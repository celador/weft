#!/usr/bin/env node
// Render narration for script.md sections: one audio file per section.
//
//   node demo/video/rig/narrate.mjs --dry                       words + estimated seconds
//   node demo/video/rig/narrate.mjs --provider cf-aura2 --voice orion [--sections 01,02] [--out DIR]
//
// Providers (see ../narration.md for the comparison and the pick):
//   cf-aura2     Workers AI @cf/deepgram/aura-2-en (wrangler OAuth token, account below)
//   gpt-audio    OpenAI gpt-audio / gpt-audio-mini via OpenRouter (OPENROUTER_API_KEY), --model
//   edge         Microsoft Edge neural TTS via edge-tts (Hermes's own TTS provider)
//   say          macOS `say` (--voice Samantha …)
// Output: <out>/<id>.mp3 (44.1 kHz mono, loudness-normalised to -16 LUFS) + <out>/manifest.json.
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { args, sections, secretEnv, cloudflareToken, CF_ACCOUNT, sh, durationSec, VIDEO } from "./lib.mjs";

const a = args();
const all = sections(a.script);
const pick = a.sections ? all.filter((s) => String(a.sections).split(",").includes(s.id)) : all;

if (a.dry) {
  let total = 0;
  for (const s of all) {
    const w = s.text.split(/\s+/).length;
    total += w;
    console.log(`${s.id} ${s.title.padEnd(32)} ${String(w).padStart(4)} words  ~${Math.round((w / 150) * 60)}s`);
  }
  console.log(`total ${total} words  ~${(total / 150).toFixed(2)} min at 150 wpm (+ gaps/cards)`);
  process.exit(0);
}

const provider = a.provider ?? "cf-aura2";
const out = a.out ?? join(VIDEO, "audio");
mkdirSync(out, { recursive: true });
const tmp = join(process.env.TMPDIR ?? tmpdir(), `weft-narrate-${process.pid}`);
mkdirSync(tmp, { recursive: true });

// TTS-only spelling fixes (captions keep the script text). --lexicon <file.json> adds
// [["regex", "spoken"], ...] pairs applied first (e.g. the hackathon cut's calc_total).
const extra = a.lexicon ? JSON.parse(readFileSync(a.lexicon, "utf8")).map(([re, to]) => [new RegExp(re, "g"), to]) : [];
const speak = (t) =>
  extra
    .reduce((s, [re, to]) => s.replace(re, to), t)
    .replace(/\bWCP\b/g, "W C P")
    .replace(/\bTypeScript\b/g, "TypeScript")
    .replace(/\bcreateSession\b/g, "create Session")
    .replace(/\bChange-Id\b/g, "Change I D")
    .replace(/\bD1\b/g, "D-one")
    .replace(/\bR2\b/g, "R-two");

async function cfAura2(text, file) {
  const tok = (cfAura2.tok ??= cloudflareToken());
  const r = await fetch(`https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT}/ai/run/@cf/deepgram/aura-2-en`, {
    method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" },
    body: JSON.stringify({ text, speaker: a.voice ?? "orion", encoding: "mp3" }),
  });
  if (!r.ok) throw new Error(`aura-2 ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const ct = r.headers.get("content-type") ?? "";
  let buf;
  if (ct.includes("json")) {
    const j = await r.json();
    const b64 = j.result?.audio ?? j.audio;
    if (!b64) throw new Error(`aura-2: unexpected JSON ${JSON.stringify(j).slice(0, 200)}`);
    buf = Buffer.from(b64, "base64");
  } else buf = Buffer.from(await r.arrayBuffer());
  writeFileSync(file, buf);
}

async function gptAudio(text, file) {
  const key = secretEnv("OPENROUTER_API_KEY");
  if (!key) throw new Error("OPENROUTER_API_KEY not set");
  const r = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: a.model ?? "openai/gpt-audio",
      modalities: ["text", "audio"],
      audio: { voice: a.voice ?? "cedar", format: "pcm16" },
      stream: true,
      messages: [
        {
          role: "system",
          content:
            "You are the narrator of a technical product video. Read the user's text aloud exactly as written, word for word, " +
            "in a calm, confident, warm documentary voice at a measured pace. Do not add, drop or change any word. Do not answer it.",
        },
        { role: "user", content: text },
      ],
    }),
  });
  if (!r.ok) throw new Error(`gpt-audio ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const chunks = [];
  let transcript = "";
  let rest = "";
  for await (const part of r.body) {
    rest += Buffer.from(part).toString("utf8");
    const lines = rest.split("\n");
    rest = lines.pop();
    for (const line of lines) {
      if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
      const d = JSON.parse(line.slice(6));
      const au = d.choices?.[0]?.delta?.audio;
      if (au?.data) chunks.push(Buffer.from(au.data, "base64"));
      if (au?.transcript) transcript += au.transcript;
    }
  }
  if (!chunks.length) throw new Error("gpt-audio: no audio in stream");
  const pcm = join(tmp, "a.pcm");
  writeFileSync(pcm, Buffer.concat(chunks));
  sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "s16le", "-ar", "24000", "-ac", "1", "-i", pcm, file]);
  return { transcript };
}

