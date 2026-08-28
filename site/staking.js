/* Browser-local bankroll and staking controls shared by the public board. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.EdgeStaking = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const SCHEMA = 1;
  const SYSTEMS = new Set(["kelly", "flat", "percent"]);
  const finite = (v, fallback) => Number.isFinite(Number(v)) ? Number(v) : fallback;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, finite(v, lo)));

  function normalise(input, defaults) {
    const d = Object.assign({
      bankroll: 500,
      system: "kelly",
      kelly_fraction: 0.25,
      bankroll_pct: 0.02,
      flat_stake: 10,
      max_stake_pct: 0.05,
      max_slate_exposure_pct: 0.50,
      min_stake: 1,
      round_to: 0.5,
    }, defaults || {});
    const s = Object.assign({}, d, input || {});
    return {
      bankroll: clamp(s.bankroll, 0, 1000000000),
      system: SYSTEMS.has(s.system) ? s.system : d.system,
      kelly_fraction: clamp(s.kelly_fraction, 0, 1),
      bankroll_pct: clamp(s.bankroll_pct, 0, 1),
      flat_stake: clamp(s.flat_stake, 0, 1000000000),
      max_stake_pct: clamp(s.max_stake_pct, 0, 1),
      max_slate_exposure_pct: clamp(s.max_slate_exposure_pct, 0, 1),
      min_stake: clamp(s.min_stake, 0, 1000000000),
      round_to: clamp(s.round_to, 0.01, 1000000),
    };
  }

  function load(key, defaults) {
    try {
      const saved = JSON.parse(localStorage.getItem(key) || "null");
      return normalise(saved && saved.settings, defaults);
    } catch (_) {
      return normalise(null, defaults);
    }
  }

  function save(key, settings) {
    try {
      localStorage.setItem(key, JSON.stringify({
        schema: SCHEMA,
        saved_at: new Date().toISOString(),
        settings: normalise(settings),
      }));
      return true;
    } catch (_) {
      return false;
    }
  }

  function clear(key) {
    try { localStorage.removeItem(key); return true; } catch (_) { return false; }
  }

  function decimal(american) {
    const a = Number(american);
    if (!Number.isFinite(a) || a === 0) return null;
    return 1 + (a > 0 ? a / 100 : 100 / Math.abs(a));
  }

  function suggestedStake(row, settings, bankroll, maxModelProb) {
    const s = normalise(settings);
    const roll = Math.max(0, finite(bankroll, s.bankroll));
    if (!row || row.tier === "PASS" || row.held || roll <= 0) return 0;

    let raw = 0;
    if (s.system === "flat") {
      raw = s.flat_stake;
    } else if (s.system === "percent") {
      raw = roll * s.bankroll_pct;
    } else {
      const dec = decimal(row.price);
      if (!dec) return 0;
      const ceiling = finite(maxModelProb, 0.85);
      const p = clamp(row.model_prob, 0, ceiling);
      const fullKelly = Math.max(0, ((p * (dec - 1)) - (1 - p)) / (dec - 1));
      const confidenceScale = clamp(row.stake_multiplier == null ? 1 : row.stake_multiplier, 0, 1);
      raw = roll * fullKelly * s.kelly_fraction * confidenceScale;
    }

    raw = Math.min(raw, roll * s.max_stake_pct);
    const rounded = Math.round(raw / s.round_to) * s.round_to;
    return rounded + 1e-9 < s.min_stake ? 0 : Math.round(rounded * 100) / 100;
  }

  function plan(rows, settings, bankroll, maxModelProb) {
    const s = normalise(settings);
    const roll = Math.max(0, finite(bankroll, s.bankroll));
    const stakes = (rows || []).map(row => suggestedStake(row, s, roll, maxModelProb));
    const total = stakes.reduce((sum, value) => sum + value, 0);
    const cap = roll * s.max_slate_exposure_pct;
    if (total <= cap + 1e-9) return stakes;
    const scale = total ? cap / total : 0;
    return stakes.map(value => {
      const adjusted = Math.floor((value * scale + 1e-9) / s.round_to) * s.round_to;
      return adjusted + 1e-9 < s.min_stake ? 0 : Math.round(adjusted * 100) / 100;
    });
  }

  function description(settings, currencySymbol) {
    const s = normalise(settings);
    if (s.system === "flat") return `Flat ${currencySymbol || "$"}${s.flat_stake.toFixed(2)}`;
    if (s.system === "percent") return `${(s.bankroll_pct * 100).toFixed(1)}% bankroll`;
    return `${(s.kelly_fraction * 100).toFixed(0)}% Kelly`;
  }

  return {SCHEMA, normalise, load, save, clear, decimal, suggestedStake, plan, description};
});
