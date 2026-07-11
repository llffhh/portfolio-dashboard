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
  depositsByYear,
  yearlyPnL,
  portfolioValueOverTime,
  buildXirrCashflows
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

    it('MET-12: yearlyPnL = V(y) − V(y−1) − invested(y); missing V omitted (rev 3.2)', () => {
      const valueByYear = { '2020': 1200, '2021': 2500, '2022': null, '2023': 2600 };
      const investedByYear = { '2020': 1000, '2021': 1000 };
      const pnl = yearlyPnL(valueByYear, investedByYear);
      // 2020: 1200-0-1000=200; 2021: 2500-1200-1000=300; 2022 omitted; 2023: 2600-2500-0=100
      expect(pnl).toEqual({ '2020': 200, '2021': 300, '2023': 100 });
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
