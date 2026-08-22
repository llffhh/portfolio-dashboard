# Changelog

## [Unreleased] — Portfolio Dashboard MVP

Built under the Universal SDLC (Standard tier). Source ledger: `股票 2023.xlsx`.

### Added
- **Metrics engine** (`src/metrics.js`): `currentHoldings`, `costOfHoldings`, `investedCapital`, `currentValue`, `roi`, `xirr` (Newton-Raphson), `simpleCagr`, `dividendsByYear`, `portfolioValueOverTime`, `buildXirrCashflows`.
- **Pluggable sources**: `LocalJsonSource`/`MockPriceSource` (offline) and `AppsScriptSource`/`AppsScriptPriceSource` (live) behind `DataSource`/`PriceSource` interfaces.
- **Dashboard UI** (`index.html`, `src/app.js`): portfolio value over time, dividends per year, holdings table, metrics card. Chart.js. GitHub-Pages servable.
- **Google Apps Script API** (`gas/Code.js`): `doGet` serving `heldlots|trades|deposits|dividends|prices`; owner-only access check; ticker validation (`^\d{4}$`, ≤50).
- **Data extraction** (`extract.py`): flattens `股票明細` into the lot-based schema → `data/*.json` + `portfolio_normalized.xlsx` (HeldLots/Trades/Deposits/Dividends/Prices) for Google Sheets import.
- Test suite (Vitest): 17 tests; every error-taxonomy code covered.

### Security / privacy
- Apps Script gated to owner email (`OWNER_EMAIL` script property); deploy "Execute as me / Anyone with a Google account".
- `config.js` (Web App URL) gitignored; only `config.example.js` (placeholder) committed. No private data in the repo.

