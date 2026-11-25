/**
 * Add My Rank — scan engine
 *
 * Shared between the /api/scan (run) and /api/report (read) serverless
 * functions. CommonJS on purpose: package.json declares "type": "commonjs",
 * so .js files stay CJS and the functions run with no build or install step.
 *
 * SECURITY: this code fetches a URL supplied by an anonymous visitor, on our
 * behalf, from inside our network. That is a server-side request forgery
 * (SSRF) hole unless it is closed deliberately, so every fetch goes through
 * safeFetch(), which validates the scheme, resolves DNS, refuses private /
 * reserved / link-local addresses, re-validates every redirect hop, and caps
 * time and bytes. Do not add fetch() calls to this file outside safeFetch().
 */

const dns = require('node:dns').promises;
const crypto = require('node:crypto');
const { allNames: ALL_ENGINES, forCountry } = require('../engines.js');

const UA = 'AddMyRankBot/1.0 (+https://addmyrank.vercel.app; crawlability audit)';
const FETCH_TIMEOUT_MS = 8000;
const MAX_BYTES = 3 * 1024 * 1024; // 3 MB per response
const MAX_REDIRECTS = 5;
const MAX_IMAGE_PROBES = 12;

/** Thrown for problems we can explain to the customer. */
class ScanError extends Error {
  constructor(message, status = 400, code = '') {
    super(message);
    this.name = 'ScanError';
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------------------
// SSRF protection
// ---------------------------------------------------------------------------

const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16',
  '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24', '192.88.99.0/24',
  '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24',
  '224.0.0.0/4', '240.0.0.0/4',
];

function v4ToInt(ip) {
  const p = ip.split('.').map(Number);
  return (((p[0] << 24) >>> 0) + (p[1] << 16) + (p[2] << 8) + p[3]) >>> 0;
}

const V4_RANGES = BLOCKED_V4.map((cidr) => {
  const [base, bits] = cidr.split('/');
  const mask = bits === '0' ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0;
  return { net: (v4ToInt(base) & mask) >>> 0, mask };
});

/** True when the literal IP must never be fetched by us. */
function isBlockedIp(ip) {
  const addr = String(ip).toLowerCase().replace(/^\[|\]$/g, '');

  if (/^\d+\.\d+\.\d+\.\d+$/.test(addr)) {
    const n = v4ToInt(addr);
    return V4_RANGES.some((r) => ((n & r.mask) >>> 0) === r.net);
  }

  if (!addr.includes(':')) return true; // not an IP literal and not a hostname: caller resolves first

  // IPv4-mapped / NAT64 forms must be judged by the IPv4 rules.
  const mapped = addr.match(/^::(?:ffff:(?:\d+\.){3}\d+|ffff:0:(\d+\.\d+\.\d+\.\d+))$/);
  if (addr.startsWith('::ffff:')) {
    const v4 = addr.slice(7);
    if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return isBlockedIp(v4);
  }
  if (addr.startsWith('64:ff9b::')) return true; // NAT64
  if (mapped) return true;

  if (addr === '::' || addr === '::1') return true;
  if (/^fe[89ab]/.test(addr)) return true; // link-local fe80::/10
  if (/^f[cd]/.test(addr)) return true; // unique-local fc00::/7
  if (/^ff/.test(addr)) return true; // multicast
  return false;
}

const ALLOWED_PORTS = new Set(['80', '443', '8080', '8443']);

/**
 * Validate a user-supplied URL before we touch the network.
 * Returns the parsed URL with a normalised origin.
 */
async function assertSafeUrl(raw) {
  let input = String(raw || '').trim();
  if (!input) throw new ScanError('Please enter your website address.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) input = 'https://' + input;

  let url;
  try {
    url = new URL(input);
  } catch {
    throw new ScanError(`"${raw}" is not a valid web address.`);
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ScanError('Only http and https addresses can be scanned.');
  }
  if (url.username || url.password) {
    throw new ScanError('Remove the username/password from the address and try again.');
  }

  const port = url.port || (url.protocol === 'https:' ? '443' : '80');
  if (!ALLOWED_PORTS.has(port)) {
    throw new ScanError('That port cannot be scanned. Use the standard web address of your site.');
  }
  url.port = '';

  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    addresses = [host];
  } else {
    try {
      const resolved = await dns.lookup(host, { all: true });
      addresses = resolved.map((r) => r.address);
    } catch {
      throw new ScanError(`We could not resolve ${host}. Check the address and try again.`);
    }
  }

  if (!addresses.length) throw new ScanError(`We could not resolve ${host}.`);
  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      throw new ScanError('That address points to a private or internal network, so it cannot be scanned.');
    }
  }

  return url;
}

