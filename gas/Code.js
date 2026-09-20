/**
 * Deploy as: Execute as: Me | Who has access: Anyone
 * Access is gated by a secret API key (Script Property: API_KEY) because
 * Apps Script cannot serve authenticated cross-origin fetch() — the
 * Google-sign-in gate breaks CORS for a GitHub-Pages frontend (rev 3.1).
 * The key lives only in the user's gitignored config.js.
 */
function doGet(e) {
  var API_KEY = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!API_KEY || !e.parameter.key || e.parameter.key !== API_KEY) {
    return ContentService.createTextOutput(JSON.stringify({ error: 'unauthorized' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  try {
    const resource = e.parameter.resource;
    
    if (resource === 'prices') {
      const tickersStr = e.parameter.tickers || '';
      const datesStr = e.parameter.dates || '';
      
      const tickers = tickersStr.split(',').filter(t => t);
      const dates = datesStr.split(',').filter(d => d);
      
      // Accept ticker names (聯電) or 4-digit codes; cap count and length (S3 DoS bound)
      if (tickers.length > 50 || tickers.some(t => t.length > 20)) {
        return ContentService.createTextOutput(JSON.stringify({ error: "bad_request" }))
          .setMimeType(ContentService.MimeType.JSON);
      }
      
      const priceMap = getPricesFromSheet(tickers, dates);
      return ContentService.createTextOutput(JSON.stringify(priceMap))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    // Rev 4.2 (design.md §C.10): saved Sell Planner scenarios, synced across devices.
    if (resource === 'sellplans') {
      return jsonOut_(listSellPlans_());
    }

    if (['heldlots', 'trades', 'deposits', 'dividends', 'dailyhistory'].includes(resource)) {
      const data = getSheetData(resource);
      return ContentService.createTextOutput(JSON.stringify(data))
        .setMimeType(ContentService.MimeType.JSON);
    }
    
    return ContentService.createTextOutput(JSON.stringify({ error: "bad_request" }))
      .setMimeType(ContentService.MimeType.JSON);
      
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ error: "upstream" }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

// ---------------------------------------------------------------------------
// Rev 4.2 — Sell Planner scenarios synced to the Sheet (design.md §C.10).
//
// This is the ONLY write path in the script. It can touch exactly one tab —
// SELLPLANS_TAB — and nothing else, so the ledger tabs (HeldLots, Trades,
// Deposits, Dividends, Prices, DailyHistory) stay read-only by construction.
// The API key now also authorises writes, but only to that one tab (SP-19).
// ---------------------------------------------------------------------------
var SELLPLANS_TAB = 'SellPlans';
var SELLPLANS_HEADER = ['id', 'savedAt', 'name', 'scenario'];
var SELLPLANS_MAX_SCENARIOS = 200;   // SP-20: bound on stored scenarios
var SELLPLANS_MAX_BODY = 20000;      // SP-20: bound on one request body, in chars
var SELLPLANS_STRATEGIES = ['tagTiered', 'yieldProtect', 'proportional', 'cutLosers', 'custom'];

function jsonOut_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

// Sheets evaluates a cell that starts with = + - @ as a formula, and the scenario
// name is user-typed. A leading apostrophe forces plain text, which also stops
// Sheets reinterpreting the ISO timestamp as a date. The JSON column needs no
// guard: JSON.stringify of an object always starts with "{".
function safeCell_(v) {
  return "'" + String(v == null ? '' : v);
}

// Pure: returns a cleaned copy of the scenario, or null if anything is off.
// No Sheet access, so test/gas.sellplans.test.js exercises it in a Node sandbox.
function validateScenario_(s) {
  if (!s || typeof s !== 'object' || Array.isArray(s)) return null;
  var isStr = function (v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max; };
  if (!isStr(s.id, 64) || !/^[A-Za-z0-9_-]+$/.test(s.id)) return null;
  if (!isStr(s.name, 80)) return null;
  if (!isStr(s.savedAt, 40) || isNaN(Date.parse(s.savedAt))) return null;
  if (SELLPLANS_STRATEGIES.indexOf(s.strategyId) === -1) return null;

  var locked = s.locked == null ? [] : s.locked;
  if (!Array.isArray(locked) || locked.length > 60) return null;
  for (var k = 0; k < locked.length; k++) if (!isStr(locked[k], 20)) return null;

  if (!Array.isArray(s.rows) || s.rows.length > 60) return null;
  var isNum = function (v, lo, hi) { return typeof v === 'number' && isFinite(v) && v >= lo && v <= hi; };
  var rows = [];
  for (var i = 0; i < s.rows.length; i++) {
    var r = s.rows[i];
    if (!r || !isStr(r.ticker, 20)) return null;
    var n = r.sellShares;
    if (typeof n !== 'number' || !isFinite(n) || n < 0 || n > 1e8 || Math.floor(n) !== n) return null;
    var row = { ticker: r.ticker, sellShares: n };
    // SP-11 amendment (design.md §C.11): a row may also carry the figures it
    // was saved with (all optional, for older clients/scenarios), so a
    // position sold out of the ledger since can still be shown at its
    // save-time price/history instead of vanishing on reload.
    if (r.price != null) { if (!isNum(r.price, 0, 1e9)) return null; row.price = r.price; }
    if (r.sellPct != null) { if (!isNum(r.sellPct, 0, 1)) return null; row.sellPct = r.sellPct; }
    if (r.gross != null) { if (!isNum(r.gross, -1e12, 1e12)) return null; row.gross = r.gross; }
    if (r.tax != null) { if (!isNum(r.tax, -1e12, 1e12)) return null; row.tax = r.tax; }
    if (r.fee != null) { if (!isNum(r.fee, -1e12, 1e12)) return null; row.fee = r.fee; }
    if (r.net != null) { if (!isNum(r.net, -1e12, 1e12)) return null; row.net = r.net; }
    if (r.realizedPL != null) { if (!isNum(r.realizedPL, -1e12, 1e12)) return null; row.realizedPL = r.realizedPL; }
    if (r.realizedPLPct != null) { if (!isNum(r.realizedPLPct, -1e6, 1e6)) return null; row.realizedPLPct = r.realizedPLPct; }
    // design.md §C.14: the save-day snapshot a plan is valued from on reload.
    if (r.sellPrice != null) { if (!isNum(r.sellPrice, 0, 1e9)) return null; row.sellPrice = r.sellPrice; }
    if (r.holdShares != null) { if (!isNum(r.holdShares, 0, 1e8)) return null; row.holdShares = r.holdShares; }
    if (r.cost != null) { if (!isNum(r.cost, 0, 1e12)) return null; row.cost = r.cost; }
    rows.push(row);
  }

  var note = s.note == null ? '' : s.note;
  if (typeof note !== 'string' || note.length > 500) return null;

  var out = { id: s.id, name: s.name, savedAt: s.savedAt, strategyId: s.strategyId,
              locked: locked.slice(), rows: rows, note: note };
  if (s.netAtSave != null) {
    if (typeof s.netAtSave !== 'number' || !isFinite(s.netAtSave)) return null;
    out.netAtSave = s.netAtSave;
  }
  return out;
}

function getSellPlansSheet_(create) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sh = ss.getSheetByName(SELLPLANS_TAB);
  if (!sh && create) {
    sh = ss.insertSheet(SELLPLANS_TAB);
    sh.getRange(1, 1, 1, SELLPLANS_HEADER.length).setValues([SELLPLANS_HEADER]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function listSellPlans_() {
  var sh = getSellPlansSheet_(false);
  if (!sh || sh.getLastRow() < 2) return [];
  var values = sh.getRange(2, 1, sh.getLastRow() - 1, SELLPLANS_HEADER.length).getValues();
  var out = [];
  for (var i = 0; i < values.length; i++) {
    // A row someone hand-edited into invalid JSON is skipped, never fatal.
    try {
      var s = validateScenario_(JSON.parse(values[i][3]));
      if (s) out.push(s);
    } catch (err) { /* skip */ }
  }
  return out;
}

function findSellPlanRow_(sh, id) {
  if (sh.getLastRow() < 2) return -1;
  var ids = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
  for (var i = 0; i < ids.length; i++) {
    if (String(ids[i][0]).replace(/^'/, '') === id) return i + 2;
  }
  return -1;
}

// POST body (text/plain JSON): { key, action: 'save' | 'delete', scenario?, id? }.
// The key travels in the body, not the URL, so it stays out of request logs.
function doPost(e) {
  var body;
  try {
    var raw = e && e.postData ? e.postData.contents : '';
    if (!raw || raw.length > SELLPLANS_MAX_BODY) return jsonOut_({ error: 'bad_request' });
    body = JSON.parse(raw);
  } catch (err) {
    return jsonOut_({ error: 'bad_request' });
  }

  var API_KEY = PropertiesService.getScriptProperties().getProperty('API_KEY');
  if (!API_KEY || !body || body.key !== API_KEY) return jsonOut_({ error: 'unauthorized' });

  // Two browsers saving at once must not interleave row lookups and writes.
  var lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return jsonOut_({ error: 'upstream' });
  try {
    if (body.action === 'save') {
      var s = validateScenario_(body.scenario);
      if (!s) return jsonOut_({ error: 'bad_request' });
      var sh = getSellPlansSheet_(true);
      var row = findSellPlanRow_(sh, s.id);
      var values = [safeCell_(s.id), safeCell_(s.savedAt), safeCell_(s.name), JSON.stringify(s)];
      if (row === -1) {
        if (sh.getLastRow() - 1 >= SELLPLANS_MAX_SCENARIOS) return jsonOut_({ error: 'bad_request' });
        sh.appendRow(values);
      } else {
        sh.getRange(row, 1, 1, SELLPLANS_HEADER.length).setValues([values]);
      }
      return jsonOut_({ ok: true, id: s.id });
    }

    if (body.action === 'delete') {
      if (typeof body.id !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(body.id)) {
        return jsonOut_({ error: 'bad_request' });
      }
      var sheet = getSellPlansSheet_(false);
      var r = sheet ? findSellPlanRow_(sheet, body.id) : -1;
      if (r !== -1) sheet.deleteRow(r);
      return jsonOut_({ ok: true, id: body.id, deleted: r !== -1 });
    }

    return jsonOut_({ error: 'bad_request' });
  } catch (err) {
    return jsonOut_({ error: 'upstream' });
  } finally {
    lock.releaseLock();
  }
}

function getSheetData(resource) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabNameMap = {
    'heldlots': 'HeldLots',
    'trades': 'Trades',
    'deposits': 'Deposits',
    'dividends': 'Dividends',
    'dailyhistory': 'DailyHistory'
  };
  const sheet = ss.getSheetByName(tabNameMap[resource]);
  if (!sheet) return [];
  
  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return [];
  
  const headers = data[0];
  const results = [];
  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      // Very basic type cast. The seed is assumed to produce matching types.
      // E.g. date to string
      let val = row[j];
      if (val instanceof Date) {
        val = val.toISOString().split('T')[0];
      }
      if (val === '') val = null;
      obj[headers[j]] = val;
    }
    results.push(obj);
  }
  return results;
}

function getPricesFromSheet(tickers, dates) {
  // Called by doGet with parsed query params; default them so running this
  // directly from the editor (no arguments) returns everything instead of
  // throwing on `undefined.length`.
  tickers = tickers || [];
  dates = dates || [];
  // Rev 4.7 (design.md §D.5): Prices tab layout is now ticker | code | price
  // | closeyest | <year-end date columns...>, but 'price'/'closeyest' are
  // stale formula columns — NEVER read here. 'current' (under sessionDate)
  // and 'prevClose' (under 'closeyest') come from getQuotes_ instead, so this
  // is the same one Yahoo response every other consumer derives its figure
  // from (§D.2 invariant). Year-end columns are untouched — they still feed
  // the Yearly chart straight off the sheet.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Prices');
  if (!sheet) throw new Error("No Prices sheet");

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return {};

  // xlsx-converted spreadsheets can report a null timezone (seen in production)
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';
  const headers = data[0];
  const priceMap = {};
  const tickerCodeMap = {};   // ticker NAME -> code, fed to getQuotes_ below

  // Phase 3 audit finding A1: a live quote is only ever needed for a
  // CURRENTLY HELD ticker — Current Value, Yesterday Value, the holdings
  // table and the Sell Planner all iterate HeldLots, and the Yearly chart's
  // year-end prices come straight off the sheet (the loop below), never from
  // getQuotes_. A ticker that was sold out still gets its year-end columns
  // here; it just doesn't cost a live Yahoo fetch it can't use.
  const heldTickers = getCurrentHoldings_(ss) || {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === '' || row[0] == null) continue;
    // Ticker strings in this ledger carry stray trailing spaces (e.g. '台積電 ') —
    // trim both sides, matching getCurrentHoldings_, or this row's live quote
    // silently fails to line up with the holdings/HeldLots key and is dropped.
    const name = row[0].toString().trim();
    const code = row[1] != null ? row[1].toString().trim() : '';
    if (tickers.length > 0 && !tickers.includes(name) && !tickers.includes(code)) continue;

    priceMap[name] = {};
    if (code && heldTickers[name] !== undefined) tickerCodeMap[name] = code;

    for (let j = 1; j < headers.length; j++) {
      let key = headers[j];
      const keyLower = String(key).toLowerCase();
      if (keyLower === 'code' || keyLower === 'price' || keyLower === 'closeyest') continue;
      // duck-typed Date check — `instanceof Date` is unreliable in the GAS V8 runtime
      if (key && typeof key.getTime === 'function') {
        key = Utilities.formatDate(key, tz, 'yyyy-MM-dd');
      }
      if (dates.length === 0 || dates.includes(key)) {
        const v = row[j];
        if (v !== '' && v != null && !isNaN(Number(v))) priceMap[name][key] = Number(v);
      }
    }
  }

  // One Yahoo chart fetch per ticker (§D.1) feeds current + prevClose together,
  // so Current Value and Yesterday Value always come from the same bundle.
  const quotes = getQuotes_(tickerCodeMap);
  const fetchErrors = [];
  for (const name in tickerCodeMap) {
    const bundle = quotes[name];
    if (!bundle || bundle.error) {
      // Never silently valued at 0 — the ticker's keys are simply absent, same
      // as any other "no price for this ticker" case the UI already handles.
      fetchErrors.push(name);
      continue;
    }
    const current = currentOf(bundle);
    if (current != null && (dates.length === 0 || dates.includes(bundle.sessionDate))) {
      priceMap[name][bundle.sessionDate] = current;
    }
    const prev = prevCloseOf(bundle);
    if (prev != null && (dates.length === 0 || dates.includes('closeyest'))) {
      priceMap[name]['closeyest'] = prev;
    }
  }
  if (fetchErrors.length > 0) {
    Logger.log('getPricesFromSheet: quote fetch failed for: ' + fetchErrors.join(', '));
  }

  return priceMap;
}

// ---------------------------------------------------------------------------
// Rev 4.7 — Unified price service (design.md §D).
//
// One Yahoo `chart` request per ticker (§D.1). Current Value, Yesterday Value
// and the DailyHistory snapshot all read out of the SAME `closes` array on the
// SAME bundle, never a `meta` price field — `meta.chartPreviousClose` was
// verified range-dependent (§D.1) and must never be used for Yesterday Value.
// ---------------------------------------------------------------------------

var PRICE_CACHE_LIVE_TTL = 300;     // §D.3: seconds, while the session is open
var PRICE_CACHE_MAX_TTL = 21600;    // CacheService's hard per-put ceiling (6h)

// Pure: builds a QuoteBundle from one already-fetched Yahoo `chart` JSON
// payload. No network/Sheet access, so this is exercised directly in a Node
// sandbox (test/gas.priceservice.test.js) against captured payloads.
function parseQuoteResponse_(json, tz) {
  var result = json && json.chart && json.chart.result && json.chart.result[0];
  if (!result || !result.meta || !result.meta.regularMarketTime || !result.timestamp) return null;

  var quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
  var closeArr = quote && quote.close;
  if (!closeArr) return null;

  var closes = {};
  for (var i = 0; i < result.timestamp.length; i++) {
    var c = closeArr[i];
    if (c == null) continue;   // null closes dropped (T1)
    var d = Utilities.formatDate(new Date(result.timestamp[i] * 1000), tz, 'yyyy-MM-dd');
    closes[d] = c;
  }

  var sessionTs = new Date(result.meta.regularMarketTime * 1000);
  var sessionDate = Utilities.formatDate(sessionTs, tz, 'yyyy-MM-dd');
  // TWSE/TPEx close 13:30 Taipei; isClosed is ALWAYS judged on Taipei local
  // time regardless of `tz` (the sheet's timezone) — the exchange doesn't
  // move (T2).
  var hhmm = Utilities.formatDate(sessionTs, 'Asia/Taipei', 'HHmm');
  var isClosed = Number(hhmm) >= 1330;

  return { sessionDate: sessionDate, isClosed: isClosed, closes: closes };
}

// Pure (T3): current = closes[sessionDate], per §D.1 — never meta.regularMarketPrice.
function currentOf(bundle) {
  return bundle && bundle.closes ? bundle.closes[bundle.sessionDate] : null;
}

// Pure (T4): prevClose = close of the latest date strictly before sessionDate.
// Deliberately reads only `bundle.closes` — a QuoteBundle carries no `meta`
// field at all, so there is nothing here that could accidentally reach
// meta.chartPreviousClose (verified range-dependent, §D.1 — must never be used).
function prevCloseOf(bundle) {
  if (!bundle || !bundle.closes) return null;
  var before = Object.keys(bundle.closes).filter(function (d) { return d < bundle.sessionDate; }).sort();
  if (before.length === 0) return null;
  return bundle.closes[before[before.length - 1]];
}

// Pure: close as of a given calendar date, walking back up to `maxLookback`
// days to the latest trading day at-or-before it (weekends/holidays have no
// entry in `closes`). Used by backfillDailySnapshots' historical reconstruction.
function closeAsOf_(closes, dateStr, maxLookback) {
  if (!closes) return null;
  var base = Date.UTC(
    Number(dateStr.slice(0, 4)), Number(dateStr.slice(5, 7)) - 1, Number(dateStr.slice(8, 10))
  );
  for (var lb = 0; lb <= maxLookback; lb++) {
    var key = new Date(base - lb * 86400000).toISOString().slice(0, 10);
    if (closes[key] !== undefined) return closes[key];
  }
  return null;
}

// Pure: normalizes a Prices-tab code cell the same way the old backfill loop did
// (numeric cell -> string, zero-padded to 4 digits).
function normalizeQuoteCode_(code) {
  if (code == null || code === '') return '';
  if (typeof code === 'number') code = code.toFixed(0);
  code = String(code).trim();
  if (code.length === 2) code = '00' + code;
  if (code.length === 3) code = '0' + code;
  return code;
}

// Pure given `now`: seconds from `now` until the next 08:00 Asia/Taipei,
// capped to CacheService's 6-hour ceiling. A settled close is valid far
// longer than that, but the cap costs nothing beyond one extra Yahoo request
// after it expires — the next fetch re-derives the identical value.
function secondsUntilNextTaipei8am_(now) {
  var hh = Number(Utilities.formatDate(now, 'Asia/Taipei', 'HH'));
  var mm = Number(Utilities.formatDate(now, 'Asia/Taipei', 'mm'));
  var ss = Number(Utilities.formatDate(now, 'Asia/Taipei', 'ss'));
  var sinceMidnight = hh * 3600 + mm * 60 + ss;
  var untilEight = 8 * 3600 - sinceMidnight;
  if (untilEight <= 0) untilEight += 86400;
  return Math.min(untilEight, PRICE_CACHE_MAX_TTL);
}

// Default Yahoo `range` token when a caller doesn't need anything wider than
// current + prevClose (§D.1's primary use). A completely bare request (no
// params at all) was verified 2026-09-20 to return 1-MINUTE intraday bars for
// a SINGLE day — every timestamp collapses onto today's date, so `closes`
// never has an earlier date and prevCloseOf_ always returns null.
// `range=1mo&interval=1d` returns ~21 real trading days of one-bar-per-day
// closes plus a valid meta.regularMarketTime. D.1's "chartPreviousClose is
// range-dependent" finding is about that META field specifically; it doesn't
// apply here because nothing in this file ever reads
// meta.chartPreviousClose/meta.previousClose/meta.regularMarketPrice — only
// `closes`, per the hard constraint.
var DEFAULT_QUOTE_RANGE = '1mo';

// Ordered widest-enough Yahoo `range` token for a span of calendar days.
// Pure — used by backfillDailySnapshots (Phase 3 audit finding A2) to request
// only as much history as the caller's actual date window needs, instead of
// every consumer being hardcoded to the same narrow default.
function yahooRangeForDays_(days) {
  var table = [[5, '5d'], [31, '1mo'], [93, '3mo'], [186, '6mo'], [366, '1y'], [731, '2y'], [1826, '5y']];
  for (var i = 0; i < table.length; i++) if (days <= table[i][0]) return table[i][1];
  return '10y';
}

// Pure: the CacheService key for one ticker's quote. MUST include `range` —
// a `1mo` entry must never satisfy a `1y` request (Phase 3 audit finding A2's
// named trap) or a backfill silently gets a month of history from a stale
// live-lookup cache entry instead of the year it asked for.
function quoteCacheKey_(code, range) {
  return 'q_' + code + '_' + range;
}

// Impure: one batch of Yahoo `chart` fetches via UrlFetchApp.fetchAll (Phase 3
// audit finding A1 — replaces N sequential UrlFetchApp.fetch calls with one
// parallel round trip). Returns an array the same length/order as `symbols`;
// an entry is the parsed QuoteBundle, or null if that symbol's fetch/parse
// failed. A transport-level failure of the WHOLE batch (fetchAll itself
// throwing) degrades to "every symbol in this batch failed", never a crash.
function fetchQuoteBatch_(symbols, range, tz) {
  if (symbols.length === 0) return [];
  var requests = symbols.map(function (sym) {
    return {
      url: 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym + '?range=' + range + '&interval=1d',
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    };
  });
  var responses;
  try {
    responses = UrlFetchApp.fetchAll(requests);
  } catch (e) {
    return symbols.map(function () { return null; });
  }
  return responses.map(function (response) {
    try {
      if (!response || response.getResponseCode() !== 200) return null;
      return parseQuoteResponse_(JSON.parse(response.getContentText()), tz);
    } catch (e) {
      return null;
    }
  });
}

/**
 * getQuotes_(tickerCodeMap[, range]) — design.md §D.1, Phase 3 audit A1/A2.
 *
 * Batches every ticker's `.TW` attempt into ONE `UrlFetchApp.fetchAll`, then
 * a SECOND `fetchAll` for just the tickers that missed (those resolve on
 * `.TWO`) — two parallel round trips instead of one sequential fetch per
 * ticker. Every consumer (getPricesFromSheet, recordDailySnapshot,
 * backfillDailySnapshots) calls this and derives current/prevClose/history
 * from the same bundle, closing the gap described in §D.0.
 *
 * @param {Object<string,string>} tickerCodeMap ticker NAME -> 4-digit code.
 * @param {string} [range] Yahoo `range` token; defaults to DEFAULT_QUOTE_RANGE
 *   ('1mo' — enough for current/prevClose). backfillDailySnapshots passes a
 *   wider one sized to its actual requested window (A2).
 * @return {Object<string, QuoteBundle|{error:string}>} one entry per input
 *   ticker. A ticker whose fetch failed gets `{error:'fetch_failed'}` —
 *   NEVER a silently-zero price (§D hard constraint, T7).
 */
function getQuotes_(tickerCodeMap, range) {
  range = range || DEFAULT_QUOTE_RANGE;
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';
  var cache = CacheService.getScriptCache();
  var now = new Date();
  var out = {};

  // Resolve codes + serve whatever's already cached; everything left over is
  // one batch of work, not N.
  var pending = [];   // { ticker, code, cacheKey }
  for (var ticker in tickerCodeMap) {
    if (!Object.prototype.hasOwnProperty.call(tickerCodeMap, ticker)) continue;
    var code = normalizeQuoteCode_(tickerCodeMap[ticker]);
    if (!code) { out[ticker] = { error: 'no_code' }; continue; }

    var cacheKey = quoteCacheKey_(code, range);
    var cached = cache ? cache.get(cacheKey) : null;
    if (cached) {
      try { out[ticker] = JSON.parse(cached); continue; } catch (e) { /* corrupt cache entry — refetch below */ }
    }
    pending.push({ ticker: ticker, code: code, cacheKey: cacheKey });
  }
  if (pending.length === 0) return out;

  function cacheAndStore(p, bundle, symbol) {
    bundle.code = p.code;
    bundle.symbol = symbol;
    out[p.ticker] = bundle;
    if (cache) {
      var ttl = bundle.isClosed ? secondsUntilNextTaipei8am_(now) : PRICE_CACHE_LIVE_TTL;
      try { cache.put(p.cacheKey, JSON.stringify(bundle), ttl); } catch (e) { /* value too large / cache unavailable — non-fatal */ }
    }
  }

  // Batch 1: every pending ticker's .TW symbol.
  var twSymbols = pending.map(function (p) { return p.code + '.TW'; });
  var twResults = fetchQuoteBatch_(twSymbols, range, tz);

  var needTwo = [];
  for (var i = 0; i < pending.length; i++) {
    var bundle = twResults[i];
    if (bundle) cacheAndStore(pending[i], bundle, pending[i].code + '.TW');
    else needTwo.push(pending[i]);
  }
  if (needTwo.length === 0) return out;

  // Batch 2: only the tickers .TW missed — this is the TPEx (.TWO) set.
  var twoSymbols = needTwo.map(function (p) { return p.code + '.TWO'; });
  var twoResults = fetchQuoteBatch_(twoSymbols, range, tz);

  for (var j = 0; j < needTwo.length; j++) {
    var bundle2 = twoResults[j];
    if (bundle2) {
      cacheAndStore(needTwo[j], bundle2, needTwo[j].code + '.TWO');
    } else {
      out[needTwo[j].ticker] = { error: 'fetch_failed' };
      Logger.log('getQuotes_: fetch failed for ' + needTwo[j].ticker + ' (' + needTwo[j].code + ')');
    }
  }
  return out;
}

/**
 * Fetches current or historical price for Taiwan stock from Yahoo Finance.
 * Supports both TWSE (.TW) and TPEx (.TWO) stocks.
 * @param {string} code Ticker code (e.g., "8299" or "2330")
 * @param {string} dateStr Optional date string "YYYY-MM-DD" for historical price. If omitted, returns current price.
 * @return {number} The stock price.
 * @customfunction
 */
function GET_TAIWAN_STOCK_PRICE(code, dateStr) {
  if (!code) return "";
  code = String(code).trim();
  
  // Try both .TW and .TWO symbols
  var symbols = [code + ".TW", code + ".TWO"];
  var price = null;
  
  // Determine date window if dateStr is provided
  var period1, period2;
  var isYesterday = false;
  if (dateStr) {
    if (String(dateStr).trim().toLowerCase() === "closeyest") {
      isYesterday = true;
    } else {
      var date = new Date(dateStr);
      // Use a 5-day window ending on the target date to ensure we hit a trading day (handles weekends)
      period2 = Math.floor(date.getTime() / 1000) + 86400; // end date (exclusive in Yahoo)
      period1 = period2 - (5 * 86400); // 5 days back
    }
  }
  
  for (var i = 0; i < symbols.length; i++) {
    var symbol = symbols[i];
    var url = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol;
    if (dateStr && !isYesterday) {
      url += "?period1=" + period1 + "&period2=" + period2 + "&interval=1d";
    }
    
    try {
      var response = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
        }
      });
      
      if (response.getResponseCode() === 200) {
        var json = JSON.parse(response.getContentText());
        var result = json.chart && json.chart.result && json.chart.result[0];
        if (result) {
          if (dateStr) {
            if (isYesterday) {
              price = result.meta.chartPreviousClose || result.meta.previousClose;
            } else {
              var indicators = result.indicators && result.indicators.quote && result.indicators.quote[0];
              var closePrices = indicators && indicators.close;
              if (closePrices && closePrices.length > 0) {
                // Find the last non-null close price in the period window
                for (var j = closePrices.length - 1; j >= 0; j--) {
                  if (closePrices[j] != null) {
                    price = closePrices[j];
                    break;
                  }
                }
              }
            }
          } else {
            price = result.meta.regularMarketPrice;
          }
        }
      }
    } catch (e) {
      // Ignore and try the next symbol
    }
    
    if (price !== null) break;
  }
  
  return price !== null ? price : "";
}

/**
 * Current share count per ticker, from the HeldLots sheet. Ticker strings are
 * trimmed — the source ledger contains stray trailing spaces ('台積電 ').
 */
function getCurrentHoldings_(ss) {
  const sh = ss.getSheetByName('HeldLots');
  if (!sh) return null;
  const data = sh.getDataRange().getValues();
  if (data.length <= 1) return null;
  const hdr = data[0];
  const tCol = hdr.indexOf('ticker'), sCol = hdr.indexOf('shares');
  if (tCol < 0 || sCol < 0) return null;
  const out = {};
  for (let i = 1; i < data.length; i++) {
    const t = data[i][tCol];
    const n = Number(data[i][sCol]);
    if (t && !isNaN(n)) {
      const k = String(t).trim();
      out[k] = (out[k] || 0) + n;
    }
  }
  return out;
}

/**
 * Length of the DailyHistory rolling window, in days. Both the backfill's
 * default start and the prune in recordDailySnapshot derive from this, so the
 * two cannot drift apart (a backfill wider than the window is deleted by the
 * next snapshot run; a narrower one never fills the chart).
 */
var HISTORY_WINDOW_DAYS = 365;

/**
 * Calculates current portfolio value and appends it to the DailyHistory sheet.
 * Cleans up rows older than 365 days to maintain a rolling 1-year window.
 *
 * Rev 4.7 (design.md §D): reads getQuotes_ exclusively — it never calls
 * getValues() on the Prices tab's 'price'/'closeyest' columns (§D.5), and the
 * value written is `closes[sessionDate]` of the same bundle `?resource=prices`
 * serves, gated on `isClosed` so a mid-session run can't stamp a half-formed
 * value onto today's row (§D.2).
 */
function recordDailySnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Get current holdings + their codes (ticker/code columns only — never
  //    the 'price'/'closeyest' cells, per §D.5).
  const holdings = getCurrentHoldings_(ss);
  if (!holdings) return;

  const pricesSheet = ss.getSheetByName('Prices');
  if (!pricesSheet) return;
  const pricesData = pricesSheet.getDataRange().getValues();
  if (pricesData.length <= 1) return;

  const tickerCodeMap = {};
  for (let i = 1; i < pricesData.length; i++) {
    const name = pricesData[i][0] != null ? pricesData[i][0].toString().trim() : '';
    const code = pricesData[i][1] != null ? pricesData[i][1].toString().trim() : '';
    if (name && code && holdings[name] !== undefined) tickerCodeMap[name] = code;
  }
  if (Object.keys(tickerCodeMap).length === 0) return;

  const quotes = getQuotes_(tickerCodeMap);

  // Every TWSE/TPEx ticker shares one exchange session, so the first bundle
  // that resolved is representative of session date/closed-ness for the whole
  // snapshot (this replaces the old single-ticker 2330 probe).
  let sessionDate = null, isClosed = false, gotBundle = false;
  const fetchErrors = [];
  var totalValue = 0;
  for (const ticker in tickerCodeMap) {
    const bundle = quotes[ticker];
    if (!bundle || bundle.error) { fetchErrors.push(ticker); continue; }
    if (!gotBundle) { sessionDate = bundle.sessionDate; isClosed = bundle.isClosed; gotBundle = true; }
    const price = currentOf(bundle);
    // Never silently valued at 0 — a failed/priceless ticker is just excluded
    // from the sum, same as every other "no price" case in this codebase.
    if (price != null) totalValue += holdings[ticker] * price;
  }
  if (fetchErrors.length > 0) {
    Logger.log('recordDailySnapshot: quote fetch failed for: ' + fetchErrors.join(', '));
  }
  if (!gotBundle) return;   // every fetch failed — nothing trustworthy to record

  if (!isClosed) {
    // Mid-session: closes[sessionDate] is the live in-progress bar (§D.2,
    // user's choice 2026-09-20 — live intraday). Writing it here would stamp
    // an unsettled value onto today's row. Skip; the after-close run records
    // it properly.
    return;
  }
  const stampDate = sessionDate;

  // 2. Write to DailyHistory
  let historySheet = ss.getSheetByName('DailyHistory');
  if (!historySheet) {
    historySheet = ss.insertSheet('DailyHistory');
    historySheet.appendRow(['date', 'value']);
  }

  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';

  const historyData = historySheet.getDataRange().getValues();
  let foundRow = -1;
  for (let i = 1; i < historyData.length; i++) {
    let dateVal = historyData[i][0];
    // duck-typed: V8 `instanceof Date` is unreliable across GAS contexts
    if (dateVal && typeof dateVal.getTime === 'function') {
      dateVal = Utilities.formatDate(dateVal, tz, 'yyyy-MM-dd');
    }
    if (dateVal === stampDate) {
      foundRow = i + 1;
      break;
    }
  }

  // Upsert, so re-running the same day rewrites the row instead of duplicating it.
  if (foundRow !== -1) {
    historySheet.getRange(foundRow, 2).setValue(totalValue);
  } else {
    historySheet.appendRow([stampDate, totalValue]);
  }
  
  // 3. Keep rolling 365 days (delete older rows)
  if (historySheet.getLastRow() > 2) {
    historySheet.getRange(2, 1, historySheet.getLastRow() - 1, historySheet.getLastColumn()).sort({column: 1, ascending: true});
  }
  const maxRows = HISTORY_WINDOW_DAYS + 1; // header + window
  const lastRow = historySheet.getLastRow();
  if (lastRow > maxRows) {
    const rowsToDelete = lastRow - maxRows;
    historySheet.deleteRows(2, rowsToDelete);
  }
}

/**
 * Reconstructs daily snapshots and writes them to the DailyHistory sheet.
 *
 * Default start is a trailing HISTORY_WINDOW_DAYS (365) — the same window the
 * prune maintains, so one run fills the chart exactly.
 *
 * Phase 3 audit finding A2: the Yahoo `range` requested from getQuotes_ is now
 * sized to the ACTUAL start..now span (yahooRangeForDays_), not a hardcoded
 * default meant for a same-day current/prevClose lookup — a 365-day window
 * asks for `range=1y`, not the `1mo` every other caller needs. If Yahoo still
 * doesn't cover everything asked for (e.g. a very old start date, or a
 * recently-listed ticker), that shortfall is logged with an exact count
 * instead of silently writing fewer rows than requested (§D — the whole
 * point of this revision is no more silent shortfalls).
 *
 * @param {number|string} [start] Omit for the trailing 365-day window; a number
 *        = that many months back (legacy); a 'YYYY-MM-DD' string = explicit
 *        start (note: anything older than the window is trimmed by the next
 *        recordDailySnapshot run unless HISTORY_WINDOW_DAYS is raised too).
 * @return {{newRows:number, existingUntouched:number, unpriceable:number}}
 *   Summary for tests / manual runs; GAS triggers ignore the return value.
 */
function backfillDailySnapshots(start) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();

  // 1. Determine date range
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';
  const now = new Date();
  let startDate;
  if (typeof start === 'number' && start > 0) {
    startDate = new Date();
    startDate.setMonth(now.getMonth() - start);          // legacy: months back
  } else if (typeof start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(start)) {
    const p = start.split('-');
    startDate = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  } else {
    // Default: trailing HISTORY_WINDOW_DAYS, matching the prune exactly, so a
    // fresh backfill fills the window and nothing it writes is trimmed.
    startDate = new Date(now.getTime());
    startDate.setDate(startDate.getDate() - (HISTORY_WINDOW_DAYS - 1));
  }
  // A2: request exactly as much Yahoo history as this window needs — the
  // default 1mo every other caller uses would silently starve anything wider.
  const spanDays = Math.max(1, Math.ceil((now.getTime() - startDate.getTime()) / 86400000));
  const quoteRange = yahooRangeForDays_(spanDays);

  Logger.log('Backfilling from ' + Utilities.formatDate(startDate, tz, 'yyyy-MM-dd')
             + ' to ' + Utilities.formatDate(now, tz, 'yyyy-MM-dd')
             + ' (' + spanDays + ' day(s), requesting Yahoo range=' + quoteRange + ')');

  const dates = [];
  let curr = new Date(startDate);
  while (curr <= now) {
    dates.push(Utilities.formatDate(new Date(curr), tz, 'yyyy-MM-dd'));
    curr.setDate(curr.getDate() + 1);
  }
  
  // 2. Load Trades
  const tradesSheet = ss.getSheetByName('Trades');
  if (!tradesSheet) return;
  const tradesData = tradesSheet.getDataRange().getValues();
  if (tradesData.length <= 1) return;
  
  const tradesHeaders = tradesData[0];
  const tDateCol = tradesHeaders.indexOf('date');
  const tTypeCol = tradesHeaders.indexOf('type');
  const tTickerCol = tradesHeaders.indexOf('ticker');
  const tSharesCol = tradesHeaders.indexOf('shares');
  
  const trades = [];
  for (let i = 1; i < tradesData.length; i++) {
    const row = tradesData[i];
    let dVal = row[tDateCol];
    if (dVal instanceof Date) dVal = Utilities.formatDate(dVal, tz, 'yyyy-MM-dd');
    trades.push({
      date: dVal,
      type: row[tTypeCol],
      ticker: row[tTickerCol],
      shares: Number(row[tSharesCol])
    });
  }
  
  // 3. Load ticker->code map (trimmed both sides — §D fix: the old version
  //    keyed priceMap by the RAW Prices!A cell but the reconstruction below
  //    looks it up with a trimmed ticker, so any name with a stray space
  //    (e.g. '台積電 ') was silently valued at 0 on every day) and fetch each
  //    one's quote bundle via getQuotes_ (§D.1) — one Yahoo request per
  //    ticker, same as every other consumer, instead of this function's own
  //    bespoke period1/period2 fetch loop.
  const pricesSheet = ss.getSheetByName('Prices');
  if (!pricesSheet) return;
  const pricesData = pricesSheet.getDataRange().getValues();
  const tickerCodeMap = {};
  for (let i = 1; i < pricesData.length; i++) {
    const name = pricesData[i][0] != null ? pricesData[i][0].toString().trim() : '';
    const code = pricesData[i][1] != null ? pricesData[i][1].toString().trim() : '';
    if (name && code) tickerCodeMap[name] = code;
  }
  if (Object.keys(tickerCodeMap).length === 0) return;

  const quotes = getQuotes_(tickerCodeMap, quoteRange);
  const priceMap = {};       // ticker -> closes (from each ticker's own bundle)
  const fetchErrors = [];
  for (const name in tickerCodeMap) {
    const bundle = quotes[name];
    if (!bundle || bundle.error) { fetchErrors.push(name); continue; }  // never a silent 0 (T7)
    priceMap[name] = bundle.closes;
  }
  if (fetchErrors.length > 0) {
    Logger.log('backfillDailySnapshots: quote fetch failed for: ' + fetchErrors.join(', '));
  }

  // 4. Reconstruct holdings & calculate value for each date that has NO
  //    existing DailyHistory row. Rev 4.7 (§D.7): the destructive clear() is
  //    gone — this can never again overwrite a value recordDailySnapshot (or
  //    a prior backfill) already committed; existing rows are fix-forward.
  let historySheet = ss.getSheetByName('DailyHistory');
  if (!historySheet) {
    historySheet = ss.insertSheet('DailyHistory');
    historySheet.appendRow(['date', 'value']);
  }

  const existingRows = historySheet.getDataRange().getValues();
  const existingDates = new Set();
  for (let i = 1; i < existingRows.length; i++) {
    let d = existingRows[i][0];
    if (d && typeof d.getTime === 'function') d = Utilities.formatDate(d, tz, 'yyyy-MM-dd');
    if (d) existingDates.add(String(d));
  }

  // Positions are derived by walking BACKWARDS from today's known holdings,
  // undoing each trade as we step past its date — not forwards from zero.
  // The Trades sheet does not reconcile with HeldLots (missing buys/sells), so
  // a forward replay is wrong on EVERY day by the size of that gap. Anchoring
  // to HeldLots makes today exact by construction and confines any ledger gap
  // to the days before the trade it belongs to.
  const anchor = getCurrentHoldings_(ss);
  if (!anchor) { Logger.log('No HeldLots — cannot anchor the reconstruction.'); return; }

  const desc = trades.filter(t => t.date && !isNaN(t.shares))
                     .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  const holdings = {};
  for (const k in anchor) holdings[k] = anchor[k];

  let ti = 0;                       // index into `desc`, advances monotonically
  const newRows = [];               // collected newest -> oldest, reversed before writing
  const unpriceableDates = [];      // A2: dates this run was asked to fill but couldn't price at all
  for (let i = dates.length - 1; i >= 0; i--) {
    const date = dates[i];
    if (existingDates.has(date)) continue;   // §D.7: never touch a date that already has a row

    // undo everything traded strictly after this date
    while (ti < desc.length && desc[ti].date > date) {
      const tr = desc[ti];
      const tk = String(tr.ticker).trim();
      holdings[tk] = (holdings[tk] || 0) - (tr.type === 'buy' ? tr.shares : -tr.shares);
      ti++;
    }

    let totalValue = 0;
    let hasPricedStock = false;

    for (const [ticker, shares] of Object.entries(holdings)) {
      if (shares <= 0) continue;
      const price = closeAsOf_(priceMap[ticker], date, 10);
      if (price != null) {
        totalValue += shares * price;
        hasPricedStock = true;
      }
    }

    if (hasPricedStock) {
      newRows.push([date, Math.round(totalValue)]);
    } else {
      // A2: no held ticker had a close within lookback of this date — most
      // likely it falls outside what `quoteRange` actually returned. Loud,
      // not a quietly-shorter chart.
      unpriceableDates.push(date);
    }
  }
  newRows.reverse();   // oldest -> newest

  if (newRows.length > 0) {
    historySheet.getRange(historySheet.getLastRow() + 1, 1, newRows.length, 2).setValues(newRows);
    // Keep the sheet sorted by date so the chart and the rolling-window prune
    // (recordDailySnapshot) still see it in order after these appends.
    const lastRow = historySheet.getLastRow();
    if (lastRow > 2) {
      historySheet.getRange(2, 1, lastRow - 1, historySheet.getLastColumn()).sort({ column: 1, ascending: true });
    }
  }

  if (unpriceableDates.length > 0) {
    // A2: loud, not silent — exactly which requested dates this run could not
    // price, so a start date wider than `quoteRange` actually covers is
    // visible in the log instead of just producing a shorter chart.
    Logger.log('backfillDailySnapshots: ' + unpriceableDates.length + ' requested date(s) could NOT be '
               + 'priced (no held ticker had a close within 10 days, i.e. outside range=' + quoteRange
               + "'s coverage or before market data existed): "
               + unpriceableDates.slice(0, 10).join(', ')
               + (unpriceableDates.length > 10 ? ', ...' : ''));
  }
  Logger.log('Backfilled ' + newRows.length + ' new daily snapshot(s); '
             + existingDates.size + ' existing row(s) left untouched; '
             + unpriceableDates.length + ' requested date(s) could not be priced.');

  return { newRows: newRows.length, existingUntouched: existingDates.size, unpriceable: unpriceableDates.length };
}

/**
 * Installs the daily snapshot trigger at 18:00–19:00 (Apps Script fires at an
 * arbitrary minute inside the hour). Run this ONCE from the editor.
 *
 * 18:00 is chosen for margin, not precision: TWSE closes 13:30, quotes are ~20
 * min delayed, and GOOGLEFINANCE recalculates on its own schedule after that.
 *
 * NOTE: the hour is interpreted in the APPS SCRIPT PROJECT's timezone, not the
 * spreadsheet's. Confirm Project Settings → Time zone is (GMT+08:00) Taipei,
 * or this fires at the wrong local time. Logs the timezone so you can check.
 */
function setupDailySnapshotTrigger() {
  const existing = ScriptApp.getProjectTriggers();
  for (const t of existing) {
    if (t.getHandlerFunction() === 'recordDailySnapshot') {
      ScriptApp.deleteTrigger(t);   // avoid stacking duplicates on re-run
    }
  }
  ScriptApp.newTrigger('recordDailySnapshot')
    .timeBased()
    .atHour(18)
    .everyDays(1)
    .create();
  Logger.log('Trigger installed: recordDailySnapshot daily 18:00-19:00');
  Logger.log('Script timezone is: ' + Session.getScriptTimeZone() + '  (must be Asia/Taipei)');
}
