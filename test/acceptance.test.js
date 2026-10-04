import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import {
  currentHoldings,
  costOfHoldings,
  investedCapital,
  currentValue,
  roi,
  xirr,
  simpleCagr,
  dividendsByYear,
  yieldOnCost,
  depositsByYear,
  yearlyPnL,
  portfolioValueOverTime,
  buildXirrCashflows,
  matchedDividends,
  accountFlows
} from '../src/metrics.js';
import { LocalJsonSource, MockPriceSource } from '../src/data.js';

describe('Acceptance Tests (design.md Section A)', () => {
  
  beforeAll(() => {
    global.fetch = vi.fn(async (url) => {
      try {
        const filepath = path.resolve(url);
        const content = await fs.readFile(filepath, 'utf-8');
        return {
          ok: true,
          json: async () => JSON.parse(content)
        };
      } catch (e) {
        return { ok: false };
      }
    });
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  describe('A.2 Metrics engine (core)', () => {
    it('MET-1: currentHoldings - per-ticker shares+cost from HeldLots; null-share lots excluded + surfaced', () => {
      const lots = [
        { date: '2020', ticker: 'A', shares: 100, cost: 1000, buyPrice: 10 },
        { date: '2021', ticker: 'A', shares: 50, cost: 600, buyPrice: 12 },
        { date: '2022', ticker: 'B', shares: null, cost: 500, buyPrice: null },
      ];
      const { holdings, reviewLots } = currentHoldings(lots);
      expect(holdings).toEqual({
        'A': { shares: 150, cost: 1600 }
      });
      expect(reviewLots).toEqual([
        { date: '2022', ticker: 'B', shares: null, cost: 500, buyPrice: null }
      ]);
    });

    it('MET-2: costOfHoldings = Σ HeldLot.cost', () => {
      const lots = [
        { date: '2020', ticker: 'A', shares: 100, cost: 1000, buyPrice: 10 },
        { date: '2021', ticker: 'A', shares: 50, cost: 600, buyPrice: 12 },
        { date: '2022', ticker: 'B', shares: null, cost: 500, buyPrice: null },
      ];
      expect(costOfHoldings(lots)).toBe(2100);
    });

    it('MET-3: investedCapital = Σ Deposit.amount', () => {
      const deposits = [
        { date: '2020', amount: 1000 },
        { date: '2021', amount: 500 },
      ];
      expect(investedCapital(deposits)).toBe(1500);
    });

    it('MET-3: investedCapital nets CD轉出 withdrawals (negative deposits)', () => {
      const deposits = [
        { date: '2020', amount: 1000 },
        { date: '2021', amount: 500 },
        { date: '2021', amount: -300 },   // CD轉出 — cash moved out of the account
      ];
      expect(investedCapital(deposits)).toBe(1200);
    });

    it('CF-1: a CD轉出 withdrawal becomes a POSITIVE xirr cashflow', () => {
      const flows = buildXirrCashflows(
        [{ date: '2020-01-01', amount: 1000 }, { date: '2021-01-01', amount: -300 }],
        [], [], undefined, undefined
      );
      expect(flows.find(f => f.date === '2020-01-01').amount).toBe(-1000);
      expect(flows.find(f => f.date === '2021-01-01').amount).toBe(300);
    });

    it('MET-4: currentValue = Σ shares×price; held ticker w/o price ⇒ E_NO_PRICE', () => {
      const holdings = {
        'A': { shares: 100, cost: 1000 },
        'B': { shares: 50, cost: 500 }
      };
      const priceMap = {
        'A': { '2023-12-31': 20 },
        'B': { '2023-12-31': 15 }
      };
      expect(currentValue(holdings, priceMap, '2023-12-31')).toBe(100 * 20 + 50 * 15);

      const holdingsMissing = {
        'A': { shares: 100, cost: 1000 },
        'C': { shares: 10, cost: 100 }
      };
      expect(() => currentValue(holdingsMissing, priceMap, '2023-12-31'))
        .toThrowError('E_NO_PRICE');
    });

    it('MET-5: roi = (value + dividends − cost) / cost; cost 0 ⇒ E_DIV_ZERO_COST', () => {
      expect(roi(2500, 500, 2000)).toBe((2500 + 500 - 2000) / 2000); // 0.5
      expect(() => roi(2500, 500, 0)).toThrowError('E_DIV_ZERO_COST');
    });

    it('MET-6: xirr converges |NPV(r)|<1e-6; E_XIRR_BAD_INPUT; E_XIRR_NO_CONVERGE', () => {
      const cashflows = [
        { date: '2020-01-01', amount: -1000 },
        { date: '2021-01-01', amount: 1100 }
      ];
      const rate = xirr(cashflows);
      expect(rate).toBeCloseTo(0.1, 2);

      expect(() => xirr([{ date: '2020', amount: 1000 }])).toThrowError('E_XIRR_BAD_INPUT');

      const noConvergeFlows = [
        { date: '2020-01-01', amount: -100 },
        { date: '2021-01-01', amount: 200 },
        { date: '2022-01-01', amount: -150 }
      ];
      expect(() => xirr(noConvergeFlows)).toThrowError('E_XIRR_NO_CONVERGE');
    });

    it('MET-7: simpleCagr = (endValue/beginValue)^(1/years) − 1; E_CAGR_DOMAIN', () => {
      expect(simpleCagr(1000, 1210, 2)).toBeCloseTo(0.1, 4);
      expect(() => simpleCagr(0, 1000, 2)).toThrowError('E_CAGR_DOMAIN');
      expect(() => simpleCagr(1000, 1210, 0)).toThrowError('E_CAGR_DOMAIN');
    });

    it('MET-11: depositsByYear conservation (rev 3.2)', () => {
      const deposits = [
        { date: '2017-01-01', amount: 1000 },
        { date: '2017-06-01', amount: 2000 },
        { date: '2019-03-01', amount: 500 },
      ];
      const byYear = depositsByYear(deposits);
      expect(byYear).toEqual({ '2017': 3000, '2019': 500 });
      expect(Object.values(byYear).reduce((a, b) => a + b, 0)).toBe(3500);
    });

    it('MET-12: yearlyPnL splits realized (average cost) + unrealized; sum = ΔV − buys + sells (rev 4.9)', () => {
      const trades = [
        { date: '2020-02-01', type: 'buy', ticker: 'A', shares: 100, amount: 1000 },
        { date: '2020-06-01', type: 'buy', ticker: 'A', shares: 100, amount: 2000 },   // avg 15/share
        { date: '2021-03-01', type: 'sell', ticker: 'A', shares: 50, amount: 1500 },   // cost 750
        { date: '2021-03-01', type: 'buy', ticker: 'B ', shares: 10, amount: 500 },
      ];
      const { years, zeroCostSells } = yearlyPnL(trades, { '2020': 3600, '2021': 3200 });
      // 2020: cost 3000 → unrealized 600; 2021: realized 1500−750=750,
      // cost 2250+500=2750 → unrealized (3200−2750)−(3600−3000) = −150
      expect(years).toEqual({
        '2020': { realized: 0, unrealized: 600 },
        '2021': { realized: 750, unrealized: -150 }
      });
      expect(zeroCostSells).toEqual([]);
      // Identity with the trade-based total: ΔV − buys + sells
      expect(years['2021'].realized + years['2021'].unrealized).toBe(3200 - 3600 - 500 + 1500);
    });

    it('MET-12: shares sold beyond those bought carry cost 0; same-day buy precedes sell', () => {
      const trades = [
        { date: '2020-01-10', type: 'sell', ticker: 'X', shares: 30, amount: 600 },
        { date: '2020-01-10', type: 'buy', ticker: 'X', shares: 10, amount: 100 },
      ];
      const { years, zeroCostSells } = yearlyPnL(trades, { '2020': 0 });
      // 10 shares at cost 100, 20 extra at 0 → realized 600 − 100 = 500
      expect(years['2020']).toEqual({ realized: 500, unrealized: 0 });
      expect(zeroCostSells).toEqual([{ date: '2020-01-10', ticker: 'X', shares: 20 }]);
    });

    it('MET-12: a year with no V has unrealized null and the next priced year spans the gap', () => {
      const trades = [
        { date: '2020-01-01', type: 'buy', ticker: 'A', shares: 10, amount: 1000 },
        { date: '2021-05-01', type: 'sell', ticker: 'A', shares: 5, amount: 700 },
      ];
      const { years } = yearlyPnL(trades, { '2020': 1100, '2021': null, '2022': 900 });
      expect(years['2021']).toEqual({ realized: 200, unrealized: null });
      // (900 − 500) − (1100 − 1000) = 300
      expect(years['2022']).toEqual({ realized: 0, unrealized: 300 });
    });

    it('MET-12: holdings before the first priced year-end ⇒ that year\'s unrealized is unknown', () => {
      const trades = [{ date: '2019-01-01', type: 'buy', ticker: 'A', shares: 10, amount: 1000 }];
      const { years } = yearlyPnL(trades, { '2020': 1200, '2021': 1500 });
      expect(years['2019'].unrealized).toBeNull();
      expect(years['2020'].unrealized).toBeNull();
      expect(years['2021'].unrealized).toBe(300);
    });

    it('MET-8: dividendsByYear conservation', () => {
      const divs = [
        { date: '2020-05-01', amount: 100 },
        { date: '2020-08-01', amount: 200 },
        { date: '2021-06-01', amount: 150 },
      ];
      expect(dividendsByYear(divs)).toEqual({
        '2020': 300,
        '2021': 150
      });
    });

    it('MET-9: portfolioValueOverTime ascending dates, value=Σ sharesHeld(t)×price; E_NO_PRICE', () => {
      const trades = [
        { date: '2020-01-01', type: 'buy', ticker: 'A', shares: 100, amount: 1000 },
        { date: '2020-06-01', type: 'buy', ticker: 'B', shares: 50, amount: 500 },
        { date: '2021-01-01', type: 'sell', ticker: 'A', shares: 20, amount: 250 },
      ];
      const priceMap = {
        'A': { '2020-12-31': 15, '2021-12-31': 18 },
        'B': { '2020-12-31': 12, '2021-12-31': 14 }
      };
      const dates = ['2020-12-31', '2021-12-31'];
      const result = portfolioValueOverTime(trades, priceMap, dates);
      expect(result).toEqual([
        { date: '2020-12-31', value: 100 * 15 + 50 * 12 },
        { date: '2021-12-31', value: 80 * 18 + 50 * 14 }
      ]);

      const missingPriceMap = {
        'A': { '2020-12-31': 15 }
      };
      expect(() => portfolioValueOverTime(trades, missingPriceMap, dates)).toThrowError('E_NO_PRICE');
    });
  });

  describe('A.3 XIRR & CAGR assembly', () => {
    it('CF-1: buildXirrCashflows signs: deposits -, dividends/withdrawals/terminal +', () => {
      const deposits = [{ date: '2020-01-01', amount: 1000 }];
      const divs = [{ date: '2020-06-01', amount: 50 }];
      const withdrawals = [{ date: '2020-08-01', amount: 100 }];
      const terminalValue = 1100;
      const terminalDate = '2020-12-31';

      const flows = buildXirrCashflows(deposits, divs, withdrawals, terminalValue, terminalDate);
      expect(flows).toEqual([
        { date: '2020-01-01', amount: -1000 },
        { date: '2020-06-01', amount: 50 },
        { date: '2020-08-01', amount: 100 },
        { date: '2020-12-31', amount: 1100 }
      ]);
    });
  });

  describe('A.2d Rev 4.8 matched-lot ROI & account return', () => {
    it('MET-14: matchedDividends counts only held tickers, from their oldest held lot on', () => {
      const lots = [
        { date: '2021-01-10', ticker: 'A', cost: 1000 },
        { date: '2020-06-01', ticker: ' A ', cost: 1000 },  // oldest A lot, padded name
        { date: '2022-03-01', ticker: 'B', cost: 500 }
      ];
      const divs = [
        { date: '2020-05-31', name: 'A', amount: 1 },    // before oldest held A lot
        { date: '2020-06-01', name: 'A', amount: 10 },   // on the day — counts
        { date: '2023-07-01', name: 'A ', amount: 20 },
        { date: '2021-07-01', name: 'B', amount: 2 },    // earlier B lot, since sold
        { date: '2023-07-01', name: 'B', amount: 30 },
        { date: '2023-07-01', name: 'SOLD', amount: 4 }, // ticker no longer held
        { date: '2023-07-01', name: null, amount: 8 }    // unnamed row
      ];
      expect(matchedDividends(lots, divs)).toBe(60);
      expect(matchedDividends([], divs)).toBe(0);
    });

    it('MET-15: accountFlows splits CD轉入 (+) from CD轉出 (−) without netting', () => {
      const deposits = [
        { date: '2020-01-01', amount: 1000 },
        { date: '2021-01-01', amount: 500 },
        { date: '2022-01-01', amount: -2000 }
      ];
      expect(accountFlows(deposits)).toEqual({ deposited: 1500, withdrawn: 2000 });
      // Withdrawals exceeding deposits: invested capital is negative, flows stay positive.
      expect(investedCapital(deposits)).toBe(-500);
    });

    it('CF-3: account ROI / CAGR = roi / simpleCagr over deposited vs value + withdrawn', () => {
      const { deposited, withdrawn } = accountFlows([
        { date: '2020-01-01', amount: 1000 },
        { date: '2021-01-01', amount: -500 }
      ]);
      expect(roi(710, withdrawn, deposited)).toBeCloseTo(0.21, 6);
      expect(simpleCagr(deposited, 710 + withdrawn, 2)).toBeCloseTo(0.1, 6);
    });
  });

  describe('A.4 / A.5 Data and Price Source', () => {
    it('LocalJsonSource returns schema-valid data; malformed ⇒ E_DATA_PARSE', async () => {
      const source = new LocalJsonSource('fixtures');
      const deposits = await source.loadDeposits();
      expect(deposits.length).toBeGreaterThan(0);
      expect(deposits[0]).toHaveProperty('date');
      expect(deposits[0]).toHaveProperty('amount');

      global.fetch.mockImplementationOnce(async () => ({
        ok: true,
        json: async () => [{ date: '2020-01-01', amount: 'not-a-number' }]
      }));
      await expect(source.loadDeposits()).rejects.toThrow('E_DATA_PARSE');
    });

    it('MockPriceSource deterministic PriceMap from fixture', async () => {
      const source = new MockPriceSource('fixtures');
      const prices = await source.getPrices(['台積電', '鴻海']);
      expect(prices).toHaveProperty('台積電');
      expect(prices['台積電']).toHaveProperty('2020-12-31', 530);
    });
  });
});

describe('MET-13 — dividend yield on cost (Rev 4.1)', () => {
  const holdings = { A: { shares: 100, cost: 1000 }, B: { shares: 50, cost: 500 } };
  const annual = { A: 50, B: 100 };
  const divOf = (t) => annual[t] ?? 0;

  it('MET-13: per-ticker yield = annual dividend / cost, as a percentage', () => {
    const r = yieldOnCost(holdings, divOf);
    expect(r.byTicker.A.yieldPct).toBeCloseTo(5, 10);
    expect(r.byTicker.B.yieldPct).toBeCloseTo(20, 10);
  });

  it('MET-13: portfolio yield uses summed dividends over summed cost, not an average of ratios', () => {
    const r = yieldOnCost(holdings, divOf);
    expect(r.annualDividend).toBe(150);
    expect(r.cost).toBe(1500);
    expect(r.yieldPct).toBeCloseTo(10, 10);
    // the naive mean of 5% and 20% would be 12.5% — cost-weighting is the contract
    expect(r.yieldPct).not.toBeCloseTo(12.5, 3);
  });

  it('MET-13: zero cost yields null rather than Infinity, and empty holdings yield null', () => {
    expect(yieldOnCost({ Z: { shares: 1, cost: 0 } }, () => 9).byTicker.Z.yieldPct).toBeNull();
    expect(yieldOnCost({}, () => 0).yieldPct).toBeNull();
  });

  it('MET-13: only currently-held tickers contribute — a sold-out payer cannot inflate the total', () => {
    const r = yieldOnCost(holdings, (t) => (t === 'SOLD' ? 99999 : divOf(t)));
    expect(r.annualDividend).toBe(150);
  });
});
