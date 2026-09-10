// Rev 4.0 Sell Planner UI (design.md Section C.4).
// Rendering, edit handlers, localStorage persistence and export live here —
// sellplanner.js stays pure/no-I/O. Exports initSellPlanner(ctx) plus a few
// standalone helpers (editSellShares, scenario functions, CSV builder) that
// are unit-testable without a DOM.
import {
  buildCandidates, proceeds, solveFill, summarize,
  tagTiered, yieldProtect, proportional, cutLosers,
  TARGET_NET
} from './sellplanner.js?v=3';

export const SCENARIO_KEY = 'sellPlanner.scenarios.v1';
export const SCENARIO_VERSION = 1;

function defaultStorage() {
  return typeof localStorage !== 'undefined' ? localStorage : null;
}

// C.2/SP-11: scenarios store share counts, not prices. Unparseable or
// wrong-version payload -> E_SCENARIO_CORRUPT, store left untouched.
export function loadScenarios(storage = defaultStorage()) {
  if (!storage) return [];
  const raw = storage.getItem(SCENARIO_KEY);
  if (raw === null || raw === undefined) return [];
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    throw new Error('E_SCENARIO_CORRUPT');
  }
  if (!parsed || parsed.version !== SCENARIO_VERSION || !Array.isArray(parsed.scenarios)) {
    throw new Error('E_SCENARIO_CORRUPT');
  }
  return parsed.scenarios;
}

function persistScenarios(scenarios, storage) {
  storage.setItem(SCENARIO_KEY, JSON.stringify({ version: SCENARIO_VERSION, scenarios }));
}

