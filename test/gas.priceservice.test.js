import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import vm from 'vm';

// Rev 4.7 — Unified price service (design.md §D). Loads gas/Code.js into a
// Node sandbox with in-memory fakes of the Apps Script services it touches
// (Utilities.formatDate is backed by real Intl so the Asia/Taipei math is
// genuine, not hand-rolled), following the pattern established in
// test/gas.sellplans.test.js.

// ---- date helpers (outer scope — plain Node Date/Intl, not the sandbox's) ----

// Formats like Utilities.formatDate(d, 'Asia/Taipei', 'yyyy-MM-dd') would.
function taipeiDateStr(d) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(d);
}
function todayTaipei() {
  return taipeiDateStr(new Date());
}
function shiftDate(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const t = Date.UTC(y, m - 1, d) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
// Epoch seconds for a given Taipei wall-clock date+time (Taipei is fixed
// UTC+8, no DST, so this is exact arithmetic, not a lookup).
function taipeiEpochSeconds(dateStr, hh, mm) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d, hh - 8, mm, 0) / 1000);
}

// Builds a captured-shape Yahoo `chart` payload. `closesByDate` need not be in
// order. `chartPreviousClose` is deliberately set to an absurd decoy value so
// any test that would pass by accident (code reading meta instead of closes)
// fails loudly instead (§D.1: verified range-dependent, must never be used).
function yahooChart({ symbol, sessionDate, sessionHHMM = '1331', closesByDate }) {
  const dates = Object.keys(closesByDate).sort();
  const timestamps = dates.map((d) => taipeiEpochSeconds(d, 13, 31));
  const closes = dates.map((d) => closesByDate[d]);
  const hh = Number(sessionHHMM.slice(0, 2)), mm = Number(sessionHHMM.slice(2));
  return {
    chart: {
      result: [{
        meta: {
          symbol,
          regularMarketTime: taipeiEpochSeconds(sessionDate, hh, mm),
          regularMarketPrice: closesByDate[sessionDate],
          chartPreviousClose: 999999.99   // decoy — must never be read (T4)
        },
        timestamp: timestamps,
        indicators: { quote: [{ close: closes }] }
      }],
      error: null
    }
  };
}

// A5: builds a captured-shape Yahoo `chart` payload with EXPLICIT per-bar
// timestamps, unlike `yahooChart` above (which always stamps every historical
// bar at the same 13:31). `bars` is chronological: [{date, hh, mm, close}, ...].
// `meta.regularMarketTime` is the LAST bar's own timestamp, matching real
// Yahoo (and what a phantom-unaware parse would use as sessionDate).
function yahooChartWithBars(symbol, bars) {
  const last = bars[bars.length - 1];
  return {
    chart: {
      result: [{
        meta: {
          symbol,
          regularMarketTime: taipeiEpochSeconds(last.date, last.hh, last.mm),
          regularMarketPrice: last.close,
          chartPreviousClose: 999999.99   // decoy — must never be read
        },
        timestamp: bars.map((b) => taipeiEpochSeconds(b.date, b.hh, b.mm)),
        indicators: { quote: [{ close: bars.map((b) => b.close) }] }
      }],
      error: null
    }
  };
}

// ---- sandbox fakes ----

function fakeFormatDate(date, tz, pattern) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  }).formatToParts(date).reduce((o, p) => ((o[p.type] = p.value), o), {});
  if (pattern === 'yyyy-MM-dd') return `${parts.year}-${parts.month}-${parts.day}`;
  if (pattern === 'HHmm') return `${parts.hour}${parts.minute}`;
  if (pattern === 'HH') return parts.hour;
  if (pattern === 'mm') return parts.minute;
  if (pattern === 'ss') return parts.second;
  throw new Error('fakeFormatDate: unsupported pattern ' + pattern);
}

function makeFakeCache() {
  const values = {}, ttls = {};
  return {
    get: (k) => (k in values ? values[k] : null),
    put: (k, v, ttl) => { values[k] = v; ttls[k] = ttl; },
    _values: values,
    _ttls: ttls
  };
}

// `responses`: { [substringOfSymbol]: yahooChartPayload | 'throw' | 'http500' }
// `fetchAllCalls` records each fetchAll() invocation's request array (for
// asserting batching — Phase 3 audit finding A1). `fetchAllThrows` simulates
// the whole batch failing at the transport level.
function makeFakeUrlFetchApp(responses, calls, fetchAllCalls, fetchAllThrows) {
  function respondTo(url) {
    const match = Object.keys(responses).find((sym) => url.indexOf(sym) !== -1);
    if (!match) return { getResponseCode: () => 404, getContentText: () => '' };
    const r = responses[match];
    if (r === 'throw') throw new Error('simulated network error');
    if (r === 'http500') return { getResponseCode: () => 500, getContentText: () => '' };
    return { getResponseCode: () => 200, getContentText: () => JSON.stringify(r) };
  }
  return {
    fetch(url) {
      calls.push(url);
      return respondTo(url);
    },
    fetchAll(requests) {
      const urls = requests.map((r) => r.url);
      fetchAllCalls.push(urls);
      calls.push(...urls);
      if (fetchAllThrows) throw new Error('simulated whole-batch transport failure');
      return urls.map((u) => {
        try { return respondTo(u); } catch (e) { return { getResponseCode: () => 500, getContentText: () => '' }; }
      });
    }
  };
}

