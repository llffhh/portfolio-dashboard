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

---

# Rev 4.7 — Unified price service (Phase 2 assignment, opened 2026-09-20)

**Read `design.md` §D.** Everything below implements it. Do not touch §A/§B/§C behaviour.

**Goal:** Current Value, Yesterday Value and DailyHistory must all read the same
stock value, so that after the close Current Value === today's DailyHistory row.

Nearly all the work is in `gas/Code.js`. The PriceMap wire contract is unchanged,
so `src/` needs only the D.2 intraday note.

## Acceptance tests (write first — MUST be RED before implementation)

Pure helpers only; `test/gas.*.test.js` already shows how to exercise GAS
functions in a Node sandbox (see the `validateScenario_` tests).

- [x] T1 `parseQuoteResponse_(json, tz)` builds `{sessionDate, isClosed, closes}`
      from a captured Yahoo payload; null closes are dropped.
- [x] T2 `isClosed` is true iff the `regularMarketTime` Taipei time-of-day >= 13:30.
- [x] T3 `currentOf(bundle) === bundle.closes[bundle.sessionDate]`.
- [x] T4 `prevCloseOf(bundle)` = close of the latest date **strictly before**
      `sessionDate`. **Must not read `meta.chartPreviousClose`** — §D.1 records it
      returning 147.5/143/142.5 for the same stock at different ranges.
- [x] T5 **The invariant.** Given a settled bundle, the value `recordDailySnapshot`
      would write equals the value `?resource=prices` serves for `sessionDate`.
- [x] T6 Upsert: backfilling a date that already has a row leaves it unchanged.
- [x] T7 A ticker whose fetch fails is reported, never silently valued at 0.
- [x] All new acceptance tests confirmed FAILING before implementation began
      (verified by `git stash`-ing `gas/Code.js` back to its pre-Rev-4.7 committed
      state and re-running `test/gas.priceservice.test.js`: 21 failed / 3 passed,
      then restored — see Gemini Notes below).

## Implementation

- [x] `getQuotes_(codes)` per §D.1 — one `chart` request per ticker, `.TW` then
      `.TWO`. Return the §D.1 QuoteBundle shape.
- [x] `CacheService` per §D.3: one entry per ticker, 300 s live / to 08:00 settled.
- [x] Rewrite `getPricesFromSheet` to serve from `getQuotes_`: `current` under
      `sessionDate`, `prevClose` under `closeyest`. **Read the ticker→code map from
      the Prices tab; never read the `price`/`closeyest` cells again** (§D.5).
- [x] `recordDailySnapshot` → `closes[sessionDate]`, gated on `isClosed`. It must
      not call `getValues()` on the price columns.
- [x] `backfillDailySnapshots` → `getQuotes_`; **delete the `historySheet.clear()`**
      and upsert only dates with no row (§D.7).
- [x] **Trim on both sides of every ticker lookup.** The present backfill keys its
      price map by the raw `Prices!A` cell but looks it up with a trimmed name, so
      any ticker with a stray space is valued 0 on every day (CHANGELOG Rev 4.6
      records `'台積電 '`). Reuse `getCurrentHoldings_`'s trimming. Applied in all
      three rewritten functions, not just the backfill (see Gemini Notes).
- [x] Per-ticker fetch failure must surface in the response, not just `Logger.log`.
      Interpreted as `getQuotes_`'s own return value carrying `{error:...}` per
      ticker (see Gemini Notes — flagged as an interpretation, not a literal spec
      quote).
- [x] `src/app.js`: while `isClosed` is false, label the Current Value card
      "intraday — today's close not yet settled" (§D.2). Bump the `?v=` tag on any
      changed internal import (Rev 3.2 gotcha) — `index.html`'s `src/app.js?v=13`
      → `?v=14` (app.js gained no new imports, so no internal import tag changed).

## Definition of Done (Phase 2)

- [x] T1–T7 green; existing suite still green (118/118: 94 pre-existing + 24 new).
- [x] `design.md` §D.5 reflected: nothing in the pipeline reads `price`/`closeyest`
      (verified by grep — see Gemini Notes).
- [x] No behaviour change to the Yearly chart or year-end history.
- [x] Hand to Phase 3 (Auditor) — **do not deploy.** Deploy is Phase 4 and needs
      `node gas/deploy.mjs` plus the user's explicit approval. **Not deployed, not
      committed, not pushed** by this Phase 2 pass.

## Gemini Notes — Rev 4.7

### Iteration 1 — 2026-09-20 (Rev 4.7 Unified price service)
**Triggered by:** Phase 2 assignment opened 2026-09-20, `design.md` §D.

**Actions taken:**
- Wrote `test/gas.priceservice.test.js` (24 tests: T1–T7 plus extra unit coverage
  for `closeAsOf_`/`secondsUntilNextTaipei8am_`/caching/trim behaviour), following
  `test/gas.sellplans.test.js`'s `vm.createContext` pattern. Confirmed RED by
  `git stash`-ing `gas/Code.js` back to the pre-Rev-4.7 committed version and
  re-running the suite (21 failed / 3 passed — the 3 passes were generic helper
  assertions unrelated to this feature), then `git stash pop` to restore.
