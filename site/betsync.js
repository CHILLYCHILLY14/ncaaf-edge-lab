/*
 * betsync.js — one ledger, five boards, every device.
 *
 * Each board already keeps its bets in this browser's localStorage, and that
 * part does not change: the board reads and writes its own store in its own
 * shape, settles its own bets, and works with no network at all. This file sits
 * beside it and keeps that store in step with a Google Sheet, so the copy on a
 * phone and the copy on a laptop end up holding the same bets.
 *
 * The shape that travels between them is deliberately flat — one row per bet,
 * the same columns whatever the sport — with the board's own record carried
 * along verbatim in `native`. That way the sheet is readable and sortable by
 * hand, a cross-sport view is possible, and nothing a board depends on is lost
 * in translation.
 *
 * Conflict resolution is last-write-wins on the sheet's clock, with one
 * exception enforced on the server: a stale device holding a bet as Pending
 * never overwrites a result the sheet already has.
 *
 * The endpoint URL and token live in this browser only. They are typed into
 * each device once and are never committed to the repository.
 *
 * Pure functions are at the top so they can be tested outside a browser.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.BetSync = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  var CONFIG_KEY = "betsync.config.v1";
  var CURSOR_KEY = "betsync.cursor.v1";
  var ALL_KEY    = "betsync.all.v1";
  var SHADOW_KEY = "betsync.shadow.v1.";
  var HELD_KEY   = "betsync.held.v1.";
  var SCHEMA = 1;

  var FIELDS = [
    "id", "app", "sport", "placed_at", "event_date", "event", "market",
    "selection", "side", "line", "price", "book", "stake", "tier", "edge",
    "model_prob", "status", "pnl", "closing_price", "score", "notes",
    "updated_at", "device", "deleted"
  ];
  var NUMERIC = ["line", "price", "stake", "edge", "model_prob", "pnl", "closing_price"];
  var STATUSES = ["Pending", "Win", "Loss", "Push", "Void"];

  /* ----------------------------------------------------------------- pure */

  function num(v) {
    if (v === "" || v == null) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }

  function str(v) {
    return v == null ? "" : String(v);
  }

  /** Put a row in canonical shape. Anything the caller left out becomes blank
   *  rather than undefined, so two equal rows always hash the same. */
  function canonical(row) {
    var out = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i];
      if (NUMERIC.indexOf(k) >= 0) out[k] = num(row[k]);
      else if (k === "deleted") out[k] = row[k] === true || row[k] === "true";
      else out[k] = str(row[k]);
    }
    if (STATUSES.indexOf(out.status) < 0) out.status = "Pending";
    out.native = row.native != null ? row.native
      : (row.native_json ? safeParse(row.native_json) : null);
    return out;
  }

  function safeParse(text) {
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /** Stable stringify — key order must not depend on how an object was built,
   *  or a round trip through the sheet would look like an edit. */
  function stable(value) {
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
    var keys = Object.keys(value).sort();
    return "{" + keys.map(function (k) {
      return JSON.stringify(k) + ":" + stable(value[k]);
    }).join(",") + "}";
  }

  /** What a row means, ignoring the bookkeeping that changes on every sync. */
  function contentHash(row) {
    var c = canonical(row);
    var meaningful = {};
    for (var i = 0; i < FIELDS.length; i++) {
      var k = FIELDS[i];
      if (k === "updated_at" || k === "device") continue;
      meaningful[k] = c[k];
    }
    meaningful.native = c.native;
    return stable(meaningful);
  }

  var STATUS_RANK = { Pending: 0, Void: 1, Push: 2, Loss: 3, Win: 3 };

  /* Rows are stamped to the millisecond, and two writes really can share one -
   * a sheet that answers a pull and accepts a push inside the same tick will
   * hand back two versions of a bet bearing the same time. Something has to
   * break the tie, and it has to break it the same way everywhere or two
   * devices settle on different answers.
   *
   *   1. The newer timestamp wins.
   *   2. On a tie, a settled row beats a pending one - the only way to tie is
   *      that the writes crossed, and a result is the side worth keeping.
   *   3. Still tied: the incoming row wins. `incoming` is what the sheet just
   *      said, and the sheet is the thing both devices are trying to agree with.
   */
  function newer(a, b) {
    if (!a) return b;
    if (!b) return a;
    var ta = str(a.updated_at), tb = str(b.updated_at);
    if (ta > tb) return a;
    if (tb > ta) return b;
    var ra = STATUS_RANK[a.status] || 0, rb = STATUS_RANK[b.status] || 0;
    if (rb !== ra) return rb > ra ? b : a;
    return b;
  }

  /** Fold a batch of rows into a set keyed by id. `incoming` is the fresher
   *  side: it wins anything `base` cannot out-rank. */
  function mergeRows(base, incoming) {
    var map = {};
    var i;
    for (i = 0; i < (base || []).length; i++) {
      var b = canonical(base[i]);
      if (b.id) map[b.id] = b;
    }
    for (i = 0; i < (incoming || []).length; i++) {
      var r = canonical(incoming[i]);
      if (!r.id) continue;
      map[r.id] = newer(map[r.id], r);
    }
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  /** Everything this device has changed since the last successful sync. */
  function diff(local, shadow, opts) {
    var o = opts || {};
    var seen = {}, dirty = [], tombstones = [];
    var i, row, prev;

    for (i = 0; i < (local || []).length; i++) {
      row = canonical(local[i]);
      if (!row.id) continue;
      seen[row.id] = true;
      prev = shadow[row.id];
      if (!prev || prev.hash !== contentHash(row)) {
        row.base_rev = prev ? prev.updated_at : "";
        row.device = o.device || row.device || "";
        dirty.push(row);
      }
    }

    for (var id in shadow) {
      if (seen[id]) continue;
      prev = shadow[id];
      tombstones.push(canonical({
        id: id, app: prev.app || o.app || "", sport: prev.sport || "",
        status: prev.status || "Pending", deleted: true,
        device: o.device || "", base_rev: prev.updated_at || ""
      }));
    }
    return { dirty: dirty, tombstones: tombstones };
  }

  /** A ledger emptying itself in one step is almost always a cleared browser or
   *  a mis-tapped Clear button, not an intention to delete every bet everywhere.
   *  Anything that large waits for the person to say so. */
  function massDeleteGuard(tombstones, shadowSize) {
    if (tombstones.length <= 5) return false;
    return tombstones.length >= shadowSize * 0.5;
  }

  function decimalOdds(american) {
    var a = Number(american);
    if (!isFinite(a) || a === 0) return 1;
    return 1 + (a > 0 ? a / 100 : 100 / Math.abs(a));
  }

  /** P/L for a row the board has not worked out for itself. */
  function impliedPnl(row) {
    if (row.pnl != null) return Number(row.pnl);
    var stake = Number(row.stake || 0);
    if (row.status === "Win") return stake * (decimalOdds(row.price) - 1);
    if (row.status === "Loss") return -stake;
    return 0;
  }

  /** One bankroll across all five boards: what you started with, plus every
   *  settled result anywhere, with pending stakes shown separately as exposure. */
  function bankroll(rows, startingBankroll) {
    var start = Number(startingBankroll || 0);
    var settledPnl = 0, staked = 0, exposure = 0;
    var wins = 0, losses = 0, pushes = 0, pending = 0, voids = 0;
    var byApp = {};

    for (var i = 0; i < (rows || []).length; i++) {
      var r = rows[i];
      if (!r || r.deleted) continue;
      var app = r.app || "other";
      if (!byApp[app]) byApp[app] = { app: app, bets: 0, pending: 0, pnl: 0, staked: 0 };
      byApp[app].bets++;

      if (r.status === "Pending") {
        pending++;
        byApp[app].pending++;
        exposure += Number(r.stake || 0);
        continue;
      }
      var pnl = impliedPnl(r);
      settledPnl += pnl;
      byApp[app].pnl += pnl;
      if (r.status === "Win") wins++;
      else if (r.status === "Loss") losses++;
      else if (r.status === "Push") pushes++;
      else if (r.status === "Void") voids++;
      if (r.status === "Win" || r.status === "Loss") {
        staked += Number(r.stake || 0);
        byApp[app].staked += Number(r.stake || 0);
      }
    }

    return {
      starting: round2(start),
      current: round2(start + settledPnl),
      available: round2(start + settledPnl - exposure),
      pnl: round2(settledPnl),
      staked: round2(staked),
      exposure: round2(exposure),
      roi: staked ? settledPnl / staked : null,
      wins: wins, losses: losses, pushes: pushes, voids: voids, pending: pending,
      win_rate: (wins + losses) ? wins / (wins + losses) : null,
      by_app: Object.keys(byApp).sort().map(function (k) {
        byApp[k].pnl = round2(byApp[k].pnl);
        byApp[k].staked = round2(byApp[k].staked);
        return byApp[k];
      })
    };
  }

  function round2(v) {
    return Math.round((Number(v) || 0) * 100) / 100;
  }

  function shadowOf(rows) {
    var map = {};
    for (var i = 0; i < (rows || []).length; i++) {
      var r = canonical(rows[i]);
      if (!r.id) continue;
      map[r.id] = {
        hash: contentHash(r), updated_at: r.updated_at,
        app: r.app, sport: r.sport, status: r.status
      };
    }
    return map;
  }

  /* -------------------------------------------------------------- storage */

  function store() {
    try { return typeof localStorage !== "undefined" ? localStorage : null; }
    catch (_) { return null; }
  }

  function readJson(key, fallback) {
    var s = store();
    if (!s) return fallback;
    try {
      var raw = s.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (_) { return fallback; }
  }

  function writeJson(key, value) {
    var s = store();
    if (!s) return false;
    try { s.setItem(key, JSON.stringify(value)); return true; }
    catch (_) { return false; }
  }

  function loadConfig() {
    var c = readJson(CONFIG_KEY, null);
    if (!c || !c.url || !c.token) return null;
    return c;
  }

  function saveConfig(cfg) {
    if (!cfg) { try { store().removeItem(CONFIG_KEY); } catch (_) {} return true; }
    var clean = {
      url: str(cfg.url).trim(),
      token: str(cfg.token).trim(),
      device: str(cfg.device).trim() || deviceName()
    };
    return writeJson(CONFIG_KEY, clean);
  }

  /** A label for this device, so the sheet says where a row came from. */
  function deviceName() {
    var saved = readJson(CONFIG_KEY, null);
    if (saved && saved.device) return saved.device;
    var ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
    var guess = /iPhone/.test(ua) ? "iPhone"
      : /iPad/.test(ua) ? "iPad"
      : /Android/.test(ua) ? "Android"
      : /Macintosh/.test(ua) ? "Mac"
      : /Windows/.test(ua) ? "Windows"
      : "Browser";
    return guess + "-" + Math.random().toString(36).slice(2, 6);
  }

  /* -------------------------------------------------------------- network */

  /* Apps Script will not answer a request that triggers a CORS preflight, so a
   * push goes out as text/plain — which counts as a simple request — and the
   * script parses the body itself. If even that is blocked (a locked-down
   * browser, a webview), the transport falls back to a fire-and-forget POST
   * followed by a JSONP read to find out what actually landed. */

  function postJson(url, payload) {
    return fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload),
      redirect: "follow"
    }).then(function (res) {
      if (!res.ok) throw new Error("http_" + res.status);
      return res.text();
    }).then(function (text) {
      var parsed = safeParse(text);
      if (!parsed) throw new Error("bad_response");
      return parsed;
    });
  }

  function postOpaque(url, payload) {
    return fetch(url, {
      method: "POST", mode: "no-cors",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(payload)
    }).then(function () { return null; });
  }

  var jsonpSeq = 0;

  function jsonp(url, params, timeoutMs) {
    return new Promise(function (resolve, reject) {
      if (typeof document === "undefined") return reject(new Error("no_dom"));
      var name = "__betsync_cb_" + (++jsonpSeq) + "_" + Date.now();
      var query = [];
      for (var k in params) {
        if (params[k] == null) continue;
        query.push(encodeURIComponent(k) + "=" + encodeURIComponent(params[k]));
      }
      query.push("callback=" + name);
      var script = document.createElement("script");
      var done = false;
      var timer = setTimeout(function () { finish(new Error("timeout")); }, timeoutMs || 20000);

      function finish(err, data) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { delete window[name]; } catch (_) { window[name] = undefined; }
        if (script.parentNode) script.parentNode.removeChild(script);
        err ? reject(err) : resolve(data);
      }

      window[name] = function (data) { finish(null, data); };
      script.onerror = function () { finish(new Error("jsonp_failed")); };
      script.src = url + (url.indexOf("?") >= 0 ? "&" : "?") + query.join("&");
      document.head.appendChild(script);
    });
  }

  /* A caller with no ledger of its own - the cross-sport HQ page - still wants
   * the same transport, the same fallbacks and the same wire shape. These two
   * are that, and nothing else: read everything, or write rows back verbatim.
   * Rows written this way keep their native_json untouched, so each board is
   * still the only thing that decides what its own entry looks like. */

  function request(cfg, payload) {
    var body = {};
    for (var k in payload) body[k] = payload[k];
    body.token = cfg.token;
    return postJson(cfg.url, body).catch(function (err) {
      if (body.action !== "pull") throw err;
      return jsonp(cfg.url, { token: cfg.token, action: "pull", since: body.since || "" });
    }).then(function (res) {
      if (!res || !res.ok) throw new Error((res && res.error) || "failed");
      return res;
    });
  }

  function pullAll(cfg, since) {
    return request(cfg || loadConfig(), { action: "pull", since: since || "" });
  }

  function pushRows(cfg, rows, settings) {
    var c = cfg || loadConfig();
    return request(c, {
      action: "push", device: c.device, app: "hq", since: "",
      rows: (rows || []).map(forWire), settings: settings || null
    });
  }

  /* ------------------------------------------------------------ the engine */

  var registered = null;
  var listeners = [];
  var stateNow = {
    status: "idle",          // idle | syncing | ok | error | unconfigured | blocked
    message: "",
    lastSync: null,
    pendingMassDelete: null,
    bankroll: null,
    total: 0
  };
  var timer = null;
  var debounceTimer = null;
  var inFlight = null;
  var suppressed = 0;

  /* Writing the merged ledger back into the board's own store looks exactly like
   * the board saving a bet. Without this the write would schedule another sync,
   * which would write again, and the two would chase each other around. */
  function suppress(fn) {
    suppressed++;
    try { return fn(); }
    finally { setTimeout(function () { suppressed = Math.max(0, suppressed - 1); }, 0); }
  }

  function emit() {
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](stateNow); } catch (_) {}
    }
  }

  function setState(patch) {
    for (var k in patch) stateNow[k] = patch[k];
    emit();
  }

  function register(adapter) {
    registered = adapter;
    var cfg = loadConfig();
    setState({ status: cfg ? "idle" : "unconfigured" });
    return api;
  }

  function onChange(fn) {
    listeners.push(fn);
    try { fn(stateNow); } catch (_) {}
    return function () {
      var i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  function allRows() {
    return readJson(ALL_KEY, { rows: [] }).rows || [];
  }

  function settings() {
    return readJson(ALL_KEY, {}).settings || { starting_bankroll: 0 };
  }

  /** One full round trip: send what changed here, take back what changed there. */
  function sync(opts) {
    var o = opts || {};
    if (inFlight) return inFlight;
    var cfg = loadConfig();
    if (!cfg) {
      setState({ status: "unconfigured", message: "Not connected yet." });
      return Promise.resolve({ ok: false, error: "unconfigured" });
    }
    if (!registered) return Promise.resolve({ ok: false, error: "no_adapter" });

    var app = registered.app;
    var shadowKey = SHADOW_KEY + app;
    var shadow = readJson(shadowKey, {});
    var cursor = readJson(CURSOR_KEY, {})[app] || "";

    var local;
    try { local = (registered.readLocal() || []).map(canonical); }
    catch (err) { local = []; }

    var d = diff(local, shadow, { device: cfg.device, app: app });

    var heldKey = HELD_KEY + app;

    if (d.tombstones.length && massDeleteGuard(d.tombstones, Object.keys(shadow).length) && !o.confirmDeletes) {
      /* The rest of this sync pulls the missing bets straight back down from the
       * sheet, which is the right default — a cleared browser should not cost
       * anyone their history. But that also erases the evidence, so the
       * deletions are set aside here: if the person really did mean it, the
       * confirm path below still has something to send. */
      writeJson(heldKey, { at: new Date().toISOString(), rows: d.tombstones });
      setState({
        status: "blocked",
        message: d.tombstones.length + " bets are on the sheet but missing from this device.",
        pendingMassDelete: d.tombstones.length
      });
      d.tombstones = [];
      /* Still sync the rest — a held-back deletion should not stop a new bet
       * from reaching the other devices. */
    } else if (o.confirmDeletes) {
      var held = readJson(heldKey, null);
      if (held && held.rows) {
        d.tombstones = d.tombstones.concat(held.rows.map(function (r) {
          var t = canonical(r);
          t.deleted = true;
          return t;
        }));
      }
      writeJson(heldKey, null);
      setState({ pendingMassDelete: null, message: "" });
    } else if (o.dropHeld) {
      writeJson(heldKey, null);
      setState({ pendingMassDelete: null, message: "" });
    }

    var outgoing = d.dirty.concat(d.tombstones);
    var payload = {
      token: cfg.token, action: "push", device: cfg.device, app: app,
      since: cursor, schema: SCHEMA,
      rows: outgoing.map(forWire),
      settings: o.settings || null
    };

    setState({ status: "syncing", message: outgoing.length ? "Sending " + outgoing.length + "…" : "Checking…" });

    inFlight = postJson(cfg.url, payload)
      .catch(function () {
        /* Response unreadable from this origin: send it blind, then read back. */
        return postOpaque(cfg.url, payload).then(function () {
          return jsonp(cfg.url, { token: cfg.token, action: "pull", since: cursor });
        });
      })
      .then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "failed");
        return applyServer(res, app, shadowKey, cfg);
      })
      .catch(function (err) {
        setState({ status: "error", message: friendlyError(err) });
        return { ok: false, error: String(err && err.message || err) };
      })
      .then(function (result) {
        inFlight = null;
        return result;
      });

    return inFlight;
  }

  function forWire(row) {
    var out = {};
    for (var i = 0; i < FIELDS.length; i++) out[FIELDS[i]] = row[FIELDS[i]];
    out.base_rev = row.base_rev || "";
    out.native_json = row.native == null ? "" : JSON.stringify(row.native);
    return out;
  }

  function applyServer(res, app, shadowKey, cfg) {
    var cached = readJson(ALL_KEY, { rows: [], settings: {} });
    var merged = res.full ? mergeRows([], res.rows) : mergeRows(cached.rows || [], res.rows || []);
    var conf = res.settings || cached.settings || {};
    writeJson(ALL_KEY, { rows: merged, settings: conf, saved_at: new Date().toISOString() });

    var mine = merged.filter(function (r) { return r.app === app && !r.deleted; });

    /* A bet can be added in the seconds between this sync going out and its
     * answer coming back. The answer knows nothing about that bet, so writing
     * it straight back over the board's store would erase the bet before it had
     * ever been sent - it would exist nowhere. Anything here that the sheet has
     * not seen is kept, and deliberately left out of the shadow below so the
     * next sync treats it as new and sends it. */
    var seen = {};
    for (var m = 0; m < merged.length; m++) seen[merged[m].id] = true;

    var localNow = [];
    try { localNow = (registered.readLocal() || []).map(canonical); } catch (_) {}
    var unsent = localNow.filter(function (r) {
      return r.app === app && r.id && !seen[r.id];
    });
    if (unsent.length) mine = mine.concat(unsent);

    try { suppress(function () { registered.writeLocal(mine); }); } catch (_) {}

    var after;
    try { after = (registered.readLocal() || []).map(canonical); }
    catch (_) { after = mine; }

    var shadowNext = shadowOf(after);
    for (var u = 0; u < unsent.length; u++) delete shadowNext[unsent[u].id];
    writeJson(shadowKey, shadowNext);

    if (unsent.length) touch();

    /* The cursor is a moment on the sheet's clock, and rows are stamped to the
     * millisecond. A row written in the same millisecond the server answered in
     * would sit exactly on the cursor and never be asked for again - gone for
     * good, not merely late. Winding the cursor back a little costs one
     * re-fetch of rows already held, which merges to nothing. */
    var cursors = readJson(CURSOR_KEY, {});
    cursors[app] = rewind(res.now, 2000);
    writeJson(CURSOR_KEY, cursors);

    var bank = bankroll(merged, conf.starting_bankroll);
    if (registered.applyBankroll) {
      try { registered.applyBankroll(bank); } catch (_) {}
    }

    /* A sync that held deletions back still sends and receives everything else,
     * so it finishes successfully - but it must not report itself as clean, or
     * the warning the person has to answer disappears the moment it appears. */
    var held = stateNow.pendingMassDelete;
    setState({
      status: held ? "blocked" : "ok",
      message: held ? stateNow.message : "",
      lastSync: new Date().toISOString(),
      bankroll: bank,
      total: merged.filter(function (r) { return !r.deleted; }).length
    });
    return { ok: true, rows: merged, bankroll: bank, settings: conf };
  }

  function rewind(iso, ms) {
    var t = Date.parse(iso);
    if (!isFinite(t)) return iso || "";
    return new Date(t - ms).toISOString();
  }

  function friendlyError(err) {
    var msg = String(err && err.message || err || "");
    if (msg === "bad_token") return "That token was rejected. Check it in the Sync panel.";
    if (msg === "not_set_up") return "Run setup() once in the Apps Script editor.";
    if (msg === "busy") return "Another device is syncing. Trying again shortly.";
    if (/Failed to fetch|NetworkError|timeout|jsonp_failed/i.test(msg)) return "Could not reach the sheet. Check the web app URL.";
    if (/^http_/.test(msg)) return "The sheet answered with an error (" + msg.slice(5) + ").";
    return "Sync failed: " + msg;
  }

  /** Push a new starting bankroll to the sheet, where the other boards read it.
   *
   *  No timestamp goes with it, deliberately. The sheet stamps settings on its
   *  own clock; a stamp from here would be compared against that one, and a
   *  device whose clock runs even slightly behind Google's would have the figure
   *  it just typed silently ignored. Somebody opening the panel and saving a
   *  bankroll is an explicit instruction, so it wins - and the sheet records
   *  when it landed. */
  function setStartingBankroll(value) {
    return sync({ settings: { starting_bankroll: Number(value) || 0 } });
  }

  function schedule() {
    if (typeof window === "undefined") return;
    if (timer) clearInterval(timer);
    timer = setInterval(function () {
      if (document.visibilityState === "visible") sync();
    }, 5 * 60 * 1000);

    document.addEventListener("visibilitychange", function () {
      if (document.visibilityState === "visible") sync();
    });
    window.addEventListener("online", function () { sync(); });
  }

  /** Boards call this after they change their own ledger. */
  function touch() {
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(function () { sync(); }, 1500);
  }

  /** Watch the board's own store, so a board needs no edits to stay in step:
   *  anything it writes is noticed and queued for the next sync. */
  function watchStorage(key) {
    if (typeof window === "undefined" || !key) return;
    try {
      var proto = Object.getPrototypeOf(localStorage) || Storage.prototype;
      var original = proto.setItem;
      if (!original.__betsyncWrapped) {
        var wrapped = function (k, v) {
          var result = original.apply(this, arguments);
          if (wrapped.__keys[k] && !suppressed) touch();
          return result;
        };
        wrapped.__betsyncWrapped = true;
        wrapped.__keys = {};
        proto.setItem = wrapped;
      }
      proto.setItem.__keys[key] = true;
    } catch (_) { /* a browser that will not allow it just syncs on its timer */ }

    /* Another tab on the same device writing the same store. */
    window.addEventListener("storage", function (e) {
      if (e && e.key === key && !suppressed) touch();
    });
  }

  function start() {
    if (!registered) return;
    watchStorage(registered.storageKey);
    schedule();
    var cfg = loadConfig();
    if (cfg) sync();
    else setState({ status: "unconfigured" });
  }

  var api = {
    SCHEMA: SCHEMA, FIELDS: FIELDS, CONFIG_KEY: CONFIG_KEY,
    canonical: canonical, contentHash: contentHash, stable: stable,
    mergeRows: mergeRows, diff: diff, newer: newer, shadowOf: shadowOf,
    massDeleteGuard: massDeleteGuard, bankroll: bankroll,
    decimalOdds: decimalOdds, impliedPnl: impliedPnl, round2: round2,
    loadConfig: loadConfig, saveConfig: saveConfig, deviceName: deviceName,
    register: register, start: start, sync: sync, touch: touch, suppress: suppress,
    onChange: onChange, state: function () { return stateNow; },
    allRows: allRows, settings: settings, setStartingBankroll: setStartingBankroll,
    pullAll: pullAll, pushRows: pushRows, friendlyError: friendlyError
  };
  return api;
});
