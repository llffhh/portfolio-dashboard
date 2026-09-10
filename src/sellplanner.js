// Rev 4.0 Sell Planner engine (design.md Section C).
// Pure functions, no I/O, no DOM — mirrors the style of metrics.js.
// Scope boundary (binding): segment tags describe what a company MAKES.
// Nothing here forecasts price or return; no strategy is "recommended".

// SP-10: the single place the goal changes.
export const TARGET_NET = 2_000_000;

// C.6: 晶電 was delisted / merged into 富采; GOOGLEFINANCE can still serve a
// stale quote for it, so it is force-excluded regardless of price presence.
const FORCE_EXCLUDED_DELISTED = new Set(['晶電']);

// SP-3: trailing-Ny dividend sum ÷ N, matched on trimmed Dividend.name.
// Approximate by construction — past dividends reflect the share count held
// then, not now. Every surface that shows yieldPct must label it approximate.
//
// SP-18: `years` is a parameter, not a constant. A 5-year window spans Taiwan's
// 2021-22 shipping super-cycle, which leaves some trailing averages several times
// higher than the most recent payout. Averaging that away is a distortion, not a
// smoothing, so the window is the user's to choose. Default stays 5 for continuity.
export function annualDividendFor(ticker, dividends, asOf, years = 5) {
  const n = Number(years) > 0 ? Number(years) : 5;
  const cutoff = new Date(asOf);
  cutoff.setFullYear(cutoff.getFullYear() - n);
  const name = String(ticker).trim();
  let sum = 0;
  for (const d of dividends) {
    if (!d || typeof d.name !== 'string') continue;
    if (d.name.trim() !== name) continue;
    if (new Date(d.date) >= cutoff) sum += d.amount;
  }
  return sum / n;
}

// SP-1: one SellCandidate per held ticker with a price at asOf. A ticker with
// no price is excluded, never valued at cost. Unmapped ticker -> unknown/tier
// 2 (SP-13, design.md §C.7 — supersedes the tier:3 default in C.0), but stays
// a candidate (also listed in excluded.unmapped, informational).
export function buildCandidates(holdings, priceMap, asOf, dividends, segmentMap, opts = {}) {
  const dividendYears = opts.dividendYears ?? 5;
  const excluded = { no_price: [], delisted: [], null_shares: [], unmapped: [] };
  const raw = [];

  for (const [ticker, data] of Object.entries(holdings || {})) {
    if (data == null || data.shares === null || data.shares === undefined) {
      excluded.null_shares.push(ticker);
      continue;
    }
    if (FORCE_EXCLUDED_DELISTED.has(ticker)) {
      excluded.delisted.push(ticker);
      continue;
    }
    const price = priceMap?.[ticker]?.[asOf];
    if (price === undefined || price === null) {
      excluded.no_price.push(ticker);
      continue;
    }

    // SP-13: a ticker absent from SegmentMap.tickers is neutral, not sell-first —
    // it resolves to tier 2, never tier 3. Defaulting unknowns to tier 3 would make
    // `tagTiered` liquidate them first on no evidence, which is the most destructive
    // possible reading of missing data. (Supersedes the tier:3 default in C.0/SP-1.)
    let segment = 'unknown';
    let tier = 2;
    let code = null;
    const mapping = segmentMap?.tickers?.[ticker];
    if (mapping) {
      segment = mapping.segment;
      code = mapping.code;
      const segDef = (segmentMap.segments || []).find(s => s.id === segment);
      tier = segDef ? segDef.tier : 2;
    } else {
      excluded.unmapped.push(ticker);
    }

    const shares = data.shares;
    const cost = data.cost;
    const value = shares * price;
    const plPct = cost > 0 ? (value - cost) / cost : 0;
    const annualDividend = annualDividendFor(ticker, dividends || [], asOf, dividendYears);
    const yieldPct = value > 0 ? (annualDividend / value) * 100 : 0;

    raw.push({ ticker, code, segment, tier, shares, cost, price, value, plPct, annualDividend, yieldPct });
  }

  const totalValue = raw.reduce((s, c) => s + c.value, 0);
  for (const c of raw) c.weightPct = totalValue > 0 ? (c.value / totalValue) * 100 : 0;

  return { candidates: raw, excluded };
}

// SP-2: sell-side proceeds. discount default 1.0 keeps `net` conservative
// (understated fee reduction never makes the plan look like it raised more
// than it truly would).
export function proceeds(shares, price, opts = {}) {
  const discount = opts.discount ?? 1.0;
  if (!shares || shares <= 0) return { gross: 0, tax: 0, fee: 0, net: 0 };
  const gross = shares * price;
  const tax = gross * 0.003;
  const fee = Math.max(20, gross * 0.001425 * discount);
  const net = gross - tax - fee;
  return { gross, tax, fee, net };
}

