#!/usr/bin/env node
// Cut the Hermes-hackathon video from one filmed take + cards + narration (see README.md here).
//
//   node demo/video/hackathon/assemble.mjs --take DIR --audio DIR --cards DIR --whisper DIR --out DIR [--plan]
//
// take:    install.mp4 + live.mp4 from film.sh (1920x940 terminal; a 140 px caption band is added below)
// audio:   NN.mp3 from rig/narrate.mjs --script demo/video/hackathon/script.md
// whisper: NN.json (whisper --word_timestamps True) for each NN.mp3, used for cue placement + caption timing
// Writes <out>/weft-hermes-demo.mp4, captions.srt, timeline.json. Nothing is sped up or reordered:
// segments are in-order excerpts of one continuous take (cuts remove idle time only).
import { chromium } from "../rig/node_modules/playwright/index.mjs"; // the rig's pinned Playwright (npm ci in rig/)
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { args, sections, sh, durationSec } from "../rig/lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const a = args();
for (const k of ["take", "audio", "cards", "whisper", "out"]) if (!a[k]) throw new Error(`--${k} DIR required`);
const edl = JSON.parse(readFileSync(join(HERE, "edl.json"), "utf8"));
const script = Object.fromEntries(sections(join(HERE, "script.md")).map((s) => [s.id, s.text.replace(/\n/g, " ")]));
const W = 1920, H = 1080, TERM_H = 940, FPS = 30;
const work = join(a.out, "work");
mkdirSync(work, { recursive: true });
const enc = ["-c:v", "libx264", "-preset", "medium", "-crf", "17", "-pix_fmt", "yuv420p", "-r", String(FPS)];

// ---- timeline ----
let t = 0;
const segs = edl.segments.map((s) => {
  const dur = s.dur ?? +(s.to - s.from).toFixed(3);
  const seg = { ...s, start: +t.toFixed(3), dur };
  t += dur;
  return seg;
});
const total = +t.toFixed(3);

const norm = (w) => w.toLowerCase().replace(/[^a-z0-9]/g, "");
function words(id) {
  const j = JSON.parse(readFileSync(join(a.whisper, `${id}.json`), "utf8"));
  return j.segments.flatMap((s) => s.words ?? []).map((w) => ({ w: w.word.trim(), s: w.start, e: w.end }));
}
// Script position -> spoken time: proportional on letters only, so "calc_total"/"calc total" and
// "worktree"/"work tree" line up (the lexicon only re-spaces words, it never adds any).
function charMap(id) {
  const ws = words(id);
  const spoken = ws.map((w) => norm(w.w));
  const totalSpoken = spoken.join("").length;
  const totalScript = norm(script[id]).length;
  const starts = [];
  let acc = 0;
  for (const [i, w] of spoken.entries()) { starts.push([acc, ws[i]]); acc += w.length; }
  return (scriptCharIdx, edge = "s") => {
    const pos = (scriptCharIdx / totalScript) * totalSpoken;
    let best = starts[0];
    if (edge === "s") {
      // A start lands on a word boundary; the proportional scale is a few letters off when the
      // lexicon/whisper spelling differs ("Weft's" heard "WEF's"), so take the nearest word start
      // rather than the last one before pos (which showed a caption one word early).
      for (const st of starts) if (Math.abs(st[0] - pos) < Math.abs(best[0] - pos)) best = st;
    } else {
      for (const st of starts) if (st[0] <= pos + 0.01) best = st;
    }
    return best[1][edge];
  };
}
function cueOffset(id, cue) {
  const text = script[id];
  const i = text.indexOf(cue);
  if (i < 0) throw new Error(`cue "${cue}" not in narration ${id}`);
  return charMap(id)(norm(text.slice(0, i)).length, "s");
}
function outTime(src, srcT) {
  const seg = segs.find((s) => s.src === src && srcT >= s.from && srcT <= s.to);
  if (!seg) throw new Error(`${src}@${srcT} is not in any segment`);
  return seg.start + (srcT - seg.from);
}

