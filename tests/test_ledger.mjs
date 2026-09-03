import assert from "node:assert/strict";
import {createRequire} from "node:module";

const require = createRequire(import.meta.url);
const L = require("../site/ledger.js");
const row = {
  game_id:"1", game_date:"2026-09-05T19:30Z", week:1, matchup:"TULN @ DUKE",
  market:"TOTAL", side:"over", pick:"Over 51.5", line:51.5, price:-105,
  book:"Draft Kings", model_prob:.574, market_fair_prob:.489, breakeven:.512,
  edge:.054, action_edge:.035, edge_raw:.062, tier:"LEAN", confidence:.45,
};

const entry = L.entryFrom(row, 16);
assert.equal(entry.stake, 16);
assert.equal(entry.edge, .035);
assert.equal(L.keyOf(entry), "1|TOTAL|over");
assert.equal(L.merge([entry], [entry]).entries.length, 1);

const settled = L.settleAll([entry], [{
  game_id:"1", completed:true, away:"TULN", home:"DUKE", away_score:28, home_score:31,
}]);
assert.equal(settled.entries[0].result, "Win");
assert.equal(settled.entries[0].pnl, 15.24);

const summary = L.summarise(settled.entries, 500);
assert.equal(summary.current_bankroll, 515.24);
assert.equal(summary.settled, 1);
assert.match(L.toCSV(settled.entries), /TULN @ DUKE/);
console.log("NCAAF manual ledger tests passed");
