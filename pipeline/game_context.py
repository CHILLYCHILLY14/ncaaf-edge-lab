"""Dated public game context. No inferred absences or uncalibrated point shifts."""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone, timedelta
import requests

from . import espn
from .model_accuracy import instant, number

STATES = dict(x.split(':') for x in (
    'AL:Alabama|AK:Alaska|AZ:Arizona|AR:Arkansas|CA:California|CO:Colorado|CT:Connecticut|'
    'DE:Delaware|FL:Florida|GA:Georgia|HI:Hawaii|ID:Idaho|IL:Illinois|IN:Indiana|IA:Iowa|'
    'KS:Kansas|KY:Kentucky|LA:Louisiana|ME:Maine|MD:Maryland|MA:Massachusetts|MI:Michigan|'
    'MN:Minnesota|MS:Mississippi|MO:Missouri|MT:Montana|NE:Nebraska|NV:Nevada|NH:New Hampshire|'
    'NJ:New Jersey|NM:New Mexico|NY:New York|NC:North Carolina|ND:North Dakota|OH:Ohio|'
    'OK:Oklahoma|OR:Oregon|PA:Pennsylvania|RI:Rhode Island|SC:South Carolina|SD:South Dakota|'
    'TN:Tennessee|TX:Texas|UT:Utah|VT:Vermont|VA:Virginia|WA:Washington|WV:West Virginia|'
    'WI:Wisconsin|WY:Wyoming|DC:District of Columbia').split('|'))


def get_json(url, params=None):
    response = requests.get(url, params=params, headers=espn._HEADERS, timeout=18)
    response.raise_for_status()
    return response.json()


def age_hours(stamp, now):
    t = instant(stamp)
    return (now-t).total_seconds()/3600 if t else float('inf')


def parse_availability(payload, season, now, max_hours=72):
    """Feed timestamp is NOT a player report date. Empty is never 'healthy'."""
    out, rejected = {}, 0
    if str((payload.get('season') or {}).get('year')) != str(season):
        return {}, {'status': 'unavailable', 'rejected_reports': 0}
    for team in payload.get('injuries') or []:
        current = []
        for row in team.get('injuries') or []:
            age = age_hours(row.get('date'), now)
            if not 0 <= age <= max_hours:
                rejected += 1
                continue
            athlete = row.get('athlete') or {}
            if not athlete.get('id') or not athlete.get('displayName') or not row.get('status'):
                rejected += 1
                continue
            current.append({'athlete_id': str(athlete['id']), 'name': athlete['displayName'],
                            'position': (athlete.get('position') or {}).get('abbreviation'),
                            'status': row['status'], 'reported_at': row['date'],
                            'detail': row.get('shortComment') or '',
                            'source': 'ESPN', 'source_url': 'https://www.espn.com/college-football/injuries'})
        if current:
            out[str(team.get('id'))] = current
    return out, {'status': 'partial' if out else 'unavailable',
                 'rejected_reports': rejected, 'current_reports': sum(map(len, out.values())),
                 'checked_at': now.isoformat(), 'max_report_age_hours': max_hours}


def parse_conferences(payload):
    out = {}
    def walk(node, conference=None):
        if node.get('isConference'):
            conference = node.get('shortName') or node.get('name')
        for entry in (node.get('standings') or {}).get('entries') or []:
            team = entry.get('team') or {}
            if team.get('id') and conference:
                out[str(team['id'])] = conference
        for child in node.get('children') or []:
            walk(child, conference)
    walk(payload)
    return out


def match_city(payload, city, state, country):
    """Require the exact state and country; never take the first Springfield."""
    if country not in ('USA', 'US') or state not in STATES:
        return None
    candidates = [r for r in payload.get('results') or []
                  if r.get('country_code') == 'US' and r.get('admin1') == STATES[state]
                  and str(r.get('name', '')).casefold() == city.casefold()
                  and number(r.get('latitude')) is not None and number(r.get('longitude')) is not None]
    if len(candidates) != 1:
        return None
    r = candidates[0]
    return {'latitude': r['latitude'], 'longitude': r['longitude'],
            'location': f'{city}, {state}', 'precision': 'venue city'}


def kickoff_weather(block, kickoff):
    hourly = block.get('hourly') or {}
    ko = instant(kickoff)
    if not ko:
        return None
    valid = [(abs((t-ko).total_seconds()), i, t) for i, value in enumerate(hourly.get('time') or [])
             if (t := instant(value + 'Z' if not value.endswith('Z') else value))]
    if not valid:
        return None
    gap, index, time = min(valid)
    if gap > 3600:
        return None
    units = block.get('hourly_units') or {}
    # Explicit units prevent a provider schema change turning km/h into mph.
    if units.get('wind_speed_10m') != 'mp/h' or units.get('temperature_2m') != '°C':
        return None
    def value(key):
        arr = hourly.get(key) or []
        return number(arr[index]) if index < len(arr) else None
    fc = {'forecast_for': time.isoformat(), 'temp_c': value('temperature_2m'),
          'wind_mph': value('wind_speed_10m'), 'gust_mph': value('wind_gusts_10m'),
          'rain_probability': value('precipitation_probability'), 'precip_mm': value('precipitation')}
    return fc if fc['wind_mph'] is not None and fc['temp_c'] is not None else None


