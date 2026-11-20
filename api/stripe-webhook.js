/**
 * POST /api/stripe-webhook
 *
 * Stripe sends `checkout.session.completed`,
 * `checkout.session.async_payment_succeeded` and `…async_payment_failed` here.
 * The signature is verified against the raw body before anything is read.
 *
 * The scan itself is fulfilled when the customer returns to /boost with their
 * session id (verified against Stripe in /api/scan). There is no database in
 * v1, so this handler's job is to make paid-but-abandoned orders recoverable:
 * every paid session is logged with its order, site and email, so an operator
 * can finish any order the browser never completed. Wiring these events to a
 * durable order record and an emailed report is the next required step before
 * real volume.
 *
 * Configure the endpoint in Stripe → Developers → Webhooks with
 * STRIPE_WEBHOOK_SECRET set to the signing secret.
 */

const { verifyWebhookSignature, recordPaidOrder, StripeError } = require('./_stripe.js');

const MAX_BODY_BYTES = 1024 * 1024;

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new StripeError('Webhook payload too large.', 413, 'payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST');
    return json(res, 405, { ok: false, error: 'Use POST.' });
  }

  let raw;
  let event;
  try {
    raw = await readRawBody(req);
    verifyWebhookSignature(raw, req.headers['stripe-signature'], String(process.env.STRIPE_WEBHOOK_SECRET || '').trim());
    event = JSON.parse(raw.toString('utf8'));
  } catch (err) {
    if (err instanceof StripeError) return json(res, err.status || 400, { ok: false, code: err.code, error: err.message });
    console.error('stripe webhook rejected', err && err.message);
    return json(res, 400, { ok: false, error: 'Invalid webhook payload.' });
  }

  const session = event && event.data && event.data.object;
  if (event.type === 'checkout.session.completed' || event.type === 'checkout.session.async_payment_succeeded') {
    if (session && session.payment_status !== 'unpaid') {
      // The order is written onto the Stripe session itself, so a customer who
      // pays and never comes back is recoverable from Stripe, not just from
      // this log. Idempotent: redeliveries of the same event are a no-op.
      let record;
      try {
        record = await recordPaidOrder(session);
      } catch (err) {
        // Fail the delivery so Stripe retries: a paid order we did not record is
        // exactly the case this handler exists to prevent.
        console.error('stripe webhook could not record order', session.id, err && err.message);
        return json(res, 500, { ok: false, error: 'Could not record order.' });
      }
      console.log('stripe paid order', JSON.stringify({
        event: event.type,
        session: session.id,
        order: record.order.orderId,
        site: record.order.url,
        email: record.order.email,
        amount: session.amount_total,
        currency: session.currency,
        recorded: record.recorded,
        reason: record.reason,
      }));
    }
  } else if (event.type === 'checkout.session.async_payment_failed') {
    console.log('stripe async payment failed', JSON.stringify({ session: session && session.id, order: session && session.client_reference_id }));
  }

  return json(res, 200, { ok: true, received: true });
};
