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
const { runScan, signToken, enginePlan, ScanError, json, readBody, MAX_URL_LENGTH, assertSafeUrl } = require('./_lib.js');
const {
  StripeError, PRICE_CENTS, isConfigured, isProduction, retrieveSession, assertPaidSession, orderFromSession,
  markOrderFulfilled,
} = require('./_stripe.js');

const SESSION_ID = /^cs_(test|live)_[A-Za-z0-9_]{8,200}$/;

// Best-effort, per-instance rate limit for the unpaid preview path.
const PREVIEW_WINDOW_MS = 10 * 60 * 1000;
const PREVIEW_MAX_SCANS = 6;
const previewHits = new Map();

function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.headers['x-real-ip'] || '') || 'unknown';
}

/** Returns 0 when allowed, otherwise seconds to wait. */
function rateLimitPreview(ip) {
  const now = Date.now();
  const entry = previewHits.get(ip);
  if (!entry || now > entry.reset) {
    previewHits.set(ip, { count: 1, reset: now + PREVIEW_WINDOW_MS });
    return 0;
  }
  entry.count += 1;
  if (entry.count > PREVIEW_MAX_SCANS) {
    return Math.ceil((entry.reset - now) / 1000);
  }
  return 0;
}

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

/** One concrete, copy-pasteable fix for the preview's top issue. */
function fixSnippet(report) {
  const origin = (report.target && report.target.origin) || '';
  const host = origin ? (new URL(origin).hostname) : 'example.com';
  const first = (report.actions || [])[0];
  if (!first) return null;
  const snippets = {
    robots_missing: { label: 'robots.txt', code: 'User-agent: *\nAllow: /\nSitemap: ' + origin + '/sitemap.xml' },
    sitemap_missing: { label: 'sitemap.xml (minimal)', code: '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>' + origin + '/</loc></url>\n</urlset>' },
    canonical: { label: 'canonical tag', code: '<link rel="canonical" href="' + origin + '/" />' },
    title_missing: { label: 'title tag', code: '<title>Your Business — what you do</title>' },
    desc_missing: { label: 'meta description', code: '<meta name="description" content="Describe your business in 150-160 characters." />' },
    viewport: { label: 'viewport meta', code: '<meta name="viewport" content="width=device-width, initial-scale=1">' },
    charset: { label: 'charset meta', code: '<meta charset="utf-8">' },
    social: { label: 'Open Graph tags', code: '<meta property="og:title" content="Your Business">\n<meta property="og:description" content="What you do">\n<meta property="og:image" content="' + origin + '/og.jpg">' },
    noindex: { label: 'remove noindex', code: '<!-- remove this tag -->\n<meta name="robots" content="noindex">' },
    https: { label: 'force HTTPS (nginx)', code: 'server {\n  listen 80;\n  return 301 https://$host$request_uri;\n}' },
  };
  const chosen = snippets[first.id] || { label: first.title, code: first.fix };
  return { issue: first.title, label: chosen.label, code: chosen.code };
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

    // The unpaid preview runs a full scan, so guard it per IP. Paid scans are
    // already gated by a verified Stripe session and are not limited here.
    if (body.preview) {
      const wait = rateLimitPreview(clientIp(req));
      if (wait) {
        res.setHeader('retry-after', String(wait));
        return json(res, 429, {
          ok: false,
          error: `That is a lot of scans in a row. Try again in ${Math.ceil(wait / 60)} minute${wait > 90 ? 's' : ''} — or get the full report for $7.`,
        });
      }
    }

    // Free preview: a real scan, but only the score, the top three issues and
    // one copy-pasteable fix are returned. The full report stays behind payment.
    let order, payment;
    if (body.preview) {
      const rawUrl = String(body.url || '').trim();
      if (!rawUrl) throw new ScanError('Please enter your website address.');
      if (rawUrl.length > MAX_URL_LENGTH) throw new ScanError('That address is too long to scan.');
      const target = await assertSafeUrl(rawUrl);
      order = {
        url: target.toString(),
        email: String(body.email || '').slice(0, 120) || null,
        country: String(body.country || 'WW').toUpperCase().slice(0, 2),
        language: String(body.language || 'English').slice(0, 40),
        medium: body.medium === 'phone' ? 'phone' : 'web',
        engines: '',
      };
      payment = { verified: false, preview: true, amount: 0 };
    } else {
      ({ order, payment } = await resolveOrder(body));
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

    // Free preview returns only the score, top three issues and one fix.
    if (body.preview) {
      const topIssues = (report.actions || []).slice(0, 3).map((f) => ({
        id: f.id, title: f.title, severity: f.severity, effort: f.effort,
        fix: f.fix, category: f.category,
      }));
      return json(res, 200, {
        ok: true,
        preview: true,
        score: report.score,
        grade: report.grade,
        summary: report.summary,
        topIssues,
        fixSnippet: fixSnippet(report),
      });
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
