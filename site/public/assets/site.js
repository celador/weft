// THE START COMMAND. This is the only place it lives: every copy block and step 1 of
// "How it works" are filled from here. When `npx weft` is published (card t_bd602434),
// set NPX_READY = true (and NPX_COMMAND to the published name if it isn't `npx weft`).
const NPX_READY = false;
const NPX_COMMAND = "npx weft";
// Until then: the quickest path from docs/try-it.md (local gateway + the two-agent demo),
// in one paste. Needs Node >= 22, pnpm and git.
const QUICKSTART = [
  "git clone https://github.com/celador/weft.git && cd weft && pnpm install --frozen-lockfile",
  'echo "WEFT_ADMIN_TOKEN=$(openssl rand -hex 16)" > apps/gateway/.dev.vars.test',
  "(cd apps/gateway && pnpm dev:local > /tmp/weft-gateway.log 2>&1 &)",
  "until curl -sf localhost:8787/v1/health > /dev/null; do sleep 1; done",
  "node scripts/local-quickstart.mjs --demo",
].join("\n");
const TRY_IT = "https://github.com/celador/weft/blob/main/docs/try-it.md?utm_source=weft-site&utm_medium=web&utm_campaign=launch&utm_content=cmd-note";

const WEFT_START = NPX_READY
  ? { label: "Run in your repo", command: NPX_COMMAND, step1: `Run <code>${NPX_COMMAND}</code> in your repo.`, note: "" }
  : {
      // John (Oct 22): the multi-line quickstart looked "intimidating and scary". Until npx is
      // published, show only the one-liner as "coming soon"; no copy button (see below).
      label: "Coming soon",
      command: NPX_COMMAND,
      step1: `Run <code>${NPX_COMMAND}</code> in your repo.`,
      note: `Launching this week. Want it now? <a href="${TRY_IT}">Try it locally</a>.`,
      soon: true,
    };

(() => {
  for (const el of document.querySelectorAll("[data-weft-cmd]")) el.textContent = WEFT_START.command;
  for (const el of document.querySelectorAll("[data-weft-label]")) el.textContent = WEFT_START.label;
  for (const el of document.querySelectorAll("[data-weft-step1]")) el.innerHTML = WEFT_START.step1;
  for (const el of document.querySelectorAll("[data-weft-note]")) {
    if (WEFT_START.note) el.innerHTML = WEFT_START.note; else el.remove();
  }
  if (WEFT_START.soon) for (const el of document.querySelectorAll("[data-copy]")) el.remove();
})();

// Funnel events -> POST /e (Workers Analytics Engine, see site/worker.js). No cookies; the
// Worker stores no IP or user agent: just the event, where on the page, and the traffic source.
const SOURCE = (new URLSearchParams(location.search).get("utm_source")
  || document.referrer.replace(/^https?:\/\/([^/]+).*$/, "$1")
  || "direct").slice(0, 64);
function track(e, w = "") {
  const body = JSON.stringify({ e, w, s: SOURCE, c: NPX_READY ? "npx" : "quickstart" });
  try { if (navigator.sendBeacon && navigator.sendBeacon("/e", body)) return; } catch {}
  fetch("/e", { method: "POST", body, keepalive: true }).catch(() => {});
}
track("view");

let copying = false;
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch {}
  const ta = Object.assign(document.createElement("textarea"), { value: text });
  ta.setAttribute("readonly", ""); ta.style.position = "fixed"; ta.style.opacity = "0";
  document.body.append(ta); ta.select();
  let ok = false; copying = true;
  try { ok = document.execCommand("copy"); } catch {}
  copying = false; ta.remove(); return ok;
}

for (const btn of document.querySelectorAll("[data-copy]")) {
  btn.addEventListener("click", async () => {
    const block = btn.closest(".cmd-block");
    const ok = await copyText(WEFT_START.command);
    btn.textContent = ok ? "Copied" : "Press ⌘C";
    btn.classList.toggle("done", ok);
    if (!ok) {
      const r = document.createRange(); r.selectNodeContents(block.querySelector("code"));
      getSelection().removeAllRanges(); getSelection().addRange(r);
    }
    track("copy", block.dataset.placement || "");
    setTimeout(() => { btn.textContent = "Copy"; btn.classList.remove("done"); }, 2000);
  });
}
// Selecting the command by hand and copying it counts as a copy too.
document.addEventListener("copy", () => {
  if (copying) return;
  const sel = getSelection();
  const block = sel?.anchorNode?.parentElement?.closest(".cmd-block");
  if (block && String(sel).trim()) track("copy", `${block.dataset.placement || ""}-manual`);
});

// Fade sections in as they enter the viewport (CSS skips this under prefers-reduced-motion).
(() => {
  const els = document.querySelectorAll(".reveal");
  if (!("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("js");
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add("in"); io.unobserve(e.target); }
    }
  }, { rootMargin: "0px 0px -10% 0px", threshold: 0.08 });
  els.forEach((el) => io.observe(el));
})();
