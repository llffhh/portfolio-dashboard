export function currentHoldings(lots) {
  const holdings = {};
  const reviewLots = [];

  for (const lot of lots) {
    if (lot.shares === null || lot.shares === undefined) {
      reviewLots.push(lot);
    } else {
      if (!holdings[lot.ticker]) {
        holdings[lot.ticker] = { shares: 0, cost: 0 };
      }
      holdings[lot.ticker].shares += lot.shares;
      holdings[lot.ticker].cost += lot.cost;
    }
  }

  return { holdings, reviewLots };
}

export function costOfHoldings(lots) {
  return lots.reduce((sum, lot) => sum + lot.cost, 0);
}

export function investedCapital(deposits) {
  return deposits.reduce((sum, dep) => sum + dep.amount, 0);
}

export function currentValue(holdings, priceMap, asOf) {
  let value = 0;
  for (const [ticker, data] of Object.entries(holdings)) {
    const price = priceMap[ticker]?.[asOf];
    if (price === undefined || price === null) {
      throw new Error('E_NO_PRICE');
    }
    value += data.shares * price;
  }
  return value;
}

export function roi(value, dividends, cost) {
  if (cost === 0) throw new Error('E_DIV_ZERO_COST');
  return (value + dividends - cost) / cost;
}

// MET-14 (Rev 4.8): dividends attributable to the lots still held — paid by a held
// ticker on or after that ticker's oldest held lot. Pairs with costOfHoldings so the
// ROI numerator and denominator cover the same lots: dividends from sold-out tickers,
// or from earlier lots of a ticker that were later sold, no longer inflate it.
// Approximate: dividends are recorded per ticker, not per lot.
export function matchedDividends(lots, divs) {
  const firstHeld = {};
  for (const lot of lots) {
    const t = String(lot.ticker).trim();
    if (!(t in firstHeld) || new Date(lot.date) < new Date(firstHeld[t])) firstHeld[t] = lot.date;
  }
  let sum = 0;
  for (const d of divs) {
    const t = String(d.name ?? '').trim();
    if (t in firstHeld && new Date(d.date) >= new Date(firstHeld[t])) sum += d.amount;
  }
  return sum;
}

// MET-15 (Rev 4.8): account-level money in / money out. Deposit rows carry CD轉入 as
// positive and CD轉出 withdrawals as negative amounts. Dividends are NOT added on top:
// they land in the account and leave inside CD轉出, so `withdrawn` already holds them.
export function accountFlows(deposits) {
  let deposited = 0, withdrawn = 0;
  for (const d of deposits) {
    if (d.amount > 0) deposited += d.amount;
    else withdrawn -= d.amount;
  }
  return { deposited, withdrawn };
}

function npv(rate, cashflows) {
  let value = 0;
  for (const cf of cashflows) {
    const days = (new Date(cf.date) - new Date(cashflows[0].date)) / (1000 * 60 * 60 * 24);
    value += cf.amount / Math.pow(1 + rate, days / 365.25);
  }
  return value;
}

function npvDerivative(rate, cashflows) {
  let value = 0;
  for (const cf of cashflows) {
    const days = (new Date(cf.date) - new Date(cashflows[0].date)) / (1000 * 60 * 60 * 24);
    const t = days / 365.25;
    if (t > 0) {
      value -= (t * cf.amount) / Math.pow(1 + rate, t + 1);
    }
  }
  return value;
}

export function xirr(cashflows, guess = 0.1) {
  if (cashflows.length < 2) throw new Error('E_XIRR_BAD_INPUT');
  
  let hasPos = false;
  let hasNeg = false;
  for (const cf of cashflows) {
    if (cf.amount > 0) hasPos = true;
    if (cf.amount < 0) hasNeg = true;
  }
  if (!hasPos || !hasNeg) throw new Error('E_XIRR_BAD_INPUT');

  cashflows = [...cashflows].sort((a, b) => new Date(a.date) - new Date(b.date));

  let rate = guess;
  for (let i = 0; i < 100; i++) {
    const fValue = npv(rate, cashflows);
    if (Math.abs(fValue) < 1e-6) return rate;
    
    const fDerivative = npvDerivative(rate, cashflows);
    if (fDerivative === 0) throw new Error('E_XIRR_NO_CONVERGE');
    
    rate = rate - fValue / fDerivative;
  }
  throw new Error('E_XIRR_NO_CONVERGE');
}

export function simpleCagr(beginValue, endValue, years) {
  if (beginValue <= 0 || years <= 0) throw new Error('E_CAGR_DOMAIN');
  return Math.pow(endValue / beginValue, 1 / years) - 1;
}

export function dividendsByYear(divs) {
  const result = {};
  for (const div of divs) {
    const year = div.date.substring(0, 4);
    result[year] = (result[year] || 0) + div.amount;
  }
  return result;
}

// MET-11: same conservation invariant as MET-8, over deposits (CD轉入)
export function depositsByYear(deposits) {
  return dividendsByYear(deposits);
}

