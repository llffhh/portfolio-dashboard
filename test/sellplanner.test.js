import { describe, it, expect } from 'vitest';
import {
  buildCandidates, proceeds, annualDividendFor, solveFill, summarize,
  tagTiered, yieldProtect, proportional, cutLosers, TARGET_NET, realizedSales
} from '../src/sellplanner.js';
import {
  loadScenarios, saveScenario, deleteScenario, serializeScenario, reviveScenario,
  buildCsv, buildSummaryText, SCENARIO_KEY, attributeSales, editSellShares
} from '../src/sellplanner-ui.js';
import realSegmentMap from '../src/segments.json';

// Minimal SegmentMap fixture (C.0) — kept small and hand-controlled so
// strategy-ordering assertions are unambiguous, independent of the real
// (large, general-reference) src/segments.json.
const SEGMENT_MAP = {
  version: 1,
  tiers: { '1': 'Tier 1', '2': 'Tier 2', '3': 'Tier 3' },
  segments: [
    { id: 'seg1', label: 'Segment 1', tier: 1 },
    { id: 'seg2', label: 'Segment 2', tier: 2 },
    { id: 'seg3', label: 'Segment 3', tier: 3 },
  ],
  tickers: {
    'A': { code: '0001', segment: 'seg1' },
    'B': { code: '0002', segment: 'seg2' },
    'C': { code: '0003', segment: 'seg3' },
    'D': { code: '0004', segment: 'seg3' },
  }
};

function makeCandidate(overrides) {
  return {
    ticker: 'X', code: null, segment: 'unknown', tier: 3,
    shares: 1000, cost: 100000, price: 150, value: 150000,
    plPct: 0.5, annualDividend: 3000, yieldPct: 2, weightPct: 100,
    ...overrides
  };
}

