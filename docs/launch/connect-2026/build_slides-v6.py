#!/usr/bin/env python3
"""Build the visual Connect 2026 deck (slides.html), offline, single file, stdlib only.

Slide order (rev 6, criteria-led): 1 headline, 2 what I built (criterion 1), 3-4 why it's new
(criterion 2), 5-10 the four questions (criterion 3: Q1 slide 5, Q2 slides 6-8 with the without-Weft
and with-Weft clips, Q3 slide 9, Q4 slide 10), 11 why Artifacts + Cloudflare, 12 close.
Inputs: demo/video/connect-2026/stills/*.png, qr-weft.svg, the 22 s "without Weft" clip
(demo/video/connect-2026/baseline.mp4, recorded from baseline.tape), and the 47 s squiggle clip, which is
reused from slides-story-v1.html (data:video/mp4). The story version build is
build_slides-story-v1.py. `--count` prints the spoken word count of pitch.md and talk time incl. clips.
Keys: right/left (or tap right/left quarter) to move, F full screen, M toggles clip sound (clips start muted).
"""
import base64, pathlib, re, sys

HERE = pathlib.Path(__file__).resolve().parent
ROOT = HERE.parents[2]
STILLS = ROOT / "demo/video/connect-2026/stills"

CLIPS = {6: 22.44, 7: 47.03}  # slide number -> clip seconds (narration runs over the clip)

def count_words():
    """Spoken words (quoted text in section bodies) and talk time incl. clips at 130 wpm."""
    body = (HERE / "pitch-v6.md").read_text().split("\n---\n")[1]
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

def baseline_clip():
    return "data:video/mp4;base64," + base64.b64encode((ROOT / "demo/video/connect-2026/baseline.mp4").read_bytes()).decode()

def clip():
    src = (HERE / "slides-story-v1.html").read_text()
    m = re.search(r'data:video/mp4;base64,[A-Za-z0-9+/=]+', src)
    if not m:
        sys.exit("clip not found in slides-story-v1.html")
    return m.group(0)

def chips(items):
    return "".join(f'<span class="chip {c}">{t}</span>' for t, c in items)

def slides():
    qr = (HERE / "qr-weft.svg").read_text() if (HERE / "qr-weft.svg").exists() else ""
    harness = chips([("Claude Code", "live"), ("Codex", "live"), ("OpenCode", "live"), ("Hermes", "live"),
                     ("Cursor", "wr"), ("Gemini", "wr"), ("File watcher: any editor, people too", "wt")])
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
        f'''<section class="hero"><p class="kicker">1 · What I built: an open protocol (WCP) + a platform on Cloudflare</p><img src="{img("02-live-log.png")}" alt="Weft live feed">
<p class="cap">weft.elier.ai · every agent edit, in order, live · Weft coordinated the agents that built Weft: <b>918</b> events · <b>27</b> landings</p></section>''',
        '''<section><p class="kicker">2 · Why it's new</p>
<h1 class="nov">Agents message each other <span class="red">in squiggles</span>.</h1>
<pre class="code"><span class="ln">src/cart.ts  4</span>  const total = <span class="sqe">calcTotal(items)</span>;
<span class="err">[weft error] stale_assumption src/cart.ts:4:42
You use src/pricing.ts#calcTotal, whose signature
changed in #3 by agent-a after your base #1.</span>
<span class="del">-export function calcTotal(items: Item[]): number {</span>
<span class="add">+export function calcTotal(items: Item[], opts: PriceOptions): number {</span></pre>
<p class="sub">Delivered into the agent's own run, <b>mid-edit</b>, carrying the other agent's code.<br>Others check a change <span class="dim">when it lands</span>. Weft checks every edit <span class="red">while it's being written</span>.</p></section>''',
        f'''<section><p class="kicker">2 · Why it's new</p>
<h1 class="huge2">Coordinates,<br><span class="red">doesn't orchestrate.</span></h1>
<p class="sub">No agent on top splitting the work. <b>Agents are peers.</b></p>
<div class="chips">{harness}</div>
<p class="src"><span class="lg live"></span>live today &nbsp; <span class="lg wr"></span>adapter written &nbsp; <span class="lg wt"></span>observes, can't refuse</p>
<p class="sub">The protocol runs on a laptop, no Cloudflare account. <b>Cloudflare is how it scales.</b></p></section>''',
        '''<section><p class="kicker">3 · Many agents at once · Question 1 of 4</p>
<h2 class="q">How do agents know what other agents are working on?</h2>
<svg viewBox="0 0 1600 560" class="diag">
<g class="agent"><rect x="40" y="20" width="300" height="110" rx="18"/><text x="190" y="88">Agent A</text></g>
<g class="agent"><rect x="40" y="225" width="300" height="110" rx="18"/><text x="190" y="293">Agent B</text></g>
<g class="agent"><rect x="40" y="430" width="300" height="110" rx="18"/><text x="190" y="498">Agent C</text></g>
<path class="flow" d="M340 75 C560 75 560 280 700 280"/><path class="flow d2" d="M340 280 L700 280"/><path class="flow d3" d="M340 485 C560 485 560 280 700 280"/>
<g class="do"><rect x="700" y="150" width="520" height="260" rx="22"/><text x="960" y="235">One ordered log per repo</text><text x="960" y="290" class="dim">one Durable Object</text><text x="960" y="345" class="dim">intent · claim · edit · checkpoint</text></g>
<path class="flow ok" d="M1220 280 L1380 280"/><g class="agent"><rect x="1380" y="225" width="190" height="110" rx="18"/><text x="1475" y="293">main</text></g>
</svg>
<p class="sub">Every edit is checked against the <b>functions and types other agents just changed</b>.</p></section>''',
        f'''<section class="hero"><p class="kicker">3 · Question 2 of 4 · Conflicting changes · without Weft, a real run</p><video data-clip muted playsinline preload="auto" src="{baseline_clip()}"></video>
<p class="cap">Both branches green alone → git merges cleanly → <span class="red">build breaks on main</span></p></section>''',
        f'''<section class="hero"><p class="kicker">3 · Question 2 of 4 · Conflicting changes · with Weft</p><video data-clip muted playsinline preload="auto" src="{clip()}"></video>
<p class="cap">Claude Code changes <code>createSession</code> → Codex's edit is refused → it adapts → accepted</p></section>''',
        f'''<section><p class="kicker">3 · Question 2 of 4 · How Weft resolves it</p>
<h2 class="q">What happens when they make conflicting changes?</h2>
<ol class="steps">{resolve}</ol></section>''',
        f'''<section><p class="kicker">3 · Question 3 of 4</p>
<h2 class="q">How do you review everything they produce?</h2>
<p class="sub">An evidence pipeline for every candidate:</p>
<ol class="pipe">{review}</ol>
<ul class="why sm"><li>Low risk lands on its own. <b>Higher risk waits for a human.</b></li>
<li>Production errors spike after a landing → <span class="red">Weft reverts it.</span></li></ul></section>''',
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
<div class="stack">
<div class="layer l1"><b>Artifacts</b>a fork + a scoped token per agent, in one call · millions of repos</div>
<div class="layer l2"><b>Queues</b>every push arrives as an event</div>
<div class="layer l3"><b>Atomic landing</b>a lease push: trunk moves only if nothing moved</div>
<div class="layer l4"><b>Durable Objects</b>exactly one authoritative log per repo</div>
</div></section>''',
        f'''<section class="center"><h1 class="mid">Red squiggles<br>for teams of coding <span class="red sq">agents</span>.</h1>