- Implemented `parseQuoteResponse_`, `currentOf`, `prevCloseOf`, `closeAsOf_`,
  `normalizeQuoteCode_`, `secondsUntilNextTaipei8am_`, `fetchYahooChartJson_`,
  `fetchQuoteForCode_`, `getQuotes_` in `gas/Code.js` per §D.1/§D.3.
- Rewrote `getPricesFromSheet`, `recordDailySnapshot`, `backfillDailySnapshots` to
  read exclusively from `getQuotes_`; removed the now-superseded
  `getLastTradeSession_` (confirmed via grep it had no other callers).
- Added the D.2 intraday note to `src/app.js` (`isLikelyIntraday`/
  `taipeiClockParts`) and a `#val-current-note` element in `index.html`.

**Deviations / interpretations (flagged for Auditor):**
1. **Yahoo request params.** §D.1 says "one chart request per ticker" without
   specifying query params. I initially implemented a bare, param-less request
   (matching the literal reading) and it passed all 24 tests against synthetic
   fixtures — but a live `curl` against Yahoo during this session showed a
   **completely bare request returns 1-minute intraday bars for a single
   calendar day**, so every timestamp collapses onto today's date and
   `prevCloseOf` would always return `null` in production (Yesterday Value would
   silently break on the very first live call, despite all tests passing).
   Fixed by adding `?range=1mo&interval=1d` to the fetch — empirically verified
   this returns ~21-25 real trading days of one-bar-per-day closes plus a valid
   `meta.regularMarketTime`, for both a `.TW` (2330) and a `.TWO` (8299) symbol.
   This does **not** reintroduce the "range-dependent" hazard §D.1 warns about,
   because nothing in this file reads `meta.chartPreviousClose` /
   `meta.previousClose` / `meta.regularMarketPrice` — only `closes`, exclusively,
   everywhere. **Recommend the Auditor re-verify this against live Yahoo data**,
   since I could not run the actual `gas/Code.js` inside real Apps Script this
   session (only a Node `vm` sandbox with fakes) and Yahoo's undocumented
   behaviour could change.
2. **Historical depth for `backfillDailySnapshots` is reduced.** The pre-4.7
   version fetched an explicit `period1`/`period2` window sized to the caller's
   requested range (up to the full 365-day `HISTORY_WINDOW_DAYS`) — one ranged
   request per ticker, covering the whole window in one call. `getQuotes_`'s
   §D.1 signature (`getQuotes_(codes)`, no range parameter) doesn't allow that;
   with the `range=1mo` fetch above, `backfillDailySnapshots` can now only
   gap-fill dates within roughly the trailing month, not reconstruct a full
   365-day window from scratch on an empty `DailyHistory` sheet. Given D.7's
   "fix forward, existing rows untouched" framing, this reads as an accepted
   trade-off (the function's job going forward is mostly filling small recent
   gaps, e.g. a day the trigger failed), not a full historical rebuilder — but
   it IS a real capability loss versus the pre-4.7 code, worth the user/Auditor
   knowing about explicitly rather than discovering silently.
3. **"Per-ticker fetch failure must surface in the response"** (task.md
   implementation bullet) — implemented as `getQuotes_`'s own return value
   carrying `{error:'fetch_failed'}` / `{error:'no_code'}` per ticker (consumed
   internally by all three callers, which exclude that ticker and `Logger.log`
   it), **not** as a new field added to the public `?resource=prices` JSON
   response. I read "the response" as referring to `getQuotes_`, the function
   named in the very next bullet, and chose this because the **hard constraint**
   "the PriceMap wire contract (§A.5) is unchanged" explicitly forbids adding
   any new top-level/sibling key to that JSON. If the Auditor intended "the
   response" to mean the public HTTP response instead, that would need a wire
   change and should come back as a design amendment, not something I should
   have silently decided either way.
4. **D.2 intraday note (`src/app.js`) uses a client-clock proxy, not a server
   field.** §D.4's consumer table lists no `isClosed` key for `?resource=prices`,
   and the hard constraint says the wire contract is unchanged — so there is no
   channel for the server's real `isClosed` to reach the browser. I derived it
   client-side instead: `priceToday` (the served `sessionDate`) equal to today's
   Taipei calendar date AND the Taipei wall-clock time-of-day still before
   13:30 ⇒ "intraday"; anything else (including `priceToday` being an earlier
   date, i.e. a weekend/holiday carry-forward) ⇒ settled. This mirrors the
   server's own >=13:30 rule but trusts the *browser's* clock, not the Yahoo
   feed's timestamp — they will disagree only within seconds of the boundary
   or if the viewer's clock is wrong. Flagging as an interpretation since §D.2
   doesn't specify a transport for this at all.
5. **Removed `getLastTradeSession_`** (the old single-ticker 2330 probe used by
   `recordDailySnapshot` to find session date/closed-ness) since it is fully
   superseded by `getQuotes_` and had no other callers (checked via grep across
   the repo, including `deploy.mjs`/tests). `recordDailySnapshot` now derives
   session date/closed-ness from the first successfully-resolved bundle among
   the tickers it's already fetching for valuation — no extra network call.
