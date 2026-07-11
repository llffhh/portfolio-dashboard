export class AppsScriptSource {
  constructor(config) {
    this.url = config.WEBAPP_URL;
    this.key = config.API_KEY;
  }

  async _fetch(resource) {
    const res = await fetch(`${this.url}?key=${encodeURIComponent(this.key)}&resource=${resource}`);
    if (!res.ok) throw new Error('E_AUTH');
    const data = await res.json();
    if (data.error) {
      if (data.error === 'unauthorized') throw new Error('E_AUTH');
      if (data.error === 'upstream') throw new Error('E_PRICE_FETCH');
      throw new Error('E_DATA_PARSE');
    }
    return data;
  }

  async loadHeldLots() { return this._fetch('heldlots'); }
  async loadTrades() { return this._fetch('trades'); }
  async loadDeposits() { return this._fetch('deposits'); }
  async loadDividends() { return this._fetch('dividends'); }
  async loadDailyHistory() { return this._fetch('dailyhistory'); }
}

// The GAS V8 runtime can serve Date headers as raw strings like
// "Sun Dec 31 2017 08:00:00 GMT+0800 (台北標準時間)" (its `instanceof Date`
// is unreliable). Normalize any such key to yyyy-MM-dd, deterministically
// from the string itself (no client-timezone math).
const MONTHS = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
                 Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };
export function normalizeDateKey(k) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(k) || k === 'closeyest') return k;
  const m = /^\w{3} (\w{3}) (\d{2}) (\d{4})/.exec(k);
  return m && MONTHS[m[1]] ? `${m[3]}-${MONTHS[m[1]]}-${m[2]}` : k;
}

export class AppsScriptPriceSource {
  constructor(config) {
    this.url = config.WEBAPP_URL;
    this.key = config.API_KEY;
  }

  async getPrices(tickers, dates = []) {
    let url = `${this.url}?key=${encodeURIComponent(this.key)}&resource=prices&tickers=${encodeURIComponent(tickers.join(','))}`;
    if (dates.length > 0) url += `&dates=${dates.join(',')}`;

    const res = await fetch(url);
    if (!res.ok) throw new Error('E_AUTH');
    const data = await res.json();

    if (data.error === 'unauthorized') throw new Error('E_AUTH');
    if (data.error === 'upstream') throw new Error('E_PRICE_FETCH');
    if (data.error) throw new Error('E_DATA_PARSE');

    const normalized = {};
    for (const [ticker, prices] of Object.entries(data)) {
      normalized[ticker] = {};
      for (const [k, v] of Object.entries(prices)) normalized[ticker][normalizeDateKey(k)] = v;
    }
    return normalized;
  }
}
