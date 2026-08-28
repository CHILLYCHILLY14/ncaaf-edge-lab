import assert from "node:assert/strict";
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const S = require("../site/staking.js");

const base = S.normalise({bankroll:500,system:"kelly",kelly_fraction:.25,max_stake_pct:.05,
  max_slate_exposure_pct:.5,min_stake:1,round_to:.5});
const row = {tier:"GOOD",price:-110,model_prob:.60,stake_multiplier:1};
assert.equal(S.suggestedStake(row,base,500,.85),20,"quarter Kelly should size to $20");
assert.equal(S.suggestedStake({...row,stake_multiplier:.5},base,500,.85),10,"Kelly respects confidence scaling");
assert.equal(S.suggestedStake({...row,held:true},base,500,.85),0,"held plays are never staked");
assert.equal(S.suggestedStake({...row,tier:"PASS"},base,500,.85),0,"passes are never staked");

assert.equal(S.suggestedStake(row,{...base,system:"flat",flat_stake:100},500,.85),25,"per-play cap applies to flat stakes");
assert.equal(S.suggestedStake(row,{...base,system:"percent",bankroll_pct:.02},500,.85),10,"percent staking uses bankroll");

const four = Array.from({length:4},()=>({...row}));
const plan = S.plan(four,{...base,system:"flat",flat_stake:25,max_stake_pct:1,max_slate_exposure_pct:.5},100,.85);
assert.deepEqual(plan,[12.5,12.5,12.5,12.5],"slate cap scales stakes proportionally");
assert.equal(plan.reduce((a,b)=>a+b,0),50,"slate exposure never exceeds its cap");

const safe = S.normalise({bankroll:-10,kelly_fraction:4,max_stake_pct:-1,round_to:0});
assert.equal(safe.bankroll,0); assert.equal(safe.kelly_fraction,1); assert.equal(safe.max_stake_pct,0); assert.equal(safe.round_to,.01);
console.log("staking tests passed");
