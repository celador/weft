# Try Weft locally

This guide takes a fresh clone to two coordinated agents on your machine, without a Cloudflare
account: install, run the tests, start a local gateway, and watch Weft deny a conflicting edit.
It takes about five minutes. The optional last section deploys to your own Cloudflare account.
To wire Weft into an agent setup you already run, read [integrate.md](integrate.md) next.

## Requirements

- macOS or Linux with Git, `curl` and `openssl` (preinstalled on macOS)
- Node.js 22 or newer (CI uses Node 24): `node --version`
- pnpm 9: `pnpm --version`. If it is missing: `npm install -g pnpm@9`
  (or, on Node 22/24, `corepack enable && corepack prepare pnpm@9.15.0 --activate`;
  Node 25 no longer ships Corepack)
- Optional: [Claude Code](https://docs.claude.com/en/docs/claude-code) (`claude`) to see a real
  agent get blocked, and `jq` to read the event log

No Docker, Cloudflare login, API token or model key is needed before section 5.

## 1. Clone and install

```sh
git clone https://github.com/celador/weft.git
cd weft
pnpm install --frozen-lockfile
```

## 2. Run the tests

```sh
pnpm --filter @weft/protocol test       # WCP schema + reference coordinator conformance, seconds
pnpm -r typecheck && pnpm -r test       # the whole repository gate, about 1-2 minutes
```

The tests use local doubles for Workers, Durable Objects and containers; they need no Docker,
secrets or network services.

## 3. Start the local gateway

The gateway's `test` environment runs the coordinator and registry only, entirely on your
machine. It needs an admin token, which Wrangler reads from a gitignored file when it starts:

```sh
cd apps/gateway
echo "WEFT_ADMIN_TOKEN=$(openssl rand -hex 16)" > .dev.vars.test
pnpm dev:local                    # serves http://localhost:8787; leave it running
```

From a second terminal, `curl -s http://localhost:8787/v1/health` should print
`{"type":"health","service":"weft-gateway",...,"ok":true}`.

- **Port 8787 already in use?** Wrangler stops with
  `bind(): Address already in use (os error 48)`. Use another port and pass the same URL to every
  command below: `pnpm dev:local --port 8797`, then `--url http://localhost:8797`.
  (`lsof -iTCP:8787 -sTCP:LISTEN` shows what holds 8787.)
- Wrangler warns that `env.test` does not inherit `vars`, `workflows`, `queues` and `artifacts`.
  That is intended: the local gateway runs without them (see Known limitations).
- Changed `.dev.vars.test`? Restart `pnpm dev:local`; Wrangler reads it only at start.
- `pnpm --filter @weft/gateway dev` (without `:local`) is the full configuration with remote
  Cloudflare bindings; it needs a Cloudflare login and is not used here.

## 4. Two agents, one collision

### 4a. One command: sample repo, tokens, adapters, both collisions

From the repository root, in the second terminal:

```sh
node scripts/local-quickstart.mjs --demo        # add --url http://localhost:8797 if you changed the port
```

It creates a tiny TypeScript repo (`shop`, in a temp dir; `--dir DIR` to choose) with two git
worktrees, `shop-agent-a` and `shop-agent-b`, registers a Weft repo for it, mints one agent token
per worktree plus a system token, installs the Claude Code adapter in both worktrees, and plays
Claude Code `Edit` calls through the adapter's real `hook` command (the JSON Claude Code sends on
stdin; no model involved):

```
1) stale_assumption: agent-b starts, agent-a changes calcTotal's signature, agent-b calls the old one
   agent-a edit src/pricing.ts: allowed
   agent-b edit src/cart.ts: DENIED
    [weft error] stale_assumption src/cart.ts:4:42: You use src/pricing.ts#calcTotal, whose signature changed in #3 by agent-a after your base #1. ...
    -export function calcTotal(items: Item[]): number {
    +export function calcTotal(items: Item[], opts: PriceOptions): number {

2) stale_overwrite: agent-a's change is merged and landed; agent-b edits calcTotal from its old base
   land #5 posted for I67833381c1a… (accepted)
   agent-b edit src/pricing.ts: DENIED
    [weft error] stale_overwrite src/pricing.ts:3:17: src/pricing.ts#calcTotal changed on trunk (#5, land by agent-a) after your base #4; ...

result:
  ok   agent-b's stale call is denied with stale_assumption
  ok   agent-b's overwrite of landed code is denied with stale_overwrite
```

