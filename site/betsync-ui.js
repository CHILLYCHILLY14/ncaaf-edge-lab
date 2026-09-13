/*
 * betsync-ui.js — the Sync panel.
 *
 * A pill in the bottom corner that says whether this device is in step, and a
 * sheet behind it holding the one-time connection details and the shared
 * bankroll. It is deliberately self-contained: it injects its own styles, owns
 * its own markup and touches nothing in the board it sits on, so the same file
 * drops into all five without any of them having to make room for it.
 *
 * Colours are taken from whatever the host board defines and fall back to the
 * dark palette they all share, so it looks native on every one.
 */
(function () {
  "use strict";

  if (typeof window === "undefined" || !window.BetSync) return;
  var BS = window.BetSync;

  var CSS = [
    '.bsy-pill{position:fixed;right:max(12px,env(safe-area-inset-right));',
    'bottom:max(12px,env(safe-area-inset-bottom));z-index:9998;display:flex;',
    'align-items:center;gap:7px;padding:9px 13px;border-radius:999px;cursor:pointer;',
    'font:600 12.5px/1 system-ui,-apple-system,"Segoe UI",sans-serif;',
    'background:var(--panel,#131c27);color:var(--ink,#e7edf5);',
    'border:1px solid var(--line,#223042);box-shadow:0 6px 20px rgba(0,0,0,.38);',
    '-webkit-tap-highlight-color:transparent}',
    '.bsy-pill:hover{border-color:var(--accent,var(--gold,#f0b429))}',
    '.bsy-dot{width:8px;height:8px;border-radius:50%;background:var(--dim,#7d8da1);flex:none}',
    '.bsy-dot.ok{background:#2ecc71}.bsy-dot.err{background:#e74c3c}',
    '.bsy-dot.warn{background:var(--accent,var(--gold,#f0b429))}',
    '.bsy-dot.sync{background:var(--accent,var(--gold,#f0b429));animation:bsy-pulse 1s ease-in-out infinite}',
    '@keyframes bsy-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
    '.bsy-scrim{position:fixed;inset:0;z-index:9998;background:rgba(4,8,13,.6);',
    'backdrop-filter:blur(2px)}',
    '.bsy-sheet{position:fixed;z-index:9999;right:max(12px,env(safe-area-inset-right));',
    'bottom:max(12px,env(safe-area-inset-bottom));width:min(400px,calc(100vw - 24px));',
    'max-height:min(78vh,720px);overflow:auto;-webkit-overflow-scrolling:touch;',
    'background:var(--panel,#131c27);color:var(--ink,#e7edf5);border-radius:16px;',
    'border:1px solid var(--line,#223042);box-shadow:0 18px 50px rgba(0,0,0,.55);',
    'font:400 13.5px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;padding:16px}',
    '@media(max-width:560px){.bsy-sheet{left:8px;right:8px;width:auto;max-height:86vh;border-radius:18px}}',
    '.bsy-sheet h3{margin:0 0 2px;font-size:15px;font-weight:680;letter-spacing:-.01em}',
    '.bsy-sheet h4{margin:16px 0 7px;font-size:10.5px;letter-spacing:.09em;',
    'text-transform:uppercase;color:var(--dim,#7d8da1);font-weight:640}',
    '.bsy-x{position:absolute;top:12px;right:14px;background:none;border:0;font-size:19px;',
    'line-height:1;color:var(--dim,#7d8da1);cursor:pointer;padding:4px}',
    '.bsy-note{color:var(--dim,#7d8da1);font-size:12px;margin:2px 0 0}',
    '.bsy-sheet label{display:block;margin:9px 0 0;font-size:11.5px;color:var(--dim,#7d8da1)}',
    '.bsy-sheet input{width:100%;box-sizing:border-box;margin-top:4px;padding:9px 10px;',
    'border-radius:9px;border:1px solid var(--line,#223042);background:var(--bg,#0b1017);',
    'color:var(--ink,#e7edf5);font:400 13px/1.3 ui-monospace,SFMono-Regular,monospace}',
    '.bsy-sheet input:focus{outline:none;border-color:var(--accent,var(--gold,#f0b429))}',
    '.bsy-btn{margin-top:11px;width:100%;padding:10px 12px;border-radius:10px;cursor:pointer;',
    'border:1px solid var(--line,#223042);background:var(--bg,#0b1017);color:var(--ink,#e7edf5);',
    'font:640 13px/1 system-ui,-apple-system,sans-serif}',
    '.bsy-btn:hover{border-color:var(--accent,var(--gold,#f0b429))}',
    '.bsy-btn.primary{background:var(--accent,var(--gold,#f0b429));color:#10151c;border-color:transparent}',
    '.bsy-btn.danger:hover{border-color:#e74c3c;color:#e74c3c}',
    '.bsy-row{display:flex;gap:8px}.bsy-row .bsy-btn{margin-top:11px}',
    '.bsy-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}',
    '.bsy-grid>div{background:var(--bg,#0b1017);border:1px solid var(--line,#223042);',
    'border-radius:10px;padding:8px 10px}',
    '.bsy-grid span{display:block;font-size:10px;letter-spacing:.07em;text-transform:uppercase;',
    'color:var(--dim,#7d8da1)}',
    '.bsy-grid b{display:block;margin-top:3px;font:650 15px/1.2 ui-monospace,SFMono-Regular,monospace;',
    'font-variant-numeric:tabular-nums}',
    '.bsy-pos{color:#2ecc71}.bsy-neg{color:#e74c3c}',
    '.bsy-apps{margin-top:8px;font-size:12px}',
    '.bsy-apps div{display:flex;justify-content:space-between;gap:10px;padding:5px 0;',
    'border-top:1px solid var(--line,#223042)}',
    '.bsy-apps div:first-child{border-top:0}',
    '.bsy-apps em{font-style:normal;color:var(--dim,#7d8da1)}',
    '.bsy-alert{margin-top:11px;padding:10px 11px;border-radius:10px;font-size:12.5px;',
    'border:1px solid rgba(240,180,41,.45);background:rgba(240,180,41,.08)}',
    '.bsy-err{border-color:rgba(231,76,60,.45);background:rgba(231,76,60,.08)}'
  ].join("");

  var sheet = null, scrim = null, pill = null, mounted = false;

  function injectStyles() {
    if (document.getElementById("bsy-styles")) return;
    var el = document.createElement("style");
    el.id = "bsy-styles";
    el.textContent = CSS;
    document.head.appendChild(el);
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c];
    });
  }

  function money(v) {
    var n = Number(v || 0);
    return (n < 0 ? "-$" : "$") + Math.abs(n).toFixed(2);
  }

  function signed(v) {
    var n = Number(v || 0);
    return (n > 0 ? "+" : n < 0 ? "-" : "") + "$" + Math.abs(n).toFixed(2);
  }

  function pct(v) {
    return v == null ? "—" : (v * 100).toFixed(1) + "%";
  }

  function ago(iso) {
    if (!iso) return "never";
    var secs = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (secs < 45) return "just now";
    if (secs < 3600) return Math.round(secs / 60) + "m ago";
    if (secs < 86400) return Math.round(secs / 3600) + "h ago";
    return Math.round(secs / 86400) + "d ago";
  }

  var APP_LABELS = {
    "mlb-edge": "MLB Edge", "ncaaf-lab": "NCAAF Lab", "nfl-lab": "NFL Lab",
    "props": "Props", "ladder": "Ladder"
  };

  function pillText(state) {
    if (state.status === "unconfigured") return "Sync off";
    if (state.status === "syncing") return "Syncing…";
    if (state.status === "error") return "Sync error";
    if (state.status === "blocked") return "Sync paused";
    if (state.status === "ok") return "Synced " + ago(state.lastSync);
    return "Sync";
  }

  function dotClass(state) {
    return state.status === "ok" ? "ok"
      : state.status === "syncing" ? "sync"
      : state.status === "error" ? "err"
      : state.status === "blocked" ? "warn" : "";
  }

  function renderPill(state) {
    if (!pill) return;
    pill.innerHTML = '<i class="bsy-dot ' + dotClass(state) + '"></i>' +
      '<span>' + esc(pillText(state)) + '</span>';
  }

  function renderSheet(state) {
    if (!sheet) return;
    var cfg = BS.loadConfig();
    var bank = state.bankroll;
    var parts = ['<button class="bsy-x" data-bsy="close" aria-label="Close">×</button>'];

    parts.push('<h3>Shared ledger</h3>');
    parts.push('<p class="bsy-note">' + (cfg
      ? 'Connected as <b>' + esc(cfg.device) + '</b> · ' + esc(state.total || 0) +
        ' bets on the sheet · last sync ' + esc(ago(state.lastSync))
      : 'Not connected. Paste the web app URL and token from your Google Sheet.') + '</p>');

    if (state.status === "error" && state.message) {
      parts.push('<div class="bsy-alert bsy-err">' + esc(state.message) + '</div>');
    }
    if (state.pendingMassDelete) {
      parts.push('<div class="bsy-alert"><b>' + esc(state.pendingMassDelete) +
        ' bets</b> went missing from this device. That is almost always a cleared ' +
        'browser rather than a deletion, so they have been put back here and ' +
        'nothing was removed anywhere else. If you did mean to delete them, say so ' +
        'and they go from every device.' +
        '<button class="bsy-btn danger" data-bsy="confirm-deletes">Yes, delete them everywhere</button>' +
        '<button class="bsy-btn" data-bsy="restore">No, keep them</button></div>');
    }

    if (!cfg) {
      parts.push('<label>Web app URL<input data-bsy="url" type="url" spellcheck="false" ' +
        'placeholder="https://script.google.com/macros/s/…/exec"></label>');
      parts.push('<label>Token<input data-bsy="token" type="text" spellcheck="false" ' +
        'autocomplete="off" placeholder="from setup() in the Apps Script log"></label>');
      parts.push('<label>Name this device<input data-bsy="device" type="text" ' +
        'value="' + esc(BS.deviceName()) + '"></label>');
      parts.push('<button class="bsy-btn primary" data-bsy="connect">Connect</button>');
    } else {
      parts.push('<div class="bsy-row">' +
        '<button class="bsy-btn primary" data-bsy="sync">Sync now</button>' +
        '<button class="bsy-btn" data-bsy="disconnect">Disconnect</button></div>');
    }

    if (bank) {
      parts.push('<h4>Bankroll — all five boards</h4>');
      var pnlClass = bank.pnl > 0 ? "bsy-pos" : bank.pnl < 0 ? "bsy-neg" : "";
      parts.push('<div class="bsy-grid">' +
        '<div><span>Current</span><b>' + money(bank.current) + '</b></div>' +
        '<div><span>Available</span><b>' + money(bank.available) + '</b></div>' +
        '<div><span>At risk</span><b>' + money(bank.exposure) + '</b></div>' +
        '<div><span>P/L</span><b class="' + pnlClass + '">' + signed(bank.pnl) + '</b></div>' +
        '<div><span>ROI</span><b class="' + (bank.roi > 0 ? "bsy-pos" : bank.roi < 0 ? "bsy-neg" : "") +
          '">' + pct(bank.roi) + '</b></div>' +
        '<div><span>Record</span><b>' + bank.wins + '–' + bank.losses +
          (bank.pushes ? '–' + bank.pushes : '') + '</b></div>' +
        '</div>');

      if (bank.by_app.length) {
        parts.push('<div class="bsy-apps">' + bank.by_app.map(function (a) {
          var cls = a.pnl > 0 ? "bsy-pos" : a.pnl < 0 ? "bsy-neg" : "";
          return '<div><em>' + esc(APP_LABELS[a.app] || a.app) + '</em><span>' +
            a.bets + ' bets' + (a.pending ? ' · ' + a.pending + ' live' : '') +
            ' <b class="' + cls + '">' + signed(a.pnl) + '</b></span></div>';
        }).join("") + '</div>');
      }

      parts.push('<label>Starting bankroll<input data-bsy="starting" type="number" step="1" ' +
        'inputmode="decimal" value="' + esc(bank.starting) + '"></label>');
      parts.push('<button class="bsy-btn" data-bsy="save-bankroll">Save to the sheet</button>');
      parts.push('<p class="bsy-note" style="margin-top:9px">Every board sizes its stakes off ' +
        'this one number, so a losing weekend on one shrinks the next bet on all of them.</p>');
    }

    sheet.innerHTML = parts.join("");
  }

  function open() {
    if (sheet) return;
    scrim = document.createElement("div");
    scrim.className = "bsy-scrim";
    scrim.addEventListener("click", close);
    sheet = document.createElement("div");
    sheet.className = "bsy-sheet";
    sheet.setAttribute("role", "dialog");
    sheet.setAttribute("aria-label", "Shared ledger sync");
    sheet.addEventListener("click", onSheetClick);
    document.body.appendChild(scrim);
    document.body.appendChild(sheet);
    renderSheet(BS.state());
    BS.sync();
  }

  function close() {
    if (scrim) scrim.remove();
    if (sheet) sheet.remove();
    scrim = sheet = null;
  }

  function field(name) {
    var el = sheet && sheet.querySelector('[data-bsy="' + name + '"]');
    return el ? el.value.trim() : "";
  }

  function onSheetClick(e) {
    var btn = e.target.closest("[data-bsy]");
    if (!btn) return;
    var action = btn.getAttribute("data-bsy");

    if (action === "close") return close();

    if (action === "connect") {
      var url = field("url"), token = field("token");
      if (!/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec/.test(url)) {
        return flash("That does not look like a web app URL. It ends in /exec.");
      }
      if (!token) return flash("Paste the token that setup() printed.");
      BS.saveConfig({ url: url, token: token, device: field("device") });
      BS.sync().then(function (res) {
        renderSheet(BS.state());
        if (!res.ok) flash(BS.state().message || "Could not connect.");
      });
      return;
    }

    if (action === "disconnect") {
      if (!window.confirm("Stop syncing this device? The bets already in this browser stay put.")) return;
      BS.saveConfig(null);
      renderSheet(BS.state());
      return;
    }

    if (action === "sync") return BS.sync().then(function () { renderSheet(BS.state()); });

    if (action === "confirm-deletes") {
      if (!window.confirm("Delete these bets from every device? This cannot be undone.")) return;
      return BS.sync({ confirmDeletes: true }).then(function () { renderSheet(BS.state()); });
    }

    if (action === "restore") {
      /* The bets are already back; this just throws away the deletions that
       * were set aside, so the warning stops asking. */
      return BS.sync({ dropHeld: true }).then(function () { renderSheet(BS.state()); });
    }

    if (action === "save-bankroll") {
      var value = Number(field("starting"));
      if (!isFinite(value) || value < 0) return flash("Enter a number.");
      return BS.setStartingBankroll(value).then(function () { renderSheet(BS.state()); });
    }
  }

  function flash(message) {
    var box = document.createElement("div");
    box.className = "bsy-alert bsy-err";
    box.textContent = message;
    if (sheet) sheet.appendChild(box);
    setTimeout(function () { box.remove(); }, 5000);
  }

  function mount() {
    if (mounted) return;
    mounted = true;
    injectStyles();
    pill = document.createElement("button");
    pill.className = "bsy-pill";
    pill.type = "button";
    pill.setAttribute("aria-label", "Shared ledger sync");
    pill.addEventListener("click", function () { sheet ? close() : open(); });
    document.body.appendChild(pill);

    BS.onChange(function (state) {
      renderPill(state);
      if (sheet) renderSheet(state);
    });
    setInterval(function () { renderPill(BS.state()); }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", mount);
  } else {
    mount();
  }

  window.BetSyncUI = { open: open, close: close, mount: mount };
})();
