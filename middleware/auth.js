const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const SECRET = process.env.JWT_SECRET || 'dev-secret-change-this-before-deploying';

if (process.env.NODE_ENV === 'production' && (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32)) {
  // Fail loudly rather than silently running a production server on a guessable secret.
  throw new Error('JWT_SECRET must be set to a long random string in production. See .env.example.');
}

const COOKIE_NAME = 'roms_session';
const DEFAULT_SESSION_DAYS = 7;

function cookieOptions(maxAgeMs) {
  return {
    httpOnly: true,                                   // JavaScript can never read this cookie — blocks XSS token theft
    secure: process.env.NODE_ENV === 'production',      // only sent over HTTPS in production
    sameSite: 'strict',                                 // never sent on cross-site requests — this is our CSRF defense
    maxAge: maxAgeMs,
    path: '/'
  };
}

// Turns a raw user-agent string into something a person can actually
// recognize in a device list, e.g. "Chrome on Windows" instead of the full
// UA string. Deliberately simple pattern matching, not a full UA parser —
// good enough for "is this me?", not meant to be exhaustive.
function describeDevice(userAgent) {
  if (!userAgent) return 'Unknown device';
  const browser = /Edg\//.test(userAgent) ? 'Edge'
    : /Chrome\//.test(userAgent) ? 'Chrome'
    : /Firefox\//.test(userAgent) ? 'Firefox'
    : /Safari\//.test(userAgent) ? 'Safari'
    : 'a browser';
  const os = /Windows/.test(userAgent) ? 'Windows'
    : /Mac OS X/.test(userAgent) ? 'Mac'
    : /Android/.test(userAgent) ? 'Android'
    : /iPhone|iPad/.test(userAgent) ? 'iOS'
    : /Linux/.test(userAgent) ? 'Linux'
    : 'an unknown device';
  return `${browser} on ${os}`;
}

function signToken(user, opts = {}) {
  const { expiresIn = `${DEFAULT_SESSION_DAYS}d`, sessionId, ...extraClaims } = opts;
  return jwt.sign(
    { userId: user.id, businessId: user.business_id, role: user.role, jti: sessionId, ...extraClaims },
    SECRET,
    { expiresIn }
  );
}

// Sets the httpOnly cookie AND records a real row in the sessions table, so
// this specific login can later be seen and individually revoked from
// another device — a stolen laptop can be logged out remotely without
// needing to change your password.
function issueSession(res, user, req) {
  const db = require('../db/schema');
  const business = db.prepare('SELECT session_length_days FROM businesses WHERE id = ?').get(user.business_id);
  const days = (business && business.session_length_days) || DEFAULT_SESSION_DAYS;
  const sessionId = crypto.randomBytes(16).toString('hex');

  const token = signToken(user, { expiresIn: `${days}d`, sessionId });

  if (req) {
    db.prepare(`
      INSERT INTO sessions (user_id, business_id, session_id, device_info, ip_address)
      VALUES (?, ?, ?, ?, ?)
    `).run(user.id, user.business_id, sessionId, describeDevice(req.headers['user-agent']), req.ip);
  }

  res.cookie(COOKIE_NAME, token, cookieOptions(days * 24 * 60 * 60 * 1000));
  return token;
}

function clearSession(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions(0), maxAge: 0 });
}

const TRIAL_DAYS = 30;
const GRACE_DAYS = 7;
const { isPaymentBlocked } = require('../lib/paymentStatus');