// Minimal in-memory Sheet supporting the calls gas/Code.js makes:
// getDataRange/getRange(getValues/setValues/setValue/sort)/appendRow/deleteRows/getLastRow/getLastColumn.
function makeSheet(initialRows = []) {
  let rows = initialRows.map((r) => [...r]);
  return {
    get _rows() { return rows; },
    getLastRow: () => rows.length,
    getLastColumn: () => rows.reduce((m, r) => Math.max(m, r.length), 0),
    getDataRange() { return { getValues: () => rows.map((r) => [...r]) }; },
    getRange(r, c, nr = 1, nc = 1) {
      return {
        getValues: () => {
          const out = [];
          for (let i = 0; i < nr; i++) {
            const row = [];
            for (let j = 0; j < nc; j++) row.push((rows[r - 1 + i] || [])[c - 1 + j] ?? '');
            out.push(row);
          }
          return out;
        },
        setValues: (vals) => {
          for (let i = 0; i < nr; i++) {
            rows[r - 1 + i] = rows[r - 1 + i] || [];
            for (let j = 0; j < nc; j++) rows[r - 1 + i][c - 1 + j] = vals[i][j];
          }
        },
        setValue: (v) => { rows[r - 1] = rows[r - 1] || []; rows[r - 1][c - 1] = v; },
        sort({ column, ascending }) {
          const slice = rows.slice(r - 1, r - 1 + nr);
          slice.sort((a, b) => {
            const av = a[column - 1], bv = b[column - 1];
            if (av < bv) return ascending ? -1 : 1;
            if (av > bv) return ascending ? 1 : -1;
            return 0;
          });
          for (let i = 0; i < slice.length; i++) rows[r - 1 + i] = slice[i];
        }
      };
    },
    appendRow(arr) { rows.push([...arr]); },
    deleteRows(start, count) { rows.splice(start - 1, count); },
    deleteRow(r) { rows.splice(r - 1, 1); },
    setFrozenRows() {},
    clear() { rows = []; }
  };
}

function loadGas({ sheets = {}, urlResponses = {}, tz = 'Asia/Taipei', fetchAllThrows = false } = {}) {
  const ss = {
    getSheetByName: (n) => sheets[n] || null,
    insertSheet: (n) => { sheets[n] = makeSheet([]); return sheets[n]; },
    getSpreadsheetTimeZone: () => tz
  };
  const cache = makeFakeCache();
  const urlCalls = [];
  const fetchAllCalls = [];
  const logs = [];
  const ctx = {
    console,
    Logger: { log: (m) => logs.push(String(m)) },
    Session: { getScriptTimeZone: () => tz },
    Utilities: { formatDate: fakeFormatDate, sleep: () => {} },
    CacheService: { getScriptCache: () => cache },
    UrlFetchApp: makeFakeUrlFetchApp(urlResponses, urlCalls, fetchAllCalls, fetchAllThrows),
    ContentService: {
      MimeType: { JSON: 'application/json' },
      createTextOutput: (s) => ({ body: s, setMimeType() { return this; } })
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => 'K' }) },
    SpreadsheetApp: { getActiveSpreadsheet: () => ss },
    LockService: { getScriptLock: () => ({ tryLock: () => true, releaseLock() {} }) }
  };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync('gas/Code.js', 'utf8'), ctx);
  return { ctx, sheets, cache, urlCalls, fetchAllCalls, logs };
}

function pricesSheetRows(rowsAfterHeader) {
  return [['ticker', 'code', 'price', 'closeyest'], ...rowsAfterHeader];
}
function heldLotsSheetRows(rowsAfterHeader) {
  return [['ticker', 'shares'], ...rowsAfterHeader];
}

describe('Rev 4.7 — parseQuoteResponse_ / currentOf / prevCloseOf (pure helpers, design.md §D.1)', () => {
  it('T1: builds {sessionDate, isClosed, closes} from a captured Yahoo payload; null closes are dropped', () => {
    const { ctx } = loadGas();
    const today = todayTaipei();
    const y1 = shiftDate(today, -1);
    const y2 = shiftDate(today, -2);
    const payload = yahooChart({
      symbol: '2330.TW',
      sessionDate: today,
      closesByDate: { [y2]: null, [y1]: 500, [today]: 510 }
    });
    const bundle = ctx.parseQuoteResponse_(payload, 'Asia/Taipei');
    expect(bundle.sessionDate).toBe(today);
    expect(bundle.closes).toEqual({ [y1]: 500, [today]: 510 });   // null close for y2 dropped
    expect(Object.keys(bundle.closes)).not.toContain(y2);
  });

  it('T2: isClosed is true iff the regularMarketTime Taipei time-of-day >= 13:30', () => {
    const { ctx } = loadGas();
    const today = todayTaipei();
    const closed = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1330', closesByDate: { [today]: 500 } });
    const stillOpen = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1329', closesByDate: { [today]: 500 } });
    const wellClosed = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 500 } });

    expect(ctx.parseQuoteResponse_(closed, 'Asia/Taipei').isClosed).toBe(true);
    expect(ctx.parseQuoteResponse_(stillOpen, 'Asia/Taipei').isClosed).toBe(false);
    expect(ctx.parseQuoteResponse_(wellClosed, 'Asia/Taipei').isClosed).toBe(true);
  });

  it('T3: currentOf(bundle) === bundle.closes[bundle.sessionDate]', () => {
    const { ctx } = loadGas();
    const today = todayTaipei();
    const bundle = ctx.parseQuoteResponse_(
      yahooChart({ symbol: '2330.TW', sessionDate: today, closesByDate: { [shiftDate(today, -1)]: 500, [today]: 512.5 } }),
      'Asia/Taipei'
    );
    expect(ctx.currentOf(bundle)).toBe(512.5);
    expect(ctx.currentOf(bundle)).toBe(bundle.closes[bundle.sessionDate]);
  });

  it('T4: prevCloseOf is the latest close strictly before sessionDate, never meta.chartPreviousClose', () => {
    const { ctx } = loadGas();
    const today = todayTaipei();
    const y1 = shiftDate(today, -1);
    const y3 = shiftDate(today, -3);
    const payload = yahooChart({
      symbol: '2303.TW',
      sessionDate: today,
      // meta.chartPreviousClose is stubbed to 999999.99 by the fixture builder —
      // if this ever leaks through, the assertion below catches it immediately.
      closesByDate: { [y3]: 140, [y1]: 147.5, [today]: 150 }
    });
    expect(payload.chart.result[0].meta.chartPreviousClose).toBe(999999.99);
    const bundle = ctx.parseQuoteResponse_(payload, 'Asia/Taipei');
    expect(ctx.prevCloseOf(bundle)).toBe(147.5);
    expect(ctx.prevCloseOf(bundle)).not.toBe(999999.99);
  });

  it('prevCloseOf returns null when there is no earlier date in `closes`', () => {
    const { ctx } = loadGas();
    const today = todayTaipei();
    const bundle = ctx.parseQuoteResponse_(
      yahooChart({ symbol: '2330.TW', sessionDate: today, closesByDate: { [today]: 500 } }),
      'Asia/Taipei'
    );
    expect(ctx.prevCloseOf(bundle)).toBeNull();
  });
});