const narr = edl.narration.map((n) => {
  const mp3 = join(a.audio, `${n.id}.mp3`);
  const len = durationSec(mp3);
  const at = n.seg !== undefined ? segs[n.seg].start + n.at : outTime(n.src, n.src_t) - cueOffset(n.id, n.cue);
  return { id: n.id, mp3, at: +at.toFixed(3), end: +(at + len).toFixed(3), len: +len.toFixed(3) };
});
for (const [i, n] of narr.entries()) {
  if (n.at < 0 || n.end > total) throw new Error(`narration ${n.id} [${n.at}, ${n.end}] outside 0..${total}`);
  if (i && n.at < narr[i - 1].end + 0.15) throw new Error(`narration ${n.id} starts ${n.at} before ${narr[i - 1].id} ends ${narr[i - 1].end}`);
}

// ---- captions: sentence chunks <= 70 chars, timed on whisper words ----
function chunks(text) {
  const out = [];
  for (const sent of text.match(/.+?(?:[.!?]+(?=\s|$)|$)/g).map((s) => s.trim()).filter(Boolean)) {
    let cur = [];
    for (const w of sent.split(/\s+/)) {
      if ([...cur, w].join(" ").length > 70 && cur.length) { out.push(cur.join(" ")); cur = []; }
      cur.push(w);
      if (/[,;:]$/.test(w) && cur.join(" ").length > 36) { out.push(cur.join(" ")); cur = []; }
    }
    if (cur.length) out.push(cur.join(" "));
  }
  return out;
}
const caps = [];
for (const n of narr) {
  const text = script[n.id];
  const map = charMap(n.id);
  let pos = 0;
  const local = [];
  for (const c of chunks(text)) {
    const i = text.indexOf(c, pos);
    pos = i + c.length;
    const c0 = norm(text.slice(0, i)).length, c1 = norm(text.slice(0, pos)).length - 1;
    local.push({ text: c, s: n.at + map(c0, "s"), e: n.at + map(c1, "e") });
  }
  for (let i = 0; i < local.length; i++) {
    if (i + 1 < local.length) local[i].e = Math.max(local[i].e, local[i + 1].s - 0.05);   // no flicker gap inside a paragraph
    local[i].e = Math.max(local[i].e, local[i].s + 1.0) + (i + 1 === local.length ? 0.3 : 0);
    if (i + 1 < local.length && local[i].e > local[i + 1].s) local[i].e = local[i + 1].s;
  }
  caps.push(...local);
}

const timeline = { total, segments: segs, narration: narr, captions: caps.map((c) => ({ ...c, s: +c.s.toFixed(2), e: +c.e.toFixed(2) })) };
writeFileSync(join(a.out, "timeline.json"), JSON.stringify(timeline, null, 1));
for (const s of segs) console.log(`${s.start.toFixed(2).padStart(6)}  ${s.dur.toFixed(2).padStart(5)}s  ${s.src}${s.from !== undefined ? ` ${s.from}..${s.to}` : ""}${s.zoom ? ` zoom ${s.zoom}` : ""}`);
for (const n of narr) console.log(`narration ${n.id}: ${n.at.toFixed(2)} .. ${n.end.toFixed(2)}`);
console.log(`total ${total.toFixed(2)} s, ${caps.length} captions`);
if (a.plan) process.exit(0);

