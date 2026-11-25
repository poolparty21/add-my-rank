'use strict';

/**
 * Fulfillment: scan the paid site once, mint the signed report, email it to the
 * buyer, and stamp the order so it is delivered exactly once.
 *
 * Called from /api/stripe-webhook, the one event that fires whether or not the
 * customer ever returns to the browser tab. The generated token is kept in the
 * report store (api/_store.js) so the buyer's return to /boost serves the same
 * report from the email instead of crawling the site a second time.
 *
 * Idempotency lives in the order record already used by the rest of the flow
 * (Stripe session metadata):
 *
 *   order_email_status=sending  → a delivery is in flight (claim, 15 min TTL)
 *   order_emailed_at=<iso>      → delivered; every later attempt is a no-op
 *   order_email_status=failed   → cleared for an immediate retry
 *
 * A stale claim (a process that died mid-send) is retried, so a crash cannot
 * leave a paid order silently undelivered.
 */

const crypto = require('node:crypto');
const { runScan, signToken, verifyToken, enginePlan } = require('./_lib.js');
const {
  retrieveSession, orderFromSession, markOrderFulfilled, stampSession, PRICE_CENTS,
} = require('./_stripe.js');
const { isConfigured: emailConfigured, renderReportEmail, sendEmail } = require('./_email.js');
const { reportStore } = require('./_store.js');

const CLAIM_TTL_MS = 15 * 60 * 1000;
/** Kept slightly longer than the signed link itself (30 days). */
const REPORT_TTL_SECONDS = 31 * 24 * 60 * 60;

/** Public origin for the emailed link. SITE_ORIGIN is the deploy contract. */
function resolveOrigin() {
  const configured = String(process.env.SITE_ORIGIN || '').trim();
  return (configured || 'https://add-my-rank.vercel.app').replace(/\/+$/, '');
}

/** Should this order still be emailed? Pure, so the rules can be tested. */
function emailDecision(metadata, now = Date.now()) {
  const meta = metadata || {};
  if (meta.order_emailed_at) return { action: 'skip', reason: 'already-emailed' };
  if (meta.order_email_status === 'sending') {
    const claimedAt = Date.parse(meta.order_email_claimed_at || '');
    if (Number.isFinite(claimedAt) && now - claimedAt < CLAIM_TTL_MS) {
      return { action: 'skip', reason: 'in-flight' };
    }
    return { action: 'send', reason: 'stale-claim' };
  }
  return { action: 'send', reason: meta.order_email_status === 'failed' ? 'retry' : 'new' };
}

/** The same report shape /api/scan and /api/recover mint, built server-side. */
async function buildReport(order) {
  const report = await runScan(order.url);
  const plan = enginePlan({ country: order.country, language: order.language, medium: order.medium });
  report.engineNotes = plan.notes;
  report.engineFleet = plan.engines;
  report.enginePrimary = plan.primary;
  report.customer = {
    email: order.email || null,
    country: order.country,
    language: order.language,
    medium: order.medium,
  };
  report.payment = { verified: true, emailed: true, amount: PRICE_CENTS };
  report.id = crypto.createHash('sha256').update(report.target.url + report.scannedAt).digest('hex').slice(0, 12);
  report.expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
  return report;
}

function reportKey(sessionId) {
  return 'report:' + String(sessionId);
}

/**
 * The report this order already generated, if it is still valid. The stored
 * value is only the token: verifyToken() gives back the whole report, and an
 * expired or corrupt entry is simply treated as "no report yet".
 */
async function loadStoredReport(sessionId, store = reportStore) {
  let raw;
  try {
    raw = await store.get(reportKey(sessionId));
  } catch (err) {
    console.error('report store read failed', sessionId, err && err.message);
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.token !== 'string') return null;
    return { token: parsed.token, report: verifyToken(parsed.token) };
  } catch (_) {
    return null;
  }
}

