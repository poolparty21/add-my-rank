/**
 * GET /api/orders?limit=25
 *
 * The operator view of paid orders: every paid Checkout Session Stripe knows
 * about, newest first, with the order state the webhook and /api/scan write
 * onto it (`paid` vs `fulfilled`). Anything still `paid` is an order whose
 * buyer never came back for the report — the recovery list.
 *
 * Protected by ORDERS_TOKEN (sent as `x-orders-token`), compared in constant
 * time. It reads Stripe, not a local store, so it can never disagree with the
 * payments themselves. No CORS: this is not for browsers.
 */

const crypto = require('node:crypto');
const { json, ScanError } = require('./_lib.js');
const { StripeError, isConfigured, listOrders } = require('./_stripe.js');

function tokenMatches(given, expected) {
  const a = Buffer.from(String(given || ''));
  const b = Buffer.from(String(expected || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, error: 'Use GET.' });
  }

  const token = String(process.env.ORDERS_TOKEN || '').trim();
  if (!token) {
    return json(res, 503, {
      ok: false,
      code: 'orders_not_configured',
      error: 'Order lookup is not configured on this server.',
    });
  }
  if (!tokenMatches(req.headers['x-orders-token'], token)) {
    return json(res, 401, { ok: false, error: 'Not authorised.' });
  }
  if (!isConfigured()) {
    return json(res, 503, {
      ok: false,
      code: 'payments_not_configured',
      error: 'Payments are not configured on this server.',
    });
  }

  try {
    const url = new URL(req.url || '/api/orders', 'https://placeholder.invalid');
    const orders = await listOrders(url.searchParams.get('limit'));
    return json(res, 200, {
      ok: true,
      count: orders.length,
      outstanding: orders.filter((order) => order.state !== 'fulfilled').length,
      orders,
    });
  } catch (err) {
    if (err instanceof ScanError) return json(res, err.status || 400, { ok: false, error: err.message });
    if (err instanceof StripeError) return json(res, err.status || 502, { ok: false, code: err.code, error: err.message });
    console.error('orders lookup failed', err);
    return json(res, 500, { ok: false, error: 'Could not read orders. Please try again.' });
  }
};
