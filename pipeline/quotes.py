"""Complete sportsbook quotes, independent provider checks and freshness gates."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
from . import espn
from .game_context import get_json, age_hours
from .model_accuracy import instant
import requests


def fresh(quote, now, max_hours=3):
    return 0 <= age_hours(quote.get('observed_at'), now) <= max_hours


def merge_quotes(quotes, now):
    by_book = {}
    for q in quotes:
        if not espn.has_priced_market(q) or not fresh(q, now):
            continue
        key = ''.join(c for c in q.get('book', '').lower() if c.isalnum())
        if not key:
            continue
        old = by_book.get(key)
        if old is None or instant(q['observed_at']) > instant(old['observed_at']):
            by_book[key] = q
    return list(by_book.values())


def enrich(games, cfg, cache, now=None):
    now = now or datetime.now(timezone.utc)
    eligible = [g for g in games if not g.get('completed') and not g.get('postponed') and not g.get('canceled')
                and g.get('state') != 'in' and (start := instant(g.get('date_utc')))
                and now < start < now+timedelta(days=int(cfg['data']['lookahead_days']))]
    # Rotate extra provider checks, prioritizing missing markets then earliest
    # games. Every scoreboard refresh still updates all games in the window.
    eligible.sort(key=lambda g: (not bool(g['home'].get('conference') and g['away'].get('conference')),
                                len((g.get('odds') or {}).get('verified_markets') or []) == 3,
                                (cache.get(g['game_id']) or {}).get('checked_at') or '', g['date_utc']))
    selected = [g for g in eligible if age_hours((cache.get(g['game_id']) or {}).get('checked_at'), now) >= .45][:48]
    def fetch(g):
        gid = g['game_id']
        try:
            data = get_json(f'{espn.CORE}/events/{gid}/competitions/{gid}/odds', {'limit': 30})
            return gid, {'checked_at': now.isoformat(),
                         'quotes': espn.parse_quotes(data.get('items') or [], 'ESPN provider feed', now.isoformat()),
                         'status': 'checked'}
        except (requests.RequestException, ValueError):
            return gid, {'checked_at': now.isoformat(), 'quotes': [], 'status': 'unavailable'}
    with ThreadPoolExecutor(max_workers=4) as pool:
        cache.update(pool.map(fetch, selected))
    books = set()
    for g in eligible:
        qs = merge_quotes([*(g.get('odds_quotes') or []), g.get('odds') or {},
                           *((cache.get(g['game_id']) or {}).get('quotes') or [])], now)
        g['odds_quotes'] = qs
        books.update(q['book'] for q in qs)
        if qs:
            priority = cfg['data']['odds_provider_priority']
            qs.sort(key=lambda q: (-len(q['verified_markets']),
                                  priority.index(q['book']) if q['book'] in priority else len(priority)))
            g['odds'] = qs[0]
    live_ids = {g['game_id'] for g in eligible}
    for gid in list(cache):
        if gid not in live_ids:
            del cache[gid]
    return {'provider_checks': len(selected), 'books': sorted(books),
            'games_multiple_books': sum(len(g.get('odds_quotes') or []) > 1 for g in eligible),
            'max_quote_age_hours': 3, 'checked_at': now.isoformat()}


def shortlist(candidates, rank):
    """One best eligible quote per game/market/side, before correlation caps."""
    best = {}
    for c in candidates:
        key = (c['game_id'], c['market'], c['side'])
        old = best.get(key)
        order = lambda r: (rank[r['tier']], -r.get('action_edge', r['edge']))
        if old is None or order(c) < order(old):
            best[key] = c
    return list(best.values())


def gate(candidates, g, cfg, now=None):
    now = now or datetime.now(timezone.utc)
    kickoff = instant(g.get('date_utc'))
    flags = (g.get('context') or {}).get('review_flags') or []
    for c in candidates:
        c['odds_observed_at'] = (g.get('odds') or {}).get('observed_at')
        c['odds_source'] = (g.get('odds') or {}).get('source')
        c['context'] = g.get('context') or {}
        if not kickoff or kickoff <= now or g.get('state') == 'in':
            c.update(tier='PASS', filtered='Game has started — pregame price is closed')
        elif not fresh(g.get('odds') or {}, now):
            c.update(tier='PASS', filtered='Price is more than 3 hours old or its observation time is unverified')
        applicable = [f for f in flags if 'QB' in f or c['market'] == 'TOTAL']
        if applicable and c['tier'] != 'PASS':
            c['tier'] = 'LEAN'
            c['stake_multiplier'] = min(c.get('stake_multiplier', 1), .5)
            c['risk_flags'] = list(dict.fromkeys([*(c.get('risk_flags') or []), *applicable]))
            c['warning'] = '; '.join(c['risk_flags'])
    return candidates
