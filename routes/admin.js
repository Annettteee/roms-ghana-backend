const express = require('express');
const db = require('../db/schema');
const { daysUntilBlocked } = require('../lib/paymentStatus');
const mailer = require('../lib/mailer');

const router = express.Router();

// Deliberately NOT the same auth as customer accounts. This is a single shared
// key only you and Adaiah know — set ADMIN_KEY in .env. It's checked on every
// request below via the X-Admin-Key header, not a cookie, so it can't be
// confused with (or accidentally granted through) a customer login.
//
// Because the key itself is shared, it can't tell the two of you apart on
// its own — so every request must ALSO carry an X-Admin-Name header (just a
// plain name, not a password) identifying who's actually using it right
// now. That name gets attached to every write action below, so "who
// approved this business" or "who marked this as paid" has a real answer.
function requireAdmin(req, res, next) {
  const key = process.env.ADMIN_KEY;
  if (!key) return res.status(503).json({ error: 'Admin access is not configured on this server.' });
  if (req.headers['x-admin-key'] !== key) return res.status(401).json({ error: 'Invalid admin key.' });
  const name = (req.headers['x-admin-name'] || '').trim();
  if (!name) return res.status(400).json({ error: 'Enter your name before continuing — every action is logged against it.' });
  req.adminName = name;
  next();
}

function logAdminAction(req, action, detail) {
  try {
    db.prepare('INSERT INTO admin_activity_log (admin_name, action, detail, ip_address) VALUES (?, ?, ?, ?)')
      .run(req.adminName, action, detail || null, req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null);
  } catch (err) {
    console.error('Admin activity log write failed:', err.message);
  }
}

// GET /api/admin/businesses — every business that's signed up, with a light
// usage summary for each. Deliberately shows COUNTS, not the actual private
// contents of a business's dishes/invoices/customers — enough to see who's
// active and who might need a check-in call, without reading anyone's
// financial data without their knowledge.
router.get('/businesses', requireAdmin, (req, res) => {
  logAdminAction(req, 'viewed_dashboard', null);
  const businesses = db.prepare('SELECT * FROM businesses ORDER BY created_at DESC').all();

  const summary = businesses.map(b => {
    const owner = db.prepare('SELECT name, email, last_login_at FROM users WHERE business_id = ? AND role = \'owner\'').get(b.id);
    const counts = {
      inventory: db.prepare('SELECT COUNT(*) c FROM inventory_items WHERE business_id = ?').get(b.id).c,
      dishes: db.prepare('SELECT COUNT(*) c FROM dishes WHERE business_id = ?').get(b.id).c,
      invoices: db.prepare('SELECT COUNT(*) c FROM invoices WHERE business_id = ?').get(b.id).c,
      customers: db.prepare('SELECT COUNT(*) c FROM customers WHERE business_id = ?').get(b.id).c,
      waste_entries: db.prepare('SELECT COUNT(*) c FROM waste_log WHERE business_id = ?').get(b.id).c,
    };
    const isActive = counts.inventory + counts.dishes + counts.invoices > 0;
    return {
      id: b.id, name: b.name, slug: b.slug, signed_up: b.created_at,
      approval_status: b.approval_status, business_type: b.business_type,
      branch_count: b.branch_count, phone_number: b.phone_number,
      owner_name: owner ? owner.name : null,
      owner_email: owner ? owner.email : null,
      last_login: owner ? owner.last_login_at : null,
      subscription_status: b.subscription_status,
      subscription_note: b.subscription_note,
      paid_through: b.paid_through,
      days_until_blocked: daysUntilBlocked(b),
      counts, status: isActive ? 'active' : 'signed up, not yet using it'
    };
  });

  // Pending approvals surface first, then whoever's closest to losing access —
  // that's the order you actually need to act in.
  summary.sort((a, b) => {
    if ((a.approval_status === 'pending') !== (b.approval_status === 'pending')) {
      return a.approval_status === 'pending' ? -1 : 1;
    }
    const aDays = a.days_until_blocked ?? Infinity;
    const bDays = b.days_until_blocked ?? Infinity;
    return aDays - bDays;
  });

  res.json({
    totalBusinesses: businesses.length,
    activeBusinesses: summary.filter(s => s.status === 'active').length,
    pendingApprovals: summary.filter(s => s.approval_status === 'pending').length,
    businesses: summary
  });
});

