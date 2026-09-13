/*
 * Shared-ledger round trip for this board.
 *
 * The sync layer's promise is that a bet can leave this board, be flattened into
 * the shared sheet's columns, come back, and still be the exact object this
 * board's own code expects - same stake, same settlement, same everything it
 * reads. That promise is what these tests hold it to, offline, with no network
 * and no browser: the real ledger module, the real betsync.js and the real
 * adapter, loaded into a sandbox.
 *
 *   node tests/test_sync.mjs
 */
import assert from "node:assert/strict";
import vm from "node:vm";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const web = path.join(root, "site");

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/* Objects made inside the sandbox carry its realm's prototype, which
   deepStrictEqual refuses to match. Compare what they say, not where they were
   made. */
function same(a, b, message) {
  const key = o => JSON.stringify(o, Object.keys(o || {}).sort());
  assert.equal(key(a), key(b), message);
}

/* A browser thin enough to load the ledger module, betsync and one adapter. */
function boardInPage() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  const noop = () => {};
  const win = {
    localStorage, console, Promise, JSON, Date, Math, Object, Array,
    String, Number, isFinite, isNaN, Error,
    setInterval: noop, clearInterval: noop, setTimeout, clearTimeout,
    addEventListener: noop,
    navigator: { userAgent: "node" },
    document: { visibilityState: "visible", addEventListener: noop, readyState: "complete" },
    Storage: { prototype: { setItem: localStorage.setItem } }
  };
  win.window = win; win.self = win; win.globalThis = win;
  const ctx = vm.createContext(win);
  const run = f => vm.runInContext(fs.readFileSync(f, "utf8"), ctx, { filename: f });

  run(path.join(web, "ledger.js"));
  run(path.join(web, "staking.js"));
  run(path.join(web, "betsync.js"));

  let adapter = null;
  const register = ctx.window.BetSync.register;
  ctx.window.BetSync.register = a => { adapter = a; return register(a); };
  ctx.window.BetSync.start = () => {};
  run(path.join(web, "sync-adapter.js"));
  assert.ok(adapter, "sync-adapter.js registered nothing");

  return { ctx, adapter, L: ctx.window.NCAAFEdgeLedger, BS: ctx.window.BetSync,
           put: rows => localStorage.setItem(ctx.window.NCAAFEdgeLedger.STORAGE_KEY, JSON.stringify({ entries: rows })),
           get: () => ctx.window.NCAAFEdgeLedger.load() };
}

const entry = (over = {}) => ({
  id: "401872925|ATS|home", candidate_id: "401872925:ATS:home",
  game_id: "401872925", game_date: "2026-09-13", week: 3,
  matchup: "Tampa Bay @ Cincinnati", market: "ATS", side: "home",
  pick: "Cincinnati -3.5", line: -3.5, price: -110, book: "ESPN BET",
  model_prob: 0.56, market_fair_prob: 0.524, breakeven: 0.524,
  edge: 0.036, edge_raw: 0.061, tier: "GOOD", confidence: 0.7,
  stake: 8.25, added_at: "2026-09-13T14:00:00.000Z",
  result: null, pnl: null, final_score: null,
  ...over
});

/* --------------------------------------------------------------------------- */

test("a bet flattens into the sheet's columns without losing itself", () => {
  const b = boardInPage();
  b.put([entry()]);
  const rows = b.adapter.readLocal();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].app, "ncaaf-lab");
  assert.ok(rows[0].id.startsWith("ncaaf-lab:"), "ids carry the board, so two boards never collide");
  assert.equal(rows[0].status, "Pending");
  assert.ok(rows[0].native, "the board's own record travels along");
});

test("and comes back as the same object the board started with", () => {
  const b = boardInPage();
  const original = entry();
  b.put([original]);
  b.adapter.writeLocal(b.adapter.readLocal());
  same(b.get()[0], original, "a round trip must change nothing");
});

test("a result settled on another device lands on this board's entry", () => {
  const b = boardInPage();
  b.put([entry()]);
  const row = b.adapter.readLocal()[0];
  b.adapter.writeLocal([{ ...row, status: "Win", pnl: 7.5 }]);
  const after = b.get()[0];
  assert.equal(after.result, "Win");
  assert.equal(after.pnl, 7.5);
  assert.equal(after.stake, 8.25, "settling must not disturb the stake");
});

test("a stake edited elsewhere lands too, without disturbing the rest", () => {
  const b = boardInPage();
  const original = entry();
  b.put([original]);
  const row = b.adapter.readLocal()[0];
  b.adapter.writeLocal([{ ...row, stake: 41.25 }]);
  const after = b.get()[0];
  assert.equal(Number(after.stake), 41.25);
  assert.equal(after.game_id, "401872925");
  assert.equal(after.pick, "Cincinnati -3.5");
  assert.equal(after.line, -3.5);
});

test("a bet removed everywhere else is removed here", () => {
  const b = boardInPage();
  b.put([entry()]);
  b.adapter.writeLocal([]);
  assert.equal(b.get().length, 0);
});

test("the shared bankroll reaches the staking settings", () => {
  const b = boardInPage();
  b.adapter.applyBankroll({ current: 407.15 });
  assert.equal(b.ctx.window.EdgeStaking.load("ncaaf-edge.staking.v1").bankroll, 407.15);
});

for (const [name, fn] of cases) {
  try { fn(); passed++; }
  catch (err) { console.error("FAIL  " + name + "\n      " + err.message); process.exitCode = 1; }
}
console.log(passed + "/" + cases.length + " passed");
