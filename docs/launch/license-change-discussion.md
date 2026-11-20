# Discussion draft: Weft's license is changing (AGPL-3.0 product, MIT protocol and plugins)

Draft for the maintainer's public record (GOVERNANCE.md: "Every decision and its reasoning is
public"). Not posted. The go-live card (t_52c6e0ad) posts it from @celador in GitHub Discussions,
category **Announcements**, after the change lands on `main`, and fills in the placeholders:
`{effective date}` (the day the change is pushed to `main`), `{last MIT commit}` (the `main` commit
just before the license change merge) and `{discussion link}` in the release notes.

---

**Title:** Weft's license is changing: AGPL-3.0 for the product, MIT for the protocol and plugins

**Body:**

Starting November 20, 2026, Weft is no longer MIT-licensed as a whole. Here is what changes, what
doesn't, and why.

### What changes

- **The product is now AGPL-3.0-only:** the gateway and sequencer, the analyzer, the agent
  adapters, the CLI (`@celador/weft`), the MCP server, the feed, the web UI and the VS Code
  extension.
- **The builds we distribute have commercial terms.** The `@celador/weft` npm package, the VS Code
  extension and the hosted service stay free for personal use. Using them for work (your
  employer's code, a client's code, or a product that earns money) needs a Weft commercial
  license, $29 per user per year or $58 once, or Weft Pro, which includes it. The definition, with
  examples, is in [docs/commercial-license.md](../commercial-license.md)
  ([weft.mx/license](https://weft.mx/license/)). Personal projects, learning, unpaid open-source
  work and 30 days of evaluation at work are free. Weft does not block anything or report how you
  use it.
- **Builds you make yourself from the source are under the AGPL only.** The commercial terms do
  not apply to them.
- **New contributions need a contributor license agreement** ([CLA.md](../../CLA.md), based on the
  Apache Individual CLA). You keep your copyright. The CLA lets the project ship your work under
  the AGPL, the MIT License and the commercial terms, and promises that merged work is always
  published as open source under the license of the directory it went into. You sign it with one
  sentence in the pull request.

### What stays MIT

- **The protocol:** the WCP and Agent Hooks Core specifications (`docs/protocol/`), the JSON schema
  and reference types (`packages/protocol/`) and the conformance suite (`packages/conformance/`).
  Anyone can implement WCP, in any product, under any license.
- **The agent plugins** that live in other vendors' catalogs: the Claude Code / Copilot CLI plugin
  (`plugins/weft/`, `.claude-plugin/`) and the Hermes plugin
  (`packages/adapters/hermes/plugin/`).
- **Everything released before this change.** Every version up to and including
  `@celador/weft` 0.3.0, every commit up to `b825786` (tag `mit-final`), and every contribution made so far
  stays available under the MIT License, permanently. If you use 0.3.0 at work, you don't need a
  license for it. The MIT text and its notice are kept in
  [licenses/LICENSE-MIT](../../licenses/LICENSE-MIT).

The root [LICENSE](../../LICENSE) lists exactly which directory is under which license.

### Why

Weft has one maintainer and is becoming a paid product, so that it can be maintained properly.
Under MIT, anyone could already use Weft commercially without paying, so a commercial license
would have meant nothing. Cap (cap.so) uses the same model: AGPL source, a free app for personal
use, and a paid commercial license for work.

The protocol stays MIT on purpose. WCP is meant to be a standard that other harnesses and
coordinators implement, so its specification, schema and test suite carry no conditions. The
plugins stay MIT so that plugin catalogs keep accepting them and nobody needs a license to read
the hook code that runs in their agent.

### When

- The license change takes effect on November 20, 2026, the day it lands on `main`.
- The first release under the new terms is the next `@celador/weft` release after 0.3.0, and the
  next VS Code extension release after 0.1.2.
- Open pull requests: before merging, we will ask authors to add the CLA sentence.

Questions about the change are welcome in this thread. Questions about a commercial license:
john@elier.ai.

— John Nelson (@celador), maintainer
