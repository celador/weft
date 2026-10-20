#!/usr/bin/env python3
"""Build the visual Connect 2026 deck (slides.html), offline, single file, stdlib only.

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

CLIPS = {7: 22.44, 8: 47.03}  # slide number -> clip seconds (narration runs over the clip)

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

def baseline_clip():
    return "data:video/mp4;base64," + base64.b64encode((ROOT / "demo/video/connect-2026/baseline.mp4").read_bytes()).decode()

def clip():
    src = (HERE / "slides-story-v1.html").read_text()
    m = re.search(r'data:video/mp4;base64,[A-Za-z0-9+/=]+', src)
    if not m:
        sys.exit("clip not found in slides-story-v1.html")
    return m.group(0)

STEPS = ["Explore", "Decide", "Delegate", "Verify", "Repeat"]

def slides():
    qr = (HERE / "qr-weft.svg").read_text() if (HERE / "qr-weft.svg").exists() else ""
    steps = "".join(f'<li style="--i:{i}"><b>{i+1}</b>{s}</li>' for i, s in enumerate(STEPS))
    return [
        f'''<section class="bg" style="background-image:linear-gradient(90deg,rgba(10,10,16,.92) 38%,rgba(10,10,16,.35)),url({img("04-squiggle.png")})">
<h1 class="huge">I didn't write the code.<br><span class="red">I directed the agents that did.</span></h1>
<p class="sub">I asked the questions and made the decisions.<br>John Nelson · Weft</p></section>''',
        '''<section><p class="kicker">Oct 3, Saturday night → submitted Oct 6</p>
<div class="stats"><div><b>64</b>hours</div><div><b>231</b>files</div><div><b>38,593</b>lines</div></div>
<p class="sub">Every commit authored by an agent.</p>
<div class="stats small"><div><b>627</b>events</div><div><b>460</b>edits</div><div><b>59</b>waits</div></div>
<p class="src">Weft's own log, first 11.3 hours of the build</p></section>''',
        f'''<section class="hero"><p class="kicker">1 · What I built</p><img src="{img("02-live-log.png")}" alt="Weft live feed">
<p class="cap">weft.elier.ai · every agent edit, in order, live · squiggles name the function, the cause, the fix</p></section>''',
        '''<section><p class="kicker">2 · Why it's new</p>
<h1 class="nov">Other systems check a change <span class="dim">when it lands.</span><br>Weft checks every edit<br><span class="red">while the agent is still writing it.</span></h1>
<div class="track"><div class="tl"></div>
<div class="st hit"><i></i><b>Edit</b><span>Weft checks here</span></div>
<div class="st"><i></i><b>Commit</b></div><div class="st"><i></i><b>Pull request</b></div>
<div class="st late"><i></i><b>Merge / land</b><span>others check here</span></div></div>
<p class="sub">Caught before a commit exists: <b>no finished work redone.</b><br>Through an open protocol, WCP, that any agent harness can speak.</p></section>''',
        '''<section><p class="kicker">3 · Many agents at once: how it works</p>
<svg viewBox="0 0 1600 640" class="diag">
<g class="agent"><rect x="40" y="60" width="300" height="110" rx="18"/><text x="190" y="128">Agent A</text></g>
<g class="agent"><rect x="40" y="265" width="300" height="110" rx="18"/><text x="190" y="333">Agent B</text></g>
<g class="agent"><rect x="40" y="470" width="300" height="110" rx="18"/><text x="190" y="538">Agent C</text></g>
<path class="flow" d="M340 115 C560 115 560 320 700 320"/><path class="flow d2" d="M340 320 L700 320"/><path class="flow d3" d="M340 525 C560 525 560 320 700 320"/>
<g class="do"><rect x="700" y="210" width="420" height="220" rx="22"/><text x="910" y="300">One checkpoint per repo</text><text x="910" y="350" class="dim">Durable Object · one shared history</text></g>
<path class="flow ok" d="M1120 290 L1360 290"/><g class="agent"><rect x="1360" y="235" width="210" height="110" rx="18"/><text x="1465" y="303">main</text></g>
<path class="back" d="M910 430 C910 560 600 560 340 540"/>
<text x="640" y="610" class="redt">squiggle back: "createSession changed, here's the diff"</text>
</svg>
<p class="sub">Not "which edit came first" but <b>which change breaks which</b>: B adopts A's new signature, then lands.</p></section>''',
        '''<section><p class="kicker">On Cloudflare · protocol runs anywhere</p>
<div class="stack">
<div class="layer l1"><b>Workers</b>API agents call + the site</div>
<div class="layer l2"><b>Durable Object</b>per-repo sequencer: checks every edit</div>
<div class="layer l3"><b>Artifacts</b>git storage</div>
<div class="layer l4"><b>Workflows + Queues</b>land on main one at a time: rebase, test, advance</div>
</div>
<p class="sub">WCP, the Weft Coordination Protocol · open draft v0.1 · any harness, any host</p></section>''',
        f'''<section class="hero"><p class="kicker">Without Weft · a real run</p><video data-clip muted playsinline preload="auto" src="{baseline_clip()}"></video>
<p class="cap">Both branches green alone → git merges cleanly → <span class="red">build breaks on main</span></p></section>''',
        f'''<section class="hero"><p class="kicker">With Weft</p><video data-clip muted playsinline preload="auto" src="{clip()}"></video>
<p class="cap">Claude Code changes <code>createSession</code> → Codex's edit is refused → it adapts → accepted</p></section>''',
        f'''<section><p class="kicker">Weft coordinated the agents building Weft</p>
<div class="stats small"><div><b>918</b>events</div><div><b>679</b>edits</div><div><b>27</b>landings</div><div><b>60</b>waits</div><div><b>5</b>refused</div></div>
<p class="src">Weft's own log, to Oct 19 · event 834 refused because event 813 changed a type; next try accepted</p>
<ol class="loop">{steps}</ol></section>''',
        '''<section><p class="kicker">Why it matters</p>
<ul class="why"><li>One agent is a tool. Ten agents on one repo is a <b>team</b>.</li>
<li>Today they find out at merge time. <span class="red">Weft moves it to edit time.</span></li>
<li>In two weeks: <b>39</b> stars · a stranger filed <b>22</b> issues &amp; PRs · the Beads team asked how to integrate</li>
<li>Next: a <b>Time Machine</b> for agent work. Previews per revision exist; the timeline isn't built yet.</li>
<li class="dim">Prototype: TypeScript/JavaScript only, not in production yet</li></ul></section>''',
        '''<section class="center"><h1 class="huge">Red squiggles<br>for teams of <span class="red">coding agents</span>.</h1></section>''',
        f'''<section class="center"><h1 class="mid">If the code editor disappears,<br>agents still need <span class="red sq">squiggles</span>.</h1>
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
.cap,.src{font-size:3vw}.st{font-size:3.4vw}.st span{font-size:2.8vw}.track{margin:1vh 0}.layer{font-size:3.6vw}.layer b{width:auto;display:block}.loop{grid-template-columns:repeat(3,1fr)}.loop li{font-size:2.8vw;min-height:auto}.loop b{font-size:4vw}.why{font-size:5vw}.url{font-size:7vw}.close{flex-direction:column}.n{font-size:3vw}}"""

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
    (HERE / "slides.html").write_text(html)
    print(f"slides.html: {len(slides())} slides, {len(html)/1e6:.1f} MB")

if __name__ == "__main__":
    count_words() if "--count" in sys.argv else build()