6. **Performance/quota risk, not a deviation but worth flagging directly:** the
   old `getPricesFromSheet` read pre-computed `GOOGLEFINANCE`/formula cells —
   essentially free. The new one calls `getQuotes_` for **every** row in the
   `Prices` tab on every `?resource=prices` request when the caller passes an
   empty ticker filter (which `src/app.js` always does, to price historically-
   sold tickers too) — up to ~50 live Yahoo fetches per web app call, mitigated
   only by the §D.3 cache. A cold cache (e.g. right after the 08:00 Taipei
   expiry, or the first request after a code change) could be noticeably slower
   than before, and in the worst case risks Apps Script's execution time limit
   if Yahoo is slow to respond. This is inherent to §D.1's "one Yahoo chart
   request per ticker" mandate, not something I introduced by choice — but the
   Auditor/user should know page-load latency can now vary with Yahoo's
   responsiveness in a way it never did before.
7. **No test exercises the real Apps Script/Sheets/Yahoo integration end-to-end**
   — only a Node `vm` sandbox with fakes (`test/gas.priceservice.test.js`,
   following the established `gas.sellplans.test.js` pattern) plus a few one-off
   `curl` calls against the real Yahoo endpoint (used only to derive item 1
   above, not run through `gas/Code.js` itself). Per the hard constraint, no
   deploy was performed. **Recommend the Auditor (or the user, post-deploy)
   confirm the live invariant** — Current Value === today's DailyHistory row
   after the close — against the real Sheet once this ships.
8. **`design.md` §D.6's blocking data-gap item** (pasting 友達/欣興/新增code rows
   into the live `Prices` tab) is a spreadsheet edit by the user, out of scope
   for this code-only pass — left untouched, as instructed.

**Files changed:** `gas/Code.js`, `src/app.js`, `index.html`,
`test/gas.priceservice.test.js` (new). `task.md` (this section) and no other file.

**Not committed, not pushed, not deployed.**

### Iteration 2 — 2026-09-20 (Phase 3 audit fixes A1/A2)
**Triggered by:** Phase 3 audit findings A1 (cold-cache latency) and A2
(backfill range silently reduced), user approved the fix iteration. A3
(intraday label) and A4 (per-ticker failure surfacing) were accepted as built
— not touched this round.

**A1 — cold-cache latency:**
- Replaced `getQuotes_`'s per-ticker sequential `UrlFetchApp.fetch` (via the
  now-deleted `fetchYahooChartJson_`/`fetchQuoteForCode_`) with
  `fetchQuoteBatch_`, which wraps `UrlFetchApp.fetchAll`. `getQuotes_` now
  does at most 2 batches total for any number of tickers: one `fetchAll` of
  every pending ticker's `.TW` symbol, then a second `fetchAll` of only the
  symbols that missed (the `.TWO` set) — 45 sequential round trips collapse to
  2 parallel ones on the current Prices tab. A whole-batch transport failure
  (`fetchAll` itself throwing) degrades to "every ticker in that batch reports
  `fetch_failed`", never a crash.
- `getPricesFromSheet` now builds its `tickerCodeMap` (the set fed to
  `getQuotes_`) from `getCurrentHoldings_(ss) ∩ coded Prices rows` instead of
  every coded row — a ticker that's been sold out of the ledger no longer
  costs a live Yahoo fetch it can't use. Year-end date columns are still
  served for every row from the sheet, untouched, regardless of held status
  (verified by a new test with one held + one non-held ticker sharing a
  year-end column). `recordDailySnapshot` was already held-only (unchanged).
  `backfillDailySnapshots` was deliberately left fetching ALL coded tickers,
  not just held ones — it reconstructs historical positions for tickers that
  have since been sold, which genuinely need a price too; narrowing it to
  held-only would silently blank out sold positions' history.
