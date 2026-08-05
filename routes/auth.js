const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');
const { authenticator } = require('otplib');
const QRCode = require('qrcode');
const db = require('../db/schema');
const { issueSession, clearSession, requireAuth, signToken, SECRET } = require('../middleware/auth');
const { isPaymentBlocked, daysUntilBlocked } = require('../lib/paymentStatus');
const mailer = require('../lib/mailer');
const { notify } = require('../lib/notify');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();

// Brute-force protection: 10 attempts per 15 minutes per IP on the endpoints
// that check a password. Registration is limited too, so a script can't mass-create accounts.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many attempts. Please wait a few minutes and try again.' }
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function passwordIssue(password) {
  if (!password || password.length < 8) return 'Password must be at least 8 characters.';
  if (!/[a-z]/.test(password)) return 'Password must include a lowercase letter.';
  if (!/[A-Z]/.test(password)) return 'Password must include an uppercase letter.';
  if (!/[0-9]/.test(password)) return 'Password must include a number.';
  return null;
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// POST /api/auth/register — brand new business, brand new empty workspace.
// Gated by a shared invite code while you're hand-picking pilot clients —
// remove the check below (or switch to per-client codes) once you're ready
// to open signups more broadly.
router.post('/register', authLimiter, (req, res) => {
  const { businessName, ownerName, email, password, inviteCode, businessType, branchCount, phoneNumber } = req.body;

  // The invite code is now OPTIONAL — an extra layer if you choose to keep
  // PILOT_INVITE_CODE set, but the real gate is manual approval below, which
  // collects real information instead of relying on a shared secret word.
  const requiredCode = process.env.PILOT_INVITE_CODE;
  if (requiredCode) {
    if (!inviteCode || inviteCode.trim().toUpperCase() !== requiredCode.toUpperCase()) {
      return res.status(403).json({ error: 'That invite code isn\'t valid. Ask your ROMS Ghana contact for the current code.' });
    }
  }

  if (!businessName || !ownerName || !email || !password) {
    return res.status(400).json({ error: 'Business name, your name, email and password are all required.' });
  }
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const pwIssue = passwordIssue(password);
  if (pwIssue) return res.status(400).json({ error: pwIssue });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with that email already exists.' });

  let slug = slugify(businessName);
  if (db.prepare('SELECT id FROM businesses WHERE slug = ?').get(slug)) {
    slug = `${slug}-${Math.floor(Math.random() * 10000)}`;
  }

  // New signups start 'pending' — explicitly, overriding the table default of
  // 'approved' (that default exists only so businesses that existed BEFORE
  // this feature was added aren't retroactively locked out).
  const businessId = db.prepare(`
    INSERT INTO businesses (name, slug, approval_status, business_type, branch_count, phone_number)
    VALUES (?, ?, 'pending', ?, ?, ?)
  `).run(businessName, slug, businessType || null, branchCount || null, phoneNumber || null).lastInsertRowid;

  // 12 salt rounds — a deliberate step up from the library default of 10, worth
  // the extra ~100ms on a login endpoint that's already rate-limited.
  const passwordHash = bcrypt.hashSync(password, 12);
  const userId = db.prepare(`
    INSERT INTO users (business_id, name, email, password_hash, role) VALUES (?, ?, ?, ?, 'owner')
  `).run(businessId, ownerName, email.toLowerCase(), passwordHash).lastInsertRowid;

  // Email verification — opt-in. If SMTP isn't configured, we don't generate a
  // code at all and email_verified stays irrelevant (nobody is asked for one).
  let emailSent = false;
  if (mailer.isConfigured()) {
    const code = String(Math.floor(100000 + Math.random() * 900000));
    db.prepare('UPDATE users SET verification_code = ? WHERE id = ?').run(code, userId);
    mailer.sendVerificationEmail(email.toLowerCase(), code).then(r => { emailSent = r.sent; }).catch(() => {});
  }

  issueSession(res, { id: userId, business_id: businessId, role: 'owner' }, req);
  notify(`🆕 New ROMS Ghana signup awaiting approval: *${businessName}* (${businessType || 'type not given'}) — owner ${ownerName} (${email.toLowerCase()}), ${phoneNumber || 'no phone given'}`);
  res.status(201).json({
    business: { id: businessId, name: businessName, slug, approval_status: 'pending' },
    user: { id: userId, name: ownerName, email: email.toLowerCase(), role: 'owner', email_verified: false },
    emailVerificationRequired: mailer.isConfigured()
  });
});

// POST /api/auth/login
router.post('/login', authLimiter, (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  // Same error message whether the email doesn't exist or the password is wrong —
  // doesn't tell an attacker which emails are registered.
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    if (user) logActivity(user.business_id, user.id, 'login_failed', 'Wrong password', req);
    return res.status(401).json({ error: 'Incorrect email or password.' });
  }

  // If this account has 2FA turned on, don't issue a session yet — issue a
  // short-lived challenge token instead and require the 6-digit code first.
  if (user.twofa_enabled) {
    const challenge = signToken(user, { twofa_pending: true, expiresIn: '5m' });
    return res.json({ requires2FA: true, challenge });
  }

  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);
  logActivity(user.business_id, user.id, 'login', user.email, req);
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(user.business_id);
  issueSession(res, user, req);
  res.json({
    business: { id: business.id, name: business.name, slug: business.slug, currency: business.currency, subscription_status: business.subscription_status, paid_through: business.paid_through, payment_blocked: isPaymentBlocked(business), days_until_blocked: daysUntilBlocked(business), vat_rate: business.vat_rate, vat_enabled: business.vat_enabled, nhil_rate: business.nhil_rate, nhil_enabled: business.nhil_enabled, tourism_levy_rate: business.tourism_levy_rate, tourism_levy_enabled: business.tourism_levy_enabled },
    user: { id: user.id, name: user.name, email: user.email, role: user.role, twofa_enabled: !!user.twofa_enabled, previous_login_at: user.last_login_at }
  });
});

