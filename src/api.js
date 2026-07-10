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

    return data;
  }
}
