'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
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

function freshScanHandler() {
  const libPath = require.resolve('../api/_lib.js');
  const originalEntry = require.cache[libPath];
  const realLib = require(libPath);
  const fakeLib = Object.assign({}, realLib, { runScan: async () => MOCK_REPORT });
  require.cache[libPath] = { id: libPath, filename: libPath, loaded: true, exports: fakeLib };
  const scanPath = require.resolve('../api/scan.js');
  delete require.cache[scanPath];
  const handler = require(scanPath);
  if (originalEntry) require.cache[libPath] = originalEntry;
  return handler;
}

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



test('preview scan response has the documented shape', { timeout: 30000 }, async () => {
  const handler = freshScanHandler();
  const result = await invoke(handler, { body: { url: 'example.com', preview: true } });

  assert.equal(result.status, 200, result.body);
  const data = JSON.parse(result.body);
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
  const handler = freshScanHandler();
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

test('build-locales check passes', () => {
  const result = spawnSync(process.execPath, ['build-locales.js', '--check'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, (result.stderr || '') + (result.stdout || ''));
});