// POST /api/auth/login/2fa — second step when the account above has 2FA enabled
router.post('/login/2fa', authLimiter, (req, res) => {
  const { challenge, code } = req.body;
  if (!challenge || !code) return res.status(400).json({ error: 'Verification code required.' });

  let payload;
  try {
    payload = jwt.verify(challenge, SECRET);
  } catch (e) {
    return res.status(401).json({ error: 'That verification step expired — please log in again.' });
  }
  if (!payload.twofa_pending) return res.status(400).json({ error: 'Invalid verification request.' });

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.userId);
  if (!user || !user.twofa_enabled) return res.status(400).json({ error: 'Invalid verification request.' });

  const valid = authenticator.check(code, user.twofa_secret);
  if (!valid) {
    logActivity(user.business_id, user.id, 'login_failed', 'Wrong 2FA code', req);
    return res.status(401).json({ error: 'Incorrect code. Check the time on your phone and try again.' });
  }

  db.prepare('UPDATE users SET last_login_at = datetime(\'now\') WHERE id = ?').run(user.id);
  logActivity(user.business_id, user.id, 'login', user.email + ' (2FA)', req);
  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(user.business_id);
  issueSession(res, user, req);
  res.json({
    business: { id: business.id, name: business.name, slug: business.slug, currency: business.currency, subscription_status: business.subscription_status, paid_through: business.paid_through, payment_blocked: isPaymentBlocked(business), days_until_blocked: daysUntilBlocked(business), vat_rate: business.vat_rate, vat_enabled: business.vat_enabled, nhil_rate: business.nhil_rate, nhil_enabled: business.nhil_enabled, tourism_levy_rate: business.tourism_levy_rate, tourism_levy_enabled: business.tourism_levy_enabled },
    user: { id: user.id, name: user.name, email: user.email, role: user.role, twofa_enabled: !!user.twofa_enabled, previous_login_at: user.last_login_at }
  });
});

