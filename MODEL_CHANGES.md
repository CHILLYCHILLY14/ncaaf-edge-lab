# NCAAF Edge Lab — model review

Reviewed against the August 25, 2026 slate and the current MLB Edge Desk user
interface.

## Why the original board was sparse

The original opening-week confidence was 0.45. Its tier formula divided every
threshold by confidence, so the nominal 3% LEAN threshold became 7.67% after
the selection haircut. That left very little middle ground: ordinary edges
were PASS, while the few surviving candidates looked unusually large.

Two additional hard filters then removed borderline information completely:

- raw model/market disagreement beyond one ceiling;
- any American price outside one allowable range.

On the reviewed live snapshot the original model showed four qualified plays.

## What changed

- Added **action edge**: raw edge minus the selection haircut and a bounded
  early-season uncertainty reserve.
- Replaced the `1 / confidence` tier multiplier with a maximum 1.8 percentage
  point reserve.
- Split model/market and price controls into **soft** and **hard** ranges.
- Soft warnings cap a candidate at LEAN and reduce its Kelly stake to 50–60%.
- Hard blind spots, incomplete prices, odds-integrity failures and FCS games
  remain AVOID and cannot enter the ledger.
- Preserved one play per game, the ten-play weekly cap, frozen ledger prices,
  CLV tracking and the 5% per-play bankroll cap (with the existing ten-play
  weekly maximum, so total weekly exposure cannot exceed 50%).
- Updated the interface to the compact MLB Edge Desk visual system and renamed
  PASS to the clearer user-facing label **AVOID**.

## Reviewed output

With the same August 25 slate, the Lab configuration produced seven qualified
plays: one GOOD and six LEAN. Three of the LEANs were explicitly risk-capped.
This is a larger, more useful board without forcing a play on every game.

The complete offline suite passes, including odds parsing, hard/soft guards,
FCS protection, grading, CLV, correlation limits, schedule handling, simulator,
backtest and workflow-facing data generation.
