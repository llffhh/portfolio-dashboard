import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import vm from 'vm';

// Loads gas/Code.js into a Node sandbox with in-memory fakes of the Apps Script
// services it touches, so the Rev 4.2 write path (design.md §C.10) is tested
// without a Google account. The fake mimics one real Sheets behaviour that the
// formula guard depends on: a leading apostrophe forces text and is not stored.
function makeFakeSheet() {
  const rows = [];
  const raw = []; // exact values handed to the Sheet, before display processing
  const store = (v) => (typeof v === 'string' && v.startsWith("'") ? v.slice(1) : v);
  return {
    rows,
    raw,
    getLastRow: () => rows.length,
    appendRow(values) {
      raw.push([...values]);
      rows.push(values.map(store));
    },
    deleteRow(r) {
      rows.splice(r - 1, 1);
    },
    setFrozenRows() {},
    getRange(r, c, nr = 1, nc = 1) {
      return {
        setValues(vals) {
          for (let i = 0; i < nr; i++) {
            raw.push([...vals[i]]);
            rows[r - 1 + i] = rows[r - 1 + i] || [];
            for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = store(vals[i][j]);
          }
        },
        getValues() {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? '');
            out.push(row);
          }
          return out;
        }
      };
    }
  };
}

function loadGas({ apiKey = 'K' } = {}) {
  const sheets = {};
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => (sheets[n] = makeFakeSheet())
  };
  const ctx = {
    console,
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } })
    },
    PropertiesService: {
      getScriptProperties: () => ({ getProperty: (k) => (k === 'API_KEY' ? apiKey : null) })
    },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('gas/Code.js', 'utf8'), ctx);
  const post = (body) =>
    JSON.parse(ctx.doPost({ postData: { contents: typeof body === 'string' ? body : JSON.stringify(body) } }).body);
  const get = (params) => JSON.parse(ctx.doGet({ parameter: params }).body);
  return { sheets, post, get };
}

const scenario = (over = {}) => ({
  id: 'sc_1',
  name: 'Plan A',
  savedAt: '2026-09-10T08:00:00.000Z',
  strategyId: 'custom',
  locked: ['台積電'],
  rows: [{ ticker: '甲', sellShares: 500 }, { ticker: '乙', sellShares: 37 }],
  note: '',
  netAtSave: 1234567.8,
  ...over
});

