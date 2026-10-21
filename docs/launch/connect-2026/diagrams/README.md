# Connect 2026 diagrams (Archify)

Interactive diagrams for deck rev 7.1, made with [Archify](https://github.com/tt-a1i/archify) 3.2
(MIT, installed with `npx skills add tt-a1i/archify -g`). Each `*.json` is the source; every box
cites the Weft source lines it was drawn from, pinned to commit d812219.

| Diagram | Source | Deck | Presentation view |
|---|---|---|---|
| Architecture | `architecture.json` | review page only (was slide 2 until card t_26e387d8; slide 3 now shows the site's `site-architecture.webp`) | `architecture.html?present=1&theme=dark#route=agents~land` |
| Conflict sequence | `conflict.json` | slide 10 (`conflict.png`) | `conflict.html?present=1&theme=dark#route=coord~codex` |

`site-architecture.webp` is not Archify: it is the website's `site/public/assets/img/architecture.webp` with
the empty margins cropped (1708x600), shown on slide 3 since card t_26e387d8.

Other views: `#route=agents~coordinator` (edit time), `#focus=<id>` (one box and its neighbours),
`#focus=<id>&reach=upstream|downstream`. Without `?theme=dark` the page follows the OS theme.

Rebuild (from this directory; each run checks schema, delivery, provenance against the pinned
commit and a real browser):

    A=~/.agents/skills/archify/bin/archify.mjs
    node $A finalize architecture architecture.json architecture.html --repo-root ../../../.. --quality showcase --json
    node $A finalize sequence conflict.json conflict.html --repo-root ../../../.. --quality showcase --json

The PNGs are screenshots of the dark presentation view with the viewer chrome hidden, trimmed
(1.5x). Then `python3 ../build_slides.py` re-embeds them in `slides.html`.

Label check against docs/design.md (corrections made while drawing):
1. Priority is wound-wait by default and wait-die per repo (design B2 update, protocol reference).
2. Priority (claim arbitration, two agents writing one symbol) and the stale_assumption squiggle
   (rule R2, a signature change) are separate rules; the sequence shows them as separate steps.
3. The coordinator does not quote the other agent's code: the receiving agent's adapter fetches the
   causing event (`GET /events/{seq}`) and quotes its hunk (design B4 update).
4. The rebase is layered: plain git, then Mergiraf, then a resolver agent (B8 update).
5. Landing = the repo DO's submit queue, then a `--force-with-lease` push of trunk (B6/B8).
6. Cursor: adapter written, not live-verified. Gemini CLI: live per the Otto run-4 hook logs
   (`demo/evidence/otto/run-4/lanes/t7/agents/gemini-t7-r4/hooks.jsonl`); design.md's B12
   "fixture-only" note and the header of `packages/adapters/gemini/src/translate.ts` predate run-4.
