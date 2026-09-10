# design.md — Portfolio Dashboard MVP

> **Workflow:** Standard SDLC — Phase 1 (Architect) output
> **Feature slug:** `portfolio-dashboard`
> **Author:** Claude (orchestrator/architect)
> **Status:** `APPROVED 2026-06-12 (rev 3 — lot-based schema)` — Phase 1 complete; cleared for Phase 2.

This is the combined **Contracts (the WHAT)** + **Blueprint (the WHERE)** document. Section A pins interfaces, invariants, and the error taxonomy. Section B pins the stack and component/trust boundaries. The Phase 2 Coder (Gemini 3.1 Pro) derives acceptance tests directly from Section A and must respect the boundaries in Section B.

> **Rev history:** rev 1 OneDrive/Graph → **rev 2** Google Sheets + Apps Script + `GOOGLEFINANCE` + GitHub Pages → **rev 3** adopts the user's **lot-based schema** of tab `股票明細`: current positions, cost, and invested capital are read from the user's own bookkeeping columns rather than reconstructed from buy−sell flow.

---

## Scope

A private personal dashboard presenting, from the ledger `股票 2023.xlsx` (tab `股票明細`, imported into **Google Sheets**):
1. **Portfolio value over time** — true historical line, year-end points.
2. **Dividends collected per year** — bar chart.
3. **Current holdings** — per-stock shares, cost, live market value, yield.
4. **Performance metrics** — total invested, total dividends, **ROI**, **XIRR**, **simple CAGR**.

Data source and price source are pluggable behind interfaces (A.4/A.5) so the system builds/tests offline (local JSON + mock prices) and goes live (Google Sheet via Apps Script + `GOOGLEFINANCE`) by swapping an implementation.

**Out of scope:** buy/sell recommendations, tax optimization, multi-currency, editing the sheet from the dashboard.

---

## Section A — Contracts (the WHAT)

### A.0 Canonical data schemas
Derived from tab `股票明細`. Money in NT$.

```
HeldLot = {                 // a currently-held lot: a 尚未交易="Y" row (AUTHORITATIVE for current position)
  date:     string  // ISO, purchase date
  ticker:   string  // Chinese short name, e.g. "聯電"
  shares:   number | null   // 股數 (>0); null if ledger omitted it (flagged → E_DATA_PARSE/E_NO_PRICE)
  buyPrice: number | null   // 股價 = PURCHASE price (not current market price)
  cost:     number          // 目前投資金額 = cost basis of this lot (incl. fees)
}

Trade = {                   // every buy/sell, for historical holdings reconstruction
  date:   string  type: "buy" | "sell"  ticker: string
  shares: number | null     amount: number   // >0, NT$ (支出 for buy, 存入 for sell)
}

Deposit = {                 // 項目="CD轉入" (in) / "CD轉出" (out) — net capital moved into the account
  date: string   amount: number   // >0 = 存入 (CD轉入);  <0 = −支出 (CD轉出 withdrawal)
}

Dividend = {                // 股票="股息"
  date: string  code: string|null  name: string  amount: number  detail: string
}

PriceMap = { [ticker: string]: { [date: string]: number } }   // NT$ per share (current + year-end history)
```

### A.1 Data extraction / seed — `extract.py`
- Writes `held_lots.json`, `trades.json`, `deposits.json`, `dividends.json`; `portfolio_normalized.xlsx` (tabs `HeldLots`, `Trades`, `Deposits`, `Dividends`, `Prices`) + matching CSVs for Google Sheets import.
- **Classification rules (authoritative):**
  - **HeldLot** ⇔ `尚未交易` starts with `"Y"`. `shares=股數`, `buyPrice=股價`, `cost=目前投資金額`.
  - **Dividend** ⇔ `股票 == "股息"`. Code+name parsed from `明細` (`現金股息2324仁寶`→`2324`,`仁寶`); `amount=存入`.
  - **Deposit** ⇔ `項目 == "CD轉入"`; `amount=存入` (>0). Also ⇔ `項目 == "CD轉出"` & `股數` blank; `amount=−支出` (<0, cash withdrawn from the account). A `CD轉出` **carrying `股數`** is money spent buying stock, mis-tagged in the ledger (2023-06-05 星宇航空) — it is an investment, not a withdrawal, and is excluded from Deposits.
  - **Trade(buy)** ⇔ `項目=="轉帳支取"` & `股票` set & `!= "股息"`; `amount=支出`. **Trade(sell)** ⇔ `項目=="轉帳存入"` & `股票` set & `!= "股息"`; `amount=存入`.
  - All other rows (interest, tax, 減資退款, 退綜所稅, cash withdrawals) excluded.
