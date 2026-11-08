# Hermes Plugin Hackathon — Weft demo and submission

## John’s remaining steps

1. Record the demo below; keep the final file **under 90 seconds**.
2. Post it on X with the draft below, replacing `CATALOG_PR_URL`. **Nothing has been posted.**
3. Submit the catalog PR URL and X post URL at **https://form.typeform.com/to/FwJLvOln**.
   Official announcement: https://x.com/NousResearch/status/2118094256438936062.
4. Deadline: **Wednesday Nov 11, 2026, 5 PM EST / 7 PM Montevideo**.
   The official announcement says the form can be submitted as soon as the PR is open;
   catalog checks may need a maintainer to start them. Do not wait for catalog merge to enter.
5. Watch for the entry’s Discord thread after submissions close. The announcement does not
   require a separate Discord submission. Support invite: https://t.co/qxek9haYeb.

## 85-second cut

| Time | Picture / action | Narration |
|---|---|---|
| 0–8s | Two Hermes sessions, `shop` and `shop-2`, both already connected. Title: “Conflicts before commits.” | “Git tells you two agents collided after they commit. Weft tells Hermes while it is editing.” |
| 8–20s | `/weft status` in each; show enforce, connected, same repo. No keys or pairing codes on screen. | “This plugin connects Hermes sessions to one ordered change log. The gateway is local by default. These agents have separate Git worktrees.” |
| 20–38s | A edits `pricing.py`: `calc_total(items)` → `calc_total(items, opts)`; show accepted result. | “The first agent changes the pricing function’s signature. Weft records which declaration changed, not just the file.” |
| 38–55s | B attempts a new `cart_total(items)` in `cart.py`, still calling `calc_total(items)`; show rejection with `stale_assumption pricing.py#calc_total`. | “The second agent still assumes the old signature. Before that edit reaches disk, Hermes gets this diagnostic: the exact symbol, the other agent, and the event that changed it.” |
| 55–70s | `weft_status` or `/weft status`: one rejection and open conflict. Optional Desktop pane if verified in the actual app. | “The agent can inspect its conflicts and inbox with tools. The person has a status command and an activity pane. It is coordination in the tool loop, not another instruction in the prompt.” |
| 70–85s | Show Python analyzer fallback, local/hosted choice, GitHub catalog PR, end card “Weft · MIT · github.com/celador/weft”. | “Python declaration analysis ships with the plugin. No analyzer download. Hosted is opt-in. Weft is open source, with a pinned catalog submission for Hermes.” |

Do not claim all languages have symbol precision out of the box: the catalog ships Python AST
analysis; other languages have whole-file keys unless a full analyzer is explicitly configured.
An in-flight **same-file** overlap is a warning (`claim_wait`), not an unconditional file lock.
The cross-file stale-signature edit above is the blocking demonstration.

## Reproducible record plan

- Use a fresh throwaway project with only `pricing.py` and `cart.py`; no business code, home
  directories, other projects, contacts, auth pages, `.env`, or `.weft/token` on screen.
- Install the catalog PR’s exact pin into an **isolated Hermes home/profile**, not over the
  development adapter. Use the setup instructions in the plugin README. Local gateway only.
- Open both sessions **before** A edits, because session start establishes each log base.
- For a genuine conversational recording, ask A to add the required `opts` argument and tax
  calculation, then ask B to add `cart_total` using the original signature. Read both files first
  so Hermes’s read-before-write guard does not obscure the coordination result.
- Do not fake a chat or splice a successful tool result over a failed run. If using the zero-cost
  deterministic driver instead of inference, label it explicitly **“real Hermes hook dispatch,
  deterministic tool-call replay; no model inference.”** It invokes real Hermes file tools and
  hooks against a real local gateway, not mocked verdicts.
- Repeatable zero-inference verification from the monorepo:
  ```sh
  WEFT_E2E_JSON="$PWD/dist/hackathon/e2e.json" python3 packages/adapters/hermes/tests/e2e_catalog.py
  ```
  Parent output directory must exist. The driver cleans its gateway, repo and isolated homes on
  exit. `WEFT_E2E_KEEP=1` intentionally leaves them running for inspection; stop the local gateway
  before deleting the kept directory.
- Screen capture: 16:9 at 1920×1080, large terminal type, two sessions tiled. Crop to repository
  panes. Record the runtime demo first, then trim idle startup time; no speed-up over the rejection.
- Show the actual Desktop pane only after loading it in that isolated Desktop instance. The committed
  screenshots are **component-harness verification using real gateway snapshots**, clearly labeled
  on-image. They are not evidence of the pane being loaded into John’s live Desktop window.
- Export MP4/H.264, aim for 85 seconds. Before posting, check duration with
  `ffprobe -v error -show_entries format=duration -of default=nw=1 demo.mp4` and verify it is <90.
- Cleanup: the driver handles its own fixture by default. For a separately recorded setup, stop
  `npx -y @celador/weft@0.3.0 local stop`, remove only throwaway worktrees and the isolated Hermes home.

## X post draft — do not post automatically

> I built Weft for the @NousResearch Hermes plugin hackathon.
>
> Two coding agents, one codebase. When one changes a function’s signature, the other gets a conflict diagnostic before writing a stale caller.
>
> Local-first. MIT. Demo ↓
> CATALOG_PR_URL

Attach the <90s video and insert the real catalog PR URL. Do not describe the catalog listing as
accepted until Nous merges it.

## Form copy

**Project:** Weft — edit-time coordination for Hermes coding agents

**Short description:** Weft catches conflicts between coding agents while they edit, before Git
merge time. Its Hermes plugin observes edit hooks, injects symbol-level diagnostics, and can block
stale edits. It includes status/inbox tools, a `/weft` command, a Desktop activity pane, built-in
Python analysis, and a local-first gateway. MIT; no model calls or core overrides.

**Repository:** https://github.com/celador/weft

**Catalog PR:** use the URL in this task’s handoff / upstream PR.

**Demo:** paste the X post URL after posting.
