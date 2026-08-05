const express = require('express');
const crypto = require('crypto');
const rateLimit = require('express-rate-limit');
const db = require('../db/schema');
const { requireAuth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');

const router = express.Router();

const paymentLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many payment attempts. Please wait a few minutes and try again.' }
});

// POST /api/payments/initialize — starts a real Paystack checkout for this
// business's subscription. Returns a URL to redirect the owner to, where
// they pay by MoMo, card, or bank transfer directly through Paystack's
// hosted page (we never see or touch card/MoMo details ourselves).
router.post('/initialize', requireAuth, paymentLimiter, async (req, res) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return res.status(503).json({ error: 'Payments aren\'t configured yet — set PAYSTACK_SECRET_KEY in .env. See README "Setting up Paystack".' });
  }

  const { amount_ghs } = req.body; // e.g. 100 for GHS 100
  if (!amount_ghs || amount_ghs <= 0) return res.status(400).json({ error: 'A valid amount is required.' });

  const business = db.prepare('SELECT * FROM businesses WHERE id = ?').get(req.businessId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.userId);

  try {
    const response = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${secretKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: user.email,
        amount: Math.round(amount_ghs * 100), // Paystack expects the smallest currency unit (pesewas for GHS)
        currency: 'GHS',
        metadata: { business_id: req.businessId, business_name: business.name },
        callback_url: (process.env.APP_URL || '') + '/app.html?payment=complete'
      })
    });

    const data = await response.json();
    if (!response.ok || !data.status) {
      return res.status(502).json({ error: 'Paystack did not accept this request.', detail: data.message || 'Unknown error' });
    }
    res.json({ authorization_url: data.data.authorization_url, reference: data.data.reference });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Paystack.', detail: err.message });
  }
});

// GET /api/payments/verify/:reference — call this after the owner returns from
// Paystack's checkout page, to confirm the payment actually went through
// before marking the business as paid (never trust the redirect alone —
// someone could land on the "success" URL without actually paying).
router.get('/verify/:reference', requireAuth, async (req, res) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return res.status(503).json({ error: 'Payments aren\'t configured yet.' });

  try {
    const response = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(req.params.reference)}`, {
      headers: { 'Authorization': `Bearer ${secretKey}` }
    });
    const data = await response.json();
    if (!response.ok || !data.status) return res.status(502).json({ error: 'Could not verify this payment.' });

    if (data.data.status === 'success') {
      const amountGhs = data.data.amount / 100;
      const paidThrough = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10); // +30 days
      db.prepare(`
        UPDATE businesses SET subscription_status = 'active', subscription_note = ?, paid_through = ? WHERE id = ?
      `).run(`Paid GHS ${amountGhs} via Paystack, ref ${req.params.reference}`, paidThrough, req.businessId);
      logActivity(req.businessId, req.userId, 'settings_changed', `Payment verified: GHS ${amountGhs} via Paystack`, req);
    }
    res.json({ status: data.data.status, amount: data.data.amount / 100 });
  } catch (err) {
    res.status(502).json({ error: 'Could not reach Paystack.', detail: err.message });
  }
});

// POST /api/payments/webhook — Paystack calls this directly (not through the
// browser) when a payment completes, so a business gets marked paid even if
// they close the tab before the redirect finishes. Signature verification
// (per Paystack's documented scheme: HMAC-SHA512 of the raw body using your
// secret key) confirms this request genuinely came from Paystack and wasn't
// forged by someone POSTing here directly.
router.post('/webhook', (req, res) => {
  const secretKey = process.env.PAYSTACK_SECRET_KEY;
  if (!secretKey) return res.status(503).end();

  const signature = req.headers['x-paystack-signature'];
  const hash = crypto.createHmac('sha512', secretKey).update(req.rawBody).digest('hex');
  if (hash !== signature) return res.status(401).json({ error: 'Invalid signature.' });

  const event = req.body;
  if (event.event === 'charge.success') {
    const businessId = event.data.metadata?.business_id;
    if (businessId) {
      const amountGhs = event.data.amount / 100;
      const paidThrough = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      db.prepare(`
        UPDATE businesses SET subscription_status = 'active', subscription_note = ?, paid_through = ? WHERE id = ?
      `).run(`Paid GHS ${amountGhs} via Paystack webhook, ref ${event.data.reference}`, paidThrough, businessId);
      logActivity(businessId, null, 'settings_changed', `Payment confirmed via webhook: GHS ${amountGhs}`, req);
    }
  }
  res.status(200).end();
});

module.exports = router;
