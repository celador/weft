#!/usr/bin/env node
// Slides (title/end cards, stat/quote/timeline cards, diagram placeholders) → 1920x1080 MP4 stills.
// Same palette as apps/web. HTML is generated here from shots/cards.json; Playwright screenshots it.
//
//   node demo/video/rig/render-cards.mjs [--shots S00b,S11b] [--out demo/video/clips/cards] [--spec other-cards.json]
import { chromium } from "playwright";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { args, sh, RIG, VIDEO } from "./lib.mjs";
import { scanText } from "./screen-safety.mjs";

const a = args();
const spec = JSON.parse(readFileSync(a.spec ?? join(RIG, "shots/cards.json"), "utf8"));
const want = a.shots ? String(a.shots).split(",") : null;
const out = a.out ?? join(VIDEO, "clips/cards");
mkdirSync(out, { recursive: true });

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const CSS = `
:root{--bg:#0b0d12;--panel:#141822;--line:#242a38;--fg:#e7eaf2;--fg2:#b4bccd;--muted:#7c859a;--accent:#7c9cff;--accent2:#ff6b8b;--err:#ff5d6c;--warn:#ffb547;--ok:#3ddc97;--info:#5ec8ff}
*{box-sizing:border-box;margin:0}
body{width:1920px;height:1080px;background:radial-gradient(1200px 700px at 70% 20%,#151a2a 0,var(--bg) 60%);color:var(--fg);
 font:400 34px/1.35 "Inter","SF Pro Display",-apple-system,system-ui,sans-serif;padding:120px 160px;display:flex;flex-direction:column;justify-content:center;gap:28px}
.kicker{font:600 26px/1 "SF Mono",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase;color:var(--accent)}
h1{font-weight:700;font-size:96px;line-height:1.05;letter-spacing:-.02em}
h2{font-weight:650;font-size:64px;line-height:1.1;letter-spacing:-.01em}
.sub{color:var(--fg2);font-size:40px;max-width:1500px}
.mark{display:inline-block;width:64px;height:64px;border-radius:14px;background:linear-gradient(135deg,var(--accent),var(--accent2));margin-bottom:12px}
.lines{display:flex;flex-direction:column;gap:18px;font-size:38px}
.lines .l{display:flex;gap:28px;align-items:baseline}
.lines .t{font:600 34px "SF Mono",Menlo,monospace;color:var(--accent);min-width:220px;text-align:right}
.stats{display:grid;grid-template-columns:repeat(4,1fr);gap:28px}
.stat{background:var(--panel);border:1px solid var(--line);border-radius:20px;padding:30px 34px}
.stat b{display:block;font-size:84px;font-weight:700;letter-spacing:-.02em}
.stat span{color:var(--muted);font-size:28px}
blockquote{font-size:48px;line-height:1.3;border-left:6px solid var(--warn);padding-left:40px;color:var(--fg)}
.src{color:var(--muted);font-size:26px;font-family:"SF Mono",Menlo,monospace}
.err{color:var(--err)} .ok{color:var(--ok)} .warn{color:var(--warn)}
.placeholder{border:3px dashed var(--line);border-radius:24px;padding:60px;color:var(--muted)}
`;

function html(c) {
  const parts = [];
  if (c.mark) parts.push(`<div class="mark"></div>`);
  if (c.kicker) parts.push(`<div class="kicker">${esc(c.kicker)}</div>`);
  if (c.title) parts.push(c.big ? `<h1>${esc(c.title)}</h1>` : `<h2>${esc(c.title)}</h2>`);
  if (c.sub) parts.push(`<div class="sub">${esc(c.sub)}</div>`);
  if (c.quote) parts.push(`<blockquote>${esc(c.quote)}</blockquote>`);
  if (c.lines) parts.push(`<div class="lines">${c.lines.map(([t, l, cls]) => `<div class="l"><span class="t">${esc(t)}</span><span class="${cls ?? ""}">${esc(l)}</span></div>`).join("")}</div>`);
  if (c.stats) parts.push(`<div class="stats">${c.stats.map(([n, l]) => `<div class="stat"><b>${esc(n)}</b><span>${esc(l)}</span></div>`).join("")}</div>`);
  if (c.placeholder) parts.push(`<div class="placeholder">${esc(c.placeholder)}</div>`);
  if (c.source) parts.push(`<div class="src">${esc(c.source)}</div>`);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${parts.join("")}</body></html>`;
}

// stats cards may pull numbers from dogfood-stats.json: {"statsFrom": "demo/video/dogfood-stats.json"}
function resolve(c) {
  if (!c.statsFrom) return c;
  const s = JSON.parse(readFileSync(join(VIDEO, "../..", c.statsFrom), "utf8"));
  return { ...c, stats: [[s.records, "events in its own log"], [s.edits, "edits by agents"], [s.lands, "landings"], [s.by_code["warning:claim_wait"] ?? 0, "“wait for another agent” warnings"]], source: `repo weft · as of ${s.as_of}` };
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
for (const c0 of spec.cards.filter((c) => !want || want.includes(c.id))) {
  const c = resolve(c0);
  const doc = html(c);
  const hits = scanText(doc);
  if (hits.length) throw new Error(`${c.id}: screen-safety hit in card text: /${hits[0].pattern}/`);
  await page.setContent(doc, { waitUntil: "load" });
  const png = join(out, `${c.id}.png`);
  await page.screenshot({ path: png });
  const mp4 = join(out, `${c.id}.mp4`);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-loop", "1", "-framerate", "30", "-i", png, "-t", String(c.seconds ?? 5),
    "-vf", "format=yuv420p", "-c:v", "libx264", "-preset", "slow", "-crf", "14", "-tune", "stillimage", mp4]);
  console.log(`${c.id}: ${c.seconds ?? 5} s -> ${mp4}`);
}
await browser.close();