function edge(text, file) {
  const py = `${process.env.HOME}/.hermes/hermes-agent/venv/bin/edge-tts`;
  // edge-tts < 7.3 gets HTTP 403 from the service: EDGE_TTS_BIN picks a newer one
  const bin = process.env.EDGE_TTS_BIN ?? (existsSync(py) ? py : "edge-tts");
  // the service fails at random (NoAudioReceived): retry with a pause
  for (let i = 0; ; i++) {
    try {
      return void sh(bin, ["--voice", a.voice ?? "en-US-AndrewMultilingualNeural", "--rate", a.rate ?? "+0%", "--text", text, "--write-media", file]);
    } catch (e) {
      if (i >= 4) throw e;
      execFileSync("sleep", [String(2 + i * 2)]);
    }
  }
}

function say(text, file) {
  const aiff = join(tmp, "s.aiff");
  sh("say", ["-v", a.voice ?? "Samantha", "-r", String(a.rate ?? 175), "-o", aiff, text]);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-i", aiff, file]);
}

const impl = { "cf-aura2": cfAura2, "gpt-audio": gptAudio, edge, say }[provider];
if (!impl) throw new Error(`unknown provider ${provider}`);

const manifest = { provider, voice: a.voice ?? null, model: a.model ?? null, rendered_at: new Date().toISOString(), sections: [] };
for (const s of pick) {
  const raw = join(tmp, `${s.id}.raw.mp3`);
  // Paragraph breaks become short pauses: render paragraphs separately and join with 0.45 s silence.
  const paras = speak(s.text).split("\n").filter(Boolean);
  const parts = [];
  let meta = {};
  for (const [i, p] of paras.entries()) {
    const f = join(tmp, `${s.id}.${i}.mp3`);
    meta = (await impl(p, f)) ?? meta;
    parts.push(f);
  }
  const silence = join(tmp, "gap.mp3");
  if (!existsSync(silence)) sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "lavfi", "-i", "anullsrc=r=44100:cl=mono", "-t", "0.45", silence]);
  const list = join(tmp, `${s.id}.txt`);
  writeFileSync(list, parts.flatMap((p, i) => (i ? [silence, p] : [p])).map((p) => `file '${p}'`).join("\n"));
  sh("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", list, "-ar", "44100", "-ac", "1", raw]);
  const dst = join(out, `${s.id}.mp3`);
  sh("ffmpeg", ["-y", "-loglevel", "error", "-i", raw, "-af", "loudnorm=I=-16:TP=-1.5:LRA=11", "-ar", "44100", "-ac", "1", "-b:a", "128k", dst]);
  const sec = durationSec(dst);
  const words = s.text.split(/\s+/).length;
  manifest.sections.push({ id: s.id, title: s.title, file: `${s.id}.mp3`, seconds: +sec.toFixed(2), words, wpm: Math.round((words / sec) * 60) });
  console.log(`${s.id} ${s.title}: ${sec.toFixed(1)} s, ${Math.round((words / sec) * 60)} wpm -> ${dst}`);
}
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
rmSync(tmp, { recursive: true, force: true });
