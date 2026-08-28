"""
Self-updating team power ratings.

This is the piece the spreadsheet could never do. The workbook shipped with
hand-typed "sample" ratings and a note telling you to replace them every week
from SP+ or FPI -- which is exactly the manual step that makes a model rot. Here
the ratings are *solved from results*, so they update themselves every time a
game goes final.

Method: ridge-regularised least squares on margin of victory.

    margin(home - away)  ~=  r_home - r_away + hfa * (0 if neutral else 1)

Solved jointly across every game in the sample, so a team's rating is its
strength net of who it played -- strength of schedule is handled structurally
rather than bolted on as a fudge factor. Three details do most of the work:

  * Ridge penalty (lambda). Without it, an undefeated team that played nobody
    gets an absurd rating and the system is near-singular in week 1. The penalty
    pulls every rating toward zero in proportion to how little evidence supports
    it, which is the correct Bayesian behaviour, not a hack.
  * MOV cap. A 63-0 win is not nine times more informative than a 7-0 win.
    Capping margin keeps blowouts from dominating the fit.
  * Recency half-life. September tells you less about November than October does.

Totals get their own solve: points scored is modelled as league average plus the
scoring team's offence minus the conceding team's defence, which projects each
side of a matchup individually instead of averaging two season scoring rates.
"""

from __future__ import annotations

import datetime as dt
from collections import defaultdict

import numpy as np


def _ridge_solve(rows: list[tuple[dict[int, float], float, float]],
                 n_params: int, lam: float,
                 unpenalised: tuple[int, ...] = (),
                 prior_mean: dict[int, float] | None = None) -> np.ndarray:
    """
    Solve (X'WX + lam*I) b = X'Wy without ever materialising a dense X.

    rows: (sparse column->coef map, target y, weight w)

    `unpenalised` names columns that must NOT be shrunk toward zero. Home-field
    advantage is one: it is a real league-wide effect estimated off thousands of
    games, and penalising it just biases it downward for no benefit.
    """
    A = np.zeros((n_params, n_params), dtype=float)
    b = np.zeros(n_params, dtype=float)
    for coefs, y, w in rows:
        items = list(coefs.items())
        for i, ci in items:
            b[i] += w * ci * y
            for j, cj in items:
                A[i, j] += w * ci * cj
    pen = np.full(n_params, lam, dtype=float)
    for c in unpenalised:
        pen[c] = 0.0
    A += np.diag(pen)
    # Ordinary ridge is a Gaussian prior centred on zero.  When a genuine
    # preseason prior is available (our own prior-season solve blended with
    # ESPN FPI), centre that same stabilising penalty on the prior instead.
    # This prevents the first current-season result from collapsing every team
    # back toward average simply because the schedule is still sparse.
    for col, value in (prior_mean or {}).items():
        if 0 <= col < n_params and col not in unpenalised:
            b[col] += pen[col] * float(value)
    try:
        return np.linalg.solve(A, b)
    except np.linalg.LinAlgError:
        return np.linalg.lstsq(A, b, rcond=None)[0]


def _weights(games: list[dict], halflife_games: float) -> list[float]:
    """
    Exponential recency decay measured in *calendar days*, not list position.

    Measuring decay by position in the list is a trap: the list holds every game
    in the league, so with ~60 games a week a half-life of "9 games" silently
    became a half-life of a few days and threw away most of the season. Days are
    what actually matter, and a team plays about once a week, so a half-life of
    N team-games is N*7 days.
    """
    if not games or halflife_games <= 0:
        return [1.0] * len(games)
    days: list[float] = []
    for g in games:
        d = (g.get("date_utc") or "")[:10]
        try:
            days.append(dt.date.fromisoformat(d).toordinal())
        except ValueError:
            days.append(0.0)
    latest = max(days) if days else 0.0
    hl = halflife_games * 7.0
    return [0.5 ** ((latest - d) / hl) if d else 0.25 for d in days]


