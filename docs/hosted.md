# Local mode, hosted spaces, and your own gateway

`npx @celador/weft` talks to one Weft gateway. **It runs locally by default: your code and diffs
stay on your machine.** Hosted team spaces are an option you choose; usage-based pricing for them
is coming. There are three kinds:

| | Where it runs | Who can create a space | Command |
|---|---|---|---|
| **Local** (default) | this machine (`wrangler dev`, port 7878) | you | `npx @celador/weft` |
| **Hosted** (opt-in) | Weft's Cloudflare account, `https://weft-hosted.elier.ai` | anyone, no login | `npx @celador/weft --hosted` or `npx @celador/weft use hosted` |
| **Your own** | your Cloudflare account | you (the admin key the CLI keeps) | `npx @celador/weft deploy` |

All three run the same gateway code (`apps/gateway`): a Worker, one `RepoCoordinator` Durable
Object per repo (the ordered log) and one `Registry` Durable Object (repos and keys).

## Hosted spaces

Hosted is opt-in: nothing is sent to it unless you pass `--hosted` or run `use hosted`. If you
already had a hosted space (in `~/.config/weft/cli.json` or a repo's `.weft/space-token`),
`npx @celador/weft` keeps using it and prints one line: "Using your hosted space. Local is now the
default for new projects: npx @celador/weft use local".

The hosted gateway is a separate Worker, `weft-hosted` (`[env.hosted]` in
`apps/gateway/wrangler.toml`), with its own Durable Objects. It shares no storage with any team
gateway. Usage-based pricing for hosted team spaces is coming; there is nothing to pay yet.

**No account.** `POST /v1/spaces` (no auth) creates a space and returns its *owner key*. That key
is the only credential: there is no login and no third-party identity. The CLI keeps it in
`~/.config/weft/cli.json` (mode 600) and in each checkout's `.weft/space-token` (git-ignored), so
running the CLI again in the same repo, even on a machine that lost `~/.config/weft`, finds the
same space.

**The space API** (owner key as `Authorization: Bearer`):

| Route | |
|---|---|
| `GET /v1/space` | the space, its repos, its key count, its limits |
| `POST /v1/space/repos {"name"}` | repo `<space>-<name>`; idempotent |
| `POST /v1/space/tokens {"kind": "agent", "repo", "agent"}` | an agent key (scopes agent + observe) bound to one repo and one agent id |
| `POST /v1/space/tokens {"kind": "system", "repo"}` | a lander key (system + observe) for one repo |
| `POST /v1/space/tokens {"kind": "viewer"}` | a read-only key for every repo of the space, current and future (the feed link) |
| `DELETE /v1/space/tokens/{id}` | revoke one of the space's keys |
| `DELETE /v1/space` | delete the space: every key, the owner key included, stops working at once |

**The feed.** `GET /feed` is a static page; the viewer key travels in the URL fragment
(`/feed#t=…`), which browsers never send to a server or put in a `Referer`. The page uses it as a
bearer token for `/v1/repos` and `/v1/feed` on the same origin. It is private in the sense that
matters: only someone holding the link can read the space.

### Tenant isolation

The space key is the boundary. Enforced in `apps/gateway/src/registry.ts` and tested in
`apps/gateway/test/spaces.test.ts`:

- an owner key has no WCP scopes; it can only manage its own space;
- every key a space mints is bound to that space's repos: agent and lander keys to exactly one
  repo, viewer keys to the space's repo list as it is when the key is checked (so they never see
  another space's repo, or an operator repo);
- a repo outside a key's list answers `404 repo_not_found` (its existence is not leaked);
- a space cannot mint keys for, revoke keys of, or name a repo in another space;
- deleting or suspending a space revokes all its keys; cached grants for space keys expire within
  5 seconds.

The public read-only demo at `demo.weft.mx` is unchanged: it is a different Worker
(`weft-web-public`) in front of a different gateway, with its own repo allow-list, and fails closed.

### Limits

Set as vars in `[env.hosted.vars]`; the per-minute ones also use Workers Rate Limiting bindings.

| Limit | Default |
|---|---|
| new spaces per network per day (counted under a daily-rotating HMAC of the IP, deleted after 48 h; nothing IP-derived is stored on the space) | 20 |
| new spaces per minute per network | 5 (`WEFT_SIGNUP_RATE`) |
| new spaces per day, whole gateway | 2,000 |
| active spaces, whole gateway | 20,000 |
| repos per space | 20 |
| active keys per space | 200 |
| requests per minute per space | 600 (`WEFT_RATE`) |
| request body | 2 MB |

Over a limit, the gateway answers `429 rate_limited` with a message; the adapters fail open, so
an agent keeps working (uncoordinated) and is told so.

### Operator controls (kill switch)

With the hosted admin key (macOS keychain item `weft-hosted-admin` on John's machine, or the
older `~/.config/weft/hosted-admin-token`; `wrangler secret put WEFT_ADMIN_TOKEN --env hosted`):

```sh
U=https://weft-hosted.elier.ai; AD="authorization: Bearer $(security find-generic-password -s weft-hosted-admin -w 2>/dev/null || cat ~/.config/weft/hosted-admin-token)"
curl -s -H "$AD" $U/v1/admin/stats                       # first runs per day, totals, retention (below)
curl -s -H "$AD" $U/v1/admin/spaces                      # every space: status, repos, keys
curl -sX POST -H "$AD" $U/v1/admin/spaces/<id>/suspend   # ban one space (all its keys revoked)
curl -sX POST -H "$AD" $U/v1/admin/spaces/<id>/tag -d '{"internal":true}'   # our own test/demo space: out of the headline numbers
curl -sX POST -H "$AD" $U/v1/admin/hosted -d '{"mode":"no-signups"}'  # stop new spaces; existing ones keep working
curl -sX POST -H "$AD" $U/v1/admin/hosted -d '{"mode":"off"}'         # refuse every space key, at once
curl -sX POST -H "$AD" $U/v1/admin/hosted -d '{"mode":"open"}'        # back to normal
```

`node site/hosted-admin.mjs spaces` and `node site/hosted-admin.mjs tag <id>... [--off]` do the
per-space listing and tagging without the key touching a shell history.

### Retention metrics (counts only)

Whether anyone keeps using Weft, without storing anything about the user. For each space the
Registry keeps `last_event_at` and a count of events per UTC day (an event = one accepted
`POST .../sessions/<id>/events` from one of the space's agent tokens); day rows older than 90 days
are deleted, and a deleted space's rows go with it. No IP, no repo names, no paths, no content.

`GET /v1/admin/stats` adds `retention`:

| field | meaning |
|---|---|
| `active_7d`, `active_30d` | spaces with at least one event in the last 7 / 30 UTC days (today included) |
| `retained` | spaces with events on 2 or more distinct days (within the 90 kept), at least one in the last 7 days |
| `events_per_day` | all events per UTC day, last 30 days |
| `internal_spaces` | spaces tagged internal |
| `spaces` | per space: `id`, `label`, `status`, `created`, `last_event_at`, `active_days_30`, `internal` (500 at most, most recently active first; `spaces_total` is the full count) |

Spaces tagged `internal` (`POST /v1/admin/spaces/<id>/tag {"internal": true}`) are left out of every
headline number, including `spaces.total` and the first-runs `days`, and stay in the per-space list
with `internal: true`. `node site/funnel.mjs` prints the same retention lines after "first runs".

The hard stop, without the Registry: set `WEFT_HOSTED_OFF = "1"` in `[env.hosted.vars]` and run
`pnpm --filter @weft/gateway deploy:hosted`. Every space request then gets `503 unavailable`.

`GET /v1/admin/stats` is the last step of the launch funnel (views → site visits → command
copies → first runs): one new space = one first run of `npx @celador/weft`.

### Deploying the hosted gateway

```sh
unset CLOUDFLARE_API_TOKEN
cd apps/gateway && pnpm deploy:hosted        # wrangler deploy --env hosted
```

## Local mode (the default)

`npx @celador/weft` installs wrangler once into `~/.config/weft/tools`, writes the bundled
gateway Worker to `~/.config/weft/local/worker/` and starts `wrangler dev` there in the background
(`127.0.0.1:7878`, or the next free port). Its state is in `~/.config/weft/local/state`; nothing
leaves the machine. Stop it with `npx @celador/weft local stop`; the next run starts it
again with the same state. `--local` is still accepted and means the same as no flag.
`npx @celador/weft use local` switches a machine that used hosted back.

## Your own Cloudflare account

```sh
npx @celador/weft deploy                               # Worker weft-gateway on <account>.workers.dev
npx @celador/weft deploy --name weft --domain weft.example.com   # on a hostname in one of your zones
```

It logs in with `wrangler login` (browser OAuth) unless wrangler is already logged in or
`CLOUDFLARE_API_TOKEN` is set, deploys the gateway Worker with its two Durable Objects (SQLite
storage, which the Workers Free plan includes), sets a random `WEFT_ADMIN_TOKEN` secret (kept in
`~/.config/weft/cli.json`), waits until it answers, and makes it your default gateway. Signups are
closed on it (`WEFT_SIGNUPS = "admin"`): only the CLI holding the admin key creates spaces.
`npx @celador/weft use local` switches back to this machine.

This is the coordinator and registry only. Weft's full hosted stack (Artifacts forks, merge queue,
evidence, workflows) needs more resources; see [runbook.md](runbook.md).
