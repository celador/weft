# Changelog

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
