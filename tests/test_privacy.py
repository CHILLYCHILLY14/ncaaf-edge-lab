import json
import os
import unittest

from pipeline import build


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


class PublicLedgerPrivacyTests(unittest.TestCase):
    def test_public_summary_contains_no_wager_or_bankroll_history(self):
        summary = build.public_ledger_summary()
        self.assertIsNone(summary["starting_bankroll"])
        self.assertIsNone(summary["current_bankroll"])
        self.assertEqual(summary["total_bets"], 0)
        self.assertEqual(summary["pending"], 0)
        self.assertEqual(summary["calibration"], [])

    def test_public_settings_exclude_bankroll_and_staking_values(self):
        settings = build.public_settings({"season": 2026, "bankroll": {"starting": 500}})
        self.assertEqual(settings, {"season": 2026})

    def test_committed_public_ledger_payloads_are_neutral(self):
        with open(os.path.join(ROOT, "site", "data", "ledger.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), [])
        with open(os.path.join(ROOT, "state", "ledger.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {})

    def test_accuracy_state_contains_game_forecasts_only(self):
        for relative in ("state/model_accuracy.json", "site/data/accuracy.json"):
            with open(os.path.join(ROOT, relative), encoding="utf-8") as fh:
                payload = json.load(fh)
            records = payload.get("records") or {}
            rows = records.values() if isinstance(records, dict) else records
            self.assertTrue(all(row.get("kind") == "game" for row in rows))
            self.assertTrue(all("units" not in row and "price" not in row
                                for row in rows))

    def test_detailed_market_prediction_state_is_empty(self):
        with open(os.path.join(ROOT, "state", "predictions.json"), encoding="utf-8") as fh:
            self.assertEqual(json.load(fh), {})

    def test_build_has_no_automatic_wager_path(self):
        with open(build.__file__, encoding="utf-8") as fh:
            source = fh.read()
        self.assertNotIn("ledger.open_bet", source)
        self.assertNotIn('store.load("ledger.json"', source)
        self.assertNotIn('store.save("ledger.json"', source)


if __name__ == "__main__":
    unittest.main()