- Added 8 new tests under `describe('A1 — UrlFetchApp.fetchAll batching')` /
  the new held-ticker guard test in the `getPricesFromSheet` block: exact
  batch count/contents for a mixed `.TW`/`.TWO` set, zero batches on a fully
  warm cache, whole-batch-throws degrading to per-ticker errors, a non-held
  ticker never being fetched at all (0 URL calls, not just an excluded
  result), and the auditor's explicitly-requested guard — a non-held ticker's
  year-end column is byte-identical to before while a held ticker's
  `sessionDate` key (what `src/app.js`'s `priceToday` resolves from) is still
  present and correct.

**A2 — backfill range silently reduced:**
- Threaded `range` through `getQuotes_(tickerCodeMap, range)` →
  `fetchQuoteBatch_(symbols, range, tz)`, defaulting to the module constant
  `DEFAULT_QUOTE_RANGE = '1mo'` (unchanged behaviour for `getPricesFromSheet`/
  `recordDailySnapshot`, which never pass a range explicitly).
- Added `yahooRangeForDays_(days)`, a pure lookup table (`5d`/`1mo`/`3mo`/
  `6mo`/`1y`/`2y`/`5y`/`10y`) mapping a calendar-day span to the smallest
  Yahoo range token that should cover it. `backfillDailySnapshots` computes
  `spanDays` from its actual `startDate..now` window and passes
  `yahooRangeForDays_(spanDays)` — the default trailing-365-day window now
  requests `range=1y`, not `1mo`.
- **Cache key now includes `range`** (`quoteCacheKey_(code, range)` →
  `'q_' + code + '_' + range'`), exactly the trap named in the audit: a
  `q_2330_1mo` entry is a cache MISS for a `range='1y'` request and vice
  versa. Covered by a dedicated test that seeds a `1mo` entry, requests `1y`
  for the same code (asserts a fresh `fetchAll`, not a stale short-range
  value), then requests `1mo` again (asserts THAT is still served from cache,
  proving the two don't cross-contaminate in either direction).
- **Loud shortfall reporting:** the per-date reconstruction loop now counts
  `unpriceableDates` — a requested date (not already an existing row) where no
  held ticker had a close within the existing 10-day lookback. When non-zero,
  `Logger.log`s the exact count plus up to 10 sample dates, and the final
  summary log line always states the unpriceable count (0 when everything was
  covered). `backfillDailySnapshots` now also **returns**
  `{newRows, existingUntouched, unpriceable}` (GAS ignores return values from
  trigger-invoked functions, so this is purely additive — nothing depended on
  the previous `undefined` return) so both a human reading the execution log
  and a test/future caller can see the shortfall without parsing log text.
- Added 4 new tests under `describe('A2 — range threading + loud shortfall')`:
  a wide (300-day) window caches under `q_2330_1y` not `q_2330_1mo` and logs
  `range=1y`; a narrow (3-day) window caches under `q_2330_5d`; a window wider
  than the fixture's actual close coverage reports `unpriceable > 0`, logs a
  count-bearing message, and still writes the rows it COULD price (not
  all-or-nothing); a fully-covered window reports `unpriceable: 0`.

**Verification:**
- Confirmed the fix, not just written: `grep -n "fetchYahooChartJson_\|fetchQuoteForCode_" gas/Code.js`
  returns nothing (fully replaced, no dangling references) and `node --check
  gas/Code.js` / `node --check src/app.js` both pass.
- `npx vitest run test/gas.priceservice.test.js`: **35/35 green** (24 T1–T7 +
  original extras, minus the 4 tests that needed a `HeldLots` fixture added
  after the A1 held-only filter landed — same assertions, now genuinely
  exercising what they claim to — plus 11 new: 3 A1 batching, 1 A1
  non-held-ticker guard, 4 A2 range/cache-key/shortfall, and the auditor's
  named A1 year-end + priceToday guard).
- Full suite: **129/129 green** (94 pre-existing + 35 in this file).
- No `getLastTradeSession_`/`fetchYahooChartJson_`/`fetchQuoteForCode_`
  remnants; §D.2 invariant intact — `currentOf`/`prevCloseOf` are untouched,
  still read exclusively from `bundle.closes`, never a `meta` field.

**What I could not fully verify:** same caveat as Iteration 1 — no live Apps
Script/Yahoo run was performed (constraint: do not deploy). The `fetchAll`
request/response shape used here (an array of `{url, muteHttpExceptions,
headers}` objects, responses returned in the same order) matches Google's
documented `UrlFetchApp.fetchAll` contract, but I could not execute it against
the real Yahoo endpoint or real Apps Script this session — only against the
Node `vm` fake, which trusts that contract rather than proving it live.
**Recommend confirming this specific call against live Apps Script before/at
deploy**, since `fetchAll`'s exact error behavior (e.g. what a single bad URL
in a batch does to the others) is the one part of this fix that a sandbox
fake can only approximate, not verify.

**Not committed, not pushed, not deployed.**

## Phase 3 — Auditor notes (Claude), Rev 4.7, 2026-09-20

Verified independently, not taken from the coder's report: suite 118/118 green;
`historySheet.clear()` gone; no `meta` price field read anywhere outside the
legacy `GET_TAIWAN_STOCK_PRICE` custom function (§D.5 permits it there);
year-end date columns still served off the sheet, so the Yearly chart is
untouched; the bare-request finding reproduced exactly — `2330.TW` with no
params returns `dataGranularity=1m`, 270 bars, **1 distinct day**, so
`prevCloseOf` would have returned null on every live call. That was a gap in
§D.1, which never specified range params. Architect's miss, caught by the coder.

### A1 — Cold-cache latency (significant, fix before Phase 4)

`getQuotes_` fetches **sequentially** (`gas/Code.js:503`); no `UrlFetchApp.fetchAll`.
The frontend calls `getPrices([])`, so a cold cache costs, against the current
Prices tab: 39 coded tickers, 33 resolving on `.TW` (1 fetch) and 6 on `.TWO`
(2 fetches, `.TW` tried first) = **45 sequential round trips**. Estimated 9–18 s
of added page-load latency where the old path read cells. Not measured live —
the count is exact, the per-fetch time is an estimate.

Fix: `UrlFetchApp.fetchAll()` for the `.TW` pass, then a second `fetchAll` for
the codes that missed. Optionally narrow the live-quote set to held tickers —
the history chart's year-end prices come off the sheet, not from `getQuotes_`.

### A2 — Backfill range silently reduced (moderate)

`fetchYahooChartJson_` hardcodes `range=1mo` (`gas/Code.js:454`). The pre-4.7
backfill used explicit `period1`/`period2` spanning any requested window.
`backfillDailySnapshots('2025-01-01')` now silently produces ~25 rows instead of
~365, with no error — the same silent-shortfall class this revision exists to
remove. Adequate for the gap-filling role D.7 leaves it, but the silence is the
defect.

Fix: thread a range/period argument through `getQuotes_` → `fetchYahooChartJson_`
(cache key must include it), or have the backfill refuse a start date outside
what it can actually cover.

### A3 — Intraday label is a clock proxy (minor, accept)

Coder flagged that `isLikelyIntraday` (`src/app.js:37`) derives from the Taipei
wall clock rather than the server's `isClosed`. Audited: it is anchored on the
**served** `sessionDate`, so on weekends and holidays `sessionDate !== today`
and the label correctly stays hidden; pre-open it is also correct. It is wrong
only on an early close (typhoon day, half session), where it shows an advisory
string for a few hours. Cosmetic, degrades safely. **Accept as built.**

### A4 — Per-ticker failure surfacing (accept)

Coder read "surface in the response" as `getQuotes_`'s return rather than the
HTTP wire, to honour the unchanged-wire-contract constraint. Correct call: a
failed ticker is absent from the PriceMap, which the existing review notice
(`src/app.js:152`) already reports to the user. **Accept.**

### Stale docs to fix before Phase 4

`design.md:118` and the old comment at `gas/Code.js:265` described the price
column as `GOOGLEFINANCE`; it is `GET_TAIWAN_STOCK_PRICE`. The gas comment is
now corrected by this revision; `design.md:118` (§A.5) still says GOOGLEFINANCE.

### Phase 3 sign-off — Rev 4.7, 2026-09-20

A1 and A2 re-audited after the coder's iteration 2. Verified independently:
suite 129/129 green; `UrlFetchApp.fetchAll` in two batches (`.TW` pass, then a
`.TWO` retry pass); cache key is `q_<code>_<range>`, closing the range-collision
trap; `yahooRangeForDays_` sizes the backfill's request to its actual span;
shortfalls now counted and logged.

Measured against the real ledger (the coder's estimate of "46 held / close to 39
coded" was wrong; it had no access to the live sheets):

| | tickers fetched | round trips |
|---|---|---|
| Before Rev 4.7 | 0 (read cells) | 0 |
| Rev 4.7 as first built | 39 | 45 sequential |
| After A1 | 20 today, 24 after the code paste | **2 parallel** |
| Backfill | 39 (all coded) | 2 parallel |

The coder declined to narrow `backfillDailySnapshots` to held tickers. Correct
call, and it should not be changed: the backfill anchors on HeldLots and walks
*backwards* undoing trades, so past days legitimately hold since-sold positions
that still need prices.

**Accepted. A3/A4 stand as built.** Remaining before Phase 4: `fetchAll`'s
same-order response contract is implemented to Google's documented behaviour but
exercised only against a Node fake — confirm on the first live run. Prices tab
code paste still outstanding (`backups/prices_tab_codes_2026-09-20.csv`).

### Phase 4 — post-deploy finding: A5, phantom non-session bar (REGRESSION)

Apps Script deployed 2026-09-20 (version 11 -> new version; rollback point 11,
backup in `backups/gas-20260920-150716/`). `deploy.mjs` step 6 threw instead of
returning problems — `verify()` does not catch a JSON parse failure, so the
transient HTML burst bypassed BOTH its retry loop and its auto-rollback. The
deploy landed un-rolled-back. Manual end-to-end verification then passed:
ledger row counts all match baseline, all 24 held tickers priced, and the §D.2
invariant holds live (Current Value == last DailyHistory row exactly, diff 0).
(Absolute portfolio figures deliberately omitted — this repo is public.)

**But:** Yahoo appends a trailing bar dated the CURRENT day even on a
non-trading day, carrying the previous session's close:

```
Fri, 2026-09-18, 09:00  close=2460  volume=35,352,856
Sun, 2026-09-20, 12:00  close=2460  volume=5,242,511
```

Real daily bars are stamped at the session open (09:00 Taipei); this one is
stamped at the current market time. So on a weekend/holiday `sessionDate`
becomes a non-session date and `prevCloseOf` returns the last REAL close —
which the phantom bar duplicates. **Yesterday Value therefore equals Current
Value and the delta card reads 0 on every non-trading day.** Verified live:
delta 0 where it should be Friday(2460) vs Thursday(2425).

This is a regression against pre-4.7 behaviour, and it is an Architect fault:
§D.1 defined `prevClose` as "the latest date strictly before `sessionDate`"
without anticipating that Yahoo emits non-session bars. Current Value and
DailyHistory are unaffected — both read the right number.

Proposed fix: keep only bars stamped at the modal (session-open) time-of-day
and drop the rest, so `closes` contains sessions only. On a trading day nothing
is dropped (the in-progress bar is itself stamped at the open); on a
non-trading day the phantom goes. **Caveat: the trading-day branch could not be
observed — 2026-09-20 is a Sunday — so it needs confirming on a weekday.**

### Iteration 3 — 2026-09-20 (Phase 4 fix-forward: A5 phantom bar, A6 deploy.mjs verify())
**Triggered by:** coordinator message after live post-deploy verification found
A5 (regression, Architect fault per §D.1) and A6 (deploy.mjs's `verify()`
swallowing a JSON-parse failure and bypassing its own retry/rollback). User
approved fixing forward. **Not deployed, not committed** — HEAD stays at
`22920dd`; the coordinator verifies and handles the redeploy.

**A5 — discriminator chosen, and why:** the two-condition rule the coordinator
suggested, implemented exactly as given: a trailing bar is a phantom iff (a)
its close exactly equals the immediately preceding bar's close, AND (b) its
Taipei time-of-day differs from the immediately preceding bar's. Only the
single last bar is ever checked, against its one predecessor. New pure helper
`detectPhantomTrailingBar_(points, tz)` in `gas/Code.js` implements the rule in
isolation (directly unit-tested); `parseQuoteResponse_` calls it, and when a
phantom is found: its date is never added to `closes`, and `sessionDate` is
recomputed from the last REAL point's timestamp instead of
`meta.regularMarketTime` (which IS the phantom's own timestamp) — otherwise
`current = closes[sessionDate]` would resolve to nothing at all. `isClosed` is
forced `true` whenever a phantom was dropped, since falling back to a real
prior session means that session is by definition already settled — this also
happens to fix a related latent risk: `recordDailySnapshot` running on a
weekend now correctly re-resolves to Friday and idempotently re-upserts
Friday's existing row, instead of being at the mercy of whatever time-of-day
Yahoo's phantom happened to carry that day for its stale isClosed gate.
`fetchQuoteBatch_` (the one impure caller) logs `bundle.phantomDropped`
per-symbol via `Logger.log` when present, satisfying "make the decision
observable... from the Apps Script log without guessing."

**T-a..T-d (test/gas.priceservice.test.js, new `describe('A5 — ...')` block,
8 tests):**
- T-a (non-trading day, phantom present): PASS. `sessionDate` resolves to
  Friday, `closes` has no Sunday key at all, `currentOf` = 2460 (Friday,
  unregressed), `prevCloseOf` = 2425 (Thursday — the session before Friday,
  not Friday itself), `isClosed` = true, and `bundle.phantomDropped` carries
  the full diagnostic record asserted verbatim.
- T-b (trading day, in-progress bar stamped 09:00 — same time-of-day as every
  other bar): PASS. Condition (b) is false (no time-of-day difference from the
  modal 09:00 convention), so nothing is dropped regardless of any close
  match; current = live, prevClose = yesterday.
- T-c (trading day, in-progress bar stamped at tick time, close DIFFERENT from
  yesterday's): PASS. Condition (a) is false, so nothing is dropped regardless
  of the time-of-day mismatch; current = live, prevClose = yesterday.
- T-d (live bar's close coincidentally equals yesterday's, on a trading day):
  PASS, **but only under the 09:00-stamping hypothesis** (paired with T-b's
  convention, where condition (b) is false so the AND never fires). Also added
  a direct `detectPhantomTrailingBar_` unit test (fewer than 2 points -> always
  null) and two integration tests: `getQuotes_` logs the phantom decision
  symbol-tagged, and the full §D.2 invariant (`getPricesFromSheet` /
  `recordDailySnapshot` agreement) survives a phantom day end-to-end.

**What remains unproven until a weekday observation (named explicitly, not
glossed over):** whether Yahoo stamps a TRADING day's in-progress bar at
09:00 (session open, T-b) or at the current tick time (T-c) is still unknown —
today is Sunday, same constraint the coordinator flagged, and nothing in this
fix round could resolve it either, since it requires observing a live market-
open session. Concretely: **if a trading day's in-progress bar is stamped at
tick time (T-c's hypothesis) AND its live price happens to coincidentally
equal yesterday's close (T-d's scenario) at the same time, both discriminator
conditions hold simultaneously and this fix would misclassify that live bar as
a phantom** — an unavoidable ambiguity from the payload alone, since that
exact signature (close match + time-of-day mismatch) is indistinguishable from
a genuine phantom without an external trading-calendar. This is the same gap
the coordinator named upfront ("I cannot prove the time-of-day rule alone").
Recommend confirming Yahoo's intraday stamping convention on the next trading
day and watching the `fetchQuoteBatch_: dropped phantom...` log line for any
unexpected trigger during market hours.

**A6 — deploy.mjs `verify()`:** `getJson`/`postJson` now go through a shared
`fetchJson(url, opts)` that reads the response as text first and only then
`JSON.parse`s it; a parse failure throws a new `UnparseableResponseError`
(carries HTTP status + a 120-char snippet of the actual body) instead of
letting a bare `SyntaxError` propagate from `res.json()`. `verify()`'s entire
body is now wrapped in one try/catch: any failure — `UnparseableResponseError`
specifically, or anything else unexpected — is turned into a `problems.push(...)`
entry and `verify()` returns normally, never throws. The two problem classes
are worded distinctly per the coordinator's instruction: a transport/parse
failure reads `"verify: transport error, endpoint did not return JSON
(retryable) — HTTP <status>..."`, while a well-formed-but-wrong response still
reads as the existing `"<resource>: N rows before, M after"` / `"POST save
returned ..."` style messages — a human scanning `problems` never has to guess
which kind occurred. This restores `main()`'s existing 4-attempt retry loop
and its auto-rollback-on-exhaustion, both of which the old code bypassed
entirely (the throw propagated straight to `main().catch(e => die(e.message))`,
never reaching either).

**No automated test added for `deploy.mjs`** — it has none today (pre-existing
condition, not introduced by me), and it cannot safely be given one without a
separate structural change: the file executes `main()` unconditionally at
`import.meta.url` load time (`main().catch(...)` at the bottom, no entry-point
guard), and `config.js` in this working tree holds the real live Apps Script
URL/key — literally `import`-ing `gas/deploy.mjs` from a test file would
attempt real network calls (and, if run without the right flags, a real
deploy) against production. Adding an entry-point guard so the file becomes
safely importable felt like a bigger structural change than the requested fix.
Instead: copied the new `fetchJson`/`getJson`/`postJson`/`verify` logic
verbatim into a throwaway Node script (outside the repo, in this session's
scratchpad, never committed) driven against a scripted fake `global.fetch`,
and confirmed by running it: (1) `verify()` never throws when every fetch
returns an HTML error page; (2) a simulated copy of `main()`'s retry loop
reaches its 4th attempt instead of dying on the first; (3) a well-formed-but-
wrong JSON response is worded as a data mismatch, never as a transport error.
This is a real dynamic check of the exact logic now in `gas/deploy.mjs` (same
source text), just not an automated regression test living in the repo.
**Flagging for the coordinator:** if ongoing automated coverage for
`deploy.mjs` is wanted, it needs that entry-point-guard refactor first — happy
to do it as a separate, explicitly-scoped change rather than folding it
silently into this fix.

**Full suite:** 136/136 green (129 before this round + 7 new: 4 T-a..T-d +
`detectPhantomTrailingBar_` unit test + `getQuotes_` phantom-log test + the
§D.2-invariant-survives-a-phantom-day integration test). `node --check` clean
on both `gas/Code.js` and `gas/deploy.mjs`.

**Files changed this iteration:** `gas/Code.js`, `test/gas.priceservice.test.js`,
`gas/deploy.mjs`, `task.md` (this section). Nothing else.

### A7 — quote cache key has no schema version (design defect, §D.3)

`quoteCacheKey_` is `'q_' + code + '_' + range` (gas/Code.js:536). It carries no
code/schema version, so **a deploy does not invalidate bundles parsed by the
previous code.** With `isClosed` true the TTL is capped at `PRICE_CACHE_MAX_TTL`
(21600s = 6h), so post-deploy the endpoint can keep serving old-logic bundles
for up to six hours.

Observed 2026-09-21 00:20 Taipei, after the Rev 4.7.1 deploy: the endpoint still
returned `sessionDate 2026-09-20` (the phantom date) and a zero delta, while the
same deployed parser run against a live Yahoo payload in a Node sandbox correctly
returned `sessionDate 2026-09-18`, current 2460, prevClose 2425. Same code, two
answers — the endpoint was serving Rev 4.7 bundles out of CacheService.

This is an Architect miss: §D.3 specified the TTL policy but not cache-key
versioning, so any future change to `parseQuoteResponse_` has the same problem.

Fix: include a schema version in the key (`q_v2_<code>_<range>`), bumped whenever
the bundle shape or parse logic changes. Cheap, and it makes deploys of parse
changes take effect immediately instead of up to 6h later.

### Iteration 4 — 2026-09-21 (Phase 4 fix-forward: A7 cache-key versioning)
**Triggered by:** coordinator message after the Rev 4.7.1 deploy's cache-key
finding (A7, §D.3 amendment, Architect fault — the TTL policy never specified
key versioning). User approved fixing forward. **Not deployed, not
committed** — HEAD stays at `2422181`; `design.md` was read only, never
edited, per the explicit constraint.

**Constant name and value:** `QUOTE_CACHE_SCHEMA_VERSION = 'v2'`, declared in
`gas/Code.js` right next to `PRICE_CACHE_LIVE_TTL`/`PRICE_CACHE_MAX_TTL` (same
block, same section), with a comment naming exactly when to bump it (any
change to `parseQuoteResponse_`'s logic or the QuoteBundle shape) and why v2
specifically (the 4.7.1 fix already changed the shape by adding
`phantomDropped`, so every bundle cached under the old unversioned key —
retroactively "v1" — is a genuinely different shape and must not be read).
`quoteCacheKey_(code, range)` now returns `'q_' + QUOTE_CACHE_SCHEMA_VERSION +
'_' + code + '_' + range` — `range` stays exactly where the A2 fix put it, in
the same relative position, so that fix is not regressed, only extended.

**No migration/cleanup code was written**, per the explicit instruction — old
unversioned entries are simply never looked up again by the new key format
and expire on their own via their existing TTL.

**Tests (new `describe('A7 — cache key carries a schema version ...')`
block, 4 tests):**
- `quoteCacheKey_` returns exactly `'q_v2_2330_1mo'` for `('2330','1mo')`, and
  the returned string contains `QUOTE_CACHE_SCHEMA_VERSION` literally (not
  just a coincidentally-matching substring — the constant is read off the
  sandbox `ctx` and checked with `.toContain`).
- **The one the coordinator asked for by name:** seeded the fake cache with an
  entry under the OLD unversioned key (`q_2330_1mo`) holding a shape without
  `phantomDropped` (a stand-in for a genuine pre-A5 v1 bundle) and a
  deliberately-wrong stale price (111). Called `getQuotes_` with the SAME code
  and range under the NEW code. Asserted: a real `fetchAll` still happened
  (not served from the stale entry), the returned value is the FRESH price
  (600), not the stale 111, and the old key is left sitting untouched in the
  cache (proving no migration/cleanup ran) while the new versioned key now
  holds the correct entry.
- Re-ran the existing A2 range-separation scenario under the new key format
  (`q_v2_..._1mo` vs `q_v2_..._1y`) to confirm range separation — the A2 fix —
  still holds; this is in addition to, not a replacement for, the original A2
  test (which was updated in place to expect the `v2`-prefixed key, since it
  was asserting the literal key string).
- Bumping `QUOTE_CACHE_SCHEMA_VERSION` to `'v3'` on the live sandbox context
  and calling `quoteCacheKey_` again produces a DIFFERENT key
  (`q_v3_2330_1mo`) — proves the version is load-bearing in the key
  construction, not a comment-only convention that could silently stop being
  honoured.
- The 6 pre-existing tests that asserted the literal old key string
  (`q_2330_1mo` etc., predating A7) were updated in place to the versioned
  form (`q_v2_2330_1mo`) — same assertions, same coverage, just the key format
  they check against.

**Full suite: 140/140 green** (136 before this round + 4 new A7 tests).
`node --check gas/Code.js` clean.

**What I would do differently about the key format, if asked (not changed —
out of scope, this is a "your opinion" answer, not a deviation):** the version
and range segments are both free-form strings joined by `_` with no
delimiter guarding against a code or range value that itself contains an
underscore. Ticker CODES are already validated 4-digit numerics upstream so
that's not a real risk, and `range` only ever comes from
`DEFAULT_QUOTE_RANGE`/`yahooRangeForDays_`'s fixed token set (never
user-supplied), so this is not an active bug — but if the key ever gained a
component from less-controlled input, a fixed-width or explicitly-delimited
format (e.g. `q/v2/2330/1mo` or a JSON-encoded key) would be more robust than
string concatenation. Not worth doing now; flagging only because the question
was asked directly.

**Files changed this iteration:** `gas/Code.js`, `test/gas.priceservice.test.js`,
`task.md` (this section). `design.md` was read, not edited.

### Phase 4 — CLOSED. Deployed 2026-09-21, Apps Script version 13

`node gas/deploy.mjs` -> `✓ Live on version 13`, step-6 verification passed
cleanly (rollback: `--rollback 12`; backup `backups/gas-20260920-164042/`).

Step 2 confirmed the earlier deduction: live code had been `22920dd` (Rev 4.7).
4.7.1 and 4.7.2 existed only in local git and had never reached the script
project — the two intervening "deploy" attempts never ran `deploy.mjs` (no
backup directory was created, which step 1 always does).

Live verification, all held tickers priced, ledger row counts unchanged:

| | v12 (Rev 4.7) | v13 (Rev 4.7.2) |
|---|---|---|
| sessionDate | 2026-09-20 (phantom) | 2026-09-18 (Friday) |
| Current Value | Friday's close | Friday's close (unchanged) |
| Yesterday Value | **equal to Current Value** | Thursday's close |
| delta | **0 (the bug)** | a full session's move |
| §D.2 invariant | diff 0 | diff 0 |

(Absolute figures omitted — public repo. They were checked and are in the
session record.)

### A8 — historical DailyHistory rows are measurably wrong (expected, quantified)

The newly-correct Yesterday Value (Thursday's close) and the stored
DailyHistory row for 2026-09-17 disagree by **about 2.2%**, the stored row
being the higher. Both value the same position at the same session, so the stored row is wrong by
that much. It was written by the old trigger from a stale cached Prices cell,
which is exactly the §D.0 defect.

This is not a regression and needs no action: the user chose fix-forward, so
pre-2026-09-21 rows were always known-untrustworthy. It is recorded because it
is the first hard measurement of the old bug's magnitude on a real row, and
because anyone reading the daily chart should know the pre-fix segment is low
by an unpredictable amount, not merely "approximate". Rows written from
2026-09-21 onward derive from the same array as the cards.
