# Offline demo at Connect 2026: ruled out, use the recording

Decision (2026-10-19): there is no offline (localhost) live demo for Wed Oct 21. If the venue
network fails, play the backup recording or click through the stills.

Why:

- The local coordinator (`pnpm dev:local`, from PR #1) and the unlanded branch `wt/local`
  (card t_e5801824, `weft serve`) both contain code from an outside contributor. John's standing
  rule for this Mac: outside-contributor code is never built, tested or run here without his
  explicit yes after a static security review. `wt/local` has been on hold since Oct 13 for that
  reason (docs/pm-log.md). Running either one to rehearse an offline demo would break that rule.
- Landing `wt/local` two days before the talk would also mean running the full gate on code
  nobody has reviewed. Not worth the risk for a fallback.

What to use instead (none of it needs the network):

1. Backup video, downloaded to the laptop before the talk:
   `curl -o ~/Desktop/weft-connect-backup.mp4 https://weft-media.elier.ai/connect-2026-backup.mp4`
   (local copy at `demo/video/connect-2026-backup.mp4` on this Mac, git-ignored; rebuild with `demo/video/connect-2026/build.sh`).
2. Stills, one per beat, in `demo/video/connect-2026/stills/` (in git). Open the folder in
   Preview and use the arrow keys. Captions per beat are in `demo/video/connect-2026/beats.json`.
3. The 3-minute and 7-minute submission videos, also worth downloading:
   https://weft-media.elier.ai/weft-demo-short.mp4 and https://weft-media.elier.ai/weft-demo.mp4

If John approves the outside-contributor code before Wednesday, an offline path becomes possible:
`pnpm install && pnpm dev:local` then `node scripts/local-quickstart.mjs --demo` (docs/try-it.md).
It has not been rehearsed on this Mac.
