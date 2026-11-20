#!/usr/bin/env node
'use strict';

/**
 * Local preview server — no dependencies.
 *
 * Serves the static pages exactly like the deployed site (clean URLs:
 * /boost → boost.html, /report → report.html) and mounts the same
 * api/*.js handlers that Vercel runs, so the scan → signed report flow can be
 * exercised end to end locally.
 *
 *   npm run dev          # http://127.0.0.1:4173
 *   PORT=5000 npm run dev
 *
 * The handlers are plain Node request/response functions, so nothing here
 * emulates a framework — it only supplies `req.query`, which Vercel parses
 * for us in production.
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;
const HOST = process.env.HOST || '127.0.0.1';

// Some shells export PORT=0 (or an empty value); only a real port counts.
const configuredPort = Number(process.env.PORT);
const PORT = Number.isInteger(configuredPort) && configuredPort > 0 ? configuredPort : 4173;

/** Minimal .env loader (KEY=VALUE, # comments, existing vars win). */
function loadEnvFile(name) {
  let text;
  try {
    text = fs.readFileSync(path.join(ROOT, name), 'utf8');
  } catch {
    return;
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
loadEnvFile('.env.local');
loadEnvFile('.env');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

/** Clean-URL routes, mirroring vercel.json. */
const ROUTES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/boost', 'boost.html'],
  ['/report', 'report.html'],
]);

const API = new Map([
  ['/api/scan', './api/scan.js'],
  ['/api/report', './api/report.js'],
  ['/api/checkout', './api/checkout.js'],
  ['/api/preview', './api/preview.js'],
  ['/api/event', './api/event.js'],
  ['/api/recover', './api/recover.js'],
  ['/api/stripe-webhook', './api/stripe-webhook.js'],
  ['/api/orders', './api/orders.js'],
]);

/** Files that exist for development only and must never be served. */
const PRIVATE = new Set(['dev-server.js', 'build-locales.js', 'package.json', 'package-lock.json', 'PLAN.md']);

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(body);
}

function json(res, status, body) {
  send(res, status, JSON.stringify(body), { 'content-type': 'application/json; charset=utf-8' });
}

function serveStatic(req, res, relativePath) {
  const file = path.resolve(ROOT, relativePath);
  if (!file.startsWith(ROOT + path.sep)) return send(res, 403, 'Forbidden');

  // Never serve dotfiles or dot-directories (.env.local, .vercel, .git, …).
  const segments = relativePath.split(/[\\/]+/).filter((s) => s && s !== '.');
  if (segments.some((s) => s.startsWith('.'))) return send(res, 404, 'Not found');
  if (PRIVATE.has(path.basename(file))) return send(res, 404, 'Not found');

  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return send(res, 404, 'Not found');
  }
  if (!stat.isFile()) return send(res, 404, 'Not found');

  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, {
    'content-type': type,
    'content-length': stat.size,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  } catch {
    return send(res, 400, 'Bad request');
  }

  const pathname = url.pathname;
  req.query = Object.fromEntries(url.searchParams);

  const apiPath = pathname.replace(/\/+$/, '');
  const handlerPath = API.get(apiPath);
  if (handlerPath) {
    let handler;
    try {
      handler = require(handlerPath);
    } catch (err) {
      console.error(`[api] ${apiPath} failed to load`, err);
      return json(res, 500, { ok: false, error: 'Handler failed to load.' });
    }
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((err) => {
        console.error(`[api] ${apiPath} threw`, err);
        if (!res.headersSent) json(res, 500, { ok: false, error: 'Internal error.' });
        else res.end();
      });
    return;
  }

  if (pathname === '/api' || pathname.startsWith('/api/')) {
    return json(res, 404, { ok: false, error: 'Unknown API route.' });
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, 'Method not allowed', { allow: 'GET, HEAD' });
  }

  if (ROUTES.has(pathname)) return serveStatic(req, res, ROUTES.get(pathname));

  // Localized pages: /de, /de/, /de/boost, /de/boost.html → de/*.html
  const localized = pathname.match(/^\/(de|pl|fr)(\/.*)?$/);
  if (localized) {
    const lang = localized[1];
    const rest = (localized[2] || '/').replace(/\/+$/, '');
    const file = !rest ? `${lang}/index.html`
      : rest.endsWith('.html') ? `${lang}${rest}`
      : `${lang}${rest}.html`;
    return serveStatic(req, res, file);
  }

  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return send(res, 400, 'Bad request');
  }
  serveStatic(req, res, '.' + decoded);
});

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Start with PORT=<other port> npm run dev.`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const { port } = server.address();
  console.log(`Add My Rank preview → http://${HOST}:${port} (pid ${process.pid})`);
  console.log('Static pages with clean URLs, plus live /api/scan and /api/report.');
});
