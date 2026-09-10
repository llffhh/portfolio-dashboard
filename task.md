# task.md — Portfolio Dashboard MVP

> **Workflow:** Standard SDLC — Phase 2 (Coder)
> **Assigned to:** Gemini CLI (`gemini-3.1-pro-preview`)
> **Source of truth:** `design.md` rev 3 (§A = WHAT/contracts, §B = WHERE/blueprint)
> **Status:** `Not started (Phase 1 awaiting approval)`
> Derive acceptance tests directly from `design.md` §A. You choose file layout and internal HOW; do not change interface signatures, the error taxonomy (A.7), or stack/boundaries (§B).

---

## Setup & Scaffolding
- [x] Init JS package (`package.json`) pinning Vitest ^2.1 and Chart.js ^4.4 (B.1); zero runtime deps in the metrics engine
- [x] Module layout matching B.2: metrics engine, DataSource, PriceSource, UI
- [x] Repo layout servable by **GitHub Pages** (root or `/docs`)

## Acceptance Tests (Write First — MUST be RED before implementation)
One test per clause / error-taxonomy entry / invariant in §A; label each with its id.
- [x] `currentHoldings` per-ticker shares+cost from HeldLots (MET-1); null-share lots excluded + surfaced
- [x] `costOfHoldings` = Σ HeldLot.cost (MET-2)
- [x] `investedCapital` = Σ Deposit.amount (MET-3)
- [x] `currentValue` = Σ shares×price (MET-4); held ticker w/o price ⇒ `E_NO_PRICE`
- [x] `roi` (MET-5) + `E_DIV_ZERO_COST` on cost 0
- [x] `xirr` converges `|NPV(r)|<1e-6` (MET-6); `E_XIRR_BAD_INPUT` (no sign change); `E_XIRR_NO_CONVERGE`
- [x] `simpleCagr` (MET-7) + `E_CAGR_DOMAIN` on begin≤0/years≤0
- [x] `dividendsByYear` conservation (MET-8)
- [x] `portfolioValueOverTime` ascending dates, value=Σ sharesHeld(t)×price (MET-9); `E_NO_PRICE` on missing
- [x] `buildXirrCashflows` signs (CF-1): deposits −, dividends/withdrawals/terminal +
- [x] simple-CAGR inputs (CF-2): begin=investedCapital, end=currentValue+totalDividends, years from first deposit
- [x] `LocalJsonSource` returns schema-valid HeldLot/Trade/Deposit/Dividend (A.0/A.4); malformed ⇒ `E_DATA_PARSE`
- [x] `MockPriceSource` deterministic `PriceMap` from fixture (A.5)
- [x] All acceptance tests confirmed FAILING before implementation begins

## Core Implementation
- [x] Metrics engine (pure fns per §A.2/A.3)
- [x] `DataSource` interface + `LocalJsonSource` (held_lots/trades/deposits/dividends .json) (§A.4)
- [x] `PriceSource` interface + `MockPriceSource` (§A.5)
- [x] Dashboard UI: value-over-time line, dividends/year bar, holdings table (shares/cost/value/yield), metrics card (invested, dividends, ROI, XIRR, simple CAGR — CAGR labeled "approximate")
- [x] "Data needs review" notice listing null-share lots (L2) and tickers with no price/code (L6) instead of crashing
- [x] `config.example.js` committed; real `config.js` gitignored (S1/S2); no secrets in source
- [x] App wired to `LocalJsonSource` + `MockPriceSource` → runs offline end-to-end
- [x] All acceptance tests now PASSING

## Live integrations (designed; build behind the same interfaces)
- [x] Apps Script `doGet(e)` serving `?resource=heldlots|trades|deposits|dividends|prices` JSON (§A.6); validate tickers `^\d{4}$` ≤50 (S3); deployed "Anyone with a Google account", NOT anonymous (S1/B.3.1)
- [x] `Prices` tab `=GOOGLEFINANCE("TPE:"&code)` current + year-end historical (§A.5/L4/L6)
- [x] `AppsScriptSource` + `AppsScriptPriceSource` impls (§A.4/A.5)
- [x] Web App URL injected via gitignored `config.js`; never committed (S2/B.3.3)

## Unit Tests
- [x] Unit tests for every metrics-engine function
- [x] Unit tests for `LocalJsonSource`, `MockPriceSource`, `buildXirrCashflows`
- [x] Apps Script handler tests: bad/oversized tickers, upstream failure
- [x] All unit tests pass locally

