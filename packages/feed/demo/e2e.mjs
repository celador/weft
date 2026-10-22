#!/usr/bin/env node
// End-to-end check of the demo page in a real browser (Playwright), against a live run:
// waits for the conflict to show up live, follows the squiggle to its cause, opens the diff,
// sends Pause (then Resume) and a Message from the page, and checks each landed in the log.
//
//   PLAYWRIGHT=/path/to/node_modules/playwright/index.mjs \
//   node packages/feed/demo/e2e.mjs --page http://127.0.0.1:8818/ --dir RUN_DIR --shots OUT_DIR
//
// RUN_DIR is live-run.mjs's --dir (run.json + human-token). Playwright is not a dependency of
// this repo; point PLAYWRIGHT at any install.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const pageUrl = opt("page", "http://127.0.0.1:8818/");
const dir = resolve(opt("dir", ".run"));
const shots = resolve(opt("shots", join(dir, "shots")));
mkdirSync(shots, { recursive: true });
const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8"));
const token = readFileSync(join(dir, "human-token"), "utf8").trim();
const { chromium } = await import(process.env.PLAYWRIGHT ?? "playwright");
const log = (m) => console.log(`[e2e] ${m}`);
const results = [];
const ok = (name, pass, detail = "") => {
  results.push({ name, pass, detail });
  log(`${pass ? "ok  " : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
};

async function events() {
  const r = await fetch(`${run.url}/v1/repos/${run.repo}/events?limit=500`, { headers: { authorization: `Bearer ${token}`, "wcp-version": "0.1" } });
  return (await r.json()).events;
}

const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
const page = await browser.newPage({ viewport: { width: 1480, height: 940 }, deviceScaleFactor: 2, colorScheme: "dark" });
const problems = [];
page.on("console", (m) => (m.type() === "error" || /Content Security Policy/i.test(m.text())) && problems.push(m.text()));
page.on("pageerror", (e) => problems.push(String(e)));
await page.goto(pageUrl);
log(`opened ${pageUrl}; waiting for the agents (live)`);

// 1. The conflict arrives live: a blocked row, and Editing now for both tasks.
await page.waitForSelector(".wf-row.wf-rejected", { timeout: 10 * 60_000 });
await page.waitForFunction(() => document.querySelectorAll(".wf-editing").length >= 2, null, { timeout: 5 * 60_000 });
const blockedId = await page.getAttribute(".wf-row.wf-rejected", "data-id");
const editing = await page.$$eval(".wf-editing", (els) => els.map((e) => e.getAttribute("data-agent")));
ok("conflict row arrived live", !!blockedId, blockedId ?? "");
ok("Editing now shows both tasks", editing.includes("claude-a") && editing.includes("claude-b"), editing.join(", "));
ok("status is live", (await page.textContent(".wf-status"))?.startsWith("Live") ?? false, await page.textContent(".wf-status"));
await page.click(`.wf-row[data-id="${blockedId}"]`);
await page.waitForSelector(".wf-detail .wf-callout");
await page.screenshot({ path: join(shots, "1-conflict-live.png") });

// 2. The squiggle links to its cause; the cause's diff renders.
const cause = await page.getAttribute(".wf-detail .wf-callout", "data-cause");
const causeText = (await page.textContent(".wf-detail .wf-cause"))?.trim();
await page.click(".wf-detail .wf-cause");
await page.waitForFunction((c) => document.querySelector(".wf-detail .wf-detail-meta")?.textContent?.includes(`#${c.split("#")[1]} `), cause);
await page.waitForSelector(".wf-detail .wf-diff-line");
const causeRec = (await events()).find((e) => `${e.repo}#${e.seq}` === cause);
ok("squiggle → cause", !!causeRec && causeRec.agent === "claude-a", `${causeText} → ${cause} (${causeRec?.kind} by ${causeRec?.agent})`);
const diffLines = await page.$$eval(".wf-detail .wf-diff-add, .wf-detail .wf-diff-del", (els) => els.length);
ok("cause diff shown in colour", diffLines > 0, `${diffLines} added/removed lines`);
await page.screenshot({ path: join(shots, "2-cause-diff.png") });

// 3. Message claude-a from its record.
await page.click('.wf-detail [data-action="message"]');
await page.fill(".wf-composer textarea", "Heads up from the feed: claude-b needs calcTotal's old call to keep working. Keep a default for opts?");
await page.click('.wf-composer button[type="submit"]');
await page.waitForSelector(".wf-notice:not(.wf-notice-error)");
const msgNotice = await page.textContent(".wf-notice");
const msg = (await events()).findLast((e) => e.kind === "message" && e.actor?.type === "human");
ok("Message appended to the log", msg?.payload?.to?.agent === "claude-a" && /Heads up from the feed/.test(msg?.payload?.text ?? ""), `${msgNotice} · #${msg?.seq} ${msg?.summary}`);

// 4. Pause claude-b from its blocked record, then Resume.
await page.click(`.wf-row[data-id="${blockedId}"]`);
await page.waitForSelector('.wf-detail [data-action="pause"]');
await page.click('.wf-detail [data-action="pause"]');
await page.waitForSelector('.wf-detail [data-action="resume"]');
const pause = (await events()).findLast((e) => e.kind === "control" && e.payload?.action === "pause");
ok("Pause appended to the log", pause?.payload?.target?.agent === "claude-b" && pause?.actor?.type === "human", `#${pause?.seq} ${pause?.summary}`);
ok("detail shows PAUSED and offers Resume", (await page.textContent(".wf-detail-who"))?.includes("PAUSED") ?? false);
await page.screenshot({ path: join(shots, "3-paused.png") });
await page.click('.wf-detail [data-action="resume"]');
await page.waitForSelector('.wf-detail [data-action="pause"]');
const resume = (await events()).findLast((e) => e.kind === "control" && e.payload?.action === "resume");
ok("Resume appended to the log", resume?.payload?.target?.agent === "claude-b", `#${resume?.seq} ${resume?.summary}`);

// 5. The human rows appear in the feed itself (the page saw its own actions).
await page.click(".wf-chip >> text=Session events");
await page.waitForSelector(`.wf-row[data-id="${run.repo}#${pause.seq}"]`);
await page.click(".wf-chip >> text=Session events");
await page.click(`.wf-row[data-id="${blockedId}"]`);
await page.screenshot({ path: join(shots, "4-feed-after-actions.png") });

ok("no console errors or CSP violations", problems.length === 0, problems.slice(0, 3).join(" | "));
writeFileSync(join(shots, "e2e.json"), JSON.stringify({ page: pageUrl, repo: run.repo, results }, null, 2));
await browser.close();
process.exitCode = results.every((r) => r.pass) ? 0 : 1;