function requireAuth(req, res, next) {
  // Cookie is the primary path for the web app. Bearer header stays as a fallback
  // for future non-browser clients (a wrapped mobile app, a Postman/API integration)
  // that can't rely on cookies — never required, never preferred over the cookie.
  const cookieToken = req.cookies && req.cookies[COOKIE_NAME];
  const header = req.headers.authorization || '';
  const headerToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  const token = cookieToken || headerToken;

  if (!token) return res.status(401).json({ error: 'Not logged in.' });

  try {
    const payload = jwt.verify(token, SECRET);
    req.userId = payload.userId;
    req.businessId = payload.businessId;
    req.role = payload.role;
    req.sessionId = payload.jti;

    // A session row missing or marked revoked means this exact login was
    // signed out remotely (or predates this feature, treated as valid until
    // its own natural JWT expiry) — this is what makes "log out this device"
    // from Settings actually work, instead of a token remaining valid until
    // it naturally expires days later regardless of what the owner wants.
    if (payload.jti) {
      const db = require('../db/schema');
      const session = db.prepare('SELECT revoked FROM sessions WHERE session_id = ?').get(payload.jti);
      if (session && session.revoked) {
        return res.status(401).json({ error: 'This session was signed out from another device. Please log in again.' });
      }
      if (session) {
        db.prepare('UPDATE sessions SET last_seen_at = datetime(\'now\') WHERE session_id = ?').run(payload.jti);
      }
    }

    // Payment/trial gate. Reading is NEVER blocked — a business's own data
    // stays visible to them regardless of payment status, on principle: losing
    // access to what you already entered is a much worse experience than a
    // paused ability to add more, and it's needless leverage to hold data hostage.
    // Auth and payment endpoints are always exempt — you must be able to log in,
    // check your status, and pay even while otherwise restricted.
    const exemptBase = req.baseUrl && (req.baseUrl.startsWith('/api/auth') || req.baseUrl.startsWith('/api/payments') || req.baseUrl.startsWith('/api/admin'));

    // Approval gate: a business that hasn't been manually approved yet can't
    // do ANYTHING except check its own status and log in/out — not even read
    // its own (empty) data — since there's nothing legitimate to show a
    // not-yet-vetted signup anyway, and this is the actual replacement for
    // the invite-code gate: real information collected, reviewed by a human,
    // rather than a shared secret word anyone could pass around.
    if (!exemptBase) {
      const db = require('../db/schema');
      const biz = db.prepare('SELECT approval_status FROM businesses WHERE id = ?').get(req.businessId);
      if (biz && biz.approval_status === 'pending') {
        return res.status(403).json({ error: 'Your account is awaiting approval. You\'ll get an email once it\'s reviewed — usually within a day.' });
      }
      if (biz && biz.approval_status === 'rejected') {
        return res.status(403).json({ error: 'This account was not approved. Contact support if you believe this is a mistake.' });
      }
    }

    if (!exemptBase && req.method !== 'GET') {
      const db = require('../db/schema');
      const biz = db.prepare('SELECT subscription_status, paid_through, created_at FROM businesses WHERE id = ?').get(req.businessId);
      if (isPaymentBlocked(biz)) {
        return res.status(402).json({
          error: 'Your trial or payment has expired. You can still view everything, but adding or changing anything is paused until payment is renewed — see Settings → Billing.'
        });
      }
    }

    next();
  } catch (err) {
    return res.status(401).json({ error: 'Session expired, please log in again.' });
  }
}

// Module-level access control. An owner always has full access. A manager or
// staff member only has full access if they were invited with `permissions`
// left null (the invite form's "select one" full-access roles); otherwise
// they're restricted to whichever module keys are in their permissions array.
// This is what makes the Settings > Add New User module checkboxes real,
// not just decorative.
function requireModule(moduleKey) {
  return (req, res, next) => {
    if (req.role === 'owner') return next();
    const db = require('../db/schema');
    const user = db.prepare('SELECT permissions FROM users WHERE id = ?').get(req.userId);
    if (!user || !user.permissions) return next(); // null permissions = full access
    let allowed;
    try { allowed = JSON.parse(user.permissions); } catch { allowed = []; }
    if (allowed.includes(moduleKey)) return next();
    return res.status(403).json({ error: `Your account doesn't have access to ${moduleKey}. Ask your business owner to grant it under Settings.` });
  };
}

// Finer-grained than requireModule: a staff member might be able to VIEW and
// ADD inventory (via requireModule) but not DELETE from it — deleting is
// higher-risk than adding, so it's opt-in separately, even for someone who
// already has the module itself. Owners and managers always pass, matching
// how requireModule treats them.
function requireDeletePermission(moduleKey) {
  return (req, res, next) => {
    if (req.role === 'owner' || req.role === 'manager') return next();
    const db = require('../db/schema');
    const user = db.prepare('SELECT can_delete FROM users WHERE id = ?').get(req.userId);
    let allowed;
    try { allowed = user && user.can_delete ? JSON.parse(user.can_delete) : []; } catch { allowed = []; }
    if (allowed.includes(moduleKey)) return next();
    return res.status(403).json({ error: `Your account can view ${moduleKey} but isn't allowed to delete from it. Ask your business owner to grant that under Settings.` });
  };
}

module.exports = { requireAuth, requireModule, requireDeletePermission, issueSession, clearSession, signToken, COOKIE_NAME, SECRET };
