"""
Orchestrator. Run this and the whole board rebuilds.

    python -m pipeline.build            # normal scheduled run (rolling window)
    python -m pipeline.build --full     # full-season backfill, rebuilds the cache
    python -m pipeline.build --no-bet   # price everything, log nothing

Sequence: refresh games -> snapshot odds -> re-solve ratings from results ->
project every upcoming game -> price against the market -> tier -> log qualified
bets -> grade finals -> write the JSON the site reads.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import math
import os
import sys

from . import espn, ledger, model as M, predictions as P, ratings as R, store

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITE_DATA = os.path.join(ROOT, "site", "data")


def load_cfg() -> dict:
    with open(os.path.join(ROOT, "config", "settings.json"), "r", encoding="utf-8") as fh:
        return json.load(fh)


def load_overrides() -> dict:
    p = os.path.join(ROOT, "config", "overrides.json")
    if not os.path.exists(p):
        return {}
    with open(p, "r", encoding="utf-8") as fh:
        return json.load(fh)


# --------------------------------------------------------------------------- #

def merge_games(cache: list[dict], fresh: list[dict]) -> list[dict]:
    """
    Fresh data wins, except never let a blank overwrite something we already had.

    Odds specifically: once a game is final ESPN stops returning a line, so a
    naive merge would erase the closing number we need for grading and CLV.
    """
    # Odds written before parser v2 have no verification marker. Those records
    # may contain the old invented -110 defaults, so they are not allowed to
    # survive a refresh as if they were observed sportsbook prices.
    by_id = {}
    for cached in cache:
        g = dict(cached)
        if "verified_markets" not in (g.get("odds") or {}):
            g["odds"] = {}
        by_id[g["game_id"]] = g
    for fresh_game in fresh:
        g = dict(fresh_game)
        old = by_id.get(g["game_id"])
        if old:
            # ESPN removes closing odds after a game becomes final. Preserve
            # only a close that was previously parsed from complete real prices.
            if (g.get("completed") and not espn.has_priced_market(g.get("odds"))
                    and espn.has_priced_market(old.get("odds"))):
                g["odds"] = old["odds"]
            if g.get("home_score") is None and old.get("home_score") is not None:
                g["home_score"] = old["home_score"]
                g["away_score"] = old["away_score"]
                g["completed"] = old.get("completed", g.get("completed"))
        by_id[g["game_id"]] = g
    return sorted(by_id.values(), key=lambda x: (x.get("date_utc") or "", x["game_id"]))


def is_priceable(g: dict, today: dt.date, lookahead_days: int = 10) -> bool:
    """
    Whether a game belongs on the priced board right now.

    Excludes games already final (nothing left to price), games ESPN has
    marked postponed or canceled (there is no market forming around a game
    that isn't happening as scheduled), and anything more than a day in the
    past (the rolling fetch window can carry a stale unfinished game briefly).
    """
    if g.get("completed") or g.get("postponed") or g.get("canceled"):
        return False
    d = (g.get("date_utc") or "")[:10]
    if not d:
        return False
    lo = (today - dt.timedelta(days=1)).isoformat()
    hi = (today + dt.timedelta(days=max(0, lookahead_days))).isoformat()
    return lo <= d <= hi


def build_schedule(game_rows: list[dict], fbs: set[str] | None = None) -> list[dict]:
    """
    The full season, grouped by week -- what's available, nothing invented.

    The Board only prices games inside the rolling odds window, because that's
    all the model can honestly have an opinion on. This is the other half:
    every game for the whole season, so you can see what's coming even before
    a market exists for it. A game with no posted line shows odds as null --
    never a placeholder, never an estimate. If ESPN hasn't posted a number,
    this doesn't have one either.
    """
    from collections import defaultdict
    by_week: dict[str, list[dict]] = defaultdict(list)
    for g in game_rows:
        wk = g.get("week")
        key = str(wk) if wk is not None else "Unscheduled"
        o = g.get("odds") or {}
        has_odds = espn.has_priced_market(o)
        by_week[key].append({
            "game_id": g["game_id"], "date": g.get("date"),
            "away": g["away"], "home": g["home"],
            "away_name": g.get("away_name"), "home_name": g.get("home_name"),
            "away_score": g.get("away_score"), "home_score": g.get("home_score"),
            "completed": g.get("completed"), "neutral": g.get("neutral"),
            "postponed": g.get("postponed"), "canceled": g.get("canceled"),
            "status": g.get("status"),
            "spread_home": o.get("spread_home") if has_odds else None,
            "total": o.get("total") if has_odds else None,
            "ml_home": o.get("ml_home") if has_odds else None,
            "ml_away": o.get("ml_away") if has_odds else None,
            "book": o.get("book") if has_odds else None,
            "has_odds": has_odds,
            # Non-FBS participants are shown, never hidden -- they are real games
            # on the real schedule. They are flagged because the ratings model has
            # no honest opinion on them: an FCS team never appears often enough in
            # this feed to earn a rating, so it inherits "average FBS team", which
            # is how a 54-point favourite once came out as a coin flip.
            "away_fcs": bool(fbs) and g["away"] not in fbs,
            "home_fcs": bool(fbs) and g["home"] not in fbs,
        })

    def week_sort_key(k: str):
        return (0, int(k)) if k.isdigit() else (1, k)

    out = []
    for wk in sorted(by_week, key=week_sort_key):
        rows = sorted(by_week[wk], key=lambda r: r.get("date") or "")
        for slate_no, slate in enumerate(split_slates(rows), start=1):
            multi = slate_no > 1 or len(split_slates(rows)) > 1
            rng = date_range_label(slate)
            out.append({
                "week": wk,
                "slate": slate_no,
                "label": (f"Week {wk} · {rng}" if wk.isdigit() and multi
                          else f"Week {wk}" if wk.isdigit() else wk),
                "date_range": rng,
                "games": len(slate),
                "with_odds": sum(1 for r in slate if r["has_odds"]),
                "completed": sum(1 for r in slate if r["completed"]),
                "rows": slate,
            })
    return out


def split_slates(rows: list[dict], gap_days: int = 3) -> list[list[dict]]:
    """
    Break one ESPN "week" into the separate weekends it actually contains.

    ESPN's college-football calendar is not a week. The 2026 season opens with
    a Week 1 that runs Aug 22 to Sep 7 and holds two entirely separate
    weekends -- six games on Aug 29, then 137 more on Sep 3-5. Rendered as one
    chip that is a 143-game wall, and the opening slate (what everyone calls
    "Week 0") is invisible inside it.

    Splitting on a gap of three or more days recovers the real slates without
    inventing a week numbering ESPN does not publish. Games stay labelled with
    the week ESPN assigned them; they are just no longer piled into one heap.
    """
    if not rows:
        return []
    groups, cur, prev = [], [rows[0]], _row_date(rows[0])
    for r in rows[1:]:
        d = _row_date(r)
        if prev is not None and d is not None and (d - prev).days >= gap_days:
            groups.append(cur)
            cur = []
        cur.append(r)
        prev = d if d is not None else prev
    groups.append(cur)
    return groups


def _row_date(row: dict) -> dt.date | None:
    s = (row.get("date") or "")[:10]
    try:
        return dt.date.fromisoformat(s)
    except ValueError:
        return None


def date_range_label(rows: list[dict]) -> str:
    """'Aug 29' for a single day, 'Sep 3-5' for a run, spelled out across months."""
    ds = sorted(d for d in (_row_date(r) for r in rows) if d is not None)
    if not ds:
        return ""
    lo, hi = ds[0], ds[-1]
    if lo == hi:
        return lo.strftime("%b %-d")
    if lo.month == hi.month:
        return f"{lo.strftime('%b %-d')}-{hi.strftime('%-d')}"
    return f"{lo.strftime('%b %-d')} - {hi.strftime('%b %-d')}"


def rest_days(games: list[dict]) -> dict[str, int]:
    """
    Days of rest each team brings into its next game.

    Derived from the schedule itself -- one of the workbook columns that used to
    be typed in by hand and now simply isn't, because the calendar already knows.
    """
    last: dict[str, str] = {}
    out: dict[str, int] = {}
    for g in sorted(games, key=lambda x: x.get("date_utc") or ""):
        d = (g.get("date_utc") or "")[:10]
        if not d:
            continue
        for side in ("home", "away"):
            t = g[side]["abbr"]
            prev = last.get(t)
            if prev:
                try:
                    delta = (dt.date.fromisoformat(d) - dt.date.fromisoformat(prev)).days
                    out[f'{g["game_id"]}:{side}'] = min(delta, 21)
                except ValueError:
                    pass
        if g.get("completed"):
            for side in ("home", "away"):
                last[g[side]["abbr"]] = d
    return out


def fbs_teams(games: list[dict]) -> set[str]:
    """
    Which teams this season's schedule treats as full FBS participants.

    ESPN's ``groups=80`` scoreboard filter returns any game involving at least
    one FBS team -- which correctly includes "buy games" against a smaller
    school, so an FCS opponent shows up in the data too. There's no reliable
    classification flag on the team object itself (the site API's own /teams
    endpoint ignores the groups filter and happily returns Division III
    schools), so this infers it from behaviour instead.

    The strongest available signal is how OFTEN a team appears. An FBS program
    plays a dozen games against opponents this feed can see, so it turns up a
    dozen times. An FCS school appears only for the one or two payout games it
    takes, because the rest of its season is invisible at groups=80. Counting
    beats the older "is it ever the home team" rule, which quietly promoted any
    FCS school that happened to host a buy game -- North Dakota State hosting
    an FBS visitor was enough to have it priced as an FBS peer.

    The bar adapts to how much schedule is actually cached: with only a couple
    of weeks pulled, everyone looks infrequent, so it falls back to the older
    host-based rule rather than declaring the entire sport FCS.
    """
    from collections import Counter
    seen: Counter = Counter()
    hosts: set[str] = set()
    for g in games:
        for side in ("home", "away"):
            abbr = (g.get(side) or {}).get("abbr")
            if abbr:
                seen[abbr] += 1
        if (g.get("home") or {}).get("abbr"):
            hosts.add(g["home"]["abbr"])
    if not seen:
        return set()
    counts = sorted(seen.values())
    median = counts[len(counts) // 2]
    if median < 4:
        return hosts          # too little of the season cached to separate them
    bar = max(3, median / 2.0)
    return {t for t, n in seen.items() if n >= bar}


def fcs_guard(cands: list[dict], home_abbr: str, away_abbr: str,
             fbs: set[str], cfg: dict) -> list[dict]:
    """
    Refuse to recommend either side of a game against a non-FBS opponent.

    This is the concrete case the guard exists for: an FCS team getting run off
    the field produces a market spread the model has no real basis to challenge
    -- it has almost no data on that team, and what little it has gets pulled
    toward "average FBS team" by the ratings' own regularisation, which is far
    too generous for a team that isn't FBS at all. The result is a wide,
    confident-looking "edge" that is really just the model's blind spot, not a
    disagreement worth betting into.
    """
    if not cfg["filters"].get("exclude_fcs_opponents"):
        return cands
    if home_abbr in fbs and away_abbr in fbs:
        return cands
    missing = away_abbr if home_abbr in fbs else (home_abbr if away_abbr in fbs else f"{home_abbr}/{away_abbr}")
    for c in cands:
        if c["tier"] != "PASS":
            c["tier"] = "PASS"
        c["filtered"] = f"{missing} isn't a full FBS participant this season — model doesn't rate them reliably"
    return cands


def project(g: dict, rat: dict, hfa: float, score_rat: dict, league: float,
            home_bump: float, rests: dict, ovr: dict, cfg: dict) -> dict:
    """Projected margin (home - away) and projected combined total."""
    h, a = g["home"]["abbr"], g["away"]["abbr"]
    rh, ra = rat.get(h), rat.get(a)
    known = rh is not None and ra is not None
    rh = rh if rh is not None else 0.0
    ra = ra if ra is not None else 0.0

    mu = rh - ra
    if not g.get("neutral"):
        mu += hfa

    rh_rest = rests.get(f'{g["game_id"]}:home')
    ra_rest = rests.get(f'{g["game_id"]}:away')
    if rh_rest is not None and ra_rest is not None:
        mu += (rh_rest - ra_rest) * float(cfg["model"]["rest_day_weight"])

    o = ovr.get(g["game_id"], {})
    mu += float(o.get("margin_adj", 0.0))       # injuries, suspensions, news

    so_h = score_rat.get(h) or {"off": 0.0, "def": 0.0}
    so_a = score_rat.get(a) or {"off": 0.0, "def": 0.0}
    pts_home = league + so_h["off"] - so_a["def"] + (0.0 if g.get("neutral") else home_bump)
    pts_away = league + so_a["off"] - so_h["def"]
    proj_total = pts_home + pts_away + float(o.get("total_adj", 0.0))

    odds = g.get("odds") or {}
    anchored = M.blend_to_market(mu, odds.get("spread_home"), cfg)
    anchored_total = M.blend_total_to_market(proj_total, odds.get("total"), cfg)
    final_mu, final_total = anchored["mu"], anchored_total["total"]
    final_home = (final_total + final_mu) / 2.0
    final_away = (final_total - final_mu) / 2.0

    return {
        **anchored,
        "proj_total": final_total,
        "proj_total_raw": anchored_total["total_raw"],
        "market_total": anchored_total["market_total"],
        "total_gap": anchored_total["gap"],
        "total_gap_raw": anchored_total["gap_raw"],
        "proj_home_pts": round(final_home, 1),
        "proj_away_pts": round(final_away, 1),
        "score_home": int(final_home + 0.5),
        "score_away": int(final_away + 0.5),
        "ratings_known": known,
    }


def fit_projection_scale(projections: list[dict]) -> dict:
    """Fit the raw model to the posted board and isolate game-specific residuals.

    In August the rating solve is intentionally narrow. Without this board-level
    check, that scale mismatch looks like the same opinion on every large
    favourite: take the underdog. Regressing raw projections on market margins
    identifies the systematic component; only the residual is allowed to become
    an actionable disagreement.
    """
    def fit(xs: list[float], ys: list[float]) -> dict:
        if len(xs) < 8 or len(xs) != len(ys):
            return {"enabled": False, "n": len(xs), "intercept": 0.0,
                    "slope": 1.0, "residual_sd": None}
        mx, my = sum(xs)/len(xs), sum(ys)/len(ys)
        vx = sum((x-mx)**2 for x in xs)
        if vx <= 1e-9:
            return {"enabled": False, "n": len(xs), "intercept": 0.0,
                    "slope": 1.0, "residual_sd": None}
        slope = sum((x-mx)*(y-my) for x,y in zip(xs,ys))/vx
        intercept = my - slope*mx
        residuals = [y-(intercept+slope*x) for x,y in zip(xs,ys)]
        rsd = math.sqrt(sum(r*r for r in residuals)/len(residuals))
        return {"enabled": True, "n": len(xs), "intercept": round(intercept, 4),
                "slope": round(slope, 4), "residual_sd": round(rsd, 3)}

    mp = [(float(p["market_mu"]), float(p["mu_raw"])) for p in projections
          if p.get("market_mu") is not None and p.get("mu_raw") is not None]
    tp = [(float(p["market_total"]), float(p["proj_total_raw"])) for p in projections
          if p.get("market_total") is not None and p.get("proj_total_raw") is not None]
    return {"margin": fit([x for x,_ in mp], [y for _,y in mp]),
            "total": fit([x for x,_ in tp], [y for _,y in tp])}


def debias_projection(proj: dict, fit: dict, cfg: dict) -> dict:
    """Replace systematic board-wide scale error with market-centred residuals."""
    out = dict(proj)
    mfit = fit.get("margin") or {}
    if mfit.get("enabled") and proj.get("market_mu") is not None:
        market = float(proj["market_mu"])
        expected = float(mfit["intercept"]) + float(mfit["slope"]) * market
        residual = float(proj["mu_raw"]) - expected
        ceiling = float(cfg["model"].get("max_spread_disagreement", 12.0))
        squeezed = ceiling * math.tanh(residual/ceiling) if ceiling > 0 else residual
        kept = float(cfg["model"].get("projection_blend", 0.5))
        out["mu"] = round(market + kept*squeezed, 2)
        out["gap"] = round(out["mu"]-market, 2)
        out["debias_expected_mu"] = round(expected, 2)
        out["debias_residual"] = round(residual, 2)
        out["debias_enabled"] = True

    tfit = fit.get("total") or {}
    if tfit.get("enabled") and proj.get("market_total") is not None:
        market_total = float(proj["market_total"])
        expected_total = float(tfit["intercept"]) + float(tfit["slope"]) * market_total
        residual_total = float(proj["proj_total_raw"]) - expected_total
        ceiling = float(cfg["model"].get("max_total_disagreement", 14.0))
        squeezed = ceiling * math.tanh(residual_total/ceiling) if ceiling > 0 else residual_total
        kept = float(cfg["model"].get("total_projection_blend", 0.55))
        out["proj_total"] = round(market_total + kept*squeezed, 1)
        out["total_gap"] = round(out["proj_total"]-market_total, 2)
        out["debias_expected_total"] = round(expected_total, 2)
        out["debias_total_residual"] = round(residual_total, 2)

    home = (float(out["proj_total"]) + float(out["mu"]))/2.0
    away = (float(out["proj_total"]) - float(out["mu"]))/2.0
    out["proj_home_pts"], out["proj_away_pts"] = round(home,1), round(away,1)
    out["score_home"], out["score_away"] = int(home+0.5), int(away+0.5)
    return out


def snapshot_confidence(snapshots: int) -> float:
    """
    Scale confidence by how many times this line has been observed.

    Not a guess about the game -- a fact about how much the pipeline has
    actually watched this number. A line seen for the first time this run
    (snapshots <= 1) hasn't had a chance to be corrected by anything; one
    that's been stable across several runs has survived more scrutiny.
    Ranges from 0.75 (brand new) up to 1.0 (seen 4+ times), never amplifying,
    only ever tempering an otherwise-full confidence score.
    """
    return min(1.0, 0.75 + (0.25 / 3.0) * max(0, snapshots - 1))


def price_game(g: dict, proj: dict, cfg: dict, conf: float) -> list[dict]:
    """Every market on one game, priced against the book."""
    o = g.get("odds") or {}
    blend = float(cfg["model"]["market_blend"])
    sd_m = float(cfg["model"]["margin_sd"])
    sd_t = float(cfg["model"]["total_sd"])
    keys = bool(cfg["model"]["use_key_numbers"])
    mu = proj["mu"]
    out: list[dict] = []

    base = {
        "game_id": g["game_id"],
        "game_date": g.get("date_utc"),
        "week": g.get("week"),
        "matchup": f'{g["away"]["abbr"]} @ {g["home"]["abbr"]}',
        "book": o.get("book"),
        "confidence": conf,
    }

    # ---- Moneyline -------------------------------------------------------- #
    if cfg["markets"]["moneyline"] and o.get("ml_home") is not None and o.get("ml_away") is not None:
        raw = M.moneyline_probability(mu, sd_m, keys)
        be_h = M.american_to_prob(float(o["ml_home"]))
        be_a = M.american_to_prob(float(o["ml_away"]))
        fair_h, fair_a = M.devig(be_h, be_a)
        p_h = (1 - blend) * raw + blend * fair_h
        for side, p, be, fair, price, label in (
            ("home", p_h, be_h, fair_h, float(o["ml_home"]), f'{g["home"]["abbr"]} ML'),
            ("away", 1 - p_h, be_a, fair_a, float(o["ml_away"]), f'{g["away"]["abbr"]} ML'),
        ):
            out.append({**base, "market": "ML", "side": side, "pick": label, "line": None,
                        "price": price, "model_prob": p, "raw_model_prob": raw if side == "home" else 1 - raw,
                        "market_fair_prob": fair, "breakeven": be, "push_prob": 0.0,
                        "edge": p - be, "ev": M.expected_value(p, price)})

    # ---- Spread ----------------------------------------------------------- #
    if (cfg["markets"]["spread"] and o.get("spread_home") is not None
            and o.get("spread_price_home") is not None and o.get("spread_price_away") is not None):
        sp = float(o["spread_home"])
        pw, pp, pl = M.cover_probability(mu, sd_m, sp, keys)
        # Re-normalise onto the non-push space, which is what the price pays on.
        denom = pw + pl
        raw_h = pw / denom if denom else 0.5
        ph_price = float(o["spread_price_home"])
        pa_price = float(o["spread_price_away"])
        be_h, be_a = M.american_to_prob(ph_price), M.american_to_prob(pa_price)
        fair_h, fair_a = M.devig(be_h, be_a)
        p_h = (1 - blend) * raw_h + blend * fair_h
        fmt = lambda x: f"{x:+g}"
        for side, p, be, fair, price, label in (
            ("home", p_h, be_h, fair_h, ph_price, f'{g["home"]["abbr"]} {fmt(sp)}'),
            ("away", 1 - p_h, be_a, fair_a, pa_price, f'{g["away"]["abbr"]} {fmt(-sp)}'),
        ):
            out.append({**base, "market": "ATS", "side": side, "pick": label, "line": sp,
                        "price": price, "model_prob": p,
                        "raw_model_prob": raw_h if side == "home" else 1 - raw_h,
                        "market_fair_prob": fair, "breakeven": be, "push_prob": round(pp, 4),
                        "projection_gap": abs(mu + sp),
                        "edge": p - be, "ev": M.expected_value(p * (1 - pp), price, pp)})

    # ---- Total ------------------------------------------------------------ #
    if (cfg["markets"]["total"] and o.get("total") is not None
            and o.get("over_price") is not None and o.get("under_price") is not None):
        tot = float(o["total"])
        po, pp, pu = M.over_probability(proj["proj_total"], tot, sd_t)
        denom = po + pu
        raw_o = po / denom if denom else 0.5
        op = float(o["over_price"])
        up = float(o["under_price"])
        be_o, be_u = M.american_to_prob(op), M.american_to_prob(up)
        fair_o, fair_u = M.devig(be_o, be_u)
        p_o = (1 - blend) * raw_o + blend * fair_o
        for side, p, be, fair, price, label in (
            ("over", p_o, be_o, fair_o, op, f"Over {tot:g}"),
            ("under", 1 - p_o, be_u, fair_u, up, f"Under {tot:g}"),
        ):
            out.append({**base, "market": "TOTAL", "side": side, "pick": label, "line": tot,
                        "price": price, "model_prob": p,
                        "raw_model_prob": raw_o if side == "over" else 1 - raw_o,
                        "market_fair_prob": fair, "breakeven": be, "push_prob": round(pp, 4),
                        "projection_gap": abs(proj["proj_total"] - tot),
                        "edge": p - be, "ev": M.expected_value(p * (1 - pp), price, pp)})

    for c in out:
        c["odds_verified"] = True
        c["raw_market_gap"] = abs(c["raw_model_prob"] - c["market_fair_prob"])
        c["edge_raw"] = c["edge"]
        c["edge"] = M.compress_edge(c["edge_raw"], cfg)
        c["action_edge"] = M.risk_adjusted_edge(c["edge"], cfg, conf)
        c["tier"] = M.tier_for(c["edge"], cfg, conf)
    return out


def raw_gap_ceiling(cfg: dict, conf: float, thin: bool) -> float | None:
    """
    The raw model/market disagreement ceiling actually applied to a candidate.

    The configured ceiling is a floor-price on caution, not the last word. Edge
    rises monotonically with the raw gap, so a confidence-scaled tier threshold
    is itself a *minimum* raw gap in disguise. If the configured ceiling lands
    below that minimum, the two guards overlap to zero and nothing can qualify
    at any price -- the board goes quiet and looks exactly like a model with no
    opinion, which is the most dangerous failure mode a betting tool has.

    So the ceiling is widened, when it must be, to sit `guard_headroom` above
    whatever a LEAN currently requires. That keeps the guard doing its real job
    -- rejecting the absurd, like a rating model that has never seen an FCS team
    calling a 54-point favourite a coin flip -- without letting it silently
    gag the model it is meant to be protecting.
    """
    f = cfg["filters"]
    ceiling = f.get("max_raw_market_prob_gap")
    if thin and f.get("max_thin_data_raw_market_prob_gap") is not None:
        t = float(f["max_thin_data_raw_market_prob_gap"])
        ceiling = min(float(ceiling), t) if ceiling is not None else t
    if ceiling is None:
        return None
    headroom = float(f.get("guard_headroom", 1.0))
    if headroom > 1.0:
        needed = M.raw_gap_for_edge(M.edge_floor(cfg, conf, "lean"), cfg) * headroom
        ceiling = max(float(ceiling), needed)
    return float(ceiling)


def spread_gap_ceiling(cfg: dict, conf: float, thin: bool, market: str) -> float | None:
    """
    The projection-gap ceiling actually applied, in points.

    Same reasoning as raw_gap_ceiling(), in the other unit. A points ceiling and
    a probability threshold are the same constraint wearing different clothes,
    so this one gets the same headroom guarantee -- otherwise a 7-point rail
    quietly sits under a floor that needs 7.1 and the board never fills.
    """
    f = cfg["filters"]
    ceiling = (f.get("max_spread_projection_gap") if market == "ATS"
               else f.get("max_total_projection_gap") if market == "TOTAL" else None)
    if thin and market == "ATS" and f.get("max_thin_data_spread_gap") is not None:
        t = float(f["max_thin_data_spread_gap"])
        ceiling = min(float(ceiling), t) if ceiling is not None else t
    if ceiling is None:
        return None
    headroom = float(f.get("guard_headroom", 1.0))
    if headroom > 1.0 and market == "ATS":
        needed = M.spread_gap_for_edge(M.edge_floor(cfg, conf, "lean"), cfg) * headroom
        if needed != float("inf"):
            ceiling = max(float(ceiling), needed)
    return float(ceiling)


def apply_filters(cands: list[dict], cfg: dict, feed_healthy: bool = True) -> list[dict]:
    """Apply hard stops first, then soft risk controls.

    A soft warning is allowed to become a LEAN with a reduced stake.  A hard
    stop remains an AVOID/PASS.  This replaces the old all-or-nothing treatment
    that made a small move across one limit erase an otherwise useful row.
    """
    f = cfg["filters"]
    ok = []
    for c in cands:
        c.setdefault("risk_flags", [])
        c.setdefault("stake_multiplier", 1.0)
        if not feed_healthy:
            c["tier"] = "PASS"
            c["filtered"] = "odds feed integrity warning"
        thin = c.get("confidence", 0.0) < float(f.get("thin_data_confidence_threshold", 0.5))
        gap_limit = spread_gap_ceiling(cfg, c.get("confidence", 0.0), thin, c["market"])
        if gap_limit is not None and c.get("projection_gap", 0.0) > float(gap_limit):
            c["tier"] = "PASS"
            c["filtered"] = "model/market gap exceeds the hard safety range"
        prob_limit = raw_gap_ceiling(cfg, c.get("confidence", 0.0), thin)
        if prob_limit is not None and c.get("raw_market_gap", 0.0) > float(prob_limit):
            c["tier"] = "PASS"
            c["filtered"] = "raw model/market gap exceeds the hard safety range"
        if not (float(f["min_price"]) <= c["price"] <= float(f["max_price"])):
            c["tier"] = "PASS"
            c["filtered"] = "price outside the hard safety range"
        if c["ev"] <= 0 and c["tier"] != "PASS":
            c["tier"] = "PASS"
            c["filtered"] = "negative expected value"

        # Soft controls preserve the information and the possible bet, but cap
        # the label at LEAN and reduce Kelly exposure.  They never reopen a row
        # that failed a hard stop above.
        if c["tier"] != "PASS":
            soft_gap = None
            if c["market"] == "ATS":
                soft_gap = f.get("soft_thin_data_spread_gap" if thin
                                 else "soft_spread_projection_gap")
            elif c["market"] == "TOTAL":
                soft_gap = f.get("soft_thin_data_total_gap" if thin
                                 else "soft_total_projection_gap")
            soft_raw = f.get("soft_thin_data_raw_market_prob_gap" if thin
                             else "soft_raw_market_prob_gap")
            preferred_min = float(f.get("preferred_min_price", f["min_price"]))
            preferred_max = float(f.get("preferred_max_price", f["max_price"]))

            if soft_gap is not None and c.get("projection_gap", 0.0) > float(soft_gap):
                c["risk_flags"].append("Large model/market gap — LEAN only")
                c["stake_multiplier"] = min(c["stake_multiplier"], 0.60)
            if soft_raw is not None and c.get("raw_market_gap", 0.0) > float(soft_raw):
                c["risk_flags"].append("Raw probability gap needs confirmation")
                c["stake_multiplier"] = min(c["stake_multiplier"], 0.60)
            if not (preferred_min <= c["price"] <= preferred_max):
                c["risk_flags"].append("High-variance price — LEAN only")
                c["stake_multiplier"] = min(c["stake_multiplier"], 0.50)

            if c["risk_flags"] and M.TIER_RANK[c["tier"]] < M.TIER_RANK["LEAN"]:
                c["tier"] = "LEAN"
            if c["risk_flags"]:
                c["warning"] = " · ".join(c["risk_flags"])
        ok.append(c)
    return ok


def diagnose_board(board: list[dict], cfg: dict) -> dict:
    """
    Why the board looks the way it does -- especially when it is empty.

    An empty Best Bets tab is ambiguous in the worst possible way. It can mean
    the model looked and honestly disagreed with nothing, which is the normal
    and correct state most weeks. It can also mean the model was structurally
    prevented from having an opinion, which is a bug. Those two look identical
    from the outside, so this records which one actually happened: the live
    thresholds, the rails in force, what each rejection was for, and how close
    the nearest miss came.
    """
    qualified = [c for c in board if c["tier"] != "PASS"]
    reasons: dict[str, int] = {}
    for c in board:
        if c["tier"] != "PASS":
            continue
        why = c.get("filtered") or "edge below the tier threshold"
        reasons[why] = reasons.get(why, 0) + 1

    # Feasibility is only a meaningful claim when something was actually priced.
    # An empty board has no confidence to read, and defaulting it to zero makes
    # every quiet week look like a configuration fault -- a false alarm is worse
    # than no alarm, because it trains you to ignore the real one.
    confs = [c.get("confidence", 0.0) for c in board if c.get("confidence") is not None]
    conf = max(confs) if confs else M.confidence_score(0, 0, True, cfg)
    thin = conf < float(cfg["filters"].get("thin_data_confidence_threshold", 0.5))
    window = M.threshold_window(cfg, conf, thin,
                                raw_ceiling=raw_gap_ceiling(cfg, conf, thin),
                                spread_ceiling=spread_gap_ceiling(cfg, conf, thin, "ATS"))
    window["evaluated_on_priced_lines"] = bool(board)

    near = sorted((c for c in board if c["tier"] == "PASS" and not c.get("filtered")),
                  key=lambda c: -c["edge"])[:5]
    if qualified:
        headline = f"{len(qualified)} play(s) cleared the bar"
    elif not board:
        headline = "no games with a posted, two-sided price in the current window"
    elif not window["feasible"]:
        headline = ("the tier threshold and the safety rails leave no window -- "
                    "nothing could qualify at any price")
    else:
        headline = "the model did not disagree with the market by enough to bet"
    return {
        "priced_lines": len(board),
        "qualified": len(qualified),
        "headline": headline,
        "reasons": reasons,
        "window": window,
        "near_misses": [{
            "matc