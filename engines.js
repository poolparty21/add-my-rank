/**
 * The search-engine fleet, defined exactly once.
 *
 *   name  — the identity: what the scanner writes into reports, what the boost
 *           form submits as `data-engine`, and what /api/checkout validates.
 *   slug  — the URL-safe form used by engine pages and the sitemap.
 *   short — the compact label on the landing page's engine cards. A shorter
 *           rendering of the same entry, never a different engine.
 *
 * Node loads this with require() (api/, build-locales.js); the browser gets the
 * same object as window.AMR_ENGINES from a plain <script>. There is no second
 * list anywhere — pages and boost form are generated from this.
 */
(function (root, factory) {
  const registry = factory();
  if (typeof module === 'object' && module.exports) module.exports = registry;
  else root.AMR_ENGINES = registry;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const ENGINES = [
    { slug: 'google', name: 'Google', short: 'Google', flag: '', country: '', channel: 'official · Search Console', tier: 'core' },
    { slug: 'bing', name: 'Bing', short: 'Bing', flag: '', country: '', channel: 'official · Webmaster Tools · feeds DDG + Yahoo', tier: 'core' },
    { slug: 'duckduckgo', name: 'DuckDuckGo', short: 'DuckDuckGo', flag: '', country: '', channel: 'via Bing index', tier: 'core' },
    { slug: 'yandex', name: 'Yandex', short: 'Yandex', flag: '🇷🇺', country: 'RU', channel: 'IndexNow', tier: 'tier2' },
    { slug: 'baidu', name: 'Baidu', short: 'Baidu', flag: '🇨🇳', country: 'CN', channel: 'Zhanzhang', tier: 'tier2' },
    { slug: 'naver', name: 'Naver', short: 'Naver', flag: '🇰🇷', country: 'KR', channel: 'Search Advisor', tier: 'tier2' },
    { slug: 'seznam', name: 'Seznam', short: 'Seznam', flag: '🇨🇿', country: 'CZ', channel: 'IndexNow', tier: 'tier2' },
    { slug: 'yahoo-japan', name: 'Yahoo! Japan', short: 'Yahoo! JP', flag: '🇯🇵', country: 'JP', channel: 'submission', tier: 'tier2' },
    { slug: 'yahoo-taiwan', name: 'Yahoo! Taiwan', short: 'Yahoo! TW', flag: '🇹🇼', country: 'TW', channel: 'submission', tier: 'tier2' },
    { slug: 'mojeek', name: 'Mojeek', short: 'Mojeek', flag: '', country: '', channel: 'own crawler', tier: 'tier3' },
    { slug: 'brave-search', name: 'Brave Search', short: 'Brave', flag: '', country: '', channel: 'own index', tier: 'tier3' },
    { slug: 'startpage', name: 'Startpage', short: 'Startpage', flag: '', country: '', channel: 'submission', tier: 'tier3' },
    { slug: 'marginalia', name: 'Marginalia', short: 'Marginalia', flag: '', country: '', channel: 'own crawler', tier: 'tier3' },
    { slug: 'stract', name: 'Stract', short: 'Stract', flag: '', country: '', channel: 'open index', tier: 'tier3' },
  ];

  /** Ordered membership lists, by slug. Layout grouping only — identity stays above. */
  const groups = {
    core: ['google', 'bing', 'duckduckgo'],
    giants: ['yandex', 'baidu', 'naver'],
    local: ['seznam', 'yahoo-japan', 'yahoo-taiwan'],
    independent: ['mojeek', 'brave-search', 'startpage'],
    longtail: ['mojeek', 'brave-search', 'startpage', 'marginalia', 'stract'],
  };

  /** The boost form's two editable tiers (tier 1 is locked on). */
  const boostTiers = {
    tier2: ['yandex', 'baidu', 'naver', 'seznam', 'yahoo-japan', 'yahoo-taiwan'],
    tier3: ['mojeek', 'brave-search', 'startpage', 'marginalia', 'stract'],
  };

  const bySlugMap = new Map(ENGINES.map((engine) => [engine.slug, engine]));

  function bySlug(slug) {
    const engine = bySlugMap.get(slug);
    if (!engine) throw new TypeError('Unknown engine slug: ' + slug);
    return engine;
  }

  const registry = {
    engines: ENGINES,
    groups,
    boostTiers,
    bySlug,
    /** Canonical names, in fleet order — what reports and checkout use. */
    allNames: ENGINES.map((engine) => engine.name),
    namesFor: (slugs) => slugs.map((slug) => bySlug(slug).name),
    slugsFor: (names) => ENGINES.filter((engine) => names.includes(engine.name)).map((engine) => engine.slug),
    /** ISO country code → the local engine that dominates it. */
    forCountry: (country) => ENGINES.find((engine) => engine.country && engine.country === country) || null,
  };

  return registry;
});
