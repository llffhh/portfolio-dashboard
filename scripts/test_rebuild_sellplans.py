import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import rebuild_sellplans as rb  # noqa: E402


def buy(date, t, shares, amount):
    return {"date": date, "type": "buy", "ticker": t, "shares": shares, "amount": amount}


def sell(date, t, shares, amount):
    return {"date": date, "type": "sell", "ticker": t, "shares": shares, "amount": amount}


def lot(t, shares, cost):
    return {"date": "2020-01-01", "ticker": t, "shares": shares, "cost": cost}


class TaipeiDay(unittest.TestCase):
    def test_utc_evening_is_the_next_taiwan_day(self):
        self.assertEqual(rb.taipei_day("2026-09-09T20:00:00.000Z"), "2026-09-10")

    def test_afternoon_stays_on_the_same_day(self):
        self.assertEqual(rb.taipei_day("2026-09-15T05:43:21.752Z"), "2026-09-15")


class NormalizeDateKey(unittest.TestCase):
    def test_gas_raw_date_string(self):
        self.assertEqual(rb.normalize_date_key("Sun Dec 31 2017 08:00:00 GMT+0800 (台北標準時間)"), "2017-12-31")

    def test_iso_and_closeyest_pass_through(self):
        self.assertEqual(rb.normalize_date_key("2026-09-15"), "2026-09-15")
        self.assertEqual(rb.normalize_date_key("closeyest"), "closeyest")


class NetProceeds(unittest.TestCase):
    def test_matches_the_planner_including_the_fee_floor(self):
        self.assertAlmostEqual(rb.net_proceeds(10, 100), 1000 - 3 - 20)

    def test_large_order_uses_the_rate(self):
        gross = 10_000 * 1000
        self.assertAlmostEqual(rb.net_proceeds(10_000, 1000), gross - gross * 0.003 - gross * 0.001425)

    def test_nothing_sold(self):
        self.assertEqual(rb.net_proceeds(0, 100), 0)


class LedgerSales(unittest.TestCase):
    def test_part_sold_lot_charges_only_the_part_that_left(self):
        trades = [buy("2023-07-10", "A", 300, 30000), sell("2025-04-18", "A", 150, 20000)]
        sales = rb.ledger_sales(trades, [lot("A", 150, 16000)])
        self.assertEqual(len(sales), 1)
        self.assertAlmostEqual(sales[0]["cost"], 14000)

    def test_cost_split_at_average_per_share(self):
        trades = [buy("2020-01-01", "A", 2000, 160000), sell("2021-01-01", "A", 500, 1), sell("2021-06-01", "A", 1500, 1)]
        costs = sorted(s["cost"] for s in rb.ledger_sales(trades, []))
        self.assertEqual(costs, [40000, 120000])

    def test_sale_without_shares_has_no_cost(self):
        trades = [buy("2020-01-01", "A", 1000, 80000), sell("2021-01-01", "A", None, 1)]
        self.assertIsNone(rb.ledger_sales(trades, [])[0]["cost"])

    def test_whitespace_in_tickers_is_ignored(self):
        trades = [buy("2020-01-01", "A ", 1000, 50000), sell("2021-01-01", "A", 1000, 60000)]
        self.assertAlmostEqual(rb.ledger_sales(trades, [])[0]["cost"], 50000)


