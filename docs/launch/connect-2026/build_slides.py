#!/usr/bin/env python3
"""Build the visual Connect 2026 deck (slides.html), offline, single file, stdlib only.

Rev 7.1 (card t_d28190c3) = rev 7 + two Archify diagrams (diagrams/*.json -> *.html, static *.png
embedded here): the system architecture beside the live feed on slide 2, and the conflict sequence
beside the five steps on slide 9 (slide 10 since the WCP slide). Each slide links its interactive diagram (opens in a new tab, in
Archify's presentation view on the highlighted path); clicking a link does not advance the deck.
Slide order (rev 7.1, Oct 21 + the WCP slide, card t_49fb8a75): 1 headline, 2-3 what I built (criterion 1;
3 = WCP, the protocol, from docs/protocol/wcp-explained.md), 4-5 why it's new (criterion 2), 6-12 the four
questions (criterion 3: Q1 slide 6, Q2 slides 7-10 with the without-Weft, with-Weft and Otto team-run
clips, Q3 slide 11, Q4 slide 12), 13 why Artifacts + Cloudflare, 14 close.
Card t_26e387d8 (Oct 21, from the site weft-site.elier.ai, wording verbatim from site/public/index.html): slide 2 =
"Merge time is too late." + the dogfood numbers (demo/video/dogfood-stats.json); slide 3 = the site's Hook / Sequence /
Answer + its architecture diagram (diagrams/site-architecture.webp) + AAIF line + honesty note + one-pager QR; slide 4 = the
site's real Codex tool result; slide 11 + "Humans get a feed, not a merge queue."; slide 13 = the site's product list;
slide 14 QR -> weft-site.elier.ai + the five-minute call to action. The Archify architecture diagram left the deck (still
on the review page's Diagrams section).
Inputs: demo/video/connect-2026/stills/*.png, qr-weft-site.svg (closing QR), qr-wcp-explained.svg (slide 3 QR to the one-pager), the 22 s "without Weft" clip
(demo/video/connect-2026/baseline.mp4, recorded from baseline.tape), the 47 s squiggle clip, which is
reused from slides-story-v1.html (data:video/mp4), and the 58 s Otto clip
(demo/video/connect-2026/otto-weft-demo-cut.mp4 = demo/otto/video/cut.py output, run-4, card t_83def502;
also on R2 under connect-2026/review-.../otto-demo/). The mp4s are gitignored; slides.html embeds them. The story version build is
build_slides-story-v1.py. `--count` prints the spoken word count of pitch.md and talk time incl. clips.
Keys: right/left (or tap: left quarter = back, else forward; or swipe left/right on touch) to move, F full screen, M toggles clip sound (clips start muted).
"""
import base64, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STILLS = ROOT / "demo/video/connect-2026/stills"

CLIPS = {7: 22.44, 8: 47.03, 9: 58.1}  # slide number -> clip seconds (narration runs over the clip)

def count_words():
    """Spoken words (quoted text in section bodies) and talk time incl. clips at 130 wpm."""
    body = (HERE / "pitch.md").read_text().split("\n---\n")[1]
    n = t = 0
    for sec in body.split("\n## ")[1:]:
        head, rest = sec.split("\n", 1)
        w = sum(len(q.split()) for q in re.findall(r'"([^"]+)"', rest, re.S))
        k = int(re.search(r"Slides? (\d+)", head).group(1))
        n += w; t += max(w / 130 * 60, CLIPS.get(k, 0))
    print(f"spoken words: {n} -> {n/130:.2f} min at 130 wpm; with clips {int(t//60)}:{int(t%60):02d}")
    return n

def img(name):
    return "data:image/png;base64," + base64.b64encode((STILLS / name).read_bytes()).decode()

DIAG = HERE / "diagrams"

def diag(name):
    return "data:image/png;base64," + base64.b64encode((DIAG / f"{name}.png").read_bytes()).decode()

# Interactive views (relative: the deck and diagrams/ are published side by side on the review page).
ARCH_URL = "diagrams/architecture.html?present=1&theme=dark#route=agents~land"
CONFLICT_URL = "diagrams/conflict.html?present=1&theme=dark#route=coord~codex"

def site_arch():
    """The site's architecture diagram (site/public/assets/img/architecture.webp), margins cropped to
    diagrams/site-architecture.webp (1708x600, no redraw), on the WCP slide (card t_26e387d8)."""
    return "data:image/webp;base64," + base64.b64encode((DIAG / "site-architecture.webp").read_bytes()).decode()

def baseline_clip():
    return "data:video/mp4;base64," + base64.b64encode((ROOT / "demo/video/connect-2026/baseline.mp4").read_bytes()).decode()

def otto_clip():
    return "data:video/mp4;base64," + base64.b64encode((ROOT / "demo/video/connect-2026/otto-weft-demo-cut.mp4").read_bytes()).decode()

