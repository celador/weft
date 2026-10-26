#!/usr/bin/env node
// Backup screen recording of the Connect 2026 demo flow, filmed against the LIVE public system
// (weft-site.elier.ai + demo.weft.mx, no login), plus one PNG still per beat for no-network use.
//
//   node demo/video/rig/connect-backup.mjs [--out demo/video/connect-2026] [--live-wait 120]
//
// Beat 3 waits (up to --live-wait seconds) for a NEW event to land in the weft log while filming:
// make any agent edit in a weft checkout during that window and it appears live on screen.
// Output: <out>/web.mp4 (1920x1080 30 fps, no audio), <out>/stills/NN-<beat>.png, <out>/beats.json.
// The terminal beat (two agents, one symbol) is filmed separately with VHS (connect-term.tape)
// and joined by demo/video/connect-2026/build.sh.
import { chromium } from "playwright";
import { mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { args, sh, VIDEO } from "./lib.mjs";
import { FORBIDDEN } from "./screen-safety.mjs";

const a = args();
const out = resolve(a.out ?? join(VIDEO, "connect-2026"));
const stills = join(out, "stills");
const raw = join(out, ".raw");
mkdirSync(stills, { recursive: true });
rmSync(raw, { recursive: true, force: true });
mkdirSync(raw, { recursive: true });
const liveWait = Number(a["live-wait"] ?? 120) * 1000;
const W = 1920, H = 1080, ZOOM = 1.25;

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: W, height: H }, recordVideo: { dir: raw, size: { width: W, height: H } } });
await ctx.addInitScript((z) => {
  const apply = () => { document.documentElement.style.zoom = String(z); };
  if (document.documentElement) apply(); else document.addEventListener("DOMContentLoaded", apply);
}, ZOOM);
const page = await ctx.newPage();
const t0 = Date.now();
const beats = [];
let n = 0;

async function safe() {
  // A task title on the board says "the old *.workers.dev host": the generic wildcard names no
  // account, so it is allowed; any real <name>.workers.dev host still aborts the recording.
  const text = (await page.evaluate(() => document.body.innerText + "\n" + location.href)).replaceAll("*.workers.dev", "*.[generic]");
  for (const re of FORBIDDEN) if (re.test(text)) throw new Error(`screen-safety hit ${re} at ${page.url()}`);
}
async function beat(name, caption, fn) {
  const start = (Date.now() - t0) / 1000;
  await fn();
  await safe();
  n += 1;
  const file = `${String(n).padStart(2, "0")}-${name}.png`;
  await page.screenshot({ path: join(stills, file) });
  beats.push({ n, name, caption, still: `stills/${file}`, start_s: +start.toFixed(1), end_s: +((Date.now() - t0) / 1000).toFixed(1) });
  console.log(`beat ${n} ${name} ${start.toFixed(1)}s`);
}
const hold = (ms) => page.waitForTimeout(ms);
const scroll = async (px, steps = 30, ms = 60) => { for (let i = 0; i < steps; i++) { await page.mouse.wheel(0, px / steps); await hold(ms); } };

await beat("site", "What Weft is: a coordinator that lets many coding agents edit one repo at once.", async () => {
  await page.goto("https://weft-site.elier.ai/", { waitUntil: "networkidle" });
  await hold(6000);
  await scroll(900, 40, 120);
  await hold(5000);
  await scroll(900, 40, 120);
  await hold(5000);
});

await beat("live-log", "demo.weft.mx: the live, public change log of the weft repo. Every agent edit is one row.", async () => {
  await page.goto("https://demo.weft.mx/#/r/weft/live");
  await page.waitForSelector(".row", { timeout: 30000 });
  await hold(9000);
  await page.mouse.move(700, 450);
  await scroll(700, 25, 80);
  await hold(3000);
  await scroll(-700, 25, 80);
  await hold(2000);
});

let liveSeq = null;
await beat("live-edit", "A real agent edit arrives while we watch (no refresh).", async () => {
  const top = async () => page.evaluate(() => Number(document.querySelector(".row")?.getAttribute("data-seq") ?? 0));
  const before = await top();
  console.log(`LIVE-WAIT head=${before}: make an agent edit in a weft checkout now`);
  const until = Date.now() + liveWait;
  while (Date.now() < until && (await top()) <= before) await hold(500);
  liveSeq = await top();
  console.log(liveSeq > before ? `live event #${liveSeq} arrived` : "no live event arrived (beat kept as is)");
  await hold(8000);
});

await beat("squiggle", "When an edit would break another agent's work, Weft blocks it and says why (a squiggle).", async () => {
  await page.click("button.toggle");
  await hold(4000);
  const row = page.locator(".row").filter({ hasText: /BLOCKED|REJECTED/i }).first();
  await row.hover();
  await hold(3000);
  await row.click();
  await hold(12000); // the still is taken here, with the record's detail open
});

await beat("replay", "Replay at 64x: the repo's own build history, many agent profiles at once.", async () => {
  await page.keyboard.press("Escape");
  await hold(1000);
  await page.click("button.toggle");
  await hold(1500);
  await page.selectOption("select.speed", "64");
  await page.click("button.replay");
  await hold(22000);
});

await beat("board", "Board: each task, its agent and its state.", async () => {
  await page.goto("https://demo.weft.mx/#/r/weft/board");
  await hold(10000);
});

await beat("analytics", "Analytics: edits, waits and landings over time.", async () => {
  await page.goto("https://demo.weft.mx/#/r/weft/analytics");
  await hold(10000);
});

const video = page.video();
await ctx.close();
await browser.close();
const webm = await video.path();
const mp4 = join(out, "web.mp4");
sh("ffmpeg", ["-y", "-loglevel", "error", "-i", webm, "-vf", `scale=${W}:${H}:flags=lanczos,fps=30,format=yuv420p`, "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-an", mp4]);
rmSync(raw, { recursive: true, force: true });
writeFileSync(join(out, "beats.json"), JSON.stringify({ recorded_at: new Date(t0).toISOString(), live_event_seq: liveSeq, beats }, null, 2) + "\n");
console.log(`wrote ${mp4} and ${beats.length} stills`);