describe('Rev 4.0 Sell Planner acceptance tests (design.md Section C)', () => {

  describe('SP-1 buildCandidates', () => {
    it('one row per priceable ticker; unpriceable excluded with reason, never valued at cost', () => {
      const holdings = {
        'A': { shares: 100, cost: 10000 },   // priced
        'B': { shares: 50, cost: 5000 },     // no price at asOf
      };
      const priceMap = { 'A': { '2024-01-01': 120 } }; // B has no entry at all
      const { candidates, excluded } = buildCandidates(holdings, priceMap, '2024-01-01', [], SEGMENT_MAP);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].ticker).toBe('A');
      expect(excluded.no_price).toContain('B');
      // B must never appear valued at its cost anywhere in candidates
      expect(candidates.find(c => c.ticker === 'B')).toBeUndefined();
    });

    it('unmapped ticker => {segment:"unknown", tier:2} (SP-13) and appears in excluded.unmapped, but stays a candidate', () => {
      const holdings = { 'Z': { shares: 10, cost: 1000 } }; // not in SEGMENT_MAP.tickers
      const priceMap = { 'Z': { '2024-01-01': 100 } };
      const { candidates, excluded } = buildCandidates(holdings, priceMap, '2024-01-01', [], SEGMENT_MAP);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].segment).toBe('unknown');
      // SP-13 (design.md §C.7): unmapped is neutral tier 2, never tier 3 — an
      // unmapped ticker must never be sell-first on no evidence. Supersedes the
      // tier:3 default stated in C.0/original SP-1.
      expect(candidates[0].tier).toBe(2);
      expect(excluded.unmapped).toContain('Z');
    });
  });

  describe('SP-2 proceeds', () => {
    it('tax 0.3% + brokerage 0.1425%xdiscount; NT$20 floor applies on a small order', () => {
      // Small order: gross*0.001425 < 20 => floor kicks in.
      const shares = 10, price = 100; // gross = 1000; 1000*0.001425 = 1.425 << 20
      const p = proceeds(shares, price, { discount: 1.0 });
      expect(p.gross).toBe(1000);
      expect(p.tax).toBeCloseTo(1000 * 0.003, 6);
      expect(p.fee).toBe(20); // floor applies
      expect(p.net).toBeCloseTo(1000 - 3 - 20, 6);

      // Large order: fee floor does not apply.
      const big = proceeds(10000, 1000, { discount: 1.0 }); // gross = 10,000,000
      expect(big.fee).toBeCloseTo(10_000_000 * 0.001425, 6);
      expect(big.fee).toBeGreaterThan(20);
    });

    it('discount defaults to 1.0 and lowers fee when set below 1', () => {
      const shares = 10000, price = 1000; // large order, above the floor
      const full = proceeds(shares, price);
      const discounted = proceeds(shares, price, { discount: 0.5 });
      expect(full.fee).toBeCloseTo(shares * price * 0.001425 * 1.0, 6);
      expect(discounted.fee).toBeCloseTo(shares * price * 0.001425 * 0.5, 6);
      expect(discounted.fee).toBeLessThan(full.fee);
      expect(discounted.net).toBeGreaterThan(full.net);
    });
  });

  describe('SP-3 annualDividendFor', () => {
    it('= trailing-5y sum / 5, matched on trimmed Dividend.name; 0 for a never-paying ticker', () => {
      const asOf = '2024-01-01';
      const dividends = [
        { date: '2020-06-01', code: '2330', name: ' 台積電 ', amount: 5000, detail: '' }, // inside window (>= 2019-01-01), trimmed match
        { date: '2018-06-01', code: '2330', name: '台積電', amount: 9000, detail: '' },   // outside 5y window, excluded
        { date: '2022-06-01', code: '2317', name: '鴻海', amount: 1000, detail: '' },
      ];
      const result = annualDividendFor('台積電', dividends, asOf);
      expect(result).toBeCloseTo(5000 / 5, 6);

      expect(annualDividendFor('沒有股息的股票', dividends, asOf)).toBe(0);
    });
  });

  describe('SP-4 solveFill', () => {
    it('cumulative net >= target, final position shares rounded up, later rows sellShares=0', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', shares: 1000, cost: 100000, price: 100, tier: 1 }), // full net ~ 99,657.5
        makeCandidate({ ticker: 'B', shares: 1000, cost: 100000, price: 100, tier: 1 }),
        makeCandidate({ ticker: 'C', shares: 1000, cost: 100000, price: 100, tier: 1 }),
      ];
      const target = 150000; // needs all of A (~99,657.5) plus part of B
      const plan = solveFill(candidates, target, { discount: 1.0, strategyId: 'custom' });

      expect(plan.totals.net).toBeGreaterThanOrEqual(target - 0.01);
      const rowA = plan.rows.find(r => r.ticker === 'A');
      const rowB = plan.rows.find(r => r.ticker === 'B');
      const rowC = plan.rows.find(r => r.ticker === 'C');
      expect(rowA.sellShares).toBe(1000); // fully taken
      expect(rowB.sellShares).toBeGreaterThan(0);
      expect(rowB.sellShares).toBeLessThan(1000); // partial fill on the position that completes the target
      expect(rowC.sellShares).toBe(0); // position after the fill point untouched
    });

    it('permits 零股 — a non-multiple-of-1000 sellShares is valid output', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', shares: 5000, cost: 500000, price: 100, tier: 1 }),
      ];
      const target = 50000; // well under full position's net, forces a partial (non-1000-multiple) fill
      const plan = solveFill(candidates, target, { discount: 1.0, strategyId: 'custom' });
      const row = plan.rows[0];
      expect(row.sellShares).toBeGreaterThan(0);
      expect(row.sellShares % 1000).not.toBe(0);
      expect(plan.totals.net).toBeGreaterThanOrEqual(target - 0.01);
    });
  });

  describe('SP-5 summarize', () => {
    it('annualDividendGivenUp = sum(annualDividend x sellPct); remaining yield/tier-1 weight correct', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', shares: 1000, cost: 100000, price: 100, tier: 1, annualDividend: 1000, value: 100000 }),
        makeCandidate({ ticker: 'B', shares: 1000, cost: 100000, price: 100, tier: 2, annualDividend: 2000, value: 100000 }),
      ];
      const plan = solveFill(candidates, 50000, { discount: 1.0, strategyId: 'custom' });
      // Force a known partial sell on A only, for a fully deterministic summary.
      plan.rows = [
        { ticker: 'A', sellShares: 500, sellPct: 0.5, gross: 50000, tax: 150, fee: 71.25, net: 49778.75, realizedPL: 25000 },
        { ticker: 'B', sellShares: 0, sellPct: 0, gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0 },
      ];
      const summary = summarize(plan, candidates);

      expect(summary.annualDividendGivenUp).toBeCloseTo(1000 * 0.5 + 2000 * 0, 6);
      // remaining: A has 500 shares left @100 = 50,000; B fully remains @ 100,000
      // remaining value = 150,000; remaining tier-1 value = 50,000 (A only)
      expect(summary.remaining.value).toBeCloseTo(150000, 6);
      expect(summary.remaining.tier1WeightPct).toBeCloseTo((50000 / 150000) * 100, 6);
      // remaining annual dividend = 1000*0.5 + 2000*1 = 2500; yield = 2500/150000*100
      expect(summary.remaining.yieldPct).toBeCloseTo((2500 / 150000) * 100, 6);
    });
  });

  describe('SP-6 strategies', () => {
    const candidates = [
      makeCandidate({ ticker: 'A', tier: 1, yieldPct: 5, plPct: 0.1, value: 1000 }),
      makeCandidate({ ticker: 'B', tier: 3, yieldPct: 2, plPct: -0.2, value: 2000 }),
      makeCandidate({ ticker: 'C', tier: 2, yieldPct: 1, plPct: 0.3, value: 3000 }),
      makeCandidate({ ticker: 'D', tier: 3, yieldPct: 2, plPct: -0.1, value: 2000 }), // ties B on tier+yield, loses tie-break on value (equal) then ticker
    ];

    it('each of the four strategies orders as specified, ties broken by value then ticker => deterministic', () => {
      // tagTiered: tier 3 -> 2 -> 1; within tier, lowest yield first. B and D tie
      // on tier(3) and yield(2); equal value => ticker order (B before D).
      expect(tagTiered(candidates).map(c => c.ticker)).toEqual(['B', 'D', 'C', 'A']);

      // yieldProtect: lowest yield first, tier ignored. C(1) < B/D(2, tie->ticker) < A(5)
      expect(yieldProtect(candidates).map(c => c.ticker)).toEqual(['C', 'B', 'D', 'A']);

      // cutLosers: lowest plPct first. B(-0.2) < D(-0.1) < A(0.1) < C(0.3)
      expect(cutLosers(candidates).map(c => c.ticker)).toEqual(['B', 'D', 'A', 'C']);

      // determinism: running twice yields the same order
      expect(tagTiered(candidates).map(c => c.ticker)).toEqual(tagTiered(candidates).map(c => c.ticker));
    });

    it('proportional applies one scale factor k across every candidate and hits target', () => {
      const props = [
        makeCandidate({ ticker: 'A', shares: 1000, price: 100, cost: 50000 }),
        makeCandidate({ ticker: 'B', shares: 2000, price: 50, cost: 50000 }),
        makeCandidate({ ticker: 'C', shares: 4000, price: 25, cost: 50000 }),
      ];
      const ordered = proportional(props);
      const target = 60000;
      const plan = solveFill(ordered, target, { discount: 1.0, strategyId: 'proportional' });

      expect(plan.totals.net).toBeGreaterThanOrEqual(target - 0.01);
      // "proportional" — every position contributes roughly the same fraction
      // of its shares (not a strict all-or-nothing walk like the other three).
      const fracs = plan.rows.map(r => {
        const c = props.find(p => p.ticker === r.ticker);
        return r.sellShares / c.shares;
      });
      const maxFrac = Math.max(...fracs), minFrac = Math.min(...fracs);
      expect(maxFrac - minFrac).toBeLessThan(0.05); // all scaled by roughly the same k
      fracs.forEach(f => expect(f).toBeGreaterThan(0));
    });
  });

  describe('SP-7 locks and custom', () => {
    it('locked tickers removed before sorting; all strategies re-solve against the reduced set', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', tier: 3, yieldPct: 1, shares: 1000, price: 100, cost: 50000 }),
        makeCandidate({ ticker: 'B', tier: 3, yieldPct: 2, shares: 1000, price: 100, cost: 50000 }),
      ];
      const locked = new Set(['A']);
      const reduced = candidates.filter(c => !locked.has(c.ticker));
      expect(reduced.map(c => c.ticker)).toEqual(['B']);

      const ordered = tagTiered(reduced);
      expect(ordered.find(c => c.ticker === 'A')).toBeUndefined();
      const plan = solveFill(ordered, 50000, { discount: 1.0, strategyId: 'tagTiered' });
      expect(plan.rows.every(r => r.ticker !== 'A')).toBe(true);
    });

    it('editing sellShares yields custom; custom is never auto-re-solved', async () => {
      const { editSellShares } = await import('../src/sellplanner-ui.js');
      const candidates = [
        makeCandidate({ ticker: 'A', tier: 1, shares: 1000, price: 100, cost: 50000 }),
        makeCandidate({ ticker: 'B', tier: 1, shares: 1000, price: 100, cost: 50000 }),
      ];
      const base = solveFill(tagTiered(candidates), 50000, { discount: 1.0, strategyId: 'tagTiered' });
      expect(base.strategyId).toBe('tagTiered');

      const edited = editSellShares(base, candidates, 'B', 10, { discount: 1.0, target: 50000 });
      expect(edited.strategyId).toBe('custom');

      const rowBBefore = edited.rows.find(r => r.ticker === 'A');
      const editedAgain = editSellShares(edited, candidates, 'B', 20, { discount: 1.0, target: 50000 });
      expect(editedAgain.strategyId).toBe('custom');
      // Row A must be untouched/unchanged by the second edit to B — no re-solve.
      const rowAAfter = editedAgain.rows.find(r => r.ticker === 'A');
      expect(rowAAfter).toEqual(rowBBefore);
    });
  });

  describe('SP-8 feasibility', () => {
    it('sum net over all candidates < target => feasible=false + shortfall + E_PLAN_INFEASIBLE', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', shares: 100, price: 10, cost: 500, tier: 1 }), // tiny portfolio
      ];
      const target = TARGET_NET; // 2,000,000 — far more than this portfolio can raise
      const plan = solveFill(candidates, target, { discount: 1.0, strategyId: 'custom' });

      expect(plan.feasible).toBe(false);
      expect(plan.shortfall).toBeGreaterThan(0);
      expect(plan.errorCode).toBe('E_PLAN_INFEASIBLE');
      // full liquidation: every candidate fully sold
      expect(plan.rows.every(r => r.sellShares === candidates.find(c => c.ticker === r.ticker).shares)).toBe(true);
    });

    it('tagTiered on a fixture where tiers 2+3 < target => spilledIntoTier set, feasible stays true', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', tier: 1, shares: 100000, price: 100, cost: 5000000, yieldPct: 1 }), // huge tier-1 value
        makeCandidate({ ticker: 'B', tier: 3, shares: 100, price: 100, cost: 5000, yieldPct: 1 }),        // small tier-3
        makeCandidate({ ticker: 'C', tier: 2, shares: 100, price: 100, cost: 5000, yieldPct: 1 }),        // small tier-2
      ];
      const ordered = tagTiered(candidates); // B/C (tier3/2) first, A (tier1) last
      const target = 500000; // far more than tier2+tier3 combined (~20,000 gross) can raise
      const plan = solveFill(ordered, target, { discount: 1.0, strategyId: 'tagTiered' });

      expect(plan.feasible).toBe(true);
      expect(plan.spilledIntoTier).toBe(1);
    });
  });

  describe('SP-9 conservation', () => {
    it('sum rows.gross == sum shares x price, totals.net == sum rows.net +-0.01, sellShares <= shares', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', shares: 1000, price: 123.45, cost: 90000, tier: 1 }),
        makeCandidate({ ticker: 'B', shares: 500, price: 67.89, cost: 20000, tier: 2 }),
        makeCandidate({ ticker: 'C', shares: 2000, price: 10, cost: 15000, tier: 3 }),
      ];
      const plan = solveFill(cutLosers(candidates), 20000, { discount: 0.7, strategyId: 'cutLosers' });

      const byTicker = Object.fromEntries(candidates.map(c => [c.ticker, c]));
      for (const row of plan.rows) {
        const c = byTicker[row.ticker];
        expect(row.sellShares).toBeLessThanOrEqual(c.shares);
        expect(row.gross).toBeCloseTo(row.sellShares * c.price, 6);
      }
      const sumNet = plan.rows.reduce((s, r) => s + r.net, 0);
      expect(Math.abs(plan.totals.net - sumNet)).toBeLessThanOrEqual(0.01);
    });
  });

  describe('C.3 error taxonomy additions', () => {
    it('all candidates excluded or locked => E_PLAN_NO_CANDIDATES', () => {
      expect(() => solveFill([], TARGET_NET, { discount: 1.0, strategyId: 'tagTiered' }))
        .toThrowError('E_PLAN_NO_CANDIDATES');
    });

    it('scenario serialize -> deserialize round-trip preserves share counts; bad payload => E_SCENARIO_CORRUPT, store untouched', () => {
      const store = {};
      const storage = {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = v; },
      };

      const plan = {
        strategyId: 'tagTiered',
        rows: [
          { ticker: 'A', sellShares: 300, sellPct: 0.3, gross: 30000, tax: 90, fee: 42.75, net: 29867.25, realizedPL: 1000, realizedPLPct: 1000 / 29000 * 100 },
          { ticker: 'B', sellShares: 0, sellPct: 0, gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0, realizedPLPct: 0 },
        ],
        totals: { gross: 30000, tax: 90, fee: 42.75, net: 29867.25, realizedPL: 1000 }
      };
      const scenario = serializeScenario({ name: 'Test plan', strategyId: 'tagTiered', locked: [], plan, note: 'unit test' });
      saveScenario(scenario, storage);

      const loaded = loadScenarios(storage);
      expect(loaded).toHaveLength(1);
      // SP-11 amendment (design.md §C.11): a saved row now also carries price
      // (derived from gross/sellShares) and its dollar figures, not just the
      // share count — needed so a since-sold position can still be shown at
      // its save-time price/history instead of vanishing on reload.
      expect(loaded[0].rows).toEqual([
        { ticker: 'A', sellShares: 300, sellPct: 0.3, price: 100, gross: 30000, tax: 90, fee: 42.75, net: 29867.25, realizedPL: 1000, realizedPLPct: 1000 / 29000 * 100 }
      ]);
      expect(loaded[0].name).toBe('Test plan');

      // Corrupt the store directly and confirm it is left untouched.
      store[SCENARIO_KEY] = 'not-json{{{';
      expect(() => loadScenarios(storage)).toThrowError('E_SCENARIO_CORRUPT');
      expect(store[SCENARIO_KEY]).toBe('not-json{{{'); // untouched, not silently cleared

      expect(() => saveScenario(scenario, storage)).toThrowError('E_SCENARIO_CORRUPT');
      expect(store[SCENARIO_KEY]).toBe('not-json{{{'); // still untouched
    });
  });

  describe('Unit tests: sellplanner-ui.js helper functions', () => {
    it('deleteScenario removes only the targeted scenario', () => {
      const store = {};
      const storage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = v; } };
      const plan = { strategyId: 'custom', rows: [{ ticker: 'A', sellShares: 10 }], totals: { net: 1000 } };
      const s1 = serializeScenario({ name: 'One', strategyId: 'custom', locked: [], plan });
      const s2 = serializeScenario({ name: 'Two', strategyId: 'custom', locked: [], plan });
      saveScenario(s1, storage);
      saveScenario(s2, storage);

      const remaining = deleteScenario(s1.id, storage);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe(s2.id);
      expect(loadScenarios(storage)).toEqual(remaining);
    });

    it('reviveScenario re-prices saved share counts at current candidate prices and reports drift', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', shares: 1000, price: 120, cost: 80000, tier: 1 }),
      ];
      const scenario = { id: 'sc1', name: 'Test', savedAt: new Date().toISOString(), strategyId: 'custom', locked: [], rows: [{ ticker: 'A', sellShares: 400 }], note: '', netAtSave: 47000 };
      const { plan, drift } = reviveScenario(scenario, candidates, { discount: 1.0, target: TARGET_NET });

      expect(plan.rows[0].sellShares).toBe(400);
      expect(plan.rows[0].gross).toBeCloseTo(400 * 120, 6);
      expect(drift).toBeCloseTo(plan.totals.net - 47000, 6);
    });

    it('reviveScenario clamps a saved share count that now exceeds the held shares', () => {
      const candidates = [makeCandidate({ ticker: 'A', shares: 100, price: 50, cost: 4000, tier: 1 })];
      const scenario = { id: 'sc2', name: 'Stale', savedAt: new Date().toISOString(), strategyId: 'custom', locked: [], rows: [{ ticker: 'A', sellShares: 9999 }], note: '' };
      const { plan } = reviveScenario(scenario, candidates, { discount: 1.0 });
      expect(plan.rows[0].sellShares).toBe(100); // clamped to shares held
    });

    it('reviveScenario amendment (design.md §C.11): a since-sold ticker (absent from heldTickers) is listed frozen at its save-time price, not dropped', () => {
      const candidates = [makeCandidate({ ticker: 'A', shares: 1000, price: 120, cost: 80000, tier: 1 })];
      const scenario = {
        id: 'sc3', name: 'Two-name plan', savedAt: new Date().toISOString(), strategyId: 'custom', locked: [],
        rows: [
          { ticker: 'A', sellShares: 400 },
          { ticker: 'B', sellShares: 200, sellPct: 1, price: 80, gross: 16000, tax: 48, fee: 22.8, net: 15929.2, realizedPL: 6000, realizedPLPct: 60 }
        ],
        note: ''
      };
      // B is not in `candidates` (no longer a live position) and not in
      // heldTickers either (actually sold, unlike a merely-locked position).
      const heldTickers = new Set(['A']);
      const { plan } = reviveScenario(scenario, candidates, { discount: 1.0, heldTickers });

      expect(plan.rows).toHaveLength(2);
      const rowA = plan.rows.find(r => r.ticker === 'A');
      const rowB = plan.rows.find(r => r.ticker === 'B');
      expect(rowA.sold).toBe(false);
      expect(rowB).toMatchObject({ sold: true, price: 80, sellShares: 200, net: 15929.2, realizedPL: 6000, realizedPLPct: 60 });
      // The sold row's net still counts toward the plan's totals — the record
      // must not understate what this plan actually raised.
      expect(plan.totals.net).toBeCloseTo(rowA.net + 15929.2, 6);
    });

    it('reviveScenario does not treat a merely-locked (still-held) ticker as sold', () => {
      const candidates = [makeCandidate({ ticker: 'A', shares: 1000, price: 120, cost: 80000, tier: 1 })];
      // B is held (in heldTickers) but excluded from `candidates` right now —
      // e.g. locked, or briefly missing a price — which is not the same as sold.
      const heldTickers = new Set(['A', 'B']);
      const scenario = {
        id: 'sc4', name: 'Locked plan', savedAt: new Date().toISOString(), strategyId: 'custom', locked: ['B'],
        rows: [{ ticker: 'A', sellShares: 100 }, { ticker: 'B', sellShares: 50, price: 10, gross: 500, tax: 1.5, fee: 20, net: 478.5, realizedPL: 100, realizedPLPct: 25 }],
        note: ''
      };
      const { plan } = reviveScenario(scenario, candidates, { discount: 1.0, heldTickers });
      expect(plan.rows.map(r => r.ticker)).toEqual(['A']); // B dropped, not shown as a sold row
    });

    it('summarize (design.md §C.11 amendment) still folds a row with no matching candidate into realizedPL/net-raised totals, but not remaining-portfolio figures', () => {
      const candidates = [makeCandidate({ ticker: 'A', shares: 1000, price: 120, cost: 80000, tier: 1, annualDividend: 1000 })];
      const plan = {
        strategyId: 'custom',
        rows: [
          { ticker: 'A', sellShares: 400, sellPct: 0.4, gross: 48000, tax: 144, fee: 68.4, net: 47787.6, realizedPL: 16000, realizedPLPct: 33.33 },
          { ticker: 'B', sellShares: 200, sellPct: 1, gross: 16000, tax: 48, fee: 22.8, net: 15929.2, realizedPL: 6000, realizedPLPct: 60, sold: true, price: 80 }
        ]
      };
      const summary = summarize(plan, candidates);
      expect(summary.positionsTouched).toBe(2); // both rows sold shares
      expect(summary.positionsLiquidated).toBe(1); // only B's sellPct === 1
      expect(summary.realizedPL).toBeCloseTo(16000 + 6000, 6);
      expect(summary.taxAndFees).toBeCloseTo(144 + 68.4 + 48 + 22.8, 6);
      // remaining value only reflects A (the live candidate) — B has nothing left to remain
      expect(summary.remaining.value).toBeCloseTo(600 * 120, 6);
    });

    it('buildCsv emits header + one row per touched position, skipping untouched rows', () => {
      const candidates = [
        makeCandidate({ ticker: 'A', code: '0001', price: 100 }),
        makeCandidate({ ticker: 'B', code: '0002', price: 50 }),
      ];
      const plan = {
        strategyId: 'custom',
        rows: [
          { ticker: 'A', sellShares: 10, sellPct: 0.1, gross: 1000, tax: 3, fee: 20, net: 977, realizedPL: 50 },
          { ticker: 'B', sellShares: 0, sellPct: 0, gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0 },
        ],
        totals: { gross: 1000, tax: 3, fee: 20, net: 977, realizedPL: 50 }
      };
      const csv = buildCsv(plan, candidates);
      const lines = csv.split('\n');
      expect(lines[0]).toBe('ticker,code,shares,price,gross,tax,fee,net,realizedPL');
      expect(lines).toHaveLength(2); // header + only the touched A row
      expect(lines[1]).toBe('A,0001,10,100,1000.00,3.00,20.00,977.00,50.00');
    });

    it('buildSummaryText includes strategy, target, feasibility and shortfall/spillover when present', () => {
      const plan = { strategyId: 'tagTiered', totals: { net: 1500000 }, feasible: false, shortfall: 500000, spilledIntoTier: 1 };
      const summary = { positionsTouched: 3, positionsLiquidated: 1, realizedPL: 20000, annualDividendGivenUp: 1000, taxAndFees: 4000, remaining: { value: 900000, yieldPct: 2.5, tier1WeightPct: 40 } };
      const text = buildSummaryText(plan, summary);
      expect(text).toContain('Strategy: tagTiered');
      expect(text).toContain('Feasible: false');
      expect(text).toContain('Shortfall: 500,000');
      expect(text).toContain('Spilled into tier 1');
    });
  });

  describe('SP-12..SP-15 segment/tier binding (design.md §C.7 amendment)', () => {
    // SP-12: tier is a property of the segment, not a judgment call — the
    // src/segments.json segment->tier table must match §C.7's normative table
    // exactly, so this cannot silently drift back to the inverted ranking the
    // audit caught (tier 1 = "core semiconductor" instead of AI/datacenter).
    const EXPECTED_TIER_BY_SEGMENT = {
      cowos_foundry: 1, ai_server: 1, abf_pcb: 1, thermal_power: 1, asic_ip: 1, optical_network: 1,
      test_epi: 2, memory_storage: 2, consumer_ic: 2, panel_led: 2,
      shipping_air: 3, finance_other: 3,
    };

    it('every segments[].tier in src/segments.json matches the SP-12 table exactly', () => {
      const ids = realSegmentMap.segments.map(s => s.id);
      // every required id (incl. the previously-missing ai_server) must be present
      for (const id of Object.keys(EXPECTED_TIER_BY_SEGMENT)) {
        expect(ids).toContain(id);
      }
      for (const seg of realSegmentMap.segments) {
        expect(seg.tier).toBe(EXPECTED_TIER_BY_SEGMENT[seg.id]);
      }
      // and no extra/unexpected segment ids have snuck in
      expect(ids.sort()).toEqual(Object.keys(EXPECTED_TIER_BY_SEGMENT).sort());
    });

    it('src/segments.json has no duplicate codes and no orphan segment references', () => {
      const validIds = new Set(realSegmentMap.segments.map(s => s.id));
      const seenCodes = new Map();
      for (const [name, entry] of Object.entries(realSegmentMap.tickers)) {
        // no orphan segment reference
        expect(validIds.has(entry.segment)).toBe(true);
        // no duplicate codes across distinct company names
        expect(seenCodes.has(entry.code)).toBe(false);
        seenCodes.set(entry.code, name);
        // ledger keys by exact Chinese name — no trailing whitespace allowed
        expect(name).toBe(name.trim());
      }
    });

    it('SP-13: a ticker absent from SegmentMap.tickers resolves to {segment:"unknown", tier:2}, never tier 3', () => {
      const holdings = { 'NotInMap': { shares: 5, cost: 500 } };
      const priceMap = { 'NotInMap': { '2024-01-01': 100 } };
      const { candidates, excluded } = buildCandidates(holdings, priceMap, '2024-01-01', [], realSegmentMap);

      expect(candidates).toHaveLength(1);
      expect(candidates[0].segment).toBe('unknown');
      expect(candidates[0].tier).toBe(2);
      expect(excluded.unmapped).toContain('NotInMap');
    });
  });
});

