/**
 * POST /api/preview — the free instant scan on the landing page.
 *
 * Body: { url }
 * Returns: { ok, site, score, grade, found, checks, critical, ms, top[], categories[] }
 *
 * This is a TEASER, on purpose:
 * - it runs the real crawler (no mock data, no invented score), but
 * - it returns no signed token and no full check list, so the 17-check report
 *   with ranked fixes and the 14 engine submissions stay behind the $7 gate.
 *
 * It is the only endpoint that scans without payment, so it is rate limited per
 * IP. The limit is best-effort and per server instance, which is enough to stop
 * a single visitor hammering it.
 */

const { runScan, ScanError } = require('./_lib.js');

const MAX_URL_LENGTH = 300;
const WINDOW_MS = 10 * 60 * 1000;
const MAX_SCANS_PER_WINDOW = 6;
const hits = new Map();

function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 8 * 1024) {
        reject(new ScanError('Request too large.', 413));
        req.destroy();
        return;
      }
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new ScanError('Malformed request body.'));
      }
    });
    req.on('error', reject);
  });
}

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '') || 'unknown';
}

/** Returns 0 when allowed, otherwise seconds to wait. */
function rateLimit(ip) {
  const now = Date.now();
  const entry = hits.get(ip);
  if (!entry || now > entry.reset) {
    hits.set(ip, { count: 1, reset: now + WINDOW_MS });
    return 0;
  }
  entry.count += 1;
  if (entry.count > MAX_SCANS_PER_WINDOW) {
    return Math.ceil((entry.reset - now) / 1000);
  }
  return 0;
}

const CATEGORY_LABEL = {
  indexability: 'Indexability',
  onpage: 'On-page',
  technical: 'Technical',
  mobile: 'Mobile',
  performance: 'Speed',
};

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
    const wait = rateLimit(clientIp(req));
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return json(res, 429, {
        ok: false,
        error: `That is a lot of scans in a row. Try again in ${Math.ceil(wait / 60)} minute${wait > 90 ? 's' : ''} — or get the full report for $7.`,
      });
    }

    const body = await readBody(req);
    const rawUrl = String(body.url || '').trim();
    if (!rawUrl) throw new ScanError('Add your website address to scan it.');
    if (rawUrl.length > MAX_URL_LENGTH) throw new ScanError('That address is too long to scan.');

    const started = Date.now();
    const report = await runScan(rawUrl);

    const top = report.actions.slice(0, 3).map((f) => ({
      severity: f.severity,
      title: f.title,
      fix: f.fix,
    }));

    return json(res, 200, {
      ok: true,
      site: report.target.origin,
      scannedUrl: report.target.url,
      httpStatus: report.target.httpStatus,
      score: report.score,
      grade: report.grade,
      found: report.summary.issues,
      checks: report.summary.checks,
      critical: report.summary.critical,
      categories: Object.entries(report.categories).map(([key, c]) => ({
        key,
        label: CATEGORY_LABEL[key] || key,
        score: c.score,
        issues: c.issues,
      })),
      top,
      ms: Date.now() - started,
    });
  } catch (err) {
    if (err instanceof ScanError) return json(res, err.status || 400, { ok: false, error: err.message });
    console.error('preview scan failed', err);
    return json(res, 500, { ok: false, error: 'The scan did not finish. Please try again.' });
  }
};