// POST /api/auth/logout — clears the cookie server-side
router.post('/logout', (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// GET /api/auth/me — confirms the session cookie and returns a fresh profile.
// Frontend calls this on page load so a refresh no longer logs anyone out.
router.get('/me', requireAuth, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, twofa_enabled, theme, font_size, email_verified FROM users WHERE id = ?').get(req.userId);
  const business = db.prepare('SELECT id, name, slug, currency, momo_number, subscription_status, approval_status, business_type, branch_count, phone_number, paid_through, created_at, vat_rate, vat_enabled, nhil_rate, nhil_enabled, tourism_levy_rate, tourism_levy_enabled, session_length_days, auto_reorder_enabled FROM businesses WHERE id = ?').get(req.businessId);
  if (!user || !business) return res.status(404).json({ error: 'Account not found.' });
  res.json({
    user: { ...user, email_verified: !!user.email_verified },
    business: { ...business, payment_blocked: isPaymentBlocked(business), days_until_blocked: daysUntilBlocked(business) },
    emailVerificationEnabled: mailer.isConfigured()
  });
});

// POST /api/auth/verify-email — confirms the 6-digit code sent at signup
router.post('/verify-email', requireAuth, (req, res) => {
  const { code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user.verification_code) return res.status(400).json({ error: 'No verification pending.' });
  if (String(code).trim() !== user.verification_code) return res.status(400).json({ error: 'Incorrect code.' });
  db.prepare('UPDATE users SET email_verified = 1, verification_code = NULL WHERE id = ?').run(req.userId);
  logActivity(req.businessId, req.userId, 'settings_changed', 'Email verified', req);
  res.json({ ok: true });
});

// POST /api/auth/resend-verification
router.post('/resend-verification', requireAuth, authLimiter, async (req, res) => {
  if (!mailer.isConfigured()) return res.status(503).json({ error: 'Email isn\'t configured on this server.' });
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare('UPDATE users SET verification_code = ? WHERE id = ?').run(code, req.userId);
  try {
    await mailer.sendVerificationEmail(user.email, code);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: 'Could not send the email right now.' });
  }
});

// PUT /api/auth/preferences — theme and font size, stored server-side so they
// follow you to any device you log in from, rather than living in one browser's
// localStorage (which we deliberately never use in this app).
router.put('/preferences', requireAuth, (req, res) => {
  const { theme, font_size } = req.body;
  if (theme && !['light', 'dark'].includes(theme)) return res.status(400).json({ error: 'Invalid theme.' });
  if (font_size && !['normal', 'large', 'xlarge'].includes(font_size)) return res.status(400).json({ error: 'Invalid font size.' });
  const existing = db.prepare('SELECT theme, font_size FROM users WHERE id = ?').get(req.userId);
  db.prepare('UPDATE users SET theme = ?, font_size = ? WHERE id = ?')
    .run(theme || existing.theme, font_size || existing.font_size, req.userId);
  res.json({ theme: theme || existing.theme, font_size: font_size || existing.font_size });
});

