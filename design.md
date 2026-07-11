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

Deposit = {                 // 項目="CD轉入" — invested capital injected into the account
  date: string   amount: number   // >0 (存入)
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
  - **Deposit** ⇔ `項目 == "CD轉入"`; `amount=存入`.
  - **Trade(buy)** ⇔ `項目=="轉帳支取"` & `股票` set & `!= "股息"`; `amount=支出`. **Trade(sell)** ⇔ `項目=="轉帳存入"` & `股票` set & `!= "股息"`; `amount=存入`.
  - All other rows (interest, tax, 減資退款, 退綜所稅, cash withdrawals) excluded.
- **Invariants:** DX-1 every record conforms to A.0; DX-2 `Σ Dividend.amount == Σ 存入 where 股票=股息`; DX-3 no `Trade`/`HeldLot` has `ticker=="股息"`; DX-4 `Σ HeldLot.cost == Σ 目前投資金額 over Y rows`.

### A.2 Metrics engine (core — highest correctness bar)
Pure functions, no I/O.

| Fn | Signature | Definition / invariant |
|---|---|---|
| `currentHoldings` | `(HeldLot[]) -> {ticker: {shares, cost}}` | **MET-1:** per ticker, `shares=Σ lot.shares`, `cost=Σ lot.cost`. Lots with `shares==null` excluded from `shares` and surfaced for review. Result shares ≥ 0 by construction (sold lots aren't `Y`). |
| `costOfHoldings` | `(HeldLot[]) -> number` | **MET-2:** `Σ HeldLot.cost` (= 目前投資金額). **This is the ROI denominator.** |
| `investedCapital` | `(Deposit[]) -> number` | **MET-3:** `Σ Deposit.amount` (= CD轉入 total). |
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