describe('A5 — phantom trailing non-session bar (Phase 4 post-deploy fix, Architect fault per §D.1)', () => {
  // Live-observed shape, 2026-09-20 (Sunday), 2330.TW, range=1mo&interval=1d:
  //   Wed 09-16 09:00 close=2380 -> Thu 09-17 09:00 close=2425 -> Fri 09-18 09:00 close=2460
  //   -> Sun 09-20 12:00 close=2460 (phantom: not a session, duplicates Friday, different time-of-day)
  const REAL_BARS = [
    { date: '2026-09-16', hh: 9, mm: 0, close: 2380 },
    { date: '2026-09-17', hh: 9, mm: 0, close: 2425 },
    { date: '2026-09-18', hh: 9, mm: 0, close: 2460 }
  ];

  it('T-a: non-trading day, phantom present -> current = last real close, prevClose = the session before it', () => {
    const bars = [...REAL_BARS, { date: '2026-09-20', hh: 12, mm: 0, close: 2460 }];   // phantom: dup close, different time
    const { ctx } = loadGas();
    const bundle = ctx.parseQuoteResponse_(yahooChartWithBars('2330.TW', bars), 'Asia/Taipei');

    // The phantom's own date never appears anywhere in the bundle.
    expect(bundle.sessionDate).toBe('2026-09-18');
    expect(bundle.closes['2026-09-20']).toBeUndefined();
    expect(Object.keys(bundle.closes)).toEqual(['2026-09-16', '2026-09-17', '2026-09-18']);

    expect(ctx.currentOf(bundle)).toBe(2460);      // Friday — unchanged, NOT regressed to Thursday
    expect(ctx.prevCloseOf(bundle)).toBe(2425);    // Thursday, the session before Friday — not Friday itself
    expect(bundle.isClosed).toBe(true);            // a resolved-to-real-prior-session bundle is always settled

    // Observable: the decision is recorded on the bundle, not just inferred.
    expect(bundle.phantomDropped).toEqual({
      date: '2026-09-20', close: 2460, timeOfDay: '1200',
      comparedTo: { date: '2026-09-18', close: 2460, timeOfDay: '0900' }
    });
  });

  it('T-b: trading day, in-progress bar stamped 09:00 (same time-of-day as every other bar) -> nothing dropped', () => {
    const bars = [...REAL_BARS, { date: '2026-09-21', hh: 9, mm: 0, close: 2500 }];   // live, different close, same stamp convention
    const { ctx } = loadGas();
    const bundle = ctx.parseQuoteResponse_(yahooChartWithBars('2330.TW', bars), 'Asia/Taipei');

    expect(bundle.phantomDropped).toBeNull();
    expect(bundle.sessionDate).toBe('2026-09-21');
    expect(ctx.currentOf(bundle)).toBe(2500);      // live
    expect(ctx.prevCloseOf(bundle)).toBe(2460);    // yesterday (Friday)
  });

  it('T-c: trading day, in-progress bar stamped at tick time (differs from the modal 09:00) -> nothing dropped', () => {
    const bars = [...REAL_BARS, { date: '2026-09-21', hh: 10, mm: 37, close: 2475 }];   // live, close DIFFERS from Friday's
    const { ctx } = loadGas();
    const bundle = ctx.parseQuoteResponse_(yahooChartWithBars('2330.TW', bars), 'Asia/Taipei');

    // Time-of-day differs from the preceding bar (like the phantom), but the
    // close does NOT match — condition (a) fails, so it is NOT flagged.
    expect(bundle.phantomDropped).toBeNull();
    expect(bundle.sessionDate).toBe('2026-09-21');
    expect(ctx.currentOf(bundle)).toBe(2475);      // live
    expect(ctx.prevCloseOf(bundle)).toBe(2460);    // yesterday (Friday)
  });

  it('T-d: live bar\'s close coincidentally equals yesterday\'s, on a trading day -> nothing dropped', () => {
    // Same stamping convention as every other bar (09:00) — close matches by
    // coincidence, but time-of-day does NOT differ, so condition (b) fails.
    const bars = [...REAL_BARS, { date: '2026-09-21', hh: 9, mm: 0, close: 2460 }];
    const { ctx } = loadGas();
    const bundle = ctx.parseQuoteResponse_(yahooChartWithBars('2330.TW', bars), 'Asia/Taipei');

    expect(bundle.phantomDropped).toBeNull();
    expect(bundle.sessionDate).toBe('2026-09-21');
    expect(ctx.currentOf(bundle)).toBe(2460);      // live (coincidentally == Friday's close)
    expect(ctx.prevCloseOf(bundle)).toBe(2460);    // Friday — a real, un-dropped value

    // NOTE (unresolved, flagged for the weekday follow-up): this specific
    // fixture pairs the coincidental-close scenario with the 09:00 stamping
    // convention (T-b's hypothesis). If a live trading day instead stamps its
    // in-progress bar at TICK time (T-c's hypothesis, also observed-possible)
    // AND that tick's close happens to coincide with yesterday's close, BOTH
    // discriminator conditions would hold simultaneously and this bar would be
    // (mis)classified as a phantom. This combination cannot be distinguished
    // from a real non-trading-day phantom using only (close match + time-of-
    // day mismatch) — it is the one gap the coordinator explicitly flagged as
    // unprovable before a weekday observation of live intraday stamping.
  });

  it('detectPhantomTrailingBar_: fewer than 2 points -> never flagged (nothing to compare against)', () => {
    const { ctx } = loadGas();
    expect(ctx.detectPhantomTrailingBar_([], 'Asia/Taipei')).toBeNull();
    expect(ctx.detectPhantomTrailingBar_([{ ts: taipeiEpochSeconds('2026-09-18', 9, 0), close: 2460 }], 'Asia/Taipei')).toBeNull();
  });

  it('getQuotes_ logs the phantom decision, symbol-tagged, so a weekday run can confirm it without guessing', () => {
    const bars = [...REAL_BARS, { date: '2026-09-20', hh: 12, mm: 0, close: 2460 }];
    const { ctx, logs } = loadGas({ urlResponses: { '2330.TW': yahooChartWithBars('2330.TW', bars) } });
    ctx.getQuotes_({ '台積電': '2330' });
    expect(logs.some((l) => l.includes('dropped phantom') && l.includes('2330.TW') && l.includes('2026-09-20'))).toBe(true);
  });

  it('the §D.2 invariant survives a phantom day: getPricesFromSheet and recordDailySnapshot agree', () => {
    const bars = [...REAL_BARS, { date: '2026-09-20', hh: 12, mm: 0, close: 2460 }];
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': yahooChartWithBars('2330.TW', bars) } });

    ctx.recordDailySnapshot();
    const history = sheets.DailyHistory._rows;
    expect(history[1][0]).toBe('2026-09-18');     // stamped under the REAL session date, not the phantom's
    expect(history[1][1]).toBe(1000 * 2460);

    const priceMap = ctx.getPricesFromSheet(['台積電'], []);
    expect(priceMap['台積電']['2026-09-18']).toBe(2460);
    expect(priceMap['台積電']['closeyest']).toBe(2425);
    expect(1000 * priceMap['台積電']['2026-09-18']).toBe(history[1][1]);
  });
});

