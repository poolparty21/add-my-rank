# Add My Rank — Sharpened Plan

*Produced by the grill-me interview, Sep 28 2026. Every decision below was explicitly chosen under pressure. Rebranded same day: brand = **Add My Rank** (domain TBD — addmyrank.com recommended), **SiteBoost 300** = the product package/catch phrase. Pay-and-list flow lives at **/boost**.*

## The pitch (as now stated)
> **Pay $7, get listed.** We submit your site to **Google, Bing, Baidu + 11 more engines** (Yandex, Naver, Seznam, Yahoo! JP/TW, Mojeek, Brave, Startpage, Marginalia, Stract, DuckDuckGo) — official channels only — plus IndexNow pings and a crawlability check, delivered as a listing report. Country / language / phone-vs-web targeting decides the engine priority and checks. **$7 all-inclusive**, card payment (Stripe), Solana later. Fix packs upsold after the report.

## Engine submission matrix (14 engines)
| Tier | Engines | Method | Notes |
|---|---|---|---|
| 1 — always | Google · Bing · DuckDuckGo | Search Console, Webmaster Tools (feeds DDG/Yahoo), sitemap ping | Locked on for every order |
| 2 — regional | Yandex · Baidu · Naver · Seznam · Yahoo! JP · Yahoo! TW | Official webmaster channels + IndexNow (Yandex, Seznam) | Auto-prioritized when customer's country matches (RU/CN/KR/CZ/JP/TW) |
| 3 — long tail | Mojeek · Brave · Startpage · Marginalia · Stract | Direct submission / own-crawler discovery | Country & language matched |

**Honesty guardrail (from grilling):** no forced-indexing claims anywhere. We submit + ping + verify crawlability; engines crawl on their own schedule. This is now the FAQ's first answer.

## Identity decisions
| Question | Decision |
|---|---|
| Who is the customer | **Non-technical small business owner** — doesn't know free audit tools exist; one click + beautiful report is the pitch |
| What "indexing" really is | **White-hat discovery signals only** — GBP, structured data, real citations, IndexNow pings. **Never** scaled link schemes (Google spam-policy violation, manual-action risk for customers) |
| The "300 bots" | **Real, countable scanner fleet** with a public job log. Launch with ~30 high-impact check classes, grow to 300 — "real, countable" stays true |
| Payment | **Stripe now, Solana later** (customer chose cards-on-ramp; original "Solana-only" was rejected as funnel-killer for non-technical buyers) |
| Upsell | **Done-for-you fix packs** ($97–$497): automated (schema/meta/sitemaps/profiles) + human specialists (content, listings, images) |
| Targeting | **Drives the pipeline**: country → local listing checks + regional speed; language → hreflang/content checks; phone-vs-web → mobile-first vs full-stack audit profile |
| First customers | **One channel, done manually** (e.g., local business communities, personal demos) |
| 90-day success metric | **~10 paying customers, 1–2 upsells** — proof a stranger will pay |
| Biggest kill risk | **"Nobody pays"** |

## Validation experiment (chosen next move)
**Fake-door + real checkout.** This landing page IS the test:
1. Deploy `index.html` as-is (it's fully static — any static host works).
2. Set the server env vars on the host: `STRIPE_SECRET_KEY` (restricted key, `rk_`), `REPORT_SECRET` (random 32+ chars), `SITE_ORIGIN` (e.g. `https://addmyrank.com`), and optionally `STRIPE_WEBHOOK_SECRET`. Checkout is created server-side; see the payment flow below.
3. Drive the one chosen channel (personal demos / local communities) to it.
4. **Success = 10 strangers pay $7.** If nobody pays for the promise, no amount of engineering saves it.

## Payment flow (as built)
`/api/checkout` validates the site (resolvable, public, so we never charge for an address we cannot scan) and creates a **Stripe Checkout Session** for $7. The price and the order are server-side: they live in the session, not the page. Stripe redirects back to `/boost?session_id=…`, and `/api/scan` re-fetches that session, requires `payment_status=paid` plus the full $7 in USD, then scans the site **named in the session metadata** — so a payment can only be redeemed for the site it was bought for. `/api/stripe-webhook` verifies signatures and logs every paid session as an order record.

**Order records:** durable, kept on the Stripe session itself (no database). `/api/stripe-webhook` stamps `metadata.order_recorded_at`, `order_status=paid` and the order fields on every paid session, idempotently, and fails the delivery (so Stripe retries) if the write does not land. `/api/scan` moves the record to `order_status=fulfilled` once the report is minted. `GET /api/orders` (header `x-orders-token` = `ORDERS_TOKEN`) lists paid sessions newest first with `state`, so an order whose buyer closed the tab shows up as `paid` instead of `fulfilled`.

**Still required before real volume:** an emailed report link. A recovered order must still be served by hand until the report is delivered by mail.

No Stripe key configured → production returns 503 and scans are paused (fails closed); local development keeps an unpaid scan path for testing.

## v1 scope (what ships)
- Landing page ✅ `index.html` (Add My Rank brand, SiteBoost 300 catch phrase, 14-engine fleet section)
- Pay-and-list page ✅ `boost.html` at route `/boost` — targeting form + engine fleet picker + sticky $7 order summary → Stripe
- Submission pipeline: official submissions + IndexNow ping + crawlability check → listing report
- Delivery: report link-in-inbox, no account required

## Explicitly OUT of v1 (per interview, adjusted after rebrand)
- ❌ Discovery-signals automation (riskiest promise — v1 = submissions + pings + crawlability check only)
- ❌ Public live fleet dashboard (ship the service first, "theater" when the fleet is real)
- ⚠️ Country/language targeting: **collected at /boost and already drives engine priority** (RU→Yandex, CN→Baidu, KR→Naver, CZ→Seznam, JP/TW→Yahoo!) — full downstream pipeline branching stays v2
- ⚠️ Phone-vs-web: **collected at /boost**, phone adds local-listings checks to the report — full audit-profile split stays v2
- ❌ Solana payments (roadmap)

## Routing note
`boost.html` is the pay-and-list page. On the live host, rewrite `/boost` → `boost.html` (one line: Netlify `_redirects`, Vercel `ver.json`, or `.htaccess` `RewriteRule ^boost$ boost.html`). Until then all internal links point at `boost.html` directly.

## Report first screen (decided)
Grade A–F + score → category bars (speed, mobile, SEO basics, local presence) → **top 10 actions ranked by impact**, each with HIGH/MED badge and effort estimate. Skimmable in 60 seconds.

## Kill-risk watchlist
1. **Nobody pays** → mitigated by fake-door test BEFORE building the fleet.
2. Scope drowns it → 30 checks at launch, not 300.
3. Weak upsell → fix packs only sold after a genuinely impressive report.
4. Fulfillment trap → software handles all automatable fixes; humans only for content/listing tasks.
