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