describe('Rev 4.7 — getQuotes_ (design.md §D.1/§D.3, T7)', () => {
  it('resolves .TW first, falls back to .TWO, and caches with the right TTL', () => {
    const today = todayTaipei();
    const twoPayload = yahooChart({ symbol: '8299.TWO', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
    const { ctx, cache, urlCalls } = loadGas({
      urlResponses: { '8299.TW?': 'http500', '8299.TWO': twoPayload }
    });
    const out = ctx.getQuotes_({ '群聯': '8299' });
    expect(out['群聯'].symbol).toBe('8299.TWO');
    expect(out['群聯'].closes[today]).toBe(600);
    expect(urlCalls.some((u) => u.includes('8299.TW'))).toBe(true);
    expect(urlCalls.some((u) => u.includes('8299.TWO'))).toBe(true);
    // isClosed (1445 Taipei) => settled TTL, capped at the 6h CacheService ceiling.
    // Cache key includes the (default) range — A2's named trap.
    expect(cache._ttls['q_v2_8299_1mo']).toBe(21600);
  });

  it('caches a live (not-yet-closed) quote at the 300s TTL (§D.3)', () => {
    const today = todayTaipei();
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1000', closesByDate: { [today]: 900 } });
    const { ctx, cache } = loadGas({ urlResponses: { '2330.TW': payload } });
    ctx.getQuotes_({ '台積電': '2330' });
    expect(cache._ttls['q_v2_2330_1mo']).toBe(300);
  });

  it('a second call within TTL is served from cache, not a second fetch', () => {
    const today = todayTaipei();
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 700 } });
    const { ctx, urlCalls } = loadGas({ urlResponses: { '2330.TW': payload } });
    ctx.getQuotes_({ '台積電': '2330' });
    const callsAfterFirst = urlCalls.length;
    const out2 = ctx.getQuotes_({ '台積電': '2330' });
    expect(urlCalls.length).toBe(callsAfterFirst);   // no new HTTP calls
    expect(out2['台積電'].closes[today]).toBe(700);
  });

  it('T7: a ticker whose fetch fails on BOTH symbols is reported with an error, never a silent 0', () => {
    const { ctx, logs } = loadGas({ urlResponses: { '9999.TW': 'throw', '9999.TWO': 'http500' } });
    const out = ctx.getQuotes_({ '故障股': '9999' });
    expect(out['故障股']).toEqual({ error: 'fetch_failed' });
    expect(out['故障股']).not.toHaveProperty('closes');
    expect(logs.some((l) => l.includes('故障股'))).toBe(true);
  });

  it('a ticker with no code is reported distinctly, also never a silent 0', () => {
    const { ctx } = loadGas();
    const out = ctx.getQuotes_({ '無代碼股': '' });
    expect(out['無代碼股']).toEqual({ error: 'no_code' });
  });

  describe('A1 — UrlFetchApp.fetchAll batching (Phase 3 audit finding)', () => {
    it('resolves N tickers in exactly 2 fetchAll batches, never one fetch per ticker', () => {
      const today = todayTaipei();
      const twOk = (sym, price) => yahooChart({ symbol: sym, sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: price } });
      const { ctx, fetchAllCalls } = loadGas({
        urlResponses: {
          '2330.TW': twOk('2330.TW', 600),     // resolves on .TW
          '2303.TW': twOk('2303.TW', 50),      // resolves on .TW
          '8299.TW?': 'http500',               // misses .TW ...
          '8299.TWO': twOk('8299.TWO', 700)    // ...resolves on .TWO
        }
      });
      const out = ctx.getQuotes_({ '台積電': '2330', '聯電': '2303', '群聯': '8299' });

      expect(out['台積電'].closes[today]).toBe(600);
      expect(out['聯電'].closes[today]).toBe(50);
      expect(out['群聯'].closes[today]).toBe(700);

      // Batch 1: all three .TW symbols in ONE fetchAll call.
      expect(fetchAllCalls.length).toBe(2);
      expect(fetchAllCalls[0]).toHaveLength(3);
      expect(fetchAllCalls[0].every((u) => u.includes('.TW?'))).toBe(true);
      // Batch 2: only the one ticker .TW missed, resolving .TWO.
      expect(fetchAllCalls[1]).toHaveLength(1);
      expect(fetchAllCalls[1][0]).toContain('8299.TWO');
    });

    it('a fully cached set makes zero fetchAll calls', () => {
      const today = todayTaipei();
      const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
      const { ctx, fetchAllCalls } = loadGas({ urlResponses: { '2330.TW': payload } });
      ctx.getQuotes_({ '台積電': '2330' });
      fetchAllCalls.length = 0;   // reset, only care about the SECOND call
      ctx.getQuotes_({ '台積電': '2330' });
      expect(fetchAllCalls.length).toBe(0);
    });

    it('a whole-batch transport failure degrades to every ticker in it reporting fetch_failed, not a crash', () => {
      const { ctx, logs } = loadGas({ fetchAllThrows: true, urlResponses: {} });
      const out = ctx.getQuotes_({ '台積電': '2330', '聯電': '2303' });
      expect(out['台積電']).toEqual({ error: 'fetch_failed' });
      expect(out['聯電']).toEqual({ error: 'fetch_failed' });
      expect(logs.length).toBeGreaterThan(0);
    });
  });

  describe('A2 — range threading + cache-key trap (Phase 3 audit finding)', () => {
    it('the cache key includes range — a 1mo entry does NOT satisfy a later 1y request for the same code', () => {
      const today = todayTaipei();
      const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
      const { ctx, cache, fetchAllCalls } = loadGas({ urlResponses: { '2330.TW': payload } });

      ctx.getQuotes_({ '台積電': '2330' }, '1mo');
      expect(fetchAllCalls.length).toBe(1);
      expect(cache._values['q_v2_2330_1mo']).toBeDefined();
      expect(cache._values['q_v2_2330_1y']).toBeUndefined();   // NOT satisfied by the 1mo entry

      fetchAllCalls.length = 0;   // reset — only care what the NEXT call does
      ctx.getQuotes_({ '台積電': '2330' }, '1y');
      // A DIFFERENT range for the SAME code must be a cache MISS — a fresh
      // fetchAll, not silently served from the '1mo' entry (A2's named trap).
      expect(fetchAllCalls.length).toBe(1);
      expect(cache._values['q_v2_2330_1y']).toBeDefined();

      // And the reverse holds too: a THIRD call at '1mo' is now served from
      // the (still-present) '1mo' cache entry, unaffected by the '1y' fetch.
      fetchAllCalls.length = 0;
      ctx.getQuotes_({ '台積電': '2330' }, '1mo');
      expect(fetchAllCalls.length).toBe(0);
    });

    it('getPricesFromSheet/recordDailySnapshot use the default 1mo range (unchanged latency profile)', () => {
      const today = todayTaipei();
      const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
      const sheets = {
        HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
        Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']]))
      };
      const { ctx, cache } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
      ctx.getPricesFromSheet([], []);
      expect(cache._values['q_v2_2330_1mo']).toBeDefined();
    });
  });

  describe('A7 — cache key carries a schema version (design.md §D.3 amendment, Phase 4 post-deploy fix)', () => {
    it('quoteCacheKey_ embeds the version constant, exactly matching what getQuotes_ actually writes', () => {
      const { ctx } = loadGas();
      expect(ctx.quoteCacheKey_('2330', '1mo')).toBe('q_v2_2330_1mo');
      expect(ctx.quoteCacheKey_('2330', '1mo')).toContain(ctx.QUOTE_CACHE_SCHEMA_VERSION);
    });

    it('a bundle cached under the OLD unversioned key is never read by the new code — always a fresh fetch', () => {
      const today = todayTaipei();
      const staleV1 = { sessionDate: today, isClosed: true, closes: { [today]: 111 } };   // pre-A5 shape: no phantomDropped
      const freshPayload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
      const { ctx, cache, fetchAllCalls } = loadGas({ urlResponses: { '2330.TW': freshPayload } });

      // Seed the cache exactly as the PRE-A7 code would have keyed it.
      cache.put('q_2330_1mo', JSON.stringify(staleV1), 21600);

      const out = ctx.getQuotes_({ '台積電': '2330' }, '1mo');

      // The old key is still sitting there, untouched (no migration/cleanup, per spec)...
      expect(cache._values['q_2330_1mo']).toBeDefined();
      // ...but it was never read: a real fetchAll happened, and the result is
      // the FRESH value, not the stale 111 a v1-key read would have returned.
      expect(fetchAllCalls.length).toBe(1);
      expect(out['台積電'].closes[today]).toBe(600);
      expect(out['台積電'].closes[today]).not.toBe(111);
      // The new call wrote under the VERSIONED key, not the old one.
      expect(cache._values['q_v2_2330_1mo']).toBeDefined();
    });

    it('the range separation A2 established still holds under the versioned key (v2_..._1mo vs v2_..._1y)', () => {
      const today = todayTaipei();
      const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
      const { ctx, cache, fetchAllCalls } = loadGas({ urlResponses: { '2330.TW': payload } });

      ctx.getQuotes_({ '台積電': '2330' }, '1mo');
      expect(cache._values['q_v2_2330_1mo']).toBeDefined();
      expect(cache._values['q_v2_2330_1y']).toBeUndefined();

      fetchAllCalls.length = 0;
      ctx.getQuotes_({ '台積電': '2330' }, '1y');
      expect(fetchAllCalls.length).toBe(1);   // still a fresh fetch, not served from the 1mo entry
      expect(cache._values['q_v2_2330_1y']).toBeDefined();
    });

    it('bumping the version constant changes the key — proves the version is load-bearing, not decorative', () => {
      const { ctx } = loadGas();
      const original = ctx.quoteCacheKey_('2330', '1mo');
      ctx.QUOTE_CACHE_SCHEMA_VERSION = 'v3';   // simulate a future bump
      const bumped = ctx.quoteCacheKey_('2330', '1mo');
      expect(bumped).not.toBe(original);
      expect(bumped).toBe('q_v3_2330_1mo');
    });
  });
});

