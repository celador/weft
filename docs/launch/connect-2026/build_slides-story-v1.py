#!/usr/bin/env python3
# Builds slides.html (story version). Run from anywhere: python3 docs/launch/connect-2026/build_slides.py
import re, base64, html, os
D = os.path.dirname(os.path.abspath(__file__)) + '/'
v1 = open(D + 'slides-feature-v1.html').read()
img = {a: d for d, a in re.findall(r'<img src="(data:[^"]+)" alt="([^"]+)"', v1)}
SITE = img['weft-site.elier.ai home page']
E834 = img['Event #834 blocked by stale_assumption, caused by #813']
QR1 = img['QR code for weft-site.elier.ai']
QR2 = img["QR code for John's Calendly"]
# The squiggle clip (weft-demo-short.mp4 0:37-1:24) is reused from the current slides.html, so the
# deck can be rebuilt without re-downloading the video.
CLIP = re.search(r'<video id="clip" src="(data:video/mp4;base64,[^"]+)"', open(D + 'slides.html').read()).group(1)

def quote(time, step, q, line):
    return f'''<section class="q">
  <p class="kicker">Oct 3 · {time}<span class="step">{step}</span></p>
  <blockquote>{q}</blockquote>
  <p class="lead">{line}</p>
</section>'''

S = []
S.append(f'''<section class="title">
  <div class="split">
    <div>
      <p class="kicker">Cloudflare Connect 2026 · GitHub competition finalist</p>
      <h1>How Weft<br>actually<br>got built.</h1>
      <p class="lead">John Nelson · product engineer, between jobs · La Barra, Uruguay</p>
    </div>
    <figure><img src="{SITE}" alt="weft-site.elier.ai home page"><figcaption>weft-site.elier.ai</figcaption></figure>
  </div>
</section>''')
S.append('''<section class="big">
  <h1>I didn't write the code.<br><span class="hl">Agents did.</span></h1>
  <p class="lead">I asked the questions, made the decisions, and directed the work.<br>Weft coordinated the agents that built it.</p>
</section>''')
S.append(quote('8:45 PM', 'Step 1 · explore', '“They want ‘the next GitHub’. What does that mean? Are they conflating git with GitHub?”', 'Why aren’t git worktrees the easy answer? Agents find out about each other at merge time. Too late.'))
S.append(quote('8:49 PM', 'Step 4 · alternatives', '“Why is it not the obvious answer?”', 'Jujutsu still records history after the fact. Nothing warns two agents before they collide.'))
S.append(quote('9:17 PM', 'Step 2 · specifics', '“An agent uses a ‘tool’, correct? These changes happen in a sequence.”', 'Check every edit as it happens. Send the warning back into the agent’s run.'))
S.append(quote('9:21 PM', 'Step 3 · solutions', '“Think about the little red <span class="sq">squiggles</span>.”<br><small class="qs">“…sort of like a pre-commit hook.”</small>', 'An agent gets an error: another agent just changed this function. Here’s the change.'))
S.append(quote('9:32 PM', 'Steps 5–6 · decide, edge cases', '“A combined event queue that has strict ordering.”<br><small class="qs">“What’s it called… ‘elect’??”</small>', 'Consensus. Decide which edit came first; the order settles every argument.'))
S.append(quote('9:51 PM', 'a standard', '“Are there not tool call hooks with other harnesses? …a new shared standard, like MCP!”', 'Hooks existed. No shared standard. That became WCP, the Weft Coordination Protocol.'))
S.append('''<section class="q">
  <p class="kicker">Oct 3 · 9:57–10:20 PM<span class="step">Steps 7–9 · delegate</span></p>
  <blockquote class="sm">“Spec this all out in a new Kanban board… a heartbeat agent… like a project manager.”</blockquote>
  <blockquote class="sm">“Make decisions… without my intervention.”</blockquote>
  <blockquote class="hl">“We have to assume the code editor disappears in the future.”</blockquote>
</section>''')
S.append('''<section>
  <h2>Then the agents built it.</h2>
  <div class="nums">
    <div><b>10 PM</b><span>first commit, 80 minutes<br>after my first question</span></div>
    <div><b>25</b><span>cards on the board</span></div>
    <div><b>hourly</b><span>project-manager agent<br>checks the board</span></div>
    <div><b>Oct 6</b><span>“I liked the video.<br>Ship it.” Submitted.</span></div>
  </div>
  <p class="lead">Agents worked in parallel. Their edits went through Weft.</p>
</section>''')
S.append('''<section>
  <h2>Cloudflare, in plain words</h2>
  <table class="map">
    <tr><td>Durable Object</td><td>one tiny server + database per repo. Exactly one copy, so it keeps the order. My “elect”, built in.</td></tr>
    <tr><td>Artifacts</td><td>the git storage</td></tr>
    <tr><td>Workers</td><td>the web service: the API agents call, and the site</td></tr>
  </table>
</section>''')
S.append(f'''<section class="demo">
  <h2>The squiggle</h2>
  <video id="clip" src="{CLIP}" playsinline preload="auto" controls></video>
  <p class="src">Demo video 0:37–1:24 · AI voice · weft-media.elier.ai/weft-demo-short.mp4</p>
</section>''')
S.append(f'''<section>
  <h2>Not staged: Weft’s own build</h2>
  <div class="split wide">
    <figure><img src="{E834}" alt="Event #834 blocked by stale_assumption, caused by #813"><figcaption>weft.elier.ai/#/r/weft/live</figcaption></figure>
    <p class="lead big">Event <b>#834</b> refused:<br><b>#813</b> changed a type it used.<br><br>Next try accepted.<br>Nobody stepped in.</p>
  </div>
</section>''')
S.append('''<section>
  <h2>Weft’s own log, Monday Oct 19</h2>
  <div class="nums">
    <div><b>918</b><span>events</span></div>
    <div><b>679</b><span>edits</span></div>
    <div><b>27</b><span>landings on main</span></div>
    <div><b>60</b><span>“wait for the other agent”</span></div>
  </div>
  <div class="nums one"><div><b>5</b><span>edits refused before they could land</span></div></div>
  <p class="src">weft.elier.ai/api/repos/weft/events · log-stats-2026-10-19.json</p>
</section>''')
S.append('''<section class="big">
  <h2>What it isn’t</h2>
  <ul class="plain">
    <li>A research prototype</li>
    <li>TypeScript and JavaScript only</li>
    <li>WCP is a draft, v0.1</li>
    <li>No outside team in production yet</li>
  </ul>
</section>''')
S.append('''<section>
  <p class="kicker">Step 11 · use it, find issues</p>
  <ul class="plain">
    <li>Hacker News: no upvotes</li>
    <li>The build broke</li>
    <li>A stranger’s pull requests: agents asked for proof</li>
  </ul>
  <blockquote class="hl">“I want every edit visible. That’s the magical part.”</blockquote>
  <p class="src">Oct 18, after my Mac app showed only finished work</p>
</section>''')
steps = ['Explore', 'Dig into specifics', 'Think up solutions', 'Discuss alter&shy;natives', 'Make decisions',
         'Reason through edge cases', 'Delegate', 'Build the system around the agents',
         'Hand over authority, keep sign-off', 'Verify and steer']  # steps 1-10; 11-12 loop back
