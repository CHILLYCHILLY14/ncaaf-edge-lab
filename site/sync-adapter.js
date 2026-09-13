/*
 * sync-adapter.js — NCAAF Edge Lab's half of the shared ledger.
 *
 * Translates between this board's own ledger entries and the flat row shape the
 * sheet stores, and puts the shared bankroll into the staking settings. The
 * board's entry travels along untouched inside `native`, so nothing this board
 * relies on is lost by passing through the sheet.
 */
(function () {
  "use strict";
  if (!window.BetSync) return;
  var BS = window.BetSync;
  var APP = "ncaaf-lab", SPORT = "NCAAF";
  var L = window.NCAAFEdgeLedger;
  var STK = window.EdgeStaking;
  var STAKING_KEY = "ncaaf-edge.staking.v1";
  if (!L) return;

  var SIDE_WORDS = { home: "Home", away: "Away", over: "Over", under: "Under" };

  function describe(e) {
    if (e.pick) return e.pick;
    var side = SIDE_WORDS[e.side] || e.side || "";
    return (e.matchup || "") + (side ? " — " + side : "");
  }

  function toCanonical(e) {
    return {
      id: APP + ":" + e.game_id + "|" + e.market + "|" + e.side,
      app: APP, sport: SPORT,
      placed_at: e.added_at,
      event_date: String(e.game_date || "").slice(0, 10),
      event: e.matchup,
      market: e.market,
      selection: describe(e),
      side: e.side,
      line: e.line, price: e.price, book: e.book, stake: e.stake,
      tier: e.tier, edge: e.edge, model_prob: e.model_prob,
      status: e.result || "Pending",
      pnl: e.pnl, closing_price: null,
      score: e.final_score, notes: "",
      native: e
    };
  }

  function fromCanonical(row) {
    var e = row.native ? JSON.parse(JSON.stringify(row.native)) : {
      id: String(row.id).split(":").slice(1).join(":"),
      game_id: String(row.id).split(":").pop().split("|")[0],
      game_date: row.event_date, matchup: row.event, market: row.market,
      side: row.side, pick: row.selection, line: row.line, price: row.price,
      book: row.book, model_prob: row.model_prob, edge: row.edge,
      tier: row.tier, added_at: row.placed_at
    };
    if (row.stake != null) e.stake = row.stake;
    e.result = row.status === "Pending" ? null : row.status;
    e.pnl = row.pnl;
    if (row.score) e.final_score = row.score;
    return e;
  }

  /* What a board would actually notice changing — a bet appearing, a stake
   * edited, a result landing. Anything else is not worth a repaint. */
  function fingerprint(entries) {
    return JSON.stringify((entries || []).map(function (e) {
      return [L.keyOf(e), e.stake, e.result, e.pnl];
    }).sort());
  }

  function rerender() {
    try { if (typeof S !== "undefined") S.myLedger = L.load(); } catch (_) {}
    if (typeof window.refreshLedgerViews === "function") try { window.refreshLedgerViews(); } catch (_) {}
  }

  BS.register({
    app: APP,
    sport: SPORT,
    storageKey: L.STORAGE_KEY,

    readLocal: function () {
      return (L.load() || []).map(toCanonical);
    },

    writeLocal: function (rows) {
      var next = rows.map(fromCanonical);
      var before = fingerprint(L.load());
      L.save(next);
      if (before !== fingerprint(next)) rerender();
    },

    /* One bankroll across all five boards, so a bad week anywhere shrinks the
     * next stake here. */
    applyBankroll: function (bank) {
      if (!STK || !bank || bank.current == null) return;
      try {
        var defaults = typeof stakingDefaults === "function" ? stakingDefaults() : undefined;
        var settings = STK.load(STAKING_KEY, defaults);
        if (Math.abs(Number(settings.bankroll) - bank.current) < 0.005) return;
        settings.bankroll = bank.current;
        STK.save(STAKING_KEY, settings);
        if (typeof S !== "undefined") S.staking = settings;
        rerender();
      } catch (_) {}
    }
  });

  BS.start();
})();
