# Pricing research — what to charge for Shelf, and where the paywall goes

**14 Sep 2026.** Assembled for the open decision in
`docs/research/account-linking.md` §11.1: *do imported games count against
`FREE_TIER_GAME_LIMIT` (50), and does the paywall land before or after the import
result?* That decision is Josh's; this is the evidence for it.

Everything below is from vendor or store pages read directly on 14 Sep 2026.
Where a number came from a search snippet and I could not open the primary page,
it is labelled **unverified**.

---

## 1. The one number that should scare us

RevenueCat's *State of Subscription Apps 2026* (115,000 apps, $16B+ revenue,
2025 cohort) breaks out **Gaming** as its own category. Gaming is the worst
monetizing category they measure:

| Metric | Gaming | Cross-category |
|---|---|---|
| Median monthly price | **$4.99** | $8 (most common $10) |
| Median annual price | **$24.99** | $34.80 (most common $30) |
| Install→paid, D35 | **1.0%** (top quartile >2.3%) | 2.0% |
| Download→trial | 4.4% | Business 9.1% |
| Realized LTV / payer, month 1 | **$8.41** | Health & Fitness $24.23 |
| Realized LTV / payer, year 1 | **$11.22** | Productivity $24.95 |
| Share sold as yearly | 13% | — |
| Share sold as weekly | 82% | — |

<https://www.revenuecat.com/state-of-subscription-apps-2026-gaming>

**The caveat that matters.** That "Gaming" bucket is dominated by weekly-billed
companion and utility apps attached to games — 82% weekly, 73.3% of trials four
days or shorter, the highest short-trial share of any category. Shelf is not that
app. Behaviourally Shelf is a **Productivity** app sold to gamers: a library you
maintain, revisited weekly, with a usage cap as the natural upgrade trigger.
Productivity's numbers are roughly 2x better — median monthly **$9.99**, year-1
RLTV **$24.95**, and **91% of revenue from monthly plans**, 77% of subs sold
monthly.

<https://www.revenuecat.com/state-of-subscription-apps-2026-productivity/>

So the question isn't "what do gaming apps charge," it's **which of those two
patterns we want to be graded against**. Price at Gaming's $4.99/$24.99 and we get
Gaming's $11 year-1 LTV. Price at Productivity's $9.99 and we have to earn it.

---

## 2. What the competition actually charges

| App | Price | Verified? |
|---|---|---|
| **GG\|** (`io.ggapp.gg`) — the closest competitor | Elite Monthly **$4.99**, Elite Yearly **$48.99** | Verified from the US App Store listing, 14 Sep 2026 |
| **Backloggd** | ~$3/mo Patreon "Backer" — ad-free, badge, stats page; every functional feature free | **Unverified** (Patreon blocked; snippet only) |
| **Grouvee** | No paid tier found | **Unverified** |

<https://apps.apple.com/us/app/gg/id1320588074> · <https://ggapp.io/>

Two things fall out of the GG line.

**GG's annual is not a discount.** $48.99/yr against $4.99/mo is 18% off — barely
more than one free month. The category median annual is $24.99 and the
cross-category median is $34.80. GG is either mispriced or deliberately pushing
everyone to monthly. Either way **$4.99/mo is the anchor a Shelf user already has
in their head**, and there is room under GG's annual, not over it.

**The free trackers are the real competitor, not GG.** Backloggd and Grouvee give
away the whole tracker. Anything we gate has to be something they structurally
cannot do — which, for us, is **account linking and imports**. Nobody imports a
400-game Steam library for free.

---

## 3. Hard paywall vs freemium — the finding that cuts against our current design

Across all 115,000 apps:

- **Hard paywall D35 conversion 10.7% vs freemium 2.1%** — ~5x.
- **Revenue per install at D60: $3.09 hard vs $0.38 freemium** — ~8x.
- **One-year retention 27% hard vs 28% freemium** — the report calls the
  difference "statistically negligible." The usual freemium defence (a bigger,
  stickier top of funnel) does not show up in the retention data.
- **But freemium wins late:** by week six, freemium converts **22.9%** of its
  eventual payers against a hard paywall's 15.3%. That advantage is real for
  products with a long discovery cycle where value accrues over weeks.

<https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026>

Shelf is squarely a long-discovery-cycle product — a backlog is worth more in
month two than on day one — so freemium is defensible here. But we should stop
treating it as obviously correct. It is a 5x conversion concession bought for a
late-conversion advantage.

