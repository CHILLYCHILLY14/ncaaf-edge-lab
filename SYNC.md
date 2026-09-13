# Shared ledger — NCAAF Edge Lab

This board now keeps its bets in step with the other four, through one
Google Sheet. Nothing about how it works has changed: it still keeps its own
copy in this browser, still settles its own bets, and still works with no
signal at all. The sheet is where the copies on your phone and your laptop
meet.

**The full setup guide lives once, in the
[bet-ledger-hq](https://github.com/chillychilly14/bet-ledger-hq) repository:
[SETUP-SYNC.md](https://github.com/chillychilly14/bet-ledger-hq/blob/main/SETUP-SYNC.md).**
Do that once, then come back here.

## Connecting this board

Open the board. There is a **Sync** pill in the bottom corner saying *Sync off*.
Tap it, paste the web app URL and the token from your Apps Script project, name
the device, and tap **Connect**. Any bets already in this browser are pushed up
on the first sync, so connecting late loses nothing.

The URL and token are kept in this browser only. They are not in this
repository and must not be added to it — it is public.

## What was added

New files:

- `site/betsync-ui.js` — the Sync pill and panel.
- `site/betsync.js` — the sync engine — works out what changed here, sends it, takes back what changed elsewhere. Byte-identical in all five boards.
- `site/sync-adapter.js` — the translation between this board's ledger entries and the sheet's flat rows. The only file that differs per board.
- `tests/test_sync.mjs` — proves a bet can leave this board, go through the sheet, and come back as the same object this board's code expects.

Changed files:

- `site/index.html` — three script tags added

## Uploading without the git command line

Same drag-and-drop route as before: open the repository on GitHub, **Add file →
Upload files**, drop the folders in, commit to `main`. GitHub Pages redeploys in
a minute or so. Uploading a folder keeps its path, so `site/betsync.js` lands in
the right place.

> **The `.github` folder.** macOS hides folders whose names start with a dot, so
> it may not appear when you unzip. Press `Cmd+Shift+.` in Finder to show it.
> That folder only adds the new test to the checks GitHub already runs — if it
> is more trouble than it is worth, skip it; nothing else depends on it.

## Running the test

```sh
node tests/test_sync.mjs
```

No network, no browser — it loads this board's real ledger module, the real
betsync.js and the real adapter, and round-trips a bet through them.
