const nodemailer = require('nodemailer');

// Email is entirely optional. If SMTP isn't configured, this silently does
// nothing and email verification is simply never required — better than
// locking real users out because a mail server isn't set up yet.
function isConfigured() {
  return !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_PORT === '465',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
}

async function sendVerificationEmail(toEmail, code) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP not configured' };
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Your ROMS Ghana verification code',
    text: `Your verification code is: ${code}\n\nThis code expires in 30 minutes. If you didn't request this, you can ignore this email.`,
    html: `<p>Your verification code is:</p><p style="font-size:28px;font-weight:bold;letter-spacing:4px;">${code}</p><p>This code expires in 30 minutes.</p>`
  });
  return { sent: true };
}

async function sendPasswordResetEmail(toEmail, resetLink) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP not configured' };
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: 'Reset your ROMS Ghana password',
    text: `Someone requested a password reset for this account. Click this link to set a new password:\n\n${resetLink}\n\nThis link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't be changed.`,
    html: `<p>Someone requested a password reset for this account.</p><p><a href="${resetLink}" style="background:#8B4A24;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Set a new password</a></p><p style="color:#8C7A68;font-size:13px;">This link expires in 1 hour. If you didn't request this, you can safely ignore this email — your password won't be changed.</p>`
  });
  return { sent: true };
}

async function sendInviteEmail(toEmail, inviterName, businessName, setupLink) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP not configured' };
  const transport = getTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: `${inviterName} invited you to ${businessName} on ROMS Ghana`,
    text: `${inviterName} has added you as a teammate on ${businessName}'s ROMS Ghana account.\n\nClick this link to set your password and log in:\n\n${setupLink}\n\nThis link expires in 24 hours.`,
    html: `<p><b>${inviterName}</b> has added you as a teammate on <b>${businessName}</b>'s ROMS Ghana account.</p><p><a href="${setupLink}" style="background:#8B4A24;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Set your password &amp; log in</a></p><p style="color:#8C7A68;font-size:13px;">This link expires in 24 hours.</p>`
  });
  return { sent: true };
}

async function sendRenewalWarningEmail(toEmail, businessName, daysLeft, appUrl) {
  if (!isConfigured()) return { sent: false, reason: 'SMTP not configured' };
  const transport = getTransport();
  const dueMessage = daysLeft > 0
    ? `Your access is set to pause in ${daysLeft} day${daysLeft === 1 ? '' : 's'} if payment isn't renewed.`
    : `Your access has paused — you can still see everything you've already entered, but adding or changing anything is on hold until payment is renewed.`;
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: toEmail,
    subject: daysLeft > 0 ? `${businessName} — payment renewal coming up` : `${businessName} — action needed to keep using ROMS Ghana`,
    text: `${dueMessage}\n\nRenew from inside the app: Settings → Billing.\n\n${appUrl || ''}`,
    html: `<p>${dueMessage}</p><p>Renew from inside the app: <b>Settings → Billing</b>.</p>${appUrl ? `<p><a href="${appUrl}" style="background:#8B4A24;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;">Open ROMS Ghana</a></p>` : ''}`
  });
  return { sent: true };
}

module.exports = { isConfigured, sendVerificationEmail, sendPasswordResetEmail, sendInviteEmail, sendRenewalWarningEmail };