async function readCapped(res) {
  if (!res.body) return Buffer.alloc(0);
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_BYTES) return Buffer.concat(chunks);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

/**
 * The only sanctioned way to make an outbound request in this project.
 * Follows redirects by hand so every hop is re-validated.
 */
async function safeFetch(rawUrl, opts = {}) {
  const { method = 'GET', accept = 'text/html,*/*', maxBytes = MAX_BYTES } = opts;
  let current = await assertSafeUrl(rawUrl);
  const chain = [];

  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(current, {
        method,
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': UA, accept, 'accept-language': 'en,*;q=0.8' },
      });
    } catch (err) {
      const reason = err && err.name === 'AbortError' ? 'timed out' : 'could not be reached';
      throw new ScanError(`${current.origin} ${reason}.`, 502);
    } finally {
      clearTimeout(timer);
    }

    const location = res.headers.get('location');
    if ([301, 302, 303, 307, 308].includes(res.status) && location) {
      let next;
      try {
        next = new URL(location, current).toString();
      } catch {
        throw new ScanError(`${current.origin} sent an invalid redirect.`, 502);
      }
      chain.push({ from: current, status: res.status });
      current = await assertSafeUrl(next);
      continue;
    }

    let body = Buffer.alloc(0);
    if (method === 'GET' && res.status < 400) body = await readCapped(res);
    else if (res.body) {
      try {
        await res.body.cancel();
      } catch {}
    }
    return { url: current, status: res.status, headers: res.headers, body, chain };
  }
  throw new ScanError('Too many redirects — check your site configuration.', 502);
}

// ---------------------------------------------------------------------------
// Tiny HTML helpers (regex based, no dependencies)
// ---------------------------------------------------------------------------

function decodeEntities(s = '') {
  return s
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, ent) => {
      if (ent[0] === '#') {
        const code = ent[1] === 'x' || ent[1] === 'X' ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
      }
      const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…' };
      return named[ent.toLowerCase()] ?? m;
    })
    .replace(/\s+/g, ' ').trim();
}

