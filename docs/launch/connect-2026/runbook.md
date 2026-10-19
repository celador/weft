# Connect 2026 runbook (Wed Oct 21, 1:35-2:20 PM PT, San Francisco)

## Before the talk (hotel wifi, morning of Oct 21)

1. `cd ~/github/weft && git pull && scripts/connect-preflight.sh`
   Every line must be green; it ends with "All green." and exit code 0. About 20 seconds.
   `--quick` skips the two-agent write test if you only want read checks.
2. Download the fallbacks to the laptop (see offline-demo.md):
   `curl -o ~/Desktop/weft-connect-backup.mp4 https://weft-media.elier.ai/connect-2026-backup.mp4`
3. Open in browser tabs: https://weft-site.elier.ai and https://weft.elier.ai/#/r/weft/live

## What the demo depends on (all Cloudflare, nothing on cal or this laptop)

Plain words: a Worker is a small web service Cloudflare runs for us. A Durable Object is a tiny
database with one owner process per repo, so every edit to a repo passes through one place in
order. Artifacts is Cloudflare's Git storage; "trunk" is the main branch kept there. A Queue is a
job queue; Workflows are multi-step background jobs.

| Piece | Hostname / name | What it does in the demo |
|---|---|---|
| Worker `weft-site` | weft-site.elier.ai | marketing page (static files) |
| Worker `weft-web-public` | weft.elier.ai | public, read-only live UI; calls the gateway over a Cloudflare service binding |
| Worker `weft-gateway-preview` + Durable Objects + D1 | weft-gateway-preview.elier.ai | the coordinator: one ordered log per repo, warnings, blocks, landings |
| Workers `weft-workflows-preview`, `weft-sandbox-preview`, `weft-previews-preview` | *-preview.elier.ai | best-of-N runs, sandboxes, preview pages (not needed for the core demo) |
| R2 bucket `weft-media` | weft-media.elier.ai | demo videos, backup recording, podcast |
| GitHub | github.com/celador/weft | public source |

No Cloudflare Tunnel, no cron trigger on any weft Worker, and no DNS record points at `cal` or the
MacBook (checked 2026-10-19 via the Cloudflare API: Workers custom domains, tunnels, schedules).
The only thing the laptop adds is new rows: when a Hermes agent edits a weft checkout, the row
appears on weft.elier.ai within a second. If the laptop is closed, the site still shows the full
history.

## Scheduled wind-down

Hermes cron job `7a4e970ec8e7` "Weft post-competition wind-down", runs once at
2026-10-22 10:00 -03 = 2026-10-22 13:00 UTC = Oct 22 06:00 PT, 6 hours after the talk day ends
(Oct 22 06:59 UTC = Oct 21 23:59 PT). It deletes the sandbox/workflows/previews Workers and their
queues, and keeps weft.elier.ai, the gateway, D1, trunks, weft-media and the Hermes plugin. It
skips everything if `~/github/weft/KEEP_LIVE` exists. The preflight re-checks this timing.

## If something is red on stage

- Live UI or gateway red: play the backup video (connect-2026-backup.mp4, about 2.5 minutes, no
  audio; talk over it) or click through `demo/video/connect-2026/stills/`.
- Only the supporting Workers red: carry on; the core demo does not use them.
- Re-record the backup (about 2.5 minutes, needs one agent edit in a weft checkout during beat 3):
  `node demo/video/rig/connect-backup.mjs && vhs demo/video/connect-2026/connect-term.tape && demo/video/connect-2026/build.sh`