// POST /api/auth/invite — owner/manager adds a teammate to the SAME business_id
router.post('/invite', requireAuth, authLimiter, async (req, res) => {
  if (req.role !== 'owner' && req.role !== 'manager') {
    return res.status(403).json({ error: 'Only owners and managers can add staff logins.' });
  }
  const { name, email, password, role, permissions, can_delete } = req.body;
  if (!name || !email) return res.status(400).json({ error: 'Name and email are required.' });
  if (!EMAIL_RE.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (role === 'owner') return res.status(400).json({ error: 'Only one owner per business; invite as manager or staff.' });

  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'That email is already registered.' });

  // permissions is an array of module keys this person can see, e.g. ["inventory","reports"].
  // null/omitted = full access (appropriate for a manager); an empty or partial
  // array locks a staff account down to just what they need. can_delete is a
  // SEPARATE, smaller array — modules this person is also trusted to delete
  // from, not just view/add/edit. A cashier might have "inventory" in
  // permissions but nothing in can_delete, so they can log stock but not
  // remove items.
  const permissionsJson = Array.isArray(permissions) ? JSON.stringify(permissions) : null;
  const canDeleteJson = Array.isArray(can_delete) ? JSON.stringify(can_delete) : null;
  const business = db.prepare('SELECT name FROM businesses WHERE id = ?').get(req.businessId);
  const inviter = db.prepare('SELECT name FROM users WHERE id = ?').get(req.userId);

  if (mailer.isConfigured()) {
    // Real email flow: the owner never sees or chooses this person's password —
    // a random, unguessable placeholder is set, and the teammate sets their own
    // real password by clicking the emailed link, reusing the same secure
    // token mechanism as "Forgot password".
    const placeholderHash = bcrypt.hashSync(crypto.randomBytes(24).toString('hex'), 12);
    const setupToken = crypto.randomBytes(32).toString('hex');
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(); // 24 hours

    const id = db.prepare(`
      INSERT INTO users (business_id, name, email, password_hash, role, permissions, can_delete, reset_token, reset_token_expires)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(req.businessId, name, email.toLowerCase(), placeholderHash, role || 'staff', permissionsJson, canDeleteJson, setupToken, expires).lastInsertRowid;

    const setupLink = `${process.env.APP_URL || ''}/app.html?reset=${setupToken}`;
    try {
      await mailer.sendInviteEmail(email.toLowerCase(), inviter.name, business.name, setupLink);
    } catch (err) {
      console.error('Invite email failed:', err.message);
    }
    logActivity(req.businessId, req.userId, 'teammate_invited', `${name} (${email.toLowerCase()}) as ${role || 'staff'} — emailed setup link`, req);
    return res.status(201).json({ id, name, email: email.toLowerCase(), role: role || 'staff', emailed: true });
  }

  // Fallback when no email service is configured: the old behavior, requiring
  // the owner to set a temporary password and share it themselves.
  if (!password) return res.status(400).json({ error: 'Email isn\'t configured on this server, so you need to set a temporary password to share with them yourself.' });
  const pwIssue = passwordIssue(password);
  if (pwIssue) return res.status(400).json({ error: pwIssue });

  const passwordHash = bcrypt.hashSync(password, 12);
  const id = db.prepare(`
    INSERT INTO users (business_id, name, email, password_hash, role, permissions, can_delete) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(req.businessId, name, email.toLowerCase(), passwordHash, role || 'staff', permissionsJson, canDeleteJson).lastInsertRowid;

  logActivity(req.businessId, req.userId, 'teammate_invited', `${name} (${email.toLowerCase()}) as ${role || 'staff'} — manual password`, req);
  res.status(201).json({ id, name, email: email.toLowerCase(), role: role || 'staff', emailed: false });
});

// PATCH /api/auth/team/:id — edit an existing teammate's role/permissions.
// There was previously no way to change these after inviting someone; this
// is that missing piece, gated to owners/managers, and can't touch the owner.
router.patch('/team/:id', requireAuth, (req, res) => {
  if (req.role !== 'owner' && req.role !== 'manager') {
    return res.status(403).json({ error: 'Only owners and managers can edit teammate access.' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ? AND business_id = ?').get(req.params.id, req.businessId);
  if (!target) return res.status(404).json({ error: 'Not found.' });
  if (target.role === 'owner') return res.status(400).json({ error: "The owner's access can't be changed here." });

  const { role, permissions, can_delete } = req.body;
  const permissionsJson = permissions !== undefined ? (Array.isArray(permissions) ? JSON.stringify(permissions) : null) : target.permissions;
  const canDeleteJson = can_delete !== undefined ? (Array.isArray(can_delete) ? JSON.stringify(can_delete) : null) : target.can_delete;
  const newRole = role || target.role;

  db.prepare('UPDATE users SET role = ?, permissions = ?, can_delete = ? WHERE id = ?')
    .run(newRole, permissionsJson, canDeleteJson, target.id);

  logActivity(req.businessId, req.userId, 'settings_changed', `Updated access for ${target.name} (${target.email})`, req);
  res.json({ id: target.id, name: target.name, email: target.email, role: newRole });
});

// GET /api/auth/activity — recent security-relevant events for this business,
// so an owner can check "was there a login I don't recognize?"
router.get('/activity', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.event, a.detail, a.ip_address, a.created_at, u.name as user_name
    FROM activity_log a LEFT JOIN users u ON u.id = a.user_id
    WHERE a.business_id = ? ORDER BY a.created_at DESC LIMIT 50
  `).all(req.businessId);
  res.json(rows);
});

// ---------- Two-factor authentication (opt-in, via an authenticator app) ----------

// GET /api/auth/2fa/setup — generates a new secret + QR code to scan.
// Nothing is enabled yet until the user confirms a code from their app.
router.get('/2fa/setup', requireAuth, async (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  const secret = authenticator.generateSecret();
  db.prepare('UPDATE users SET twofa_secret = ? WHERE id = ?').run(secret, req.userId);

  const otpauth = authenticator.keyuri(user.email, 'ROMS Ghana', secret);
  const qrDataUrl = await QRCode.toDataURL(otpauth);
  res.json({ secret, qrDataUrl });
});

// POST /api/auth/2fa/confirm — turns 2FA on once the user proves they can generate a valid code
router.post('/2fa/confirm', requireAuth, (req, res) => {
  const { code } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!user.twofa_secret) return res.status(400).json({ error: 'Start setup first.' });
  if (!authenticator.check(code || '', user.twofa_secret)) {
    return res.status(400).json({ error: 'Incorrect code — check your app and try again.' });
  }
  db.prepare('UPDATE users SET twofa_enabled = 1 WHERE id = ?').run(req.userId);
  logActivity(req.businessId, req.userId, '2fa_enabled', null, req);
  res.json({ ok: true });
});

// POST /api/auth/2fa/disable — requires the current password as confirmation
router.post('/2fa/disable', requireAuth, (req, res) => {
  const { password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);
  if (!bcrypt.compareSync(password || '', user.password_hash)) {
    return res.status(401).json({ error: 'Incorrect password.' });
  }
  db.prepare('UPDATE users SET twofa_enabled = 0, twofa_secret = NULL WHERE id = ?').run(req.userId);
  logActivity(req.businessId, req.userId, '2fa_disabled', null, req);
  res.json({ ok: true });
});

// GET /api/auth/team — everyone with a login on this business, for the owner
// to review who has access to what.
router.get('/team', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, name, email, role, permissions, can_delete FROM users WHERE business_id = ? ORDER BY id ASC').all(req.businessId);
  res.json(rows.map(r => ({ ...r, permissions: r.permissions ? JSON.parse(r.permissions) : null, can_delete: r.can_delete ? JSON.parse(r.can_delete) : null })));
});

// ---------- Forgot / reset password ----------

// POST /api/auth/forgot-password — always returns the same generic message
// whether or not the email exists, on purpose: telling an attacker "that
// email isn't registered" is a real information leak (email enumeration).
// Only sends an actual email if SMTP is configured AND the account exists.
router.post('/forgot-password', authLimiter, async (req, res) => {
  const { email } = req.body;
  const GENERIC_MSG = { message: 'If that email is registered, a reset link has been sent.' };
  if (!email) return res.status(400).json({ error: 'Email is required.' });

  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
  if (!user || !mailer.isConfigured()) return res.json(GENERIC_MSG);

  // A random 32-byte token — unlike the 6-digit email-verification code, this
  // one grants account access on its own, so it needs to be unguessable, not
  // just short-lived.
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hour
  db.prepare('UPDATE users SET reset_token = ?, reset_token_expires = ? WHERE id = ?').run(token, expires, user.id);

  const resetLink = `${process.env.APP_URL || ''}/app.html?reset=${token}`;
  try {
    await mailer.sendPasswordResetEmail(user.email, resetLink);
  } catch (err) {
    console.error('Password reset email failed:', err.message);
  }
  res.json(GENERIC_MSG);
});

// POST /api/auth/reset-password — the token IS the authentication here (the
// person clicked a link only their inbox could have received), so this
// intentionally doesn't require being logged in.
router.post('/reset-password', authLimiter, (req, res) => {
  const { token, newPassword } = req.body;
  if (!token || !newPassword) return res.status(400).json({ error: 'Missing token or new password.' });

  const pwIssue = passwordIssue(newPassword);
  if (pwIssue) return res.status(400).json({ error: pwIssue });

  const user = db.prepare('SELECT * FROM users WHERE reset_token = ?').get(token);
  if (!user || !user.reset_token_expires || new Date(user.reset_token_expires) < new Date()) {
    return res.status(400).json({ error: 'This reset link is invalid or has expired. Request a new one.' });
  }

  const passwordHash = bcrypt.hashSync(newPassword, 12);
  db.prepare('UPDATE users SET password_hash = ?, reset_token = NULL, reset_token_expires = NULL WHERE id = ?').run(passwordHash, user.id);
  logActivity(user.business_id, user.id, 'settings_changed', 'Password reset via email link', req);
  res.json({ ok: true });
});

// ---------- Session / device management ----------

// GET /api/auth/sessions — every currently-valid login for THIS user (not
// the whole business), so "is that really me on my phone, or someone else?"
// has a real answer instead of just the audit log's history of past events.
router.get('/sessions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT id, session_id, device_info, ip_address, created_at, last_seen_at
    FROM sessions WHERE user_id = ? AND revoked = 0 ORDER BY last_seen_at DESC
  `).all(req.userId);
  res.json(rows.map(r => ({ ...r, is_current: r.session_id === req.sessionId })));
});

// DELETE /api/auth/sessions/:id — sign out one specific device remotely.
// Deliberately scoped to req.userId — you can only revoke your OWN sessions,
// never a teammate's, even if you're the owner; that would need a separate,
// more careful "force logout this person" feature, not this one.
router.delete('/sessions/:id', requireAuth, (req, res) => {
  const result = db.prepare('UPDATE sessions SET revoked = 1 WHERE id = ? AND user_id = ?').run(req.params.id, req.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Not found.' });
  res.status(204).end();
});

module.exports = router;
