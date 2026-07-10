# Deployment Runbook — Portfolio Dashboard

Four steps. Steps 1–2 need your Google account; step 4 needs your GitHub account. I'll guide each.

## Step 1 — Google Sheet (the dataset)
1. Go to https://sheets.google.com → **Blank** → name it e.g. `Portfolio`.
2. **File ▸ Import ▸ Upload** → drop `portfolio_normalized.xlsx` → **Insert new sheet(s)**. You'll get 5 tabs: `HeldLots`, `Trades`, `Deposits`, `Dividends`, `Prices`.
3. On the **Prices** tab, fill the 7 missing 4-digit TWSE codes in the `code` column:
   台達電→2308, 瑞昱→2379, 華邦電→2344, 晶電→2448, 康舒→6282, 晶心科→6533, 星宇航空→2646.
   The `price` cell already holds `=IFERROR(GOOGLEFINANCE("TPE:"&code),"")` — it will light up once the code is present.
4. (For the historical value chart) add year-end columns to `Prices`, e.g. header `2023-12-31` with
   `=IFERROR(INDEX(GOOGLEFINANCE("TPE:"&$B2,"close",DATE(2023,12,31)),2,2),"")` per row/year you want.

## Step 2 — Apps Script (the API)
1. In the Sheet: **Extensions ▸ Apps Script**.
2. Replace the default code with the contents of `gas/Code.js`. Save.
3. **Project Settings ▸ Script Properties ▸ Add**: name `OWNER_EMAIL`, value = your Google email.
4. **Deploy ▸ New deployment ▸ Web app**: *Execute as* **Me**, *Who has access* **Anyone with a Google account**. Deploy, authorize, and **copy the `/exec` URL**.

## Step 3 — Wire the URL
- Put the `/exec` URL into `config.js`:
  `export const WEBAPP_URL = "https://script.google.com/macros/s/AKfy.../exec";`
- The app auto-switches to live mode when this is a real URL (else it shows the offline preview from `data/`).
- **Privacy note:** your data is protected by the `OWNER_EMAIL` check in `gas/Code.js` (only you, signed into Google, get data; everyone else gets `unauthorized`). The URL itself grants nothing. Decide at step 4 whether to commit `config.js` (currently gitignored).

## Step 4 — Git + GitHub Pages (the frontend)
1. `git init && git add -A && git commit -m "Portfolio dashboard MVP"`
2. Create a GitHub repo, push.
3. **Settings ▸ Pages** → deploy from branch (root). Your dashboard is live at `https://<you>.github.io/<repo>/`.
4. If you want the live data to work on Pages, `config.js` must be present there — either commit it (safe, because data is owner-gated) or keep the repo private.

## Verify
Open the Pages URL while signed into Google as the owner → holdings, dividends-by-year, metrics, and the historical value line should all populate from live prices.
