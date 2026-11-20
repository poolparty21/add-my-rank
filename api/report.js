/**
 * GET /api/report?t=<signed token>
 *
 * Verifies the HMAC signature produced by /api/scan and returns the report
 * JSON. The token carries the report itself, so there is no storage to keep,
 * expire or leak — and a tampered or guessed token is rejected.
 */

const { verifyToken, ScanError } = require('./_lib.js');

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET');
    return json(res, 405, { ok: false, error: 'Use GET.' });
  }
  try {
    const token = String(req.query.t || '');
    if (!token) return json(res, 400, { ok: false, error: 'No report token supplied.' });
    const report = verifyToken(token);
    return json(res, 200, { ok: true, report });
  } catch (err) {
    if (err instanceof ScanError) return json(res, err.status || 400, { ok: false, code: err.code || '', error: err.message });
    console.error('report failed', err);
    return json(res, 400, { ok: false, code: 'report_invalid', error: 'This report link is not valid.' });
  }
};