### Fixed (Phase 3 audit)
- `.gitignore` rewritten UTF-8 (was UTF-16 → git couldn't parse it).
- Real per-record schema validation for `E_DATA_PARSE`; added `E_XIRR_NO_CONVERGE` test.
- `extract.py` no longer emits invalid JSON: skips a corrupt 威剛 row (2023-12-12, mis-recorded `轉帳存入`) and uses `allow_nan=False`.

### Deployment (2026-07-10) — live on Google Apps Script (v3)
- **Security model changed to secret API key** (`API_KEY` script property + gitignored `config.js`): Apps Script cannot serve Google-sign-in-gated cross-origin `fetch()` (CORS), so the owner-email gate was replaced by a 48-char token gate; deployed "Execute as me / Anyone". `design.md` §A.6/B.3.1 updated (rev 3.1).
- Fixed GAS `getPricesFromSheet`: timezone fallback (`getSpreadsheetTimeZone()` returns null on xlsx-converted sheets); prices keyed by ticker name with `price` column served under today's date; ticker validation accepts names or codes (≤20 chars, ≤50).
- Fixed `app.js`: request live prices only for currently-held tickers (46) to stay under the 50-ticker cap; cache-busted module URL.
- Live E2E verified: unauthorized without key; 198 lots / 356 trades / 70 deposits / 169 dividends served; live GOOGLEFINANCE prices; dashboard renders ROI 123.73%, XIRR 19.35%, CAGR 10.83% on real data.

### Known data items (fix in the source sheet)
- 14 held lots with blank `股數` (京元電子/仲琦/友達/長榮) — surfaced in the dashboard's data-review notice, not valued.
- 7 held tickers need TWSE codes for live pricing (台達電/康舒/星宇航空/晶心科/晶電/瑞昱/華邦電).

### Published (2026-07-10) — GitHub Pages
- Live at https://llffhh.github.io/portfolio-dashboard/ (repo: llffhh/portfolio-dashboard, public).
- Key-entry model: no secret in the repo; `src/settings.js` resolves config from gitignored `config.js` (dev) or browser localStorage via an in-page setup form (Pages). Verified on the live site: setup form → key saved → real data renders (ROI 123.73%, XIRR 19.35%).
- `.gitignore` hardened: real data (`data/`, xlsx, csv, root json), `config.js`, and local tooling excluded; verified nothing sensitive in the initial commit; `config.js` returns 404 on the live site.

### Rev 3.2 (2026-07-11) — yesterday value, yearly capital, yearly P/L
- New cards: Current Value + Yesterday Close Value with ▲/▼ delta (GOOGLEFINANCE `closeyest` column, MET-10).
- New charts: Invested Capital per Year with cumulative overlay (MET-11); Yearly P/L excluding dividends = V(y)−V(y−1)−invested(y) (MET-12).
- Historical value chart now populated: year-end close columns (last trading day ≤ Dec 31, 2017–2025) added to the Prices tab; portfolio line runs 2017→today.
- Fixes: client normalizes raw GAS date keys (V8 `instanceof Date` unreliable — duck-typed fix also in gas/Code.js for next redeploy); current-price lookups keyed to the sheet's timezone date, not client UTC; internal ES-module imports version-tagged to bust browser module cache.
- 21 tests pass. Known caveat: early-year values slightly understated where sold/delisted tickers lack GOOGLEFINANCE history (surfaced in review notice).

### Rev 3.4 (2026-08-11) — re-normalized ledger, Cost of Holdings card, CD轉出 withdrawals
- Re-ran `extract.py` on the updated `股票 2023.xlsx`: 191 held lots (46 tickers), 369 trades, 79 deposits, 190 dividends. **Both prior data-quality gaps closed by the user** — 0 null-share lots (was 1) and 0 held tickers missing a TWSE code.
- **New card: Cost of Holdings** (Σ HeldLot.cost = Σ `目前投資金額` = NT$2,976,826), labeled as the ROI denominator so it reads distinctly from Invested Capital. Chart and its title deliberately left unchanged.
- **`extract.py` now handles `CD轉出`** (cash leaving the account, 台新銀行轉國泰世華) as a negative deposit — previously ignored entirely, overstating invested capital by NT$238,800. A `CD轉出` carrying `股數` is money spent buying stock, mis-tagged in the ledger (2023-06-05 星宇航空, 137 shares) — an investment, not a withdrawal — and is excluded. Deposits: 76 rows / NT$2,401,730 → **79 rows / NT$2,162,930**, reconciling exactly with the live sheet's Deposits tab (no re-import needed).
- Live cards after the change: Current Value 7,964,823 · Invested 2,162,930 · Cost of Holdings 2,976,826 · Dividends 589,945 · ROI 187.38% · XIRR 25.89% · Simple CAGR 15.39%.
- Known open: 3 金像電 2020 trades still have blank `股數` (2020-04-01 / 04-10 / 06-17), so the historical chart holds that position flat through 2020–2021; the 2023-06-05 星宇航空 row has `尚未交易 = Y` and 137 shares but a blank `股票`, so it never becomes a HeldLot. Some `CD轉入` rows tagged 國泰世華銀行轉入 are transfers back from the second broker rather than new outside capital — deferred by decision, still counted as capital.

### Daily snapshot: stamp the trading session, not the run date (pending redeploy)
- `recordDailySnapshot` stamped rows with `new Date()`, so a run before TWSE's 13:30 close wrote the *previous* session's close under today's date. Symptom: the daily chart's 2026-08-21 point (8,063,964) equalled the dashboard's **Yesterday** card rather than Friday's actual close (8,052,548), with duplicate weekday values across the series.
- New `getLastTradeSession_()` probes Yahoo for 2330 and derives the session date from `meta.regularMarketTime` — the feed's own timestamp — since GOOGLEFINANCE returns a bare number with no session attached. Rows are upserted on that date, making re-runs idempotent.
- Mid-session guard uses the timestamp's time-of-day (`>= 13:30` = closed). Yahoo's **chart** endpoint does not return `marketState` (that field is on the *quote* endpoint), so an earlier `marketState === 'REGULAR'` check was dead code and never fired.
- Falls back to the run date if the probe fails (degrades to the old behaviour, not to no data). Duck-typed the `instanceof Date` check while in the file.
- New `setupDailySnapshotTrigger()` installs a daily 18:00–19:00 trigger (deleting any existing one first) and logs `Session.getScriptTimeZone()` — triggers fire in the **script project's** timezone, which must be Asia/Taipei.
- `backfillDailySnapshots()` default start is now a **trailing 365-day window** instead of 3 months, and both it and the prune derive from one `HISTORY_WINDOW_DAYS` constant — previously the backfill (3 months) and the prune (365 rows) disagreed silently, so the chart never filled its own window. One run now produces exactly 365 rows and the prune trims none of them. Accepts a number (months, legacy) or a 'YYYY-MM-DD' start.
- Full-history (2017→) backfill considered and rejected for now: ~3,440 rows would be deleted by the prune, the inner loop would likely exceed the 6-minute limit, and 15 of 78 traded tickers have no price — early years would read misleadingly low, the Rev 3.3 failure again. Over a 365-day window only 太極 is unpriced (not a current holding; ~NT$10–14k for ~4 months, <0.2%).
- **DailyHistory was low by ~NT$1.22M on every point.** The backfill rebuilt each day's position by replaying Trades forward from zero, but the Trades sheet does not reconcile with HeldLots — 欣興 (1,000 shares, −1,085,000) and 威剛 (500, −211,250) net to zero from trades though both are held, while 宏碁/統懋/錦明/鴻海 show 1,000 shares from trades that are no longer held. Net −1,220,024, applied to **every** day equally.
  Reconstruction now walks **backwards from HeldLots**, undoing each trade as it steps past that date: today is exact by construction (verified 8,052,548 = the cards) and any ledger gap is confined to days before the trade it belongs to. Also removes the O(days × trades) inner loop.
- `getCurrentHoldings_()` shared by the snapshot and the backfill; trims ticker whitespace (the ledger contains '台積電 '), which the snapshot previously did not.
- `getPricesFromSheet` defaults its `tickers`/`dates` arguments so running it from the editor returns everything instead of throwing on `undefined.length`.
- **Not deployed.** Live Apps Script is still v3 (built from `e911e89`); the repo is ~414 lines ahead, so redeploying also ships `GET_TAIWAN_STOCK_PRICE`, the snapshot/backfill functions, and the `getPricesFromSheet` date fix.

### Rev 3.3 (2026-08-11) — complete price coverage + trustworthy history start
- **Fixed root cause of wrong early years:** the Prices tab only held *currently-owned* tickers, but the history chart reconstructs past positions from Trades — so every stock already sold (台積電, 鴻海, 友訊, 撼訊, 尼克森, 康那香, 力旺, 泰碩, 東元, 宏碁, 波若威, 車王電, 統懋, 華冠, 錦明, 國產, 花王, 金寶…) had no price and silently vanished from past values. `extract.py` now emits a price row for **every ticker ever traded**; 33 rows appended to the live sheet + 晶電's code filled.
  Effect: 2017 year-end value corrected 28,400 → **376,900**; 2019 115,560 → **994,883**.
- **Fixed ticker whitespace bug:** the ledger contains `'台積電 '` / `'穩懋 '` with trailing spaces, which split one holding into two and broke code lookup. Normalized in `extract.py` and in both data sources (`normalizeRecords`, A.0).
- **History now starts only when fully priced (MET-9a):** year-ends where any held stock lacks a price are dropped from the front of the series instead of being charted as misleading lows; later partly-priced years are charted but named in the review notice.
- App requests **all** price rows (empty ticker list) rather than only current holdings, so sold tickers are priced.
- 23 tests pass (added `normalizeRecords` + end-to-end trim coverage).
- Remaining unpriced (<1% of value, flagged in-app): 太極 and 聯亞藥 (no TWSE code known — codes not in the dividend records), 晶電 (delisted, merged into 富采), 波若威 2025 only.
