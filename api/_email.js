'use strict';

/**
 * Transactional email — SMTP2GO HTTP API, called with plain fetch().
 *
 * The project ships with no dependencies and no build step, so this is the same
 * pattern as api/_stripe.js: documented REST endpoint, key read from the
 * environment, provider diagnostics kept in the server log.
 *
 * Config (all read at call time, never at import time):
 *   SMTP2GO_API_KEY  API key from SMTP2GO → Sending → API Keys
 *   EMAIL_FROM       e.g. "Add My Rank <reports@addmyrank.com>"; the domain must
 *                    be verified in SMTP2GO → Sending → Domains
 *   EMAIL_REPLY_TO   optional, defaults to EMAIL_FROM's address
 *
 * SECURITY: the API key never leaves the server and is never logged, and the
 * report token is only ever sent to the buyer's own address.
 */

const ENDPOINT = 'https://api.smtp2go.com/v3/email/send';
const SEND_TIMEOUT_MS = 10000;

class EmailError extends Error {
  constructor(message, code = 'email_failed') {
    super(message);
    this.name = 'EmailError';
    this.code = code;
  }
}

function apiKey() {
  return String(process.env.SMTP2GO_API_KEY || '').trim();
}

function sender() {
  return String(process.env.EMAIL_FROM || '').trim();
}

function replyTo() {
  const configured = String(process.env.EMAIL_REPLY_TO || '').trim();
  if (configured) return configured;
  const match = sender().match(/<([^>]+)>/);
  return match ? match[1] : sender();
}

/** A key without a verified sender cannot deliver anything, so require both. */
function isConfigured() {
  return apiKey().length > 8 && sender().includes('@');
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Absolute link to the signed report. The token travels in the fragment. */
function reportUrlFor(token, origin) {
  const base = String(origin || 'https://add-my-rank.vercel.app').replace(/\/+$/, '');
  return base + '/report.html#t=' + encodeURIComponent(token);
}

function hostOf(report) {
  try {
    return new URL(report.target.url).hostname.replace(/^www\./, '');
  } catch (_) {
    return String((report.target && report.target.origin) || 'your site');
  }
}

/**
 * Pure builder for the report email. Kept free of I/O so it can be tested
 * without a network or an API key.
 */
function renderReportEmail({ report, token, origin }) {
  const host = hostOf(report);
  const url = reportUrlFor(token, origin);
  const top = (report.actions || []).slice(0, 3);
  const grade = report.grade || '?';
  const score = typeof report.score === 'number' ? report.score : '?';
  const expires = new Date(Number(report.expiresAt) || Date.now() + 30 * 24 * 60 * 60 * 1000);
  const expiresText = expires.toISOString().slice(0, 10);
  const issueCount = (report.summary && report.summary.issues) || 0;

  const subject = 'Your Add My Rank report for ' + host + ' — grade ' + grade;

  const lines = [
    'Thanks for your order. Your SiteBoost 300 report for ' + host + ' is ready.',
    '',
    'Grade ' + grade + ' · ' + score + '/100 · ' + issueCount + ' issue' + (issueCount === 1 ? '' : 's') + ' found',
    '',
  ];
  if (top.length) {
    lines.push('Fix these first:');
    top.forEach((action, index) => {
      lines.push('  ' + (index + 1) + '. ' + action.title + ' — ' + action.fix);
    });
    lines.push('');
  }
  lines.push('Open your full report: ' + url);
  lines.push('');
  lines.push('This link is private and works until ' + expiresText + '.');
  lines.push('Reply to this email if anything looks wrong and we will sort it out.');
  lines.push('');
  lines.push('— Add My Rank');

  const topHtml = top.length
    ? '<ol style="margin:16px 0 0;padding-left:20px;color:#0f172a;font-size:15px;line-height:1.5">' +
      top.map((action) =>
        '<li style="margin-bottom:8px"><strong>' + escapeHtml(action.title) + '</strong><br>' +
        '<span style="color:#475569">' + escapeHtml(action.fix) + '</span></li>'
      ).join('') +
      '</ol>'
    : '';

  const html = [
    '<div style="background:#f6f7ff;padding:24px;font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Helvetica,Arial,sans-serif">',
    '<div style="max-width:560px;margin:0 auto;background:#ffffff;border:1px solid #e2e8f0;border-radius:16px;padding:28px">',
    '<p style="margin:0;font-size:13px;letter-spacing:.08em;text-transform:uppercase;color:#4f46e5;font-weight:700">Add My Rank · SiteBoost 300</p>',
    '<h1 style="margin:12px 0 0;font-size:22px;line-height:1.3;color:#0f172a">Your report for ' + escapeHtml(host) + ' is ready</h1>',
    '<p style="margin:16px 0 0;font-size:15px;line-height:1.6;color:#334155">Grade <strong>' + escapeHtml(grade) + '</strong> · ' +
      escapeHtml(String(score)) + '/100 · ' + escapeHtml(String(issueCount)) + ' issue' + (issueCount === 1 ? '' : 's') + ' found.</p>',
    topHtml,
    '<p style="margin:24px 0 0"><a href="' + escapeHtml(url) + '" style="display:inline-block;background:#4f46e5;color:#ffffff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:10px;font-size:15px">Open your full report</a></p>',
    '<p style="margin:18px 0 0;font-size:13px;line-height:1.6;color:#64748b">This link is private and works until ' + escapeHtml(expiresText) + '. Reply to this email if anything looks wrong.</p>',
    '</div>',
    '</div>',
  ].join('');

  return { to: null, subject, text: lines.join('\n'), html };
}

/**
 * Send one email through SMTP2GO. Returns { id } on success and throws
 * EmailError otherwise, so a caller can decide whether to retry.
 */
async function sendEmail(message, options = {}) {
  const fetchImpl = options.fetch || fetch;
  const key = apiKey();
  if (!key || !sender().includes('@')) {
    throw new EmailError('Email is not configured on this server.', 'email_not_configured');
  }
  if (!message || !message.to) throw new EmailError('An email needs a recipient.', 'email_no_recipient');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        api_key: key,
        sender: sender(),
        to: [message.to],
        subject: message.subject,
        text_body: message.text,
        html_body: message.html,
        custom_headers: [{ header: 'Reply-To', value: replyTo() }],
      }),
    });
  } catch (err) {
    throw new EmailError(err && err.name === 'AbortError' ? 'Email provider timed out.' : 'Email provider could not be reached.');
  } finally {
    clearTimeout(timer);
  }

  const data = await res.json().catch(() => ({}));
  const providerError = (data && data.data && data.data.error) || null;
  const failed = Number((data && data.data && data.data.failed) || 0);
  if (!res.ok || providerError || failed > 0) {
    // Provider text can name account details, so it stays in the log.
    console.error('email send failed', res.status, providerError || '', failed ? 'failed=' + failed : '');
    throw new EmailError('The email provider rejected that message.', 'email_rejected');
  }

  return { id: String((data && data.data && data.data.email_id) || '') };
}

module.exports = {
  EmailError,
  isConfigured,
  escapeHtml,
  reportUrlFor,
  renderReportEmail,
  sendEmail,
};