describe('SP-19/SP-20 — Apps Script SellPlans write path (gas/Code.js)', () => {
  let g;
  beforeEach(() => {
    g = loadGas();
  });

  it('SP-20: POST without the key, or with a wrong key, is unauthorized and writes nothing', () => {
    expect(g.post({ action: 'save', scenario: scenario() })).toEqual({ error: 'unauthorized' });
    expect(g.post({ key: 'nope', action: 'save', scenario: scenario() })).toEqual({ error: 'unauthorized' });
    expect(g.sheets.SellPlans).toBeUndefined();
  });

  it('SP-20: a body that is not JSON, or exceeds the size bound, is rejected', () => {
    expect(g.post('not json')).toEqual({ error: 'bad_request' });
    expect(g.post({ key: 'K', action: 'save', scenario: scenario({ note: 'x'.repeat(30000) }) }))
      .toEqual({ error: 'bad_request' });
  });

  it('SP-19: the first save creates the SellPlans tab with a header row, and GET lists it back', () => {
    expect(g.post({ key: 'K', action: 'save', scenario: scenario() })).toEqual({ ok: true, id: 'sc_1' });
    expect(g.sheets.SellPlans.rows[0]).toEqual(['id', 'savedAt', 'name', 'scenario']);
    const list = g.get({ key: 'K', resource: 'sellplans' });
    expect(list).toHaveLength(1);
    expect(list[0].rows).toEqual([{ ticker: '甲', sellShares: 500 }, { ticker: '乙', sellShares: 37 }]);
    expect(list[0].locked).toEqual(['台積電']);
    expect(list[0].netAtSave).toBe(1234567.8);
  });

  it('SP-19: saving an existing id updates it in place rather than adding a duplicate', () => {
    g.post({ key: 'K', action: 'save', scenario: scenario() });
    g.post({ key: 'K', action: 'save', scenario: scenario({ name: 'Plan A v2' }) });
    const list = g.get({ key: 'K', resource: 'sellplans' });
    expect(list).toHaveLength(1);
    expect(list[0].name).toBe('Plan A v2');
  });

  it('SP-19: delete removes the row; deleting an unknown id is a harmless no-op', () => {
    g.post({ key: 'K', action: 'save', scenario: scenario() });
    expect(g.post({ key: 'K', action: 'delete', id: 'sc_1' })).toEqual({ ok: true, id: 'sc_1', deleted: true });
    expect(g.get({ key: 'K', resource: 'sellplans' })).toEqual([]);
    expect(g.post({ key: 'K', action: 'delete', id: 'nope' })).toEqual({ ok: true, id: 'nope', deleted: false });
  });

  it('SP-20: a name that looks like a formula is written as plain text, never evaluated', () => {
    const evil = '=IMPORTXML("http://x.test","//a")';
    g.post({ key: 'K', action: 'save', scenario: scenario({ name: evil }) });
    const written = g.sheets.SellPlans.raw.at(-1);
    for (const cell of written.slice(0, 3)) expect(String(cell).startsWith("'")).toBe(true);
    expect(g.get({ key: 'K', resource: 'sellplans' })[0].name).toBe(evil);
  });

  it('SP-20: malformed scenarios are rejected and nothing is written', () => {
    const bad = [
      scenario({ id: 'bad id!' }),
      scenario({ strategyId: 'yolo' }),
      scenario({ rows: [{ ticker: '甲', sellShares: 1.5 }] }),
      scenario({ rows: [{ ticker: '甲', sellShares: -1 }] }),
      scenario({ rows: Array.from({ length: 61 }, (_, i) => ({ ticker: 'T' + i, sellShares: 1 })) }),
      scenario({ savedAt: 'not a date' }),
      scenario({ name: '' }),
      scenario({ netAtSave: 'lots' })
    ];
    for (const s of bad) expect(g.post({ key: 'K', action: 'save', scenario: s })).toEqual({ error: 'bad_request' });
    expect(g.post({ key: 'K', action: 'delete', id: '../HeldLots' })).toEqual({ error: 'bad_request' });
    expect(g.sheets.SellPlans).toBeUndefined();
  });

  it('SP-19: the write path can only ever touch the SellPlans tab', () => {
    g.post({ key: 'K', action: 'save', scenario: scenario() });
    g.post({ key: 'K', action: 'delete', id: 'sc_1' });
    expect(g.post({ key: 'K', action: 'bogus', tab: 'HeldLots' })).toEqual({ error: 'bad_request' });
    expect(Object.keys(g.sheets)).toEqual(['SellPlans']);
  });

  it('SP-20: the store is bounded — the 201st distinct scenario is refused, updates still allowed', () => {
    for (let i = 0; i < 200; i++) {
      expect(g.post({ key: 'K', action: 'save', scenario: scenario({ id: 'sc_' + i }) }).ok).toBe(true);
    }
    expect(g.post({ key: 'K', action: 'save', scenario: scenario({ id: 'sc_overflow' }) }))
      .toEqual({ error: 'bad_request' });
    expect(g.post({ key: 'K', action: 'save', scenario: scenario({ id: 'sc_5', name: 'edited' }) }).ok).toBe(true);
  });

  it('SP-19: a hand-edited, unparseable row is skipped rather than breaking the list', () => {
    g.post({ key: 'K', action: 'save', scenario: scenario() });
    g.sheets.SellPlans.appendRow(['x', 'y', 'z', '{not json']);
    expect(g.get({ key: 'K', resource: 'sellplans' }).map((s) => s.id)).toEqual(['sc_1']);
  });

  it('SP-19: GET sellplans still requires the key, and the existing read paths are untouched', () => {
    expect(g.get({ key: 'wrong', resource: 'sellplans' })).toEqual({ error: 'unauthorized' });
    expect(g.get({ key: 'K', resource: 'nonsense' })).toEqual({ error: 'bad_request' });
  });
});