def solve_margin_ratings(games: list[dict], cfg: dict,
                         prior: dict[str, float] | None = None) -> tuple[dict[str, float], float]:
    """
    Returns ({team_abbr: rating_in_points}, solved_home_field_advantage).

    A rating is "points better than an average team in this sample on a neutral
    field". The difference between two ratings is a projected margin.
    """
    r = cfg["ratings"]
    lam = float(r["ridge_lambda"])
    cap = float(r["mov_cap"])
    halflife = float(r["recency_halflife_games"])

    played = [g for g in games
              if g.get("completed") and g.get("home_score") is not None
              and g.get("away_score") is not None
              and g["home"]["abbr"] and g["away"]["abbr"]]
    if not played:
        return (dict(prior or {}), float(cfg["model"]["home_field_fallback"]))

    teams = sorted(
        {g["home"]["abbr"] for g in played}
        | {g["away"]["abbr"] for g in played}
        | set((prior or {}).keys())
    )
    idx = {t: i for i, t in enumerate(teams)}
    hfa_col = len(teams)
    n_params = len(teams) + 1

    ws = _weights(played, halflife)
    rows: list[tuple[dict[int, float], float, float]] = []
    for g, w in zip(played, ws):
        margin = g["home_score"] - g["away_score"]
        margin = max(-cap, min(cap, margin))
        coefs = {idx[g["home"]["abbr"]]: 1.0, idx[g["away"]["abbr"]]: -1.0}
        if not g.get("neutral"):
            coefs[hfa_col] = 1.0
        rows.append((coefs, float(margin), float(w)))

    prior_mean = ({idx[t]: float(p) for t, p in (prior or {}).items() if t in idx}
                  if prior else None)
    current_lam = float(r.get("current_season_prior_strength", lam)) if prior else lam
    beta = _ridge_solve(rows, n_params, current_lam,
                        unpenalised=(hfa_col,), prior_mean=prior_mean)
    # Shrink the solved home-field number toward the configured fallback in
    # proportion to how many non-neutral games it was estimated from. In week 1
    # a raw solve can land anywhere; by November it should stand on its own.
    hfa = float(beta[hfa_col])
    n_home_games = sum(1 for g in played if not g.get("neutral"))
    k = 150.0
    hfa = (n_home_games * hfa + k * float(cfg["model"]["home_field_fallback"])) / (n_home_games + k)
    hfa = min(max(hfa, 0.5), 5.0)

    ratings = {t: float(beta[idx[t]]) for t in teams}
    mean = sum(ratings.values()) / len(ratings)
    return ({t: v - mean for t, v in ratings.items()}, hfa)


def solve_scoring_ratings(games: list[dict], cfg: dict,
                          prior: dict[str, dict] | None = None,
                          prior_league: float | None = None,
                          prior_home_bump: float | None = None
                          ) -> tuple[dict[str, dict], float, float]:
    """
    Offence / defence ratings for the totals model.

        points_for(t vs o)  ~=  league_avg + off[t] - def[o] + home_bump*(home?)

    Returns ({team: {"off": x, "def": y}}, league_avg_points, home_scoring_bump).
    """
    r = cfg["ratings"]
    lam = float(r["ridge_lambda"])
    halflife = float(r["recency_halflife_games"])

    played = [g for g in games
              if g.get("completed") and g.get("home_score") is not None
              and g.get("away_score") is not None
              and g["home"]["abbr"] and g["away"]["abbr"]]
    if not played:
        return (dict(prior or {}), float(prior_league or 27.5),
                float(prior_home_bump or 1.2))

    pts = [g["home_score"] for g in played] + [g["away_score"] for g in played]
    observed_league = float(np.mean(pts))
    if prior_league is None:
        league = observed_league
    else:
        # One Saturday should not redefine the scoring environment.  Forty
        # prior games is enough ballast to make the transition smooth while
        # allowing the current season to take over quickly.
        k = float(r.get("scoring_prior_games", 40.0))
        league = (len(played) * observed_league + k * float(prior_league)) / (len(played) + k)

    teams = sorted(
        {g["home"]["abbr"] for g in played}
        | {g["away"]["abbr"] for g in played}
        | set((prior or {}).keys())
    )
    off = {t: i for i, t in enumerate(teams)}
    dfn = {t: i + len(teams) for i, t in enumerate(teams)}
    home_col = 2 * len(teams)
    n_params = home_col + 1

    ws = _weights(played, halflife)
    rows: list[tuple[dict[int, float], float, float]] = []
    for g, w in zip(played, ws):
        h, a = g["home"]["abbr"], g["away"]["abbr"]
        rows.append(({off[h]: 1.0, dfn[a]: -1.0, home_col: 1.0},
                     float(g["home_score"]) - league, float(w)))
        rows.append(({off[a]: 1.0, dfn[h]: -1.0},
                     float(g["away_score"]) - league, float(w)))

    prior_mean = None
    if prior:
        prior_mean = {}
        for team, values in prior.items():
            if team in off:
                prior_mean[off[team]] = float(values.get("off") or 0.0)
                prior_mean[dfn[team]] = float(values.get("def") or 0.0)
    current_lam = float(r.get("current_season_prior_strength", lam)) if prior else lam
    beta = _ridge_solve(rows, n_params, current_lam,
                        unpenalised=(home_col,), prior_mean=prior_mean)
    bump = float(beta[home_col])
    if not (-3.0 <= bump <= 6.0):
        bump = float(prior_home_bump or 1.2)
    elif prior_home_bump is not None:
        k = float(r.get("home_scoring_prior_games", 120.0))
        bump = (len(played) * bump + k * float(prior_home_bump)) / (len(played) + k)

    out = {}
    for t in teams:
        out[t] = {"off": float(beta[off[t]]), "def": float(beta[dfn[t]])}
    return out, league, bump


def regress_to_prior(last_season: dict[str, float], factor: float) -> dict[str, float]:
    """Carry last year's solved ratings into this year's preseason prior."""
    return {t: v * factor for t, v in last_season.items()}