function makeScenarioId() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `sc_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

// Builds a SavedScenario (C.0) from the active plan. `netAtSave` is an extra,
// optional field beyond the C.0 schema (not required by any consumer) kept
// only so the UI can show proceeds drift after a reload re-prices the plan —
// see Gemini Notes for why this was added.
export function serializeScenario({ name, strategyId, locked, plan, note }) {
  return {
    id: makeScenarioId(),
    name,
    savedAt: new Date().toISOString(),
    strategyId,
    locked: locked || [],
    rows: plan.rows.filter(r => r.sellShares > 0).map(r => ({ ticker: r.ticker, sellShares: r.sellShares })),
    note: note || '',
    netAtSave: plan.totals.net
  };
}

// Throws (does not touch storage) if the existing store is already corrupt —
// never silently clears it.
export function saveScenario(scenario, storage = defaultStorage()) {
  if (!storage) return [];
  const scenarios = loadScenarios(storage); // throws E_SCENARIO_CORRUPT, untouched
  scenarios.push(scenario);
  persistScenarios(scenarios, storage);
  return scenarios;
}

export function deleteScenario(id, storage = defaultStorage()) {
  if (!storage) return [];
  const scenarios = loadScenarios(storage).filter(s => s.id !== id);
  persistScenarios(scenarios, storage);
  return scenarios;
}

// Re-prices a saved scenario's share counts against today's candidates
// (SP-11: "a reloaded scenario re-prices at today's market").
export function reviveScenario(scenario, candidates, opts = {}) {
  const discount = opts.discount ?? 1.0;
  const byTicker = Object.fromEntries(candidates.map(c => [c.ticker, c]));
  const rows = [];
  for (const c of candidates) {
    const saved = scenario.rows.find(r => r.ticker === c.ticker);
    const sellShares = saved ? Math.min(saved.sellShares, c.shares) : 0;
    const p = proceeds(sellShares, c.price, { discount });
    const costPerShare = c.shares > 0 ? c.cost / c.shares : 0;
    rows.push({
      ticker: c.ticker,
      sellShares,
      sellPct: c.shares > 0 ? sellShares / c.shares : 0,
      gross: p.gross, tax: p.tax, fee: p.fee, net: p.net,
      realizedPL: sellShares * (c.price - costPerShare)
    });
  }
  const totals = rows.reduce((acc, r) => ({
    gross: acc.gross + r.gross, tax: acc.tax + r.tax, fee: acc.fee + r.fee,
    net: acc.net + r.net, realizedPL: acc.realizedPL + r.realizedPL
  }), { gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0 });

  const plan = {
    strategyId: 'custom',
    rows,
    totals,
    feasible: totals.net >= (opts.target ?? TARGET_NET),
    shortfall: Math.max(0, (opts.target ?? TARGET_NET) - totals.net)
  };
  const drift = scenario.netAtSave !== undefined ? totals.net - scenario.netAtSave : undefined;
  return { plan, drift };
}

// SP-7: editing any sellShares switches the active plan to `custom` (seeded
// from whichever plan was active) and stops re-solving — only this one row
// is recomputed; every other row is carried over untouched.
export function editSellShares(plan, candidates, ticker, newShares, opts = {}) {
  const discount = opts.discount ?? 1.0;
  const target = opts.target ?? TARGET_NET;
  const candidate = candidates.find(c => c.ticker === ticker);
  if (!candidate) return plan;

  const clamped = Math.max(0, Math.min(Math.round(newShares), candidate.shares));
  const p = proceeds(clamped, candidate.price, { discount });
  const costPerShare = candidate.shares > 0 ? candidate.cost / candidate.shares : 0;
  const newRow = {
    ticker,
    sellShares: clamped,
    sellPct: candidate.shares > 0 ? clamped / candidate.shares : 0,
    gross: p.gross, tax: p.tax, fee: p.fee, net: p.net,
    realizedPL: clamped * (candidate.price - costPerShare)
  };

  const rows = plan.rows.map(r => (r.ticker === ticker ? newRow : r));
  const totals = rows.reduce((acc, r) => ({
    gross: acc.gross + r.gross, tax: acc.tax + r.tax, fee: acc.fee + r.fee,
    net: acc.net + r.net, realizedPL: acc.realizedPL + r.realizedPL
  }), { gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0 });

  return {
    strategyId: 'custom',
    rows,
    totals,
    feasible: totals.net >= target,
    shortfall: Math.max(0, target - totals.net),
    spilledIntoTier: plan.spilledIntoTier
  };
}

// C.2: CSV + text export via Blob/object URL. Pure string-building here;
// the Blob/anchor-click part is DOM-only and lives in the render helpers below.
export function buildCsv(plan, candidates) {
  const byTicker = Object.fromEntries(candidates.map(c => [c.ticker, c]));
  const header = 'ticker,code,shares,price,gross,tax,fee,net,realizedPL';
  const lines = plan.rows
    .filter(r => r.sellShares > 0)
    .map(r => {
      const c = byTicker[r.ticker] || {};
      return [r.ticker, c.code || '', r.sellShares, c.price ?? '', r.gross.toFixed(2), r.tax.toFixed(2), r.fee.toFixed(2), r.net.toFixed(2), r.realizedPL.toFixed(2)].join(',');
    });
  return [header, ...lines].join('\n');
}

export function buildSummaryText(plan, summary) {
  const lines = [
    `Strategy: ${plan.strategyId}`,
    `Target net: ${TARGET_NET.toLocaleString()}`,
    `Net raised: ${Math.round(plan.totals.net).toLocaleString()}`,
    `Feasible: ${plan.feasible}`,
    plan.feasible ? null : `Shortfall: ${Math.round(plan.shortfall).toLocaleString()}`,
    plan.spilledIntoTier ? `Spilled into tier ${plan.spilledIntoTier}` : null,
    `Positions touched: ${summary.positionsTouched} (liquidated: ${summary.positionsLiquidated})`,
    `Realized P/L: ${Math.round(summary.realizedPL).toLocaleString()}`,
    `Annual dividend given up (approximate): ${Math.round(summary.annualDividendGivenUp).toLocaleString()}`,
    `Tax + fees: ${Math.round(summary.taxAndFees).toLocaleString()}`,
    `Remaining value: ${Math.round(summary.remaining.value).toLocaleString()}`,
    `Remaining yield (approximate): ${summary.remaining.yieldPct.toFixed(2)}%`,
    `Remaining Tier-1 weight: ${summary.remaining.tier1WeightPct.toFixed(2)}%`
  ].filter(Boolean);
  return lines.join('\n');
}

// SP-21: localStorage behind the same async interface as SheetScenarioStore,
// so the UI treats the two stores identically.
export class LocalScenarioStore {
  constructor(storage = defaultStorage()) { this.storage = storage; }
  async list() { return loadScenarios(this.storage); }
  async save(scenario) { saveScenario(scenario, this.storage); }
  async remove(id) { deleteScenario(id, this.storage); }
}

export const MIGRATED_KEY = 'sellPlanner.migratedToSheet.v1';
export const PENDING_KEY = 'sellPlanner.pendingUpload.v1';

function readPending(storage) {
  try {
    const v = JSON.parse(storage.getItem(PENDING_KEY) || '[]');
    return Array.isArray(v) ? v : [];
  } catch (e) {
    return [];
  }
}

// Records a plan that had to be saved in this browser because the Sheet was
// unreachable, so the next live load uploads it.
export function markPendingUpload(id, storage = defaultStorage()) {
  if (!storage) return;
  const pending = new Set(readPending(storage));
  pending.add(id);
  storage.setItem(PENDING_KEY, JSON.stringify([...pending]));
}

// SP-21: copy plans that exist only in this browser up to the Sheet.
// First live load: every local-only plan. After that: only plans saved locally
// while the Sheet was down (PENDING_KEY) — never one deliberately deleted on
// another device. Local copies are always left in place as a backup. If the
// Sheet is unreachable this throws without marking anything done, so the next
// load retries; a plan the Sheet rejects is reported once, not retried forever.
export async function syncLocalToSheet(remote, storage = defaultStorage()) {
  if (!storage) return { uploaded: 0, rejected: [] };
  let local;
  try {
    local = loadScenarios(storage);
  } catch (e) {
    return { uploaded: 0, rejected: [], error: 'E_SCENARIO_CORRUPT' };
  }
  const firstRun = !storage.getItem(MIGRATED_KEY);
  const pending = new Set(readPending(storage));
  const wanted = local.filter(s => firstRun || pending.has(s.id));
  if (!wanted.length) {
    if (firstRun) storage.setItem(MIGRATED_KEY, new Date().toISOString());
    return { uploaded: 0, rejected: [] };
  }

  const remoteIds = new Set((await remote.list()).map(s => s.id));
  let uploaded = 0;
  const rejected = [];
  for (const s of wanted) {
    if (!remoteIds.has(s.id)) {
      try {
        await remote.save(s);
        uploaded++;
      } catch (e) {
        if (e.message !== 'E_SCENARIO_REJECTED') throw e;
        rejected.push(s.name);
      }
    }
    pending.delete(s.id);
  }
  storage.setItem(PENDING_KEY, JSON.stringify([...pending]));
  storage.setItem(MIGRATED_KEY, new Date().toISOString());
  return { uploaded, rejected };
}

// Scenario names now arrive from a shared Sheet, not just this browser, so they
// are escaped before going anywhere near innerHTML.
function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const STRATEGY_LABELS = {
  tagTiered: 'Tag-tiered (segment tier order)',
  yieldProtect: 'Yield-protect (lowest yield first)',
  proportional: 'Proportional (scaled across all)',
  cutLosers: 'Cut losers (lowest P/L first)',
  custom: 'Custom (edited)'
};
const STRATEGY_FNS = { tagTiered, yieldProtect, proportional, cutLosers };

function fmt(n) { return Math.round(n).toLocaleString(); }

// DOM entry point (C.4). `ctx = { holdings, priceMap, priceToday, divs,
// reviewLots, offline }`. Segment map is fetched at runtime (no build step,
// no import assertion) rather than imported, keeping sellplanner.js pure.
export async function initSellPlanner(ctx) {
  const panel = document.getElementById('sellplanner-panel');
  if (!panel) return;

  const offlineBanner = document.getElementById('sp-offline-banner');
  const noticeList = document.getElementById('sp-notice-list');
  const noticeBox = document.getElementById('sp-notice');
  const strip = document.getElementById('sp-strategy-strip');
  const progressEl = document.getElementById('sp-progress');
  const tierEl = document.getElementById('sp-tier-breakdown');
  const discountInput = document.getElementById('sp-discount');
  const divYearsInput = document.getElementById('sp-div-years');
  const tbody = document.querySelector('#sp-detail-table tbody');
  const scenarioList = document.getElementById('sp-scenario-list');
  const exportBtn = document.getElementById('sp-export-csv');
  const saveBtn = document.getElementById('sp-save-scenario');
  const statusEl = document.getElementById('sp-scenario-status');
  function setStatus(mode) {
    if (!statusEl) return;
    statusEl.textContent =
      mode === 'sheet' ? 'Saved plans are stored in your Google Sheet (SellPlans tab) and shared across your devices.'
      : mode === 'local-fallback' ? 'Your Google Sheet is unreachable right now — plans are shown and saved in this browser only.'
      : 'Offline preview — plans are saved in this browser only.';
  }

  function notice(msg) {
    if (!noticeBox || !noticeList) return;
    noticeBox.classList.add('visible');
    noticeList.innerHTML += `<li>${msg}</li>`;
  }

  // C.5: offline block — a plausible-looking wrong plan is worse than none.
  if (ctx.offline) {
    if (offlineBanner) {
      offlineBanner.classList.add('visible');
      offlineBanner.innerHTML = '<strong>Offline mode:</strong> prices shown are purchase prices, not live market data. The sell planner is disabled until live prices are available.';
    }
    return;
  }

  let segmentMap;
  try {
    const res = await fetch('src/segments.json?v=1');
    segmentMap = await res.json();
  } catch (e) {
    segmentMap = { version: 1, tiers: {}, segments: [], tickers: {} };
  }

  const locked = new Set();
  let discount = 1.0;
  let dividendYears = 5;   // SP-18: the trailing window is the user's choice
  let activeStrategyId = 'tagTiered';
  let activePlan = null;
  // The custom plan persists independently of activePlan so that clicking between
  // strategy cards to compare no longer discards the user's edits.
  let customPlan = null;
  let customClearedByLock = false;
  // SP-21: live mode stores plans in the Sheet; offline, or if the Sheet is
  // unreachable, in this browser.
  const remoteStore = ctx.scenarioStore || null;
  const localStore = new LocalScenarioStore();
  let store = remoteStore || localStore;
  let candidates = [];

  function recomputeCandidates() {
    const { candidates: all, excluded } = buildCandidates(ctx.holdings, ctx.priceMap, ctx.priceToday, ctx.divs, segmentMap, { dividendYears });
    candidates = all.filter(c => !locked.has(c.ticker));

    if (noticeList) noticeList.innerHTML = '';
    if (noticeBox) noticeBox.classList.remove('visible');
    if (excluded.no_price.length) notice(`No price available (excluded from planning): ${excluded.no_price.join(', ')}`);
    if (excluded.delisted.length) notice(`Delisted / stale-quote (force-excluded): ${excluded.delisted.join(', ')}`);
    if (excluded.null_shares.length) notice(`Lots with null shares under review (excluded): ${excluded.null_shares.join(', ')}`);
    if (excluded.unmapped.length) notice(`Not in the segment reference table (tagged unknown / neutral tier 2): ${excluded.unmapped.join(', ')}`);
    if (ctx.reviewLots && ctx.reviewLots.length) {
      const tickers = [...new Set(ctx.reviewLots.map(l => l.ticker))].join(', ');
      notice(`Held lots excluded from every metric (null shares): ${tickers}`);
    }
  }

  function planFor(strategyId) {
    if (candidates.length === 0) return null;
    if (strategyId === 'custom') return customPlan;
    const fn = STRATEGY_FNS[strategyId];
    const ordered = fn(candidates);
    return solveFill(ordered, TARGET_NET, { discount, strategyId });
  }

  function renderStrip() {
    if (!strip) return;
    strip.innerHTML = '';
    if (candidates.length === 0) {
      notice('E_PLAN_NO_CANDIDATES — every held ticker is excluded or locked; nothing left to plan against.');
      return;
    }
    // The custom plan gets a fifth card so all five are comparable at a glance.
    for (const id of [...Object.keys(STRATEGY_FNS), 'custom']) {
      const plan = planFor(id);
      const card = document.createElement('div');
      card.className = 'card';
      card.style.cursor = 'pointer';
      card.dataset.strategyId = id;
      if (id === activeStrategyId) card.style.outline = '2px solid #3b82f6';

      // No custom plan yet: an empty slot that seeds one from whatever is active,
      // rather than a dead card or a missing fifth column.
      if (id === 'custom' && !plan) {
        card.style.borderStyle = 'dashed';
        card.style.background = '#fafafa';
        card.innerHTML = `
          <h3>${STRATEGY_LABELS.custom}</h3>
          <div class="value" style="color:#9ca3af;">—</div>
          <div class="label">${customClearedByLock
            ? 'cleared when you changed a lock — click to start again from the selected plan'
            : 'click to start one from the selected plan, or edit any Sell Shares below'}</div>
        `;
        card.addEventListener('click', () => {
          const seed = activePlan || planFor('tagTiered');
          if (!seed) return;
          customPlan = { ...seed, strategyId: 'custom', rows: seed.rows.map(r => ({ ...r })) };
          customClearedByLock = false;
          activePlan = customPlan;
          activeStrategyId = 'custom';
          renderStrip();
          renderProgress();
          renderDetail();
        });
        strip.appendChild(card);
        continue;
      }
      // SP-5: the comparison metrics are the point of showing four plans at once —
      // net raised alone is nearly identical across strategies by construction.
      const s = summarize(plan, candidates);
      card.innerHTML = `
        <h3>${STRATEGY_LABELS[id]}</h3>
        <div class="value">${fmt(plan.totals.net)}</div>
        <div class="label">${plan.feasible ? 'reaches target' : `short by ${fmt(plan.shortfall)}`}${plan.spilledIntoTier ? ` — reaches into Tier ${plan.spilledIntoTier}` : ''}</div>
        <table style="margin-top:12px;box-shadow:none;font-size:12px;">
          <tbody>
            <tr><td style="padding:4px 0;border:none;">Realized P/L</td><td style="padding:4px 0;border:none;">${s.realizedPL >= 0 ? '+' : ''}${fmt(s.realizedPL)}</td></tr>
            <tr><td style="padding:4px 0;border:none;">Dividend/yr given up</td><td style="padding:4px 0;border:none;">−${fmt(s.annualDividendGivenUp)}</td></tr>
            <tr><td style="padding:4px 0;border:none;">Tier 1 share of sale</td><td style="padding:4px 0;border:none;">${s.tier1ValueSoldPct.toFixed(0)}%</td></tr>
            <tr><td style="padding:4px 0;border:none;">Positions sold</td><td style="padding:4px 0;border:none;">${s.positionsLiquidated} of ${s.positionsTouched}</td></tr>
            <tr><td style="padding:4px 0;border:none;">Remaining yield</td><td style="padding:4px 0;border:none;">${s.remaining.yieldPct.toFixed(2)}%</td></tr>
          </tbody>
        </table>
        <div class="label" style="margin-top:6px;">yield approximate — see notice</div>
      `;
      card.addEventListener('click', () => {
        activeStrategyId = id;
        activePlan = planFor(id);
        renderStrip();
        renderProgress();
        renderDetail();
      });
      strip.appendChild(card);
    }
  }


  // Which names, in which tier, make up the sale — the aggregate
  // `tier1ValueSoldPct` on the cards says how much, not what.
  function renderTierBreakdown() {
    if (!tierEl) return;
    if (!activePlan) { tierEl.innerHTML = ''; return; }
    const byTicker = Object.fromEntries(candidates.map(c => [c.ticker, c]));
    const sold = activePlan.rows.filter(r => r.sellShares > 0);
    const totalGross = sold.reduce((s, r) => s + r.gross, 0);
    if (totalGross <= 0) {
      tierEl.innerHTML = '<div class="label">Nothing is being sold in this plan.</div>';
      return;
    }
    const tiers = { 1: [], 2: [], 3: [] };
    for (const r of sold) {
      const c = byTicker[r.ticker];
      if (!c) continue;
      (tiers[c.tier] || tiers[2]).push({ ...r, segment: c.segment, shares: c.shares });
    }
    const LABELS = {
      1: 'Tier 1 — AI / 資料中心供應鏈',
      2: 'Tier 2 — 科技，非 AI 主力',
      3: 'Tier 3 — 非科技'
    };
    let html = '';
    for (const tier of [3, 2, 1]) {
      const rows = tiers[tier].sort((a, b) => b.gross - a.gross);
      const tierGross = rows.reduce((s, r) => s + r.gross, 0);
      const tierPct = (tierGross / totalGross) * 100;
      html += `<div style="margin-bottom:18px;">
        <div style="display:flex;justify-content:space-between;font-weight:600;margin-bottom:6px;">
          <span>${LABELS[tier]}</span><span>${fmt(tierGross)} — ${tierPct.toFixed(1)}% of sale</span>
        </div>`;
      if (!rows.length) {
        html += '<div class="label">nothing sold from this tier</div></div>';
        continue;
      }
      html += `<div style="background:#e5e7eb;border-radius:4px;overflow:hidden;height:8px;margin-bottom:8px;">
          <div style="background:${tier === 1 ? '#dc2626' : tier === 2 ? '#f59e0b' : '#16a34a'};width:${tierPct}%;height:100%;"></div>
        </div>
        <table style="box-shadow:none;font-size:13px;"><tbody>`;
      for (const r of rows) {
        const pct = (r.gross / totalGross) * 100;
        const whole = r.sellShares >= r.shares;
        html += `<tr>
          <td style="padding:4px 0;border:none;">${r.ticker}<span class="label"> ${r.segment}</span></td>
          <td style="padding:4px 0;border:none;">${r.sellShares.toLocaleString()} sh${whole ? ' (all)' : ''}</td>
          <td style="padding:4px 0;border:none;">${fmt(r.gross)}</td>
          <td style="padding:4px 0;border:none;font-weight:600;">${pct.toFixed(1)}%</td>
        </tr>`;
      }
      html += '</tbody></table></div>';
    }
    tierEl.innerHTML = html;
  }

  function renderProgress() {
    if (!progressEl || !activePlan) return;
    const pct = Math.min(100, (activePlan.totals.net / TARGET_NET) * 100);
    const sum = summarize(activePlan, candidates);
    progressEl.innerHTML = `
      <div style="background:#e5e7eb;border-radius:6px;overflow:hidden;height:20px;">
        <div style="background:${activePlan.feasible ? '#16a34a' : '#f59e0b'};width:${pct}%;height:100%;"></div>
      </div>
      <div class="label">${fmt(activePlan.totals.net)} / ${fmt(TARGET_NET)} net raised (${pct.toFixed(1)}%)</div>
      <div class="grid" style="margin-top:16px;">
        <div><div class="label">Realized P/L on this plan</div><div class="value" style="font-size:18px;">${sum.realizedPL >= 0 ? '+' : ''}${fmt(sum.realizedPL)}</div></div>
        <div><div class="label">Annual dividend given up (approx.)</div><div class="value" style="font-size:18px;">−${fmt(sum.annualDividendGivenUp)}</div></div>
        <div><div class="label">Tax + fees</div><div class="value" style="font-size:18px;">${fmt(sum.taxAndFees)}</div></div>
        <div><div class="label">Gross to sell</div><div class="value" style="font-size:18px;">${fmt(activePlan.totals.gross)}</div></div>
        <div><div class="label">Portfolio left after</div><div class="value" style="font-size:18px;">${fmt(sum.remaining.value)}</div></div>
        <div><div class="label">Tier 1 weight after</div><div class="value" style="font-size:18px;">${sum.remaining.tier1WeightPct.toFixed(0)}%</div></div>
      </div>
    `;
    renderTierBreakdown();
  }

  function renderDetail() {
    if (!tbody || !activePlan) return;
    tbody.innerHTML = '';
    const byTicker = Object.fromEntries(candidates.map(c => [c.ticker, c]));
    for (const row of activePlan.rows) {
      const c = byTicker[row.ticker];
      if (!c) continue;
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td><input type="checkbox" class="sp-lock" data-ticker="${c.ticker}" ${locked.has(c.ticker) ? 'checked' : ''}></td>
        <td>${c.ticker}</td>
        <td>${segmentMap.segments.find(s => s.id === c.segment)?.label || c.segment}</td>
        <td>${c.shares.toLocaleString()}</td>
        <td><input type="number" class="sp-sell-shares" data-ticker="${c.ticker}" min="0" max="${c.shares}" value="${row.sellShares}"></td>
        <td>${fmt(row.net)}</td>
        <td>${row.realizedPL >= 0 ? '+' : ''}${fmt(row.realizedPL)}</td>
        <td>${c.yieldPct.toFixed(2)}% (approx.)</td>
      `;
      tbody.appendChild(tr);
    }

    tbody.querySelectorAll('.sp-sell-shares').forEach(input => {
      input.addEventListener('change', () => {
        const ticker = input.dataset.ticker;
        customPlan = editSellShares(activePlan, candidates, ticker, Number(input.value), { discount, target: TARGET_NET });
        customClearedByLock = false;
        activePlan = customPlan;
        activeStrategyId = 'custom';
        renderStrip();
        renderProgress();
        renderDetail();
      });
    });
    tbody.querySelectorAll('.sp-lock').forEach(cb => {
      cb.addEventListener('change', () => {
        const ticker = cb.dataset.ticker;
        if (cb.checked) locked.add(ticker); else locked.delete(ticker);
        recomputeCandidates();
        if (customPlan) { customPlan = null; customClearedByLock = true; }
        activeStrategyId = STRATEGY_FNS[activeStrategyId] ? activeStrategyId : 'tagTiered';
        activePlan = planFor(activeStrategyId);
        renderStrip();
        renderProgress();
        renderDetail();
      });
    });
  }

  async function renderScenarios() {
    if (!scenarioList) return;
    let scenarios;
    try {
      scenarios = await store.list();
    } catch (e) {
      if (store === remoteStore) {
        // SP-21: never show an empty list just because the Sheet is down.
        notice(`${e.message} — your Google Sheet couldn't be reached, so the plans below are the ones saved in this browser.`);
        store = localStore;
        setStatus('local-fallback');
        try { scenarios = await store.list(); } catch (e2) { scenarios = null; }
      }
      if (!scenarios) {
        notice('E_SCENARIO_CORRUPT — saved scenarios could not be read; the store was left untouched.');
        scenarios = [];
      }
    }
    scenarioList.innerHTML = scenarios.length ? '' : '<div class="label">No saved plans yet.</div>';
    for (const sc of scenarios) {
      const row = document.createElement('div');
      const { plan, drift } = reviveScenario(sc, candidates, { discount, target: TARGET_NET });
      row.innerHTML = `
        <span>${esc(sc.name)} (saved ${esc(new Date(sc.savedAt).toLocaleDateString())}) — net now ${fmt(plan.totals.net)}${drift !== undefined ? ` (${drift >= 0 ? '+' : ''}${fmt(drift)} vs. save time)` : ''}</span>
        <button class="btn-toggle sp-load-scenario" data-id="${esc(sc.id)}">Load</button>
        <button class="btn-toggle sp-delete-scenario" data-id="${esc(sc.id)}">Delete</button>
      `;
      scenarioList.appendChild(row);
    }
    scenarioList.querySelectorAll('.sp-load-scenario').forEach(btn => {
      btn.addEventListener('click', () => {
        const sc = scenarios.find(s => s.id === btn.dataset.id);
        if (!sc) return;
        const { plan } = reviveScenario(sc, candidates, { discount, target: TARGET_NET });
        customPlan = plan;
        customClearedByLock = false;
        activePlan = plan;
        activeStrategyId = 'custom';
        renderStrip();
        renderProgress();
        renderDetail();
      });
    });
    scenarioList.querySelectorAll('.sp-delete-scenario').forEach(btn => {
      btn.addEventListener('click', async () => {
        const sc = scenarios.find(s => s.id === btn.dataset.id);
        // Deleting from the Sheet removes the plan on every device, so confirm.
        if (!sc || !confirm(`Delete saved plan "${sc.name}"?`)) return;
        try {
          await store.remove(sc.id);
        } catch (e) {
          notice(`${e.message} — "${esc(sc.name)}" could not be deleted; nothing was changed.`);
        }
        renderScenarios();
      });
    });
  }

  if (discountInput) {
    discountInput.value = String(discount);
    discountInput.addEventListener('change', () => {
      const v = Number(discountInput.value);
      discount = Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1.0;
      activePlan = planFor(activeStrategyId === 'custom' ? 'tagTiered' : activeStrategyId);
      activeStrategyId = activePlan ? activePlan.strategyId : activeStrategyId;
      renderStrip();
      renderProgress();
      renderDetail();
    });
  }

  if (divYearsInput) {
    divYearsInput.addEventListener('change', () => {
      const v = Number(divYearsInput.value);
      dividendYears = Number.isFinite(v) && v > 0 ? v : 5;
      // Only the yield figures move — share counts stay valid, so a custom plan
      // survives a window change (unlike a lock change, which alters candidates).
      recomputeCandidates();
      activePlan = planFor(activeStrategyId);
      renderStrip();
      renderProgress();
      renderDetail();
    });
  }

  if (exportBtn) {
    exportBtn.addEventListener('click', () => {
      if (!activePlan) return;
      const csv = buildCsv(activePlan, candidates);
      const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sell-plan-${activePlan.strategyId}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    });
  }

  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      if (!activePlan) return;
      const raw = prompt('Scenario name? (up to 80 characters)');
      const name = raw == null ? '' : raw.trim();
      if (!name) return;
      if (name.length > 80) {
        notice('E_SCENARIO_REJECTED — scenario names are limited to 80 characters; nothing was saved.');
        return;
      }
      const scenario = serializeScenario({ name, strategyId: activeStrategyId, locked: [...locked], plan: activePlan });
      try {
        await store.save(scenario);
      } catch (e) {
        if (e.message === 'E_SCENARIO_REJECTED') {
          notice(`E_SCENARIO_REJECTED — the Sheet refused "${esc(name)}"; nothing was saved.`);
        } else if (store === remoteStore) {
          // SP-21: the Sheet is unreachable — keep the plan here rather than lose it,
          // and queue it so the next live load uploads it.
          try {
            await localStore.save(scenario);
            markPendingUpload(scenario.id);
            notice(`${e.message} — your Google Sheet couldn't be reached, so "${esc(name)}" was saved in this browser and will be uploaded next time.`);
          } catch (e2) {
            notice('E_SCENARIO_CORRUPT — could not save: the scenario store in this browser is corrupt.');
          }
        } else {
          notice('E_SCENARIO_CORRUPT — could not save: the scenario store in this browser is corrupt.');
        }
      }
      renderScenarios();
    });
  }

  recomputeCandidates();
  activePlan = planFor(activeStrategyId);
  renderStrip();
  renderProgress();
  renderDetail();
  setStatus(remoteStore ? 'sheet' : 'local');
  if (remoteStore) {
    // SP-21: copy this browser's local-only plans up, then list from the Sheet.
    syncLocalToSheet(remoteStore)
      .then(r => {
        if (r.uploaded) notice(`Copied ${r.uploaded} plan(s) saved in this browser to your Google Sheet. A copy stays in this browser as a backup.`);
        if (r.rejected && r.rejected.length) notice(`E_SCENARIO_REJECTED — the Sheet refused: ${r.rejected.map(esc).join(', ')}. They remain saved in this browser.`);
      })
      .catch(e => notice(`${e.message} — couldn't copy this browser's saved plans to the Sheet yet; they're safe here and will be retried next time.`))
      .finally(() => renderScenarios());
  } else {
    renderScenarios();
  }
}