function makeRow(candidate, sellShares, p) {
  const costPerShare = candidate.shares > 0 ? candidate.cost / candidate.shares : 0;
  const realizedPL = sellShares * (candidate.price - costPerShare);
  return {
    ticker: candidate.ticker,
    sellShares,
    sellPct: candidate.shares > 0 ? sellShares / candidate.shares : 0,
    gross: p.gross,
    tax: p.tax,
    fee: p.fee,
    net: p.net,
    realizedPL
  };
}

function totalsOf(rows) {
  return rows.reduce((acc, r) => ({
    gross: acc.gross + r.gross,
    tax: acc.tax + r.tax,
    fee: acc.fee + r.fee,
    net: acc.net + r.net,
    realizedPL: acc.realizedPL + r.realizedPL
  }), { gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0 });
}

function spilledIntoTierOf(touchedTiers) {
  if (touchedTiers.has(1)) return 1;
  if (touchedTiers.has(2)) return 2;
  return undefined;
}

// Minimal integer x in [0, maxShares] such that proceeds(x, price, opts).net
// >= remaining. net(x) is non-decreasing in x, so a plain binary search over
// the integer domain finds the smallest satisfying share count (SP-4: "round
// up to whole shares").
function minSharesForNet(price, remaining, discount, maxShares) {
  if (remaining <= 0) return 0;
  let lo = 0, hi = maxShares;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const net = proceeds(mid, price, { discount }).net;
    if (net >= remaining) hi = mid; else lo = mid + 1;
  }
  return lo;
}

// SP-6: proportional strategy — one scale factor k applied to every
// candidate, solved (numerically, since fees are non-linear) so that
// Σ net(shares×k) = target, with a deterministic per-share correction pass
// so the result never undershoots target due to rounding.
function solveProportional(candidates, target, discount) {
  const netFor = (sharesArr) => candidates.reduce(
    (s, c, i) => s + proceeds(sharesArr[i], c.price, { discount }).net, 0
  );
  const sharesFor = (k) => candidates.map(c => Math.min(c.shares, Math.floor(c.shares * k)));

  let lo = 0, hi = 1;
  for (let iter = 0; iter < 60; iter++) {
    const mid = (lo + hi) / 2;
    const net = netFor(sharesFor(mid));
    if (net >= target) hi = mid; else lo = mid;
  }

  const sellShares = sharesFor(hi);
  const order = candidates
    .map((c, idx) => idx)
    .sort((a, b) => candidates[a].ticker.localeCompare(candidates[b].ticker));

  let net = netFor(sellShares);
  let guard = 0;
  while (net < target && guard < 10_000_000) {
    let bumped = false;
    for (const idx of order) {
      if (sellShares[idx] < candidates[idx].shares) {
        sellShares[idx]++;
        bumped = true;
        net = netFor(sellShares);
        if (net >= target) break;
      }
    }
    if (!bumped) break; // no capacity left — feasibility was already checked by the caller
    guard++;
  }

  return sellShares;
}

// SP-4/SP-8/SP-9: fills `candidates` (assumed already ordered by the caller's
// chosen strategy comparator, or unordered for `proportional`) until
// cumulative net proceeds reach `target`.
export function solveFill(candidates, target, opts = {}) {
  if (!candidates || candidates.length === 0) {
    throw new Error('E_PLAN_NO_CANDIDATES');
  }

  const discount = opts.discount ?? 1.0;
  const strategyId = opts.strategyId ?? 'custom';

  const totalNetAll = candidates.reduce(
    (s, c) => s + proceeds(c.shares, c.price, { discount }).net, 0
  );

  // SP-8: infeasible — full liquidation, not a crash. `errorCode` is an
  // informational (non-thrown) tag for the UI/Auditor; see Gemini Notes.
  if (totalNetAll < target) {
    const touchedTiers = new Set();
    const rows = candidates.map(c => {
      const p = proceeds(c.shares, c.price, { discount });
      touchedTiers.add(c.tier);
      return makeRow(c, c.shares, p);
    });
    return {
      strategyId,
      rows,
      totals: totalsOf(rows),
      feasible: false,
      shortfall: target - totalNetAll,
      spilledIntoTier: spilledIntoTierOf(touchedTiers),
      errorCode: 'E_PLAN_INFEASIBLE'
    };
  }

  if (strategyId === 'proportional') {
    const sellShares = solveProportional(candidates, target, discount);
    const touchedTiers = new Set();
    const rows = candidates.map((c, i) => {
      const p = proceeds(sellShares[i], c.price, { discount });
      if (sellShares[i] > 0) touchedTiers.add(c.tier);
      return makeRow(c, sellShares[i], p);
    });
    return {
      strategyId,
      rows,
      totals: totalsOf(rows),
      feasible: true,
      shortfall: 0,
      spilledIntoTier: spilledIntoTierOf(touchedTiers)
    };
  }

  // Ordered walk: take whole positions until the running net would meet
  // target, then solve the final position's shares (rounded up).
  const rows = [];
  const touchedTiers = new Set();
  let cumulativeNet = 0;
  let filled = false;

  for (const c of candidates) {
    if (filled) {
      rows.push(makeRow(c, 0, proceeds(0, c.price, { discount })));
      continue;
    }
    const fullP = proceeds(c.shares, c.price, { discount });
    if (cumulativeNet + fullP.net < target) {
      rows.push(makeRow(c, c.shares, fullP));
      cumulativeNet += fullP.net;
      touchedTiers.add(c.tier);
    } else {
      const remaining = target - cumulativeNet;
      const x = minSharesForNet(c.price, remaining, discount, c.shares);
      const p = proceeds(x, c.price, { discount });
      rows.push(makeRow(c, x, p));
      cumulativeNet += p.net;
      if (x > 0) touchedTiers.add(c.tier);
      filled = true;
    }
  }

  return {
    strategyId,
    rows,
    totals: totalsOf(rows),
    feasible: true,
    shortfall: 0,
    spilledIntoTier: spilledIntoTierOf(touchedTiers)
  };
}

