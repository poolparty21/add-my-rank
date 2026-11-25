#!/usr/bin/env node
'use strict';

/**
 * Generates the localized pages: de/, pl/, fr/ — one copy of each page per
 * language, with the title, meta description, hreflang block and body copy
 * baked into the HTML. Crawlers and no-JS visitors get real localized content
 * instead of waiting for i18n.js to rewrite the page.
 *
 *   node build-locales.js            # regenerate de/ pl/ fr/ (and the head of the English pages)
 *   node build-locales.js --check    # fail if the committed copies are stale
 *   node build-locales.js --warn     # warn about stale copies, then regenerate
 *
 * The English dictionaries in i18n.js stay the single source of truth: this
 * script loads that file, asks it for each language's strings, and writes the
 * result next to the English pages. The deploy runs --warn, so a forgotten
 * regeneration is reported in the build log but never ships stale pages.
 */

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = __dirname;
const ORIGIN = 'https://add-my-rank.vercel.app';
const LOCALES = ['de', 'pl', 'fr'];
const ALL = ['en'].concat(LOCALES);
const PAGES = [
  { file: 'index.html', kind: 'index', titleKey: 'meta.title', descKey: 'meta.description' },
  { file: 'boost.html', kind: 'boost', titleKey: 'boost.meta.title', descKey: 'boost.meta.description' },
  { file: 'report.html', kind: 'report', titleKey: 'report.meta.title', descKey: 'report.meta.description' },
];

/** Report pages are signed, noindex token views — never in the sitemap. */
const SITEMAP_PAGES = PAGES.filter((page) => page.kind !== 'report');

const MODE = process.argv.includes('--check') ? 'check' : process.argv.includes('--warn') ? 'warn' : 'write';

const I18N_SOURCE = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');

/** Run i18n.js in a stub DOM and hand back its translation function. */
function translator(lang) {
  const noop = () => {};
  const sandbox = {
    window: {},
    document: {
      readyState: 'loading', // never fires DOMContentLoaded here
      // i18n.js reads its language from <html data-locale>: the stub page has
      // to look like a generated page in `lang`, or it renders English.
      documentElement: { getAttribute: (name) => (name === 'data-locale' ? lang : null), lang: '' },
      body: { getAttribute: () => null },
      querySelectorAll: () => [],
      querySelector: () => null,
      addEventListener: noop,
      dispatchEvent: noop,
      title: '',
    },
    navigator: { language: lang, languages: [lang] },
    localStorage: { getItem: () => null, setItem: noop },
    location: { search: '?lang=' + lang, href: ORIGIN + '/?lang=' + lang, pathname: '/', replace: noop },
    history: { replaceState: noop },
    URLSearchParams,
    CustomEvent: function () {},
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(I18N_SOURCE, sandbox);
  return sandbox.window.AMR.t;
}

// No trailing slash: vercel.json runs trailingSlash:false, so /de/ would be a
// 308 to /de and the sitemap should only list the final URL.
function urlFor(lang, kind) {
  const prefix = lang === 'en' ? '' : '/' + lang;
  if (kind === 'index') return ORIGIN + prefix + (prefix ? '' : '/');
  return ORIGIN + prefix + '/' + kind;
}

function headBlock(lang, kind) {
  const lines = [
    '<!-- locale-head -->',
    '<link rel="canonical" href="' + urlFor(lang, kind) + '">',
  ];
  for (const code of ALL) {
    lines.push('<link rel="alternate" hreflang="' + code + '" href="' + urlFor(code, kind) + '">');
  }
  lines.push('<link rel="alternate" hreflang="x-default" href="' + urlFor('en', kind) + '">');
  lines.push('<!-- /locale-head -->');
  return lines.join('\n');
}

/** Replace text/HTML inside every data-i18n element, using its own close tag. */
function translateContent(html, t) {
  const open = /<([a-zA-Z][\w-]*)\b([^>]*?)\sdata-i18n(-html)?="([^"]+)"([^>]*)>/g;
  let out = '';
  let cursor = 0;
  let match;
  while ((match = open.exec(html))) {
    const [tag, name, , , key] = match;
    const start = match.index;
    const innerStart = start + tag.length;
    const closeAt = html.indexOf('</' + name + '>', innerStart);
    if (closeAt === -1) continue; // unmatched: leave the element alone
    out += html.slice(cursor, start) + tag + t(key);
    cursor = closeAt;
    open.lastIndex = closeAt;
  }
  return out + html.slice(cursor);
}

