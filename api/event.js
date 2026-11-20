/**
 * POST /api/event
 *
 * Privacy-friendly funnel instrumentation. Accepts only an event name and a
 * small allow-list of non-identifying properties; no URLs, emails, IPs or
 * other PII are read or stored. The event is written to the server log for
 * aggregation and never persisted to a database.
 */

const { readBody, json } = require('./_lib.js');

const ALLOWED_EVENTS = new Set([
  'preview_started',
  'preview_completed',
  'preview_failed',
  'checkout_started',
  'checkout_failed',
  'checkout_dev_mode',
  'checkout_redirect',
  'payment_verification_started',
  'scan_completed',
  'scan_failed',
  'report_opened',
  'report_load_failed',
  'report_recovery_started',
  'report_recovery_completed',
  'report_recovery_failed',
]);

const ALLOWED_PROPS = new Set([
  'grade',
  'issues',
  'checks',
  'critical',
  'hasFix',
  'outcome',
  'source',
  'medium',
  'status',
]);

module.exports = async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'POST, OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  if (req.method !== 'POST') {
    res.setHeader('allow', 'POST, OPTIONS');
    return json(res, 405, { ok: false, error: 'Use POST.' });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (_) {
    return json(res, 400, { ok: false, error: 'Bad request.' });
  }

  const event = String(body && body.event || '').trim();
  if (!ALLOWED_EVENTS.has(event)) {
    return json(res, 400, { ok: false, error: 'Unknown event.' });
  }

  const props = {};
  if (body && body.props && typeof body.props === 'object' && !Array.isArray(body.props)) {
    for (const key of Object.keys(body.props)) {
      if (!ALLOWED_PROPS.has(key)) continue;
      const value = body.props[key];
      if (typeof value === 'boolean' || typeof value === 'number') {
        props[key] = value;
      } else if (typeof value === 'string' && /^[a-zA-Z0-9 _.-]{1,40}$/.test(value)) {
        props[key] = value;
      }
    }
  }

  // No IP, user agent, or request identifiers are logged.
  console.log('funnel event', JSON.stringify({ event, props, ts: new Date().toISOString() }));

  res.writeHead(204, { 'cache-control': 'no-store' });
  return res.end();
};