def clip():
    src = (HERE / "slides-story-v1.html").read_text()
    m = re.search(r'data:video/mp4;base64,[A-Za-z0-9+/=]+', src)
    if not m:
        sys.exit("clip not found in slides-story-v1.html")
    return m.group(0)

def chips(items):
    return "".join(f'<span class="chip {c}">{t}</span>' for t, c in items)

def slides():
    # closing QR -> https://weft-site.elier.ai/ (qrcode SvgPathImage, EC M; card t_26e387d8). qr-weft.svg (weft.elier.ai) is kept for older revs.
    qr = (HERE / "qr-weft-site.svg").read_text().split("?>", 1)[-1].strip()
    # QR to the full one-pager (docs/protocol/wcp-explained.md) on the WCP slide; qrcode SvgPathImage, EC M (card t_03b89786)
    qr_wcp = (HERE / "qr-wcp-explained.svg").read_text().split("?>", 1)[-1].strip().replace('id="qr-path"', 'id="qr-wcp-path"')
    harness = chips([("Claude Code", "live"), ("Codex", "live"), ("OpenCode", "live"), ("Hermes", "live"),
                     ("Gemini CLI", "live"), ("Cursor", "wr"), ("File watcher: any editor, people too", "wt")])
    resolve = "".join(f'<li style="--i:{i}"><b>{i+1}</b><em>{h}</em>{d}</li>' for i, (h, d) in enumerate([
        ("Refused before it's written", "a stale_assumption squiggle quotes the other agent's change"),
        ("Reroute or negotiate", "propose an overload · accept · counter"),
        ("Priority decides who adapts", "same rule every time: no deadlocks"),
        ("Structural merge", "Mergiraf, not line-by-line"),
        ("Land", "compare-and-swap on trunk: main moves only if nothing moved")]))
    review = "".join(f'<li style="--i:{i}">{t}</li>' for i, t in enumerate([
        "Tests", "Preview", "Screenshots<br>+ pixel diff", "Risk tier", "Review agent<br><small>acceptance criteria, fails closed</small>"]))
    return [
        f'''<section class="bg" style="background-image:linear-gradient(90deg,rgba(10,10,16,.94) 42%,rgba(10,10,16,.35)),url({img("04-squiggle.png")})">
<h1 class="huge">Red squiggles<br>for teams of<br>coding <span class="red sq">agents</span>.</h1>
<p class="sub lede">Weft checks every agent edit against what the other agents just changed, and tells the agent <b>before the conflict exists</b>.</p>
<p class="src">John Nelson · Weft</p></section>''',
        f'''<section><p class="kicker">1 · What I built · the problem it solves</p>
<h1 class="nov">Merge time is too late.</h1>
<div class="prob"><p class="sub">Git coordinates people when they open a pull request. Agents in parallel worktrees break each other's assumptions every few minutes. By the time the PR shows a conflict, an agent has spent an hour building on a function signature that no longer exists.</p>
<figure class="shot"><img src="{img("02-live-log.png")}" alt="Weft live feed"><figcaption>weft.elier.ai · every agent edit, in order, live</figcaption></figure></div>
<p class="src nums">Built by agents, under Weft · first 11 hours: <b>627</b> events · <b>460</b> edits from three agent profiles · <b>18</b> landings, zero reverts · <b>59</b> &ldquo;wait for the other agent&rdquo; warnings <span class="fine">(repo weft, 2026-10-04, 03:24&ndash;14:40 UTC · dogfood-stats.json)</span></p></section>''',
        f'''<section class="wcps"><p class="kicker">1 · What I built · the protocol</p>
<h1 class="nov h3l">One ordered log per repo.<br><span class="red">The verdict goes back to the agent.</span></h1>
<div class="how"><ol class="hsa">
<li style="--i:0"><em>Hook</em>An adapter catches each Edit, Write or apply_patch call before it touches disk, and records the symbols it reads and writes.</li>
<li style="--i:1"><em>Sequence</em>One Durable Object per repo orders every edit and checks it against everything that landed since the agent's base, down to the symbol.</li>
<li style="--i:2"><em>Answer</em>Allow, advise or deny. A denied agent gets a compiler-style diagnostic in its tool result, and exactly one side is told to adapt.</li></ol>
<div class="howr"><figure class="arch"><img src="{site_arch()}" alt="Diagram: Claude Code, Codex, OpenCode, a file watcher and Hermes send edits through adapters to the Weft gateway (WCP over HTTP/WebSocket), which forwards them to a per-repo sequencer Durable Object that checks each edit against everything that landed since the agent's base; a strictly ordered log #1 to #8"></figure>
<div class="foot"><div class="ft"><p class="aaif">Proposed to the AAIF (Agentic AI Foundation): <b>Agent Hooks Core + WCP</b>, in collaboration with members of Gas Town.</p>
<p class="fine">WCP v0.1 is a draft and Weft is a research prototype. The analyzer understands TypeScript today.</p></div>
<figure class="qrw"><div class="qr">{qr_wcp}</div><figcaption><b>Full one-pager</b>wcp-explained.md</figcaption></figure></div></div></div></section>''',
        '''<section><p class="kicker">2 · Why it's new</p>
<h1 class="nov">Agents message each other <span class="red">in squiggles</span>.</h1>
<div class="term"><div class="tbar">codex-b (Codex CLI), tool result from the Weft pre-edit hook</div><pre class="code tres"><span class="err">[weft] Edit to src/api/account.ts, test/signup.test.ts blocked: it conflicts with another agent's change
  (Weft edit-time coordination, log #9).
[weft error] stale_assumption src/api/account.ts:17:25: You use <span class="sqe">src/auth/session.ts#createSession</span>, whose
  signature changed in #3 by claude-a after your base #1. (caused by claude-a, task T-1, event #3).
  Suggestion: Read the new src/auth/session.ts#createSession (event #3) and update this call site, or
  negotiate with claude-a.</span>
<span class="inf">  ↳ event #3 by claude-a changed src/auth/session.ts (their change is not in your checkout yet):</span>
<span class="del">    -export function createSession(userId: string): Session {</span>
<span class="add">    +export function createSession(userId: string, opts: SessionOptions): Session {</span></pre></div>
<p class="sub"><b>The agent reads the diagnostic. You don't have to.</b><br>Others check a change <span class="dim">when it lands</span>. Weft checks every edit <span class="red">while it's being written</span>.</p></section>''',
        f'''<section><p class="kicker">2 · Why it's new</p>
<h1 class="huge2">Coordination,<br><span class="red">not Orchestration</span></h1>
<p class="sub">No agent on top splitting the work. <b>Agents are peers.</b></p>
<div class="chips">{harness}</div>
<p class="src"><span class="lg live"></span>live today &nbsp; <span class="lg wr"></span>adapter written &nbsp; <span class="lg wt"></span>observes, can't refuse</p>
<p class="sub">The protocol runs on a laptop, no Cloudflare account. <b>Cloudflare is how it scales.</b></p></section>''',
        f'''<section><p class="kicker">3 · Many agents at once · Question 1 of 4</p>
<h2 class="q">How do agents know what other agents are working on?</h2>
<div class="q1"><svg viewBox="0 0 1600 560" class="diag">
<g class="agent"><rect x="40" y="20" width="300" height="110" rx="18"/><text x="190" y="88">Agent A</text></g>
<g class="agent"><rect x="40" y="225" width="300" height="110" rx="18"/><text x="190" y="293">Agent B</text></g>
<g class="agent"><rect x="40" y="430" width="300" height="110" rx="18"/><text x="190" y="498">Agent C</text></g>
<path class="flow" d="M340 75 C560 75 560 280 700 280"/><path class="flow d2" d="M340 280 L700 280"/><path class="flow d3" d="M340 485 C560 485 560 280 700 280"/>
<g class="do"><rect x="700" y="150" width="520" height="260" rx="22"/><text x="960" y="235">One ordered log per repo</text><text x="960" y="290" class="dim">one Durable Object</text><text x="960" y="345" class="dim">intent · claim · edit · checkpoint</text></g>
<path class="flow ok" d="M1220 280 L1380 280"/><g class="agent"><rect x="1380" y="225" width="190" height="110" rx="18"/><text x="1475" y="293">main</text></g>
</svg><figure class="shot"><img src="{img("09-otto-board.png")}" alt="Otto board: Running 7, Weft editing now"><figcaption>The Otto run: 7 cards, who is editing what, live</figcaption></figure></div>
<p class="sub">Every edit is checked against the <b>functions and types other agents just changed</b>.</p></section>''',
        f'''<section class="hero"><p class="kicker">3 · Question 2 of 4 · Conflicting changes · without Weft, a real run</p><video data-clip muted playsinline preload="auto" src="{baseline_clip()}"></video>
<p class="cap">Both branches green alone → git merges cleanly → <span class="red">build breaks on main</span></p></section>''',
        f'''<section class="hero"><p class="kicker">3 · Question 2 of 4 · Conflicting changes · with Weft</p><video data-clip muted playsinline preload="auto" src="{clip()}"></video>
<p class="cap">Claude Code changes <code>createSession</code> → Codex's edit is refused → it adapts → accepted</p></section>''',
        f'''<section class="hero"><p class="kicker">3 · Question 2 of 4 · A whole team, in Otto · a real run</p><video data-clip muted playsinline preload="auto" src="{otto_clip()}"></video>
<p class="cap">7 cards at once · candidates on 5 harnesses · <b>no agent in charge</b> · 6 squiggles, all rerouted · all 7 landed</p></section>''',
        f'''<section><p class="kicker">3 · Question 2 of 4 · How Weft resolves it</p>
<h2 class="q">What happens when they make conflicting changes?</h2>
<div class="q2r"><ol class="steps v">{resolve}</ol>
<figure class="dg"><img src="{diag("conflict")}" alt="Conflict sequence: B's check is rejected with stale_assumption, the adapter denies the edit with a squiggle quoting A's hunk, B reroutes or negotiates, Workflows rebase with Mergiraf and land by CAS on trunk">
<figcaption>Traced from the code · deny → reroute as in the M1 run (Claude Code vs Codex) · <a href="{CONFLICT_URL}" target="_blank" rel="noopener">interactive ↗</a></figcaption></figure></div></section>''',
        f'''<section><p class="kicker">3 · Question 3 of 4</p>
<h2 class="q">How do you review everything they produce?</h2>
<p class="hl">Humans get a feed, not a merge queue.</p>
<p class="sub">An evidence pipeline for every candidate:</p>
<ol class="pipe">{review}</ol>
<div class="q3"><ul class="why sm"><li>Low risk lands on its own. <b>Higher risk waits for a human.</b></li>
<li>Production errors spike after a landing → <span class="red">Weft reverts it.</span></li>
<li class="dim">In the Otto run: a planted bug was reverted <b>32 s</b> after it landed.</li></ul>
<img src="{img("10-otto-revert.png")}" alt="Otto: landing reverted after a production error spike"></div></section>''',
        '''<section><p class="kicker">3 · Question 4 of 4</p>
<h2 class="q">How do you keep track of <span class="red">why</span>?</h2>
<pre class="code tr">Change-Id: I2e59ce5c1eaa4d57a28a2a5c8f9458bdcd8fd4f3
Task-Id:   agent-issue-4-continue
Agent-Id:  wt-4-agent-issue-4-continue</pre>
<ul class="why sm"><li>Every commit carries its change, task and agent.</li>
<li>Every squiggle cites the event that caused it <span class="dim">(#834 ← #813)</span>.</li>
<li>The log replays byte for byte · each run's model transcript is stored.</li>
<li>A revert names the operation it undoes, and why.</li></ul></section>''',
        '''<section><p class="kicker">Why Artifacts + Cloudflare</p>
<p class="sub">Weft doesn't need Artifacts to work. <b>Artifacts is how it scales.</b></p>
<div class="stack s5">
<div class="layer l1"><b>Durable Objects</b>One authoritative, ordered log and submit queue per repo.</div>
<div class="layer l2"><b>Artifacts</b>The trunk, plus an isolated fork for every candidate change.</div>
<div class="layer l3"><b>Queues and Workflows</b>Durable, retryable processing, selection, landing and auto-revert.</div>
<div class="layer l4"><b>Containers</b>Git, builds and tests in a sandbox, with credentials kept outside.</div>
<div class="layer l5"><b>D1 and R2</b>An index of tasks and changes, and the evidence behind each one.</div>
</div></section>''',
        f'''<section class="center"><h1 class="mid">Red squiggles<br>for teams of coding <span class="red sq">agents</span>.</h1>
<p class="tag">Coordination, not Orchestration</p>
<div class="close"><div class="qr">{qr}</div><div><p class="cta">Two agents, one repo, five minutes.<br><span>No Cloudflare account needed.</span></p><p class="url">weft-site.elier.ai</p><p class="sub">John Nelson · johnaaronnelson.com · github.com/celador</p></div></div></section>''',
    ]