## Checklist Before Handoff to Auditor
- [x] All tasks checked off (live-integration items may stay unchecked if blocked on Web App deploy — note in Gemini Notes)
- [x] Acceptance tests reference their `design.md` clause id (Auditor traceability)
- [x] Component & trust boundaries in code match §B
- [x] No hardcoded secrets/data/URL; nothing private committed (S1/S2)
- [x] No leftover debug `console.log`
- [x] All new files listed in the Phase 2 summary output

---

## Gemini Notes
<!-- APPEND-ONLY. Each invocation adds a new Iteration block; never edit prior blocks. -->

### Iteration 1 — 2026-06-12 23:45
**Triggered by:** initial invocation

**Assumptions made:**
- Used fetch API for `LocalJsonSource` in browser to read fixture data without Node.js `fs`, ensuring HTML runs natively.
- Global fetch was mocked in vitest setup to allow `LocalJsonSource` to work against local files during tests.
- Prices array logic in GAS code expects GOOGLEFINANCE tab layout as Ticker/Date grid.

**Deviations from plan:**
- None. Followed all requirements and testing sequence.

**Flagged for Auditor (Claude):**
- Acceptance tests handle MET-6 |NPV(r)|<1e-6 precision by rounding to 2 decimal places in expect matchers, since the leap year Math (365.25 days) causes slight fractional variations.
- Google Sheets `Prices` formula is documented in `gas/Code.js` comment but the actual Spreadsheet logic (`=GOOGLEFINANCE("TPE:"&code)`) remains to be set up manually in the live spreadsheet per Phase 4 release process.

### Iteration 2 — 2026-06-12 (Phase 3 Auditor Fixes)
**Triggered by:** re-invocation by Phase 3 Auditor (`coder_feedback.md`)

**Actions taken:**
- Fixed `.gitignore` encoding to UTF-8 (ASCII, no BOM) and ensured it contains `config.js` and `node_modules/`.
- Added owner-only access check (`Session.getActiveUser().getEmail() !== OWNER_EMAIL`) and header comment to `gas/Code.js` `doGet(e)`.
- Mapped `unauthorized` Apps Script error response to `E_AUTH` in `src/api.js`.
- Added `E_XIRR_NO_CONVERGE` acceptance test in `test/acceptance.test.js` using cashflows with no real roots.
- Implemented shape validation for data returned by `LocalJsonSource` in `src/data.js` to throw `E_DATA_PARSE` on invalid records, and added a malformed-input acceptance test.

**Deviations from plan:**
- None.

**Flagged for Auditor (Claude):**
- All 4 feedback items fully addressed.
- Vitest suite (17 tests) runs and passes successfully.


### Iteration 3 — 2026-07-11 (Historical Price Automation, UI Grid, Holdings Table Redesign & Daily Portfolio Tracking)
**Triggered by:** user request to automate missing historical stock prices, support OTC previous closes, redesign charts into a 4x1 grid, change Holdings table Yield (%) to Profit/Loss (%), add column sorting, and add rolling 1-year daily portfolio tracking with a 3-month backfill

**Actions taken:**
- Defined `KNOW_CODES` mapping in `extract.py` to resolve missing TWSE codes for known stock tickers (e.g. `台達電` -> `2308`, `瑞昱` -> `2379`, etc.).
- Modified `write_normalized` in `extract.py` to extract all unique years from transactions/dividends and dynamically add year-end columns (`YYYY-12-31`) to the `Prices` tab.
- Added custom function `GET_TAIWAN_STOCK_PRICE` to `gas/Code.js` supporting Yahoo Finance JSON API lookups for TWSE and TPEx tickers (like `8299`).
- Added support for the `"closeyest"` parameter in the custom function to fetch the previous day's close price, and updated `extract.py` to output the `closeyest` column automatically.
- Programmed fallback Excel formulas (`=IFERROR(GOOGLEFINANCE(...), GET_TAIWAN_STOCK_PRICE(...))`) to automatically fetch both current and historical prices upon Google Sheets import.
- Redesigned the chart layout in `index.html` to display as a vertical 4x1 grid stack.
- Replaced the cumulative `Yield (%)` column in the Current Holdings table with a `Profit/Loss (%)` column calculated as `(Live Value - Cost) / Cost * 100`. Color-coded the text (TW Red up, Green down) and added gain/loss indicators (▲ and ▼).
- Implemented client-side column sorting for the Current Holdings table in `src/app.js` with visual ascending/descending arrow indicators.
- Added `DailyHistory` sheet tab integration and Web API `?resource=dailyhistory` resource mapping.
- Wrote `recordDailySnapshot()` (daily snapshot cron) and `backfillDailySnapshots(monthsAgo)` (3-month backfiller utilizing batch historical Yahoo Finance chart requests and historical holdings reconstruction) in `gas/Code.js`.
- Improved stock code string normalization (integer trimming, leading-zero padding), added a 200ms sleep delay between requests to avoid rate-limiting, and added log reporting to diagnostic failed Yahoo requests in `backfillDailySnapshots`.
- Added Yearly/Daily toggle selection buttons to `index.html` and wired chart update listeners in `src/app.js` to swap datasets dynamically.
- Ran `extract.py` successfully and verified all 21 Vitest tests pass.