function translateAttributes(html, t) {
  return html
    .replace(/(placeholder=")([^"]*)("[^>]*data-i18n-placeholder="([^"]+)")/g, (m, a, _old, c, key) => a + t(key) + c)
    .replace(/(data-i18n-aria="([^"]+)"[^>]*aria-label=")([^"]*)(")/g, (m, a, key, _old, d) => a + t(key) + d);
}

function rewriteLinks(html, lang) {
  if (lang === 'en') return html;
  return html
    .replace(/<html lang="en">/, '<html lang="' + lang + '" data-locale="' + lang + '">')
    .replace('src="i18n.js"', 'src="/i18n.js"')
    .replace(/href="index\.html#/g, 'href="/' + lang + '/#')
    .replace(/href="index\.html"/g, 'href="/' + lang + '/"')
    .replace(/href="boost\.html"/g, 'href="/' + lang + '/boost.html"')
    .replace(/'boost\.html\?url='/g, "'/" + lang + "/boost.html?url='")
    .replace(/href="\/index\.html"/g, 'href="/' + lang + '"')
    .replace(/href="\/boost\.html#/g, 'href="/' + lang + '/boost#')
    .replace(/href="\/boost\.html"/g, 'href="/' + lang + '/boost"');
}

/** Language-aware JSON-LD so crawlers get the same entity on every locale. */
function structuredData(lang, page, t) {
  if (page.kind === 'report') return '';
  const graph = [
    {
      '@type': 'Organization',
      '@id': ORIGIN + '/#organization',
      name: 'Add My Rank',
      url: ORIGIN + '/',
      logo: ORIGIN + '/favicon.svg',
    },
    {
      '@type': 'WebSite',
      '@id': ORIGIN + '/#website',
      url: urlFor(lang, 'index'),
      name: 'Add My Rank',
      description: t('meta.description'),
      inLanguage: lang,
      publisher: { '@id': ORIGIN + '/#organization' },
    },
  ];
  if (page.kind === 'boost') {
    graph.push({
      '@type': 'Service',
      '@id': urlFor(lang, 'boost') + '#service',
      name: 'SiteBoost 300',
      serviceType: 'Search engine submission and crawlability report',
      description: t('boost.meta.description'),
      provider: { '@id': ORIGIN + '/#organization' },
      areaServed: 'Worldwide',
      offers: {
        '@type': 'Offer',
        price: '7.00',
        priceCurrency: 'USD',
        url: urlFor(lang, 'boost'),
        availability: 'https://schema.org/InStock',
      },
    });
  }
  const json = JSON.stringify({ '@context': 'https://schema.org', '@graph': graph }).replace(/</g, '\\u003c');
  // The markers let the next run replace exactly this block. Any other
  // structured data a page grows (FAQ, breadcrumbs, …) is left alone.
  return (
    '<!-- structured-data -->\n' +
    '<script type="application/ld+json">' + json + '</script>\n' +
    '<!-- /structured-data -->'
  );
}

function applyHead(html, lang, page, t) {
  const block = headBlock(lang, page.kind);
  // Strip every previous block first, then insert exactly one: replacing in
  // place is not enough, because an unchanged replacement still compares equal
  // to the input and would be inserted a second time.
  let out = html.replace(/<!-- locale-head -->[\s\S]*?<!-- \/locale-head -->\n?/g, '');
  // noindex token pages get no canonical/hreflang cluster
  if (page.kind !== 'report') {
    out = out.replace(/(<link rel="icon"[^>]*>\n)/, (m, icon) => icon + block + '\n');
  }
  out = out.replace(/<title>[\s\S]*?<\/title>/, '<title>' + t(page.titleKey) + '</title>');
  out = out.replace(
    /(<meta name="description" content=")([^"]*)(")/,
    (m, a, _old, c) => a + t(page.descKey).replace(/"/g, '&quot;') + c
  );
  // Social unfurl tags repeat the same two strings, so a translated page can
  // never unfurl with an English title. Pages that do not declare them are
  // left untouched.
  out = out.replace(/(<meta property="og:title" content=")([^"]*)(")/,
    (m, a, _old, c) => a + t(page.titleKey).replace(/"/g, '&quot;') + c);
  out = out.replace(/(<meta property="og:description" content=")([^"]*)(")/,
    (m, a, _old, c) => a + t(page.descKey).replace(/"/g, '&quot;') + c);
  out = out.replace(/(<meta name="twitter:title" content=")([^"]*)(")/,
    (m, a, _old, c) => a + t(page.titleKey).replace(/"/g, '&quot;') + c);
  out = out.replace(/(<meta name="twitter:description" content=")([^"]*)(")/,
    (m, a, _old, c) => a + t(page.descKey).replace(/"/g, '&quot;') + c);
  out = out.replace(/(<meta property="og:url" content=")([^"]*)(")/,
    (m, a, _old, c) => a + urlFor(lang, page.kind) + c);
  // Remove only the block this script generated, identified by its markers, so
  // a localized page does not inherit the English block from the template while
  // any hand-written structured data on the page survives regeneration.
  out = out.replace(/<!-- structured-data -->[\s\S]*?<!-- \/structured-data -->\n?/g, '');
  const data = structuredData(lang, page, t);
  if (data) out = out.replace('</head>', data + '\n</head>');
  return out;
}

/** sitemap.xml: every language of every page, each with its hreflang cluster. */
function sitemap() {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
  ];
  for (const page of SITEMAP_PAGES) {
    for (const lang of ALL) {
      lines.push('  <url>');
      lines.push('    <loc>' + urlFor(lang, page.kind) + '</loc>');
      for (const alt of ALL) {
        lines.push('    <xhtml:link rel="alternate" hreflang="' + alt + '" href="' + urlFor(alt, page.kind) + '"/>');
      }
      lines.push('    <xhtml:link rel="alternate" hreflang="x-default" href="' + urlFor('en', page.kind) + '"/>');
      lines.push('  </url>');
    }
  }
  lines.push('</urlset>');
  return lines.join('\n') + '\n';
}

/** Every page this script owns: relative path → intended contents. */
function renderAll() {
  const outputs = new Map();
  outputs.set('sitemap.xml', sitemap());
  for (const page of PAGES) {
    const template = fs.readFileSync(path.join(ROOT, page.file), 'utf8');
    outputs.set(page.file, applyHead(template, 'en', page, translator('en')));
    for (const lang of LOCALES) {
      const t = translator(lang);
      let html = applyHead(template, lang, page, t);
      html = translateContent(html, t);
      html = translateAttributes(html, t);
      html = rewriteLinks(html, lang);
      outputs.set(lang + '/' + page.file, html);
    }
  }
  return outputs;
}

// Guard against "the translator quietly fell back to English", which would
// rewrite every localized page with English copy and still look successful.
const englishSample = translator('en')('hero.title2');
for (const lang of LOCALES) {
  if (translator(lang)('hero.title2') === englishSample) {
    console.error('Refusing to write: translations for "' + lang + '" resolved to English.');
    process.exit(1);
  }
}

const outputs = renderAll();

const stale = [];
for (const [relPath, intended] of outputs) {
  let current = null;
  try {
    current = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  } catch {
    current = null;
  }
  if (current !== intended) stale.push(relPath);
}

if (stale.length) {
  const list = stale.map((p) => '  - ' + p).join('\n');
  if (MODE === 'check') {
    console.error('Localized pages are stale:\n' + list);
    console.error('\nRun `npm run build:locales` and commit the result.');
    process.exit(1);
  }
  console.warn('WARNING: localized pages were stale and have been regenerated:\n' + list);
} else if (MODE === 'check') {
  console.log('Localized pages and sitemap are up to date (' + outputs.size + ' files).');
  process.exit(0);
}

if (MODE !== 'check') {
  for (const [relPath, intended] of outputs) {
    const target = path.join(ROOT, relPath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target) && fs.readFileSync(target, 'utf8') === intended) continue;
    fs.writeFileSync(target, intended);
  }
  console.log('Wrote ' + outputs.size + ' files (' + ALL.join(', ') + ').');
}