def _centred(values: dict[str, float]) -> dict[str, float]:
    if not values:
        return {}
    mean = sum(values.values()) / len(values)
    return {team: float(value) - mean for team, value in values.items()}


def blend_preseason_ratings(internal: dict[str, float], fpi: dict[str, dict],
                            fpi_weight: float) -> tuple[dict[str, float], dict[str, dict]]:
    """Blend independent 2026 FPI with the model's regressed 2025 solve.

    FPI is already expressed in neutral-field points, the same units as this
    rating model.  It supplies the roster/recruiting/coaching information our
    score-only ridge solve cannot know in August; the internal component keeps
    the result from becoming an ESPN copy.
    """
    weight = min(1.0, max(0.0, float(fpi_weight)))
    internal_c = _centred({t: float(v) for t, v in internal.items()})
    fpi_raw = {t: float(row["fpi"]) for t, row in fpi.items()
               if row.get("fpi") is not None}
    fpi_c = _centred(fpi_raw)
    teams = sorted(set(internal_c) | set(fpi_c))
    out: dict[str, float] = {}
    audit: dict[str, dict] = {}
    for team in teams:
        own = internal_c.get(team)
        espn = fpi_c.get(team)
        if own is None:
            value, source = espn, "ESPN FPI"
        elif espn is None:
            value, source = own, "internal prior"
        else:
            value = (1.0 - weight) * own + weight * espn
            source = "FPI + internal"
        if value is None:
            continue
        out[team] = float(value)
        audit[team] = {
            "internal_prior": own,
            "fpi": fpi_raw.get(team),
            "fpi_centered": espn,
            "fpi_rank": (fpi.get(team) or {}).get("fpi_rank"),
            "source": source,
        }
    return _centred(out), audit


def blend_scoring_priors(internal: dict[str, dict], fpi: dict[str, dict],
                         fpi_weight: float) -> dict[str, dict]:
    """Use FPI's offensive/defensive/ST components in preseason totals.

    Half of special-teams value is assigned to each scoring side so the two
    components still sum to the headline team-strength contribution.
    """
    weight = min(1.0, max(0.0, float(fpi_weight)))
    own_off = _centred({t: float(v.get("off") or 0.0) for t, v in internal.items()})
    own_def = _centred({t: float(v.get("def") or 0.0) for t, v in internal.items()})
    fpi_off, fpi_def = {}, {}
    for team, row in fpi.items():
        off, dfn = row.get("offense"), row.get("defense")
        if off is None or dfn is None:
            continue
        st = float(row.get("special_teams") or 0.0)
        fpi_off[team] = float(off) + st / 2.0
        fpi_def[team] = float(dfn) + st / 2.0
    fpi_off, fpi_def = _centred(fpi_off), _centred(fpi_def)

    out = {}
    for team in sorted(set(own_off) | set(fpi_off)):
        if team in own_off and team in fpi_off:
            off = (1.0 - weight) * own_off[team] + weight * fpi_off[team]
            dfn = (1.0 - weight) * own_def[team] + weight * fpi_def[team]
        elif team in fpi_off:
            off, dfn = fpi_off[team], fpi_def[team]
        else:
            off, dfn = own_off[team], own_def[team]
        out[team] = {"off": float(off), "def": float(dfn)}
    return out


def games_played(games: list[dict]) -> dict[str, int]:
    n: dict[str, int] = defaultdict(int)
    for g in games:
        if g.get("completed"):
            n[g["home"]["abbr"]] += 1
            n[g["away"]["abbr"]] += 1
    return dict(n)


def ats_form(games: list[dict], lookback: int = 5) -> dict[str, dict]:
    """
    Recent against-the-spread form, straight from graded results.

    Kept as a *reporting* number rather than a model input on purpose: ATS record
    is one of the most seductive and least predictive stats in sports betting.
    The margin solve already knows a team is playing well -- adding ATS form on
    top double-counts the same information and, worse, it's the market's own
    residual, so chasing it is chasing noise. It's displayed because it's useful
    context for a human, not because the model leans on it.
    """
    hist: dict[str, list[dict]] = defaultdict(list)
    for g in sorted(games, key=lambda x: x.get("date_utc") or ""):
        if not g.get("completed"):
            continue
        sp = (g.get("odds") or {}).get("spread_home")
        if sp is None:
            continue
        margin = g["home_score"] - g["away_score"]
        cover = margin + sp
        hist[g["home"]["abbr"]].append({"result": "W" if cover > 0 else ("L" if cover < 0 else "P")})
        hist[g["away"]["abbr"]].append({"result": "L" if cover > 0 else ("W" if cover < 0 else "P")})

    out = {}
    for t, rows in hist.items():
        recent = rows[-lookback:]
        w = sum(1 for x in recent if x["result"] == "W")
        l = sum(1 for x in recent if x["result"] == "L")
        p = sum(1 for x in recent if x["result"] == "P")
        out[t] = {"w": w, "l": l, "p": p,
                  "pct": (w / (w + l)) if (w + l) else None,
                  "n": len(recent)}
    return out
