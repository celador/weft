#!/usr/bin/env node
// weft-job: the git side of Weft's workflows (B8). One process = one job:
//
//   rebase  replay a change's commits onto trunk with the layered merge
//           (git -> Mergiraf -> resolver agent; what is still conflicted bounces to the agent),
//           run the repo's tests on the result, optionally push it to the fork's
//           refs/heads/weft/rebased (so a resolver's work is not redone at landing)
//   land    rebase onto the current trunk + presubmit + compare-and-swap push of trunk
//           (fast-forward only, `--force-with-lease=<ref>:<onto>`; a lost race = stale_trunk)
//   revert  revert a landed range (before..after) on the current trunk + CAS push
//
//   node weft-job.mjs '<json JobSpec>'      (or: node weft-job.mjs @spec.json)
//
// stdout: exactly one line `{"weft_job": JobResult}` (the sandbox runner's script harness
// lifts it into result.json `outcome`). Progress goes to stderr as NDJSON.
//
// Secrets: on Cloudflare the container holds none; the sandbox's Outbound entrypoint adds the
// trunk/fork tokens to matching git requests. Locally, WEFT_GIT_AUTH='{"<url prefix>":"<token>"}'
// adds per-URL `http.<prefix>.extraHeader` via GIT_CONFIG_* env (never argv, never logged).
//
// Node >= 22, no dependencies (shared by the image and the workflows' Node tests).

import { spawn, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const ZERO_SHA = "0000000000000000000000000000000000000000";
let mergirafAvailable;
/** True when a `mergiraf` binary is on PATH (checked once per process). */
export function hasMergirafBinary() {
  if (mergirafAvailable === undefined) {
    const r = spawnSync("mergiraf", ["--version"], { stdio: "ignore" });
    mergirafAvailable = !r.error && r.status === 0;
  }
  return mergirafAvailable;
}

const MERGIRAF_DRIVER = "mergiraf merge --git %O %A %B -s %S -x %X -y %Y -p %P -l %L";
const MARKER = /^(<{7}|>{7}|={7}|\|{7})( |$)/m;
const DEFAULT_RESOLVER_MODEL = "@cf/qwen/qwen2.5-coder-32b-instruct";

function now() {
  return Date.now();
}

export function redact(s, extra = []) {
  let out = String(s);
  for (const x of extra) if (x && x.length >= 8) out = out.split(x).join("***");
  return out.replace(/art_v1_[0-9a-f]{16,}(\?expires=\d+)?/g, "art_v1_***").replace(/(authorization:\s*(bearer|basic)\s+)[^\s"']+/gi, "$1***");
}

/** Spawn without a shell; collects output; optional timeout (kills the process group). */
export function sh(argv, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(argv[0], argv.slice(1), { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ["ignore", "pipe", "pipe"], detached: Boolean(opts.timeoutMs) });
    let out = "";
    let err = "";
    let timedOut = false;
    let timer;
    if (opts.timeoutMs)
      timer = setTimeout(() => {
        timedOut = true;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, opts.timeoutMs);
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout: out, stderr: err + String(e.message), timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code: code ?? (signal ? 128 : 1), stdout: out, stderr: err, timedOut });
    });
  });
}

