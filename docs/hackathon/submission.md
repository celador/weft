# Hermes Plugin Hackathon — Weft demo and submission

## State (Nov 10, 2026)

- Catalog PR **merged**: https://github.com/NousResearch/hermes-agent/pull/150998 (teknium1,
  2026-11-10 10:32 UTC). `hermes plugins search weft` lists **weft 0.4.0 @ fe30e497**, tier
  community, so `hermes plugins install weft` works from the catalog.
- Demo video is cut (80.7 s): `~/Documents/Weft/hackathon/weft-hermes-demo.mp4` on John's Mac, with
  `captions.srt`, `contact-sheet.jpg` and `x-post.txt` beside it. Not in git (binary). How it was
  made: [demo/video/hackathon/README.md](../../demo/video/hackathon/README.md).

## John’s remaining steps

1. Watch `~/Documents/Weft/hackathon/weft-hermes-demo.mp4` (80.7 s, under the 90 s limit).
2. Post it on X with the text in `x-post.txt` (also below). **Nothing has been posted.**
3. Submit the catalog PR URL and the X post URL at **https://form.typeform.com/to/FwJLvOln**.
   Official announcement: https://x.com/NousResearch/status/2118094256438936062.
4. Deadline: **Wednesday Nov 11, 2026, 5 PM EST / 7 PM Montevideo**.
5. Watch for the entry’s Discord thread after submissions close. The announcement does not
   require a separate Discord submission. Support invite: https://t.co/qxek9haYeb.

## The cut (80.7 s)

One continuous take of two **live** Hermes sessions (model inference, `claude-sonnet-4-5`) in tmux,
filmed with VHS. Cuts only remove idle time (session start-up, model think time before the reads);
nothing is sped up, reordered or spliced from another run. Two short zooms enlarge B's pane for
phone readability. No Desktop pane (it was not filmed in a live Desktop window).

| Time | Picture | Narration |
|---|---|---|
| 0–6.8 s | Title card “Conflicts before commits”; “Recorded live · real model calls · local gateway · idle time trimmed”. | “Git tells you two agents collided after they commit. Weft tells Hermes while it's still editing.” |
| 6.8–19.1 s | `hermes plugins search weft` (catalog table: weft 0.4.0 @ fe30e497, community), then `hermes plugins install weft --enable` into an isolated Hermes home. | “Weft is in the Hermes plugin catalog, so one command installs it. Its gateway runs on your machine by default. Hosted mode is opt-in.” |
| 19.1–35.5 s | Two `hermes chat` sessions start in `/tmp/shop` and `/tmp/shop-2` (paired Git worktree); both read `pricing.py` and `cart.py`; `/weft status` in each: enforce mode, local gateway, connected, same repo, the other session live. | “Now a live run, with real model calls. Two Hermes sessions, each in its own Git worktree of the same repo. Both read the code. Weft status: enforce mode, connected, same repo.” |
| 35.5–45.7 s | A is asked to change `calc_total(items)` to `calc_total(items, opts)` in `pricing.py`; the patch is accepted. | “Agent A changes calc_total to take a required options argument. Weft records which declaration changed, not just the file.” |
| 45.7–58.9 s | B is asked to add `cart_total(items)` calling `calc_total(items)` in `cart.py` (“if Weft blocks the edit, don't retry: quote its error”). The write is blocked; B quotes `[weft error] stale_assumption pricing.py#calc_total … changed in #3 by shop … event #3`. Zoom on B from 53.1 s. | “Agent B still has the old signature in its worktree, and writes code that calls it the old way. Before that edit reaches disk, Hermes gets a stale assumption error, naming the symbol, the other agent, and the event.” |
| 58.9–70.7 s | `/weft status` in B: 1 rejected, open conflicts (1) `stale_assumption pricing.py#calc_total`, `edit cart.py#cart_total -> REJECTED (blocked before it was written)`. | “B's status shows one rejected edit and one open conflict. Coordination happens in the tool loop, not in the prompt.” |
| 70.7–80.7 s | End card “Weft · MIT · github.com/celador/weft”: `hermes plugins install weft`; Python declaration analysis ships in the plugin; other languages whole-file unless a full analyzer is configured; local by default, hosted opt-in. | “Python analysis ships with the plugin. Other languages fall back to whole files. Weft is open source, under MIT.” |

Do not claim all languages have symbol precision out of the box: the catalog ships Python AST
analysis; other languages have whole-file keys unless a full analyzer is explicitly configured.
An in-flight **same-file** overlap is a warning (`claim_wait`), not an unconditional file lock.
The cross-file stale-signature edit above is the blocking demonstration.

## Reproducible record plan

The scripts in `demo/video/hackathon/` do all of this (see its README):

- A fresh throwaway project with only `pricing.py` and `cart.py` under `/tmp`; no business code,
  home directories, other projects, contacts, auth pages, `.env`, or `.weft/token` on screen.
- The catalog install goes into an **isolated Hermes home** (`/tmp/hx/profiles/demo`, standalone
  gateway with its own lock dir), never over the development adapter or the host gateway.
  Local Weft gateway only (127.0.0.1).
- Both sessions are open and have read both files **before** A edits, so the read-before-write
  guard doesn't hide the coordination result.
- Do not fake a chat or splice a successful tool result over a failed run. If the zero-cost
  deterministic driver is ever filmed instead of inference, label it explicitly **“real Hermes hook
  dispatch, deterministic tool-call replay; no model inference.”**
- Repeatable zero-inference verification from the monorepo:
  ```sh
  WEFT_E2E_JSON="$PWD/dist/hackathon/e2e.json" python3 packages/adapters/hermes/tests/e2e_catalog.py
  ```
- Before posting, check duration with
  `ffprobe -v error -show_entries format=duration -of default=nw=1 weft-hermes-demo.mp4` (< 90).
- Cleanup: `demo/video/hackathon/teardown.sh` stops the local Weft gateway, the demo's Hermes
  gateway and tmux, and deletes `/tmp/shop`, `/tmp/shop-2` and `/tmp/hx`.

## X post — do not post automatically

> I built Weft for the @NousResearch Hermes plugin hackathon.
>
> Two agents, one codebase. A changes a function signature; B gets a conflict diagnostic mid-edit, and in enforce mode its stale write never lands.
>
> hermes plugins install weft · local-first · MIT
> https://github.com/NousResearch/hermes-agent/pull/150998

279 characters as X counts them (the URL counts as 23). Attach `weft-hermes-demo.mp4`.

## Form copy

**Project:** Weft — edit-time coordination for Hermes coding agents

**Short description:** Weft catches conflicts between coding agents while they edit, before Git
merge time. Its Hermes plugin, now in the Hermes plugin catalog (`hermes plugins install weft`),
observes edit hooks, injects symbol-level diagnostics for Python, and in enforce mode blocks stale
edits before they reach disk. It includes status/inbox tools, a `/weft` command, a Desktop activity
pane and a local-first gateway (hosted is opt-in). MIT; no model calls or core overrides.

**Repository:** https://github.com/celador/weft

**Catalog PR (merged):** https://github.com/NousResearch/hermes-agent/pull/150998

**Demo:** paste the X post URL after posting.