class PositionAtSave(unittest.TestCase):
    def test_still_held_and_untouched(self):
        lots = [lot("A", 1000, 50000)]
        self.assertEqual(rb.position_at_save("A", 300, "2026-09-15", lots, [], []), (1000, 50000, 0))

    def test_a_sale_after_the_save_is_added_back(self):
        trades = [buy("2020-01-01", "A", 2000, 100000), sell("2026-09-16", "A", 500, 99999)]
        lots = [lot("A", 1500, 75000)]
        sales = rb.ledger_sales(trades, lots)
        hold, cost, rolled = rb.position_at_save("A", 500, "2026-09-15", lots, trades, sales)
        self.assertEqual((hold, rolled), (2000, 0))
        self.assertAlmostEqual(cost, 100000)

    def test_a_buy_after_the_save_is_removed(self):
        trades = [buy("2020-01-01", "A", 1000, 50000), buy("2026-09-20", "A", 500, 40000)]
        lots = [lot("A", 1000, 50000), lot("A", 500, 40000)]
        hold, cost, _ = rb.position_at_save("A", 100, "2026-09-15", lots, trades, [])
        self.assertEqual((hold, cost), (1000, 50000))

    def test_a_sale_made_before_the_save_is_rolled_back_when_the_plan_records_it(self):
        # Fully sold on 09-14; a plan saved 09-15 still lists the 25 shares it sold.
        trades = [buy("2020-01-01", "A", 25, 50000), sell("2026-09-14", "A", 25, 90000)]
        sales = rb.ledger_sales(trades, [])
        hold, cost, rolled = rb.position_at_save("A", 25, "2026-09-15", [], trades, sales)
        self.assertEqual((hold, rolled), (25, 25))
        self.assertAlmostEqual(cost, 50000)

    def test_roll_back_stops_as_soon_as_the_plan_is_covered(self):
        trades = [buy("2020-01-01", "A", 3000, 30000),
                  sell("2026-09-10", "A", 1000, 1), sell("2026-09-14", "A", 1000, 1)]
        lots = [lot("A", 1000, 10000)]
        sales = rb.ledger_sales(trades, lots)
        hold, _, rolled = rb.position_at_save("A", 2000, "2026-09-15", lots, trades, sales)
        self.assertEqual((hold, rolled), (2000, 1000))  # only the newest earlier sale was needed


class CloseOnOrBefore(unittest.TestCase):
    series = [("2026-09-10", 100.0), ("2026-09-11", 101.0), ("2026-09-14", 99.0)]

    def test_exact_trading_day(self):
        self.assertEqual(rb.close_on_or_before(self.series, "2026-09-14"), ("2026-09-14", 99.0))

    def test_weekend_falls_back_to_friday(self):
        self.assertEqual(rb.close_on_or_before(self.series, "2026-09-13"), ("2026-09-11", 101.0))

    def test_nothing_before(self):
        self.assertIsNone(rb.close_on_or_before(self.series, "2026-09-01"))


class ChooseCode(unittest.TestCase):
    def test_a_code_whose_price_disagrees_with_the_sheet_is_rejected(self):
        # The dividend code is right (price ~92); the other maps to a different company (~27).
        prices = {"2222": 92.0, "1111": 27.0}
        picked = rb.choose_code([("1111", "segments.json"), ("2222", "dividends")], 90.0, prices.get)
        self.assertEqual(picked, ("2222", "dividends"))

    def test_nothing_agrees(self):
        self.assertEqual(rb.choose_code([("1111", "segments.json")], 90.0, {"1111": 27.0}.get), (None, None))

    def test_without_a_sheet_price_only_a_dividend_code_is_trusted(self):
        self.assertEqual(rb.choose_code([("1111", "segments.json")], None, {"1111": 10.0}.get), (None, None))
        self.assertEqual(rb.choose_code([("2222", "dividends")], None, {"2222": 10.0}.get), ("2222", "dividends"))

    def test_code_with_no_market_data_is_skipped(self):
        self.assertEqual(rb.choose_code([("0000", "dividends"), ("2222", "dividends")], 10.0, {"2222": 10.5}.get),
                         ("2222", "dividends"))


class BuildRowAndFigures(unittest.TestCase):
    def test_schema_and_rounding(self):
        row = rb.build_row("A", 20.0, 723.456, 100.0, 60000.4)
        self.assertEqual(row, {"ticker": "A", "sellShares": 20, "sellPrice": 723.46, "holdShares": 100, "cost": 60000})

    def test_no_price_leaves_sell_price_out(self):
        self.assertNotIn("sellPrice", rb.build_row("A", 20, None, 100, 60000))

    def test_figures_match_the_planner(self):
        row = {"ticker": "A", "sellShares": 20, "sellPrice": 723, "holdShares": 100, "cost": 60000}
        net, pl, pct = rb.row_figures(row)
        self.assertAlmostEqual(net, rb.net_proceeds(20, 723))
        self.assertAlmostEqual(pl, 20 * 723 - 20 * 600)
        self.assertAlmostEqual(pct, (20 * 723 - 12000) / 12000 * 100)

    def test_nothing_held_gives_no_percentage(self):
        net, pl, pct = rb.row_figures({"ticker": "A", "sellShares": 20, "sellPrice": 10, "holdShares": 0, "cost": 0})
        self.assertIsNotNone(net)
        self.assertIsNone(pl)
        self.assertIsNone(pct)


if __name__ == "__main__":
    unittest.main()