// PATCH /api/admin/businesses/:id/payment — record that a business paid you
// (e.g. via MoMo transfer collected in person). This is a manual ledger, not
// a payment processor — see README "How do customers actually pay?" for why.
router.patch('/businesses/:id/payment', requireAdmin, (req, res) => {
  const { subscription_status, subscription_note, paid_through } = req.body;
  const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Business not found.' });
  db.prepare('UPDATE businesses SET subscription_status = ?, subscription_note = ?, paid_through = ? WHERE id = ?').run(
    subscription_status ?? existing.subscription_status,
    subscription_note ?? existing.subscription_note,
    paid_through ?? existing.paid_through,
    req.params.id
  );
  logAdminAction(req, 'payment_recorded', `${existing.name}: ${subscription_note || subscription_status}`);
  res.json(db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id));
});

// PATCH /api/admin/businesses/:id/approval — approve or reject a pending signup.
router.patch('/businesses/:id/approval', requireAdmin, (req, res) => {
  const { approval_status } = req.body;
  if (!['approved', 'rejected', 'pending'].includes(approval_status)) {
    return res.status(400).json({ error: 'approval_status must be approved, rejected, or pending.' });
  }
  const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Business not found.' });
  db.prepare('UPDATE businesses SET approval_status = ? WHERE id = ?').run(approval_status, req.params.id);
  logAdminAction(req, 'approval_changed', `${existing.name}: ${approval_status}`);
  res.json(db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id));
});

// GET /api/admin/activity — who used the admin panel, and what they did with
// it. This IS the answer to "how do I know who logged in as admin" — since
// the key itself is shared, this log (keyed by the name each of you enters,
// not a separate password) is the real accountability trail.
router.get('/activity', requireAdmin, (req, res) => {
  const rows = db.prepare('SELECT * FROM admin_activity_log ORDER BY id DESC LIMIT 100').all();
  res.json(rows);
});

// DELETE /api/admin/businesses/:id — permanently removes a business and
// everything tied to it (inventory, invoices, customers, staff, the works)
// via cascading foreign keys. Deliberately hard to do by accident: the
// request body must include the business's exact name as confirmation,
// case-sensitive — not just an "are you sure" click, since this can't be
// undone and there's no separate confirmation dialog step at the API level.
router.delete('/businesses/:id', requireAdmin, (req, res) => {
  const existing = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Business not found.' });

  const { confirmName } = req.body;
  if (confirmName !== existing.name) {
    return res.status(400).json({ error: `Type the exact business name ("${existing.name}") to confirm deletion.` });
  }

  db.prepare('DELETE FROM businesses WHERE id = ?').run(existing.id);
  logAdminAction(req, 'business_deleted', `${existing.name} (id ${existing.id}) — permanently deleted`);
  res.status(204).end();
});

// POST /api/admin/send-renewal-warnings — checks every business, emails a
// warning to any owner within WARNING_DAYS of losing write access (or who's
// already lost it), and skips anyone already warned in the last
// RESEND_GAP_DAYS so this can run daily without spamming the same person
// every day. Safe to trigger manually from the dashboard button, or by
// pointing a free external scheduler (e.g. cron-job.org) at this endpoint
// once a day — either way it's the same idempotent check, not a one-off.
const WARNING_DAYS = 5;
const RESEND_GAP_DAYS = 3;
router.post('/send-renewal-warnings', requireAdmin, async (req, res) => {
  if (!mailer.isConfigured()) {
    return res.status(503).json({ error: 'Email isn\'t configured on this server, so warnings can\'t be sent yet.' });
  }
  const businesses = db.prepare('SELECT * FROM businesses WHERE approval_status = \'approved\'').all();
  let sent = 0, skipped = 0, ineligible = 0, failed = 0;

  for (const b of businesses) {
    const days = daysUntilBlocked(b);
    if (days === null || days > WARNING_DAYS) { ineligible++; continue; }

    if (b.renewal_warning_sent_at) {
      const gapDays = (Date.now() - new Date(b.renewal_warning_sent_at.replace(' ', 'T') + 'Z').getTime()) / (24 * 60 * 60 * 1000);
      if (gapDays < RESEND_GAP_DAYS) { skipped++; continue; }
    }

    const owner = db.prepare('SELECT email FROM users WHERE business_id = ? AND role = \'owner\'').get(b.id);
    if (!owner) { ineligible++; continue; }

    try {
      await mailer.sendRenewalWarningEmail(owner.email, b.name, days, process.env.APP_URL);
      db.prepare('UPDATE businesses SET renewal_warning_sent_at = datetime(\'now\') WHERE id = ?').run(b.id);
      sent++;
    } catch (err) {
      console.error(`Renewal warning failed for business ${b.id}:`, err.message);
      failed++;
    }
  }

  logAdminAction(req, 'renewal_warnings_sent', `${sent} sent, ${failed} failed, ${skipped} skipped (recently warned), ${ineligible} not due yet`);
  res.json({ sent, failed, skipped, ineligible });
});

module.exports = router;