CSS = """*{box-sizing:border-box;margin:0}html,body{height:100%;background:#0a0a10;color:#f2f2f5;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;overflow:hidden}
html,body{touch-action:manipulation}section{cursor:pointer;-webkit-tap-highlight-color:transparent}
section{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;padding:6vh 7vw;gap:3.2vh}
section.on{display:flex}.bg{background-size:cover;background-position:center}
.huge{font-size:7.4vw;line-height:1.02;font-weight:800;letter-spacing:-.02em}.mid{font-size:5vw;line-height:1.08;font-weight:800}.nov{font-size:4.1vw;line-height:1.12;font-weight:800;letter-spacing:-.01em}
.red{color:#ff4d5e}.sq{text-decoration:underline wavy #ff4d5e;text-underline-offset:.21em;text-decoration-skip-ink:none}
.sub{font-size:2.3vw;color:#c9c9d6;line-height:1.35}.kicker{font-size:1.9vw;letter-spacing:.12em;text-transform:uppercase;color:#ff4d5e;font-weight:700}
.src{font-size:1.7vw;color:#9a9aab}.dim{color:#9a9aab}
.stats{display:flex;gap:5vw}.stats div{font-size:2.2vw;color:#c9c9d6}.stats b{display:block;font-size:8vw;color:#fff;line-height:1}
.stats.small b{font-size:4.6vw}.stats.small{gap:4vw}
.hero{padding:2vh 2vw;align-items:center;gap:1.6vh}.hero .kicker{align-self:flex-start}.hero img,.hero video{max-width:100%;max-height:78vh;border-radius:14px;box-shadow:0 0 0 1px #333}
.cap{font-size:1.9vw;color:#c9c9d6}code{color:#ff8a95}
.center{align-items:center;text-align:center}
.diag{width:100%;height:auto;max-height:76vh}.diag rect{fill:#171722;stroke:#3a3a4c;stroke-width:3}.diag text{fill:#f2f2f5;font-size:34px;text-anchor:middle;font-weight:600}
.diag .do rect{fill:#1d1430;stroke:#f6821f}.diag text.dim{fill:#b0b0c0;font-size:30px;font-weight:400}.diag .redt{fill:#ff4d5e;font-size:32px}
.flow{fill:none;stroke:#7aa2ff;stroke-width:6;stroke-dasharray:18 14;animation:dash 1.2s linear infinite}.flow.ok{stroke:#4ade80}
.back{fill:none;stroke:#ff4d5e;stroke-width:6;stroke-dasharray:1200;stroke-dashoffset:1200}
section.on .back{animation:draw 1.6s 1.4s ease-out forwards}
@keyframes dash{to{stroke-dashoffset:-64}}@keyframes draw{to{stroke-dashoffset:0}}
.stack{display:flex;flex-direction:column;gap:1.6vh}.layer{font-size:2.2vw;padding:2.2vh 2vw;border-radius:14px;background:#171722;border-left:10px solid #f6821f;color:#c9c9d6;opacity:0;transform:translateX(-30px)}
.layer b{color:#fff;display:inline-block;width:28vw}
section.on .layer{animation:in .5s ease-out forwards}.l2{animation-delay:.3s!important}.l3{animation-delay:.6s!important}.l4{animation-delay:.9s!important}.l5{animation-delay:1.2s!important}
@keyframes in{to{opacity:1;transform:none}}
.loop{list-style:none;padding:0;display:grid;grid-template-columns:repeat(5,1fr);gap:1.2vw}
.loop li{background:#171722;border-radius:12px;padding:1.4vh .8vw;font-size:1.7vw;color:#d6d6e0;min-height:11vh;opacity:0}
section.on .loop li{animation:in .3s calc(var(--i)*.12s) forwards}.loop b{display:block;color:#ff4d5e;font-size:2.4vw}
.why{list-style:none;padding:0;display:flex;flex-direction:column;gap:2.6vh;font-size:2.7vw;line-height:1.2}
.close{display:flex;gap:4vw;align-items:center;margin-top:3vh;text-align:left}.qr svg{width:22vh;height:22vh;background:#fff;padding:1vh;border-radius:12px}
.url{font-size:3.6vw;font-weight:800}
.n{position:fixed;right:2vw;bottom:2vh;font-size:1.2vw;color:#777}
.track{position:relative;display:grid;grid-template-columns:repeat(4,1fr);margin:2vh 0 1vh}.tl{position:absolute;left:12.5%;right:12.5%;top:1.6vw;height:6px;background:#3a3a4c}
.st{position:relative;text-align:center;font-size:2vw;color:#c9c9d6}.st i{display:block;width:3.2vw;height:3.2vw;margin:0 auto 1.2vh;border-radius:50%;background:#171722;border:5px solid #3a3a4c}
.st b{display:block;color:#fff}.st span{display:block;font-size:1.7vw;margin-top:.6vh}
.st.hit i{background:#ff4d5e;border-color:#ff4d5e;box-shadow:0 0 0 0 #ff4d5e88;animation:pulse 1.6s infinite}.st.hit span{color:#ff4d5e;font-weight:700}.st.late span{color:#8b8b9c}
@keyframes pulse{70%{box-shadow:0 0 0 2.4vw #ff4d5e00}100%{box-shadow:0 0 0 0 #ff4d5e00}}
@media (orientation:portrait){.nov{font-size:6.4vw}.huge{font-size:11vw}.mid{font-size:8vw}.sub{font-size:4.2vw}.kicker{font-size:3.4vw}.stats{flex-wrap:wrap}.stats b{font-size:13vw}.stats div{font-size:3.6vw}.stats.small b{font-size:9vw}
.cap,.src{font-size:3vw}.st{font-size:3.4vw}.st span{font-size:2.8vw}.track{margin:1vh 0}.layer{font-size:3.6vw}.layer b{width:auto;display:block}.loop{grid-template-columns:repeat(3,1fr)}.loop li{font-size:2.8vw;min-height:auto}.loop b{font-size:4vw}.why{font-size:5vw}.url{font-size:7vw}.close{flex-direction:column}.n{font-size:3vw}}
.huge2{font-size:6.6vw;line-height:1.02;font-weight:800;letter-spacing:-.02em}.q{font-size:3.6vw;line-height:1.12;font-weight:800}
.lede{max-width:52vw}.tag{font-size:3.2vw;font-weight:800;color:#ff4d5e;margin-top:-1vh}
.code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.7vw;line-height:1.45;background:#12121a;border:1px solid #2c2c3c;border-radius:14px;padding:2.2vh 2vw;color:#d6d6e0;white-space:pre;overflow:hidden}
.code .ln{color:#77778a}.code .sqe{text-decoration:underline wavy #ff4d5e;text-underline-offset:.25em;text-decoration-thickness:2px}
.code .err{color:#ff8a95}.code .del{color:#ff6b6b}.code .add{color:#4ade80}.code.tr{font-size:2.1vw;color:#f6c177}
.chips{display:flex;flex-wrap:wrap;gap:1.2vw}.chip{font-size:2.1vw;padding:1.2vh 1.6vw;border-radius:999px;background:#171722;border:3px solid #3a3a4c;color:#fff;font-weight:600}
.chip.live{border-color:#4ade80}.chip.wr{border-color:#7aa2ff}.chip.wt{border-color:#8b8b9c;border-style:dashed}
.lg{display:inline-block;width:1.2vw;height:1.2vw;border-radius:50%;margin-right:.5vw;vertical-align:middle;border:3px solid}.lg.live{border-color:#4ade80}.lg.wr{border-color:#7aa2ff}.lg.wt{border-color:#8b8b9c;border-style:dashed}
.steps{list-style:none;padding:0;display:grid;grid-template-columns:repeat(5,1fr);gap:1.2vw;margin-top:2vh}
.steps li{background:#171722;border-radius:14px;padding:2.4vh 1.1vw;font-size:1.9vw;line-height:1.3;color:#c9c9d6;min-height:40vh;opacity:0;border-top:8px solid #ff4d5e}
.steps li:last-child{border-top-color:#4ade80}
section.on .steps li{animation:in .35s calc(var(--i)*.18s) forwards}.steps b{display:block;color:#ff4d5e;font-size:3.4vw;line-height:1}.steps li:last-child b{color:#4ade80}
.steps em{display:block;font-style:normal;color:#fff;font-weight:800;font-size:2.4vw;line-height:1.15;margin:1.4vh 0}
.pipe{list-style:none;padding:0;display:grid;grid-template-columns:repeat(5,1fr);gap:1vw}
.pipe li{background:#171722;border-radius:12px;padding:2vh .8vw;font-size:2.1vw;font-weight:700;color:#fff;text-align:center;position:relative;opacity:0;border-bottom:6px solid #f6821f}
.pipe small{display:block;font-size:1.6vw;font-weight:400;color:#c9c9d6;margin-top:.6vh}
section.on .pipe li{animation:in .3s calc(var(--i)*.15s) forwards}
.why.sm{font-size:2.4vw;gap:1.6vh}.layer b{width:22vw}
.q1{display:grid;grid-template-columns:1fr 29vw;gap:2vw;align-items:center}.q1 .diag{max-height:52vh}
.shot{margin:0;text-align:center}.shot img{width:100%;max-height:54vh;object-fit:cover;object-position:top;border-radius:12px;box-shadow:0 0 0 1px #333}
.shot figcaption{font-size:1.45vw;color:#9a9aab;margin-top:.8vh;line-height:1.25}
.q3{display:grid;grid-template-columns:1fr 44vw;gap:2.4vw;align-items:center}.q3 img{width:100%;max-height:42vh;object-fit:contain;border-radius:12px;box-shadow:0 0 0 1px #333}
.why .dim b{color:#c9c9d6}
.built{display:grid;grid-template-columns:1.35fr 1fr;gap:1.6vw;align-items:center;width:100%}.built .feed{width:100%;max-height:70vh;object-fit:contain}
.dg{margin:0;text-align:center}.dg img{width:100%;max-height:68vh;object-fit:contain;border-radius:12px;box-shadow:0 0 0 1px #333;background:#0b0f1a}
.dg figcaption{font-size:1.4vw;color:#9a9aab;margin-top:.8vh}.dg a{color:#7aa2ff;text-decoration:none}
.q2r{display:grid;grid-template-columns:27vw 1fr;gap:2vw;align-items:center}.q2r .dg img{max-height:62vh}
.steps.v{grid-template-columns:1fr;gap:1vh;margin-top:0}.steps.v li{min-height:auto;padding:1.2vh 1vw;font-size:1.45vw;border-top:0;border-left:7px solid #ff4d5e}
.steps.v li:last-child{border-left-color:#4ade80}.steps.v b{display:inline;font-size:2vw;margin-right:.8vw}.steps.v em{display:inline;font-size:1.75vw;margin:0}.steps.v em::after{content:"";display:block;height:.4vh}
.wcp{list-style:none;padding:0;display:flex;flex-direction:column;gap:1.8vh}.wcp li{display:grid;grid-template-columns:3.6vw 1fr;align-items:baseline;font-size:2.25vw;line-height:1.25;color:#c9c9d6;opacity:0}
section.on .wcp li{animation:in .35s calc(var(--i)*.15s) forwards}.wcp b{color:#ff4d5e;font-size:2.6vw;font-weight:800}.wcp em{font-style:normal;color:#fff;font-weight:800}
.log{display:grid;grid-template-columns:1fr 1.15fr 1.25fr;gap:1vw;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:1.45vw}.ev{background:#12121a;border:1px solid #2c2c3c;border-left:7px solid #4ade80;border-radius:10px;padding:1.2vh 1vw;color:#d6d6e0;line-height:1.35}
.ev b{color:#fff;margin-right:.7vw}.ev.no{border-left-color:#ff4d5e;color:#ff8a95}
.wcpg{display:grid;grid-template-columns:1fr auto;gap:2.6vw;align-items:center}.wcpm{display:flex;flex-direction:column;gap:3.2vh}.wcpm .log{font-size:1.3vw;grid-template-columns:.85fr 1.1fr 1.55fr}
.qrw{margin:0;text-align:center}.qrw .qr svg{width:19vh;height:19vh;display:block;margin:0 auto}.qrw figcaption{font-size:1.25vw;color:#9a9aab;margin-top:1vh;line-height:1.3}.qrw figcaption b{display:block;color:#fff;font-size:1.6vw}
@media (orientation:portrait){.wcp li{font-size:4vw;grid-template-columns:6.5vw 1fr}.wcp b{font-size:4.6vw}.log{grid-template-columns:1fr;font-size:3vw;gap:1vh}
.wcpg{grid-template-columns:1fr;gap:2vh}.wcpm .log{font-size:3vw;grid-template-columns:1fr}.qrw{display:flex;align-items:center;gap:4vw;text-align:left}.qrw .qr svg{width:15vh;height:15vh}.qrw figcaption{font-size:3.2vw;margin:0}.qrw figcaption b{font-size:4vw}}
@media (orientation:portrait){.built,.q2r{grid-template-columns:1fr}.dg img,.q2r .dg img{max-height:30vh}.dg figcaption{font-size:2.8vw}.built .feed{max-height:28vh}.steps.v li{font-size:3vw}.steps.v em{font-size:3.4vw}}
@media (orientation:portrait){.q1,.q3{grid-template-columns:1fr}.shot img{max-height:24vh}.shot figcaption{font-size:2.8vw}.q3 img{max-height:22vh}}
@media (orientation:portrait){.huge2{font-size:10vw}.q{font-size:6vw}.lede{max-width:none}.tag{font-size:6vw}.code{font-size:2.15vw;padding:1.2vh 2vw;white-space:pre-wrap;word-break:break-all}.code.tr{font-size:2.3vw}.chip{font-size:3.6vw}.lg{width:2.4vw;height:2.4vw}
.steps{grid-template-columns:1fr}.steps li{min-height:auto;font-size:3.2vw;padding:1vh 2vw}.steps b{font-size:4.4vw;display:inline;margin-right:2vw}.steps em{display:inline;font-size:3.6vw}
.pipe{grid-template-columns:repeat(2,1fr)}.pipe li{font-size:3.6vw}.pipe small{font-size:2.8vw}.why.sm{font-size:4.2vw}.layer b{width:auto}}
.prob{display:grid;grid-template-columns:1fr 46vw;gap:3vw;align-items:center}.prob .sub{font-size:2.5vw;line-height:1.4}.prob .shot img{max-height:56vh}
.nums{font-size:1.5vw;line-height:1.35}.nums b{color:#fff}.fine{font-size:1.15vw;color:#77778a}
.wcps{gap:2.2vh;padding-top:4vh;padding-bottom:4vh}.h3l{font-size:3.2vw}
.how{display:grid;grid-template-columns:26vw 1fr;gap:2.4vw;align-items:start}
.hsa{list-style:none;padding:0;display:flex;flex-direction:column;gap:2.4vh}.hsa li{font-size:1.42vw;line-height:1.38;color:#c9c9d6;border-left:7px solid #ff4d5e;padding:.4vh 0 .4vh 1.3vw;opacity:0}
.hsa li:last-child{border-left-color:#4ade80}section.on .hsa li{animation:in .35s calc(var(--i)*.18s) forwards}
.hsa em{display:block;font-style:normal;color:#fff;font-weight:800;font-size:2vw;margin-bottom:.4vh}
.howr{display:flex;flex-direction:column;gap:2.4vh}.arch{margin:0}.arch img{width:100%;display:block;border-radius:12px;box-shadow:0 0 0 1px #333}
.foot{display:grid;grid-template-columns:1fr auto;gap:2vw;align-items:center}.foot .aaif{font-size:1.35vw;line-height:1.35;color:#c9c9d6}.foot .aaif b{color:#fff}.foot .fine{margin-top:1vh}
.wcps .qrw .qr svg{width:15vh;height:15vh}.wcps .qrw figcaption{font-size:1.1vw}.wcps .qrw figcaption b{font-size:1.35vw}
.term{border:1px solid #2c2c3c;border-radius:14px;overflow:hidden;background:#12121a}.tbar{font-size:1.25vw;color:#9a9aab;background:#1b1b26;padding:1vh 1.4vw;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.code.tres{font-size:1.18vw;line-height:1.5;border:0;border-radius:0}.code .inf{color:#9ab4ff}
.hl{font-size:2.6vw;font-weight:800;color:#ff4d5e;margin-top:-1.4vh}
.cta{font-size:2.6vw;font-weight:800;line-height:1.2;margin-bottom:1.4vh}.cta span{font-size:2vw;font-weight:600;color:#c9c9d6}
.stack.s5 .layer{display:grid;grid-template-columns:24vw 1fr;align-items:center;font-size:2vw;padding:1.9vh 2vw}.stack.s5 .layer b{width:auto}
@media (orientation:portrait){.prob,.how,.foot{grid-template-columns:1fr}.prob .sub{font-size:4vw}.prob .shot img{max-height:26vh}.nums{font-size:3vw}.fine{font-size:2.4vw}
.h3l{font-size:5.6vw}.hsa li{font-size:3.3vw}.hsa em{font-size:4.2vw}.foot .aaif{font-size:3vw}.wcps .qrw .qr svg{width:14vh;height:14vh}.wcps .qrw figcaption{font-size:3vw}.wcps .qrw figcaption b{font-size:3.6vw}
.tbar{font-size:2.4vw}.stack.s5 .layer{grid-template-columns:1fr;font-size:3.4vw}.code.tres{font-size:2.05vw;white-space:pre-wrap;word-break:break-all}.hl{font-size:5vw}.cta{font-size:5vw}.cta span{font-size:4vw}}"""