// MET-12 (Rev 4.9): yearly P/L split into realized + unrealized, AVERAGE COST.
//   realized(y)   = Σ sells in y of (sell.amount − avgCost × shares sold)
//   unrealized(y) = [V(y) − Cost(y)] − [V(p) − Cost(p)], p = last earlier year-end with a V
//   realized + unrealized = V(y) − V(p) − buys + sells  (deposits and dividends never enter)
// Cost(y) = average-cost basis of shares held at y's year-end, replayed from Trades
// (same-day buys before sells). Shares sold beyond what Trades bought (配股, pre-ledger
// holdings) carry cost 0 and are listed in zeroCostSells. A year whose V is missing has
// unrealized null; the next priced year spans the gap. Before the first priced year,
// unrealized stays null while shares were held (the starting gain is unknown).
export function yearlyPnL(trades, valueByYear) {
  const sorted = [...trades].sort((a, b) =>
    a.date.localeCompare(b.date) || (a.type === 'buy' ? -1 : 1) - (b.type === 'buy' ? -1 : 1));
  const pos = {};               // ticker -> {shares, cost}
  const realized = {};
  const costAt = {};            // year -> {cost, held}
  const zeroCostSells = [];
  const snapshot = () => {
    let cost = 0, held = false;
    for (const p of Object.values(pos)) { cost += p.cost; if (p.shares > 0) held = true; }
    return { cost, held };
  };

  let curY = null;
  for (const t of sorted) {
    const y = t.date.substring(0, 4);
    for (; curY !== null && curY < y; curY = String(Number(curY) + 1)) costAt[curY] = snapshot();
    curY = y;
    const p = (pos[String(t.ticker).trim()] ??= { shares: 0, cost: 0 });
    if (t.type === 'buy') {
      p.shares += t.shares;
      p.cost += t.amount;
    } else if (t.type === 'sell') {
      const matched = Math.min(t.shares, p.shares);
      const soldCost = matched > 0 ? p.cost * matched / p.shares : 0;
      if (t.shares > matched) zeroCostSells.push({ date: t.date, ticker: String(t.ticker).trim(), shares: t.shares - matched });
      p.shares -= matched;
      p.cost -= soldCost;
      realized[y] = (realized[y] || 0) + t.amount - soldCost;
    }
  }

  const vYears = Object.keys(valueByYear).filter(y => valueByYear[y] != null);
  const firstY = [...Object.keys(costAt), curY, ...vYears].filter(Boolean).sort()[0];
  const lastY = [curY, ...vYears].filter(Boolean).sort().pop();
  const years = {};
  if (!firstY) return { years, zeroCostSells };
  if (curY !== null) {
    for (; curY <= lastY; curY = String(Number(curY) + 1)) costAt[curY] = snapshot();
  }

  let prev = { v: 0, cost: 0 };   // nothing held before the first trade
  for (let y = firstY; y <= lastY; y = String(Number(y) + 1)) {
    const c = costAt[y] || { cost: 0, held: false };
    const v = valueByYear[y] != null ? valueByYear[y] : (c.held ? null : 0);
    let unrealized = null;
    if (v !== null) {
      if (prev) unrealized = (v - c.cost) - (prev.v - prev.cost);
      prev = { v, cost: c.cost };
    } else if (prev && !vYears.some(k => k < y)) {
      prev = null;                // held before any priced year-end: start unknown
    }
    years[y] = { realized: realized[y] || 0, unrealized };
  }
  return { years, zeroCostSells };
}

export function portfolioValueOverTime(trades, priceMap, dates) {
  const result = [];
  const sortedDates = [...dates].sort((a, b) => new Date(a) - new Date(b));
  
  for (const date of sortedDates) {
    const targetTime = new Date(date).getTime();
    
    // Calculate holdings up to 'date'
    const holdings = {};
    for (const trade of trades) {
      const tradeTime = new Date(trade.date).getTime();
      if (tradeTime <= targetTime) {
        if (!holdings[trade.ticker]) holdings[trade.ticker] = 0;
        if (trade.type === 'buy') {
          holdings[trade.ticker] += trade.shares;
        } else if (trade.type === 'sell') {
          holdings[trade.ticker] -= trade.shares;
        }
      }
    }
    
    let totalValue = 0;
    for (const [ticker, shares] of Object.entries(holdings)) {
      if (shares <= 0) continue; // Not holding
      const price = priceMap[ticker]?.[date];
      if (price === undefined || price === null) {
        throw new Error('E_NO_PRICE');
      }
      totalValue += shares * price;
    }
    
    result.push({ date, value: totalValue });
  }
  
  return result;
}

export function buildXirrCashflows(deposits, divs, withdrawals, terminalValue, terminalDate) {
  const flows = [];
  
  for (const dep of deposits) {
    flows.push({ date: dep.date, amount: -dep.amount });
  }
  for (const div of divs) {
    flows.push({ date: div.date, amount: div.amount });
  }
  for (const wd of withdrawals) {
    flows.push({ date: wd.date, amount: wd.amount });
  }
  if (terminalValue !== undefined) {
    flows.push({ date: terminalDate, amount: terminalValue });
  }
  
  return flows.sort((a, b) => new Date(a.date) - new Date(b.date));
}

// MET-13 (Rev 4.1): dividend yield on COST basis — annual dividends ÷ cost basis,
// per ticker and portfolio-wide. `annualDividendOf(ticker)` is injected rather than
// computed here so the trailing-window convention stays defined in exactly one
// place (annualDividendFor, sellplanner.js SP-3).
//
// APPROXIMATE by construction, for the same reason as SP-3: dividends received in
// the past reflect the share count held at the time, not the current position.
// Only currently-held tickers contribute, so dividends from sold-out positions
// never inflate the portfolio figure.
export function yieldOnCost(holdings, annualDividendOf) {
  const byTicker = {};
  let totalAnnual = 0;
  let totalCost = 0;
  for (const [ticker, data] of Object.entries(holdings)) {
    const cost = data.cost || 0;
    const annual = annualDividendOf(ticker) || 0;
    byTicker[ticker] = {
      annualDividend: annual,
      cost,
      yieldPct: cost > 0 ? (annual / cost) * 100 : null
    };
    totalAnnual += annual;
    totalCost += cost;
  }
  return {
    byTicker,
    annualDividend: totalAnnual,
    cost: totalCost,
    yieldPct: totalCost > 0 ? (totalAnnual / totalCost) * 100 : null
  };
}
