import unittest
from copy import deepcopy
from datetime import datetime, timezone, timedelta
from pipeline import espn, quotes, game_context as C, fpi_audit as F, model_accuracy as A, build

NOW = datetime(2026, 9, 12, 12, tzinfo=timezone.utc)


class QuoteIntegrityTests(unittest.TestCase):
    def test_core_handicap_cannot_be_used_as_american_price(self):
        block = {'provider': {'name': 'Test'}, 'spread': 3.5,
                 'homeTeamOdds': {'current': {'pointSpread': {'american': '+3.5'}}},
                 'awayTeamOdds': {'current': {'pointSpread': {'american': '-3.5'}}}}
        self.assertIsNone(espn.parse_odds(block)['spread_price_home'])
        self.assertNotIn('ATS', espn.parse_odds(block)['verified_markets'])
        block['homeTeamOdds']['current']['spread'] = {'american': '-112'}
        block['awayTeamOdds']['spreadOdds'] = -108
        result = espn.parse_odds(block)
        self.assertEqual(result['spread_price_home'], -112)
        self.assertIn('ATS', result['verified_markets'])

    def test_conflicting_lines_and_nonfinite_prices_do_not_verify(self):
        result = espn.parse_odds({'pointSpread': {'home': {'close': {'line': '-3', 'odds': '-110'}},
                               'away': {'close': {'line': '+4', 'odds': '-110'}}},
                                 'moneyline': {'home': {'close': {'odds': 'NaN'}},
                                               'away': {'close': {'odds': '100'}}}})
        self.assertEqual(result['verified_markets'], [])
        self.assertIsNone(result['spread_price_home'])

    def test_quotes_keep_whole_books_and_reject_old_prices(self):
        q = {'book': 'A', 'observed_at': NOW.isoformat(), 'verified_markets': ['ML'],
             'ml_home': -150, 'ml_away': 130}
        old = {**q, 'book': 'Old', 'observed_at': (NOW-timedelta(hours=4)).isoformat()}
        different = {**q, 'book': 'B', 'ml_home': -140, 'ml_away': 120}
        self.assertEqual(quotes.merge_quotes([q, different, old], NOW), [q, different])
        self.assertFalse(quotes.fresh({**q, 'observed_at': (NOW+timedelta(hours=1)).isoformat()}, NOW))

    def test_started_and_stale_games_cannot_qualify(self):
        row = {'market': 'TOTAL', 'tier': 'GOOD'}
        game = {'date_utc': NOW.isoformat(), 'odds': {'observed_at': NOW.isoformat()}}
        self.assertEqual(quotes.gate([dict(row)], game, {}, NOW)[0]['tier'], 'PASS')
        game['date_utc'] = (NOW+timedelta(hours=3)).isoformat()
        game['odds']['observed_at'] = (NOW-timedelta(hours=4)).isoformat()
        self.assertEqual(quotes.gate([dict(row)], game, {}, NOW)[0]['tier'], 'PASS')
        game['odds']['observed_at'] = NOW.isoformat()
        game['context'] = {'review_flags': ['Strong wind forecast — total needs review']}
        self.assertEqual(quotes.gate([dict(row)], game, {}, NOW)[0]['stake_multiplier'], .5)
        self.assertEqual(quotes.gate([{'market': 'ML', 'tier': 'GOOD'}], game, {}, NOW)[0]['tier'], 'GOOD')


