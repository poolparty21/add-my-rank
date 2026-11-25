/**
 * Stripe helpers — plain REST calls, no SDK.
 *
 * This project deliberately ships with no dependencies and no build step, so
 * instead of the Node SDK we call the documented REST endpoints with fetch()
 * and pin the API version on every request.
 *
 * SECURITY NOTES
 * - STRIPE_SECRET_KEY never leaves the server: it is read here only and is
 *   never logged, echoed in an error, or sent to the browser.
 * - The price is defined here, server-side. The browser cannot influence what
 *   is charged; it can only describe which site it wants scanned.
 * - The order travels inside the Checkout Session metadata and is read back
 *   from Stripe. The redirect back to /boost carries only a session id.
 */

const crypto = require('node:crypto');

const API_BASE = 'https://api.stripe.com/v1';
const API_VERSION = '2026-08-26.dahlia';

const PRICE_CENTS = 700;
const CURRENCY = 'usd';
const PRODUCT_NAME = 'SiteBoost 300 — 14-engine listing + crawlability report';
const PRODUCT_DESCRIPTION = '17-point crawlability audit, signed listing report and submission to 14 search engines.';
const INTEGRATION_IDENTIFIER = 'addmyrank_boost_x7k2mqzt';
/**
 * Stripe requires an eligible tax code on every product when the account has
 * Managed Payments enabled (it is on by default for new live accounts).
 * txcd_10103000 = Software as a Service (SaaS) — personal use, which covers the
 * digitally supplied report. Without it Stripe rejects the session with
 * "the product tax code is missing".
 */
const PRODUCT_TAX_CODE = 'txcd_10103000';

/** An error we can show the customer, with an HTTP status and a machine code. */
class StripeError extends Error {
  constructor(message, status = 400, code = 'stripe_error') {
    super(message);
    this.name = 'StripeError';
    this.status = status;
    this.code = code;
  }
}

/** A secret API key: sk_/rk_ (restricted) in live or test mode. */
const KEY_SHAPE = /^(sk|rk)_(test|live)_[A-Za-z0-9]{10,}$/;

function secretKey() {
  return String(process.env.STRIPE_SECRET_KEY || '').trim();
}

/**
 * A publishable key (pk_) or a truncated value pasted into the env var is not a
 * configured server: treating it as one only turns every request into a 502 at
 * Stripe. Shape-checking here makes the failure say what is actually wrong.
 */
function isConfigured() {
  return KEY_SHAPE.test(secretKey());
}

/** Production behaves strictly; local development keeps an unpaid path for testing. */
function isProduction() {
  return process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL);
}

/**
 * Stripe expects bracket-encoded form bodies:
 *   { line_items: [{ quantity: 1 }] }  →  line_items[0][quantity]=1
 */
function encodeParams(params, prefix = '', out = []) {
  if (params == null) return out;
  const entries = Array.isArray(params)
    ? params.map((value, index) => [index, value])
    : Object.entries(params);

  for (const [key, value] of entries) {
    const name = prefix ? `${prefix}[${key}]` : String(key);
    if (value === null || value === undefined || value === '') continue;
    if (typeof value === 'object') encodeParams(value, name, out);
    else out.push(`${encodeURIComponent(name)}=${encodeURIComponent(String(value))}`);
  }
  return out;
}

