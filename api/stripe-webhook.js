/**
 * POST /api/stripe-webhook
 *
 * Stripe sends `checkout.session.completed`,
 * `checkout.session.async_payment_succeeded` and `…async_payment_failed` here.
 * The signature is verified against the raw body before anything is read.
 *
 * Fulfillment happens here, not in the browser: after recording the order this
 * handler scans the paid site, mints the signed report and emails the buyer
 * their link, so an order is delivered even if the tab is closed before the
 * redirect completes. Delivery is idempotent on the session metadata (see
 * api/_fulfill.js), so Stripe redeliveries never mail the same order twice.
 * /api/scan still serves the report on the customer's return, and /api/recover
 * remains the manual fallback.
 *
 * Configure the endpoint in Stripe → Developers → Webhooks with
 * STRIPE_WEBHOOK_SECRET set to the signing secret.
 */

const { verifyWebhookSignature, recordPaidOrder, StripeError } = require('./_stripe.js');
const { deliverReportEmail } = require('./_fulfill.js');

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

      // Deliver the report now. A failure fails the delivery on purpose so
      // Stripe retries: a paid order with no email is exactly what this handler
      // exists to prevent, and the claim in _fulfill.js keeps the retry safe.
      let delivery;
      try {
        delivery = await deliverReportEmail(session.id);
      } catch (err) {
        console.error('stripe webhook could not email report', session.id, err && err.message);
        return json(res, 500, { ok: false, error: 'Could not email the report.' });
      }
      console.log('stripe report email', JSON.stringify({
        session: session.id,
        sent: delivery.sent,
        reason: delivery.reason,
        report: delivery.reportId || null,
        emailId: delivery.emailId || null,
      }));
    }
  } else if (event.type === 'checkout.session.async_payment_failed') {
    console.log('stripe async payment failed', JSON.stringify({ session: session && session.id, order: session && session.client_reference_id }));
  }

  return json(res, 200, { ok: true, received: true });
};
