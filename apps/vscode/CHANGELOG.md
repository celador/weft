# Changelog

## 0.1.2

- The panel shows only the repos this workspace maps to (from `.weft/` or the folder name) and
  streams only those; every repo the token sees is shown only when the workspace maps to none.
  A token with access to 100 repos no longer fills the panel with repo lines.
- The repo strip hides idle repos (no agents, no changes, no record in 24 h) and is capped at
  two lines; the Changes list keeps its height and scrolls in a short bottom panel.

## 0.1.1

- First Marketplace and Open VSX release (`celador.weft`).
- Install section and screenshots in the README; homepage is weft.mx.
- Verified: a fresh install in a clean VS Code 1.143 and Cursor 3.27 profile connects to a space
  made by `npx @celador/weft` with no settings (`test/install/run.mjs`).

## 0.1.0

- Feed webview in the panel (`@weft/feed/view`): Changes feed across repos, Editing now,
  detail pane with diff, squiggles and actions.
- `weft-event:` documents and the native diff editor for any event.
- Open Weft squiggles as diagnostics on this checkout's files, with the cause as related
  information and an “Open causing event” quick fix.
- Approve, Undo, Pause, Resume and Message (human-scope token), with a clear message when the
  token can only read.
- Token lookup: `WEFT_TOKEN`, `.weft/`, `~/.config/weft`, then secret storage (“Weft: Set token”).
- Status bar: repo, agents editing, open squiggles.
