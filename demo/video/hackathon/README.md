# Hermes-hackathon cut (< 90 s)

The 83.9 s demo for Weft's Hermes Plugin Hackathon entry: two **live** Hermes sessions (real model
calls) in one repo, where B's stale call to `calc_total` is blocked before it reaches disk. Script
table and posting steps: [docs/hackathon/submission.md](../../../docs/hackathon/submission.md).
The competition video (`../script.md`, `../rig/edl.json`, `../weft-demo.mp4`) is untouched.

Everything runs in a throwaway world under `/tmp` (on-screen paths stay neutral): an isolated Hermes
home `/tmp/hx/profiles/demo` with its **own standalone gateway** (`gateway.standalone: true` and its
own `HERMES_GATEWAY_LOCK_DIR`, so the host gateway and `~/.hermes` are never touched), an isolated
Weft home/cache, `/tmp/shop` and its paired worktree `/tmp/shop-2`, and a local Weft gateway on
127.0.0.1. Inference uses the machine's Anthropic login (Claude Code credentials) with
`claude-sonnet-4-5`; no API keys are written anywhere.

```sh
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
(cd demo/video/rig && npm ci && npx playwright install --only-shell chromium)   # once
W=<work dir outside the repo>

# 1. one complete take: isolated home -> filmed catalog install -> project + local gateway ->
#    plugin settings (enforce, agent id, agent-token secret) -> two live sessions filmed in tmux
bash demo/video/hackathon/film.sh $W/take1
python3 demo/video/hackathon/timing.py $W/take1/live.mp4 --fps 4   # when things appear on screen (VHS clock drifts)
#    -> adjust edl.json source times if this is a new take

# 2. narration (Edge en-US-AndrewNeural; edge-tts >= 7.3), whisper words for cues + captions
EDGE_TTS_BIN=$(which edge-tts) node demo/video/rig/narrate.mjs --script demo/video/hackathon/script.md \
  --provider edge --voice en-US-AndrewNeural --lexicon demo/video/hackathon/lexicon.json --out $W/audio
for f in $W/audio/0*.mp3; do whisper $f --model medium.en --language en --word_timestamps True \
  --output_format json --output_dir $W/wh --fp16 False; done

# 3. cards, cut, check
node demo/video/rig/render-cards.mjs --spec demo/video/hackathon/cards.json --out $W/cards
node demo/video/hackathon/assemble.mjs --take $W/take1 --audio $W/audio --cards $W/cards --whisper $W/wh --out $W/cut
node demo/video/hackathon/safety.mjs $W/cut/weft-hermes-demo.mp4 --every 0.5
# re-cutting one section (v2 changed only 06): narrate.mjs ... --sections 06 into a copy of the
#    audio dir, whisper that one file, re-render cards, adjust the card's dur in edl.json, assemble
bash demo/video/hackathon/teardown.sh
```

| File | Does |
|---|---|
| `env.sh` | the throwaway world's variables; unsets a Kanban worker's / gateway's identity |
| `setup.sh home\|project\|plugin` | isolated Hermes home; `/tmp/shop` + `npx @celador/weft@0.3.0 --local` (what `/weft setup` runs); plugin settings + secret |
| `install.tape` | films `hermes plugins search weft` + `hermes plugins install weft --enable` |
| `live.py` + `live.tape` | tmux with two panes; types the prompts into two real `hermes chat` sessions and waits for each turn; VHS films the attached tmux |
| `film.sh` | one whole take (the above, in order) into a directory |
| `timing.py` | OCR (Apple Vision) of the take: first time each key line appears per pane |
| `script.md`, `lexicon.json` | narration (rig format) and TTS-only spellings (`calc_total` -> "calc total") |
| `edl.json` | cut list: in-order excerpts of the one take, cards, narration cue points, zoom rects |
| `cards.json` | title and end cards (`render-cards.mjs --spec`) |
| `assemble.mjs` | cuts, adds the caption band, burns captions (whisper-timed), mixes and loudness-normalises narration, writes SRT + timeline |
| `safety.mjs` | the rig's OCR screen-safety patterns plus home paths, the OS user, emails, pairing codes, token files, "hermes update" |
| `teardown.sh` | stops the local Weft gateway, the demo Hermes gateway and tmux; deletes `/tmp/shop*`, `/tmp/hx` |

Prompts typed into the sessions (on screen): both — “Read pricing.py and cart.py. No changes yet.”;
A — “In pricing.py only, change calc_total to calc_total(items, opts) and multiply the sum by
1 + opts['tax'].”; B — “In cart.py, add cart_total(items) that returns round(calc_total(items), 2).
If Weft blocks the edit, don't retry: quote its error.”; then `/weft status`.

Why B is told not to retry: Hermes's CLI doesn't print a tool call that a `pre_tool_call` hook
blocked, so the rejection reaches the screen only through the model quoting it. Left alone, B
re-read its own (still old) `pricing.py` and retried; once a diagnostic has been delivered the log
base advances, and the retry was accepted. That is by design (an informed agent may proceed), but
the diagnostic doesn't carry the new signature, so the model had nothing to adapt to.
