import { describe, it, expect } from 'vitest';
import { SheetScenarioStore } from '../src/api.js';

// Client side of the Rev 4.2 Sheet sync (design.md §C.10, SP-21), against a fake fetch.
const cfg = { WEBAPP_URL: 'https://example.test/exec', API_KEY: 'secret-key' };

function fakeFetch(responder) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  f.calls = calls;
  return f;
}
const ok = (data) => ({ ok: true, json: async () => data });

describe('SP-21 — SheetScenarioStore', () => {
  it('list() reads GET resource=sellplans and returns the array', async () => {
    const f = fakeFetch(() => ok([{ id: 'a' }]));
    expect(await new SheetScenarioStore(cfg, f).list()).toEqual([{ id: 'a' }]);
    expect(f.calls[0].url).toContain('resource=sellplans');
  });

  it('save() POSTs with the key in the body, never the URL, and sends no custom headers', async () => {
    const f = fakeFetch(() => ok({ ok: true, id: 'a' }));
    await new SheetScenarioStore(cfg, f).save({ id: 'a' });
    const { url, init } = f.calls[0];
    expect(url).toBe(cfg.WEBAPP_URL);
    expect(url).not.toContain('secret-key');
    expect(init.method).toBe('POST');
    // No headers keeps it a CORS "simple request"; Apps Script can't answer a preflight.
    expect(init.headers).toBeUndefined();
    expect(JSON.parse(init.body)).toEqual({ key: 'secret-key', action: 'save', scenario: { id: 'a' } });
  });

  it('remove() POSTs a delete action for the id', async () => {
    const f = fakeFetch(() => ok({ ok: true, id: 'a', deleted: true }));
    await new SheetScenarioStore(cfg, f).remove('a');
    expect(JSON.parse(f.calls[0].init.body)).toEqual({ key: 'secret-key', action: 'delete', id: 'a' });
  });

  it('maps server and network failures onto the closed error taxonomy', async () => {
    const as = (resp) => new SheetScenarioStore(cfg, fakeFetch(() => resp));
    await expect(as(ok({ error: 'unauthorized' })).save({})).rejects.toThrow('E_AUTH');
    await expect(as(ok({ error: 'bad_request' })).save({})).rejects.toThrow('E_SCENARIO_REJECTED');
    await expect(as(ok({ error: 'upstream' })).list()).rejects.toThrow('E_SCENARIO_SYNC');
    await expect(as({ ok: false, json: async () => ({}) }).list()).rejects.toThrow('E_SCENARIO_SYNC');
    await expect(as(ok({ not: 'an array' })).list()).rejects.toThrow('E_SCENARIO_SYNC');
    const down = new SheetScenarioStore(cfg, async () => {
      throw new TypeError('network down');
    });
    await expect(down.list()).rejects.toThrow('E_SCENARIO_SYNC');
    await expect(down.save({})).rejects.toThrow('E_SCENARIO_SYNC');
  });
});
