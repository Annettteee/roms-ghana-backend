// Sends you and Adaiah a notification the moment something worth knowing happens
// (right now: new business signups). Works with either a Discord or a Slack
// incoming webhook URL — both are free, take two minutes to set up, and need
// no email service/API keys. Set NOTIFY_WEBHOOK_URL in .env to turn this on;
// if it's not set, this simply does nothing (never blocks the actual signup).
//
// How to get a webhook URL:
//   Discord: Server Settings → Integrations → Webhooks → New Webhook → Copy URL
//   Slack:   api.slack.com/messaging/webhooks → create an Incoming Webhook → Copy URL

async function notify(message) {
  const url = process.env.NOTIFY_WEBHOOK_URL;
  if (!url) return; // notifications are optional — silently skip if not configured

  try {
    // Sending both "content" (Discord's field) and "text" (Slack's field) in one
    // request means this works with either service without needing to know which
    // one you picked — each platform just ignores the field it doesn't recognize.
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message, text: message })
    });
  } catch (err) {
    // Never let a failed notification break the actual request that triggered it.
    console.error('Notification webhook failed:', err.message);
  }
}

module.exports = { notify };
