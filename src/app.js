import { LocalJsonSource, MockPriceSource } from './data.js?v=32';
import { AppsScriptSource, AppsScriptPriceSource, normalizeDateKey } from './api.js?v=32';
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

// Value of the reconstructed position at a date, plus which held tickers had
// no price there. `complete` = every held ticker priced, i.e. the figure is
// trustworthy rather than silently understated.
function valueAt(trades, priceMap, dateStr, missing) {
  const pos = holdingsAt(trades, dateStr);
  let total = 0, priced = 0;
  const gaps = [];
  for (const [ticker, shares] of Object.entries(pos)) {
    if (shares <= 0) continue;
    const p = priceMap[ticker]?.[dateStr];
    if (p == null) { missing?.add(ticker); gaps.push(ticker); continue; }
    total += shares * p;
    priced++;
  }
  return { value: priced > 0 ? total : null, complete: priced > 0 && gaps.length === 0, gaps };
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

    let dailyHistory = [];
    try {
      dailyHistory = await dataSource.loadDailyHistory();
    } catch (e) {
      console.warn("Could not load daily history", e);
    }

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
    // Fetch EVERY price row (empty ticker list = all): the historical chart
    // reconstructs past positions from Trades, so it needs prices for tickers
    // already sold, not just current holdings.
    const priceMap = await priceSource.getPrices([]);

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
    document.getElementById('val-cost').innerText = cost.toLocaleString();
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
    // The history only starts once EVERY stock held at that date has a price —
    // earlier year-ends would silently understate the portfolio, so they are
    // dropped rather than charted as misleading lows.
    const histMissing = new Set();
    const yearEndDates = servedDates.filter(k => k !== priceToday);

    const evaluated = yearEndDates.map(d => ({ date: d, ...valueAt(trades, priceMap, d, null) }));
    const startIdx = evaluated.findIndex(e => e.complete);
    const skipped = startIdx === -1 ? evaluated : evaluated.slice(0, startIdx);
    const usable = startIdx === -1 ? [] : evaluated.slice(startIdx);

    const series = [];
    const valueByYear = {};
    const partialYears = [];
    for (const e of usable) {
      if (e.value === null) continue;
      e.gaps.forEach(t => histMissing.add(t));
      if (!e.complete) partialYears.push(e.date.substring(0, 4));
      series.push({ date: e.date, value: e.value });
      valueByYear[e.date.substring(0, 4)] = e.value;
    }
    if (currentVal > 0) {
      series.push({ date: priceToday, value: currentVal });
      valueByYear[priceToday.substring(0, 4)] = currentVal;
    }

    const notice = (msg) => {
      document.getElementById('review-notice').classList.add('visible');
      document.getElementById('review-list').innerHTML += `<li>${msg}</li>`;
    };
    if (skipped.length > 0) {
      notice(`History starts ${series.length ? series[0].date.substring(0, 4) : '—'}: earlier year-ends `
        + `(${skipped.map(e => e.date.substring(0, 4)).join(', ')}) are hidden because some stocks held then have no price`
        + ` (${[...new Set(skipped.flatMap(e => e.gaps))].join(', ')}).`);
    }
    if (partialYears.length > 0) {
      notice(`Partly-priced year-ends (values slightly understated): ${partialYears.join(', ')}`
        + ` — missing ${[...histMissing].join(', ')}.`);
    }

    const yearlySeries = series;
    const dailySeries = (dailyHistory && dailyHistory.length > 0)
      ? dailyHistory.map(d => ({ date: normalizeDateKey(d.date), value: Number(d.value) })).sort((a, b) => new Date(a.date) - new Date(b.date))
      : [];

    let valueChartInstance = null;
    try {
      valueChartInstance = new Chart(document.getElementById('valueChart'), {
        type: 'line',
        data: {
          labels: yearlySeries.map(d => d.date),
          datasets: [{
            label: 'Portfolio Value',
            data: yearlySeries.map(d => d.value),
            borderColor: '#10b981',
            tension: 0.1,
            fill: false
          }]
        }
      });
    } catch (e) {
      console.warn("Could not render value chart", e);
    }

    const btnYearly = document.getElementById('toggle-yearly');
    const btnDaily = document.getElementById('toggle-daily');

    if (dailySeries.length === 0) {
      btnDaily.disabled = true;
      btnDaily.style.opacity = '0.3';
      btnDaily.title = 'No daily history found. Run backfillDailySnapshots in Apps Script.';
    } else {
      btnDaily.addEventListener('click', () => {
        btnYearly.classList.remove('active');
        btnDaily.classList.add('active');
        if (valueChartInstance) {
          valueChartInstance.data.labels = dailySeries.map(d => d.date);
          valueChartInstance.data.datasets[0].data = dailySeries.map(d => d.value);
          valueChartInstance.update();
        }
      });
      btnYearly.addEventListener('click', () => {
        btnDaily.classList.remove('active');
        btnYearly.classList.add('active');
        if (valueChartInstance) {
          valueChartInstance.data.labels = yearlySeries.map(d => d.date);
          valueChartInstance.data.datasets[0].data = yearlySeries.map(d => d.value);
          valueChartInstance.update();
        }
      });
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

    makeTableSortable('holdingsTable');

  } catch (err) {
    console.error("Dashboard Init Error", err);
    document.body.innerHTML += `<div style="color:red; padding: 20px;">Error loading dashboard: ${err.message}</div>`;
  }
}

function makeTableSortable(tableId) {
  const table = document.getElementById(tableId);
  if (!table) return;
  const headers = table.querySelectorAll('thead th');
  const tbody = table.querySelector('tbody');
  if (!tbody) return;
  
  let currentSortCol = -1;
  let isAsc = true;
  
  headers.forEach((header, index) => {
    header.style.cursor = 'pointer';
    header.style.userSelect = 'none';
    
    header.addEventListener('click', () => {
      const rows = Array.from(tbody.querySelectorAll('tr'));
      if (rows.length === 0) return;
      
      if (currentSortCol === index) {
        isAsc = !isAsc;
      } else {
        isAsc = true;
        currentSortCol = index;
      }
      
      // Reset indicators on other headers
      headers.forEach(h => h.innerHTML = h.innerHTML.replace(/ [▲▼]$/, ''));
      header.innerHTML += isAsc ? ' ▲' : ' ▼';
      
      rows.sort((rowA, rowB) => {
        if (!rowA.cells[index] || !rowB.cells[index]) return 0;
        const cellA = rowA.cells[index].innerText;
        const cellB = rowB.cells[index].innerText;
        
        const clean = str => {
          let val = str.replace(/[,\s%▲▼]/g, '').trim();
          if (val === 'N/A') return -Infinity; // Keep N/A grouped at bottom
          return isNaN(Number(val)) ? str.toLowerCase() : Number(val);
        };
        
        const valA = clean(cellA);
        const valB = clean(cellB);
        
        if (typeof valA === 'number' && typeof valB === 'number') {
          return isAsc ? valA - valB : valB - valA;
        } else {
          return isAsc 
            ? String(valA).localeCompare(String(valB)) 
            : String(valB).localeCompare(String(valA));
        }
      });
      
      tbody.innerHTML = '';
      rows.forEach(row => tbody.appendChild(row));
    });
  });
}

init();
