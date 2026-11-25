'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const MOCK_REPORT = {
  target: { url: 'https://example.com/', origin: 'https://example.com', httpStatus: 200, redirects: 0 },
  scannedAt: '2026-11-20T00:00:00.000Z',
  score: 87,
  grade: 'B',
  summary: { checks: 16, issues: 7, critical: 0 },
  actions: [
    { id: 'sitemap_missing', title: 'No valid XML sitemap', severity: 'high', effort: '5 min', fix: 'Generate a sitemap.', category: 'indexability' },
  ],
  categories: {},
};

function invoke(handler, options) {
  options = options || {};
  return new Promise((resolve) => {
    const req = new EventEmitter();
    req.method = options.method || 'POST';
    req.headers = options.headers || { 'content-type': 'application/json' };
    req.url = options.url || '/';
    req.query = options.query || {};

    const res = {
      statusCode: 200,
      headers: {},
      body: '',
      setHeader(name, value) { this.headers[name] = value; },
      writeHead(status, headers) {
        this.statusCode = status;
        if (headers) Object.assign(this.headers, headers);
      },
      write(chunk) { this.body += chunk == null ? '' : String(chunk); },
      end(chunk) {
        if (chunk != null) this.body += String(chunk);
        resolve({ status: this.statusCode, headers: this.headers, body: this.body });
      },
    };

    handler(req, res).catch((err) => {
      resolve({ status: 500, headers: res.headers, body: '', error: err });
    });

    process.nextTick(() => {
      if (options.body !== undefined) {
        req.emit('data', Buffer.from(JSON.stringify(options.body)));
      }
      req.emit('end');
    });
  });
}



test('preview scan response has the documented shape', () => {
  const { buildPreviewResponse } = require('../api/scan.js');
  const data = buildPreviewResponse(MOCK_REPORT);
  assert.equal(data.ok, true);
  assert.equal(data.preview, true);
  assert.equal(typeof data.score, 'number');
  assert.equal(typeof data.grade, 'string');
  assert.ok(Array.isArray(data.topIssues));
  assert.ok(data.topIssues.length <= 3);
  assert.ok(data.summary && typeof data.summary.checks === 'number');
  assert.ok(data.fixSnippet === null || (typeof data.fixSnippet.label === 'string' && typeof data.fixSnippet.code === 'string'));
  assert.equal(data.token, undefined);
});

test('per-IP rate limiting blocks the 7th preview scan', async () => {
  const handler = require('../api/scan.js');
  for (let i = 0; i < 6; i++) {
    const result = await invoke(handler, { body: { preview: true } });
    assert.notEqual(result.status, 429, `request ${i + 1} was rate limited unexpectedly`);
  }
  const blocked = await invoke(handler, { body: { preview: true } });
  assert.equal(blocked.status, 429);
  assert.ok(blocked.headers['retry-after']);
});

test('signed report tokens verify, reject tampering, and expire', () => {
  const { signToken, verifyToken } = require('../api/_lib.js');

  const payload = { score: 87, grade: 'B', expiresAt: Date.now() + 60000 };
  const token = signToken(payload);
  assert.deepEqual(verifyToken(token), payload);

  const tampered = token.slice(0, -1) + (token.endsWith('a') ? 'b' : 'a');
  assert.throws(() => verifyToken(tampered), (err) => err.status === 400);

  const expiredToken = signToken({ score: 87, expiresAt: Date.now() - 1000 });
  assert.throws(() => verifyToken(expiredToken), (err) => err.status === 410 && err.code === 'report_expired');
});

test('generated pages expose canonical, social, structured, and analytics metadata', () => {
  const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

  const index = read('index.html');
  assert.match(index, /<link rel="canonical" href="https:\/\/add-my-rank\.vercel\.app\/">/);
  assert.match(index, /<meta property="og:image" content="https:\/\/add-my-rank\.vercel\.app\/og-image\.png">/);
  assert.match(index, /"@type":"Organization"/);
  assert.match(index, /\/analytics\.js/);

  const deBoost = read('de/boost.html');
  assert.match(deBoost, /<link rel="canonical" href="https:\/\/add-my-rank\.vercel\.app\/de\/boost">/);
  assert.match(deBoost, /<meta property="og:url" content="https:\/\/add-my-rank\.vercel\.app\/de\/boost">/);
  assert.match(deBoost, /"@type":"Service"/);
  assert.match(deBoost, /"url":"https:\/\/add-my-rank\.vercel\.app\/de\/boost"/);
  assert.doesNotMatch(deBoost, /Boost my rank — Add My Rank/);

  const report = read('report.html');
  assert.match(report, /<meta name="robots" content="noindex, nofollow">/);
  assert.match(report, /\/analytics\.js/);

  assert.match(read('404.html'), /noindex/);
});

