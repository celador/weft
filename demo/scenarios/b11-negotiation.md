# Scenario B11: negotiation — B proposes an overload, A accepts, both land

Driver: `node demo/b11-negotiation.mjs [--runs N] [--first K] [--out DIR]` (repo root, Node ≥ 22).
Target: `demo/target-app` (same app as M1). Evidence: `demo/evidence/b11/` (report in its
`README.md`). Design beat: §8 item 4 ("Negotiation: B proposes an overload; A accepts; both
land"). Protocol: spec §7.2 options, §7.4 negotiation, §7.6 escalation, §8.4 negotiation dues.

## Cast

| | agent A | agent B |
|---|---|---|
| harness | Claude Code, `claude -p --output-format stream-json` | Claude Code, `claude -p` (turn 2 = `--resume`) |
| Weft adapter | `packages/adapters/claude-code` (L3) + `.weft/bin/weft` | same |
| WCP agent / task | `claude-a` / T-1 "Session expiry" (priority 1) | `claude-b` / T-2 "Signup endpoint" (priority 0) |
| checkout | git worktree `agent-a` | git worktree `agent-b` |

Coordinator: the gateway Worker + `RepoCoordinator` Durable Object from this branch, run with
`wrangler dev --env test` (workerd, local DO + D1) on `127.0.0.1:8799`, so the shared preview
gateway used by other cards is not touched. `WEFT_URL` points the driver at any gateway.

## The conflict and the deal

- **A (T-1)** changes `createSession(userId)` → `createSession(userId, opts: SessionOptions)`
  (sessions expire), updates the login caller and tests, then adds `refreshSession`.
- **B (T-2)** adds `POST /api/signup`. Product rule in B's prompt: signup sessions use the
  default lifetime, so the route must call `createSession(user.id)` exactly as login did and must
  not pick session options. If Weft blocks it because someone changed an API it calls, it should
  not adapt but negotiate: ask the owner to keep the old call working as an overload.
- A's prompt only says that Weft may relay requests from other agents and to treat a reasonable,
  compatible request in good faith. It is not told what will be asked.

## Timeline per run

1. B turn 1 reads and plans (its base is pinned before A's change).
2. A starts as soon as B has joined, and changes the signature (accepted, e.g. log #3).
3. B turn 2 implements. Its edit with `createSession(user.id)` is **denied at PreToolUse**
   (`stale_assumption`, A's diff quoted, plus a `↳ Your options:` line with the exact
   `negotiate propose overload` command; since #15 a `stale_assumption` no longer offers
   retreat or `negotiate escalate`, which claim conflicts still do).
4. B runs `.weft/bin/weft negotiate propose overload "…" --wait 100` → `negotiate.propose`
   addressed to A's change.
5. The proposal reaches A as injected context, either **live** (next hook of the running
   session, e.g. run 5: PreToolUse:Edit) or, when A had already finished, **redelivered** in the
   SessionStart context of A's resumed conversation (driver prompt: "Continue: handle anything
   Weft reports for you"). A's stop gate would refuse to finish while it is unanswered.
6. A makes the overload (`createSession(userId)` + `createSession(userId, opts)`) and runs
   `weft negotiate accept <seq>`. Until that edit is in the log, A's stop gate refuses with
   `[weft negotiation due] agreement #n …` (spec §8.4).
7. B's `--wait` returns the acceptance with a role-specific hint; B retries its edit unchanged and
   it is accepted (its base is now past A's change).
8. Both checkouts commit through the installed git hooks (Change-Id/Task-Id/Agent-Id trailers),
   merge into `main` (A, then B), and a system token posts one `land` record per change. `tsc`
   and `node --test` run on `main`.

## Pass criteria (all required)

`b_denied_at_edit_time_by_a`, `b_proposed_overload`, `proposal_injected_into_a` (A's
hooks.jsonl shows the `[weft negotiation] #n` text), `a_accepted`, `a_made_agreed_edit`
(accepted A edit of `createSession` after the proposal), `b_kept_old_call` (the signup route
calls `createSession` with one argument), `both_landed` (two accepted `land` records),
`tests_green` (tsc + tests on main).
