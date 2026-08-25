# NCAAF Edge

A college-football betting model that runs itself. Schedule, scores, odds, power
ratings, edges, tiers, stake sizes, grading, bankroll and ROI all update on a
schedule with no manual step, and the output is a responsive web dashboard plus
a workbook that regenerates itself every run. This Lab version uses the same
compact dark-first layout as MLB Edge Desk.

The dashboard also includes a matchup simulator that runs 1,000 to 50,000
repeat games from the same power ratings, scoring model, key-number margin
distribution and uncertainty used by the board. Choose a scheduled game to
load its posted spread and total, or create any rated matchup.

It replaces a spreadsheet that needed the whole week's games, every line, and
every final score typed in by hand.

```
ESPN public API  ──►  ratings solved from results  ──►  edges + tiers
                                                          │
                          state/ (line history, bet ledger, game cache)
                                                          │
                                   site/data/*.json  ──►  dashboard  ──►  Wix
                                                     └►  NCAAF_Edge_Model.xlsx
```

## What it does that the spreadsheet couldn't

**Power ratings solve themselves.** The workbook shipped with hand-typed sample
ratings and a note telling you to replace them weekly from SP+ or FPI. Here they
are solved from actual results by ridge-regularised least squares on margin of
victory, so strength of schedule falls out of the maths instead of being a fudge
factor, and they update every time a game goes final. Home-field advantage is
solved too rather than assumed.

**Key numbers.** Football margins are not a bell curve — games land on 3 and 7
far more often than a normal distribution predicts. The spreadsheet used
`NORMSDIST`, which systematically overpays to buy off 3 and misprices every
number beside it. This uses a discrete margin distribution bumped at the key
numbers, which also produces honest push probabilities on whole-number spreads.

**Vig is separated from disagreement.** The market's *fair* opinion (de-vigged)
and the price you actually have to beat (break-even) are different numbers, and
conflating them makes the juice look like an edge. Both are shown.

**Missing prices stay missing.** ESPN's current feed nests the real two-sided
prices inside each moneyline, point-spread and total market. A market is priced
only when both side prices are present; the pipeline never substitutes a
standard `-110`. A flat-price integrity tripwire disables plays if that bug ever
returns.

**Old lines expire.** Only games inside the configured rolling lookahead window
can reach the betting board. A preseason line cached for a game months away can
remain visible in the season schedule, but it cannot be treated as a current,
actionable quote.

**Closing line value.** Every line is snapshotted every run, so the model knows
what it bet into and what the market closed at. Over a few hundred bets CLV
predicts profit far better than win rate.

**It grades itself honestly.** A bet is logged once at the number it qualified
at and never re-priced. A model that re-grades itself against the closing line
always looks brilliant and is always lying.

**It tells you when not to trust it.** The Model Health tab publishes the
calibration table, Brier score and CLV. If a 60% pick has been winning 45% of
the time, you will see it there.

**Rest days come from the calendar,** not from you typing them in.

## Action grades

| Grade | Action edge | Meaning |
|---|---|---|
| **BEST BET** | ≥ 8% | The model's strongest disagreements with the market |
| **GOOD** | ≥ 5% | Worth a standard stake |
| **LEAN** | ≥ 3% | Small stake, or a watch |
| **AVOID** | below or hard stop | Visible for audit, never logged or staked |

Raw edge is model probability minus the break-even probability of the offered
price. The dashboard emphasizes **action edge**, the more conservative number
used for grading. Two adjustments are subtracted first:

* A **winner's-curse haircut** is subtracted from every edge. You only bet where
  the model disagrees with the market, which is exactly where the model's own
  error is largest, so selected edges are overstated even when the model is
  perfectly calibrated across all games. Walk-forward simulation puts that gap
  at 9–15 points of probability.
* **Confidence reserve** subtracts up to 1.8 additional percentage points when
  team and line data are thin. This bounded reserve replaces the old
  `1 / confidence` threshold multiplier that created an empty middle between
  huge edges and PASS.

Safety checks now have two levels. Crossing a **soft** model/market or preferred
price range caps the play at LEAN and reduces the stake. Crossing a **hard**
range still produces AVOID. FCS games, incomplete two-sided prices and
odds-integrity failures always remain hard stops.