- **Invariants:** DX-1 every record conforms to A.0; DX-2 `Σ Dividend.amount == Σ 存入 where 股票=股息`; DX-3 no `Trade`/`HeldLot` has `ticker=="股息"`; DX-4 `Σ HeldLot.cost == Σ 目前投資金額 over Y rows`.

### A.2 Metrics engine (core — highest correctness bar)
Pure functions, no I/O.

| Fn | Signature | Definition / invariant |
|---|---|---|
| `currentHoldings` | `(HeldLot[]) -> {ticker: {shares, cost}}` | **MET-1:** per ticker, `shares=Σ lot.shares`, `cost=Σ lot.cost`. Lots with `shares==null` excluded from `shares` and surfaced for review. Result shares ≥ 0 by construction (sold lots aren't `Y`). |
| `costOfHoldings` | `(HeldLot[]) -> number` | **MET-2:** `Σ HeldLot.cost` (= 目前投資金額). **This is the ROI denominator.** |
| `investedCapital` | `(Deposit[]) -> number` | **MET-3:** `Σ Deposit.amount` (= CD轉入 total net of CD轉出 withdrawals). |
| `currentValue` | `({ticker:{shares}}, PriceMap, asOf) -> number` | **MET-4:** `Σ shares × price(ticker, asOf)`. Held ticker with no price ⇒ `E_NO_PRICE`. |
| `roi` | `(value, dividends, cost) -> number` | **MET-5:** `(value + dividends − cost) / cost`, `cost=costOfHoldings`. `cost==0` ⇒ `E_DIV_ZERO_COST`. |
| `xirr` | `(cashflows:{date,amount}[], guess?=0.1) -> number` | **MET-6:** rate `r`, `|NPV(r)|<1e-6`, Newton-Raphson ≤100 iters. Needs ≥1 neg & ≥1 pos ⇒ else `E_XIRR_BAD_INPUT`; non-convergence ⇒ `E_XIRR_NO_CONVERGE`. |
| `simpleCagr` | `(beginValue, endValue, years) -> number` | **MET-7:** `(endValue/beginValue)^(1/years) − 1`. `beginValue≤0` or `years≤0` ⇒ `E_CAGR_DOMAIN`. **Labeled "approximate — ignores deposit timing."** |
| `dividendsByYear` | `(Dividend[]) -> {year: total}` | **MET-8:** `Σ years == Σ amounts`. |
| `portfolioValueOverTime` | `(Trade[], PriceMap, dates[]) -> {date,value}[]` | **MET-9:** dates ascending; `value(t)=Σ_ticker sharesHeld(t)×price(ticker,t)`, `sharesHeld(t)=Σ buys≤t − Σ sells≤t`. Missing price for held ticker at `t` ⇒ `E_NO_PRICE`. |

### A.2b Rev 3.2 additions (approved 2026-07-10)
| Fn | Signature | Definition / invariant |
|---|---|---|
| `yesterdayValue` | via `currentValue(holdings, priceMap, 'closeyest')` | **MET-10:** Prices tab column `closeyest` (`GOOGLEFINANCE(...,"closeyest")`, previous trading-day close) served under reserved PriceMap key `'closeyest'`. Tickers without it excluded + surfaced. UI shows Current Value, Yesterday Close Value, and ▲/▼ delta. |
| `depositsByYear` | `(Deposit[]) -> {year: total}` | **MET-11:** `Σ years == Σ amounts` (same conservation as MET-8). UI: bar chart + cumulative overlay. |
| `yearlyPnL` | `(valueByYear, investedByYear) -> {year: pnl}` | **MET-12:** `PnL(y) = V(y) − V(y−1) − invested(y)` (V(y₀−1)=0). Excludes dividends by construction. Years with no computable V omitted + surfaced. Year-end V from historical close columns (last trading day ≤ Dec 31) in the Prices tab — which also feeds MET-9's value-over-time chart. |

*Known limitation (extends L4): delisted/renamed tickers sold in the past have no GOOGLEFINANCE history → early-year V slightly understated; surfaced in the review notice.*

### A.2c Rev 4.1 addition (approved 2026-09-10)
| Fn | Signature | Definition / invariant |
|---|---|---|
| `yieldOnCost` | `({ticker:{shares,cost}}, annualDividendOf) -> {byTicker, annualDividend, cost, yieldPct}` | **MET-13:** per ticker `yieldPct = annualDividend / cost × 100`; portfolio `yieldPct = Σ annualDividend / Σ cost × 100` — **cost-weighted, never a mean of per-ticker ratios**. `cost == 0` ⇒ `yieldPct: null` (not `Infinity`, not `E_DIV_ZERO_COST` — a zero-cost lot is a data artifact, not a metric failure). Only tickers present in `holdings` contribute, so dividends from sold-out positions cannot inflate the total. The trailing-window convention is **injected** via `annualDividendOf`, not reimplemented, so it stays defined once in `annualDividendFor` (SP-3). **Approximate for the same reason as SP-3** — past dividends reflect the share count held then, not now; every surface must label it approximate. Needs no price data, so unlike the planner it is meaningful offline. |

### A.3 XIRR & CAGR assembly
- `buildXirrCashflows(Deposit[], Dividend[], withdrawals, terminalValue, terminalDate) -> {date,amount}[]` — **CF-1:** deposits → `−amount`; dividends → `+amount`; withdrawals (CD轉出) → `+amount`; terminal → `+terminalValue` at `terminalDate`. (Account-level money-weighted return.)
- **Simple CAGR inputs (CF-2):** `beginValue = investedCapital`, `endValue = currentValue + totalDividends`, `years = (terminalDate − earliest Deposit.date)/365.25`.

### A.4 Data source interface (pluggable)
```
interface DataSource {
  loadHeldLots(): Promise<HeldLot[]>
  loadTrades():   Promise<Trade[]>
  loadDeposits(): Promise<Deposit[]>
  loadDividends():Promise<Dividend[]>
}
```
- **`LocalJsonSource`** (offline/tests): fetches the four JSON files.
- **`AppsScriptSource`** (live): `GET {WEBAPP_URL}?resource=heldlots|trades|deposits|dividends` → JSON (A.0). Non-2xx/auth ⇒ `E_AUTH`.

### A.5 Price source interface (pluggable)
```
interface PriceSource { getPrices(tickers: string[], dates?: string[]): Promise<PriceMap> }
```
- **`MockPriceSource`** (tests): deterministic from fixture.
- **`AppsScriptPriceSource`** (live): `GET {WEBAPP_URL}?resource=prices&tickers=..[&dates=..]` → `PriceMap`. Reads `Prices` tab using `=GOOGLEFINANCE("TPE:"&code)` (current) and `GOOGLEFINANCE("TPE:"&code,"close",date)` (year-end). Transport/upstream failure ⇒ `E_PRICE_FETCH`; unknown ticker omitted (→ `E_NO_PRICE` if held).

### A.6 API / data-transfer layer — Google Apps Script Web App
- Deployment: `doGet(e)`, **Execute as owner**, access **"Anyone with a Google account"** (NOT anonymous — B.3.1). Returns `application/json`.
- `?resource=heldlots|trades|deposits|dividends` → arrays per A.0. `?resource=prices&tickers=<csv, names or 4-digit codes, each ≤20 chars, ≤50 items>[&dates=<csv ISO>]` → `PriceMap` keyed by ticker NAME (matching HeldLots/Trades); the Prices tab's current `price` column is served under today's date. Bad/oversized tickers ⇒ `{error:"bad_request"}`; market data unavailable ⇒ `{error:"upstream"}`. *(rev 3.1: was "4-digit codes only" — corrected at integration: the data model keys by Chinese name.)*
- Read-only, idempotent, no persistence.

### A.7 Error taxonomy (closed)
| Code | Trigger |
|---|---|
| `E_DATA_PARSE` | A record fails schema validation (A.0), incl. a `Y` lot with null shares used where shares are required. |
| `E_DIV_ZERO_COST` | `roi` with `cost == 0`. |
| `E_CAGR_DOMAIN` | `simpleCagr` with `beginValue ≤ 0` or `years ≤ 0`. |
| `E_XIRR_BAD_INPUT` | `xirr` cashflows lack both a negative and a positive flow. |
| `E_XIRR_NO_CONVERGE` | Newton-Raphson exceeds 100 iters without `|NPV| < 1e-6`. |
| `E_NO_PRICE` | A held ticker has no price for a requested date (incl. unknown TWSE code). |
| `E_PRICE_FETCH` | `prices` resource returns `{error:"upstream"}` or is unreachable. |
| `E_AUTH` | Apps Script Web App request unauthorized / sign-in fails. |

No "other errors" escape hatch.

---

## Section B — Blueprint (the WHERE)

### B.1 Stack summary (versions pinned)
| Layer | Tech | Version |
|---|---|---|
| Source of truth | **Google Sheets** (from `股票 2023.xlsx`) | — |
| API / data transfer | **Google Apps Script Web App** (`doGet` JSON) | V8 |
| Live prices | **`GOOGLEFINANCE("TPE:"&code)`** in-sheet | — |
| Data seed / extraction | Python + pandas + openpyxl | 3.13 |
| Metrics engine | JavaScript (ES modules), zero runtime deps | ES2022 |
| Test runner | Vitest | ^2.1 |
| Charts | Chart.js | ^4.4 |
| Frontend | Static HTML + vanilla JS | — |
| Hosting | **GitHub Pages** (static) | — |
| Coder model (Phase 2) | **Gemini 3.1 Pro** | `gemini -m gemini-3.1-pro-preview` (verified) |

### B.2 Component sketch
```
股票 2023.xlsx ──(extract.py seed)──► Google Sheet
                                        ├ HeldLots (尚未交易=Y)   ─┐
                                        ├ Trades (buys/sells)     │ read server-side
                                        ├ Deposits (CD轉入)        │
                                        ├ Dividends (股息)         │
                                        └ Prices =GOOGLEFINANCE   ─┘
                                              │
                                  [Apps Script Web App · doGet→JSON]
                                              │ HTTPS (CORS→Pages origin, Google sign-in)
        [DataSource]◄AppsScriptSource/LocalJsonSource   [PriceSource]◄AppsScriptPriceSource/MockPriceSource
                                              │
                                  [Metrics engine · JS pure]
                holdings/cost/invested/value/roi/xirr/simpleCagr/dividendsByYear/valueOverTime
                                              │
                                  [Dashboard UI · HTML+Chart.js] ──► [GitHub Pages]
              value-over-time line | dividends/year bar | holdings table | metrics card
```

### B.3 Trust boundaries
1. **Browser (Pages) ↔ Apps Script** — portfolio data is **private**. Deploy "Anyone with a Google account" (Google sign-in), **not** anonymous. Web App URL is a capability → injected via gitignored `config.js`, never committed. Unauthorized ⇒ `E_AUTH`.
2. **Apps Script ↔ GOOGLEFINANCE** — server-side; only 4-digit codes used; validated `^\d{4}$`, ≤50.
3. **Public Pages repo** — static frontend + metrics engine + fixtures only; never real data, never the Web App URL/keys. Enforced by `.gitignore`(`config.js`) + committed `config.example.js`.

### B.4 Persistence map / migration
- **Source of truth:** the Google Sheet (seeded from `股票 2023.xlsx`); `GOOGLEFINANCE` keeps `Prices` live.
- **Derived:** the JSON files — regenerable seed/fixtures, not authoritative at runtime.
- **No database, no schema migration.** → Standard, not Regulated.

### B.5 Plan Review (Security & Logic Lite)
**Security:** S1 Apps Script not anonymous-public (B.3.1). S2 no secrets/data/URL in the public repo (B.3.3). S3 validate `tickers` `^\d{4}$` ≤50. S4 CORS scoped to Pages origin.

**Logic:**
- L1 — **Negative-holdings issue RESOLVED** by the lot-based method: holdings come from `尚未交易=Y` rows (sold lots aren't `Y`), so the prior 4 negatives (國產/華冠/花王/威剛) no longer arise. Verified: 46 tickers, zero negatives.
- L2 — **New data gap:** 14 `Y` rows have null `股數` (友達, 長榮, 仲琦, 京元電子). Surfaced in a "data needs review" notice; those lots aren't valued. User fixes the sheet.
- L3 — Cost basis = sum of `目前投資金額` (the user's recorded lot cost); ROI denominator per user decision.
- L4 — Historical line samples **year-end + today**; intraday out of scope. `portfolioValueOverTime` uses `Trades` (full buy/sell history) to reconstruct holdings at each year-end; reconstruction may be approximate for tickers with ledger gaps — flagged in the notice, not crashed.
- L5 — 減資退款 / 退綜所稅 excluded from dividends and not modeled as XIRR flows (small).
- L6 — Ticker→TWSE-code map built from dividend `明細`; held tickers with no code (8 known: 統懋, 晶電, 錦明, 星宇航空, 瑞昱, 台達電, 康舒, 華邦電, 晶心科) need codes filled into the `Prices` tab → else `E_NO_PRICE`.
- L7 — **XIRR uses account-level cashflows** (CD轉入 deposits, dividends, withdrawals, terminal value) per the user's "CD轉入 = investment cost" framing. **Simple CAGR** is shown alongside, labeled approximate (CF-2).

### B.6 Notes / decisions
- Lot-based schema (rev 3) adopted because the ledger already records current positions/cost explicitly (`尚未交易=Y`, `目前投資金額`), which is more reliable than reconstructing from flow and eliminates the negative-holdings artifact.
- Google + Apps Script consolidates data access and price fetching server-side (no CORS proxy, no browser OAuth lib).
- JS metrics engine (browser-side, Vitest-testable); `extract.py` stays Python for the messy xlsx seed.

---

## Section C — Rev 4.0 Sell Planner (approved 2026-09-10)

**Goal:** raise **NT$2,000,000 net of tax and fees** out of the current portfolio, showing four
independently-computed candidate plans side by side plus a user-edited plan, persisted locally.

**Scope boundary (binding on the implementation):** segment tags state what a company *makes*. No
function in this section forecasts price or return, and no strategy is labeled recommended. Ranking rules
are transparent and a per-ticker user override outranks every rule.

### C.0 New schemas
```
SegmentMap = {                          // src/segments.json, committed
  version: number
  tiers:    { "1"|"2"|"3": string }     // display labels
  segments: { id: string, label: string, tier: 1|2|3 }[]
  tickers:  { [chineseName: string]: { code: string, segment: string } }
}

SellCandidate = {                       // one per PRICEABLE held ticker
  ticker, code, segment, tier,
  shares, cost, price, value,           // value = shares × price
  plPct,                                // (value − cost) / cost
  annualDividend, yieldPct,             // SP-3
  weightPct                             // value / Σ value
}

SellRow  = { ticker, sellShares, sellPct, gross, tax, fee, net, realizedPL }
SellPlan = { strategyId, rows: SellRow[], totals, feasible, shortfall, spilledIntoTier }
SavedScenario = { id, name, savedAt, strategyId, locked: string[], rows: {ticker,sellShares}[], note }
```

### C.1 Sell-planner engine — `src/sellplanner.js` (pure, no I/O, mirrors A.2)

| Fn | Signature | Definition / invariant |
|---|---|---|
| `buildCandidates` | `({ticker:{shares,cost}}, PriceMap, asOf, Dividend[], SegmentMap) -> {candidates, excluded}` | **SP-1:** one `SellCandidate` per held ticker with a price at `asOf`. A ticker with no price is **excluded**, never valued at cost — returned in `excluded` with a reason (`no_price` / `delisted` / `null_shares`). Unmapped ticker ⇒ `{segment:"unknown", tier:3}`, also listed in `excluded.unmapped` (informational — it stays a candidate). |
| `proceeds` | `(shares, price, {discount=1.0}) -> {gross,tax,fee,net}` | **SP-2:** `gross = shares×price`; `tax = gross×0.003` (證交稅, sell side only); `fee = max(20, gross×0.001425×discount)` (brokerage, NT$20 floor per order); `net = gross − tax − fee`. `discount` default **1.0** so `net` is conservative (understated ⇒ plan raises ≥ target). |
| `annualDividendFor` | `(ticker, Dividend[], asOf) -> number` | **SP-3:** `Σ dividends where date ≥ asOf − 5y` ÷ 5. Matched on trimmed `Dividend.name`. **Approximate by construction** — past dividends reflect the share count held then, not now; every surface that shows `yieldPct` must label it approximate. |
| `solveFill` | `(SellCandidate[], target, opts) -> SellPlan` | **SP-4:** walk the (already sorted) list taking whole positions until the running `net` would meet `target`; solve the final position's `sellShares` so cumulative `net ≥ target`, rounding **up** to whole shares. Shares are integers; 零股 permitted (no 1,000-share rounding). Positions after the fill point get `sellShares = 0`. |
| `summarize` | `(SellPlan, SellCandidate[]) -> PlanSummary` | **SP-5:** `positionsTouched`, `positionsLiquidated`, `realizedPL`, `annualDividendGivenUp` (`Σ annualDividend × sellPct`), `tier1ValueSoldPct`, `taxAndFees`, and remaining-portfolio `value` / `yieldPct` / `tier1WeightPct`. |

**SP-6 — Strategies.** Each is a pure comparator `(SellCandidate[]) -> SellCandidate[]`, fed to the same
`solveFill`. Ties break on higher `value` then `ticker` so output is deterministic.

| id | Ordering rule |
|---|---|
| `tagTiered` | tier 3 → 2 → 1; within a tier, lowest `yieldPct` first |
| `yieldProtect` | lowest `yieldPct` first, tier ignored |
| `proportional` | not a sort — one scale factor `k` applied to every candidate, solved so `Σ net(shares×k) = target` |
| `cutLosers` | lowest `plPct` first |

**SP-7 — Locks and custom.** `locked: string[]` removes those tickers from the candidate list before
sorting; all four strategies re-solve against the reduced set. Editing any `sellShares` switches the
active plan to `custom` (seeded from the strategy it was edited from) and stops re-solving — `custom` is
never auto-adjusted, only recomputed for proceeds.

**SP-8 — Feasibility.** If `Σ net(all candidates) < target`: `feasible=false`, `shortfall = target − Σ net`,
`rows` = the full liquidation, and the UI states the target is unreachable. `tagTiered` recording
`spilledIntoTier = 1|2` is **not** infeasibility — it is the expected outcome (tiers 2+3 do not cover 2M)
and must be shown as an explicit note, not hidden by the ranking.

**SP-9 — Conservation.** For every plan: `Σ rows.gross == Σ shares×price` over touched rows, and
`totals.net == Σ rows.net` to within NT$0.01. `sellShares ≤ candidate.shares` always.

**SP-10 — Target.** `TARGET_NET = 2_000_000`, a single exported constant — the one place the goal changes.

### C.2 Persistence — `localStorage`
- Key `sellPlanner.scenarios.v1` → `SavedScenario[]`. **SP-11:** scenarios store *share counts, not prices*,
  so a reloaded scenario re-prices at today's market; the UI shows the drift in net proceeds since `savedAt`.
- Unparseable or wrong-`version` payload ⇒ `E_SCENARIO_CORRUPT`, surfaced and the store left untouched
  (never silently cleared).
- Export: CSV `ticker,code,shares,price,gross,tax,fee,net,realizedPL` + a text summary, via `Blob` +
  object URL. No backend, no Apps Script change anywhere in Rev 4.0.

### C.3 Error taxonomy additions (extends A.7, still closed)
| Code | Trigger |
|---|---|
| `E_PLAN_INFEASIBLE` | `Σ net` over all candidates `< TARGET_NET` (SP-8). |
| `E_SCENARIO_CORRUPT` | `sellPlanner.scenarios.v1` fails to parse or carries an unknown version. |
| `E_PLAN_NO_CANDIDATES` | Every held ticker was excluded or locked — nothing left to plan against. |

### C.4 Blueprint
- `src/sellplanner.js` — C.1, pure. `src/sellplanner-ui.js` — rendering, edit handlers, localStorage,
  export; exports `initSellPlanner(ctx)`. `src/segments.json` — C.0 map, seeded as a **general ~150-name
  TWSE reference table across all segments**, not only held tickers, so committing it to the public repo
  discloses nothing about the actual position (B.3 trust boundary).
- `index.html` — `Dashboard | 賣股規劃` tab bar; planner section = comparison strip (4 strategy cards) →
  editable detail table → sticky net-raised-vs-target progress bar → discount input → scenario list →
  export. Reuses existing `.card` / `.notice` / `.btn-toggle` styles; no new CSS framework, no new CDN.
- `src/app.js` — one added call after the existing load:
  `initSellPlanner({ holdings, priceMap, priceToday, divs, reviewLots, offline })`. `init()` is otherwise
  untouched. Entry tag → `src/app.js?v=7`; internal imports version-tagged (`./sellplanner.js?v=1`) per the
  module-graph caching gotcha in B.6/task.md.

**C.5 Offline block.** `MockPriceSource` serves *buy* prices (`data/prices.json`), so offline every
`plPct` is 0 and `value == cost`. The planner renders a blocking banner and computes no plan when
`offline` is true — a plausible-looking wrong plan is worse than no plan.

**C.6 Known data exclusions** (surfaced in the planner notice, never silently dropped): 晶電 (delisted,
merged into 富采 — stale quote, force-excluded); lots with null `股數` (A.2 MET-1 review lots); any held
ticker without a `GOOGLEFINANCE` price.

### C.7 Segment → tier binding (amendment, 2026-09-10 — Phase 3 audit)

C.0 named the tier labels and C.4 listed the segment ids, but **nothing bound one to the other**. The
first implementation filled the gap with a *semiconductor-purity* ranking (tier 1 = "core semiconductor"),
which inverts the intent: `tagTiered` sells tier 3 first, so AI server ODM, thermal and rack-power names
were liquidated before consumer IC and commodity memory. The binding below is now normative.

**SP-12 — Tier is a property of the segment, not a judgment call.** `segments[].tier` MUST be exactly:

| Tier | Label (C.0) | Segment ids |
|---|---|---|
| 1 | AI / 資料中心供應鏈 | `cowos_foundry`, `ai_server`, `abf_pcb`, `thermal_power`, `asic_ip`, `optical_network` |
| 2 | 科技，非 AI 主力 | `test_epi`, `memory_storage`, `consumer_ic`, `panel_led` |
| 3 | 非科技 | `shipping_air`, `finance_other` |

`ai_server` (AI 伺服器 / 系統 — server and rack ODM/OEM) was present in the C.0 example but **missing from
the C.4 enumeration**; it is a required segment id. Rationale for the two non-obvious placements, recorded
so they can be argued with rather than guessed at: `thermal_power` is tier 1 because liquid cooling and
rack power sell directly into AI datacenter buildout, not despite being non-semiconductor; `memory_storage`
is tier 2 because the holdings it covers are mostly commodity/niche memory rather than HBM. Neither is a
forecast — both are statements about where the revenue comes from, and the user can move any ticker by
editing `src/segments.json`.

**SP-13 — Unmapped tickers are neutral, never sell-first.** A ticker absent from `SegmentMap.tickers`
resolves to `{ segment: "unknown", tier: 2 }` — **not tier 3**. Defaulting an unknown to tier 3 makes
`tagTiered` liquidate it first on no evidence, which is the most destructive possible reading of missing
data. It stays a candidate, and it MUST appear in the planner notice (already required by SP-1).
*(This supersedes the `tier:3` default stated in C.0 and C.1/SP-1.)*

**SP-14 — Reference table coverage.** `src/segments.json` MUST cover, at minimum, every constituent of the
**台灣50 (0050)** and **中型100 (0051)** indices, plus the named AI-supply-chain suppliers in each segment
above — a public, general membership criterion. This is what keeps the file both *useful* (it must
actually classify a real Taiwanese portfolio; the first cut left 17 of 45 held tickers unmapped) and
*safe to commit* (membership is derived from public index composition, never from `data/`). Building the
table by reading the owner's ledger remains prohibited.

**SP-15 — Classification is by primary revenue source.** Assign the segment describing what the company
mainly *sells*, not its most newsworthy product line. Errors found in the first cut, for the record:
聯詠 and 瑞鼎 are display-driver IC (`consumer_ic`), not `asic_ip`; 京元電子 is IC test (`test_epi`), not
`cowos_foundry`.



---


### C.8 Custom plan as a peer card (amendment, 2026-09-10)

**SP-16 — The custom plan is the fifth card, and it persists.** The comparison strip renders one card per
strategy **plus one for `custom`**, so all five are comparable at a glance. `custom` is held in its own
state, independent of the active selection: clicking between cards to compare no longer discards the
user's edits, which the original single-`activePlan` implementation did silently. Selecting any card must
re-render the strip, the progress bar **and** the totals block — the first implementation omitted the
progress/totals refresh, so a card click left stale figures on screen.

With no edits yet, the fifth card renders as an empty slot that seeds a custom plan from the currently
selected one when clicked, rather than as a dead or missing card.

**SP-17 — A lock change invalidates the custom plan.** Toggling 鎖定不賣 changes the candidate set, so a
custom plan built against the old set is no longer well defined. It is dropped and the empty slot says
*why*. Re-solving it silently against the new set would misrepresent numbers the user entered by hand.

---


### C.9 Dividend window is a parameter (amendment, 2026-09-10)

**SP-18 — `annualDividendFor` takes a `years` window; 5 is a default, not a constant.** SP-3 fixed the
window at five years. On this ledger that spans the 2021–22 shipping super-cycle, so trailing averages
can sit several times above a position's latest 12-month payout — in the audit, one shipping holding's
5-year figure was roughly five times its 12-month figure, and another paid nothing in the window. Averaging a one-off cycle into a "yield" is a
distortion, not a smoothing, and it mis-ranks `yieldProtect` — which is the strategy whose entire job is
knowing which income is worth keeping.

The window is therefore selectable (5-year / 3-year / latest 12 months) and drives **every** yield
surface at once: the detail-table column, `yieldProtect`'s ordering, and `summarize`'s
`annualDividendGivenUp`. Default stays 5 for continuity with saved scenarios. A non-positive or
non-numeric `years` falls back to 5 rather than dividing by zero.

Changing the window does **not** invalidate a custom plan (unlike a lock change, SP-17): only the yield
figures move, and the hand-entered share counts remain well defined.

**This narrows but does not remove the SP-3 approximation.** A shorter window still measures dividends
received against the share count held *then*, and a single missed or shifted payment date swings a
12-month figure hard. Both windows stay labelled approximate. Neither is a forecast: the dashboard reports
what was actually paid over a chosen past window, and says which window it used.

---


### C.10 Scenarios synced to the Sheet (Rev 4.2, approved 2026-09-10)

Scenarios move from per-browser `localStorage` to a `SellPlans` tab in the owner's Sheet, so a plan saved
on one device is visible on all of them. This adds the **first write path** to a backend that was
read-only through Rev 4.1, so its contract is deliberately narrow.

**SP-19 — Write confinement.** `doPost` can write to exactly one tab, `SellPlans` (created on first save,
header `id | savedAt | name | scenario`). No code path lets a request name a different tab; the ledger
tabs stay read-only by construction. One row per scenario, upserted by `id`; `scenario` holds the full
validated JSON and is the authoritative column — the other three are for a human reading the Sheet.
`GET ?resource=sellplans` returns the parsed list, skipping (never failing on) a row hand-edited into
invalid JSON. Delete of an unknown id is a harmless no-op. Writes serialise on `LockService`.

**SP-20 — Validation and bounds.** Key compared against the `API_KEY` script property, sent in the **POST
body, never the URL**. Body ≤ 20,000 chars and valid JSON. `id` matches `[A-Za-z0-9_-]{1,64}`; `name`
1–80 chars; `savedAt` a parseable date; `strategyId` one of the five plan ids; ≤ 60 `rows`, each an
integer `sellShares` in [0, 1e8]; ≤ 60 `locked`; `note` ≤ 500. At most 200 stored scenarios (updating an
existing one is always allowed). Every display cell is written with a leading apostrophe so a name like
`=IMPORTXML(…)` is stored as text, never evaluated as a formula.

**SP-21 — Client sync.** Live mode (Apps Script source) uses `SheetScenarioStore`; offline mode keeps
`localStorage`. Writes are `text/plain` POSTs with no custom headers — a CORS "simple request", because
Apps Script cannot answer a preflight. If the Sheet is unreachable on save, the scenario is kept in this
browser and the UI says so rather than failing silently. On the first successful live load, scenarios
that exist only in this browser's `localStorage` are uploaded once (a flag prevents a later re-upload
from resurrecting a scenario deleted elsewhere); **local copies are left in place as a backup.**

**SP-22 — Deployment invariants** (`gas/deploy.mjs`). (1) The live `/exec` URL never changes: the
existing deployment id (read from `config.js`) is updated to a new version; a new deployment is never
created, since a new URL would break every browser holding the old one. (2) Before any push, the live
project is cloned into `backups/gas-<timestamp>/` with its deployment and version lists. (3) The live
`Code.js` must equal the last committed `gas/Code.js` (tag `pre-rev4.2-backup`); if it differs, the
script was edited online and pushing would erase that work — **abort, push nothing**. Time-driven
triggers run the editor's HEAD code, not the deployed version, which is why this check guards the daily
snapshot too. (4) The live `appsscript.json` is reused verbatim, so timezone and web-app access settings
cannot drift. (5) After redeploy the endpoint is verified end to end — ledger reads match the pre-deploy
baseline, save → list → delete round-trips, a wrong key is refused — and on any failure the deployment
is automatically re-pointed at the previous version. `config.js` values are read, never printed.

| Code | Trigger |
|---|---|
| `E_SCENARIO_SYNC` | The Sheet store is unreachable, returns non-2xx, or reports `upstream`. |
| `E_SCENARIO_REJECTED` | The server refused the payload as `bad_request` (validation or bound, SP-20). |

---

## Verified figures (offline, from current ledger)
| Quantity | Value |
|---|---|
| Invested capital (Σ CD轉入) | NT$ 2,249,946 |
| Cost of current holdings (Σ 目前投資金額) — **ROI base** | NT$ 2,677,525 |
| Dividends total (股息) | NT$ 520,609 |
| Current holdings | 46 tickers, 0 negative |
| Data-review lots (null shares) | 14 (友達/長榮/仲琦/京元電子) |
*(ROI / XIRR / current value require live `GOOGLEFINANCE` prices — computed at runtime.)*

## Requirements → contract trace (forward)
| Requirement | Covered by |
|---|---|
| Portfolio value historically | MET-9, A.5 (historical prices), L4 |
| Dividends each year | MET-8, A.1 |
| Performance: ROI / CAGR / IRR | MET-5 (ROI), MET-7+CF-2 (simple CAGR), MET-6+CF-1 (XIRR) |
| Stock value = 股數 × price; cost = 目前投資金額 | MET-4 (value w/ live price), MET-2 (cost) |
| Invested cost = CD轉入 | MET-3, CF-1 |
| Google Sheet dataset + API transfer | A.4 `AppsScriptSource`, A.6, B.3.1 |
| Live market prices | A.5, `GOOGLEFINANCE` |
| GitHub frontend, private | B.1 hosting, B.3.1/B.3.3 |

## Definition of Done (Phase 1)
- [x] Contracts (A) + Blueprint (B) written; lot-based schema per user
- [x] Every requirement maps to a contract clause (trace table)
- [x] Stack pinned (B.1)
- [x] Error taxonomy closed (A.7)
- [x] Security & logic signals flagged (B.5)
- [ ] **User explicitly approves** ← gate to Phase 2
