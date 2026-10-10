# Weft web UI (apps/web)

The human surface of Weft in a browser: what the agents are doing, live, and the
editor-free controls (approve, undo). Built for the demo video as much as for daily use:
dark-first, large type, every squiggle traceable to the record that caused it.

Preview: https://weft-web-preview.elier.ai (operator-key login, see
below). Production `weft-web` is not deployed yet (PM decision).

## Views

| Route | What |
|---|---|
| `#/r/<repo>/live` | Change log (newest first) streamed over the repo DO's WebSocket. Every record shows agent, kind, the one-line summary, the symbols it wrote (`sig`/`body`/`new`/`del`), and its diagnostics as squiggle cards: the symbol gets a wavy underline in the severity color, with the message, the arbitration outcome and a link to the causing record (hovering a row outlines the cause). New records slide in and glow; a squiggle flashes the Squiggles panel. Right column: the squiggle feed (newest diagnostics, big) and agents with presence (join/leave), harness and capability level. Filter box, "Squiggles only", and **Replay**: re-animates the whole stored log at 1/4/16/64× for recordings. Click a row for the full record (intent, diagnostics, reads/writes, colored diff). |
| `#/r/<repo>/board` | Tasks in columns Queued / Working / Squiggled / Review / Landed / Reverted, with candidate count, agents, squiggle and blocked counts, approval badge. Tasks come from the gateway's D1 index (`GET /v1/repos/{repo}/tasks`, tasks created with candidates) merged with tasks seen in the log. |
| `#/r/<repo>/task/<id>` | Candidates side by side: agent + harness, Change-Id, status, diff stats (+/−, files, edits — from the log's diffs), squiggles, cost, screenshots, tests/preview/review evidence (D1 `evidence`, written by ProcessRevision), revisions (pushes), touched files, and **Approve**. |
| `#/r/<repo>/ops` | Operation log: every `land` and `revert` with state `live` → `undo requested` → `reverted`, and **Undo** (asks for a reason). |

Board column rules (pure function `deriveBoard` in `public/lib/model.js`): a live land →
Landed; lands all reverted → Reverted; no log activity → Queued; the latest edit of some
change rejected/with an error → Squiggled; no activity for 20 minutes → Review; else Working.

## Architecture

```
browser ──(Access JWT or session cookie)──▶ weft-web Worker ──service binding──▶ weft-gateway ──▶ RepoCoordinator DO
            static app (ASSETS)                 /api/* allow-list               (WEFT_WEB_TOKEN: observe+human)
            WS /api/repos/{r}/stream ─────────── proxied upgrade ─────────────▶ /v1/repos/{r}/stream
```

- The browser never sees a WCP token. The Worker holds `WEFT_WEB_TOKEN` (scopes
  `observe`+`human`, repos `*`, principal `john`) and calls the gateway over a service
  binding. Human actions are attributed to that principal (spec §3); the Worker appends
  `(via web by <email>)` to the note/reason so the log shows who clicked.
- `/api/*` is an allow-list: repos, events (paged + by seq), tasks, candidates, changes,
  actions (`approve|undo|pause|resume|message` only), stream. Admin, system and agent
  endpoints are unreachable from the browser.
- Actions are CSRF-guarded: same-origin `Origin` header, JSON body, `SameSite=Strict` cookie.
- CSP `default-src 'self'` (no inline script/style, no third-party origins), `frame-ancestors 'none'`.
- The client is dependency-free ES modules (`public/app.js`, `public/lib/*.js`, `// @ts-check`,
  typechecked by `tsconfig.client.json`). All agent-provided text is set via `textContent`.
- **Approve → BestOfN.** Approve appends the WCP `control approve` record (the landing
  workflow's documented signal, spec §9.6). When the Worker has a `BESTOFN` Workflows
  binding it additionally calls `instance.sendEvent({type:"approve", payload:{repo, task,
  change, seq, by}})` on instance id `bestofn-<repo>-<task>` (`bestOfNInstanceId()`), so a
  BestOfN instance blocked in `step.waitForEvent("approve")` resumes immediately. The
  binding is commented out in `wrangler.toml` until apps/workflows deploys BestOfN.

## Auth

Three modes, decided in `src/auth.ts`:

1. **Cloudflare Access (production).** Set `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD`. The Worker
   verifies the `Cf-Access-Jwt-Assertion` header (or `CF_Authorization` cookie) itself:
   RS256 against `https://<team>/cdn-cgi/access/certs` (cached, refetched on unknown `kid`),
   `aud`, `iss`, `exp`/`nbf`. Requests that bypass Access (e.g. the workers.dev URL with
   Access only on a custom domain) get 401. Optional `WEFT_ALLOWED_EMAILS` allow-list.
2. **Operator key (fallback, current preview).** `WEFT_WEB_KEY` secret; `/login` sets an
   HMAC-signed `HttpOnly; Secure; SameSite=Strict` session cookie (12 h).
3. **Neither configured → 503** (fail closed). `WEFT_WEB_DEV=1` disables auth for local
   `wrangler dev` only.

### Set up Cloudflare Access (John, ~5 minutes, dashboard)

Wrangler's OAuth token has no Access scopes (it can list but not create Access apps; the
Zero Trust organization endpoint returns an auth error), so this is a dashboard step:

1. Zero Trust dashboard → if prompted, create the team (free plan, team name e.g. `elier`
   → team domain `elier.cloudflareaccess.com`). Settings → Authentication: keep One-time PIN
   (email) or add GitHub/Google.
2. Easiest: Workers & Pages → `weft-web` (or `weft-web-preview`) → Settings → Domains &
   Routes → workers.dev → **Enable Cloudflare Access**. Or: Access → Applications → Add →
   Self-hosted → domain `weft-web.elier.ai` (and/or a custom domain).
3. Policy: Allow → Include → Emails → `john@elier.ai` (add Kathryn or a service token if
   wanted). Session duration 24 h.
4. Copy the application's **AUD tag** (Application → Overview).
5. Put both values in `apps/web/wrangler.toml` (`[vars]` for prod, `[env.preview.vars]` for
   preview) and deploy:
   ```
   ACCESS_TEAM_DOMAIN = "elier.cloudflareaccess.com"
   ACCESS_AUD = "<aud tag>"
   WEFT_ALLOWED_EMAILS = "john@elier.ai"
   ```
6. Optionally remove the fallback: `wrangler secret delete WEFT_WEB_KEY [--env preview]`.
   With Access configured and the key still set, a request with no Access JWT can still use
   the operator-key login; with the key deleted, Access is the only way in.

## Public read-only demo (weft.elier.ai)

Privacy containment: the public feed is disabled (`WEFT_PUBLIC_DEMO = "0"`) and its
observe token is revoked. Do not re-enable it or mint a replacement token without
John's explicit approval after a data-isolation audit. Never publish live personal
or customer development logs; use separately isolated, reviewed demo data only.
Missing or empty `WEFT_PUBLIC_REPOS` now exposes no repositories (fail closed).
The authenticated operator UI remains available at weft-web-preview.elier.ai.

The following describes the previous demo configuration, not the current deployment:

Wrangler env `public` deploys the same Worker as `weft-web-public` at
[https://weft.elier.ai](https://weft.elier.ai) with `WEFT_PUBLIC_DEMO = "1"`:

- No login: `authenticate()` returns `{email:"guest", via:"public"}`; `/login` redirects to `/`.
- API: GET routes and the WebSocket stream only. Every other method (actions, policy evaluate,
  `/logout`) returns `403 {"error":{"code":"read_only"}}` before reaching the gateway.
  `/api/me` reports `readOnly: true`; the SPA then hides Approve/Undo, disables policy
  evaluation and shows a "Public read-only demo of Weft" strip.
- Gateway token: `WEFT_PUBLIC_TOKEN` only (scopes `["observe"]`, no human/system), never
  `WEFT_WEB_TOKEN`; the env has no web/email/operator secrets at all. The email handler rejects.
- Repos: `WEFT_PUBLIC_REPOS` (var) is enforced by the Worker on top of the token's own repo list:
  `weft` (dogfood), `weft-demo` (M2 runs + video), `demo-b11-20261004-144005-r6`,
  `demo-m1-20261004-064201-r1` (the runs shown in the video). Other repos 404.
- Scrubbing (`src/scrub.ts`): old diffs in the append-only log still name the account's
  workers.dev hosts, so every relayed body and every stream frame (the stream is proxied frame by
  frame in public mode) maps `<worker>.<sub>.workers.dev` to `<worker>.elier.ai`, redacts any
  other workers.dev host or truncated hostname, and replaces the literal terms in the secret
  `WEFT_REDACT` (comma-separated).
- No Cloudflare Access application covers `weft.elier.ai` (it must answer 200, not a 302).

```bash
cd apps/web; export PATH=/opt/homebrew/opt/node@24/bin:$PATH; unset CLOUDFLARE_API_TOKEN
# token: POST /v1/admin/tokens {"principal":"weft-public-demo","scopes":["observe"],
#   "repos":[<WEFT_PUBLIC_REPOS>],"label":"weft-web-public (weft.elier.ai)"}
#   stored at ~/.config/weft/web-public-token.json (mode 600), piped (never echoed) into:
pnpm exec wrangler secret put WEFT_PUBLIC_TOKEN --env public
pnpm exec wrangler secret put WEFT_REDACT --env public
pnpm deploy:public
```

To add a repo: inspect its events for secrets/customer data, re-mint the token with the new repo
list, update `WEFT_PUBLIC_REPOS`, redeploy.

## Deploy / operate

```
export PATH=/opt/homebrew/opt/node@24/bin:$PATH; unset CLOUDFLARE_API_TOKEN
cd apps/web
pnpm exec wrangler deploy --env preview            # weft-web-preview → weft-gateway-preview
# one-time secrets (never echo them):
#   token: POST /v1/admin/tokens {"principal":"john","scopes":["observe","human"],"repos":"*","label":"weft-web-preview"}
#   stored at ~/.config/weft/web-preview-token.json (mode 600), piped into:
pnpm exec wrangler secret put WEFT_WEB_TOKEN --env preview
pnpm exec wrangler secret put WEFT_WEB_KEY --env preview   # ~/.config/weft/web-preview-key (mode 600)
```

Production: same with no `--env` (Worker `weft-web`, service binding `weft-gateway`) once
the PM deploys the production gateway; issue a separate prod token.

Local: `pnpm exec wrangler dev --env-file <file>` with `WEFT_WEB_DEV=1`,
`GATEWAY_URL=https://weft-gateway-preview…` and `WEFT_WEB_TOKEN=…` in a file outside the repo.

Demo traffic: `node apps/web/scripts/demo-feed.mjs [--repo weft-ui-x] [--pace 1500]` plays
three competing candidates for one task (signature change → `stale_assumption` squiggle on
the stale caller, `claim_wait`/wound arbitration, overload negotiation, reroute) plus a
second task, then lands two changes — real coordinator verdicts, streamed live into the UI.