// SP-5: plan-level summary + remaining-portfolio figures.
export function summarize(plan, candidates) {
  const byTicker = Object.fromEntries((candidates || []).map(c => [c.ticker, c]));

  let positionsTouched = 0, positionsLiquidated = 0, realizedPL = 0, annualDividendGivenUp = 0;
  let taxAndFees = 0;
  let soldValueTotal = 0, soldValueTier1 = 0;
  let remainingValue = 0, remainingAnnualDiv = 0, remainingTier1Value = 0;

  for (const row of plan.rows) {
    const c = byTicker[row.ticker];
    if (!c) continue;

    if (row.sellShares > 0) positionsTouched++;
    if (c.shares > 0 && row.sellShares === c.shares) positionsLiquidated++;

    realizedPL += row.realizedPL;
    annualDividendGivenUp += c.annualDividend * row.sellPct;
    taxAndFees += row.tax + row.fee;
    soldValueTotal += row.gross;
    if (c.tier === 1) soldValueTier1 += row.gross;

    const remainingShares = c.shares - row.sellShares;
    const remVal = remainingShares * c.price;
    remainingValue += remVal;
    remainingAnnualDiv += c.annualDividend * (1 - row.sellPct);
    if (c.tier === 1) remainingTier1Value += remVal;
  }

  return {
    positionsTouched,
    positionsLiquidated,
    realizedPL,
    annualDividendGivenUp,
    tier1ValueSoldPct: soldValueTotal > 0 ? (soldValueTier1 / soldValueTotal) * 100 : 0,
    taxAndFees,
    remaining: {
      value: remainingValue,
      yieldPct: remainingValue > 0 ? (remainingAnnualDiv / remainingValue) * 100 : 0,
      tier1WeightPct: remainingValue > 0 ? (remainingTier1Value / remainingValue) * 100 : 0
    }
  };
}

// SP-6: four peer strategies — pure comparators, ties break on higher value
// then ticker so output is deterministic. None forecasts price or return;
// none is presented as "recommended" (that's a UI-layer rule too).
function tieBreak(a, b) {
  if (a.value !== b.value) return b.value - a.value;
  return a.ticker.localeCompare(b.ticker);
}

export function tagTiered(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.tier !== b.tier) return b.tier - a.tier; // tier 3 -> 2 -> 1
    if (a.yieldPct !== b.yieldPct) return a.yieldPct - b.yieldPct; // lowest yield first
    return tieBreak(a, b);
  });
}

export function yieldProtect(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.yieldPct !== b.yieldPct) return a.yieldPct - b.yieldPct; // lowest yield first, tier ignored
    return tieBreak(a, b);
  });
}

export function cutLosers(candidates) {
  return [...candidates].sort((a, b) => {
    if (a.plPct !== b.plPct) return a.plPct - b.plPct; // lowest P/L% (biggest losers) first
    return tieBreak(a, b);
  });
}

// Not a sort (SP-6) — solveFill branches on opts.strategyId === 'proportional'
// and applies a scale factor instead of walking this order. The order here
// only fixes row output order deterministically.
export function proportional(candidates) {
  return [...candidates].sort((a, b) => a.ticker.localeCompare(b.ticker));
}

export const STRATEGIES = { tagTiered, yieldProtect, proportional, cutLosers };
