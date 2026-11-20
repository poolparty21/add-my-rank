/**
 * POST /api/scan
 *
 * Body (normal path): { sessionId }   — the Stripe Checkout session id
 * Body (local dev):   { url, email?, country?, language?, medium?, engines? }
 * Returns: { ok: true, token, score, grade, reportUrl }
 *
 * PAYMENT GATE
 * - With STRIPE_SECRET_KEY set, the session is fetched from Stripe and must be
 *   paid in full. The site that gets scanned comes from the session metadata,
 *   never from the request body, so a $7 payment is only ever redeemable for
 *   the site it was bought for. No session id, no scan.
 * - Without a key, production refuses to scan at all (fail closed); local
 *   development allows an unpaid scan so the pipeline stays testable.
 *
 * The report token returned here is signed and carries the report itself, so
 * there is no storage to keep: /api/report just verifies the signature.
 */

const crypto = require('node:crypto');
const { runScan, signToken, enginePlan, ScanError, json, readBody, MAX_URL_LENGTH } = require('./_lib.js');
const {
  StripeError, PRICE_CENTS, isConfigured, isProduction, retrieveSession, assertPaidSession, orderFromSession,
  markOrderFulfilled,
} = require('./_stripe.js');

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9_]{8,200}$/;

/** Unpaid order used only outside production, when Stripe is not configured. */
function devOrder(body) {
  const rawUrl = String(body.url || '').trim();
  if (!rawUrl) throw new ScanError('Please enter your website address.');
  if (rawUrl.length > MAX_URL_LENGTH) throw new ScanError('That address is too long to scan.');

  return {
    url: rawUrl,
    email: String(body.email || '').slice(0, 120) || null,
    country: String(body.country || 'WW').toUpperCase().slice(0, 2),
    language: String(body.language || 'English').slice(0, 40),
    medium: body.medium === 'phone' ? 'phone' : 'web',
    engines: '',
  };
}

/** Turn a paid session (or a dev order) into the order we actually scan. */
async function resolveOrder(body) {
  if (isConfigured()) {
    const sessionId = String(body.sessionId || '').trim();
    if (!sessionId) throw new ScanError('Payment required before we can run the scan.', 402);
    if (!SESSION_ID.test(sessionId)) throw new ScanError('That payment reference is not valid.', 400);

    const session = await retrieveSession(sessionId);
    assertPaidSession(session);

    const order = orderFromSession(session);
    if (!order.url) throw new ScanError('That payment has no website attached. Please contact support.', 400);

    return {
      order,
      payment: {
        verified: true,
        skipped: false,
        amount: session.amount_total,
        currency: session.currency,
        orderId: order.orderId,
      },
    };
  }

  if (isProduction()) {
    throw new ScanError('Payments are not configured on this server, so scans are paused.', 503);
  }
  // The /boost?session_id=… return carries no site: only Stripe's session does.
  // Without a key that session cannot be read, so say that instead of asking a
  // paying customer to type the address they already paid for.
  if (body.sessionId) {
    throw new ScanError('This server cannot verify payments, so the report cannot be generated.', 503);
  }
  return { order: devOrder(body), payment: { verified: false, amount: PRICE_CENTS } };
}

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, OPTIONS');
    return json(res, 405, { ok: false, error: 'Use POST.' });
  }

  try {
    const body = await readBody(req);
    const { order, payment } = await resolveOrder(body);

    const report = await runScan(order.url);
    const plan = enginePlan({
      country: order.country,
      language: order.language,
      medium: order.medium,
    });
    report.engineNotes = plan.notes;
    report.engineFleet = plan.engines;
    report.enginePrimary = plan.primary;
    report.customer = {
      email: order.email || null,
      country: order.country,
      language: order.language,
      medium: order.medium,
    };
    report.payment = payment;
    report.id = crypto.createHash('sha256').update(report.target.url + report.scannedAt).digest('hex').slice(0, 12);

    // A report now exists for this order, so the webhook record can stop
    // looking abandoned. Best effort: a failure here must not cost the
    // customer the report they paid for.
    if (payment.verified && body.sessionId) {
      try {
        await markOrderFulfilled(String(body.sessionId));
      } catch (err) {
        console.error('could not mark order fulfilled', body.sessionId, err && err.message);
      }
    }

    const token = signToken(report);
    return json(res, 200, {
      ok: true,
      token,
      id: report.id,
      score: report.score,
      grade: report.grade,
      summary: report.summary,
      reportUrl: `/report.html#t=${token}`,
    });
  } catch (err) {
    if (err instanceof ScanError) return json(res, err.status || 400, { ok: false, error: err.message });
    if (err instanceof StripeError) {
      return json(res, err.status || 400, { ok: false, code: err.code, error: err.message });
    }
    console.error('scan failed', err);
    return json(res, 500, { ok: false, error: 'Something went wrong during the scan. Please try again.' });
  }
};