/** git env: no prompts, fixed identity, per-URL auth headers from WEFT_GIT_AUTH. */
export function gitEnv(base = process.env, identity = { name: "weft", email: "weft@agents.weft.dev" }) {
  const env = { ...base, GIT_TERMINAL_PROMPT: "0", GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
  const secrets = [];
  delete env.WEFT_GIT_AUTH;
  if (base.WEFT_GIT_AUTH) {
    const map = JSON.parse(base.WEFT_GIT_AUTH);
    const entries = Object.entries(map);
    env.GIT_CONFIG_COUNT = String(entries.length);
    entries.forEach(([prefix, token], i) => {
      env[`GIT_CONFIG_KEY_${i}`] = `http.${prefix}.extraHeader`;
      env[`GIT_CONFIG_VALUE_${i}`] = `Authorization: Bearer ${token}`;
      secrets.push(token);
    });
  }
  return { env, secrets };
}

class Job {
  constructor(spec, opts = {}) {
    this.spec = spec;
    this.t0 = now();
    this.timings = {};
    this.steps = [];
    const g = gitEnv(opts.env ?? process.env, spec.identity ?? { name: "weft-landing-queue", email: "landing@agents.weft.dev" });
    this.env = g.env;
    this.secrets = g.secrets;
    this.log = opts.log ?? ((o) => process.stderr.write(JSON.stringify(o) + "\n"));
  }
  note(step, extra = {}) {
    const e = { t: now() - this.t0, step, ...extra };
    this.steps.push(e);
    this.log(JSON.parse(redact(JSON.stringify(e), this.secrets)));
  }
  async timed(name, fn) {
    const s = now();
    try {
      return await fn();
    } finally {
      this.timings[`${name}_ms`] = (this.timings[`${name}_ms`] ?? 0) + now() - s;
    }
  }
  git(args, extraConfig = [], opts = {}) {
    const cfg = extraConfig.flatMap(([k, v]) => ["-c", `${k}=${v}`]);
    return sh(["git", ...cfg, ...args], { cwd: opts.cwd ?? this.dir, env: { ...this.env, ...(opts.env ?? {}) } });
  }
  async gitOk(args, extraConfig = [], opts = {}) {
    const r = await this.git(args, extraConfig, opts);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed (${r.code}): ${redact((r.stderr || r.stdout).trim(), this.secrets).slice(-1500)}`);
    return r.stdout.trim();
  }
  async rev(ref) {
    const r = await this.git(["rev-parse", "--verify", "-q", `${ref}^{commit}`]);
    return r.code === 0 ? r.stdout.trim() : null;
  }
  async isAncestor(a, b) {
    return (await this.git(["merge-base", "--is-ancestor", a, b])).code === 0;
  }

  async init() {
    this.dir = this.spec.work ?? (await mkdtemp(join(process.env.WEFT_WORK_ROOT ?? tmpdir(), "weft-job-")));
    await mkdir(this.dir, { recursive: true });
    await this.gitOk(["init", "-q", "--initial-branch=weft-work", "."]);
    // A file that routes every path through Mergiraf, used only for the mergiraf layer.
    this.attrs = join(this.dir, ".git", "weft-mergiraf.attributes");
    await writeFile(this.attrs, "* merge=mergiraf\n");
    await writeFile(join(this.dir, ".git", "weft-none.attributes"), "");
  }

  /** Fetch `branch` of `remote` into refs/weft/<name>; returns the sha or null if the branch does not exist. */
  async fetch(name, remote, branch, extra = []) {
    const refspecs = [`+refs/heads/${branch}:refs/weft/${name}`, ...extra];
    const r = await this.timed(`fetch_${name}`, () => this.git(["fetch", "--quiet", "--no-tags", remote, ...refspecs]));
    if (r.code !== 0) {
      if (/couldn't find remote ref|not our ref|no such ref/i.test(r.stderr)) return null;
      throw new Error(`fetch ${name} failed: ${redact(r.stderr.trim(), this.secrets).slice(-1500)}`);
    }
    return this.rev(`refs/weft/${name}`);
  }

  layerConfig(layer) {
    const base = [
      ["merge.conflictStyle", "diff3"],
      ["rerere.enabled", "false"],
      ["commit.gpgSign", "false"],
    ];
    if (layer === "git") return [...base, ["core.attributesFile", join(this.dir, ".git", "weft-none.attributes")]];
    return [...base, ["core.attributesFile", this.attrs], ["merge.mergiraf.name", "mergiraf"], ["merge.mergiraf.driver", MERGIRAF_DRIVER]];
  }

  async conflicted() {
    const r = await this.git(["diff", "--name-only", "--diff-filter=U"]);
    return r.stdout.split("\n").filter(Boolean);
  }

  layers() {
    const layers = this.spec.layers ?? ["git", "mergiraf", "resolver"];
    // Without the mergiraf binary the merge driver fails and git leaves the file
    // WITHOUT conflict markers, which would hide the conflict from the resolver and
    // the bounce report. Skip the layer instead (the production image ships mergiraf).
    return hasMergirafBinary() ? layers : layers.filter((l) => l !== "mergiraf");
  }

  /**
   * Apply one commit onto HEAD with the layered merge. `kind` = cherry-pick | revert.
   * Returns {ok, layer, conflicts?, resolver?}. On failure the operation is aborted.
   */
  async applyLayered(kind, target, ctx) {
    const layers = this.layers();
    const mergeLayers = layers.filter((l) => l === "git" || l === "mergiraf");
    const args = kind === "cherry-pick" ? ["cherry-pick", "--allow-empty", "--keep-redundant-commits", target] : ["revert", "--no-edit", target];
    let lastConflicts = [];
    let described = [];
    for (let i = 0; i < mergeLayers.length; i++) {
      const layer = mergeLayers[i];
      const isLast = i === mergeLayers.length - 1;
      const r = await this.timed(`layer_${layer}`, () => this.git(args, this.layerConfig(layer)));
      if (r.code === 0) return { ok: true, layer };
      lastConflicts = await this.conflicted();
      if (!lastConflicts.length) {
        await this.git([kind, "--abort"]);
        throw new Error(`${kind} ${target.slice(0, 12)} failed without conflicts: ${redact(r.stderr.trim(), this.secrets).slice(-800)}`);
      }
      described = await this.describeConflicts(lastConflicts, target);
      this.note("conflict", { layer, commit: target, files: lastConflicts });
      if (isLast && layers.includes("resolver") && this.spec.resolver) break; // keep the tree for the resolver
      await this.git([kind, "--abort"]);
    }
    if (!(layers.includes("resolver") && this.spec.resolver)) return { ok: false, layer: mergeLayers[mergeLayers.length - 1] ?? "git", conflicts: described };

    // Layer 3: resolver agent on the files Mergiraf could not merge.
    const res = await this.timed("layer_resolver", () => this.resolve(lastConflicts, target, ctx));
    if (res.ok) {
      await this.gitOk(["add", "--", ...lastConflicts]);
      let c = await this.git([kind, "--continue"], this.layerConfig("git"), { env: { GIT_EDITOR: "true" } });
      // The resolution may equal trunk (the change is subsumed): keep an empty commit, like --keep-redundant-commits.
      if (c.code !== 0 && /now empty/i.test(c.stderr + c.stdout)) c = await this.git(["commit", "--allow-empty", "--no-edit", "--no-verify"], this.layerConfig("git"), { env: { GIT_EDITOR: "true" } });
      if (c.code === 0) return { ok: true, layer: "resolver", resolver: res.info };
      res.info.error = redact(c.stderr.trim(), this.secrets).slice(-500);
    }
    this.note("resolver_failed", { commit: target, ...res.info });
    await this.git([kind, "--abort"]);
    return { ok: false, layer: "resolver", conflicts: described, resolver: res.info };
  }

  /** Conflict report for the bounce: file + the conflicted hunks (with markers), truncated. */
  async describeConflicts(files, commit) {
    const out = [];
    for (const f of files.slice(0, 20)) {
      let text = "";
      try {
        text = await readFile(join(this.dir, f), "utf8");
      } catch {}
      const hunks = [];
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && hunks.length < 5; i++) {
        if (!lines[i].startsWith("<<<<<<<")) continue;
        const start = i;
        while (i < lines.length && !lines[i].startsWith(">>>>>>>")) i++;
        hunks.push({ line: start + 1, text: lines.slice(start, i + 1).join("\n").slice(0, 2000) });
      }
      out.push({ file: f, commit, hunks });
    }
    return out;
  }

  async resolve(files, commit, ctx) {
    const r = this.spec.resolver;
    const info = { kind: r.kind, files };
    try {
      if (r.kind === "command") {
        const res = await sh(r.argv, { cwd: this.dir, env: { ...this.env, WEFT_CONFLICT_FILES: files.join("\n"), WEFT_CONFLICT_COMMIT: commit }, timeoutMs: (r.timeout_s ?? 600) * 1000 });
        info.exit = res.code;
        info.output = redact((res.stdout + res.stderr).slice(-1500), this.secrets);
        if (res.code !== 0) return { ok: false, info: { ...info, error: "resolver exited non-zero" } };
      } else if (r.kind === "llm") {
        const url = r.url ?? (process.env.WEFT_AIG_BASE_URL ? `${process.env.WEFT_AIG_BASE_URL}/workers-ai/v1/chat/completions` : null);
        if (!url) return { ok: false, info: { ...info, error: "no resolver url (WEFT_AIG_BASE_URL unset)" } };
        info.model = r.model ?? DEFAULT_RESOLVER_MODEL;
        const subject = (await this.git(["log", "-1", "--format=%B", commit])).stdout.trim().slice(0, 2000);
        info.usage = [];
        for (const f of files) {
          const text = await readFile(join(this.dir, f), "utf8");
          if (text.length > (r.max_bytes ?? 60_000)) return { ok: false, info: { ...info, error: `${f} too large for the resolver` } };
          const body = {
            model: info.model,
            temperature: 0,
            max_tokens: 8192,
            messages: [
              {
                role: "system",
                content:
                  "You resolve git merge conflicts. You get one file containing conflict markers (diff3 style: <<<<<<< ours, ||||||| base, ======= , >>>>>>> theirs). 'ours' is the current trunk, 'theirs' is the change being replayed onto it. Produce the complete resolved file that keeps the intent of BOTH sides. Output ONLY the file content, no explanations, no markdown fences.",
              },
              { role: "user", content: `Change being replayed:\n${subject}\n\n${ctx?.intent ? `Task: ${ctx.intent}\n\n` : ""}${explainHunks(text)}File: ${f}\n\n${text}` },
            ],
          };
          const resp = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
          const raw = await resp.text();
          if (!resp.ok) return { ok: false, info: { ...info, error: `resolver HTTP ${resp.status}: ${raw.slice(0, 300)}` } };
          const j = JSON.parse(raw);
          info.usage.push(j.usage ?? null);
          let content = j.choices?.[0]?.message?.content ?? j.response ?? j.result?.response ?? "";
          content = stripFences(String(content));
          if (!content.trim()) return { ok: false, info: { ...info, error: `empty resolution for ${f}` } };
          if (!content.endsWith("\n") && text.endsWith("\n")) content += "\n";
          // Guard against truncated/garbled answers: the result must be about as long as the smaller side.
          const sides = await Promise.all([":2:", ":3:"].map(async (st) => (await this.git(["show", `${st}${f}`])).stdout));
          const floor = Math.floor(Math.min(...sides.map((x) => x.length).filter((n) => n > 0), text.length) * 0.5);
          if (content.length < floor) return { ok: false, info: { ...info, error: `resolution for ${f} is suspiciously short (${content.length} < ${floor} bytes)` } };
          // One-sided answers silently drop the other side's edit (trunk's or the change's): fail closed.
          const norm = (x) => x.replace(/\s+$/g, "");
          if (norm(content) === norm(sides[0])) return { ok: false, info: { ...info, error: `resolution for ${f} drops the change's edit (identical to trunk)` } };
          if (norm(content) === norm(sides[1])) return { ok: false, info: { ...info, error: `resolution for ${f} drops trunk's edit (identical to the change)` } };
          await writeFile(join(this.dir, f), content);
        }
      } else return { ok: false, info: { ...info, error: `unknown resolver ${r.kind}` } };
      for (const f of files) {
        const t = await readFile(join(this.dir, f), "utf8").catch(() => "");
        if (MARKER.test(t)) return { ok: false, info: { ...info, error: `${f} still has conflict markers` } };
      }
      // Cheap syntax gate when the repo can check it (TS/JS): node --check for .js/.mjs.
      return { ok: true, info };
    } catch (e) {
      return { ok: false, info: { ...info, error: String(e?.message ?? e).slice(0, 500) } };
    }
  }

  /** Replay head's commits since merge-base(onto, head) onto `onto`. */
  async rebase(onto, head) {
    if (onto === null) return { status: "up_to_date", onto: ZERO_SHA, head, rebased: head, base: null, layer: "none", commits: [] };
    if (await this.isAncestor(onto, head)) return { status: "up_to_date", onto, head, rebased: head, base: onto, layer: "none", commits: [] };
    const mb = await this.git(["merge-base", onto, head]);
    if (mb.code !== 0) return { status: "conflict", onto, head, base: null, layer: "git", commits: [], conflicts: [{ file: "*", commit: head, hunks: [], note: "no common history with trunk" }] };
    const base = mb.stdout.trim();
    const list = (await this.gitOk(["rev-list", "--reverse", "--topo-order", "--no-merges", `${base}..${head}`])).split("\n").filter(Boolean);
    await this.gitOk(["checkout", "-q", "--detach", onto]);
    const commits = [];
    const rank = { none: 0, git: 1, mergiraf: 2, resolver: 3 };
    let layer = "git";
    for (const c of list) {
      const r = await this.applyLayered("cherry-pick", c, { intent: this.spec.intent });
      if (!r.ok) return { status: "conflict", onto, head, base, layer: r.layer, commits, conflicts: r.conflicts, ...(r.resolver ? { resolver: r.resolver } : {}) };
      const now_ = await this.rev("HEAD");
      commits.push({ orig: c, new: now_, layer: r.layer, ...(r.resolver ? { resolver: r.resolver } : {}) });
      if (rank[r.layer] > rank[layer]) layer = r.layer;
    }
    const rebased = await this.rev("HEAD");
    return { status: layer === "resolver" ? "resolved" : "clean", onto, head, base, rebased, layer, commits };
  }

  async diffstat(from, to) {
    if (!from || from === ZERO_SHA) return { files: 0, insertions: 0, deletions: 0 };
    const r = await this.git(["diff", "--numstat", from, to]);
    let files = 0,
      ins = 0,
      del = 0;
    for (const l of r.stdout.split("\n").filter(Boolean)) {
      const [a, d] = l.split("\t");
      files++;
      ins += Number(a) || 0;
      del += Number(d) || 0;
    }
    return { files, insertions: ins, deletions: del };
  }

  /** B10: unified diff (capped) + changed files, for the risk classifier and the review agent. */
  async patch(from, to, max = 48_000) {
    if (!from || from === ZERO_SHA || !to) return { patch: "", files: [], truncated: false };
    const d = await this.git(["diff", "--no-color", "--no-ext-diff", "-U3", from, to]);
    const ns = await this.git(["diff", "--name-status", "--no-renames", from, to]);
    const files = ns.stdout.split("\n").filter(Boolean).slice(0, 500).map((l) => {
      const [status, ...rest] = l.split("\t");
      return { status, path: rest.join("\t") };
    });
    const text = redact(d.stdout, this.secrets);
    return { patch: text.slice(0, max), files, truncated: text.length > max };
  }

  /**
   * Run the repo's tests on `sha`. `select` (ProcessRevision checkpoints only): affected-test
   * selection against `onto` when the repo config has `tests.select`; anything the selector
   * cannot vouch for runs the full suite with the reason in `selection`. The land presubmit
   * passes `select = { full: reason }` and always runs the full suite.
   */
  async tests(sha, select = null) {
    const t = this.spec.tests;
    if (!t || !t.command || (Array.isArray(t.command) && !t.command.length)) return { status: "skipped", reason: "no test command configured" };
    await this.gitOk(["checkout", "-q", "--detach", sha]);
    const fullArgv = Array.isArray(t.command) ? t.command : ["sh", "-c", t.command];
    let argv = fullArgv;
    let selection = null;
    if (t.select && select) {
      selection = await this.timed("select", () => this.selectTests(sha, select));
      if (selection.mode === "subset") {
        if (!selection.selected.length) {
          const { selected, why, ...rest } = selection;
          return { status: "pass", exit: 0, timed_out: false, ms: 0, command: "(no tests reach the change)", summary: { pass: 0, fail: 0 }, tail: "", selection: { ...rest, files: [], why: {} } };
        }
        argv = selectedCommand(t.select.command ?? t.command, selection.selected);
      }
    }
    const s = now();
    const r = await this.timed("tests", () => sh(argv, { cwd: this.dir, env: { ...this.env, CI: "1" }, timeoutMs: (t.timeout_s ?? 900) * 1000 }));
    const output = redact(r.stdout + (r.stderr ? `\n${r.stderr}` : ""), this.secrets);
    const out = {
      status: r.code === 0 && !r.timedOut ? "pass" : "fail",
      exit: r.code,
      timed_out: r.timedOut,
      ms: now() - s,
      command: argv.join(" ").slice(0, 300),
      summary: summarizeTests(output),
      tail: output.slice(-4000),
    };
    if (selection) {
      const { selected, why, ...rest } = selection;
      out.selection = { ...rest, files: selected.slice(0, 100), why: Object.fromEntries(Object.entries(why ?? {}).slice(0, 100)) };
    }
    return out;
  }

  /** Affected-test selection (packages/analyzer/src/testselect.ts, bundled into the image). */
  async selectTests(sha, select) {
    const t0 = now();
    const cfg = this.spec.tests.select === true ? {} : this.spec.tests.select;
    const base = { mode: "full", selected: [], total: null, why: {}, writes: [], graph: null };
    let mod;
    try {
      mod = await loadSelector();
    } catch (e) {
      return { ...base, reason: `test selector unavailable: ${String(e?.message ?? e).slice(0, 200)}`, ms: now() - t0 };
    }
    try {
      const ls = await this.gitOk(["ls-tree", "-r", "-z", "--full-tree", sha]);
      const blobs = {};
      for (const entry of ls.split("\0").filter(Boolean)) {
        const tab = entry.indexOf("\t");
        const [mode, type, blob] = entry.slice(0, tab).split(" ");
        if (type === "blob" && mode !== "120000") blobs[entry.slice(tab + 1)] = blob;
      }
      const files = Object.keys(blobs);
      if (select.full) {
        const tests = mod.discoverTests(files, cfg);
        return { ...base, reason: select.full, total: tests.length, selected: tests, ms: now() - t0 };
      }
      const onto = select.onto;
      if (!onto || onto === ZERO_SHA) {
        const tests = mod.discoverTests(files, cfg);
        return { ...base, reason: "no trunk to diff against", total: tests.length, selected: tests, ms: now() - t0 };
      }
      const ns = await this.gitOk(["diff", "--name-status", "--no-renames", "-z", onto, sha]);
      const parts = ns.split("\0").filter(Boolean);
      const changed = [];
      for (let i = 0; i + 1 < parts.length; i += 2) changed.push({ status: parts[i][0], path: parts[i + 1] });
      const readBefore = (p) => {
        const r = spawnSync("git", ["show", `${onto}:${p}`], { cwd: this.dir, env: this.env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
        return r.status === 0 ? r.stdout : undefined;
      };
      const read = (p) => {
        try {
          return readFileSync(join(this.dir, p), "utf8");
        } catch {
          return undefined;
        }
      };
      const cache = await loadFactsCache();
      const sel = mod.selectTests({ files, read, readBefore, changed, risk: select.risk ?? null, config: cfg, blobs, cache: cache.map });
      await cache.save().catch(() => undefined);
      return { ...sel, tests: undefined, onto, changed: changed.length, ms: now() - t0 };
    } catch (e) {
      return { ...base, reason: `test selection failed: ${redact(String(e?.message ?? e), this.secrets).slice(0, 300)}`, ms: now() - t0 };
    }
  }

  /** CAS push: refs/heads/<branch> from `expected` to `sha` (fast-forward checked by the caller). */
  async casPush(remote, branch, sha, expected) {
    const ref = `refs/heads/${branch}`;
    const lease = `--force-with-lease=${ref}:${expected === ZERO_SHA ? "" : expected}`;
    const r = await this.timed("push", () => this.git(["push", "--porcelain", lease, remote, `${sha}:${ref}`]));
    const line = r.stdout.split("\n").find((l) => l.includes(`:${ref}\t`)) ?? "";
    if (r.code === 0 && line[0] !== undefined && line[0] !== "!") return { ok: true, ref, before: expected, after: sha };
    const detail = redact((line || r.stderr).trim(), this.secrets).slice(-800);
    if (/stale info|stale ref|incorrect old value|fetch first|cannot lock ref|failed to update ref|but expected|non-fast-forward/i.test(detail + r.stderr)) {
      const cur = await this.git(["ls-remote", remote, ref]);
      const current = cur.stdout.split("\t")[0]?.trim() || ZERO_SHA;
      if (current !== expected) return { ok: false, reason: "stale_trunk", ref, expected, current, detail };
    }
    return { ok: false, reason: "rejected", ref, expected, detail: detail || `git push exited ${r.code}` };
  }
}

/** Plain-language summary of each diff3 hunk (base -> trunk, base -> change) for the resolver prompt. */
export function explainHunks(text) {
  const out = [];
  const re = /^<{7}[^\n]*\n([\s\S]*?)^\|{7}[^\n]*\n([\s\S]*?)^={7}\n([\s\S]*?)^>{7}[^\n]*$/gm;
  let m;
  let i = 0;
  while ((m = re.exec(text)) && i < 10) {
    i++;
    const [, ours, base, theirs] = m;
    out.push(`Conflict ${i}:\n- base:\n${base.trimEnd()}\n- trunk changed it to:\n${ours.trimEnd()}\n- the change changed it to:\n${theirs.trimEnd()}\nApply BOTH edits to the base (for example combine a new value from one side with a new form from the other).`);
  }
  return out.length ? `${out.join("\n\n")}\n\n` : "";
}

export function stripFences(s) {
  const m = /^\s*```[\w.+-]*\n([\s\S]*?)\n```\s*$/.exec(s);
  return m ? m[1] + "\n" : s;
}

/** Pull pass/fail counts out of common runners' output (node:test, vitest, jest, tap). */
export function summarizeTests(out) {
  const n = (re) => {
    const m = re.exec(out);
    return m ? Number(m[1]) : undefined;
  };
  const s = { pass: n(/^# pass (\d+)/m) ?? n(/ℹ pass (\d+)/m) ?? n(/Tests\s+.*?(\d+) passed/m), fail: n(/^# fail (\d+)/m) ?? n(/ℹ fail (\d+)/m) ?? n(/Tests\s+.*?(\d+) failed/m) };
  return Object.fromEntries(Object.entries(s).filter(([, v]) => v !== undefined));
}

// ------------------------------------------------------------------------------- test selection

let selectorModule;
/**
 * The affected-test selector (packages/analyzer/src/testselect.ts). In the image it is a bundle
 * next to this file (testselect/weft-testselect.mjs, staged by scripts/stage.mjs); in the repo's
 * Node tests WEFT_TESTSELECT points at the TypeScript source. Missing = full suite.
 */
export async function loadSelector() {
  if (selectorModule) return selectorModule;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [process.env.WEFT_TESTSELECT, join(here, "testselect", "weft-testselect.mjs"), join(here, "vendor", "testselect", "weft-testselect.mjs")].filter(Boolean);
  let last;
  for (const c of candidates) {
    try {
      selectorModule = await import(c.startsWith("file:") ? c : pathToFileURL(c).href);
      return selectorModule;
    } catch (e) {
      last = e;
    }
  }
  throw last ?? new Error("no selector module");
}

/**
 * Parse facts keyed by git blob sha: every candidate on the same trunk sha shares the trunk's
 * graph, and a warm container keeps it across jobs. Bounded; stale entries are harmless
 * (a blob sha names exact contents).
 */
async function loadFactsCache() {
  const dir = process.env.WEFT_CACHE_DIR ?? join(process.env.WEFT_WORK_ROOT ?? tmpdir(), "weft-cache");
  const file = join(dir, "testselect-facts-v1.json");
  let map = new Map();
  try {
    map = new Map(Object.entries(JSON.parse(await readFile(file, "utf8"))));
  } catch {}
  const size0 = map.size;
  return {
    map,
    async save() {
      if (map.size === size0) return;
      const entries = [...map.entries()].slice(-50_000);
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(Object.fromEntries(entries)));
      await rename(tmp, file);
    },
  };
}

/** Test command for the selected files: `{files}` placeholder in an argv/string, else appended. */
export function selectedCommand(command, files) {
  const q = (s) => `'${s.replace(/'/g, `'\\''`)}'`;
  if (Array.isArray(command)) {
    const i = command.indexOf("{files}");
    return i >= 0 ? [...command.slice(0, i), ...files, ...command.slice(i + 1)] : [...command, ...files];
  }
  const joined = files.map(q).join(" ");
  return ["sh", "-c", command.includes("{files}") ? command.replace("{files}", joined) : `${command} ${joined}`];
}

// ------------------------------------------------------------------------------- jobs

async function rebaseJob(job) {
  const s = job.spec;
  const onto = await job.fetch("trunk", s.trunk.remote, s.trunk.branch ?? "main");
  const tip = await job.fetch("fork", s.fork.remote, s.fork.branch ?? "main");
  const head = s.fork.sha ?? tip;
  if (!head || (await job.rev(head)) === null) return { status: "error", error: `change head ${s.fork.sha ?? "(branch)"} not found in the fork` };
  job.note("fetched", { onto, head, fork_tip: tip });
  const rb = await job.timed("rebase", () => job.rebase(onto, head));
  job.note("rebased", { status: rb.status, layer: rb.layer, rebased: rb.rebased ?? null });
  const out = { job: "rebase", ...rb, superseded: tip !== null && tip !== head ? tip : undefined };
  if (rb.status === "conflict") return out;
  out.diffstat = await job.diffstat(onto, rb.rebased);
  if (s.patch !== false) {
    const pt = await job.patch(onto, rb.rebased);
    out.patch = pt.patch;
    out.files = pt.files;
    if (pt.truncated) out.patch_truncated = true;
  }
  // Checkpoint feedback: affected tests only (when the repo opts in with tests.select).
  out.tests = await job.tests(rb.rebased, s.select === false ? null : { onto, risk: s.select?.risk ?? null });
  job.note("tested", { status: out.tests.status, selection: out.tests.selection ? { mode: out.tests.selection.mode, selected: out.tests.selection.files?.length ?? 0, total: out.tests.selection.total, reason: out.tests.selection.reason } : null });
  if (s.push_rebased && rb.rebased !== head) {
    const ref = typeof s.push_rebased === "string" ? s.push_rebased : "refs/heads/weft/rebased";
    const p = await job.timed("push_rebased", () => job.git(["push", "--porcelain", "--force", s.fork.remote, `${rb.rebased}:${ref}`]));
    out.pushed = p.code === 0 ? { ref, sha: rb.rebased } : { ref, error: redact(p.stderr.trim(), job.secrets).slice(-500) };
  }
  return out;
}

async function landJob(job) {
  const s = job.spec;
  const branch = s.trunk.branch ?? "main";
  const onto = await job.fetch("trunk", s.trunk.remote, branch);
  const tip = await job.fetch("fork", s.fork.remote, s.fork.branch ?? "main");
  // A resolver's earlier result (ProcessRevision pushed it); optional — absent when the change was already up to date.
  if (s.rebased) await job.fetch("rebased", s.fork.remote, "weft/rebased").catch(() => null);
  const head = s.fork.sha ?? tip;
  if (!head || (await job.rev(head)) === null) return { job: "land", status: "error", error: `change head ${s.fork.sha ?? "(branch)"} not found in the fork` };
  if (s.expected_trunk && onto !== s.expected_trunk && s.strict_expected) return { job: "land", status: "stale_trunk", expected: s.expected_trunk, current: onto };
  let rb;
  // Reuse a resolver's earlier rebase when it is exactly on today's trunk.
  if (s.rebased && s.rebased.onto === onto && (await job.rev(s.rebased.sha)) !== null && (await job.isAncestor(onto ?? s.rebased.sha, s.rebased.sha))) {
    rb = { status: "clean", onto, head, rebased: s.rebased.sha, layer: s.rebased.layer ?? "reused", commits: [], reused: true };
  } else rb = await job.timed("rebase", () => job.rebase(onto, head));
  job.note("rebased", { status: rb.status, layer: rb.layer, rebased: rb.rebased ?? null });
  if (rb.status === "conflict") return { job: "land", ...rb };
  const out = { job: "land", ...rb, diffstat: await job.diffstat(onto, rb.rebased) };
  // The presubmit before the trunk CAS push ALWAYS runs the full suite (selection is only a
  // checkpoint-feedback speedup); the selection record just says so and counts the tests.
  out.tests = await job.tests(rb.rebased, { full: "land presubmit always runs the full suite" });
  if (out.tests.status === "fail") return { ...out, status: "tests_failed" };
  if (s.dry_run) return { ...out, status: "ready" };
  const expected = onto ?? ZERO_SHA;
  if (rb.rebased === expected) return { ...out, status: "noop", before: expected, after: expected };
  const p = await job.casPush(s.trunk.remote, branch, rb.rebased, expected);
  job.note("pushed", { ok: p.ok, reason: p.reason ?? null });
  if (p.ok) return { ...out, status: "landed", before: p.before, after: p.after, ref: p.ref };
  return { ...out, status: p.reason, expected: p.expected, current: p.current, detail: p.detail };
}

/**
 * Batched landing (design §6.4 update t_5f9c01c1). Stack the changes in queue order onto
 * trunk (each rebased onto the previous one's result with the layered merge; a change that
 * conflicts is dropped from the stack and reported), run the full presubmit ONCE on the
 * stacked tip and CAS-push it. On failure, bisect over prefixes of the stack (binary search
 * for the shortest failing prefix: ceil(log2 n) more runs) to isolate the first culprit; the
 * passing prefix is pushed, the culprit is reported with its failing run, and the changes
 * after it are `pending` (not landed this round; the workflow re-stacks them without it).
 * Every change keeps its own before/after range on trunk, so one change of a batch can be
 * reverted on its own.
 */
async function landBatchJob(job) {
  const s = job.spec;
  const branch = s.trunk.branch ?? "main";
  const full = { full: "land presubmit always runs the full suite" };
  const onto = await job.fetch("trunk", s.trunk.remote, branch);
  const items = [];
  const heads = [];
  for (let i = 0; i < s.changes.length; i++) {
    const c = s.changes[i];
    const tip = await job.fetch(`fork-${i}`, c.remote, c.branch ?? "main");
    if (c.rebased) await job.fetch(`rebased-${i}`, c.remote, "weft/rebased").catch(() => null);
    const head = c.sha ?? tip;
    if (!head || (await job.rev(head)) === null) return { job: "land_batch", status: "error", error: `change ${c.change} head ${c.sha ?? "(branch)"} not found in its fork` };
    heads.push(head);
  }
  job.note("fetched", { onto, changes: s.changes.length });

  // 1. Stack.
  let cur = onto;
  const stacked = [];
  for (let i = 0; i < s.changes.length; i++) {
    const c = s.changes[i];
    const head = heads[i];
    s.intent = c.intent ?? undefined; // the resolver prompt names the change being replayed
    let rb;
    if (c.rebased && cur !== null && c.rebased.onto === cur && (await job.rev(c.rebased.sha)) !== null && (await job.isAncestor(cur, c.rebased.sha)))
      rb = { status: "clean", onto: cur, head, rebased: c.rebased.sha, layer: c.rebased.layer ?? "reused", commits: [], reused: true };
    else rb = await job.timed("rebase", () => job.rebase(cur, head));
    job.note("stacked", { change: c.change, status: rb.status, layer: rb.layer, rebased: rb.rebased ?? null });
    if (rb.status === "conflict") {
      items.push({ change: c.change, status: "conflict", head, layer: rb.layer, conflicts: rb.conflicts, ...(rb.resolver ? { resolver: rb.resolver } : {}), commits: rb.commits ?? [] });
      continue;
    }
    const before = cur ?? ZERO_SHA;
    const item = { change: c.change, status: "pending", head, before, after: rb.rebased, layer: rb.layer, commits: (rb.commits ?? []).map((x) => ({ orig: x.orig, new: x.new, layer: x.layer })), diffstat: await job.diffstat(before, rb.rebased) };
    items.push(item);
    stacked.push(item);
    cur = rb.rebased;
  }
  const batch = { size: s.changes.length, presubmit_runs: 0, bisect_steps: 0, tested: [], culprit: null, passing_prefix: 0 };
  const out = { job: "land_batch", onto: onto ?? ZERO_SHA, items, batch };
  if (!stacked.length) return { ...out, status: "conflict" };

  // 2. One presubmit on the stacked tip.
  const tip = stacked[stacked.length - 1].after;
  out.tests = await job.tests(tip, full);
  batch.presubmit_runs++;
  batch.tested.push({ prefix: stacked.length, status: out.tests.status === "fail" ? "fail" : "pass", ms: out.tests.ms });
  let pass = stacked.length;
  if (out.tests.status === "fail") {
    // 3. Bisect: lo = longest prefix known to pass (0 = trunk), hi = shortest known to fail.
    let lo = 0;
    let hi = stacked.length;
    let failing = out.tests;
    let passing = null;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      const t = await job.tests(stacked[mid - 1].after, full);
      batch.presubmit_runs++;
      batch.bisect_steps++;
      batch.tested.push({ prefix: mid, status: t.status === "fail" ? "fail" : "pass", ms: t.ms });
      job.note("bisect", { prefix: mid, status: t.status });
      if (t.status === "fail") {
        hi = mid;
        failing = t;
      } else {
        lo = mid;
        passing = t;
      }
    }
    const culprit = stacked[hi - 1];
    culprit.status = "culprit";
    batch.culprit = culprit.change;
    out.culprit_tests = failing;
    if (passing) out.passing_tests = passing;
    pass = lo;
  } else out.passing_tests = out.tests;
  batch.passing_prefix = pass;
  for (let k = 0; k < pass; k++) stacked[k].status = s.dry_run ? "ready" : "landed";
  if (pass === 0) return { ...out, status: "tests_failed", before: onto ?? ZERO_SHA, after: onto ?? ZERO_SHA };
  if (s.dry_run) return { ...out, status: "ready" };

  // 4. One CAS push for the passing prefix (trunk: onto -> its last change).
  const expected = onto ?? ZERO_SHA;
  const target = stacked[pass - 1].after;
  if (target === expected) return { ...out, status: "noop", before: expected, after: expected };
  const p = await job.casPush(s.trunk.remote, branch, target, expected);
  job.note("pushed", { ok: p.ok, reason: p.reason ?? null, landed: pass });
  if (p.ok) return { ...out, status: "landed", before: p.before, after: p.after, ref: p.ref };
  for (let k = 0; k < pass; k++) stacked[k].status = "pending";
  return { ...out, status: p.reason, expected: p.expected, current: p.current, detail: p.detail };
}

async function revertJob(job) {
  const s = job.spec;
  const branch = s.trunk.branch ?? "main";
  const onto = await job.fetch("trunk", s.trunk.remote, branch);
  if (!onto) return { job: "revert", status: "error", error: "trunk has no commits" };
  const { before, after } = s.revert;
  if ((await job.rev(after)) === null) return { job: "revert", status: "error", error: `landed sha ${after} not on trunk` };
  if (!(await job.isAncestor(after, onto))) return { job: "revert", status: "error", error: `${after} is not on trunk any more` };
  // Idempotent: an earlier attempt may have pushed the revert and failed before it was logged.
  if (s.revert.op_id) {
    const done = (await job.git(["log", "--format=%H", "-1", "--fixed-strings", `--grep=Weft-Reverts-Op: ${s.revert.op_id}`, `${after}..${onto}`])).stdout.trim();
    if (done) return { job: "revert", status: "reverted", onto, layer: "none", commits: [], sha: done, before: (await job.rev(`${done}^`)) ?? ZERO_SHA, after: done, already: true };
  }
  // Newest first (revert order). Without a known `before`, only the landed commit itself.
  const list = before && before !== ZERO_SHA ? (await job.gitOk(["rev-list", "--topo-order", "--no-merges", `${before}..${after}`])).split("\n").filter(Boolean) : [after];
  await job.gitOk(["checkout", "-q", "--detach", onto]);
  const commits = [];
  let layer = "git";
  const rank = { git: 1, mergiraf: 2, resolver: 3 };
  for (const c of list) {
    const r = await job.applyLayered("revert", c, { intent: `revert: ${s.revert.reason ?? ""}` });
    if (!r.ok) return { job: "revert", status: "conflict", onto, layer: r.layer, conflicts: r.conflicts, commits };
    commits.push({ orig: c, new: await job.rev("HEAD"), layer: r.layer });
    if (rank[r.layer] > rank[layer]) layer = r.layer;
  }
  // Squash the per-commit reverts into one commit that names the operation.
  const msg = [
    `Revert ${s.revert.change ? `change ${s.revert.change}` : `${before?.slice(0, 12)}..${after.slice(0, 12)}`}`,
    "",
    `Reason: ${s.revert.reason ?? "unspecified"}`,
    "",
    `Reverts op ${s.revert.op_id ?? "?"} (${before ?? ZERO_SHA}..${after}).`,
    ...(s.revert.op_id ? [`Weft-Reverts-Op: ${s.revert.op_id}`] : []),
  ].join("\n");
  await job.gitOk(["reset", "--soft", onto]);
  await job.gitOk(["commit", "-q", "--allow-empty", "-m", msg], [["commit.gpgSign", "false"]]);
  const sha = await job.rev("HEAD");
  const out = { job: "revert", onto, layer, commits, sha, diffstat: await job.diffstat(onto, sha) };
  if (s.tests) out.tests = await job.tests(sha);
  if (s.dry_run) return { ...out, status: "ready" };
  const p = await job.casPush(s.trunk.remote, branch, sha, onto);
  if (p.ok) return { ...out, status: "reverted", before: p.before, after: p.after, ref: p.ref };
  return { ...out, status: p.reason, expected: p.expected, current: p.current, detail: p.detail };
}

export function validateJob(spec) {
  const errs = [];
  if (!spec || typeof spec !== "object") return ["spec must be an object"];
  if (!["rebase", "land", "revert", "land_batch"].includes(spec.job)) errs.push("job must be rebase|land|revert|land_batch");
  if (!spec.trunk?.remote) errs.push("trunk.remote required");
  if ((spec.job === "rebase" || spec.job === "land") && !spec.fork?.remote) errs.push("fork.remote required");
  if (spec.job === "revert" && !spec.revert?.after) errs.push("revert.after required");
  if (spec.job === "land_batch") {
    if (!Array.isArray(spec.changes) || !spec.changes.length) errs.push("changes required (non-empty array)");
    else if (spec.changes.some((c) => !c?.remote || !c?.change)) errs.push("every change needs change + remote");
  }
  if (spec.resolver && !["llm", "command"].includes(spec.resolver.kind)) errs.push("resolver.kind must be llm|command");
  return errs;
}

/** Run one job; never throws (errors become {status:"error"}). */
export async function runJob(spec, opts = {}) {
  const errs = validateJob(spec);
  if (errs.length) return { job: spec?.job, status: "error", error: errs.join("; ") };
  const job = new Job(spec, opts);
  let result;
  try {
    await job.init();
    result = spec.job === "rebase" ? await rebaseJob(job) : spec.job === "land" ? await landJob(job) : spec.job === "land_batch" ? await landBatchJob(job) : await revertJob(job);
  } catch (e) {
    result = { job: spec.job, status: "error", error: redact(String(e?.message ?? e), job.secrets).slice(-2000) };
  }
  for (const k of Object.keys(result)) if (result[k] === undefined) delete result[k];
  result.timings = { ...job.timings, total_ms: now() - job.t0 };
  result.workdir = job.dir;
  return result;
}

// CLI
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const arg = process.argv[2];
  if (!arg) {
    console.error("usage: weft-job.mjs '<json spec>' | @spec.json");
    process.exit(2);
  }
  const spec = JSON.parse(arg.startsWith("@") ? await readFile(arg.slice(1), "utf8") : arg);
  const result = await runJob(spec);
  process.stdout.write(JSON.stringify({ weft_job: result }) + "\n");
  process.exit(result.status === "error" ? 1 : 0);
}
