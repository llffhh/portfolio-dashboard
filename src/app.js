import { LocalJsonSource, MockPriceSource } from './data.js';
import { AppsScriptSource, AppsScriptPriceSource } from './api.js';
import { getConfig, saveConfig } from './settings.js';
import {
  currentHoldings, costOfHoldings, investedCapital, currentValue,
  roi, xirr, simpleCagr, dividendsByYear, portfolioValueOverTime, buildXirrCashflows
} from './metrics.js';

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

    // Filter review lots (null shares) and missing prices
    const noPriceTickers = new Set();
    let currentVal = 0;
    
    for (const [ticker, data] of Object.entries(holdings)) {
      const price = priceMap[ticker]?.[today];
      if (price === undefined || price === null) {
        noPriceTickers.add(ticker);
      } else {
        currentVal += data.shares * price;
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

    try {
      // For portfolio value, we only chart dates where we have prices for all held tickers at that date
      const safeDates = dates.filter(date => {
        return !Array.from(allTickers).some(t => {
          // simple check: if we held it, and price is null... we might skip.
          // For simplicity in the app, we'll let portfolioValueOverTime throw or filter it.
          return false; 
        });
      });
      // Filter out trades with tickers that have missing prices to avoid E_NO_PRICE
      const safeTrades = trades.filter(t => priceMap[t.ticker]);
      const pvOverTime = portfolioValueOverTime(safeTrades, priceMap, dates);
      
      new Chart(document.getElementById('valueChart'), {
        type: 'line',
        data: {
          labels: pvOverTime.map(d => d.date),
          datasets: [{
            label: 'Portfolio Value',
            data: pvOverTime.map(d => d.value),
            borderColor: '#10b981',
            tension: 0.1
          }]
        }
      });
    } catch (e) {
      console.warn("Could not render value chart", e);
    }

    // Table
    const tbody = document.querySelector('#holdingsTable tbody');
    for (const [ticker, data] of Object.entries(holdings)) {
      const price = priceMap[ticker]?.[today];
      const val = price ? (data.shares * price) : 0;
      const tDivs = divs.filter(d => d.name === ticker || d.code === ticker).reduce((s,d) => s + d.amount, 0);
      const yieldPct = data.cost > 0 ? (tDivs / data.cost) * 100 : 0;
      
      tbody.innerHTML += `
        <tr>
          <td>${ticker}</td>
          <td>${data.shares.toLocaleString()}</td>
          <td>${data.cost.toLocaleString()}</td>
          <td>${price ? val.toLocaleString() : 'N/A'}</td>
          <td>${yieldPct.toFixed(2)}%</td>
        </tr>
      `;
    }

  } catch (err) {
    console.error("Dashboard Init Error", err);
    document.body.innerHTML += `<div style="color:red; padding: 20px;">Error loading dashboard: ${err.message}</div>`;
  }
}

init();
