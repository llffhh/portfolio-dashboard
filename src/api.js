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
    return normalizeRecords(data);
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
// The ledger contains stray trailing spaces ('台積電 ' vs '台積電'), which
// otherwise split one holding into two and break price lookups (A.0 normalization).
export function normalizeRecords(rows) {
  if (!Array.isArray(rows)) return rows;
  for (const r of rows) {
    if (r && typeof r.ticker === 'string') r.ticker = r.ticker.trim();
    if (r && typeof r.name === 'string') r.name = r.name.trim();
  }
  return rows;
}

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

// Rev 4.2 (design.md §C.10, SP-21): Sell Planner scenarios persisted in the
// owner's Sheet, so a plan saved in one browser shows up on every device.
// Writes are POSTs with the key in the BODY — never in the URL — and no custom
// headers, which keeps them CORS "simple requests": Apps Script cannot answer a
// preflight, so a JSON content-type header would make every save fail.
export class SheetScenarioStore {
  constructor(config, fetchImpl = (...args) => fetch(...args)) {
    this.url = config.WEBAPP_URL;
    this.key = config.API_KEY;
    this.fetch = fetchImpl;
  }

  static _check(data) {
    if (data && data.error === 'unauthorized') throw new Error('E_AUTH');
    if (data && data.error === 'bad_request') throw new Error('E_SCENARIO_REJECTED');
    if (data && data.error) throw new Error('E_SCENARIO_SYNC');
    return data;
  }

  async list() {
    let res;
    try {
      res = await this.fetch(`${this.url}?key=${encodeURIComponent(this.key)}&resource=sellplans`);
    } catch (e) {
      throw new Error('E_SCENARIO_SYNC');
    }
    if (!res.ok) throw new Error('E_SCENARIO_SYNC');
    const data = SheetScenarioStore._check(await res.json());
    if (!Array.isArray(data)) throw new Error('E_SCENARIO_SYNC');
    return data;
  }

  async _post(payload) {
    let res;
    try {
      res = await this.fetch(this.url, {
        method: 'POST',
        body: JSON.stringify({ key: this.key, ...payload })
      });
    } catch (e) {
      throw new Error('E_SCENARIO_SYNC');
    }
    if (!res.ok) throw new Error('E_SCENARIO_SYNC');
    return SheetScenarioStore._check(await res.json());
  }

  async save(scenario) { return this._post({ action: 'save', scenario }); }
  async remove(id) { return this._post({ action: 'delete', id }); }
}