describe('Rev 4.7 — getPricesFromSheet rewritten on getQuotes_ (design.md §D.4/§D.5)', () => {
  it("serves current under sessionDate and prevClose under 'closeyest', never touching the price/closeyest cells", () => {
    const today = todayTaipei();
    const yest = shiftDate(today, -1);
    const payload = yahooChart({
      symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
      closesByDate: { [yest]: 500, [today]: 510 }
    });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),
      // 'price'/'closeyest' cells hold obviously-stale decoy values — if the
      // rewrite ever reads them again, these numbers leak into the assertions.
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, -1, -2]]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
    const map = ctx.getPricesFromSheet([], []);
    expect(map['台積電'][today]).toBe(510);
    expect(map['台積電']['closeyest']).toBe(500);
    expect(map['台積電'][today]).not.toBe(-1);
    expect(map['台積電']['closeyest']).not.toBe(-2);
  });

  it('trims stray whitespace on both sides of the ticker name (the Rev 4.6 CHANGELOG bug)', () => {
    const today = todayTaipei();
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 640 } });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),   // trimmed key, matches getCurrentHoldings_
      Prices: makeSheet(pricesSheetRows([['台積電 ', ' 2330 ', '', '']]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
    const map = ctx.getPricesFromSheet([], []);
    expect(map['台積電']).toBeDefined();       // keyed by the TRIMMED name
    expect(map['台積電'][today]).toBe(640);
    expect(map['台積電 ']).toBeUndefined();
  });

  it('a ticker whose quote fetch fails is simply absent from the map, never priced at 0', () => {
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['故障股', 100]])),   // held, so it IS quoted (and fails)
      Prices: makeSheet(pricesSheetRows([['故障股', 9999, '', '']]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '9999.TW': 'http500', '9999.TWO': 'http500' } });
    const map = ctx.getPricesFromSheet([], []);
    expect(map['故障股']).toEqual({});   // row exists (year-end cols, if any) but no current/closeyest key
  });

  it('A1: a NON-held ticker never gets a live quote at all — 0 fetches, not just an excluded result', () => {
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),   // 鴻海 is NOT held
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', ''], ['鴻海', 2317, '', '']]))
    };
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: todayTaipei(), sessionHHMM: '1445', closesByDate: { [todayTaipei()]: 600 } });
    const { ctx, urlCalls } = loadGas({ sheets, urlResponses: { '2330.TW': payload, '2317.TW': 'http500', '2317.TWO': 'http500' } });
    ctx.getPricesFromSheet([], []);
    expect(urlCalls.some((u) => u.includes('2317'))).toBe(false);   // never even attempted
  });

  it('still serves year-end history columns straight off the sheet, untouched (Yearly chart)', () => {
    const yearEnd = new Date(Date.UTC(2023, 11, 29));
    yearEnd.getTime = yearEnd.getTime.bind(yearEnd);   // duck-typed Date check in Code.js
    const rows = pricesSheetRows([]);
    rows[0].push(yearEnd);
    rows.push(['台積電', 2330, '', '', 593]);
    const sheets = { Prices: makeSheet(rows) };
    const { ctx } = loadGas({ sheets, urlResponses: {} });
    const map = ctx.getPricesFromSheet(['台積電'], ['2023-12-29']);
    expect(map['台積電']['2023-12-29']).toBe(593);
  });

  it('A1 guard: a NON-held ticker keeps its year-end column (Yearly chart / valueAt reconstruction unaffected) '
     + 'while a HELD ticker still resolves sessionDate (client priceToday)', () => {
    const today = todayTaipei();
    const yearEnd = new Date(Date.UTC(2023, 11, 29));
    yearEnd.getTime = yearEnd.getTime.bind(yearEnd);
    const rows = pricesSheetRows([]);
    rows[0].push(yearEnd);
    rows.push(['台積電', 2330, '', '', 593]);   // held
    rows.push(['鴻海', 2317, '', '', 104]);      // NOT held — sold out historically
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 600 } });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),
      Prices: makeSheet(rows)
    };
    const { ctx, urlCalls } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

    const map = ctx.getPricesFromSheet([], []);

    // Non-held: year-end column intact, but no live quote was ever attempted.
    expect(map['鴻海']['2023-12-29']).toBe(104);
    expect(map['鴻海'][today]).toBeUndefined();
    expect(urlCalls.some((u) => u.includes('2317'))).toBe(false);

    // Held: both year-end AND the live sessionDate/closeyest keys are present —
    // this is what src/app.js's `priceToday` (max date key across all tickers)
    // resolves from.
    expect(map['台積電']['2023-12-29']).toBe(593);
    expect(map['台積電'][today]).toBe(600);
    const servedDates = [...new Set(Object.values(map).flatMap((m) => Object.keys(m)))]
      .filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    expect(servedDates.at(-1)).toBe(today);   // priceToday still resolves correctly
  });
});

