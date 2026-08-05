const db = require('../db/schema');

// Records a security-relevant event so the business owner can later answer
// "was there a login I don't recognize?" This is intentionally lightweight —
// no IP geolocation, no device fingerprinting, just enough of a trail to spot
// something unusual. Never throws — a logging failure should never break the
// actual request that triggered it.
function logActivity(businessId, userId, event, detail, req) {
  try {
    const ip = req ? (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null) : null;
    db.prepare(`
      INSERT INTO activity_log (business_id, user_id, event, detail, ip_address) VALUES (?, ?, ?, ?, ?)
    `).run(businessId, userId || null, event, detail || null, ip);
  } catch (err) {
    console.error('Activity log write failed:', err.message);
  }
}

module.exports = { logActivity };