---

## 4. Where the paywall goes — the evidence for §11.1

The old advice (delay the paywall until the user finds value) has been reversed by
the case-study data:

- **Greg** (plant care) moved the paywall from "after you add 5 plants" into
  onboarding and switched to feature-based gating: trial starts up ~400%,
  conversion 3% → 15%.
- **Rootd** (mental wellness) moved its paywall earlier in onboarding despite the
  obvious concern about anxious users: ~5x revenue.
- Onboarding paywalls account for **~50% of trial starts** at many apps.
- The pattern that works is **one compelling value moment, then the paywall** —
  not a paywall before the user understands the product. PhotoRoom has you remove
  a background during onboarding, then paywalls you.
- Placement is not either/or: test before onboarding, after onboarding, before a
  locked feature, and after a core action.

<https://www.revenuecat.com/blog/growth/paywall-placement> ·
<https://www.revenuecat.com/blog/growth/guide-to-mobile-paywalls-subscription-apps>

**This is direct support for the recommendation already in account-linking §8:
paywall *after* the import result, not before.** The import *is* the "one
compelling value moment" the PhotoRoom pattern asks for. "We found 412 games on
your Steam account — keep all of them" is the strongest paywall copy this product
will ever have, and it costs nothing to show the count first. The Greg case is the
exact same move: gate at the moment of demonstrated intent, inside onboarding,
rather than on an arbitrary schedule.

---

## 5. Where the free limit goes

RevenueCat's freemium-tier playbook, which is the most directly useful article
here:

- Pick an **architecture** first. *Taster* = the whole product with a usage cap
  (Loom's 5-minute recordings, Zoom's 40 minutes). *Split* = different features
  for different users. *Hybrid* = both. **Our 50-game limit is a taster cap**, and
  account linking is a split gate — we are already hybrid, we just haven't said so.
- Set the cap at the point **where casual use becomes serious use**, not at a round
  number. Fitbod gives three free workouts — enough to build the habit, not enough
  to live on.
- Write a **"bill of rights"**: features that are permanently free, so the free
  tier can't erode. Life360 protects the core map and location history forever.
  Ours should probably be: manual tracking, search, and the shelf itself.
- Usage-based triggers convert far better than scheduled prompts — a user who just
  hit the cap is a live buyer; a user seeing a generic upgrade prompt on session
  three is not.
- Industry median freemium→paid for consumer apps: **2–5%**.

<https://www.revenuecat.com/blog/growth/freemium-tier-design> ·
<https://www.revenuecat.com/docs/playbooks/guides/freemium> ·
<https://www.revenuecat.com/docs/playbooks/guides/hard-paywall>

**Applied to the 50-game limit.** A 400-game Steam import blows through a 50-game
cap by 8x. That is not a cap being hit, it is a cap being humiliated — the taster
model only works when the free tier is usable, and a library showing 50 of your 412
games is a broken library, not a teaser. Two coherent ways out:

1. **Imported rows count, and the cap is the pitch.** Show all 412, then the
   paywall, then keep 50 if they decline. Highest conversion pressure; the risk is
   it reads as a bait-and-switch and earns 1-star reviews.
2. **Imports are the paid feature; the cap only governs manual adds.** Linking an
   account *is* Pro. Cleaner story, no confiscation moment, and it's the thing the
   free competitors can't copy. The cost is that the import can't be the hook —
   we'd be paywalling before the value moment, which §4 says is the weaker play.

There's a third that gets both: **run the import free, show the full result, and
put the cap on what persists.** The value moment happens, the pitch is honest
("keep all 412"), and declining leaves a working 50-game free app rather than a
truncated one. Worth putting in front of Josh alongside his own two options.

---

## 6. Other numbers worth holding

- **35% of annual subscribers cancel auto-renewal in month one.** Year-1
  cancellation has worsened to ~72% in 2026 from ~56% in 2025. Annual revenue is
  not annual retention.
- **Longer trials convert better**: 17–32 day trials convert at 42.5% vs 25.5% for
  trials of 4 days or less — ~70% better. Yet 46% of apps now use ≤4-day trials,
  up from 42.1%. The industry is moving away from the thing that works.
- **Price localization is worth real money**: North America $39.99 annual median
  vs India/SEA $18.32. Higher-priced apps see $34.82 monthly RLTV per payer against
  $10.69 for low-priced ones.