describe('Rev 4.7 — recordDailySnapshot / getPricesFromSheet invariant (design.md §D.2, T5)', () => {
  it('T5: after the close, the value recordDailySnapshot writes equals what ?resource=prices serves for sessionDate', () => {
    const today = todayTaipei();
    const yest = shiftDate(today, -1);
    const payload = yahooChart({
      symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',   // settled
      closesByDate: { [yest]: 500, [today]: 523 }
    });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

    ctx.recordDailySnapshot();
    const history = sheets.DailyHistory._rows;
    expect(history[1][0]).toBe(today);
    expect(history[1][1]).toBe(1000 * 523);

    const priceMap = ctx.getPricesFromSheet(['台積電'], []);
    expect(priceMap['台積電'][today]).toBe(523);
    expect(1000 * priceMap['台積電'][today]).toBe(history[1][1]);
  });

  it('a mid-session (not-yet-closed) run writes nothing to DailyHistory', () => {
    const today = todayTaipei();
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1000', closesByDate: { [today]: 999 } });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 1000]])),
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
    ctx.recordDailySnapshot();
    expect(sheets.DailyHistory).toBeUndefined();
  });

  it('trims ticker/code whitespace and never calls getValues on the price/closeyest cells', () => {
    const today = todayTaipei();
    const payload = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [today]: 700 } });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電 ', 100]])),   // stray trailing space
      // price/closeyest cells hold decoys — a correct implementation never reads them.
      Prices: makeSheet(pricesSheetRows([[' 台積電 ', ' 2330 ', -1, -2]]))
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
    ctx.recordDailySnapshot();
    expect(sheets.DailyHistory._rows[1][1]).toBe(100 * 700);
  });
});