class ContextTests(unittest.TestCase):
    def test_new_feed_timestamp_does_not_revive_old_injury_reports(self):
        athlete = {'id': '1', 'displayName': 'Test QB', 'position': {'abbreviation': 'QB'}}
        rows = [{'athlete': athlete, 'status': 'Out', 'date': '2020-11-21T18:31Z'},
                {'athlete': athlete, 'status': 'Questionable', 'date': NOW.isoformat()}]
        payload = {'timestamp': NOW.isoformat(), 'season': {'year': 2026},
                   'injuries': [{'id': '10', 'injuries': rows}]}
        teams, health = C.parse_availability(payload, 2026, NOW)
        self.assertEqual(health['rejected_reports'], 1)
        self.assertEqual(teams['10'][0]['status'], 'Questionable')
        self.assertEqual(health['status'], 'partial')
        self.assertEqual(C.parse_availability(payload, 2027, NOW)[0], {})

    def test_city_requires_matching_state_country_and_unambiguous_name(self):
        city = {'name': 'Springfield', 'country_code': 'US', 'admin1': 'Illinois',
                'latitude': 39.8, 'longitude': -89.6}
        self.assertIsNone(C.match_city({'results': [city]}, 'Springfield', 'MO', 'USA'))
        self.assertIsNotNone(C.match_city({'results': [city]}, 'Springfield', 'IL', 'USA'))
        self.assertIsNone(C.match_city({'results': [city, city]}, 'Springfield', 'IL', 'USA'))

    def test_forecast_requires_correct_time_and_units(self):
        block = {'hourly_units': {'wind_speed_10m': 'mp/h', 'temperature_2m': '°C'},
                 'hourly': {'time': ['2026-09-12T12:00'], 'temperature_2m': [20], 'wind_speed_10m': [25]}}
        self.assertEqual(C.kickoff_weather(block, '2026-09-12T12:30Z')['wind_mph'], 25)
        self.assertIsNone(C.kickoff_weather(block, '2026-09-13T12:30Z'))
        block['hourly_units']['wind_speed_10m'] = 'km/h'
        self.assertIsNone(C.kickoff_weather(block, '2026-09-12T12:30Z'))

    def test_conference_mapping_uses_team_identity(self):
        payload = {'children': [{'isConference': True, 'shortName': 'Big Ten',
                    'standings': {'entries': [{'team': {'id': '2483'}}]}}]}
        self.assertEqual(C.parse_conferences(payload), {'2483': 'Big Ten'})


class ForecastEvidenceTests(unittest.TestCase):
    def test_anchor_and_paired_forecasts_are_immutable(self):
        fpi = {'season': 2026, 'last_updated': '2026-09-12T08:00Z',
               'teams': {str(i): {'fpi': i} for i in range(50)}}
        state = F.initialize({}, fpi, 2026, NOW)
        anchor = deepcopy(state['anchor'])
        fpi['teams']['1']['fpi'] = 100
        F.initialize(state, fpi, 2026, NOW+timedelta(hours=1))
        self.assertEqual(state['anchor'], anchor)
        g = {'game_id': '1', 'season': 2026, 'season_type': 2, 'date_utc': '2026-09-12T18:00Z',
             'home': {'abbr': 'H'}, 'away': {'abbr': 'A'}}
        F.update(state, [(g, {'mu': 3, 'proj_total': 50}, {'mu': 4, 'proj_total': 51})], [g], 2026, NOW)
        saved = deepcopy(state['records']['1'])
        F.update(state, [(g, {'mu': 10, 'proj_total': 70}, {'mu': 9, 'proj_total': 80})], [g], 2026, NOW+timedelta(hours=1))
        self.assertEqual(saved, state['records']['1'])
        g.update(completed=True, home_score=30, away_score=20)
        report = F.update(state, [], [g], 2026, NOW+timedelta(hours=10))
        self.assertEqual(report['graded'], 1)
        self.assertEqual(report['live']['margin_mae'], 7)
        self.assertEqual(report['frozen']['margin_mae'], 6)
        self.assertFalse(report['weights_changed'])

    def test_only_results_after_anchor_enter_the_fixed_model(self):
        state = {'anchor': {'source_as_of': '2026-09-12T08:00Z'}}
        games = [{'date_utc': '2026-09-11T20:00Z'}, {'date_utc': '2026-09-12T20:00Z'}]
        self.assertEqual(F.after_anchor(games, state), [games[1]])

    def test_calibration_uses_home_wins_and_small_sample_interval_is_wide(self):
        rows = [{'probability': .8, 'actual_margin': 3}, {'probability': .8, 'actual_margin': -3}]
        evidence = A.forecast_validation(rows)
        self.assertEqual(evidence['calibration'][0]['actual'], .5)
        self.assertAlmostEqual(evidence['brier'], .34)
        interval = A.wilson(2, 2)
        self.assertLess(interval[0], .4)
        self.assertEqual(interval[1], 1)


if __name__ == '__main__':
    unittest.main()
