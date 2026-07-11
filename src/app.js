import { LocalJsonSource, MockPriceSource } from './data.js?v=32';
import { AppsScriptSource, AppsScriptPriceSource } from './api.js?v=32';
import { getConfig, saveConfig } from './settings.js?v=32';
import {
  currentHoldings, costOfHoldings, investedCapital, currentValue,
  roi, xirr, simpleCagr, dividendsByYear, depositsByYear, yearlyPnL,
  portfolioValueOverTime, buildXirrCashflows
} from './metrics.js?v=32';

// Shares held per ticker as of a date (tolerant app-side variant of MET-9's
// reconstruction — missing prices are skipped and surfaced, not thrown).
function holdingsAt(trades, dateStr) {
  const t = new Date(dateStr).getTime();
  const pos = {};
  for (const tr of trades) {
    if (new Date(tr.date).getTime() > t || tr.shares == null) continue;
    pos[tr.ticker] = (pos[tr.ticker] || 0) + (tr.type === 'buy' ? tr.shares : -tr.shares);
  }
  return pos;
}

function valueAt(trades, priceMap, dateStr, missing) {
  const pos = holdingsAt(trades, dateStr);
  let total = 0, priced = 0;
  for (const [ticker, shares] of Object.entries(pos)) {
    if (shares <= 0) continue;
    const p = priceMap[ticker]?.[dateStr];
    if (p == null) { missing?.add(ticker); continue; }
    total += shares * p;
    priced++;
  }
  return priced > 0 ? total : null;
}

// Config comes from gitignored config.js (dev) or localStorage (Pages) — see settings.js.
// With config → live Apps Script; without → offline data/ preview if present, else setup form.
function showSetupForm() {
  const panel = document.getElementById('setup-panel');
  panel.style.display = 'block';
  document.getElementById('setup-save').addEventListener('click', () => {
    const url = document.getElementById('setup-url').value;
    const key = document.getElementById('setup-key').value;
    if (url && key) { saveConfig(url, key); window.location.reload(); }
  });
}