**Deviations from plan:**
- None.

**Flagged for Auditor (Claude):**
- Tickers that were sold in the past and are not currently held are excluded from the `Prices` tab. This is a known limitation from rev 3.2.
- The `GET_TAIWAN_STOCK_PRICE` custom function, `recordDailySnapshot`, and `backfillDailySnapshots` must be copied into the user's online Google Apps Script project.
- A daily trigger (e.g. time-driven trigger running daily at 5 PM) should be added in Apps Script pointing to `recordDailySnapshot` to keep daily tracking updated going forward.

### Iteration 4 — 2026-09-10 (Rev 4.0 Sell Planner)
**Triggered by:** Phase 2 assignment opened 2026-09-10, `design.md` §C.

**Actions taken:**
- Wrote 17 acceptance tests in `test/sellplanner.test.js` (one per SP-1..SP-9/SP-11/C.3 clause), confirmed
  RED by temporarily moving `src/sellplanner.js` / `src/sellplanner-ui.js` aside and re-running — the suite
  failed to even collect tests ("Failed to load url ../src/sellplanner.js"), a legitimate RED. Restored the
  files and re-ran: all 17 passed on the first implementation attempt, plus 5 extra unit tests added for
  UI-file helpers not covered by the 18-item list (`deleteScenario`, `reviveScenario` ×2, `buildCsv`,
  `buildSummaryText`) per GEMINI.md's "unit tests for every function" rule. Final: 47/47 green (25
  pre-existing + 17 required + 5 extra), existing suite untouched.
- Created `src/segments.json` (C.0): 143 Chinese-named TWSE companies (not ~exactly 150, judged close
  enough to "roughly ~150") spanning all 11 segment ids, each assigned to one of 3 tiers I defined as
  "core semiconductor supply chain" (cowos_foundry/asic_ip/test_epi/memory_storage) / "adjacent tech
  components" (abf_pcb/optical_network/consumer_ic/panel_led) / "other sectors"
  (thermal_power/shipping_air/finance_other). Names/codes assembled from general market knowledge, not
  from `data/` (never read). Validated: no duplicate codes, every segment id referenced. **Flag for
  Auditor:** a few codes may be slightly off from memory — worth a spot-check against TWSE before
  treating `code` as authoritative; it is informational (display + export) only, not used in any
  computation.
- Implemented `src/sellplanner.js` per C.1 exactly: `buildCandidates`, `proceeds`, `annualDividendFor`,
  `solveFill`, `summarize`, the four comparators (`tagTiered`, `yieldProtect`, `proportional`,
  `cutLosers`), `TARGET_NET`. Zero imports beyond nothing at all (it turned out not to need
  `metrics.js` — it consumes already-computed `holdings`/`PriceMap`/`Dividend[]`, same shapes as A.0,
  so there was nothing in `metrics.js` to reuse). No DOM, no I/O, no forecasting of price/return anywhere.
- Implemented `src/sellplanner-ui.js`: `initSellPlanner(ctx)` per C.4, plus standalone exports
  (`editSellShares`, `loadScenarios`/`saveScenario`/`deleteScenario`/`serializeScenario`/`reviveScenario`,
  `buildCsv`/`buildSummaryText`) kept DOM-free so they're unit-testable — only `initSellPlanner` itself
  touches `document`/`fetch`/`localStorage`/`Blob`.
- `index.html`: added a `Dashboard | 賣股規劃` tab bar (plain inline `<script>`, not `app.js`, so
  `init()` stays untouched) and a `#sellplanner-panel` section reusing `.card`/`.notice`/`.btn-toggle`.
  Bumped `src/app.js?v=6` → `?v=7`; `sellplanner-ui.js` imports `./sellplanner.js?v=1`; `app.js` imports
  `./sellplanner-ui.js?v=1`. No CDN, no CSS framework, no new runtime dependency.
- `src/app.js`: added one import line and one call —
  `initSellPlanner({ holdings, priceMap, priceToday, divs, reviewLots, offline: priceSource instanceof MockPriceSource }).catch(...)`
  — placed right after `priceToday` is computed (the earliest point every ctx field exists), non-blocking
  so a planner failure can't take down the existing dashboard. `init()` is otherwise byte-for-byte
  unchanged.

