// The core must run in a browser, a VS Code webview, Node and JCEF: no DOM and no Node-only
// APIs outside src/view. This scans the sources (comments stripped) for both.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const src = fileURLToPath(new URL("../src", import.meta.url));
const core = readdirSync(src).filter((f) => f.endsWith(".ts"));
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const DOM = /\b(document|window|HTMLElement|Element|Node|navigator|localStorage|sessionStorage|requestAnimationFrame)\b(?!\s*:)/;
const NODE = /\bfrom\s+["'](node:|fs|path|os|http|https|net|child_process|crypto)["']|\b(process|Buffer|require|__dirname)\b/;

describe("core has no DOM and no Node-only APIs", () => {
  it.each(core)("%s", (f) => {
    const code = stripComments(readFileSync(join(src, f), "utf8"));
    expect(code).not.toMatch(DOM);
    expect(code).not.toMatch(NODE);
  });

  it("the view is the only DOM code and never uses innerHTML or inline styles", () => {
    const view = stripComments(readFileSync(join(src, "view", "index.ts"), "utf8"));
    expect(view).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|\.style\b|setAttribute\(\s*["']style|eval\(|new Function/);
  });
});