async function init() {
  const cfg = await getConfig();
  let dataSource, priceSource;
  if (cfg) {
    dataSource = new AppsScriptSource(cfg);
    priceSource = new AppsScriptPriceSource(cfg);
  } else {
    const probe = await fetch('data/held_lots.json', { method: 'HEAD' }).catch(() => null);
    if (probe && probe.ok) {
      dataSource = new LocalJsonSource('data');
      priceSource = new MockPriceSource('data');
    } else {
      showSetupForm();
      return;
    }
  }

  try {
    const [lots, trades, deposits, divs] = await Promise.all([
      dataSource.loadHeldLots(),
      dataSource.loadTrades(),
      dataSource.loadDeposits(),
      dataSource.loadDividends()
    ]);

    const { holdings, reviewLots } = currentHoldings(lots);
    const cost = costOfHoldings(lots);
    const invested = investedCapital(deposits);
    
    // Build array of all tickers held historically or currently for pricing
    const allTickers = new Set([...Object.keys(holdings), ...trades.map(t => t.ticker)]);
    
    // Find earliest deposit for simple CAGR
    const firstDepositDate = deposits.length ? [...deposits].sort((a,b) => new Date(a.date) - new Date(b.date))[0].date : new Date().toISOString();
    
    // Find all unique dates for portfolioValueOverTime
    const endOfYears = [...new Set(divs.map(d => `${d.date.substring(0, 4)}-12-31`))];
    const today = new Date().toISOString().split('T')[0];
    const dates = [...new Set([...endOfYears, today])].sort();

    // Request prices only for currently-held tickers (≤50 cap, design A.6);
    // omit the dates filter so all available columns (today + any year-ends) return.
    const priceMap = await priceSource.getPrices(Object.keys(holdings));

    // The sheet's "current price" is keyed by ITS timezone's today (Asia/Taipei),
    // which can differ from the client's UTC date — use the latest date key served.
    const servedDates = [...new Set(Object.values(priceMap).flatMap(m => Object.keys(m)))]
      .filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    const priceToday = servedDates[servedDates.length - 1] || today;

    // Filter review lots (null shares) and missing prices
    const noPriceTickers = new Set();
    let currentVal = 0;
    let yesterdayVal = 0;          // MET-10: previous trading-day close ('closeyest')
    let hasYesterday = false;

    for (const [ticker, data] of Object.entries(holdings)) {
      const price = priceMap[ticker]?.[priceToday];
      if (price === undefined || price === null) {
        noPriceTickers.add(ticker);
      } else {
        currentVal += data.shares * price;
      }
      const yPrice = priceMap[ticker]?.['closeyest'];
      if (yPrice != null) {
        yesterdayVal += data.shares * yPrice;
        hasYesterday = true;
      }
    }

    const totalDivs = divs.reduce((sum, d) => sum + d.amount, 0);

    // Show notices
    if (reviewLots.length > 0 || noPriceTickers.size > 0) {
      const notice = document.getElementById('review-notice');
      const list = document.getElementById('review-list');
      notice.classList.add('visible');
      if (reviewLots.length > 0) {
        const nullShareTickers = [...new Set(reviewLots.map(l => l.ticker))].join(', ');
        list.innerHTML += `<li>Lots with null shares (excluded from valuation): ${nullShareTickers}</li>`;
      }
      if (noPriceTickers.size > 0) {
        list.innerHTML += `<li>Held tickers with no price for today (excluded from valuation): ${[...noPriceTickers].join(', ')}</li>`;
      }
    }

    // Since E_NO_PRICE and E_DATA_PARSE would crash if we blindly call functions,
    // we only pass holdings that have valid data to metric functions.
    const validHoldings = {};
    for (const [t, d] of Object.entries(holdings)) {
      if (!noPriceTickers.has(t)) validHoldings[t] = d;
    }

    document.getElementById('val-invested').innerText = invested.toLocaleString();
    document.getElementById('val-dividends').innerText = totalDivs.toLocaleString();

    // MET-10 cards: current value, yesterday close value, delta
    document.getElementById('val-current').innerText = Math.round(currentVal).toLocaleString();
    if (hasYesterday) {
      document.getElementById('val-yesterday').innerText = Math.round(yesterdayVal).toLocaleString();
      const delta = currentVal - yesterdayVal;
      const el = document.getElementById('val-delta');
      el.innerText = `${delta >= 0 ? '▲' : '▼'} ${Math.abs(Math.round(delta)).toLocaleString()} (${yesterdayVal ? (delta / yesterdayVal * 100).toFixed(2) : '0.00'}%)`;
      el.style.color = delta >= 0 ? '#dc2626' : '#16a34a';  // TW convention: red up, green down
    } else {
      document.getElementById('val-yesterday').innerText = 'N/A';
    }

    let computedRoi = 0;
    try { computedRoi = roi(currentVal, totalDivs, cost); } catch(e) {}
    document.getElementById('val-roi').innerText = (computedRoi * 100).toFixed(2) + '%';

    let computedXirr = 0;
    try {
      const flows = buildXirrCashflows(deposits, divs, [], currentVal, today);
      computedXirr = xirr(flows);
    } catch(e) {}
    document.getElementById('val-xirr').innerText = (computedXirr * 100).toFixed(2) + '%';

    let computedCagr = 0;
    try {
      const years = (new Date(today) - new Date(firstDepositDate)) / (1000 * 60 * 60 * 24 * 365.25);
      computedCagr = simpleCagr(invested, currentVal + totalDivs, years);
    } catch(e) {}
    document.getElementById('val-cagr').innerText = (computedCagr * 100).toFixed(2) + '%';

    // Charts
    const divByYear = dividendsByYear(divs);
    new Chart(document.getElementById('divChart'), {
      type: 'bar',
      data: {
        labels: Object.keys(divByYear),
        datasets: [{
          label: 'Dividends',
          data: Object.values(divByYear),
          backgroundColor: '#3b82f6'
        }]
      }
    });

    // Year-end value series from the Prices tab's date columns (rev 3.2) —
    // tolerant: tickers with no historical price at a date are skipped + surfaced.
    const histMissing = new Set();
    const yearEndDates = servedDates.filter(k => k !== priceToday);

    const series = [];
    const valueByYear = {};
    for (const d of yearEndDates) {
      const v = valueAt(trades, priceMap, d, histMissing);
      if (v !== null) { series.push({ date: d, value: v }); valueByYear[d.substring(0, 4)] = v; }
    }
    if (currentVal > 0) {
      series.push({ date: priceToday, value: currentVal });
      valueByYear[priceToday.substring(0, 4)] = currentVal;
    }

    if (histMissing.size > 0) {
      document.getElementById('review-notice').classList.add('visible');
      document.getElementById('review-list').innerHTML +=
        `<li>No historical price for some year-ends (those tickers excluded from past values): ${[...histMissing].join(', ')}</li>`;
    }

    try {
      new Chart(document.getElementById('valueChart'), {
        type: 'line',
        data: {
          labels: series.map(d => d.date),
          datasets: [{
            label: 'Portfolio Value',
            data: series.map(d => d.value),
            borderColor: '#10b981',
            tension: 0.1,
            fill: false
          }]
        }
      });
    } catch (e) {
      console.warn("Could not render value chart", e);
    }

    // MET-11: invested capital per year + cumulative overlay
    try {
      const invByYear = depositsByYear(deposits);
      const invYears = Object.keys(invByYear).sort();
      let running = 0;
      const cumulative = invYears.map(y => (running += invByYear[y]));
      new Chart(document.getElementById('investedChart'), {
        data: {
          labels: invYears,
          datasets: [
            { type: 'bar', label: 'Invested that year', data: invYears.map(y => invByYear[y]), backgroundColor: '#6366f1' },
            { type: 'line', label: 'Cumulative capital', data: cumulative, borderColor: '#f59e0b', tension: 0.1 }
          ]
        }
      });

      // MET-12: yearly P/L excluding dividends (current year = YTD, uses live value)
      const pnl = yearlyPnL(valueByYear, invByYear);
      const pnlYears = Object.keys(pnl).sort();
      new Chart(document.getElementById('pnlChart'), {
        type: 'bar',
        data: {
          labels: pnlYears.map(y => y === priceToday.substring(0, 4) ? `${y} YTD` : y),
          datasets: [{
            label: 'P/L (excl. dividends)',
            data: pnlYears.map(y => pnl[y]),
            backgroundColor: pnlYears.map(y => pnl[y] >= 0 ? '#dc2626' : '#16a34a')
          }]
        }
      });
    } catch (e) {
      console.warn("Could not render yearly charts", e);
    }

    // Table
    const tbody = document.querySelector('#holdingsTable tbody');
    for (const [ticker, data] of Object.entries(holdings)) {
      const price = priceMap[ticker]?.[priceToday];
      const val = price ? (data.shares * price) : 0;
      const plPct = data.cost > 0 && price ? ((val - data.cost) / data.cost) * 100 : 0;
      const plColor = plPct >= 0 ? '#dc2626' : '#16a34a';
      const plText = price ? `<span style="color: ${plColor}; font-weight: 600;">${plPct >= 0 ? '▲' : '▼'} ${Math.abs(plPct).toFixed(2)}%</span>` : 'N/A';
      
      tbody.innerHTML += `
        <tr>
          <td>${ticker}</td>
          <td>${data.shares.toLocaleString()}</td>
          <td>${data.cost.toLocaleString()}</td>
          <td>${price ? val.toLocaleString() : 'N/A'}</td>
          <td>${plText}</td>
        </tr>
      `;
    }

  } catch (err) {
    console.error("Dashboard Init Error", err);
    document.body.innerHTML += `<div style="color:red; padding: 20px;">Error loading dashboard: ${err.message}</div>`;
  }
}

init();
