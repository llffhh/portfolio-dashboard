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
      // duck-typed Date check — `instanceof Date` is unreliable in the GAS V8 runtime
      if (key && typeof key.getTime === 'function') {
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
 * Calculates current portfolio value and appends it to the DailyHistory sheet.
 * Cleans up rows older than 365 days to maintain a rolling 1-year window.
 */
function recordDailySnapshot() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Get current portfolio value
  const heldLotsSheet = ss.getSheetByName('HeldLots');
  if (!heldLotsSheet) return;
  const heldLotsData = heldLotsSheet.getDataRange().getValues();
  if (heldLotsData.length <= 1) return;
  
  const holdings = {};
  const headers = heldLotsData[0];
  const tickerCol = headers.indexOf('ticker');
  const sharesCol = headers.indexOf('shares');
  
  for (let i = 1; i < heldLotsData.length; i++) {
    const row = heldLotsData[i];
    const ticker = row[tickerCol];
    const shares = Number(row[sharesCol]);
    if (ticker && !isNaN(shares)) {
      holdings[ticker] = (holdings[ticker] || 0) + shares;
    }
  }
  
  const pricesSheet = ss.getSheetByName('Prices');
  if (!pricesSheet) return;
  const pricesData = pricesSheet.getDataRange().getValues();
  if (pricesData.length <= 1) return;
  
  const priceHeaders = pricesData[0];
  const priceTickerCol = priceHeaders.indexOf('ticker');
  const priceValCol = priceHeaders.indexOf('price');
  
  var totalValue = 0;
  for (let i = 1; i < pricesData.length; i++) {
    const row = pricesData[i];
    const ticker = row[priceTickerCol];
    const price = Number(row[priceValCol]);
    if (ticker && holdings[ticker] !== undefined && !isNaN(price)) {
      totalValue += holdings[ticker] * price;
    }
  }
  
  // 2. Write to DailyHistory
  let historySheet = ss.getSheetByName('DailyHistory');
  if (!historySheet) {
    historySheet = ss.insertSheet('DailyHistory');
    historySheet.appendRow(['date', 'value']);
  }
  
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  
  const historyData = historySheet.getDataRange().getValues();
  let foundRow = -1;
  for (let i = 1; i < historyData.length; i++) {
    let dateVal = historyData[i][0];
    if (dateVal instanceof Date) {
      dateVal = Utilities.formatDate(dateVal, tz, 'yyyy-MM-dd');
    }
    if (dateVal === today) {
      foundRow = i + 1;
      break;
    }
  }
  
  if (foundRow !== -1) {
    historySheet.getRange(foundRow, 2).setValue(totalValue);
  } else {
    historySheet.appendRow([today, totalValue]);
  }
  
  // 3. Keep rolling 365 days (delete older rows)
  if (historySheet.getLastRow() > 2) {
    historySheet.getRange(2, 1, historySheet.getLastRow() - 1, historySheet.getLastColumn()).sort({column: 1, ascending: true});
  }
  const maxRows = 366; // header + 365 days
  const lastRow = historySheet.getLastRow();
  if (lastRow > maxRows) {
    const rowsToDelete = lastRow - maxRows;
    historySheet.deleteRows(2, rowsToDelete);
  }
}

/**
 * Reconstructs daily snapshots starting from monthsAgo months ago and writes to DailyHistory sheet.
 * @param {number} monthsAgo Number of months to backfill (default 3)
 */
function backfillDailySnapshots(monthsAgo) {
  monthsAgo = monthsAgo || 3;
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  
  // 1. Determine date range
  const tz = ss.getSpreadsheetTimeZone() || Session.getScriptTimeZone() || 'Asia/Taipei';
  const now = new Date();
  const startDate = new Date();
  startDate.setMonth(now.getMonth() - monthsAgo);
  
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
  
  // 3. Load all tickers and fetch their historical close prices
  const tickers = [];
  const pricesSheet = ss.getSheetByName('Prices');
  if (!pricesSheet) return;
  const pricesData = pricesSheet.getDataRange().getValues();
  for (let i = 1; i < pricesData.length; i++) {
    const code = pricesData[i][1];
    if (code) tickers.push(pricesData[i][0]);
  }
  
  const period1 = Math.floor(startDate.getTime() / 1000);
  const period2 = Math.floor(now.getTime() / 1000);
  
  const priceMap = {};
  const nameToCode = {};
  for (let i = 1; i < pricesData.length; i++) {
    const name = pricesData[i][0];
    const code = pricesData[i][1];
    if (name && code) nameToCode[name] = code;
  }
  
  for (const name of tickers) {
    const code = nameToCode[name];
    if (!code) continue;
    
    priceMap[name] = {};
    const symbols = [code + ".TW", code + ".TWO"];
    let success = false;
    
    for (const symbol of symbols) {
      const url = "https://query1.finance.yahoo.com/v8/finance/chart/" + symbol + "?period1=" + period1 + "&period2=" + period2 + "&interval=1d";
      try {
        const response = UrlFetchApp.fetch(url, {
          muteHttpExceptions: true,
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
        });
        
        if (response.getResponseCode() === 200) {
          const json = JSON.parse(response.getContentText());
          const result = json.chart && json.chart.result && json.chart.result[0];
          if (result && result.timestamp) {
            const timestamps = result.timestamp;
            const closePrices = result.indicators && result.indicators.quote && result.indicators.quote[0] && result.indicators.quote[0].close;
            if (closePrices) {
              for (let j = 0; j < timestamps.length; j++) {
                const dateStr = Utilities.formatDate(new Date(timestamps[j] * 1000), tz, 'yyyy-MM-dd');
                const price = closePrices[j];
                if (price != null) priceMap[name][dateStr] = price;
              }
              success = true;
            }
          }
        }
      } catch (e) {
        // Ignore
      }
      if (success) break;
    }
  }
  
  // 4. Reconstruct holdings & calculate value for each date
  let historySheet = ss.getSheetByName('DailyHistory');
  if (!historySheet) {
    historySheet = ss.insertSheet('DailyHistory');
    historySheet.appendRow(['date', 'value']);
  } else {
    historySheet.clear();
    historySheet.appendRow(['date', 'value']);
  }
  
  const dailyValues = [];
  
  for (const date of dates) {
    const holdings = {};
    for (const trade of trades) {
      if (trade.date <= date) {
        holdings[trade.ticker] = (holdings[trade.ticker] || 0) + (trade.type === 'buy' ? trade.shares : -trade.shares);
      }
    }
    
    let totalValue = 0;
    let hasPricedStock = false;
    
    for (const [ticker, shares] of Object.entries(holdings)) {
      if (shares <= 0) continue;
      
      let price = null;
      let checkDate = new Date(date);
      for (let lookback = 0; lookback < 10; lookback++) {
        const dStr = Utilities.formatDate(checkDate, tz, 'yyyy-MM-dd');
        if (priceMap[ticker] && priceMap[ticker][dStr] !== undefined) {
          price = priceMap[ticker][dStr];
          break;
        }
        checkDate.setDate(checkDate.getDate() - 1);
      }
      
      if (price !== null) {
        totalValue += shares * price;
        hasPricedStock = true;
      }
    }
    
    if (hasPricedStock) {
      dailyValues.push([date, Math.round(totalValue)]);
    }
  }
  
  if (dailyValues.length > 0) {
    historySheet.getRange(2, 1, dailyValues.length, 2).setValues(dailyValues);
  }
  
  Logger.log("Backfilled " + dailyValues.length + " daily snapshots!");
}