async function stripeRequest(pathname, params, opts = {}) {
  const key = secretKey();
  if (!key) throw new StripeError('Payments are not configured on this server.', 503, 'payments_not_configured');

  const body = params ? encodeParams(params).join('&') : null;
  let res;
  try {
    res = await fetch(`${API_BASE}${pathname}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        authorization: `Bearer ${key}`,
        'stripe-version': API_VERSION,
        ...(body ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
      },
      body: body || undefined,
    });
  } catch {
    throw new StripeError('We could not reach our payment provider. Please try again.', 502, 'stripe_unreachable');
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Provider diagnostics stay in the server log: Stripe messages can name
    // account internals (key prefixes, account config) that must not reach the
    // browser. The customer gets a generic, actionable message instead.
    console.error('stripe request failed', pathname, res.status,
      data && data.error && data.error.type, data && data.error && data.error.code,
      data && data.error && data.error.message);

    // A key Stripe rejects is our misconfiguration, not a transient outage: say
    // so instead of inviting the customer to retry a broken checkout forever.
    if (res.status === 401 || res.status === 403 || (data && data.error && data.error.type === 'authentication_error')) {
      throw new StripeError('Payments are not configured correctly on this server.', 503, 'payments_misconfigured');
    }
    throw new StripeError(
      opts.errorMessage || 'Our payment provider could not complete that request. Please try again.',
      502,
      'stripe_error',
    );
  }
  return data;
}

/** Create the $7 Checkout Session for a validated order and return it. */
async function createCheckoutSession(order, origin) {
  const orderId = crypto.randomBytes(12).toString('hex');
  const params = {
    mode: 'payment',
    success_url: `${origin}/boost?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${origin}/boost?canceled=1`,
    customer_email: order.email,
    client_reference_id: orderId,
    integration_identifier: INTEGRATION_IDENTIFIER,
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: CURRENCY,
          unit_amount: PRICE_CENTS,
          product_data: {
            name: PRODUCT_NAME,
            description: PRODUCT_DESCRIPTION,
            tax_code: PRODUCT_TAX_CODE,
          },
        },
      },
    ],
    metadata: {
      order_id: orderId,
      site_url: order.url,
      email: order.email,
      country: order.country,
      language: order.language,
      medium: order.medium,
      engines: order.engines,
    },
  };
  return stripeRequest('/checkout/sessions', params, {
    errorMessage: 'Secure checkout is temporarily unavailable. Please try again in a moment.',
  });
}

async function retrieveSession(sessionId) {
  return stripeRequest(`/checkout/sessions/${encodeURIComponent(sessionId)}`, null, {
    errorMessage: 'We could not verify that payment right now. Please try again in a moment.',
  });
}

/** The order is whatever Stripe says it is — never the request body. */
function orderFromSession(session) {
  const meta = (session && session.metadata) || {};
  const customer = (session && session.customer_details) || {};
  const engines = String(meta.engines || '');
  return {
    url: String(meta.site_url || '').slice(0, 300),
    email: String(meta.email || customer.email || '').slice(0, 120),
    country: String(meta.country || 'WW').toUpperCase().slice(0, 2),
    language: String(meta.language || 'English').slice(0, 40),
    medium: meta.medium === 'phone' ? 'phone' : 'web',
    engines,
    orderId: String(meta.order_id || (session && session.client_reference_id) || ''),
  };
}

/** Reject unpaid, underpaid or wrong-currency sessions. */
function assertPaidSession(session) {
  if (!session || !session.id) throw new StripeError('That payment reference is not valid.', 402, 'payment_invalid');
  if (session.mode !== 'payment') {
    throw new StripeError('That payment reference is not valid.', 402, 'payment_invalid');
  }
  if (session.payment_status !== 'paid') {
    throw new StripeError('Your payment has not completed yet.', 402, 'payment_incomplete');
  }
  if (Number(session.amount_total) < PRICE_CENTS) {
    throw new StripeError('That payment does not cover this order.', 402, 'payment_amount');
  }
  if (String(session.currency || '').toLowerCase() !== CURRENCY) {
    throw new StripeError('That payment was made in an unsupported currency.', 402, 'payment_currency');
  }
}

// ---------------------------------------------------------------------------
// Durable order records
// ---------------------------------------------------------------------------
// v1 has no database, and the Checkout Session already holds the whole order,
// so the session is the record: the webhook stamps metadata.order_recorded_at
// on a paid session, and /api/scan moves order_status to 'fulfilled' once the
// report exists. That survives restarts and redeliveries, needs no extra
// service or credential, and keeps the order next to the payment it came from.
// A session with no order_recorded_at is an order the webhook never saw.

const ORDER_METADATA_LIMIT = 40; // Stripe caps metadata keys at 40 characters

function sessionPath(sessionId) {
  return `/checkout/sessions/${encodeURIComponent(sessionId)}`;
}

/** Stamp a paid session as a recorded order. Safe to call on every retry. */
async function recordPaidOrder(session) {
  if (!session || !session.id) throw new StripeError('That payment reference is not valid.', 402, 'payment_invalid');

  // A webhook payload is a snapshot: a redelivery of the same event carries the
  // metadata from *before* the first write, so the "already recorded" guard has
  // to read the session as Stripe holds it now, not as the event remembers it.
  const current = await retrieveSession(session.id);
  const meta = (current && current.metadata) || {};
  if (meta.order_recorded_at) {
    return { recorded: false, reason: 'already-recorded', order: orderFromSession(current) };
  }

  const order = orderFromSession(current);
  await stripeRequest(sessionPath(current.id), {
    metadata: {
      order_recorded_at: new Date().toISOString(),
      order_status: 'paid',
      order_site: order.url.slice(0, 500),
      order_email: order.email.slice(0, 500),
      order_amount: String(current.amount_total || PRICE_CENTS),
      order_currency: String(current.currency || CURRENCY),
    },
  }, { errorMessage: 'We could not record that order. Please try again.' });
  return { recorded: true, reason: 'recorded', order };
}

/** Write metadata onto a Checkout Session — the order record for name:value pairs such as the email claim. */
async function stampSession(sessionId, metadata) {
  return stripeRequest(sessionPath(sessionId), { metadata }, {
    errorMessage: 'We could not update that order. Please try again.',
  });
}

/** Mark the order behind a paid session as delivered (report generated). */
async function markOrderFulfilled(sessionId) {
  const current = await retrieveSession(sessionId);
  const meta = (current && current.metadata) || {};
  // Idempotent: a session that is already fulfilled stays fulfilled; we do not
  // rewrite its metadata or its fulfilled_at timestamp on every repeat scan.
  if (meta.order_status === 'fulfilled' && meta.order_fulfilled_at) {
    return { fulfilled: false, reason: 'already-fulfilled' };
  }
  await stripeRequest(sessionPath(current.id), {
    metadata: {
      order_status: 'fulfilled',
      order_fulfilled_at: new Date().toISOString(),
    },
  }, { errorMessage: 'We could not update that order. Please try again.' });
  return { fulfilled: true, reason: 'fulfilled' };
}

function normalizeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try {
    const url = new URL(raw.includes('://') ? raw : 'https://' + raw);
    return (url.origin || '').toLowerCase().replace(/\/$/, '');
  } catch (_) {
    return raw.toLowerCase().replace(/\/$/, '');
  }
}

/**
 * Find the most recent paid Checkout Session for an email + site, so a lost
 * report link can be regenerated without rescanning the payment. Returns the
 * session object or null.
 */
async function findPaidOrder(email, siteUrl) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const targetOrigin = normalizeOrigin(siteUrl);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalizedEmail) || !targetOrigin) return null;

  const data = await stripeRequest(
    `/checkout/sessions?limit=100&customer_details%5Bemail%5D=${encodeURIComponent(normalizedEmail)}`,
    null,
    { errorMessage: 'We could not look up that order right now. Please try again in a moment.' },
  );

  const sessions = (data && data.data ? data.data : [])
    .filter((session) => session && session.payment_status === 'paid')
    .map((session) => ({ session, order: orderFromSession(session) }))
    .filter(({ order }) => normalizeOrigin(order.url) === targetOrigin);

  if (!sessions.length) return null;
  sessions.sort((a, b) => Number(b.session.created || 0) - Number(a.session.created || 0));
  return sessions[0].session;
}

/** Paid sessions, newest first, with their order state — the abandoned-order list. */
async function listOrders(limit = 25) {
  const capped = Math.min(Math.max(Math.trunc(Number(limit)) || 25, 1), 100);
  const data = await stripeRequest(`/checkout/sessions?limit=${capped}`, null, {
    errorMessage: 'We could not read the order list right now. Please try again in a moment.',
  });

  return (data.data || [])
    .filter((session) => session.payment_status === 'paid')
    .map((session) => {
      const meta = session.metadata || {};
      const order = orderFromSession(session);
      return {
        session: session.id,
        site: order.url,
        email: order.email,
        amount: session.amount_total,
        currency: session.currency,
        paidAt: session.created ? new Date(session.created * 1000).toISOString() : null,
        state: meta.order_status || 'unrecorded',
        recordedAt: meta.order_recorded_at || null,
        fulfilledAt: meta.order_fulfilled_at || null,
      };
    });
}

/**
 * Verify a Stripe webhook signature header (t=…,v1=…) against the raw body.
 * Throws StripeError on any mismatch; supports multiple v1 signatures, which
 * Stripe sends while a signing secret is being rotated.
 */
function verifyWebhookSignature(rawBody, signatureHeader, secret, toleranceSeconds = 300) {
  if (!secret) throw new StripeError('Webhook signing secret is not configured.', 500, 'webhook_not_configured');

  let timestamp = null;
  const signatures = [];
  for (const part of String(signatureHeader || '').split(',')) {
    const [field, value] = part.split('=');
    if (!field || value === undefined) continue;
    if (field.trim() === 't') timestamp = Number(value.trim());
    else if (field.trim() === 'v1') signatures.push(value.trim());
  }

  if (!timestamp || !signatures.length) throw new StripeError('Missing webhook signature.', 400, 'webhook_signature');
  if (Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) {
    throw new StripeError('Webhook timestamp is outside the tolerance.', 400, 'webhook_signature');
  }

  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const expectedBuffer = Buffer.from(expected, 'hex');
  const matched = signatures.some((signature) => {
    const candidate = Buffer.from(signature, 'hex');
    return candidate.length === expectedBuffer.length && crypto.timingSafeEqual(candidate, expectedBuffer);
  });
  if (!matched) throw new StripeError('Webhook signature does not match.', 400, 'webhook_signature');
}

module.exports = {
  StripeError,
  PRICE_CENTS,
  CURRENCY,
  PRODUCT_NAME,
  encodeParams,
  isConfigured,
  isProduction,
  createCheckoutSession,
  retrieveSession,
  orderFromSession,
  assertPaidSession,
  verifyWebhookSignature,
  recordPaidOrder,
  stampSession,
  markOrderFulfilled,
  findPaidOrder,
  listOrders,
};