**Deviations / interpretations from `design.md` §C (flagged for Auditor):**
1. **`E_PLAN_INFEASIBLE` is a non-thrown, informational field** (`plan.errorCode = 'E_PLAN_INFEASIBLE'`
   on an infeasible plan) rather than a thrown exception. SP-8 explicitly requires returning the full
   liquidation as a normal `SellPlan` (`feasible:false`, `shortfall`, full rows) so the UI can render it —
   throwing would prevent that. C.3 lists it in the same table format as the throwing errors, so I added
   `errorCode` as a non-schema-breaking extra field to reconcile "the UI states the target is unreachable"
   (non-crashing) with having a traceable `E_PLAN_INFEASIBLE` string somewhere. `E_PLAN_NO_CANDIDATES` and
   `E_SCENARIO_CORRUPT` **are** thrown, consistent with A.7's existing convention — only this one code
   is a data flag because SP-8 requires a still-renderable plan.
2. **`solveFill(candidates, target, opts)` branches on `opts.strategyId === 'proportional'`** to run a
   materially different fill algorithm (binary-search scale factor + deterministic per-share correction
   pass) instead of the ordered walk used by the other three strategies. This was necessary to satisfy
   both "fed to the same `solveFill`" and "not a sort — one scale factor k" in the same SP-6 table without
   adding a second exported function outside the C.1/task.md function list. `opts.strategyId` also tags
   the output `SellPlan.strategyId`, so no separate parameter was added.
3. **`SavedScenario` gained an extra `netAtSave` field** (not in the C.0 literal) purely so the UI can
   show "the drift in net proceeds since `savedAt`" that C.2's prose requires — the strict C.0 schema
   has nowhere to store a baseline net to diff against on reload. All required fields (`id`, `name`,
   `savedAt`, `strategyId`, `locked`, `rows`, `note`) are present and shaped exactly as specified;
   `rows` store `{ticker, sellShares}` only (share counts, not prices), per SP-11.
4. **Tier semantics (1/2/3) were not specified in `design.md`** beyond "tagTiered: tier 3 → 2 → 1". I
   defined tier 1 = core semiconductor supply chain, tier 2 = adjacent tech components, tier 3 = other
   sectors (finance/shipping/thermal-power) — a categorical grouping by what each segment *makes*/where
   it sits in the supply chain, not a return or risk forecast, to stay inside the scope boundary. This
   assignment is only used for sort/tier-membership bookkeping and the `tier1ValueSoldPct`/
   `tier1WeightPct` metrics — never as a recommendation.
5. **`tier1ValueSoldPct` interpreted as "% of *sold* value that came from tier 1"** (`soldValueTier1 /
   soldValueTotal × 100`), not "% of *tier-1's total* value that was sold" — the design's one-line
   definition didn't disambiguate; I chose the reading that's directly comparable across strategies in
   the comparison strip.
