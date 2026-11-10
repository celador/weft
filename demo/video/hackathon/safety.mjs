#!/usr/bin/env node
// Screen-safety OCR for the hackathon cut: the rig's patterns plus this video's own (home paths,
// the OS user, emails, pairing codes, token files, the "hermes update" nag).
//
//   node demo/video/hackathon/safety.mjs <video.mp4>... [--every 1]
import { FORBIDDEN, scanVideo } from "../rig/screen-safety.mjs";
import { args } from "../rig/lib.mjs";
import { userInfo } from "node:os";

FORBIDDEN.push(
  /\/Users\//,
  new RegExp(`\\b${userInfo().username}\\b`, "i"),
  /\.hermes\/cache|scratch/i,
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}/,      // email addresses
  /pairing code|\b[A-Z0-9]{5}-[A-Z0-9]{5}\b/,             // /weft feed pairing codes
  /\.weft\/token|WEFT_AGENT_TOKEN|\.env\b/,
  /hermes update|source update/i,
  /HERMES_KANBAN|t_[0-9a-f]{8}\b/,                        // the kanban worker that filmed it
);
const a = args();
let bad = 0;
for (const f of a._) {
  const r = scanVideo(f, Number(a.every ?? 1));
  bad += r.hits.length;
  console.log(`${r.hits.length ? "FAIL" : "ok  "} ${f}: ${r.frames} frames, ${r.ocr_lines} OCR lines, ${r.hits.length} hit(s), ${FORBIDDEN.length} patterns`);
  for (const h of r.hits.slice(0, 20)) console.log(`     t=${h.t}s /${h.pattern}/  ${h.text.slice(0, 120)}`);
}
process.exit(bad ? 1 : 0);