test('sitemap excludes signed report pages', () => {
  const sitemap = fs.readFileSync(path.join(ROOT, 'sitemap.xml'), 'utf8');
  assert.equal((sitemap.match(/<url>/g) || []).length, 8);
  assert.doesNotMatch(sitemap, /\/report/);
});

test('report email carries the signed link and escapes page data', () => {
  const { renderReportEmail } = require('../api/_email.js');
  const report = {
    target: { url: 'https://example.com/', origin: 'https://example.com' },
    score: 87,
    grade: 'B',
    summary: { issues: 7 },
    expiresAt: Date.parse('2026-12-24T00:00:00Z'),
    actions: [{ title: '<script>alert(1)</script>', fix: 'Add a sitemap.' }],
  };

  const message = renderReportEmail({ report, token: 'payload.sig', origin: 'https://add-my-rank.vercel.app' });
  assert.match(message.subject, /example\.com/);
  assert.match(message.subject, /grade B/);
  assert.match(message.text, /https:\/\/add-my-rank\.vercel\.app\/report\.html#t=payload\.sig/);
  assert.match(message.text, /works until 2026-12-24/);
  assert.match(message.html, /Open your full report/);
  assert.doesNotMatch(message.html, /<script>/);
  assert.match(message.html, /&lt;script&gt;/);
});

test('email delivery decision is idempotent and retries stale claims only', () => {
  const { emailDecision, CLAIM_TTL_MS } = require('../api/_fulfill.js');
  const now = Date.parse('2026-11-25T12:00:00Z');

  assert.deepEqual(emailDecision({ order_emailed_at: '2026-11-25T11:00:00Z' }, now), { action: 'skip', reason: 'already-emailed' });
  assert.equal(emailDecision({ order_email_status: 'sending', order_email_claimed_at: '2026-11-25T11:55:00Z' }, now).reason, 'in-flight');
  assert.equal(
    emailDecision({ order_email_status: 'sending', order_email_claimed_at: new Date(now - CLAIM_TTL_MS - 1000).toISOString() }, now).reason,
    'stale-claim',
  );
  assert.equal(emailDecision({ order_email_status: 'failed' }, now).reason, 'retry');
  assert.equal(emailDecision({}, now).reason, 'new');
});

test('deliverReportEmail emails a paid order exactly once', async () => {
  process.env.SMTP2GO_API_KEY = 'test-key-0000000000';
  process.env.EMAIL_FROM = 'Add My Rank <reports@example.com>';

  const { deliverReportEmail } = require('../api/_fulfill.js');
  const session = {
    id: 'cs_test_delivery',
    payment_status: 'paid',
    metadata: {
      site_url: 'https://example.com',
      email: 'buyer@example.com',
      country: 'US',
      language: 'English',
      medium: 'web',
      order_id: 'order-1',
    },
  };

  let sends = 0;
  const stamped = [];
  let fulfilled = 0;
  const deps = {
    retrieve: async () => session,
    buildReport: async () => MOCK_REPORT,
    sendEmail: async (message) => {
      sends += 1;
      assert.equal(message.to, 'buyer@example.com');
      return { id: 'em_1' };
    },
    stampSession: async (id, metadata) => {
      assert.equal(id, session.id);
      stamped.push(metadata);
      Object.assign(session.metadata, metadata);
    },
    markOrderFulfilled: async () => { fulfilled += 1; return { fulfilled: true }; },
    origin: 'https://add-my-rank.vercel.app',
  };

  const first = await deliverReportEmail(session.id, deps);
  assert.equal(first.sent, true);
  assert.equal(sends, 1);
  assert.equal(fulfilled, 1);
  assert.ok(session.metadata.order_emailed_at);
  assert.equal(session.metadata.order_email_status, 'sent');
  assert.equal(session.metadata.order_email_id, 'em_1');
  assert.ok(stamped.some((m) => m.order_email_status === 'sending'), 'the send is claimed before it happens');

  const second = await deliverReportEmail(session.id, deps);
  assert.equal(second.sent, false);
  assert.equal(second.reason, 'already-emailed');
  assert.equal(sends, 1, 'a redelivered webhook must not email twice');
});

test('sendEmail posts to SMTP2GO and surfaces provider rejection', async () => {
  process.env.SMTP2GO_API_KEY = 'test-key-0000000000';
  process.env.EMAIL_FROM = 'Add My Rank <reports@example.com>';
  const { sendEmail } = require('../api/_email.js');

  let seen = null;
  const ok = await sendEmail(
    { to: 'buyer@example.com', subject: 's', text: 't', html: '<p>x</p>' },
    {
      fetch: async (url, init) => {
        seen = { url, init };
        return { ok: true, status: 200, json: async () => ({ data: { succeeded: 1, failed: 0, email_id: 'em_42' } }) };
      },
    },
  );
  assert.equal(ok.id, 'em_42');
  assert.equal(seen.url, 'https://api.smtp2go.com/v3/email/send');
  const body = JSON.parse(seen.init.body);
  assert.equal(body.api_key, 'test-key-0000000000');
  assert.deepEqual(body.to, ['buyer@example.com']);
  assert.equal(body.sender, 'Add My Rank <reports@example.com>');
  assert.match(body.text_body, /^t$/);

  const originalError = console.error;
  console.error = () => {};
  try {
    await assert.rejects(
      sendEmail({ to: 'buyer@example.com' }, {
        fetch: async () => ({ ok: false, status: 400, json: async () => ({ data: { error: 'bad key' } }) }),
      }),
      (err) => err.code === 'email_rejected',
    );
  } finally {
    console.error = originalError;
  }
});

test('report store keeps a generated token and reads it back', async () => {
  const { reportStore } = require('../api/_store.js');
  const { loadStoredReport, saveReport } = require('../api/_fulfill.js');
  const { signToken } = require('../api/_lib.js');

  const key = 'store-roundtrip:' + Date.now();
  assert.equal(await reportStore.get(key), null);
  await reportStore.set(key, 'value', 60);
  assert.equal(await reportStore.get(key), 'value');

  const token = signToken({ score: 91, grade: 'A', expiresAt: Date.now() + 60000 });
  await saveReport('cs_test_store_roundtrip', token);
  const stored = await loadStoredReport('cs_test_store_roundtrip');
  assert.equal(stored.token, token);
  assert.equal(stored.report.score, 91);

  assert.equal(await loadStoredReport('cs_test_store_empty'), null, 'an unknown order has no report');
  await saveReport('cs_test_store_corrupt', 'not-a-signed-token');
  assert.equal(await loadStoredReport('cs_test_store_corrupt'), null, 'a corrupt entry is ignored');
});

test('one scan per order: the return path reuses the report already generated', async () => {
  const { getOrCreateReport } = require('../api/_fulfill.js');
  const session = {
    id: 'cs_test_onescan',
    payment_status: 'paid',
    metadata: { site_url: 'https://example.com', email: 'buyer@example.com', country: 'US', language: 'English', medium: 'web' },
  };

  let scans = 0;
  const buildReport = async () => { scans += 1; return { ...MOCK_REPORT }; };

  const first = await getOrCreateReport(session, { buildReport });
  const second = await getOrCreateReport(session, { buildReport });

  assert.equal(scans, 1, 'the site must be crawled only once');
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(second.token, first.token, 'the buyer gets the token that was already minted');
  assert.equal(second.report.id, first.report.id);
});

test('emailing an order reuses its stored report instead of crawling again', async () => {
  process.env.SMTP2GO_API_KEY = 'test-key-0000000000';
  process.env.EMAIL_FROM = 'Add My Rank <reports@example.com>';
  const { getOrCreateReport, deliverReportEmail } = require('../api/_fulfill.js');

  const session = {
    id: 'cs_test_email_reuse',
    payment_status: 'paid',
    metadata: { site_url: 'https://example.com', email: 'buyer@example.com', country: 'US', language: 'English', medium: 'web' },
  };

  const built = await getOrCreateReport(session, { buildReport: async () => ({ ...MOCK_REPORT }) });

  let mailed = null;
  const delivery = await deliverReportEmail(session, {
    buildReport: async () => { throw new Error('must not rescan a stored order'); },
    sendEmail: async (message) => { mailed = message; return { id: 'em_reuse' }; },
    stampSession: async (id, metadata) => { Object.assign(session.metadata, metadata); },
    markOrderFulfilled: async () => ({ fulfilled: true }),
  });

  assert.equal(delivery.sent, true);
  assert.equal(delivery.reusedReport, true);
  assert.equal(delivery.reportId, built.report.id);
  assert.ok(mailed.text.includes('#t=' + built.token), 'the emailed link carries the stored token');
});

test('build-locales check passes', () => {
  const result = spawnSync(process.execPath, ['build-locales.js', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, (result.stderr || '') + (result.stdout || ''));
});
