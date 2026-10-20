# M1 baseline: the same two-agent scenario with Weft OFF

Recorded 2026-10-20 with `WEFT_BASELINE_A=codex node demo/m1-baseline.mjs` (no coordinator,
no adapter, no hooks). Agent A ran on Codex because the Claude CLI was not logged in on the
recording machine; with Weft off, the harness doesn't change the result: neither agent can see the other's work.

Scenario (same target app and tasks as `demo/m1-collision.mjs`):

- T-1 (agent A): change `createSession(userId)` to `createSession(userId, opts)`.
- T-2 (agent B): add `POST /api/signup`, which must sign the new user in (calls `createSession`).
- Timeline: B plans (56 s), A finishes (119 s), B implements in its own worktree (176 s).

Result (`landing.txt`, `summary.json`):

| check | agent A alone | agent B alone | main after merging A then B |
|---|---|---|---|
| `git merge` | ok | ok | both clean, no conflict |
| `tsc` | exit 0 | exit 0 | exit 2: `src/api/account.ts(19,25): error TS2554: Expected 2 arguments, but got 1.` |
| `node --test` | pass | pass | 9/10; fails "signup registers a user and signs them in immediately" |

So each branch is green on its own, git merges cleanly, and the build is only broken after the
merge: B called the old one-argument `createSession(user.id)` that A had already changed.
Someone has to find that and send B back to redo it. Compare `demo/evidence/m1/`, where Weft
denies B's stale edit while B is writing it and B adopts the new signature before landing.

Model usage (harness-reported, cached input included): A 123,960 in / 820 out; B plan 100,719 /
1,324; B implement 216,351 / 2,741. Not comparable 1:1 with the Weft-on runs (A was a different
harness there).