function parseAttrs(tag) {
  const attrs = {};
  const re = /([\w:.-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>`]+)))?/g;
  let m;
  while ((m = re.exec(tag))) {
    attrs[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return attrs;
}

function extractHtml(html) {
  const pick = (re) => {
    const m = html.match(re);
    return m ? decodeEntities(m[1]) : '';
  };
  const meta = {};
  for (const m of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    const key = (a.name || a.property || a['http-equiv'] || '').toLowerCase();
    if (key) meta[key] = a.content || '';
  }
  const links = [];
  for (const m of html.matchAll(/<link\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    links.push({ rel: (a.rel || '').toLowerCase(), href: a.href || '' });
  }
  const images = [];
  for (const m of html.matchAll(/<img\b([^>]*)>/gi)) {
    const a = parseAttrs(m[1]);
    images.push({ src: a.src || a['data-src'] || '', alt: a.alt, width: a.width, height: a.height, loading: a.loading });
  }
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i),
    lang: pick(/<html\b[^>]*\blang\s*=\s*["']?([\w-]+)/i),
    meta,
    links,
    images,
    h1Count: (html.match(/<h1\b/gi) || []).length,
    html,
  };
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

const PENALTY = { critical: 38, high: 15, medium: 6, low: 2 };
const CATEGORY_WEIGHT = { indexability: 30, onpage: 25, technical: 20, mobile: 15, performance: 10 };
const EFFORT = {
  noindex: '1 min', robots_missing: '2 min', robots_blocked: '5 min', sitemap_missing: '5 min',
  sitemap_empty: '10 min', https: '20 min', viewport: '2 min', title_missing: '5 min',
  title_length: '2 min', desc_missing: '5 min', desc_length: '3 min', canonical: '5 min',
  lang: '2 min', images_heavy: '15 min', images_alt: '20 min', images_dims: '20 min',
  images_lazy: '10 min', img_formats: '20 min', charset: '1 min', social: '10 min',
  mixed_content: '15 min', redirect_https: '10 min', sitemaps: '10 min',
};

function finding(id, category, severity, title, detail, fix) {
  return { id, category, severity, title, detail, fix, effort: EFFORT[id] || '10 min' };
}

function parseRobots(txt) {
  const groups = [];
  let current = null;
  const sitemaps = [];
  let crawlDelay = null;
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (field === 'sitemap') sitemaps.push(value);
    else if (field === 'user-agent') {
      current = { agents: [value.toLowerCase()], disallow: [], allow: [] };
      groups.push(current);
    } else if (field === 'disallow' && current) current.disallow.push(value);
    else if (field === 'allow' && current) current.allow.push(value);
    else if (field === 'crawl-delay' && current) crawlDelay = Number(value) || null;
  }
  return { groups, sitemaps, crawlDelay };
}

/** robots.txt path matching with * and $ wildcards. */
function robotsAllows(rules, path) {
  const test = (pattern) => {
    const anchoredEnd = pattern.endsWith('$');
    const body = anchoredEnd ? pattern.slice(0, -1) : pattern;
    const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + (anchoredEnd ? '$' : '')).test(path);
  };
  let allowed = true;
  for (const rule of rules.disallow) {
    if (rule === '') continue;
    if (test(rule)) allowed = false;
  }
  for (const rule of rules.allow) {
    if (rule && test(rule)) allowed = true;
  }
  return allowed;
}

async function probeImageSize(src) {
  try {
    const res = await safeFetch(src, { method: 'HEAD', maxBytes: 0 });
    const len = Number(res.headers.get('content-length') || 0);
    return { src, status: res.status, bytes: len };
  } catch {
    return { src, status: 0, bytes: 0 };
  }
}

async function runScan(targetUrl) {
  const start = await assertSafeUrl(targetUrl);
  const findings = [];

  // 1. Fetch the homepage (follows redirects, every hop validated).
  const home = await safeFetch(start.toString());
  const finalUrl = home.url;

  const html = home.body.toString('utf8');
  const doc = extractHtml(html);

  // 2. HTTPS.
  const isHttps = finalUrl.protocol === 'https:';
  const upgraded = isHttps && finalUrl.host !== start.host;
  if (isHttps) {
    findings.push(finding('https', 'technical', 'pass', 'HTTPS is active',
      `Your site is served over encrypted HTTPS at ${finalUrl.host}.`,
      'Nothing to do — keep your certificate renewing.'));
  } else {
    findings.push(finding('https', 'technical', 'critical', 'Site is not served over HTTPS',
      `Browsers mark ${finalUrl.host} as “Not secure”, and search engines treat HTTP sites as less trustworthy.`,
      'Install an SSL certificate and force all pages to redirect to https://.'));
  }
  if (upgraded) {
    findings.push(finding('redirect_https', 'technical', 'low', 'HTTP redirects to HTTPS',
      `http:// redirects to https://${finalUrl.host} — correct.`, 'No action needed.'));
  }

  // 3. robots.txt
  let robots = null;
  try {
    const res = await safeFetch(new URL('/robots.txt', finalUrl).toString(), { accept: 'text/plain' });
    if (res.status === 200) {
      const txt = res.body.toString('utf8');
      robots = parseRobots(txt);
      const star = robots.groups.find((g) => g.agents.includes('*')) || { disallow: [], allow: [] };
      if (robotsAllows(star, '/') === false) {
        findings.push(finding('robots_blocked', 'indexability', 'critical', 'robots.txt blocks all crawling',
          'Your robots.txt contains "Disallow: /", which tells every crawler to ignore your entire site.',
          'Remove or narrow the Disallow rule so search engines can reach your pages.'));
      } else {
        findings.push(finding('robots_blocked', 'indexability', 'pass', 'Crawlers are allowed in',
          `robots.txt is present and ${robotsAllows(star, '/') ? 'does not block' : 'blocks'} your homepage.`,
          'Nothing to do.'));
      }
      findings.push(finding('robots_missing', 'indexability', 'pass', 'robots.txt found',
        `Crawler rules are published at ${finalUrl.origin}/robots.txt${robots.crawlDelay ? ` (crawl-delay: ${robots.crawlDelay})` : ''}.`,
        'Nothing to do.'));
    } else {
      findings.push(finding('robots_missing', 'indexability', 'medium', 'No robots.txt',
        `We could not find a robots.txt at ${finalUrl.origin}/robots.txt.`,
        'Publish a robots.txt that allows crawling and points to your sitemap.'));
    }
  } catch (err) {
    if (!(err instanceof ScanError)) throw err;
    findings.push(finding('robots_missing', 'indexability', 'medium', 'robots.txt could not be fetched',
      err.message, 'Publish a robots.txt at the root of your domain.'));
  }

  // 4. sitemaps (root sitemap.xml plus any declared in robots.txt).
  const candidates = [new URL('/sitemap.xml', finalUrl).toString()];
  if (robots) for (const s of robots.sitemaps.slice(0, 3)) if (/^https?:/i.test(s)) candidates.push(s);

  let sitemapUrls = [];
  let sitemapOk = 0;
  for (const candidate of candidates) {
    try {
      const res = await safeFetch(candidate, { accept: 'application/xml,text/xml,*/*' });
      if (res.status !== 200) continue;
      const xml = res.body.toString('utf8');
      const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => decodeEntities(m[1]));
      const lastmods = (xml.match(/<lastmod>/gi) || []).length;
      sitemapUrls = sitemapUrls.concat(locs);
      sitemapOk += 1;
      if (lastmods === 0 && locs.length) {
        findings.push(finding('sitemaps', 'indexability', 'low', 'Sitemap has no lastmod dates',
          `${locs.length} URLs found but none carry <lastmod>, so engines can’t tell what changed.`,
          'Regenerate your sitemap with lastmod dates.'));
      }
    } catch (err) {
      if (!(err instanceof ScanError)) throw err;
    }
  }

  if (sitemapOk > 0) {
    const listed = sitemapUrls.some((u) => {
      try {
        return new URL(u).host === finalUrl.host;
      } catch {
        return false;
      }
    });
    findings.push(listed
      ? finding('sitemap_missing', 'indexability', 'pass', `Sitemap lists ${sitemapUrls.length} URLs`,
        'Your sitemap is valid XML and lists pages on this domain.',
        'Nothing to do — keep it regenerated as you add pages.')
      : finding('sitemap_empty', 'indexability', 'high', 'Sitemap does not list your homepage',
        'A sitemap was found but it contains no URLs for this domain.',
        'Regenerate your sitemap so it lists your real pages.'));
  } else {
    findings.push(finding('sitemap_missing', 'indexability', 'high', 'No valid XML sitemap',
      `We could not find a sitemap at ${finalUrl.origin}/sitemap.xml${robots && robots.sitemaps.length ? ' or in robots.txt' : ''}.`,
      'Generate an XML sitemap listing your pages and submit it in robots.txt and Search Console.'));
  }

  // 5. meta / on-page
  if (doc.title) {
    findings.push(doc.title.length >= 10 && doc.title.length <= 70
      ? finding('title_length', 'onpage', 'pass', `Title tag looks good (${doc.title.length} chars)`,
        `“${doc.title}”`, 'Nothing to do.')
      : finding('title_length', 'onpage', 'medium', doc.title.length < 10 ? 'Title tag is too short' : 'Title tag is too long',
        `Your title is ${doc.title.length} characters; search engines show ~50-60.`,
        'Rewrite it to lead with your main keyword and a benefit.'));
  } else {
    findings.push(finding('title_missing', 'onpage', 'high', 'No title tag',
      'Your homepage has no <title>, which is the strongest on-page ranking signal you control.',
      'Add a unique, descriptive title of 50-60 characters.'));
  }

  const desc = doc.meta.description || '';
  if (!desc) {
    findings.push(finding('desc_missing', 'onpage', 'high', 'No meta description',
      'Without one, engines invent the snippet shown in results.',
      'Write a 150-160 character description that makes people click.'));
  } else if (desc.length < 70 || desc.length > 165) {
    findings.push(finding('desc_length', 'onpage', 'low', 'Meta description could be tuned',
      `It is ${desc.length} characters; 150-160 usually fits search results best.`,
      'Expand it slightly to use the space available in the snippet.'));
  } else {
    findings.push(finding('desc_length', 'onpage', 'pass', 'Meta description looks good',
      `${desc.length} characters.`, 'Nothing to do.'));
  }

  const robotsMeta = (doc.meta.robots || '').toLowerCase();
  if (/\bnoindex\b/.test(robotsMeta)) {
    findings.push(finding('noindex', 'indexability', 'critical', 'Homepage is set to noindex',
      `Your meta robots tag says "${doc.meta.robots}". This instructs every engine to drop your site from results entirely.`,
      'Remove noindex from the tag — this one setting can silently erase your rankings.'));
  } else {
    findings.push(finding('noindex', 'indexability', 'pass', 'Homepage is indexable',
      robotsMeta ? `meta robots is “${doc.meta.robots}”.` : 'No blocking meta robots tag found.',
      'Nothing to do.'));
  }

  const canonical = doc.links.find((l) => l.rel === 'canonical' && l.href);
  if (!canonical) {
    findings.push(finding('canonical', 'onpage', 'medium', 'No canonical tag',
      'Canonicals stop engines treating http/https and www/non-www as duplicate pages.',
      'Add <link rel="canonical" href="https://yourdomain.com/"> to your <head>.'));
  } else {
    let pointsHome = false;
    try {
      pointsHome = new URL(canonical.href, finalUrl).host === finalUrl.host;
    } catch {}
    findings.push(pointsHome
      ? finding('canonical', 'onpage', 'pass', 'Canonical tag points at this site', canonical.href, 'Nothing to do.')
      : finding('canonical', 'onpage', 'high', 'Canonical points to a different domain',
        `Your canonical tag points at ${canonical.href}, telling engines to credit that site instead.`,
        'Point the canonical at your own homepage.'));
  }

  if (doc.lang) {
    findings.push(finding('lang', 'onpage', 'pass', `Page language declared (${doc.lang})`, 'Correct for international SEO.', 'Nothing to do.'));
  } else {
    findings.push(finding('lang', 'onpage', 'low', 'No lang attribute on <html>',
      'Engines use it to judge language and regional relevance.',
      'Add lang="en" (or your language) to your <html> tag.'));
  }

  const hasSocial = doc.meta['og:title'] && doc.meta['og:image'];
  findings.push(hasSocial
    ? finding('social', 'onpage', 'pass', 'Social share tags present', 'Open Graph tags control how links look when shared.', 'Nothing to do.')
    : finding('social', 'onpage', 'low', 'Social share tags missing',
      'Shares of your links will render without a title or image.',
      'Add og:title, og:description and og:image to your <head>.'));

  findings.push(doc.meta.charset
    ? finding('charset', 'technical', 'pass', 'Character encoding declared', `<meta charset="${doc.meta.charset}">`, 'Nothing to do.')
    : finding('charset', 'technical', 'low', 'No charset declared',
      'Missing encoding declarations can scramble characters for some crawlers.',
      'Add <meta charset="utf-8"> as the first tag in <head>.'));

  // 6. mobile
  const viewport = doc.meta.viewport || '';
  if (!viewport) {
    findings.push(finding('viewport', 'mobile', 'high', 'No mobile viewport tag',
      'Without it, mobile browsers render your site at desktop width and zoom out.',
      'Add <meta name="viewport" content="width=device-width, initial-scale=1">.'));
  } else if (/user-scalable\s*=\s*no|maximum-scale\s*=\s*1(\b|$)/i.test(viewport)) {
    findings.push(finding('viewport', 'mobile', 'medium', 'Viewport blocks zooming',
      `“${viewport}” stops users from zooming, which Google treats as a mobile problem.`,
      'Remove user-scalable=no and maximum-scale=1.'));
  } else {
    findings.push(finding('viewport', 'mobile', 'pass', 'Mobile viewport is correct', `“${viewport}”`, 'Nothing to do.'));
  }

  // 7. images: weight, alt, dimensions, lazy loading
  const imgs = doc.images;
  const probes = await Promise.all(
    imgs.slice(0, MAX_IMAGE_PROBES).map((i) => (i.src ? probeImageSize(new URL(i.src, finalUrl).toString()) : Promise.resolve(null)))
  );
  const measured = probes.filter(Boolean);
  const totalBytes = measured.reduce((sum, p) => sum + (p.bytes || 0), 0);
  const sampled = measured.length;
  const extrapolated = sampled && sampled < imgs.length ? Math.round(totalBytes * (imgs.length / sampled)) : totalBytes;
  const mb = (extrapolated / (1024 * 1024)).toFixed(1);

  if (imgs.length === 0) {
    findings.push(finding('images_heavy', 'performance', 'pass', 'No images on this page', 'Nothing to measure.', 'Nothing to do.'));
  } else if (extrapolated > 3 * 1024 * 1024) {
    findings.push(finding('images_heavy', 'performance', 'high', `Images weigh about ${mb} MB`,
      `We measured ${sampled} image${sampled === 1 ? '' : 's'} on this page (${imgs.length} total). Heavy images are the #1 cause of slow pages.`,
      'Compress them (WebP/AVIF), resize to display size, and serve responsive variants.'));
  } else {
    findings.push(finding('images_heavy', 'performance', 'pass', `Image weight is fine (~${mb} MB)`,
      `${imgs.length} image${imgs.length === 1 ? '' : 's'} on the page.`, 'Nothing to do.'));
  }

  const missingAlt = imgs.filter((i) => i.alt === undefined || i.alt === '').length;
  findings.push(missingAlt === 0
    ? finding('images_alt', 'onpage', 'pass', 'All images have alt text', 'Good for accessibility and image search.', 'Nothing to do.')
    : finding('images_alt', 'onpage', missingAlt > imgs.length / 2 ? 'medium' : 'low',
      `${missingAlt} of ${imgs.length} images have no alt text`,
      'Alt text feeds accessibility and lets engines understand your images.',
      'Describe each image in a sentence or two of alt text.'));

  const noDims = imgs.filter((i) => !i.width || !i.height).length;
  findings.push(noDims > 0
    ? finding('images_dims', 'performance', 'low', `${noDims} image${noDims === 1 ? '' : 's'} without width/height`,
      'Missing dimensions cause layout shift while loading.',
      'Add width and height attributes to your img tags.')
    : finding('images_dims', 'performance', 'pass', 'Images reserve their space', 'No layout shift detected.', 'Nothing to do.'));

  const noLazy = imgs.filter((i) => i.loading !== 'lazy').length;
  findings.push(noLazy > imgs.length / 2
    ? finding('images_lazy', 'performance', 'low', 'Most images load eagerly',
      'Below-the-fold images should load="lazy" to speed up first paint.',
      'Add loading="lazy" to images below the fold.')
    : finding('images_lazy', 'performance', 'pass', 'Lazy loading is in use', 'Good for first paint.', 'Nothing to do.'));

  const modern = /\.(webp|avif)(\?|$)/i.test(imgs.map((i) => i.src).join(' '));
  findings.push(modern
    ? finding('img_formats', 'performance', 'pass', 'Modern image formats in use', 'WebP/AVIF detected.', 'Nothing to do.')
    : finding('img_formats', 'performance', 'low', 'No modern image formats detected',
      'WebP/AVIF typically cut image weight by 30-50% versus PNG/JPEG.',
      'Convert your images to WebP or AVIF.'));

  const insecureRefs = [...html.matchAll(/(?:src|href)\s*=\s*["']http:\/\/[^"']+/gi)].length;
  if (isHttps && insecureRefs > 0) {
    findings.push(finding('mixed_content', 'technical', 'high', `${insecureRefs} insecure http:// references`,
      'Browsers block or warn on these, and they slow your secure pages down.',
      'Update those links to https://.'));
  }

  // 8. Scoring
  const categories = {};
  for (const [key, weight] of Object.entries(CATEGORY_WEIGHT)) {
    const penalty = findings.filter((f) => f.category === key).reduce((s, f) => s + (PENALTY[f.severity] || 0), 0);
    categories[key] = { score: Math.max(0, 100 - penalty), weight, issues: findings.filter((f) => f.category === key && f.severity !== 'pass').length };
  }
  const total = Math.round(
    Object.values(categories).reduce((s, c) => s + (c.score * c.weight) / 100, 0)
  );
  const grade = total >= 90 ? 'A' : total >= 80 ? 'B' : total >= 70 ? 'C' : total >= 60 ? 'D' : total >= 50 ? 'E' : 'F';

  const actions = findings
    .filter((f) => f.severity !== 'pass')
    .sort((a, b) => (PENALTY[b.severity] || 0) - (PENALTY[a.severity] || 0) || CATEGORY_WEIGHT[b.category] - CATEGORY_WEIGHT[a.category])
    .slice(0, 10);

  return {
    target: {
      url: finalUrl.toString(),
      submitted: start.toString(),
      origin: finalUrl.origin,
      httpStatus: home.status,
      redirects: home.chain.length,
    },
    scannedAt: new Date().toISOString(),
    score: total,
    grade,
    categories,
    summary: {
      checks: findings.length,
      issues: findings.filter((f) => f.severity !== 'pass').length,
      critical: findings.filter((f) => f.severity === 'critical').length,
      sitemapUrls: sitemapUrls.length,
      imagesFound: imgs.length,
      imageWeightMB: Number(mb),
    },
    actions,
    checks: findings,
    engineNotes: [],
  };
}

// ---------------------------------------------------------------------------
// Signed, stateless report tokens
// ---------------------------------------------------------------------------

function reportSecret() {
  const secret = process.env.REPORT_SECRET;
  if (!secret) {
    if (process.env.NODE_ENV === 'production' || process.env.VERCEL) {
      throw new ScanError('REPORT_SECRET is not configured on the server.', 500);
    }
    return 'dev-only-insecure-secret';
  }
  return secret;
}

function signToken(report) {
  const payload = Buffer.from(JSON.stringify(report)).toString('base64url');
  const sig = crypto.createHmac('sha256', reportSecret()).update(payload).digest('base64url').slice(0, 43);
  return `${payload}.${sig}`;
}

function verifyToken(token) {
  if (typeof token !== 'string' || token.length > 64 * 1024) throw new ScanError('Malformed report token.', 400);
  const dot = token.lastIndexOf('.');
  if (dot < 1) throw new ScanError('Malformed report token.', 400);
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', reportSecret()).update(payload).digest('base64url').slice(0, 43);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new ScanError('This report link is not valid.', 400);
  const report = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  if (report && report.expiresAt && Number(report.expiresAt) < Date.now()) {
    throw new ScanError('This report link has expired. Recover it below using your email and website.', 410, 'report_expired');
  }
  return report;
}

// ---------------------------------------------------------------------------
// Request plumbing shared by the API routes
// ---------------------------------------------------------------------------

/** Every POST body we accept is a small JSON object; longer ones are a mistake. */
const MAX_BODY_BYTES = 16 * 1024;
const MAX_URL_LENGTH = 300;

/** JSON response with the headers all of our API routes share. */
function json(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

/** Read a capped JSON body; rejects oversized or malformed input as a ScanError. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
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

/**
 * The full engine fleet — also used to validate engine picks at checkout.
 * Names come from engines.js, which is the single source for the fleet, so a
 * report, a checkout payload and a boost checkbox can never disagree.
 */

/** Priority ordering + notes for the engine fleet, based on market targeting. */
function enginePlan({ country, language, medium }) {
  const primary = (forCountry(country) || {}).name;
  const all = ALL_ENGINES;
  const notes = [];
  if (primary) notes.push(`${primary} is the dominant engine for your market, so it is submitted first.`);
  if (String(language).toLowerCase() === 'english') notes.push('English content is indexed on all 14 engines.');
  if (medium === 'phone') notes.push('Phone & local selected — local listing checks are included in your fix packs.');
  return { engines: primary ? [primary, ...all.filter((e) => e !== primary)] : all, primary, notes };
}

module.exports = {
  ScanError, safeFetch, assertSafeUrl, isBlockedIp, runScan, signToken, verifyToken, enginePlan, ALL_ENGINES, UA,
  json, readBody, MAX_URL_LENGTH,
};