// ---- video segments ----
const parts = [];
for (const [i, s] of segs.entries()) {
  const f = join(work, `seg${String(i).padStart(2, "0")}.mp4`);
  if (s.src.startsWith("card:")) {
    const png = join(a.cards, `${s.src.slice(5)}.png`);
    const n = Math.ceil(s.dur * FPS);
    sh("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-framerate", String(FPS), "-i", png, "-vf",
      `scale=3840:2160,zoompan=z='1+0.03*on/${n}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':d=1:s=${W}x${H}:fps=${FPS},` +
      `fade=t=in:st=0:d=0.3,fade=t=out:st=${(s.dur - 0.3).toFixed(2)}:d=0.3`, "-t", s.dur.toFixed(3), "-an", ...enc, f]);
  } else {
    const src = join(a.take, `${s.src}.mp4`);
    // terminal take: 1920x940, caption band below in the theme's darkest shade. "zoom": [x, y, w]
    // enlarges one region (same aspect) so the key text reads on a phone; content is untouched.
    const z = s.zoom ? `crop=${s.zoom[2]}:${Math.round((s.zoom[2] * TERM_H) / W)}:${s.zoom[0]}:${s.zoom[1]},scale=${W}:${TERM_H}:flags=lanczos,` : "";
    sh("ffmpeg", ["-y", "-loglevel", "error", "-ss", String(s.from), "-i", src, "-t", s.dur.toFixed(3), "-vf",
      `${z}scale=${W}:${TERM_H},pad=${W}:${H}:0:0:color=0x11111b,fps=${FPS}`, "-an", ...enc, f]);
  }
  parts.push(f);
}
const list = join(work, "concat.txt");
writeFileSync(list, parts.map((p) => `file '${p}'`).join("\n"));
const silent = join(work, "video.mp4");
sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", silent]);

// ---- caption PNGs ----
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: W, height: H - TERM_H } });
const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);
for (const [i, c] of caps.entries()) {
  await page.setContent(`<!doctype html><html><body style="margin:0;width:${W}px;height:${H - TERM_H}px;display:flex;align-items:center;justify-content:center;background:transparent">
    <div style="max-width:1760px;padding:10px 26px;border-radius:12px;background:rgba(8,10,14,.6);color:#f2f4f8;white-space:nowrap;
      font:500 38px/1.25 'Inter','SF Pro Text',-apple-system,system-ui,sans-serif;text-align:center">${esc(c.text)}</div></body></html>`);
  c.png = join(work, `cap${String(i).padStart(2, "0")}.png`);
  await page.screenshot({ path: c.png, omitBackground: true });
}
await browser.close();

// ---- burn captions, mix narration ----
const inputs = ["-i", silent];
for (const c of caps) inputs.push("-i", c.png);
for (const n of narr) inputs.push("-i", n.mp3);
let chain = "[0:v]";
const f = [];
caps.forEach((c, i) => {
  const outLabel = i + 1 === caps.length ? "[v]" : `[v${i}]`;
  f.push(`${chain}[${i + 1}:v]overlay=0:${TERM_H}:enable='between(t,${c.s.toFixed(3)},${c.e.toFixed(3)})'${outLabel}`);
  chain = outLabel;
});
const aIdx = caps.length + 1;
narr.forEach((n, i) => f.push(`[${aIdx + i}:a]aresample=48000,aformat=channel_layouts=stereo,adelay=${Math.round(n.at * 1000)}:all=1[a${i}]`));
f.push(`${narr.map((_, i) => `[a${i}]`).join("")}amix=inputs=${narr.length}:normalize=0,apad,atrim=0:${total},loudnorm=I=-16:TP=-1.5:LRA=11,aresample=48000[a]`);
const final = join(a.out, "weft-hermes-demo.mp4");
sh("ffmpeg", ["-y", "-loglevel", "error", ...inputs, "-filter_complex", f.join(";"), "-map", "[v]", "-map", "[a]",
  ...enc, "-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-t", String(total), "-movflags", "+faststart", final]);

// ---- SRT ----
const fmt = (x) => { const ms = Math.round(x * 1000); const p = (n, w = 2) => String(n).padStart(w, "0"); return `${p(Math.floor(ms / 3.6e6))}:${p(Math.floor(ms / 6e4) % 60)}:${p(Math.floor(ms / 1000) % 60)},${p(ms % 1000, 3)}`; };
writeFileSync(join(a.out, "captions.srt"), caps.map((c, i) => `${i + 1}\n${fmt(c.s)} --> ${fmt(c.e)}\n${c.text}\n`).join("\n"));
console.log(`-> ${final} (${durationSec(final).toFixed(2)} s)`);
if (!existsSync(final)) process.exit(1);
