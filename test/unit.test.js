import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { AppsScriptSource, AppsScriptPriceSource } from '../src/api.js';

const TEST_CFG = { WEBAPP_URL: 'https://script.test/exec', API_KEY: 'testkey' };

describe('Unit Tests: Apps Script Integration', () => {
  let originalFetch;

  beforeAll(() => {
    originalFetch = global.fetch;
  });

  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('AppsScriptSource throws E_AUTH on non-2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const source = new AppsScriptSource(TEST_CFG);
    await expect(source.loadHeldLots()).rejects.toThrow('E_AUTH');
  });

  it('AppsScriptSource throws E_PRICE_FETCH on upstream error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ 
      ok: true, 
      json: async () => ({ error: 'upstream' }) 
    });
    const source = new AppsScriptSource(TEST_CFG);
    await expect(source.loadHeldLots()).rejects.toThrow('E_PRICE_FETCH');
  });

  it('AppsScriptSource throws E_DATA_PARSE on bad_request error', async () => {
    global.fetch = vi.fn().mockResolvedValue({ 
      ok: true, 
      json: async () => ({ error: 'bad_request' }) 
    });
    const source = new AppsScriptSource(TEST_CFG);
    await expect(source.loadHeldLots()).rejects.toThrow('E_DATA_PARSE');
  });

  it('AppsScriptPriceSource formats URL correctly and parses prices', async () => {
    global.fetch = vi.fn().mockResolvedValue({ 
      ok: true, 
      json: async () => ({ 'A': { '2023-12-31': 100 } }) 
    });
    const source = new AppsScriptPriceSource(TEST_CFG);
    const prices = await source.getPrices(['A'], ['2023-12-31']);
    expect(global.fetch).toHaveBeenCalledWith(expect.stringContaining('resource=prices&tickers=A&dates=2023-12-31'));
    expect(prices).toEqual({ 'A': { '2023-12-31': 100 } });
  });

  it('AppsScriptPriceSource throws E_AUTH on non-2xx', async () => {
    global.fetch = vi.fn().mockResolvedValue({ ok: false });
    const source = new AppsScriptPriceSource(TEST_CFG);
    await expect(source.getPrices(['A'])).rejects.toThrow('E_AUTH');
  });
});