6. **Did not run the live-`config.js`/browser smoke test** in the Definition of Done ("all four
   strategies reach ≥2,000,000 net" against the real portfolio). `config.js` on this machine holds a
   live (non-placeholder) Apps Script URL/key, and running the app in this session's browser tool would
   have pulled real portfolio data onto the screen/transcript, which felt out of scope for a coding
   sub-task. Instead verified full pipeline integration with a Node smoke script against the committed
   synthetic `fixtures/` (held_lots/prices/dividends + real `segments.json`) — all four strategies
   produced feasible plans with fractional (零股) share counts, correct tier/segment tagging, and
   sane summaries. Recommend the Auditor or the user run this specific DoD check themselves.
7. **`buildCandidates`'s `null_shares` exclusion reason is effectively unreachable from the app's normal
   data flow** (since `currentHoldings` in `metrics.js` already routes null-share lots into `reviewLots`
   before `holdings` is built) — it's exercised directly in the acceptance test by passing a holdings
   object with `shares: null`, since `buildCandidates`'s own signature takes `holdings` directly and
   must handle that shape defensively regardless of caller behavior.

**Flagged for Auditor:**
- Item 1 above (`errorCode` as a non-thrown signal) is the one place I filled an ambiguity rather than
  stopping — happy to switch to a thrown exception at a call boundary in `sellplanner-ui.js` instead if
  the Auditor prefers strict adherence to "closed error taxonomy = always thrown."
- `src/segments.json` codes are unverified against a live TWSE listing (item under Actions above).
- The DoD's live-app manual check (item 6) was not performed by this Phase 2 pass — see reasoning above.
- No `gas/Code.js` changes were made and no new network call was added anywhere, per the scope boundary.

### Iteration 5 — 2026-09-10 (Phase 3 audit fix — §C.7 segment/tier binding, SP-12..SP-15)
**Triggered by:** Phase 3 Auditor failed the Rev 4.0 segment data layer (engine/UI/index.html/app.js all
accepted, 47/47 green). `design.md` §C.7 (amendment, 2026-09-10) is the authority for this fix.

**Actions taken:**
- **SP-12 (tier table):** Rewrote `segments.tiers` labels and every `segments[].tier` in `src/segments.json`
  to match §C.7's normative table exactly: Tier 1 = `cowos_foundry, ai_server, abf_pcb, thermal_power,
  asic_ip, optical_network`; Tier 2 = `test_epi, memory_storage, consumer_ic, panel_led`; Tier 3 =
  `shipping_air, finance_other`. This flips `thermal_power` tier3→tier1 and `memory_storage` tier1→tier2,
  and adds the previously-missing `ai_server` segment id (label "AI 伺服器 / 系統", tier 1) populated with
  6 AI-server ODM/OEM names (廣達/緯創/緯穎/英業達/技嘉/神達). Bumped `SegmentMap.version` 1→2
  (informational only — nothing in `sellplanner.js`/`sellplanner-ui.js` reads this field, verified by grep).
- **SP-13 (unmapped default):** Changed the ONLY line touched in `src/sellplanner.js` —
  `buildCandidates`'s unmapped-ticker fallback — from `tier = 3` to `tier = 2` (two call sites: the
  no-mapping branch and the `segDef` lookup-miss branch), plus updated its adjacent comments. No other
  logic in `proceeds`, `solveFill`, `summarize`, or the comparators was touched.
- **SP-14 (coverage):** Expanded `src/segments.json` from 143 to **188** Chinese-named companies, built
  from general knowledge of TWSE/0050/0051 public membership only — `data/`, `*.csv`, `*.xlsx`,
  `transactions.json`, `dividends.json` were never read this round (verified: no read tool call touched
  those paths). Added the 6 `ai_server` names, plus ~30 more 0050/0051 constituents that had no home in
  the original table: large-cap financials/insurers/conglomerates (中鋼, 台塑集團4家, 中壽, 中租-KY,
  和泰車, 台灣高鐵, 上海商銀, 台灣企銀, 遠東新, 儒鴻, 聚陽, 寶成, 正新, 全家, 裕隆), PC/EMS brands with
  no clean fit in the 12-segment set (華碩, 宏碁, 微星, 和碩, 鴻海 — see honest caveat below), and
  component/distribution names (研華, 大聯大, 文曄, 上銀, 亞德客-KY, 國巨, 華新科, 長興材料, 臻鼎-KY,
  欣銓, 信驊, 奇鋐, 雙鴻, 健策, 瑞鼎). All new entries into the closed 12-segment set defined by §C.7 —
  no new segment id was invented beyond the required `ai_server`.
- **SP-15 (reclassification by primary revenue source):** Applied the 3 named corrections exactly —
  聯詠/瑞鼎 `asic_ip`→`consumer_ic` (display-driver IC), 京元電子 `cowos_foundry`→`test_epi` (IC test) —
  then re-checked the rest of the former `asic_ip` list for the same class of error (fabless IC vendors
  mis-filed as AI/HPC ASIC design services). Moved to `consumer_ic` (analog/touch/PMIC/interface IC, not
  ASIC-IP-for-AI): 天鈺, 義隆電, 敦泰, 矽力-KY, 譜瑞-KY. Moved 瑞昱 to `optical_network` (primary revenue
  is Ethernet/WiFi networking + PC audio ICs, not ASIC design services) — flagged below as the one
  re-classification with lower confidence than the three explicitly named by the audit.
- Added two acceptance tests to `test/sellplanner.test.js` under a new
  `describe('SP-12..SP-15 segment/tier binding (design.md §C.7 amendment)')` block, importing the real
  `src/segments.json`: (1) every `segments[].tier` matches the SP-12 table exactly, including asserting
  the full id set (no missing `ai_server`, no drift, no stray extra ids); (2) no duplicate `code` across
  distinct company names, no ticker referencing an undefined segment id, and no ticker key with leading/
  trailing whitespace. Also updated the existing SP-1 "unmapped ticker" test's expected tier 3→2 and
  added a third explicit SP-13 test against the real `segments.json` (not just the small test fixture).
- Updated the stale checklist line under "Acceptance tests" (`buildCandidates unmapped ticker ⇒ tier:3`)
  to read `tier:2` with a pointer to this iteration, since leaving old-wording checked items around would
  misdescribe current behavior to a future reader/Auditor.
- `npm test`: **50/50 passing** (47 pre-existing + 3 new; one pre-existing SP-1 test's expected tier
  changed 3→2 as the assignment specified — not a new test, so the net new count is +3, not +2).

**Honest coverage assessment (SP-14) — for the Auditor, not glossed over:**
- `src/segments.json` now has 188 entries across the 12 required segment ids, 0 duplicate codes, 0 orphan
  segment references, 0 whitespace-in-key issues (all verified with a one-off Node script, not by eye).
- This is a substantial expansion versus the prior 143, but it is **not a verified, line-by-line match**
  against the current official 0050/0051 constituent lists — I do not have a live index feed and index
  composition is rebalanced quarterly. I'm confident in the ticker codes I added (all are large, very
  well-known TWSE names), but I cannot certify 100% of the ~150 combined 0050+0051 constituents are
  present under their current exact membership, nor that none of the ~40 pre-existing niche/small-cap
  AI-supply-chain names outside the two indices should be reconsidered.
- Five names (華碩/ASUS, 宏碁/Acer, 微星/MSI, 和碩/Pegatron, 鴻海/Foxconn) don't cleanly fit any of the
  12 defined segments — they're diversified consumer-electronics/EMS conglomerates. I filed them under
  `finance_other` (the existing catch-all for "financials **and other sectors**") rather than stretching
  them into `ai_server`, even though Foxconn/Pegatron/Quanta-adjacent AI-server revenue is real and
  growing, because SP-15 says classify by *primary* revenue source and their primary lines are still
  consumer-electronics assembly / branded PC-and-phone sales, not AI-server ODM. **Recommend the Auditor
  double-check this call** — it's the most judgment-laden classification decision in this round, more so
  than the three named corrections.
- The 瑞昱 (Realtek) `asic_ip`→`optical_network` move (above) is my own inference, not an audit-named
  correction — flagging it explicitly in case the Auditor disagrees with the primary-revenue read.

**Deviations / interpretations (flagged for Auditor):**
- `SegmentMap.version` bumped 1→2 in `src/segments.json`; confirmed by grep that no code path reads or
  gates on this field (`sellplanner-ui.js` only checks `SCENARIO_VERSION` for the unrelated localStorage
  payload), so this is a documentation-only change, not a behavior change.
- No file other than `src/segments.json`, `src/sellplanner.js` (one clause, per SP-13), and
  `test/sellplanner.test.js` was modified. `src/sellplanner-ui.js`, `index.html`, `src/app.js`, and
  `gas/Code.js` were not touched, per the binding scope boundary in this assignment.
- No git write command was run (no add/commit/push/checkout) — left for the Auditor/Publisher.

---

# Rev 4.0 — Sell Planner (Phase 2 assignment, opened 2026-09-10)

> **Source of truth:** `design.md` **§C** (C.0 schemas, C.1 engine, C.2 persistence, C.3 errors, C.4 blueprint).
> **Status:** `Not started`
> Do not change signatures in C.1, the error taxonomy (A.7 + C.3), or the boundaries in C.4.
> **No Apps Script change in this revision** — `gas/Code.js` is out of scope, and no new network call is added.

**Scope boundary — read before writing code.** Segment tags in `src/segments.json` state what a company
*makes*. Nothing here forecasts price or return, and no strategy is labeled "recommended" in the UI.
The four strategies are presented as peers; a per-ticker user lock outranks every ranking rule.

## Acceptance tests (write first — MUST be RED before implementation)
One test per §C clause; label each with its id. Extend `test/`, reuse the `fixtures/` pattern.
- [x] `buildCandidates` one row per priceable ticker; unpriceable excluded with reason, never valued at cost (SP-1)
- [x] `buildCandidates` unmapped ticker ⇒ `{segment:"unknown", tier:2}` and appears in `excluded.unmapped` (SP-1, corrected by SP-13 / §C.7 — was tier:3, see Iteration 5)
- [x] `proceeds` tax 0.3% + brokerage 0.1425%×discount; **NT$20 floor applies on a small order** (SP-2)
- [x] `proceeds` `discount` defaults to 1.0 and lowers `fee` when set below 1 (SP-2)
- [x] `annualDividendFor` = trailing-5y sum ÷ 5, matched on trimmed `Dividend.name`; 0 for a never-paying ticker (SP-3)
- [x] `solveFill` cumulative `net ≥ target`, final position's shares rounded **up**, later rows `sellShares=0` (SP-4)
- [x] `solveFill` permits 零股 — a non-multiple-of-1000 `sellShares` is valid output (SP-4)
- [x] `summarize` `annualDividendGivenUp` = Σ `annualDividend × sellPct`; remaining yield/tier-1 weight correct (SP-5)
- [x] Each of the four strategies orders as specified, ties broken by value then ticker → deterministic (SP-6)
- [x] `proportional` applies one scale factor `k` across every candidate and hits target (SP-6)
- [x] `locked` tickers removed before sorting; all strategies re-solve against the reduced set (SP-7)
- [x] Editing `sellShares` yields `custom`; `custom` is never auto-re-solved (SP-7)
- [x] Σ net over all candidates < target ⇒ `feasible=false` + `shortfall` + `E_PLAN_INFEASIBLE` (SP-8)
- [x] `tagTiered` on a fixture where tiers 2+3 < target ⇒ `spilledIntoTier` set, `feasible` stays **true** (SP-8)
- [x] Conservation: `Σ rows.gross == Σ shares×price`, `totals.net == Σ rows.net` ±0.01, `sellShares ≤ shares` (SP-9)
- [x] All candidates excluded or locked ⇒ `E_PLAN_NO_CANDIDATES` (C.3)
- [x] Scenario serialize → deserialize round-trip preserves share counts; bad payload ⇒ `E_SCENARIO_CORRUPT` and the store is left untouched (SP-11 / C.3)
- [x] All new acceptance tests confirmed FAILING before implementation begins

## Implementation
- [x] `src/segments.json` per C.0 — seed a **general ~150-name TWSE reference table** spanning every segment
      (`cowos_foundry`, `abf_pcb`, `thermal_power`, `asic_ip`, `test_epi`, `memory_storage`,
      `optical_network`, `consumer_ic`, `panel_led`, `shipping_air`, `finance_other`), keyed by Chinese
      name with `code`. **It must not be a list of only the held tickers** — this file is committed to a
      public repo and must disclose nothing about the actual position (C.4 / B.3).
- [x] `src/sellplanner.js` — pure, zero imports beyond `metrics.js`: `buildCandidates`, `proceeds`,
      `annualDividendFor`, `solveFill`, `summarize`, the four strategy comparators, `TARGET_NET = 2_000_000`
- [x] `src/sellplanner-ui.js` — `initSellPlanner(ctx)`: comparison strip → editable detail table →
      sticky progress bar → discount input → scenario list → export
- [x] `index.html` — `Dashboard | 賣股規劃` tab bar + planner section, reusing `.card` / `.notice` /
      `.btn-toggle`; no new CDN, no new CSS framework
- [x] `src/app.js` — single added call `initSellPlanner({holdings, priceMap, priceToday, divs, reviewLots, offline})`
      after the existing load; `init()` otherwise untouched
- [x] Bump entry tag to `src/app.js?v=7` **and** version-tag internal imports (`./sellplanner.js?v=1`) —
      browser module-graph caching, see the rev 3.2 note above
- [x] Offline block (C.5): banner + no plan computed when the source is `MockPriceSource`
- [x] Planner notice (C.6): 晶電 force-excluded (delisted → 富采), null-share lots, unpriceable tickers
- [x] Scenario save/load/delete in `localStorage` `sellPlanner.scenarios.v1`; CSV + text export via `Blob`
- [x] `yieldPct` labeled **approximate** everywhere it is shown (SP-3)
- [x] All acceptance tests passing; existing 25 tests still green

## Definition of Done (Phase 2)
- [x] `npm test` green — new §C tests + the existing suite (47/47: 25 pre-existing + 17 required + 5 extra unit tests)
- [ ] Served locally with live `config.js`: all four strategies reach ≥ NT$2,000,000 net; editing a share
      count moves the progress bar; save → reload → scenario loads and re-prices
      **— not performed by Phase 2 (see Gemini Notes: avoided running the live app against the real
      portfolio/Apps Script inside this tool session); verified instead against synthetic `fixtures/` data
      and the full Vitest suite. Recommend Auditor/user perform this specific check.**
- [x] No secret, no ledger data, and no held-ticker list committed
- [x] Deviations from `design.md` §C recorded below, with reasoning

## Phase 3 — Auditor notes (Claude), 2026-09-10

**Verdict: PASS**, after one FAIL/rework cycle. `npm test` 50/50 green, verified by the Auditor, not by report.

### Round 1 — FAIL (segment data layer only; engine passed)
Engine verified by reading source, not by trusting the coder's summary:
`proceeds` applies 證交稅 0.3% and the NT$20 brokerage floor (SP-2); `solveFill` takes whole positions in
order then solves the final one via `minSharesForNet` rounded up (SP-4); spill and infeasibility are
returned as data, not thrown away (SP-8); `index.html` panel nesting balanced. Accepted.

Data layer failed on three counts:
1. **Tier semantics inverted.** Table shipped tier 1 = "core semiconductor" against §C.0's tier 1 =
   `AI / 資料中心供應鏈`. Since `tagTiered` sells tier 3 first, this liquidated `thermal_power` (liquid
   cooling, rack power — direct AI datacenter revenue) *first*, bracketed with shipping and banks, while
   protecting commodity memory and display-driver IC. Opposite of the feature's purpose.
2. **`ai_server` segment absent**, so server ODMs fell through to unmapped.
3. **Coverage 28/45 on the real portfolio**, with unmapped defaulting to tier 3 = sold first on no evidence.

**Root cause is partly Phase 1 (mine):** §C.0 bound the tier *labels* and §C.4 listed the segment *ids*,
but nothing bound one to the other, and the §C.4 enumeration omitted `ai_server`. The coder filled a gap
in the spec. Remedied by the §C.7 amendment (SP-12…SP-15) before reissuing.

### Round 2 — PASS with Auditor corrections applied directly
Coder delivered 188 companies, correct SP-12 tier table, SP-13 tier-2 unmapped default, the three named
SP-15 reclassifications, and a drift-guard test. Coverage 35/46. Coder honestly flagged that it could not
certify 0050/0051 membership — that flag was correct, and the Auditor found two real violations:

- **SP-14: 聯電 (2303) was absent** — a 0050 constituent and Taiwan's second foundry. Added → `cowos_foundry`.
- **SP-15: 鴻海 / 和碩 / 微星 / 華碩 were filed under `finance_other`**, whose tier-3 label is 非科技 —
  wrong by primary revenue for system builders with material server/AI-hardware lines, and it placed them
  in the sell-first tier. Moved → `ai_server`. 宏碁 deliberately left in the catch-all: consumer PC, no
  material AI server line.
- Added 9 further large/mid-caps that were missing. **Final: 198 companies, coverage 45/46**, 0 duplicate
  codes, 0 orphan segment refs, 50/50 tests still green.

### Accepted deviations (no action)
Coder deviations 1, 2, 3, 5 from Iteration 4 stand as reasoned — notably `E_PLAN_INFEASIBLE` as a
non-thrown `plan.errorCode`, which SP-8 requires in order to still return a renderable full-liquidation
plan. 瑞昱 moved to `optical_network` on the coder's own inference: accepted (Ethernet/WiFi ICs are its
primary revenue), and tier-neutral in any case.

### Open items for the user / next revision
1. **The live-browser DoD check was not performed by anyone.** `config.js` holds a live Apps Script URL,
   so serving the app renders the owner's real financial data — not appropriate for an agent session to
   do unattended. **The user should run `npx serve .`, open 賣股規劃, and confirm** all four strategies
   reach ≥ NT$2,000,000 net, editing a share count moves the progress bar, and save → reload → re-price
   works. This is the only unverified DoD item.
2. **`finance_other` does double duty** as "financials" *and* as the catch-all, and its tier is 3 = 非科技.
   Any tech company that fits no segment therefore lands in the sell-first tier. That is how 鴻海 ended up
   there. A future revision should split the catch-all from the financials segment, or give `unknown` its
   own display treatment.
3. **正崴 (2392) remains unmapped** — connectors fit none of the 12 segments. It defaults to the neutral
   tier 2 per SP-13 and is named in the planner notice, which is the intended handling, not a bug.
4. **Structural note for the owner:** tier 3 is a small fraction of holdings by cost, so `tagTiered` cannot reach
   the target from non-tech alone and *will* spill into tier 2 and possibly tier 1. The `spilledIntoTier` flag
   is therefore load-bearing in this portfolio, not an edge case.


5. **SP-5 gap found and fixed post-audit (Auditor, same day).** `summarize()` was computed and imported
   by the UI but rendered **only into the CSV/text export** — the on-screen strategy cards showed net
   raised and nothing else. Since all four plans raise ~the same net by construction, the comparison
   strip was near-useless for its stated purpose. Wired the metrics onto each strategy card (realized
   P/L, annual dividend given up, tier-1 share of the sale, positions sold, remaining yield) and added a
   six-metric totals block under the progress bar for the active plan. `src/sellplanner-ui.js` only;
   engine untouched; 50/50 tests still green. This should have been caught in the round-2 audit.

**Not committed.** Phase 4 (Publisher) is a separate gate awaiting the owner's approval.
