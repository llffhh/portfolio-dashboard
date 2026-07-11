export class LocalJsonSource {
  constructor(basePath) {
    this.basePath = basePath;
  }
  
  async _readJson(filename, validator) {
    let data;
    try {
      // Use fetch to work in both browser and modern Node
      const res = await fetch(`${this.basePath}/${filename}`);
      if (!res.ok) throw new Error('E_DATA_PARSE');
      data = await res.json();
    } catch (e) {
      throw new Error('E_DATA_PARSE');
    }
    
    if (validator && Array.isArray(data)) {
      for (const record of data) {
        if (!validator(record)) throw new Error('E_DATA_PARSE');
      }
    }
    return data;
  }

  async loadHeldLots() {
    return this._readJson('held_lots.json', r => 
      typeof r.date === 'string' && typeof r.ticker === 'string' && 
      (typeof r.shares === 'number' || r.shares === null) && 
      (typeof r.buyPrice === 'number' || r.buyPrice === null) &&
      typeof r.cost === 'number'
    );
  }
  
  async loadTrades() {
    return this._readJson('trades.json', r =>
      typeof r.date === 'string' && typeof r.ticker === 'string' &&
      (r.type === 'buy' || r.type === 'sell') &&
      (typeof r.shares === 'number' || r.shares === null) &&
      typeof r.amount === 'number'
    );
  }
  
  async loadDeposits() {
    return this._readJson('deposits.json', r =>
      typeof r.date === 'string' && typeof r.amount === 'number'
    );
  }
  
  async loadDividends() {
    return this._readJson('dividends.json', r =>
      typeof r.date === 'string' && typeof r.name === 'string' &&
      typeof r.amount === 'number' && typeof r.detail === 'string' &&
      (typeof r.code === 'string' || r.code === null)
    );
  }

  async loadDailyHistory() {
    try {
      return await this._readJson('daily_history.json');
    } catch (e) {
      return [];
    }
  }
}

export class MockPriceSource {
  constructor(basePath) {
    this.basePath = basePath;
  }
  
  async getPrices(tickers, dates = []) {
    let content;
    try {
      const res = await fetch(`${this.basePath}/prices.json`);
      if (!res.ok) throw new Error('E_PRICE_FETCH');
      content = await res.json();
    } catch (e) {
      throw new Error('E_PRICE_FETCH');
    }
    
    const result = {};
    for (const t of tickers) {
      if (content[t]) {
        result[t] = content[t];
      }
    }
    return result;
  }
}
