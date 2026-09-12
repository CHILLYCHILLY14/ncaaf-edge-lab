"""Prospective paired test of rolling FPI versus a fixed, dated FPI baseline.

No live weight changes. No retrospective forecasts. Each game is frozen once,
at the same instant for both variants, with no wagers or prices in the log.
"""
from datetime import datetime, timezone
from copy import deepcopy
from .model_accuracy import instant, number, mean


def initialize(state, fpi, season, now=None):
    now = now or datetime.now(timezone.utc)
    if state and str(state.get('season')) != str(season):
        state.clear()
    if (not state.get('anchor') and len(fpi.get('teams') or {}) >= 50
            and fpi.get('season') in (None, season)):
        source = instant(fpi.get('last_updated'))
        if source and source <= now:
            state.update(season=season, anchor={'captured_at': now.isoformat(),
                         'source_as_of': source.isoformat(), 'teams': deepcopy(fpi['teams'])}, records={})
    return state


def after_anchor(games, state):
    cutoff = instant((state.get('anchor') or {}).get('source_as_of'))
    return [g for g in games if cutoff and (start := instant(g.get('date_utc'))) and start > cutoff]


def update(state, paired, games, season, now=None):
    now = now or datetime.now(timezone.utc)
    records = state.setdefault('records', {})
    for g, live, frozen in paired:
        gid, start = str(g['game_id']), instant(g.get('date_utc'))
        if gid in records or not start or start <= now or g.get('completed'):
            continue
        if str(g.get('season')) != str(season) or str(g.get('season_type')) != '2':
            continue
        def clean(p):
            return {'margin': number(p.get('mu')), 'total': number(p.get('proj_total'))}
        if any(number(p.get(k)) is None for p in (live, frozen) for k in ('mu', 'proj_total')):
            continue
        records[gid] = {'game_id': gid, 'start': g['date_utc'], 'captured_at': now.isoformat(),
                        'matchup': f"{g['away']['abbr']} @ {g['home']['abbr']}",
                        'live': clean(live), 'frozen': clean(frozen), 'result': 'Pending'}
    source = {str(g['game_id']): g for g in games}
    for gid, r in records.items():
        g = source.get(gid) or {}
        if r['result'] != 'Pending':
            continue
        if g.get('canceled'):
            r['result'] = 'Void'
        elif g.get('completed'):
            h, a = number(g.get('home_score')), number(g.get('away_score'))
            if h is not None and a is not None:
                r.update(result='Graded', actual_margin=h-a, actual_total=h+a)
    finals = [r for r in records.values() if r['result'] == 'Graded']
    def metrics(variant):
        return {'n': len(finals),
                'margin_mae': mean(abs(r[variant]['margin']-r['actual_margin']) for r in finals),
                'total_mae': mean(abs(r[variant]['total']-r['actual_total']) for r in finals)}
    return {'season': season, 'status': 'collecting evidence',
            'anchor_captured_at': (state.get('anchor') or {}).get('captured_at'),
            'source_as_of': (state.get('anchor') or {}).get('source_as_of'),
            'paired_games': len(records), 'graded': len(finals),
            'live': metrics('live'), 'frozen': metrics('frozen'),
            'weights_changed': False,
            'method': 'Same-time pregame forecasts. Current FPI plus season results versus fixed FPI plus games after its source date. This baseline was captured during the season; it is not a preseason snapshot.'}
