import unittest
from pipeline.build import build_schedule


def game(event, date, week=1, phase=2, season=2026):
    return {"game_id": event, "date": date, "week": week,
            "season": season, "season_type": phase,
            "away": "AWAY", "home": "HOME", "completed": False, "odds": None}


class ScheduleScopeTests(unittest.TestCase):
    def test_postseason_week_one_does_not_mix_with_opening_weeks(self):
        rows = [game("bowl", "2026-12-20T20:00Z", phase=3),
                game("week2", "2026-09-12T20:00Z", week=2),
                game("opening", "2026-08-29T20:00Z"),
                game("week1", "2026-09-05T20:00Z")]
        schedule = build_schedule(rows)
        self.assertEqual([s["rows"][0]["game_id"] for s in schedule],
                         ["opening", "week1", "week2", "bowl"])
        self.assertTrue(schedule[0]["label"].startswith("Opening weekend"))
        self.assertEqual(sum(s["label"].startswith("Week 1") for s in schedule), 1)
        self.assertTrue(schedule[-1]["label"].startswith("Postseason"))
        self.assertEqual(len({s["id"] for s in schedule}), 4)
        self.assertTrue(all(s["week"] == "1" for s in schedule if s["season_type"] == 3))

    def test_seasons_and_phases_with_same_week_get_distinct_keys(self):
        schedule = build_schedule([
            game("pre", "2026-09-01T20:00Z", phase=1),
            game("regular", "2026-09-02T20:00Z"),
            game("post", "2026-09-03T20:00Z", phase=3),
            game("other", "2027-09-04T20:00Z", season=2027)])
        self.assertEqual(len(schedule), 4)
        self.assertEqual(len({s["id"] for s in schedule}), 4)

    def test_overnight_utc_game_uses_eastern_calendar_day(self):
        schedule = build_schedule([game("late", "2026-08-30T02:00Z")])
        self.assertEqual(schedule[0]["date_range"], "Aug 29")
        self.assertEqual(schedule[0]["rows"][0]["date"], "2026-08-30T02:00Z")

    def test_missing_phase_is_unconfirmed_and_prices_stay_missing(self):
        schedule = build_schedule([game("unknown", "2026-09-05T20:00Z", phase=None)])
        self.assertEqual(schedule[0]["phase_label"], "Season phase unconfirmed")
        self.assertFalse(schedule[0]["rows"][0]["has_odds"])
        self.assertIsNone(schedule[0]["rows"][0]["spread_home"])


if __name__ == "__main__":
    unittest.main()