describe('SP-18 — the dividend window is a parameter, not a constant', () => {
  // One big payout 4 years back plus a small recent one: the 5y average is
  // dominated by the old spike, the 1y window sees only the recent reality.
  const dividends = [
    { date: '2022-08-01', name: '陽明', amount: 15000 },
    { date: '2026-08-01', name: '陽明', amount: 1000 }
  ];
  const asOf = '2026-09-10';

  it('SP-18: defaults to a 5-year window when years is omitted', () => {
    expect(annualDividendFor('陽明', dividends, asOf)).toBeCloseTo(16000 / 5, 6);
    expect(annualDividendFor('陽明', dividends, asOf, 5)).toBeCloseTo(16000 / 5, 6);
  });

  it('SP-18: a 1-year window excludes the older spike entirely', () => {
    expect(annualDividendFor('陽明', dividends, asOf, 1)).toBeCloseTo(1000, 6);
  });

  it('SP-18: a shorter window can report a far lower figure than the 5-year average', () => {
    const five = annualDividendFor('陽明', dividends, asOf, 5);
    const one = annualDividendFor('陽明', dividends, asOf, 1);
    expect(one).toBeLessThan(five / 3);
  });

  it('SP-18: a non-positive or non-numeric window falls back to 5, never divides by zero', () => {
    expect(annualDividendFor('陽明', dividends, asOf, 0)).toBeCloseTo(16000 / 5, 6);
    expect(annualDividendFor('陽明', dividends, asOf, -2)).toBeCloseTo(16000 / 5, 6);
    expect(Number.isFinite(annualDividendFor('陽明', dividends, asOf, 'x'))).toBe(true);
  });
});