<p class="tag">Coordinates, doesn't orchestrate.</p>
<div class="close"><div class="qr">{qr}</div><div><p class="url">weft.elier.ai</p><p class="sub">I'm looking for my next builder role.<br>John Nelson</p></div></div></section>''',
    ]

CSS = """*{box-sizing:border-box;margin:0}html,body{height:100%;background:#0a0a10;color:#f2f2f5;font-family:-apple-system,BlinkMacSystemFont,"Inter","Segoe UI",sans-serif;overflow:hidden}
section{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;padding:6vh 7vw;gap:3.2vh}
section.on{display:flex}.bg{background-size:cover;background-position:center}
.huge{font-size:7.4vw;line-height:1.02;font-weight:800;letter-spacing:-.02em}.mid{font-size:5vw;line-height:1.08;font-weight:800}.nov{font-size:4.1vw;line-height:1.12;font-weight:800;letter-spacing:-.01em}
.red{color:#ff4d5e}.sq{text-decoration:underline wavy #ff4d5e;text-underline-offset:.18em}
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
section.on .layer{animation:in .5s ease-out forwards}.l2{animation-delay:.35s!important}.l3{animation-delay:.7s!important}.l4{animation-delay:1.05s!important}
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
@media (orientation:portrait){.huge2{font-size:10vw}.q{font-size:6vw}.lede{max-width:none}.tag{font-size:6vw}.code{font-size:2.15vw;padding:1.2vh 2vw;white-space:pre-wrap;word-break:break-all}.code.tr{font-size:2.3vw}.chip{font-size:3.6vw}.lg{width:2.4vw;height:2.4vw}
.steps{grid-template-columns:1fr}.steps li{min-height:auto;font-size:3.2vw;padding:1vh 2vw}.steps b{font-size:4.4vw;display:inline;margin-right:2vw}.steps em{display:inline;font-size:3.6vw}
.pipe{grid-template-columns:repeat(2,1fr)}.pipe li{font-size:3.6vw}.pipe small{font-size:2.8vw}.why.sm{font-size:4.2vw}.layer b{width:auto}}"""

JS = """const S=[...document.querySelectorAll('section')];let i=Math.max(0,Math.min(S.length-1,(parseInt(location.hash.slice(1))||1)-1));
const N=document.querySelector('.n');
function go(k){S[i].classList.remove('on');S[i].querySelectorAll('video').forEach(v=>v.pause());i=Math.max(0,Math.min(S.length-1,k));
S[i].classList.add('on');S[i].querySelectorAll('video').forEach(v=>{v.muted=true;v.currentTime=0;v.play().catch(()=>{})});N.textContent=(i+1)+' / '+S.length;history.replaceState(null,'','#'+(i+1))}
addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' ','Enter'].includes(e.key))go(i+1);else if(['ArrowLeft','PageUp','Backspace'].includes(e.key))go(i-1);
else if(e.key==='m'||e.key==='M'){S[i].querySelectorAll('video').forEach(v=>{v.muted=!v.muted})}
else if(e.key==='f'||e.key==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen().catch(()=>{})}});
addEventListener('click',e=>{if(e.target.tagName==='VIDEO'&&e.target.paused){e.target.play();return}go(e.clientX<innerWidth/4?i-1:i+1)});go(i);"""

def build():
    body = "\n".join(slides())
    html = f'<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Weft · Connect 2026</title><style>{CSS}</style></head><body>{body}<div class="n"></div><script>{JS}</script></body></html>'
    (HERE / "slides-v6.html").write_text(html)
    print(f"slides.html: {len(slides())} slides, {len(html)/1e6:.1f} MB")

if __name__ == "__main__":
    count_words() if "--count" in sys.argv else build()