/** Best effort: a store outage must never cost the customer their report. */
async function saveReport(sessionId, token, store = reportStore) {
  try {
    await store.set(reportKey(sessionId), JSON.stringify({ token, savedAt: new Date().toISOString() }), REPORT_TTL_SECONDS);
  } catch (err) {
    console.error('report store write failed', sessionId, err && err.message);
  }
}

/** One scan per order: reuse the stored report, otherwise scan and keep it. */
async function getOrCreateReport(session, options = {}) {
  const store = options.store || reportStore;
  const scan = options.buildReport || buildReport;

  const existing = await loadStoredReport(session.id, store);
  if (existing) return { ...existing, reused: true };

  const order = orderFromSession(session);
  const report = await scan(order);
  const token = signToken(report);
  await saveReport(session.id, token, store);
  return { report, token, reused: false };
}

/**
 * Email the paid order's report once. Never throws for a "nothing to do"
 * outcome; throws only when a delivery was attempted and failed, so the webhook
 * can ask Stripe to retry.
 */
async function deliverReportEmail(sessionOrId, options = {}) {
  const retrieve = options.retrieve || retrieveSession;
  const scan = options.buildReport || buildReport;
  const mail = options.sendEmail || sendEmail;
  const stamp = options.stampSession || stampSession;
  const markFulfilled = options.markOrderFulfilled || markOrderFulfilled;
  const store = options.store || reportStore;
  const now = options.now || Date.now();

  const session = typeof sessionOrId === 'string' ? await retrieve(sessionOrId) : sessionOrId;
  if (!session || !session.id) return { sent: false, reason: 'no-session' };

  const decision = emailDecision(session.metadata, now);
  if (decision.action === 'skip') return { sent: false, reason: decision.reason, sessionId: session.id };

  if (!emailConfigured()) return { sent: false, reason: 'email-not-configured', sessionId: session.id };

  const order = orderFromSession(session);
  if (!order.email) return { sent: false, reason: 'no-email', sessionId: session.id };
  if (!order.url) return { sent: false, reason: 'no-site', sessionId: session.id };

  // Scan first (unless this order already has a report): a scan failure must not
  // leave a claim behind that blocks the retry Stripe is about to send us.
  const built = options.report && options.token
    ? { report: options.report, token: options.token, reused: true }
    : await getOrCreateReport(session, { store, buildReport: scan });
  const report = built.report;
  const token = built.token;
  const message = renderReportEmail({ report, token, origin: options.origin || resolveOrigin() });
  message.to = order.email;

  // Claim immediately before the send so two concurrent deliveries (webhook
  // retry + a second event) cannot both mail the buyer.
  await stamp(session.id, {
    order_email_status: 'sending',
    order_email_claimed_at: new Date(now).toISOString(),
  });

  let result;
  try {
    result = await mail(message);
  } catch (err) {
    // Release the claim so the retry does not have to wait out the TTL.
    try {
      await stamp(session.id, { order_email_status: 'failed', order_email_failed_at: new Date(now).toISOString() });
    } catch (stampErr) {
      console.error('could not clear email claim', session.id, stampErr && stampErr.message);
    }
    throw err;
  }

  const sentAt = new Date(now).toISOString();
  await stamp(session.id, {
    order_emailed_at: sentAt,
    order_email_status: 'sent',
    order_email_id: String((result && result.id) || '').slice(0, 120),
  });

  // The customer has the report, so the order is no longer "paid but pending".
  try {
    await markFulfilled(session.id);
  } catch (err) {
    console.error('could not mark emailed order fulfilled', session.id, err && err.message);
  }

  return {
    sent: true,
    reason: decision.reason,
    sessionId: session.id,
    reportId: report.id,
    emailId: (result && result.id) || null,
    reusedReport: built.reused,
  };
}

module.exports = {
  emailDecision,
  buildReport,
  deliverReportEmail,
  getOrCreateReport,
  loadStoredReport,
  saveReport,
  reportKey,
  resolveOrigin,
  CLAIM_TTL_MS,
  REPORT_TTL_SECONDS,
};
