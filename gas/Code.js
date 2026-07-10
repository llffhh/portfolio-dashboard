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
    
    if (['heldlots', 'trades', 'deposits', 'dividends'].includes(resource)) {
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

function getSheetData(resource) {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const tabNameMap = {
    'heldlots': 'HeldLots',
    'trades': 'Trades',
    'deposits': 'Deposits',
    'dividends': 'Dividends'
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
  // Prices tab layout: ticker | code | price (current, GOOGLEFINANCE) | <date columns...>
  // Returned PriceMap is keyed by ticker NAME (matches HeldLots/Trades), the 'price'
  // column is keyed under today's date, and date-headed columns keep their date key.
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sheet = ss.getSheetByName('Prices');
  if (!sheet) throw new Error("No Prices sheet");

  const data = sheet.getDataRange().getValues();
  if (data.length <= 1) return {};

  // xlsx-converted spreadsheets can report a null timezone (seen in production)
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const headers = data[0];
  const priceMap = {};

  for (let i = 1; i < data.length; i++) {
    const row = data[i];
    if (row[0] === '' || row[0] == null) continue;
    const name = row[0].toString();
    const code = row[1] != null ? row[1].toString() : '';
    if (tickers.length > 0 && !tickers.includes(name) && !tickers.includes(code)) continue;

    priceMap[name] = {};
    for (let j = 1; j < headers.length; j++) {
      let key = headers[j];
      if (String(key).toLowerCase() === 'code') continue;
      if (key instanceof Date) {
        key = Utilities.formatDate(key, tz, 'yyyy-MM-dd');
      } else if (String(key).toLowerCase() === 'price') {
        key = today;
      }
      if (dates.length === 0 || dates.includes(key)) {
        const v = row[j];
        if (v !== '' && v != null && !isNaN(Number(v))) priceMap[name][key] = Number(v);
      }
    }
  }
  return priceMap;
}