describe('Rev 4.7 — backfillDailySnapshots upsert-only (design.md §D.7, T6)', () => {
  it('T6: a date that already has a row is left completely unchanged', () => {
    const today = todayTaipei();
    const yest = shiftDate(today, -1);
    const payload = yahooChart({
      symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
      closesByDate: { [yest]: 500, [today]: 510 }
    });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
      // A harmless old trade — Code.js bails out early on a FULLY empty Trades
      // sheet (pre-existing guard, unrelated to Rev 4.7); this dates before
      // every test date so it's never "undone" during the backward walk.
      Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']])),
      // A pre-existing row for `today` with a value that does NOT match
      // 100 * 510 (what a fresh computation would produce) — if the backfill
      // touches it, this deliberately-wrong sentinel value changes.
      DailyHistory: makeSheet([['date', 'value'], [today, 123456]])
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

    ctx.backfillDailySnapshots(yest);

    const row = sheets.DailyHistory._rows.find((r) => r[0] === today);
    expect(row[1]).toBe(123456);   // untouched — never overwritten
  });

  it('fills a date that has no existing row', () => {
    const today = todayTaipei();
    const yest = shiftDate(today, -1);
    const payload = yahooChart({
      symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
      closesByDate: { [yest]: 500, [today]: 510 }
    });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
      // A harmless old trade — Code.js bails out early on a FULLY empty Trades
      // sheet (pre-existing guard, unrelated to Rev 4.7); this dates before
      // every test date so it's never "undone" during the backward walk.
      Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']])),
      DailyHistory: makeSheet([['date', 'value']])
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

    ctx.backfillDailySnapshots(yest);

    const rows = sheets.DailyHistory._rows;
    const todayRow = rows.find((r) => r[0] === today);
    expect(todayRow).toBeDefined();
    expect(todayRow[1]).toBe(100 * 510);
  });

  it('never calls historySheet.clear() — the destructive rebuild is gone (§D.7)', () => {
    const sheets = {};
    const { ctx } = loadGas({ sheets });
    // Spy on clear() by wrapping after loadGas creates/loads the sheet lazily via insertSheet.
    const src = fs.readFileSync('gas/Code.js', 'utf8');
    expect(src.includes('historySheet.clear()')).toBe(false);
  });

  it('trims stray whitespace on both sides of the ticker (Rev 4.6 CHANGELOG bug, backfill path)', () => {
    const today = todayTaipei();
    const yest = shiftDate(today, -1);
    const payload = yahooChart({
      symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
      closesByDate: { [yest]: 500, [today]: 510 }
    });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
      // A harmless old trade — Code.js bails out early on a FULLY empty Trades
      // sheet (pre-existing guard, unrelated to Rev 4.7); this dates before
      // every test date so it's never "undone" during the backward walk.
      Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
      // Raw Prices!A cell carries a stray trailing space, same as the real ledger.
      Prices: makeSheet(pricesSheetRows([['台積電 ', 2330, '', '']])),
      DailyHistory: makeSheet([['date', 'value']])
    };
    const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

    ctx.backfillDailySnapshots(yest);

    const todayRow = sheets.DailyHistory._rows.find((r) => r[0] === today);
    // Before the fix this ticker was valued at 0 every day (name/lookup key mismatch).
    expect(todayRow[1]).toBe(100 * 510);
  });

  it('a ticker whose fetch fails is excluded from the reconstruction, not valued at 0', () => {
    const today = todayTaipei();
    const yest = shiftDate(today, -1);
    const ok = yahooChart({ symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445', closesByDate: { [yest]: 500, [today]: 510 } });
    const sheets = {
      HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100], ['故障股', 50]])),
      // A harmless old trade — Code.js bails out early on a FULLY empty Trades
      // sheet (pre-existing guard, unrelated to Rev 4.7); this dates before
      // every test date so it's never "undone" during the backward walk.
      Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
      Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', ''], ['故障股', 9999, '', '']])),
      DailyHistory: makeSheet([['date', 'value']])
    };
    const { ctx, logs } = loadGas({
      sheets,
      urlResponses: { '2330.TW': ok, '9999.TW': 'http500', '9999.TWO': 'http500' }
    });

    ctx.backfillDailySnapshots(yest);

    const todayRow = sheets.DailyHistory._rows.find((r) => r[0] === today);
    // Only 台積電's value is included; 故障股 contributes nothing (not 50*0).
    expect(todayRow[1]).toBe(100 * 510);
    expect(logs.some((l) => l.includes('故障股'))).toBe(true);
  });

  describe('A2 — range threading + loud shortfall (Phase 3 audit finding)', () => {
    it('requests a range sized to the actual start..now span, not the 1mo default (via the cache key)', () => {
      const today = todayTaipei();
      const yearAgo = shiftDate(today, -300);   // > 93 days, <= 366 -> yahooRangeForDays_ picks '1y', not '1mo'
      const payload = yahooChart({
        symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
        closesByDate: { [shiftDate(today, -1)]: 500, [today]: 510 }
      });
      const sheets = {
        HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
        Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
        Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']])),
        DailyHistory: makeSheet([['date', 'value']])
      };
      const { ctx, cache, logs } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

      ctx.backfillDailySnapshots(yearAgo);

      // Cached under the WIDE range, not the '1mo' every other consumer uses —
      // proves the range was actually threaded through, not silently dropped.
      expect(cache._values['q_v2_2330_1mo']).toBeUndefined();
      expect(cache._values['q_v2_2330_1y']).toBeDefined();
      expect(logs.some((l) => l.includes('range=1y'))).toBe(true);
    });

    it('a short window still requests a tight range (5d), not an oversized one', () => {
      const today = todayTaipei();
      const threeDaysAgo = shiftDate(today, -3);
      const payload = yahooChart({
        symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
        closesByDate: { [shiftDate(today, -1)]: 500, [today]: 510 }
      });
      const sheets = {
        HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
        Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
        Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']])),
        DailyHistory: makeSheet([['date', 'value']])
      };
      const { ctx, cache } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
      ctx.backfillDailySnapshots(threeDaysAgo);
      expect(cache._values['q_v2_2330_5d']).toBeDefined();
    });

    it('a requested window wider than what Yahoo actually returned is reported loudly, not silently shorter', () => {
      const today = todayTaipei();
      const farBack = shiftDate(today, -60);   // asks for ~60 days of history...
      // ...but the fixture only actually has 2 days of closes (simulates Yahoo
      // not covering the full requested range, or a recently-listed ticker).
      const payload = yahooChart({
        symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
        closesByDate: { [shiftDate(today, -1)]: 500, [today]: 510 }
      });
      const sheets = {
        HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
        Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
        Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']])),
        DailyHistory: makeSheet([['date', 'value']])
      };
      const { ctx, logs } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });

      const summary = ctx.backfillDailySnapshots(farBack);

      // Dates far outside the fixture's 2-day coverage could not be priced —
      // this must be COUNTED and LOGGED, never just a quietly shorter chart.
      expect(summary.unpriceable).toBeGreaterThan(0);
      expect(summary.newRows).toBeGreaterThan(0);   // the recent days it COULD price still got written
      expect(logs.some((l) => l.includes('could NOT be') || l.includes('could not be priced'))).toBe(true);
      expect(logs.some((l) => new RegExp(summary.unpriceable + ' requested date').test(l))).toBe(true);
    });

    it('a fully-covered window reports zero unpriceable dates', () => {
      const today = todayTaipei();
      const yest = shiftDate(today, -1);
      const payload = yahooChart({
        symbol: '2330.TW', sessionDate: today, sessionHHMM: '1445',
        closesByDate: { [yest]: 500, [today]: 510 }
      });
      const sheets = {
        HeldLots: makeSheet(heldLotsSheetRows([['台積電', 100]])),
        Trades: makeSheet([['date', 'type', 'ticker', 'shares'], ['2020-01-01', 'buy', '台積電', 0]]),
        Prices: makeSheet(pricesSheetRows([['台積電', 2330, '', '']])),
        DailyHistory: makeSheet([['date', 'value']])
      };
      const { ctx } = loadGas({ sheets, urlResponses: { '2330.TW': payload } });
      const summary = ctx.backfillDailySnapshots(yest);
      expect(summary.unpriceable).toBe(0);
      expect(summary.newRows).toBe(2);
    });
  });
});