row = ''.join(f'<li><b>{i+1}</b>{s}</li>' for i, s in enumerate(steps))
S.append(f'''<section class="method">
  <h2>How I build with agents</h2>
  <div class="mwrap">
    <ol class="ten">{row}</ol>
    <svg class="loop" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
      <path d="M 955 2 L 955 50" fill="none" stroke="#ffa53d" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <path d="M 945 42 L 955 52 L 965 42" fill="none" stroke="#ffa53d" stroke-width="3" vector-effect="non-scaling-stroke"/>
      <path d="M 298 78 C 150 78, 50 80, 50 4" fill="none" stroke="#ffa53d" stroke-width="3" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/>
      <path d="M 42 14 L 50 2 L 58 14" fill="none" stroke="#ffa53d" stroke-width="3" vector-effect="non-scaling-stroke"/>
    </svg>
    <div class="loopbox"><span><b>11</b> Use it, find issues</span><span>→</span><span><b>12</b> Iterate: back to step 1 for each gap</span></div>
  </div>
  <p class="lead">Now: Weft on a laptop, and inside my app. Neither is finished.<br>Preparing this talk was the loop too.</p>
</section>''')
S.append(f'''<section class="end">
  <h2>If the code editor disappears,<br>agents still need <span class="sq">squiggles</span>.</h2>
  <p class="lead">Credits: a free hosted coordinator for outside teams · a public benchmark, with and without Weft</p>
  <div class="qrs">
    <figure><img src="{QR1}" alt="QR code for weft-site.elier.ai"><figcaption>weft-site.elier.ai</figcaption></figure>
    <figure><img src="{QR2}" alt="QR code for John's Calendly"><figcaption>talk with John</figcaption></figure>
  </div>
</section>''')

