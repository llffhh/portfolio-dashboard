import { describe, it, expect } from 'vitest';
import {
  buildCandidates, proceeds, annualDividendFor, solveFill, summarize,
  tagTiered, yieldProtect, proportional, cutLosers, TARGET_NET
} from '../src/sellplanner.js';
import {
  loadScenarios, saveScenario, deleteScenario, serializeScenario, reviveScenario,
  buildCsv, buildSummaryText, SCENARIO_KEY
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
          { ticker: 'A', sellShares: 300, sellPct: 0.3, gross: 30000, tax: 90, fee: 42.75, net: 29867.25, realizedPL: 1000 },
          { ticker: 'B', sellShares: 0, sellPct: 0, gross: 0, tax: 0, fee: 0, net: 0, realizedPL: 0 },
        ],
        totals: { gross: 30000, tax: 90, fee: 42.75, net: 29867.25, realizedPL: 1000 }
      };
      const scenario = serializeScenario({ name: 'Test plan', strategyId: 'tagTiered', locked: [], plan, note: 'unit test' });
      saveScenario(scenario, storage);

      const loaded = loadScenarios(storage);
      expect(loaded).toHaveLength(1);
      expect(loaded[0].rows).toEqual([{ ticker: 'A', sellShares: 300 }]);
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