describe('SP-26 a loaded scenario shows what actually happened (design.md §C.13)', () => {
  // Saved on 2026-09-10 in Taiwan (13:36 UTC = 21:36 Taipei).
  const SAVED = '2026-09-10T13:36:30.000Z';
  const sale = (o) => ({ shares: 1000, netProceeds: 50000, cost: 40000, realizedPL: 10000, realizedPLPct: 25, allocated: false, ...o });
  const scenario = (rows) => ({ id: 'sc', name: 'p', savedAt: SAVED, strategyId: 'custom', locked: [], rows, note: '' });

  it('attributeSales: only sales on or after the save day count, oldest first, capped at the planned shares', () => {
    const sales = [
      sale({ date: '2026-09-09', ticker: 'A', shares: 100, netProceeds: 1, cost: 1 }),   // before save — ignored
      sale({ date: '2026-09-15', ticker: 'A', shares: 200, netProceeds: 400, cost: 200 }), // later plan's sale
      sale({ date: '2026-09-10', ticker: 'A', shares: 25, netProceeds: 50, cost: 20 })     // this plan's sale
    ];
    const a = attributeSales(scenario([{ ticker: 'A', sellShares: 25 }]), sales);
    expect(a.A).toMatchObject({ shares: 25, net: 50, cost: 20, realizedPL: 30, lastDate: '2026-09-10' });
    expect(a.A.realizedPLPct).toBeCloseTo(150, 6);
  });

  it('attributeSales: a sale only partly needed is prorated by shares', () => {
    const sales = [sale({ date: '2026-09-11', ticker: 'A', shares: 250, netProceeds: 500, cost: 250 })];
    const a = attributeSales(scenario([{ ticker: 'A', sellShares: 100 }]), sales);
    expect(a.A.shares).toBe(100);
    expect(a.A.net).toBeCloseTo(200, 6);
    expect(a.A.cost).toBeCloseTo(100, 6);
  });

  it('attributeSales: the save day is the Taiwan calendar day, not the UTC one', () => {
    // 2026-09-09T20:00Z is already 2026-09-10 04:00 in Taipei.
    const sc = { ...scenario([{ ticker: 'A', sellShares: 100 }]), savedAt: '2026-09-09T20:00:00.000Z' };
    const sales = [sale({ date: '2026-09-09', ticker: 'A', shares: 100 })];
    expect(attributeSales(sc, sales)).toEqual({});
  });

  it('attributeSales: an unparseable savedAt matches nothing rather than everything', () => {
    const sc = { ...scenario([{ ticker: 'A', sellShares: 100 }]), savedAt: 'not a date' };
    expect(attributeSales(sc, [sale({ date: '2020-01-01', ticker: 'A' })])).toEqual({});
  });

  it('a fully executed position that is no longer held shows its real figures and counts toward the total', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 1000, price: 120, cost: 80000 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'B', shares: 500, netProceeds: 30000, cost: 20000, realizedPL: 10000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'B', sellShares: 500 }]), candidates, { heldTickers: new Set(['A']), sales });

    const b = plan.rows.filter(r => r.ticker === 'B');
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ sold: true, actual: true, sellShares: 500, net: 30000, realizedPL: 10000, soldDate: '2026-09-11' });
    expect(b[0].realizedPLPct).toBeCloseTo(50, 6);
    expect(plan.totals.net).toBeCloseTo(30000, 6);
  });

  it('a fully executed position that is still held (other lots remain) is a sold row, and nothing more is planned for it', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 2000, price: 120, cost: 160000 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'A', shares: 1000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'A', sellShares: 1000 }]), candidates, { sales });

    const rows = plan.rows.filter(r => r.ticker === 'A');
    expect(rows.find(r => r.sold)).toMatchObject({ sellShares: 1000, net: 50000 });
    expect(rows.find(r => !r.sold).sellShares).toBe(0);
    expect(plan.totals.net).toBeCloseTo(50000, 6);
  });

  it('a partly executed position splits: a sold row for what sold, a live row for the rest at today\'s price', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 5000, price: 20, cost: 80000 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'A', shares: 1000, netProceeds: 29000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'A', sellShares: 1400 }]), candidates, { discount: 1.0, sales });

    const sold = plan.rows.find(r => r.ticker === 'A' && r.sold);
    const live = plan.rows.find(r => r.ticker === 'A' && !r.sold);
    expect(sold.sellShares).toBe(1000);
    expect(live.sellShares).toBe(400);
    expect(live.net).toBeCloseTo(proceeds(400, 20, { discount: 1.0 }).net, 6);
    expect(plan.totals.net).toBeCloseTo(29000 + live.net, 6);
  });

  it('an unexecuted position is unchanged — re-priced at today\'s market as before', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 1000, price: 100, cost: 50000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'A', sellShares: 300 }]), candidates, { sales: [] });
    expect(plan.rows).toHaveLength(1);
    expect(plan.rows[0]).toMatchObject({ sold: false, sellShares: 300 });
  });

  it('sold rows lead the table', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 1000, price: 100 }), makeCandidate({ ticker: 'C', shares: 1000, price: 100 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'B', shares: 10 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'B', sellShares: 10 }]), candidates, { sales });
    expect(plan.rows[0].ticker).toBe('B');
  });

  it('summarize: a sold row beside a live row for the same ticker does not double-count what remains', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 4000, price: 20, cost: 64000, tier: 2, annualDividend: 4000 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'A', shares: 1000, netProceeds: 29000, cost: 16000, realizedPL: 13000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'A', sellShares: 1400 }]), candidates, { discount: 1.0, sales });
    const s = summarize(plan, candidates);

    expect(s.remaining.value).toBeCloseTo((4000 - 400) * 20, 6); // only the live row's 400 leave the holding
    const live = plan.rows.find(r => !r.sold);
    expect(s.taxAndFees).toBeCloseTo(live.tax + live.fee, 6); // the sold row's net already has them deducted
    expect(s.realizedPL).toBeCloseTo(13000 + live.realizedPL, 6);
  });

  it('editing Sell Shares changes the live row and leaves the sold row alone', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 5000, price: 20, cost: 80000 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'A', shares: 1000, netProceeds: 29000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'A', sellShares: 1400 }]), candidates, { sales });
    const edited = editSellShares(plan, candidates, 'A', 700);

    expect(edited.rows.find(r => r.sold)).toMatchObject({ sellShares: 1000, net: 29000 });
    expect(edited.rows.find(r => !r.sold).sellShares).toBe(700);
  });

  it('saving a loaded plan writes only what is still planned, not what already sold', () => {
    const candidates = [makeCandidate({ ticker: 'A', shares: 5000, price: 20, cost: 80000 })];
    const sales = [sale({ date: '2026-09-11', ticker: 'A', shares: 1000, netProceeds: 29000 })];
    const { plan } = reviveScenario(scenario([{ ticker: 'A', sellShares: 1400 }]), candidates, { sales });
    const saved = serializeScenario({ name: 'again', strategyId: 'custom', locked: [], plan });

    expect(saved.rows).toHaveLength(1);
    expect(saved.rows[0]).toMatchObject({ ticker: 'A', sellShares: 400 });
    expect(saved.netAtSave).toBeCloseTo(plan.rows.find(r => !r.sold).net, 6);
  });
});