JS = """const S=[...document.querySelectorAll('section')];let i=Math.max(0,Math.min(S.length-1,(parseInt(location.hash.slice(1))||1)-1));
const N=document.querySelector('.n');
function go(k){S[i].classList.remove('on');S[i].querySelectorAll('video').forEach(v=>v.pause());i=Math.max(0,Math.min(S.length-1,k));
S[i].classList.add('on');S[i].querySelectorAll('video').forEach(v=>{v.muted=true;v.currentTime=0;v.play().catch(()=>{})});N.textContent=(i+1)+' / '+S.length;history.replaceState(null,'','#'+(i+1))}
addEventListener('keydown',e=>{if(['ArrowUp','ArrowDown',' '].includes(e.key))e.preventDefault();if(['ArrowRight','ArrowDown','PageDown',' ','Enter'].includes(e.key))go(i+1);else if(['ArrowLeft','ArrowUp','PageUp','Backspace'].includes(e.key))go(i-1);
else if(e.key==='m'||e.key==='M'){S[i].querySelectorAll('video').forEach(v=>{v.muted=!v.muted})}
else if(e.key==='f'||e.key==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(()=>{})}});
let tapT=0,P=null,T=null;function tap(e){if(e.target.closest('a'))return;tapT=Date.now();if(e.target.tagName==='VIDEO'&&e.target.paused){e.target.play().catch(()=>{});return}go(e.clientX<innerWidth/4?i-1:i+1)}
addEventListener('pointerdown',e=>{P=e.isPrimary&&e.button===0?{x:e.clientX,y:e.clientY}:null});
addEventListener('pointerup',e=>{if(!P||!e.isPrimary||e.button!==0)return;const m=Math.hypot(e.clientX-P.x,e.clientY-P.y);P=null;if(m<12)tap(e)});
addEventListener('pointercancel',()=>{P=null});
addEventListener('click',e=>{if(Date.now()-tapT<800)return;tap(e)});
addEventListener('touchstart',e=>{T=e.touches.length===1?{x:e.touches[0].clientX,y:e.touches[0].clientY}:null},{passive:true});
addEventListener('touchend',e=>{if(!T||e.touches.length)return;const t=e.changedTouches[0],dx=t.clientX-T.x,dy=t.clientY-T.y;T=null;if(Math.abs(dx)>40&&Math.abs(dx)>1.5*Math.abs(dy)){tapT=Date.now();P=null;go(dx<0?i+1:i-1)}},{passive:true});go(i);"""

def build():
    body = "\n".join(slides())
    html = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weft · Connect 2026</title><style>{CSS}</style></head><body>{body}<div class="n"></div><script>{JS}</script></body></html>'
    (HERE / "slides.html").write_text(html)
    print(f"slides.html: {len(slides())} slides, {len(html)/1e6:.1f} MB")

if __name__ == "__main__":
    count_words() if "--count" in sys.argv else build()
