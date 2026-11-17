#!/usr/bin/env node
// weft.mx/license/ is docs/commercial-license.md, rendered into the site's page shell. The site has no build step, so
// the HTML is committed; after editing the Markdown run `node site/license-page.mjs` (site.test.mjs fails when the two
// differ). The go-live card replaces `{effective date}` in the Markdown and reruns this.
//
// The converter handles exactly what that document uses: #/## headings, paragraphs, "- " lists (with wrapped lines),
// **bold**, `code`, [text](url) links and one leading HTML comment. Anything else is a test failure, not a guess.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SOURCE = join(HERE, "..", "docs", "commercial-license.md");
export const TARGET = join(HERE, "public", "license", "index.html");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline Markdown: code first (its contents are literal), then links, bold and the effective-date placeholder. */
export function inline(text) {
  const parts = text.split(/(`[^`]+`)/);
  return parts
    .map((p, i) => {
      if (i % 2 === 1) return `<code>${esc(p.slice(1, -1))}</code>`;
      let h = esc(p);
      h = h.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${url.replace(/^https:\/\/weft\.mx\//, "/")}">${label}</a>`);
      h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      h = h.replace(/\{effective date\}/g, '<span class="golive">[go-live date]</span>');
      return h;
    })
    .join("");
}

/** The document body as HTML (h1 is the page title; the paragraph right after it is the meta line). */
export function render(md) {
  const lines = md.replace(/<!--[\s\S]*?-->\n*/g, "").split("\n");
  const out = [];
  let title = "";
  let para = [];
  let list = null;
  const flushPara = () => {
    if (!para.length) return;
    const cls = out.length === 0 ? ' class="meta"' : "";
    out.push(`    <p${cls}>${inline(para.join(" "))}</p>`);
    para = [];
  };
  const flushList = () => {
    if (!list) return;
    out.push("    <ul>", ...list.map((li) => `      <li>${inline(li)}</li>`), "    </ul>");
    list = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (line.startsWith("# ")) { flushPara(); flushList(); title = line.slice(2).trim(); continue; }
    if (line.startsWith("## ")) { flushPara(); flushList(); out.push(`    <h2>${inline(line.slice(3).trim())}</h2>`); continue; }
    if (line.startsWith("- ")) { flushPara(); (list ??= []).push(line.slice(2).trim()); continue; }
    if (line === "") { flushPara(); flushList(); continue; }
    if (list && /^\s+\S/.test(raw)) { list[list.length - 1] += ` ${line.trim()}`; continue; }
    if (/^(#|>|\||\* |\d+\. )/.test(line) || line.startsWith("```")) throw new Error(`license-page: unsupported Markdown: ${line}`);
    flushList();
    para.push(line.trim());
  }
  flushPara();
  flushList();
  if (!title) throw new Error("license-page: no # title");
  return { title, body: out.join("\n") };
}

export function page(md) {
  const { title, body } = render(md);
  const desc = "Weft is free for personal use. Using it at work needs a commercial license ($29 per user a year, or $58 once) or Weft Pro, which includes one.";
  return `<!doctype html>
<!-- Generated from docs/commercial-license.md by site/license-page.mjs. Edit the Markdown, then run: node site/license-page.mjs -->
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="color-scheme" content="dark">
  <meta name="theme-color" content="#0b0d12">
  <title>Commercial license · Weft</title>
  <meta name="description" content="${esc(desc)}">
  <link rel="canonical" href="https://weft.mx/license/">
  <meta property="og:type" content="website">
  <meta property="og:title" content="Commercial license · Weft">
  <meta property="og:description" content="${esc(desc)}">
  <meta property="og:url" content="https://weft.mx/license/">
  <link rel="icon" href="/favicon.svg" type="image/svg+xml">
  <link rel="stylesheet" href="/assets/site.css">
</head>
<body data-page="license">
  <header class="nav">
    <div class="wrap nav-inner">
      <a class="brand" href="/" aria-label="Weft home"><img src="/favicon.svg" alt="" width="22" height="22">weft</a>
      <nav class="nav-links" aria-label="Primary">
        <a href="/#how">How it works</a>
        <a href="/#protocol">Protocol</a>
        <a href="/pricing/">Pricing</a>
        <a href="https://github.com/celador/weft#readme">Docs</a>
        <a href="https://github.com/celador/weft?utm_source=weft-site&amp;utm_medium=web&amp;utm_campaign=launch&amp;utm_content=repo">GitHub</a>
        <a href="/sign-in/">Sign in</a>
      </nav>
      <a class="btn btn-small btn-ghost nav-signup" href="/sign-up/">Sign up</a>
      <a class="btn btn-small" href="/#start">Get started</a>
    </div>
  </header>

  <main class="wrap doc">
    <h1>${inline(title.replace(/^Weft c/, "C"))}</h1>
${body}
    <p><a class="btn" href="/pricing/">See prices and buy</a></p>
  </main>

  <footer class="footer">
    <div class="wrap footer-inner">
      <span class="brand"><img src="/favicon.svg" alt="" width="18" height="18">weft</span>
      <nav aria-label="Footer">
        <a href="https://github.com/celador/weft?utm_source=weft-site&amp;utm_medium=web&amp;utm_campaign=launch&amp;utm_content=repo">GitHub</a>
        <a href="https://github.com/celador/weft#readme">Docs</a>
        <a href="/pricing/">Pricing</a>
        <a href="/privacy/">Privacy</a>
        <a href="/terms/">Terms</a>
        <a href="/support/">Support</a>
        <a href="/license/" aria-current="page">License</a>
      </nav>
      <p>Built by <a href="https://johnaaronnelson.com">John Aaron Nelson</a>.</p>
    </div>
  </footer>
  <script src="/assets/site.js"></script>
  <!-- Cloudflare Web Analytics (cookieless). The token is public by design. -->
  <script defer src="https://static.cloudflareinsights.com/beacon.min.js" data-cf-beacon='{"token": "f2a2e8db7c3c44a3aff0a5ddd425ef2f"}'></script>
</body>
</html>
`;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  mkdirSync(dirname(TARGET), { recursive: true });
  writeFileSync(TARGET, page(readFileSync(SOURCE, "utf8")));
  console.log(`wrote ${TARGET}`);
}