- **Median YoY MRR growth is 5.3%**; the top 10% grew 306%. Only **4.6% of newly
  launched apps reach $10k MRR within two years**. Pre-2020 apps still hold 69% of
  all subscription revenue.

<https://www.revenuecat.com/state-of-subscription-apps>

---

## 7. Reading list, ranked by usefulness to us

1. **[Designing a freemium tier that converts](https://www.revenuecat.com/blog/growth/freemium-tier-design)** — read first. Taster vs split, where to set a cap, the bill of rights.
2. **[Optimizing paywall placement](https://www.revenuecat.com/blog/growth/paywall-placement)** — the Greg and Rootd case studies; the direct evidence for paywall-after-import.
3. **[State of Subscription Apps 2026: Gaming](https://www.revenuecat.com/state-of-subscription-apps-2026-gaming)** — our category's benchmarks, with the caveat in §1.
4. **[State of Subscription Apps 2026: Productivity](https://www.revenuecat.com/state-of-subscription-apps-2026-productivity/)** — the category we behave like; the better target.
5. **[The 2026 report in 10 minutes](https://www.revenuecat.com/blog/growth/subscription-app-trends-benchmarks-2026)** — hard vs freemium, trial length, churn.
6. **[The full 2026 report](https://www.revenuecat.com/state-of-subscription-apps)** — price medians by duration, localization, LTV by price band.
7. **[Essential guide to mobile paywalls](https://www.revenuecat.com/blog/growth/guide-to-mobile-paywalls-subscription-apps)** and **[8 paywall test ideas](https://www.revenuecat.com/blog/growth/paywall-tests-grow-app-revenue)** — for Sola when the paywall screen gets built.
8. **[Freemium playbook](https://www.revenuecat.com/docs/playbooks/guides/freemium)** / **[Hard paywall playbook](https://www.revenuecat.com/docs/playbooks/guides/hard-paywall)** — RevenueCat's own implementation docs, i.e. what the Shipaton judges have read.

---

## 8. What I'd put to Josh

Three questions, in the order they block work:

1. ~~**Price.**~~ **DECIDED 14 Sep: $4.99/mo and $29.99/yr.** $4.99 sits exactly on
   GG's anchor and on the Gaming median; the $29.99 annual is a real 50% discount
   against GG's nominal 18%, undercutting them at their weakest point and landing
   between the Gaming median annual ($24.99) and the cross-category median ($34.80).
   These are the two products to configure in RevenueCat.
2. ~~**The §11.1 decision.**~~ **DECIDED 14 Sep** — paywall **after** the import
   result, imported rows **count** against the 50-game limit. §4's case-study
   evidence backs this: it is the higher-converting placement, not just the more
   honest one.
3. ~~**Trial length.**~~ **DECIDED 14 Sep: a long trial, 17–32 days**, against the
   ≤4 days that 73% of gaming apps use. The data behind it: 17–32 day trials convert
   at 42.5% vs 25.5% for ≤4 days, ~70% better.

   **Pick the low end of that band — 17 to 21 days — and here is why.** Launch is
   30 Sep and Shipaton judging closes 22 Oct, a 22-day window. A 30-day trial
   started at launch resolves on 30 Oct, after judging is over, so every judge would
   see an app with trials running and zero conversions. At 21 days the first cohort
   converts on 21 Oct, inside the window by a day; at 17 days, on 17 Oct with room
   to spare. Same benchmark band, but the conversion data actually exists while it
   still counts. **21 days is the ceiling, 17 is the safe pick.**

None of this is backend work. It changes `FREE_TIER_GAME_LIMIT`, the RevenueCat
product config, and where Sola puts the paywall screen.

---

## 9. Decisions, as settled on 14 Sep

| Decision | Settled |
|---|---|
| Monthly price | **$4.99** |
| Annual price | **$29.99** (50% off; GG's annual is $48.99) |
| Free tier | **50 games**, `FREE_TIER_GAME_LIMIT` unchanged |
| Imported rows count against the limit | **Yes** |
| Paywall placement | **After** the import result, never before |
| Trial length | **Long — 17–32 day band; take 17–21 so it resolves before judging closes 22 Oct** |

Still unsettled, and not blocking: whether to localize pricing by region (North
America medians $39.99 annual against IN/SEA's $18.32, so the gap is real money),
and whether to run a reverse trial. Neither needs answering before launch.
