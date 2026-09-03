/* My Ledger — NCAAF wagers the user explicitly confirms, stored in this browser. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.NCAAFEdgeLedger = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const STORAGE_KEY = "ncaafedge.ledger.v2";
  const SCHEMA = 2;
  const decimal = american => {
    const value = Number(american);
    if (!isFinite(value) || value === 0) return 1;
    return 1 + (value > 0 ? value / 100 : 100 / Math.abs(value));
  };
  const keyOf = row => `${row.game_id}|${row.market}|${row.side}`;

  function entryFrom(row, stakeOverride) {
    const stake = stakeOverride == null ? Number(row.stake || 0) : Number(stakeOverride);
    return {
      id: keyOf(row),
      candidate_id: `${row.game_id}:${row.market}:${row.side}`,
      game_id: row.game_id,
      game_date: row.game_date,
      week: row.week,
      matchup: row.matchup,
      market: row.market,
      side: row.side,
      pick: row.pick,
      line: row.line == null ? null : Number(row.line),
      price: Number(row.price),
      book: row.book || null,
      model_prob: Number(row.model_prob),
      market_fair_prob: row.market_fair_prob == null ? null : Number(row.market_fair_prob),
      breakeven: Number(row.breakeven),
      edge: Number(row.action_edge == null ? row.edge : row.action_edge),
      edge_raw: Number(row.edge_raw),
      tier: row.tier,
      confidence: row.confidence,
      stake: Math.round(Math.max(0, stake) * 100) / 100,
      added_at: new Date().toISOString(),
      result: null,
      pnl: null,
      final_score: null,
    };
  }

  function settle(entry, game) {
    if (!game || !game.completed || game.away_score == null || game.home_score == null) return null;
    const away = Number(game.away_score);
    const home = Number(game.home_score);
    const margin = home - away;
    const total = home + away;
    let result = null;

    if (entry.market === "ML") {
      result = margin === 0 ? "Push" : ((entry.side === "home") === (margin > 0) ? "Win" : "Loss");
    } else if (entry.market === "ATS") {
      if (entry.line == null) return {result:"Void", pnl:0, final_score:`${game.away} ${away} - ${game.home} ${home}`};
      const adjusted = margin + Number(entry.line);
      result = Math.abs(adjusted) < 1e-9 ? "Push" : ((entry.side === "home") === (adjusted > 0) ? "Win" : "Loss");
    } else if (entry.market === "TOTAL") {
      if (entry.line == null) return {result:"Void", pnl:0, final_score:`${game.away} ${away} - ${game.home} ${home}`};
      result = Math.abs(total - Number(entry.line)) < 1e-9
        ? "Push"
        : ((entry.side === "over") === (total > Number(entry.line)) ? "Win" : "Loss");
    }
    if (!result) return null;

    const stake = Number(entry.stake || 0);
    const pnl = result === "Win" ? stake * (decimal(entry.price) - 1)
      : result === "Loss" ? -stake : 0;
    return {
      result,
      pnl: Math.round(pnl * 100) / 100,
      final_score: `${game.away} ${away} - ${game.home} ${home}`,
      settled_at: new Date().toISOString(),
    };
  }

  function settleAll(entries, games) {
    const byId = new Map((games || []).map(game => [String(game.game_id), game]));
    let changed = 0;
    const rows = (entries || []).map(entry => {
      if (entry.result) return entry;
      const result = settle(entry, byId.get(String(entry.game_id)));
      if (!result) return entry;
      changed += 1;
      return Object.assign({}, entry, result);
    });
    return {entries: rows, changed};
  }

  function summarise(entries, starting) {
    const rows = entries || [];
    const settled = rows.filter(entry => entry.result);
    const pnl = settled.reduce((sum, entry) => sum + Number(entry.pnl || 0), 0);
    const staked = settled
      .filter(entry => entry.result !== "Push" && entry.result !== "Void")
      .reduce((sum, entry) => sum + Number(entry.stake || 0), 0);
    const wins = settled.filter(entry => entry.result === "Win").length;
    const losses = settled.filter(entry => entry.result === "Loss").length;
    const pushes = settled.filter(entry => entry.result === "Push").length;
    let running = Number(starting || 0);
    const curve = settled.slice()
      .sort((a, b) => String(a.settled_at || a.game_date).localeCompare(String(b.settled_at || b.game_date)))
      .map(entry => {
        running += Number(entry.pnl || 0);
        return {date:String(entry.game_date || "").slice(0, 10), bankroll:Math.round(running * 100) / 100};
      });
    return {
      starting_bankroll: Number(starting || 0),
      current_bankroll: Math.round((Number(starting || 0) + pnl) * 100) / 100,
      total_bets: rows.length,
      settled: settled.length,
      pending: rows.filter(entry => !entry.result).length,
      wins,
      losses,
      pushes,
      win_rate: wins + losses ? wins / (wins + losses) : null,
      staked: Math.round(staked * 100) / 100,
      pnl: Math.round(pnl * 100) / 100,
      roi: staked ? pnl / staked : null,
      at_risk: Math.round(rows.filter(entry => !entry.result)
        .reduce((sum, entry) => sum + Number(entry.stake || 0), 0) * 100) / 100,
      curve,
    };
  }

  function load() {
    try {
      const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      const rows = Array.isArray(parsed) ? parsed : (parsed && parsed.entries) || [];
      return rows.filter(row => row && row.game_id && row.market && row.side);
    } catch (_) {
      return [];
    }
  }

  function save(entries) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({schema:SCHEMA, saved_at:new Date().toISOString(), entries}));
      return true;
    } catch (_) {
      return false;
    }
  }

  function merge(existing, incoming) {
    const rows = new Map((existing || []).map(entry => [keyOf(entry), entry]));
    let added = 0;
    (incoming || []).forEach(entry => {
      if (!entry || !entry.game_id || !entry.market || !entry.side) return;
      const key = keyOf(entry);
      if (!rows.has(key)) {
        rows.set(key, entry);
        added += 1;
      }
    });
    return {entries:[...rows.values()], added};
  }

  const CSV_COLS = [
    "game_date", "matchup", "market", "side", "pick", "line", "price", "book",
    "stake", "tier", "edge", "model_prob", "result", "pnl", "final_score", "added_at",
  ];
  function toCSV(entries) {
    const quote = value => {
      const text = value == null ? "" : String(value);
      return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
    };
    return [CSV_COLS.join(",")]
      .concat((entries || []).map(entry => CSV_COLS.map(key => quote(entry[key])).join(",")))
      .join("\n");
  }

  return {STORAGE_KEY, SCHEMA, decimal, keyOf, entryFrom, settle, settleAll, summarise, load, save, merge, toCSV, CSV_COLS};
});
