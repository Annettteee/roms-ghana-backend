const TRIAL_DAYS = 30;
const GRACE_DAYS = 7;

function blockDate(business) {
  if (!business) return null;
  if (business.subscription_status === 'trial') {
    return new Date(new Date(business.created_at).getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
  }
  if (business.paid_through) {
    return new Date(new Date(business.paid_through).getTime() + GRACE_DAYS * 24 * 60 * 60 * 1000);
  }
  return null;
}

// Returns true if this business should have writes blocked right now.
// Reading is never blocked — see middleware/auth.js for why.
function isPaymentBlocked(business) {
  const bd = blockDate(business);
  return bd ? new Date() > bd : false;
}

// How many whole days until writes get blocked — negative if already
// blocked. Null if there's nothing to count down (e.g. active with no
// paid_through set, which shouldn't normally happen but shouldn't crash
// either). Shared by the admin dashboard's "expiring soon" sort AND the
// in-app warning banner, so the two are never telling the owner two
// different numbers for the same thing.
function daysUntilBlocked(business) {
  const bd = blockDate(business);
  if (!bd) return null;
  return Math.ceil((bd.getTime() - Date.now()) / (24 * 60 * 60 * 1000));
}

module.exports = { isPaymentBlocked, daysUntilBlocked, TRIAL_DAYS, GRACE_DAYS };