describe('Rev 4.7 — closeAsOf_ / secondsUntilNextTaipei8am_ (pure helpers)', () => {
  it('closeAsOf_ walks back to the latest trading day at-or-before the date', () => {
    const { ctx } = loadGas();
    const closes = { '2026-09-18': 100, '2026-09-15': 90 };
    expect(ctx.closeAsOf_(closes, '2026-09-18', 10)).toBe(100);
    expect(ctx.closeAsOf_(closes, '2026-09-20', 10)).toBe(100);   // weekend, falls back
    expect(ctx.closeAsOf_(closes, '2026-09-14', 10)).toBeNull();  // nothing that far back within window
  });

  it('secondsUntilNextTaipei8am_ is capped at the 6h CacheService ceiling', () => {
    const { ctx } = loadGas();
    // 09:00 Taipei -> 23h until next 08:00, must be capped to 21600.
    const now = new Date(taipeiEpochSeconds(todayTaipei(), 9, 0) * 1000);
    expect(ctx.secondsUntilNextTaipei8am_(now)).toBe(21600);
    // 07:00 Taipei -> 1h until 08:00, under the cap.
    const now2 = new Date(taipeiEpochSeconds(todayTaipei(), 7, 0) * 1000);
    expect(ctx.secondsUntilNextTaipei8am_(now2)).toBe(3600);
  });
});
