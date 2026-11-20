/**
 * POST /api/checkout
 *
 * Body: { url, email, country?, language?, medium?, engines? }
 * Returns: { ok: true, id, url }  — `url` is the Stripe-hosted Checkout page.
 *
 * The $7 price lives here, not in the browser. The order is stamped into the
 * Checkout Session metadata, so after payment /api/scan can scan exactly the
 * site that was paid for, whatever the browser claims afterwards.
 *
 * The site is validated (resolvable, public) BEFORE checkout is created, so we
 * never take money for an address we cannot scan.
 */

const { ScanError, assertSafeUrl, ALL_ENGINES, json, readBody, MAX_URL_LENGTH } = require('./_lib.js');
const { StripeError, isConfigured, isProduction, createCheckoutSession } = require('./_stripe.js');

const ENGINE_SET = new Set(ALL_ENGINES);

/** The public origin customers return to. Set SITE_ORIGIN in production. */
function resolveOrigin(req) {
  const configured = String(process.env.SITE_ORIGIN || '').trim();
  if (configured) return configured.replace(/\/+$/, '');

  const protoHeader = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const proto = protoHeader === 'https' ? 'https' : (isProduction() ? 'https' : 'http');
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || 'localhost');
  return `${proto}://${host}`;
}

async function sanitizeOrder(body) {
  const url = String(body.url || '').trim();
  if (!url) throw new ScanError('Please enter your website address.');
  if (url.length > MAX_URL_LENGTH) throw new ScanError('That address is too long to scan.');

  const email = String(body.email || '').trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    throw new ScanError('Enter the email address where we should send your report.');
  }

  const engines = [...new Set(String(body.engines || '')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => ENGINE_SET.has(name)))];

  // Rejects private/internal hosts and unregistered domains before any charge.
  const target = await assertSafeUrl(url);

  return {
    url: target.toString(),
    email,
    country: String(body.country || 'WW').toUpperCase().slice(0, 2),
    language: String(body.language || 'English').slice(0, 40),
    medium: body.medium === 'phone' ? 'phone' : 'web',
    engines: (engines.length ? engines : ALL_ENGINES.slice(0, 3)).join(',').slice(0, 480),
  };
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
    if (!isConfigured()) {
      // Local development can still exercise the pipeline; production fails closed.
      if (isProduction()) {
        throw new StripeError('Payments are not configured on this server, so checkout is unavailable.', 503, 'payments_not_configured');
      }
      return json(res, 503, {
        ok: false,
        devMode: true,
        code: 'payments_not_configured',
        error: 'Stripe is not configured locally, so this run skips payment.',
      });
    }

    const order = await sanitizeOrder(await readBody(req));
    const session = await createCheckoutSession(order, resolveOrigin(req));

    if (!session || !session.url) {
      throw new StripeError('Checkout could not be created. Please try again.', 502, 'stripe_error');
    }
    return json(res, 200, { ok: true, id: session.id, url: session.url });
  } catch (err) {
    if (err instanceof ScanError) return json(res, err.status || 400, { ok: false, error: err.message });
    if (err instanceof StripeError) {
      return json(res, err.status || 400, { ok: false, code: err.code, error: err.message });
    }
    console.error('checkout failed', err);
    return json(res, 500, { ok: false, error: 'Checkout could not be started. Please try again.' });
  }
};