describe('SP-25 realizedSales (design.md §C.12)', () => {
  it('a clean round trip: net proceeds are the sell amount, cost the buy amount, P/L the difference', () => {
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 1000, amount: 100000 }
    ];
    const { byTicker, totals } = realizedSales(trades, []);

    expect(byTicker).toHaveLength(1);
    expect(byTicker[0]).toMatchObject({
      ticker: 'A', shares: 1000, netProceeds: 100000, cost: 80000,
      realizedPL: 20000, fullyExited: true, sharesReconcile: true
    });
    expect(byTicker[0].realizedPLPct).toBeCloseTo(25, 6);
    expect(totals.realizedPL).toBe(20000);
  });

  it('a partially-held ticker charges only the sold lots — the held lot\'s cost is excluded', () => {
    // Two 1,000-share buys, one sold and one still held. The held lot's cost is
    // the same ledger cell as its buy amount, so it cancels exactly.
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2020-06-10', type: 'buy', ticker: 'A', shares: 1000, amount: 90000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 1000, amount: 100000 }
    ];
    const heldLots = [{ date: '2020-06-10', ticker: 'A', shares: 1000, buyPrice: 90, cost: 90000 }];
    const { byTicker } = realizedSales(trades, heldLots);

    expect(byTicker[0].cost).toBe(80000);
    expect(byTicker[0].realizedPL).toBe(20000);
    expect(byTicker[0].fullyExited).toBe(false);
  });

  it('a PART-sold lot charges only the portion sold, per the ledger\'s remainder row', () => {
    // One 300-share buy, of which 150 shares were sold and 150 kept. The buy row
    // is left whole and the kept portion's cost goes on a separate remainder row,
    // so the sale cost 30,000−16,000. Summing "buy rows not marked held" would
    // wrongly charge the whole 30,000 to a half-sold lot.
    const trades = [
      { date: '2023-07-10', type: 'buy', ticker: 'A', shares: 300, amount: 30000 },
      { date: '2025-04-18', type: 'sell', ticker: 'A', shares: 150, amount: 20000 }
    ];
    const heldLots = [{ date: '2025-04-18', ticker: 'A', shares: 150, buyPrice: 106.67, cost: 16000 }];
    const { byTicker } = realizedSales(trades, heldLots);

    expect(byTicker[0].cost).toBe(14000);
    expect(byTicker[0].realizedPL).toBe(6000);
    expect(byTicker[0].sharesReconcile).toBe(true);
  });

  it('a zero-cost 配股 lot subtracts nothing but still counts its shares', () => {
    const trades = [
      { date: '2021-03-15', type: 'buy', ticker: 'A', shares: 500, amount: 10000 },
      { date: '2024-01-05', type: 'sell', ticker: 'A', shares: 510, amount: 12000 }
    ];
    // 10 shares arrived as a stock dividend — real shares, no cash behind them.
    const heldLots = [{ date: '2022-01-28', ticker: 'A', shares: 10, buyPrice: 0, cost: 0 }];
    const { byTicker } = realizedSales(trades, heldLots);

    expect(byTicker[0].cost).toBe(10000);
    expect(byTicker[0].realizedPL).toBe(2000);
  });

  it('a null-share held lot still cancels its cost (it is held, merely unusable for share maths)', () => {
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2020-06-10', type: 'buy', ticker: 'A', shares: null, amount: 90000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 1000, amount: 100000 }
    ];
    const heldLots = [{ date: '2020-06-10', ticker: 'A', shares: null, buyPrice: null, cost: 90000 }];
    expect(realizedSales(trades, heldLots).byTicker[0].cost).toBe(80000);
  });

  it('share counts that do not reconcile (e.g. a 配股 stock dividend) keep exact cash figures but flag the per-share split', () => {
    // 1,000 shares bought, 1,200 sold — the extra 200 came from a stock dividend
    // with no buy row behind it. Money in and money out are still exact.
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 1200, amount: 100000 }
    ];
    const { byTicker, sales, notices } = realizedSales(trades, []);

    expect(byTicker[0].netProceeds).toBe(100000);
    expect(byTicker[0].cost).toBe(80000);
    expect(byTicker[0].realizedPL).toBe(20000);
    expect(byTicker[0].sharesReconcile).toBe(false);
    expect(notices.unreconciled).toEqual(['A']);
    expect(sales[0].allocated).toBe(true);
  });

  it('per-sale cost is allocated at the average cost of the shares sold, and sums back to the ticker total', () => {
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 2000, amount: 160000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 500, amount: 60000 },
      { date: '2021-09-05', type: 'sell', ticker: 'A', shares: 1500, amount: 150000 }
    ];
    const { sales, byTicker } = realizedSales(trades, []);

    expect(sales).toHaveLength(2);
    expect(sales.map(s => s.date)).toEqual(['2021-09-05', '2021-03-05']); // newest first
    const sum = sales.reduce((s, r) => s + r.cost, 0);
    expect(sum).toBeCloseTo(byTicker[0].cost, 6);
    expect(sales.reduce((s, r) => s + r.realizedPL, 0)).toBeCloseTo(byTicker[0].realizedPL, 6);
  });

  it('a non-positive cost basis yields a null percentage rather than Infinity or NaN', () => {
    // Everything bought is still held, yet a sell exists — the derived sold cost
    // is 0, so there is no denominator to divide by.
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 500, amount: 60000 }
    ];
    const heldLots = [{ date: '2020-01-10', ticker: 'A', shares: 1000, buyPrice: 80, cost: 80000 }];
    const { byTicker, sales, totals } = realizedSales(trades, heldLots);

    expect(byTicker[0].cost).toBe(0);
    expect(byTicker[0].realizedPLPct).toBeNull();
    expect(sales[0].realizedPLPct).toBeNull();
    expect(Number.isFinite(totals.realizedPL)).toBe(true);
  });

  it('a sell with no share count still reports its proceeds, with no allocated P/L', () => {
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: null, amount: 100000 }
    ];
    const { sales, byTicker } = realizedSales(trades, []);

    expect(sales[0].netProceeds).toBe(100000);
    expect(sales[0].realizedPL).toBeNull();
    expect(sales[0].realizedPLPct).toBeNull();
    expect(byTicker[0].realizedPL).toBe(20000); // the ticker-level cash figure is unaffected
  });

  it('a ticker that was never sold never appears, and ticker whitespace is normalised', () => {
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: '台積電', shares: 1000, amount: 80000 },
      { date: '2020-01-10', type: 'buy', ticker: '鴻海 ', shares: 1000, amount: 50000 },
      { date: '2021-03-05', type: 'sell', ticker: '鴻海', shares: 1000, amount: 60000 }
    ];
    const { byTicker } = realizedSales(trades, []);

    expect(byTicker.map(t => t.ticker)).toEqual(['鴻海']);
    expect(byTicker[0].cost).toBe(50000); // the trailing-space buy row matched
  });

  it('totals are the sum of the per-ticker figures', () => {
    const trades = [
      { date: '2020-01-10', type: 'buy', ticker: 'A', shares: 1000, amount: 80000 },
      { date: '2021-03-05', type: 'sell', ticker: 'A', shares: 1000, amount: 100000 },
      { date: '2020-02-10', type: 'buy', ticker: 'B', shares: 1000, amount: 50000 },
      { date: '2021-04-05', type: 'sell', ticker: 'B', shares: 1000, amount: 30000 }
    ];
    const { byTicker, totals } = realizedSales(trades, []);

    expect(totals.netProceeds).toBe(byTicker.reduce((s, t) => s + t.netProceeds, 0));
    expect(totals.cost).toBe(byTicker.reduce((s, t) => s + t.cost, 0));
    expect(totals.realizedPL).toBe(0); // +20,000 and −20,000
  });

  it('empty or missing input is not an error', () => {
    expect(realizedSales([], []).sales).toEqual([]);
    expect(realizedSales(undefined, undefined).totals.realizedPL).toBe(0);
    expect(realizedSales(undefined, undefined).totals.realizedPLPct).toBeNull();
  });
});