def enrich(games, cfg, cache, now=None):
    now = now or datetime.now(timezone.utc)
    season = int(cfg['season'])
    current = [g for g in games if not g.get('completed') and not g.get('canceled')
               and (ko := instant(g.get('date_utc'))) and now < ko < now+timedelta(days=10)]
    try:
        injury_payload = get_json(f'{espn.SITE}/injuries')
        injuries, injury_health = parse_availability(injury_payload, season, now)
    except (requests.RequestException, ValueError):
        injuries, injury_health = {}, {'status': 'unavailable', 'checked_at': now.isoformat()}
    if str(cache.get('season')) != str(season):
        cache.clear()
        cache['season'] = season
    if age_hours(cache.get('conferences_checked_at'), now) > 24:
        try:
            conferences = parse_conferences(get_json(
                'https://site.web.api.espn.com/apis/v2/sports/football/college-football/standings',
                {'season': season, 'type': 0, 'level': 2}))
            if conferences:
                cache.update(conferences=conferences, conferences_checked_at=now.isoformat())
        except (requests.RequestException, ValueError):
            pass
    for g in games:
        for side in ('home', 'away'):
            g[side]['conference'] = (cache.get('conferences') or {}).get(str(g[side].get('id')))

    geo = cache.setdefault('geo', {})
    locations = {(g.get('venue_city'), g.get('venue_state'), g.get('venue_country', 'USA'))
                 for g in current if not g.get('indoor') and g.get('venue_city')}
    def locate(loc):
        key = '|'.join(x or '' for x in loc)
        prior = geo.get(key) or {}
        if prior.get('point') or age_hours(prior.get('checked_at'), now) < 24:
            return key, prior
        try:
            point = match_city(get_json('https://geocoding-api.open-meteo.com/v1/search',
                               {'name': loc[0], 'count': 100, 'language': 'en', 'countryCode': 'US'}), *loc)
        except (requests.RequestException, ValueError):
            point = None
        return key, {'point': point, 'checked_at': now.isoformat()}
    with ThreadPoolExecutor(max_workers=4) as pool:
        geo.update(pool.map(locate, locations))
    forecasts = cache.setdefault('weather', {})
    points = {key: item['point'] for key, item in geo.items() if item.get('point')
              and key in {'|'.join(x or '' for x in loc) for loc in locations}}
    pending = [(key, point) for key, point in points.items()
               if age_hours((forecasts.get(key) or {}).get('checked_at'), now) >= 2]
    for offset in range(0, len(pending), 20):
        batch = pending[offset:offset+20]
        try:
            payload = get_json('https://api.open-meteo.com/v1/forecast', {
                'latitude': ','.join(str(p['latitude']) for _, p in batch),
                'longitude': ','.join(str(p['longitude']) for _, p in batch),
                'hourly': 'temperature_2m,wind_speed_10m,wind_gusts_10m,precipitation_probability,precipitation',
                'wind_speed_unit': 'mph', 'temperature_unit': 'celsius', 'timezone': 'UTC', 'forecast_days': 11})
            blocks = payload if isinstance(payload, list) else [payload]
            if len(blocks) == len(batch):
                for (key, _), block in zip(batch, blocks):
                    if block.get('hourly'):
                        forecasts[key] = {'checked_at': now.isoformat(), 'data': block}
        except (requests.RequestException, ValueError):
            pass
    for g in current:
        reports = {side: injuries.get(str(g[side].get('id')), []) for side in ('home', 'away')}
        availability = {'status': 'partial' if any(reports.values()) else 'unavailable',
                        'checked_at': injury_health.get('checked_at'), 'reports': reports,
                        'note': 'Only dated reports from the last 72 hours. No report does not confirm availability.'}
        key = '|'.join(g.get(k) or '' for k in ('venue_city', 'venue_state', 'venue_country'))
        point, saved = points.get(key), forecasts.get(key) or {}
        fresh = 0 <= age_hours(saved.get('checked_at'), now) <= 3
        fc = kickoff_weather(saved.get('data') or {}, g.get('date_utc')) if fresh else None
        weather = {'status': 'indoor' if g.get('indoor') else 'available' if fc else 'unavailable',
                   'forecast': fc, 'checked_at': saved.get('checked_at'),
                   'location': (point or {}).get('location'), 'precision': 'venue city',
                   'source': 'Open-Meteo', 'source_url': 'https://open-meteo.com/',
                   'note': 'Forecast near kickoff; no uncalibrated scoring adjustment.'}
        flags = []
        if not g.get('indoor') and fc and (fc['wind_mph'] >= 20 or (fc.get('gust_mph') or 0) >= 30):
            flags.append('Strong wind forecast — total needs review')
        if any(r.get('position') == 'QB' for rs in reports.values() for r in rs):
            flags.append('Recent QB report — starter availability needs review')
        g['context'] = {'availability': availability, 'weather': weather, 'review_flags': flags}
    return {'availability': injury_health,
            'weather_available': sum((g.get('context', {}).get('weather') or {}).get('status') == 'available' for g in current),
            'games_checked': len(current), 'conferences': len(cache.get('conferences') or {}),
            'scoring_adjustments': False}