Then two volume controls: at most one bet per game (a team's moneyline and its
spread are close to the same bet) and at most ten plays per week, best edges
first.

## Setup

Full walkthrough including the Wix embed is in **[SETUP.md](SETUP.md)**. Short
version:

```bash
git clone https://github.com/YOURNAME/ncaaf-edge-lab
cd ncaaf-edge-lab
pip install -r requirements.txt
python -m tests.test_offline        # 90-odd checks, no network needed
python -m pipeline.build --full     # first run backfills last season, ~5 min
python -m pipeline.to_excel
```

Then push, turn on GitHub Pages (Settings → Pages → Source: GitHub Actions), and
the included workflow refreshes everything four times a day for free.

## Commands

| Command | What it does |
|---|---|
| `python -m pipeline.build` | Normal refresh — rolling window of games |
| `python -m pipeline.build --full` | Full-season backfill, rebuilds the cache |
| `python -m pipeline.build --no-bet` | Price everything, log nothing |
| `python -m pipeline.backtest` | Walk-forward backtest on cached seasons |
| `python -m pipeline.to_excel` | Regenerate the workbook |
| `python -m tests.test_offline` | Full pipeline self-test, no network |
| `node tests/test_simulator.js` | Simulator self-test, no network |
| `python -m tools.make_demo --embed` | Simulated data + a standalone preview page |

## Tuning

Everything lives in `config/settings.json` — thresholds, Kelly fraction, market
blend, ridge lambda, volume caps. Edit, commit, and the next run uses it.

`config/overrides.json` (optional) is the manual escape hatch for things no feed
knows: an injury, a suspension, weather. It never gets overwritten.

```json
{
  "401752815": { "margin_adj": -3.5, "total_adj": -2.0,
                 "note": "starting QB out" }
}
```

`margin_adj` is in points and positive favours the home team.

## The honest part

The market is a consensus of everyone with money on the line, and it is very
good. A single rating model built on one free data source should not expect to
beat it by much, and most weeks the correct output is a short list or an empty
one. Three specific things to watch, all on the Model Health tab:

* **Calibration gap negative across every bucket past 100 bets** — the model is
  systematically overconfident. Raise `market_blend`.
* **Average CLV below zero** — it is consistently taking worse numbers than the
  market closes at. No win rate rescues that.
* **Tier ROI running backwards**, LEAN out-earning BEST BET — the edge estimate
  isn't ordering bets correctly and the tiers are cosmetic.

Any one of them is a reason to stop betting the model and go fix it.

A backtest that shows a big edge is far more likely to have a look-ahead bug
than to have found one. `pipeline/backtest.py` re-solves ratings each matchday
using only games already finished, specifically to avoid that.

Nothing here is a guarantee. Bet only what you can afford to lose.

## Data source

ESPN's public JSON feed — free and no key. It carries the full FBS schedule,
live and final scores, and a single sportsbook's pregame line. DraftKings is
preferred when ESPN exposes it; incomplete two-sided markets are ignored.

The main limitation is that single book: there is no line shopping, no
multi-book consensus, and no way to spot the outlier price that is usually where
the real edge lives. If you later want that, `pipeline/espn.py` is the only file
that touches the network — adding a second source means adding one more
`fetch_range`-shaped function and merging its odds in `build.py`.

## Layout

```
config/settings.json      every knob
config/overrides.json     manual injury / weather adjustments (optional)
pipeline/espn.py          the only file that touches the network
pipeline/ratings.py       ridge solve for power, offence and defence ratings
pipeline/model.py         probabilities, key numbers, de-vig, Kelly, tiers
pipeline/build.py         orchestrator
pipeline/ledger.py        bet log, grading, CLV, ROI
pipeline/backtest.py      walk-forward evaluation
pipeline/to_excel.py      workbook export
site/index.html           the dashboard (one file, no dependencies)
site/data/*.json          generated feed
state/*.json              line history and ledger — committed, do not delete
tests/test_offline.py     self-test
```

`state/` is the memory. Delete it and you lose every line snapshot and the bet
history, which cannot be re-fetched — ESPN drops odds once a game is final.