CSS = '''*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;background:#0b0d12;color:#e8e8ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Helvetica,Arial,sans-serif;overflow:hidden}
section{position:absolute;inset:0;padding:7vh 7vw;display:none;flex-direction:column;justify-content:center;gap:4vh}
section.on{display:flex}
h1{font-size:11vh;line-height:1.05;letter-spacing:-.02em}
h2{font-size:8vh;line-height:1.1;letter-spacing:-.015em}
.kicker{color:#ffa53d;font-size:3.4vh;text-transform:uppercase;letter-spacing:.12em}
.kicker .step{margin-left:2vw;color:#8b909b}
.lead{color:#b9bec8;font-size:4.8vh;line-height:1.35}
.lead.big{font-size:5vh}
.hl{color:#ffa53d}
blockquote{font-size:8.6vh;line-height:1.18;letter-spacing:-.01em;font-weight:600}
blockquote.sm{font-size:5.6vh;font-weight:500;color:#d6d9df}
blockquote.hl{font-size:7vh}
.qs{display:block;font-size:5.2vh;color:#b9bec8;font-weight:500;margin-top:1.5vh}
.sq{text-decoration:underline wavy #ff4d4d;text-underline-offset:1.4vh;text-decoration-thickness:.45vh}
.split{display:grid;grid-template-columns:1fr 1.2fr;gap:4vw;align-items:center}
.split.wide{grid-template-columns:1.7fr 1fr}
figure img{width:100%;border-radius:10px;border:1px solid #2a2f3a;display:block}
figcaption{font-size:2.2vh;color:#8b909b;margin-top:1vh}
.nums{display:grid;grid-template-columns:repeat(4,1fr);gap:1.5vw}
.nums.one{grid-template-columns:1fr}
.nums div{background:#141821;border:1px solid #262b36;border-radius:14px;padding:3vh 1.6vw}
.nums b{display:block;font-size:10vh;color:#ffa53d;letter-spacing:-.02em}
.nums span{font-size:3.6vh;color:#c3c7cf;line-height:1.35;display:block}
table.map{border-collapse:collapse;width:100%}
table.map td{padding:3vh 1.2vw;border-bottom:1px solid #232834;vertical-align:top;font-size:5vh;line-height:1.3}
table.map td:first-child{color:#ffa53d;white-space:nowrap;font-weight:600;width:28%}
ul.plain{list-style:none}
ul.plain li{font-size:6.4vh;line-height:1.5}
ul.plain li:before{content:"·";color:#ffa53d;margin-right:1.5vw}
.src{font-size:2.2vh;color:#7d828d}
.demo{gap:2vh}
.demo video{width:100%;max-height:72vh;background:#000;border-radius:10px}
.method{gap:1.5vh}
.mwrap{position:relative;padding-bottom:20vh}
.method svg.loop{position:absolute;left:0;right:0;bottom:0;width:100%;height:20vh}
ol.ten{list-style:none;display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:.8vw}
ol.ten li{background:#141821;border:1px solid #262b36;border-radius:12px;padding:2vh .6vw;font-size:3vh;line-height:1.2;min-height:30vh;hyphens:manual;-webkit-hyphens:manual}
ol.ten b{display:block;color:#ffa53d;font-size:5.6vh;margin-bottom:1vh}
.loopbox{position:absolute;left:30%;right:0;bottom:0;display:flex;gap:1.5vw;justify-content:center;align-items:center;font-size:3.8vh;white-space:nowrap;background:#1c1610;border:1px dashed #ffa53d;border-radius:12px;padding:2vh 1.5vw}
.loopbox b{color:#ffa53d;margin-right:.6vw}
.end{align-items:center;text-align:center}
.qrs{display:flex;gap:6vw;justify-content:center}
.qrs img{width:30vh;height:30vh;image-rendering:pixelated;border-radius:12px;border:none}
.qrs figcaption{font-size:2.8vh;color:#e8e8ea}
#n{position:fixed;right:2vw;bottom:2vh;font-size:1.8vh;color:#5d626c}'''

JS = '''const s=[...document.querySelectorAll('section')],n=document.getElementById('n'),v=document.getElementById('clip');
let i=Math.max(0,Math.min(s.length-1,(parseInt(location.hash.slice(1))||1)-1));
function show(k){i=Math.max(0,Math.min(s.length-1,k));s.forEach((e,j)=>e.classList.toggle('on',j===i));n.textContent=(i+1)+' / '+s.length;history.replaceState(null,'','#'+(i+1));
 if(s[i].contains(v)){v.currentTime=0;v.play().catch(()=>{})}else{v.pause()}}
document.addEventListener('keydown',e=>{if(['ArrowRight','PageDown',' '].includes(e.key)){e.preventDefault();show(i+1)}
 else if(['ArrowLeft','PageUp'].includes(e.key))show(i-1);else if(e.key==='f'||e.key==='F'){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()}});
document.addEventListener('click',e=>{if(e.target.tagName==='VIDEO')return;show(e.clientX<innerWidth/4?i-1:i+1)});
show(i);'''

out = f'''<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Weft · the true origin story · Cloudflare Connect 2026</title>
<!-- Self-contained deck (story version, card t_eddf67e7): no network, no build step.
     Right arrow / click to advance, F for full screen. Script and sources: pitch.md.
     Feature version kept as slides-feature-v1.html. Generated by a script from v1 assets
     and the squiggle segment (0:37-1:24) of weft-media.elier.ai/weft-demo-short.mp4. -->
<style>
{CSS}
</style></head><body>
{chr(10).join(S)}
<div id="n"></div>
<script>
{JS}
</script>
</body></html>
'''
open(D + 'slides.html', 'w').write(out)
print(len(S), 'slides', len(out), 'bytes')
