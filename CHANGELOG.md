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
