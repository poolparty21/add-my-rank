/**
 * POST /api/recover
 *
 * Regenerates a signed report link for a customer who lost theirs, using the
 * email and website from their paid order. No password or token is required:
 * possession of the payment email + the scanned site is the proof of purchase,
 * and the scan is rerun from the live site so the report is fresh.
 */

const crypto = require('node:crypto');
const { runScan, signToken, ScanError, json, readBody, MAX_URL_LENGTH, assertSafeUrl, enginePlan } = require('./_lib.js');
const {
  StripeError, isConfigured, isProduction, assertPaidSession, orderFromSession,
  findPaidOrder, markOrderFulfilled,
} = require('./_stripe.js');

const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 5;
const hits = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '') || 'unknown';
}

function rateLimit(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return 0;
  }
  entry.count += 1;
  if (entry.count > MAX_PER_WINDOW) return Math.ceil((entry.reset - now) / 1000);
  return 0;
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

  const wait = rateLimit(clientIp(req));
  if (wait) {
    res.setHeader('retry-after', String(wait));
    return json(res, 429, { ok: false, error: `Too many recovery attempts. Try again in ${Math.ceil(wait / 60)} minute${wait > 90 ? 's' : ''}.` });
  }

  try {
    const body = await readBody(req);
    const email = String(body.email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      throw new ScanError('Enter the email address used for your order.');
    }
    const rawUrl = String(body.url || '').trim();
    if (!rawUrl) throw new ScanError('Enter the website you had scanned.');
    if (rawUrl.length > MAX_URL_LENGTH) throw new ScanError('That address is too long.');

    let order;
    if (isConfigured()) {
      const session = await findPaidOrder(email, rawUrl);
      if (!session) throw new ScanError('No paid order found for that email and website.', 404, 'order_not_found');
      assertPaidSession(session);
      order = orderFromSession(session);
      if (!order.url) throw new ScanError('That paid order has no website attached. Please contact support.', 400);
    } else {
      if (isProduction()) {
        throw new StripeError('Payments are not configured on this server, so recovery is unavailable.', 503, 'payments_not_configured');
      }
      // Local development: keep the pipeline testable without Stripe.
      const target = await assertSafeUrl(rawUrl);
      order = {
        url: target.toString(),
        email,
        country: String(body.country || 'WW').toUpperCase().slice(0, 2),
        language: String(body.language || 'English').slice(0, 40),
        medium: body.medium === 'phone' ? 'phone' : 'web',
        engines: '',
      };
    }

    const report = await runScan(order.url);
    const plan = enginePlan({
      country: order.country,
      language: order.language,
      medium: order.medium,
    });
    report.engineNotes = plan.notes;
    report.engineFleet = plan.engines;
    report.enginePrimary = plan.primary;
    report.customer = { email: order.email || null, country: order.country, language: order.language, medium: order.medium };
    report.payment = { verified: true, recovered: true, amount: 700 };
    report.id = crypto.createHash('sha256').update(report.target.url + report.scannedAt).digest('hex').slice(0, 12);
    report.expiresAt = Date.now() + (30 * 24 * 60 * 60 * 1000);

    if (isConfigured()) {
      try {
        const session = await findPaidOrder(email, rawUrl);
        if (session) await markOrderFulfilled(session.id);
      } catch (err) {
        console.error('could not mark recovered order fulfilled', err && err.message);
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
    if (err instanceof ScanError) return json(res, err.status || 400, { ok: false, code: err.code || '', error: err.message });
    if (err instanceof StripeError) return json(res, err.status || 400, { ok: false, code: err.code, error: err.message });
    console.error('recover failed', err);
    return json(res, 500, { ok: false, error: 'Recovery could not be completed. Please try again.' });
  }
};