The worktrees stay installed, so you can continue with real agents in them. To watch a model get
blocked, set up a fresh pair (4b, or the sample repo again with `--demo`), have agent-a change a
signature (ask `claude` in agent-a's worktree), then ask agent-b's Claude to use it:

```sh
cd <dir>/shop-agent-b
claude -p "In src/cart.ts, also show the cart total computed with calcTotal(items) from ./pricing." \
  --permission-mode acceptEdits
```

Claude's first edit is denied with the `stale_assumption` diagnostic and agent-a's diff. Usually
it adapts the call (for example `calcTotal(items, { taxRate: 0 })`) and that edit is accepted.
Sometimes it negotiates instead (`.weft/bin/weft negotiate propose overload ...` to agent-a); with
nobody running as agent-a the proposal is never answered, and the stop gate keeps Claude working
while the error is open, so give it enough turns (`--max-turns 20`) to fall back to adapting.

### 4b. Your own repository

Give the script one checkout per agent, either separate clones or `git worktree add` (two agents
in one directory would share files and adapter state):

```sh
git -C ~/code/myapp worktree add ../myapp-b -b agent-b
node scripts/local-quickstart.mjs ~/code/myapp ~/code/myapp-b      # [--repo NAME] [--agents a,b] [--url URL]
```

It prints what it did and the next steps. Agent tokens go to `<checkout>/.weft/token` (mode 0600;
`.weft/` is added to `.git/info/exclude`), the system token to
`apps/gateway/.wrangler/weft-local/<repo>.system-token`; no token is printed. Then start `claude`
in each checkout. **Claude Code reads hooks when a session starts**: restart any session that was
already open.

While it runs:

```sh
cd <checkout> && .weft/bin/weft status              # this agent's session, base and open errors
tail -f <checkout>/.weft/log/adapter.log            # every check/commit and its verdict
curl -s -H "authorization: Bearer $(cat apps/gateway/.wrangler/weft-local/<repo>.system-token)" \
  http://localhost:8787/v1/repos/<repo>/events | jq -c '.events[] | [.seq, .status, .kind, .agent, .summary]'
```

### Claiming symbols before you start

An agent (or you, in its checkout) can claim the symbols it is about to change, so other agents
are told before they collide:

```sh
cd <checkout>
.weft/bin/weft claim --keys src/auth/session.ts#SessionStore.get,src/api/client.ts#fetchWithAuth
.weft/bin/weft claim --keys src/auth/session.ts#refreshToken --firm --ttl 300000
```

- Keys are `path#symbol` exactly as they appear in Weft diagnostics: a repo-relative POSIX path
  (no leading `/`, no `.` or `..` segments, no spaces), `#`, then a dotted declaration name
  (`SessionStore.get`) or `*` for the whole file. Anything else is refused before it is sent.
- A plain claim is a **lease** (2 minutes by default): it stays while the agent keeps working
  (every edit and the adapter's 30 s heartbeat renew it) and is released within 2 minutes after
  the agent dies, or at once when its session ends.
- `--firm` makes others' overlapping edits fail instead of warn. A firm claim has a hard limit
  counted from the claim: `--ttl MS` (firm claims only), at most the repo's firm limit (10 minutes
  by default; the CLI refuses more). Heartbeats do not extend it; run `weft claim` again to extend
  it, which shows up in the log.

Repos created before claim leases existed keep the old 30-minute claim TTL until the operator
switches them over (this is recorded in the repo's journal, so its history replays unchanged):

```sh
curl -sX POST $U/v1/admin/repos/<repo>/policy -H "$AD" \
  -d '{"claims":{"lease_ms":120000,"firm_max_ms":600000}}'
```

### 4c. Landing

`stale_overwrite` protects *landed* (merged) code. The local gateway has no merge queue, so after
you merge an agent's branch, tell Weft:

```sh
node scripts/local-quickstart.mjs land --repo <repo> --change <Change-Id> --sha <merged sha>
```

The Change-Id is `change` in that agent's `<checkout>/.weft/claude.json` (it is also the
`Change-Id:` trailer the adapter adds to the agent's commits). The coordinator learns a change
when its agent's first session starts, so landing a change whose agent never ran fails with
`422 invalid_reference: unknown change`. See
[integrate.md](integrate.md#land-events) for what a land does.

### 4d. The same steps by hand

What the script does, if you want to script it differently. `U` is the gateway URL; each token
response contains the secret once, in its `token` field.

```sh
U=http://localhost:8787; AD="authorization: Bearer $(cut -d= -f2 apps/gateway/.dev.vars.test)"
curl -sX POST $U/v1/admin/repos  -H "$AD" -d '{"repo":"my-repo"}'
curl -sX POST $U/v1/admin/tokens -H "$AD" \
  -d '{"principal":"agent-a","scopes":["agent","observe"],"repos":["my-repo"],"agent":"agent-a"}'
curl -sX POST $U/v1/admin/tokens -H "$AD" \
  -d '{"principal":"lander","scopes":["system","observe"],"repos":["my-repo"]}'

pnpm --filter @weft/adapter-claude-code build      # once: packages/adapters/claude-code/dist/weft-claude.mjs
cd /path/to/agent-a-checkout
WEFT_TOKEN=<agent-a token> node /abs/path/to/weft/packages/adapters/claude-code/dist/weft-claude.mjs install \
  --url $U --repo my-repo --agent agent-a --task T-1 --title "What agent-a is doing"

# land, with the system token; base_seq = head_seq of GET $U/v1/repos/my-repo/events?limit=1
curl -sX POST $U/v1/repos/my-repo/system/events -H "authorization: Bearer <system token>" \
  -d '{"kind":"land","base_seq":<head_seq>,"change":"<Change-Id>","payload":{"sha":"<40-hex sha>","op_id":"land-1"}}'
```

The bundle path must be absolute (the agent's checkout does not contain it). The agent token
needs `observe` so the adapter can quote the other agent's diff; the system token needs `observe`
to read `head_seq`. Use one token, `--agent` and `--task` per checkout. Agents in different
repositories need different `--repo` values: coordination is per repository.

## Known limitations

Found while walking this guide on a clean Mac without a Cloudflare account.

- **No automatic landing locally.** `dev:local` has no Artifacts, Queues, Workflows or sandboxes:
  no candidate forks, test runs, evidence or merge queue. You post `land` events yourself (4c);
  the hosted stack's landing workflow does it there.
- **Symbol-level checks cover TypeScript/JavaScript only.** Other files are coordinated per file
  (`path#*`): two edits to the same file conflict wherever they are in it.
- **Only edit tools are checked before they run.** Claude Code `Edit`, `Write` and `MultiEdit` are
  checked and can be denied. Files changed through `Bash` (`sed -i`, redirects, generators) are
  not checked; `git commit` through Bash is gated.
- **An accepted adaptation may not compile yet.** After a `stale_assumption`, the agent codes
  against the other agent's new signature, which its checkout does not have until that change is
  merged. Weft accepts the edit (it matches the log); the type checker will not until you merge.
- **Negotiation needs a live counterpart.** A proposal to an agent that is not running is never
  answered; the asking agent's open error keeps its stop gate shut until it adapts (or until the
  runaway guard lets it stop after five refusals).
- **Fail open.** If the gateway is down or slow (5 s timeout), edits run uncoordinated and the
  agent is told so; nothing is blocked.
- **Hooks load at session start**, so an install into a running Claude Code session has no effect
  until that session restarts.
- **Local state lives in `apps/gateway/.wrangler/`** (event logs, registry, system-token files).
  Deleting it resets everything; agent installs then hold tokens the gateway no longer knows, so
  re-run the quickstart.
- **Adapters are not published to npm.** Installs reference the bundle in your clone, so keep the
  clone where it is (or re-run `install` after moving it).

## 5. Optional: deploy a preview in your Cloudflare account

This step creates/updates a Worker in the account selected by your Wrangler login. Review the
commands and account before proceeding. All Weft Cloudflare resource names use the `weft-`
prefix. Do not set `CLOUDFLARE_API_TOKEN`; the project uses Wrangler OAuth.

1. Authenticate with Wrangler (`pnpm exec wrangler login`) and confirm the intended account
   (`pnpm exec wrangler whoami`).
2. Point the preview's custom domain (`[env.preview]` `routes` in `apps/gateway/wrangler.toml`)
   at a hostname in a zone on your account; the committed value is the project's own domain.
3. From the repository root, deploy the gateway preview:

   ```sh
   unset CLOUDFLARE_API_TOKEN
   pnpm --filter @weft/gateway deploy:preview
   ```

4. Check its public health endpoint: `curl -i https://<your-gateway-preview-host>/v1/health`

The preview deployment is only the gateway app; it is not the full hosted multi-agent demo, which
also needs configured Artifacts, D1, Queue, workflow, sandbox, and evidence resources. Consult
[the runbook](runbook.md) before provisioning those services. Never paste admin tokens or secrets
into issue reports or logs.

## Next steps

- [Integrate Weft into your own agent setup](integrate.md): capability levels, adapters, advise
  vs enforce, landing.
- [WCP v0.1](protocol/wcp-v0.md): message formats, roles, validation, conformance.
- [Architecture and Cloudflare mapping](design.md).
- [AAIF proposal](proposal-aaif.md): the case for standardizing agent hooks.
