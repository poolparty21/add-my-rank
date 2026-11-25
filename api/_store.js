'use strict';

/**
 * Key/value store for generated report tokens.
 *
 * A report token is the whole report, so it is too large for Stripe metadata
 * (500 chars per value). To let the webhook and the buyer's return to /boost
 * share one report — one crawl, one token, one email — the token is kept here
 * under `report:<checkout session id>` for as long as the link is valid.
 *
 * REST only, no SDK: Upstash Redis' HTTP API, which is also what Vercel KV
 * exposes. Config (either naming works):
 *   UPSTASH_REDIS_REST_URL  + UPSTASH_REDIS_REST_TOKEN
 *   KV_REST_API_URL         + KV_REST_API_TOKEN
 *
 * Without configuration this falls back to a per-instance Map: correct locally
 * and inside one warm instance, but instances cannot see each other's entries,
 * so production needs the env vars for the "one scan per order" guarantee.
 */

const REST_TIMEOUT_MS = 5000;
const MEMORY_LIMIT = 500;

/** Values survive only for the life of the process, keyed by store key. */
const memory = new Map();

function config() {
  const url = String(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '')
    .trim()
    .replace(/\/+$/, '');
  const token = String(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '').trim();
  return url && token ? { url, token } : null;
}

function isConfigured() {
  return Boolean(config());
}

/** Run one Redis command through the REST API. Values are never logged. */
async function command(args) {
  const cfg = config();
  if (!cfg) throw new Error('No report store is configured.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REST_TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      signal: controller.signal,
    });
    const data = await res.json().catch(() => ({}));
    const error = data && data.error;
    if (!res.ok || error) {
      throw new Error('store command failed' + (error ? ': ' + error : ' (HTTP ' + res.status + ')'));
    }
    return data ? data.result : null;
  } finally {
    clearTimeout(timer);
  }
}

function remember(key, value, ttlSeconds) {
  if (memory.size >= MEMORY_LIMIT && !memory.has(key)) {
    const oldest = memory.keys().next().value;
    if (oldest !== undefined) memory.delete(oldest);
  }
  memory.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
}

let warnedFallback = false;

/** In production the memory fallback silently weakens the one-scan guarantee. */
function warnIfFallingBack() {
  if (warnedFallback) return;
  warnedFallback = true;
  if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
    console.warn(
      'report store is not configured: using per-instance memory. Set UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL/KV_REST_API_TOKEN) so one order is scanned once.',
    );
  }
}

async function get(key) {
  if (!isConfigured()) {
    warnIfFallingBack();
    const hit = memory.get(key);
    if (!hit) return null;
    if (hit.expiresAt <= Date.now()) {
      memory.delete(key);
      return null;
    }
    return hit.value;
  }
  const value = await command(['GET', key]);
  return typeof value === 'string' ? value : null;
}

async function set(key, value, ttlSeconds) {
  const ttl = Math.max(1, Math.trunc(Number(ttlSeconds) || 0));
  if (!isConfigured()) {
    warnIfFallingBack();
    remember(key, value, ttl);
    return 'OK';
  }
  return command(['SET', key, value, 'EX', ttl]);
}

async function remove(key) {
  if (!isConfigured()) {
    memory.delete(key);
    return 1;
  }
  return command(['DEL', key]);
}

const reportStore = { isConfigured, get, set, remove };

module.exports = { reportStore, isConfigured, get, set, remove };