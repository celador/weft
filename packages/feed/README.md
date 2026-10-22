# @weft/feed

One feed model and one view for every Weft UI: the VS Code extension, `npx weft feed`, the web
feed and a later JetBrains plugin all behave like Otto. Spec: [docs/harness-coverage.md §3](../../docs/harness-coverage.md#3-the-otto-experience-everywhere).
Otto (`~/code/hermes-ios/ios/Hermes/Weft/`, Swift) is the reference for the semantics; this
package is its TypeScript port, and it is tested with Otto's own test cases plus real recorded logs.

- **Core** (`@weft/feed`): no DOM and no Node-only APIs (checked by `test/portability.test.ts`), so it
  runs in a browser, a VS Code webview, Node >= 22 and JCEF. Depends only on `@weft/protocol`.
- **View** (`@weft/feed/view` + `@weft/feed/view.css`): a dependency-free DOM component. CSP-safe like
  `apps/web`: no inline script or style, no `innerHTML`; agent text is set with `textContent`.

```ts
import { FeedSession, ObserverClient, feedRows, editingNow, squiggles, actionsFor, renderText } from "@weft/feed";
import { mountFeed } from "@weft/feed/view"; // + <link rel="stylesheet" href=".../view.css">

const client = new ObserverClient({ baseUrl: "http://localhost:8787", token }); // observe (+ human for actions)
const session = new FeedSession(client, { perRepoStreams: true });
mountFeed(document.getElementById("app")!, { session });
await session.start();

// Or headless (a terminal feed):
for (const r of feedRows(session.log)) console.log(renderText(r, { ansi: true, now: Date.now() }));
for (const s of squiggles(session.log)) console.log(renderText(s)); // == the adapter's renderContext() line
```

## API

| Piece | What it does |
|---|---|
| `ObserverClient({baseUrl, token})` | `repos()`, `events(repo, {after\|before\|tail, limit, include, kind, agent, task, change, status})`, `event(repo, seq)` (full record with `diff`), `feed({cursor\|tail, limit, repos})`, `act(repo, HumanAction)`. `streamRepo(repo, {after, onEvent})`: WebSocket with first-frame auth, replay → `replay.done` → live, reconnect with `after=` the highest seq processed, de-dupe by seq, `4413` → page `GET /events?after=` then reconnect, stop on 4401/4403/4404. `streamFeed({cursor, onEvents})`: tries `/v1/feed/stream` (§9.5 SHOULD) and, when the gateway has none, polls `/v1/feed` with the opaque cursor on Otto's schedule (4 s busy → 10 s quiet; failures 2, 4, 8 … 30 s). Token goes in `Authorization` or the first socket frame, never in a URL. |
| `FeedLog` | Records by repo and seq; ingest de-dupes (a detail copy with `diff` replaces the list copy), per-repo high-water marks that never decrease, 500-record cache per repo, combined order newest first by (ts, repo, seq), filters, `thread()`, `candidates()`, `isPaused()`, `revertOf()`. |
| `FeedSession` | `ObserverClient` → `FeedLog` with status, fresh rows, `loadDetail()`, `act()` (the action's record lands in the log at once). What a UI subscribes to. |
| `feedRows(log, filter)` | The Changes feed: one row per record (summary without the actor, kind badge and tint, symbol chips, squiggles). Session bookkeeping hidden by default. |
| `stripModel(events, now)` / `editingNow()` | "Editing now" per change (edits since its last accepted `land`, within 3 h) and Otto's live strip (one row per edit, plus lands, installs, non-edit conflicts). |
| `squiggles(log)` | Every diagnostic with its cause: `cause {repo, seq, agent, task}` and `causeText` "caused by <agent> · event #N". |
| `actionsFor(record, log)` / `actionBody()` | Message, Pause/Resume, Approve, Undo per Otto's rules; bodies match the spec's pinned `HumanAction` fixtures. |
| `repoSummary(repo)` / `headerStatus()` | "weft-demo · 2 agents · 1 change · 1 conflict · 3m"; "Live · N repos" / "Connecting" / "Offline · saved changes". |
| `renderText(x, {multiline, ansi, now})` | One-line and multi-line text for a row, squiggle, Editing now row, strip row or record. A squiggle's one-line form **is** `renderDiagnostic()` (what `renderContext()` gives the model). |
| `parseDiff(diff)` | Unified diff → file / hunk / add / del / context lines with old and new line numbers. |
| `mountFeed(el, {session})` | Header (status, filters, per-repo lines), Editing now (expandable trail), Changes with inline squiggles whose cause link opens the cause, detail pane (coloured diff, intent, squiggles, writes/reads, negotiation thread, task candidates, provenance) and the action buttons with an inline composer. |

## Parity with Otto

Each row: the Otto behaviour, where it lives in Otto, the TS function, and the test that pins it.
Tests in `test/otto-parity.test.ts` are Otto's own test cases (HermesTests `WeftStripTests`,
`WeftTests`, `WeftFeedTests`) with the same inputs and expected outputs; `test/recorded-logs.test.ts`
runs the reducers on real logs from `demo/evidence`; `test/live-run.test.ts` on the log recorded
by this package's live demo run.

| Otto behaviour | Otto source | TS function | Test |
|---|---|---|---|
| Records keyed by repo+seq; replay/live overlap de-duplicated; detail copy replaces list copy without counting as new | `WeftLog.ingest` | `FeedLog.ingest` | parity › "ingest de-duplicates…", "a detail copy replaces…"; client › "streams a repo…de-duplicates by seq" |
| Per-repo high-water mark (never decreases), 500-record cache, catch-up plan tail vs after | `WeftLog.highWater/trim/catchUpPlan` | `FeedLog.resumePoint`, `catchUpPlan` | parity › "high-water is per repo", "trims to the cache size…", "catch-up plan" |
| Combined order newest first by (ts, repo, seq) | `WeftLog.newestFirst` | `newestFirst`, `FeedLog.combined` | parity › "combined order is newest first across repos" |
| Default feed hides session bookkeeping; blocked/squiggled bookkeeping never hidden; filters (repo, task, agent, kind, only conflicts) | `WeftFilter.matches` | `filterMatches`, `FeedLog.filtered`, `feedRows` | parity › "filters", "the default feed hides…", "blocked or squiggled bookkeeping…"; recorded › claude-collision "Changes feed…" |
| Row summary without the actor; whole-file keys (`path#*`) rebuilt as file names | `WeftSummary.render/withActor/rebuild` | `summaryLine`, `summaryWithActor`, `rebuildSummary` | parity › "whole-file edits and releases name the file", "parsed symbols keep the coordinator's summary" (Otto's live feed tail fixture) |
| Kind badge (blocked/rejected, negotiate sub-kind, control action) and tint | `WeftKindBadge` | `kindBadge`, `kindTint` | recorded › m2 "control and revert rows read like Otto's" |
| Editing now: per change, edits since its last accepted land, within 3 h; files of accepted edits; conflicted if blocked or error/warning; count and trail | `WeftStripModel.make` (`editingWindow`) | `stripModel`, `editingNow`, `trailOf` | parity › "Editing now lists unlanded changes…", "landed or stale changes…", "expanding a card…"; recorded › claude-collision "Editing now has a row for each running task"; live-run |
| Strip feed: every edit its own row; lands green, installs blue, non-edit conflicts amber; inline blocked/warned badge; probes hidden; capped | `WeftStripModel.make` | `stripModel` | parity › "every edit is its own row…", "feed interleaves…", "blocked and warned edits…", "non-edit conflicts…", "installs…", "probe runs…" |
| Card title only from `<task>: <title>` intents or `x_task_title` | `WeftStripModel.title` | `titleFromIntent`, `stripModel` | parity › "only task intents name the card" |
| Squiggle shows the symbol, plain-words code, message and "caused by <agent> · event #N" linking to the cause | `WeftDiagnosticCallout`, `WeftFormat.codeLabel` | `squiggles`, `squiggleOf`, `codeLabel`; view `.wf-cause` | recorded › "the squiggle links to the edit that caused it", m2 "every squiggle's cause…"; live-run; e2e "squiggle → cause" |
| Actions: Message + Pause (Resume when paused) for an agent's record; Approve for a candidate not yet approved, never on land/revert; Undo only on an un-reverted land | `WeftEventDetailView.availableActions`, `WeftRowMenu` | `actionsFor` | parity › "Message + Pause/Resume…"; recorded › m2 "Undo is offered only on lands no revert has undone", "Approve disappears…"; e2e Pause/Resume/Message |
| Paused = last pause/resume control on that agent in that repo | `WeftLog.isPaused` | `FeedLog.isPaused` | parity › "candidates: approval, land, revert, pause" |
| Revert lookup for a land | `WeftLog.revert(of:)` | `FeedLog.revertOf` (also matches `reverts_op_id`) | parity, recorded › m2 |
| Candidates per task (approved, landed, reverted, evidence) | `WeftLog.candidates` | `FeedLog.candidates` | parity › "candidates…"; recorded › m2 "Approve disappears…" |
| Negotiation thread through `reply_to` | `WeftLog.thread` | `FeedLog.thread` | parity › "a negotiation thread follows reply_to"; recorded › m2 |
| HumanAction wire bodies | `WeftAction.json` | `actionBody` | parity › "encodes human actions exactly like the spec's pinned fixtures" |
| Endpoints, bearer + WCP-Version headers, error mapping (401, 403 read-only) | `WeftClient` | `ObserverClient` | client › "sends the bearer token…", "maps errors…" |
| Poll schedule and "Live" window | `WeftPollPolicy`, `WeftHeaderStatus` | `pollInterval`, `headerStatus`, `FeedSession.isLive` | client › "poll and reconnect schedules match Otto"; parity › "repos sort by activity; the header…" |
| Relative times, line stats, paging | `WeftFeedTime`, `WeftLineStats`, `WeftFeedPaging` | `relTime`, `tickMs`, `lineStats`, `nextPage` | parity › "relative times tick live", "line stats…", "paging…" |
| Unified diff with line numbers | `DiffParser` | `parseDiff` | parity › "the diff parser numbers lines" |
| Repo name from a project folder (adapter's `sanitize_repo`) | `WeftStripModel.repo(forFolder:)` | `repoForFolder` | parity › "repo name follows the adapter" |

Differences from Otto, on purpose:

- Undo also requires the land to be `accepted` (a rejected land has nothing to revert); `revertOf`
  also matches `reverts_op_id` (as the web UI's op log does).
- `stripModel` groups by (repo, change), so it can take records from several repos; for one repo it
  is Otto's rule.
- Squiggles whose cause is older than the records held still carry `cause.repo/seq`; the view
  fetches the cause with `GET /events/{seq}` when it is opened (`m2/run-5` has such causes).
- Streams: Otto polls `/v1/feed`; `FeedSession` can also use per-repo sockets (`perRepoStreams`),
  which is what the demo does.

## Demo (a real run)

`demo/` is a page that mounts `@weft/feed/view` on a local gateway. `live-run.mjs` reproduces the
run behind the screenshot: two Claude Code agents with the Weft adapter, one conflict.

```sh
cd apps/gateway && echo "WEFT_ADMIN_TOKEN=$(openssl rand -hex 16)" > .dev.vars.test && pnpm dev:local --port 8817
# second terminal, repo root:
node packages/feed/demo/live-run.mjs setup --url http://localhost:8817 --dir /tmp/feed-run
cd packages/feed && node demo/build.mjs && \
  WEFT_URL=http://localhost:8817 WEFT_TOKEN_FILE=/tmp/feed-run/human-token node demo/server.mjs --port 8818
# open http://127.0.0.1:8818/, then:
node packages/feed/demo/live-run.mjs agents --dir /tmp/feed-run
# optional browser check (Playwright not a dependency): Pause, Resume, Message from the page, verified in the log
PLAYWRIGHT=/path/to/playwright/index.mjs node packages/feed/demo/e2e.mjs --page http://127.0.0.1:8818/ --dir /tmp/feed-run
```

`server.mjs` serves the page with a strict CSP, proxies `/v1` (HTTP and WebSocket) to the gateway
so the page is same-origin, and hands the page its token via `/config.json` (local use only).
