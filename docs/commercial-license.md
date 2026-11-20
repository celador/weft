# Weft commercial license

<!-- Published at https://weft.mx/license/. Effective date filled in at go-live (t_52c6e0ad). -->

Effective November 20, 2026. Operator: Weft (celador), John Nelson. Contact:
[john@elier.ai](mailto:john@elier.ai).

Weft is free for personal use. Using it for work needs a Weft commercial license, or Weft Pro,
which includes one.

## The short version

- **Free:** personal projects, learning, open-source work you aren't paid for, and 30 days of
  evaluation at work.
- **Needs a license:** using Weft on code for your employer, for a client, or for a product or
  service that earns money.
- **Price:** $29 per user per year, or $58 per user once (it never renews). Weft Pro includes the
  commercial license for every Pro user.
- **Builds you make yourself** from the [source code](https://github.com/celador/weft) are
  covered by the AGPL-3.0 only, not by these terms.
- Weft never blocks you or reports what you do with it. We trust you to buy a license when you
  need one.

## What these terms cover

The builds of Weft that we distribute:

- the `@celador/weft` npm package (`npx @celador/weft`: the CLI, the local gateway, the agent
  adapters and the MCP server),
- the Weft extension for VS Code and compatible editors (Visual Studio Marketplace, Open VSX),
- the hosted service (hosted spaces on Weft's gateway).

They do **not** cover:

- **Builds from source.** If you build Weft yourself from
  [github.com/celador/weft](https://github.com/celador/weft), your build is governed by the
  [GNU AGPL-3.0](https://github.com/celador/weft/blob/main/LICENSE) only, and you don't need a
  commercial license for it.
- **The MIT parts.** The protocol specifications and JSON schema, the conformance suite, and the
  agent plugins listed in [LICENSE](https://github.com/celador/weft/blob/main/LICENSE) (the Claude
  Code / Copilot CLI plugin and the Hermes plugin) are MIT-licensed: free for any use.
- **Older versions.** Every version released before this change, up to and including
  `@celador/weft` 0.3.0, stays under the MIT License, including for commercial use.

## What counts as commercial use

Commercial use means using Weft for work that you are paid for or that makes money. For a coding
tool, that is mostly about whose code your agents are working on.

**Commercial (needs a license):**

- Running Weft on your employer's code, or on code you write as part of your job.
- Running Weft on a client's code: freelance, contract, consulting or agency work.
- Running Weft on code for a product or service that earns revenue or is meant to (a startup, a
  SaaS, a paid app, an app with ads), including your own.
- Using Weft inside a company, for internal tools too.

**Not commercial (free):**

- Personal projects that don't earn money.
- Learning: tutorials, courses, school work, trying out agents.
- Maintaining open-source projects when you aren't paid to maintain them.
- Evaluating Weft at work for up to 30 days before you decide.

Not sure? If someone pays you for the code your agents are writing, it's commercial. Email
[john@elier.ai](mailto:john@elier.ai) for anything in between; we would rather make it work than
turn you away.

## Who counts as a user

A user is a person who uses Weft or whose coding agents Weft coordinates. Agents are not users:
one developer running five agents needs one license. A team of four developers needs four.

## Buying

- **Commercial license, yearly:** $29 per user per year.
- **Commercial license, one-time:** $58 per user, paid once. It never renews.
- **Weft Pro:** the hosted service, per user. Every Pro user is covered by the commercial license
  for as long as the subscription runs.

Buy at [weft.mx/pricing](https://weft.mx/pricing/). You can change the number of users at
checkout, and the invoice can carry your business name.

## Terms for the builds we distribute

The full text is in
[licenses/WEFT-BUILDS.md](https://github.com/celador/weft/blob/main/licenses/WEFT-BUILDS.md),
and it ships as the `LICENSE` file in the npm package and the extension. The hosted service is
also governed by the [terms of service](https://weft.mx/terms/).

## Why

Weft is built by one person. The license pays for that work while the source stays open: anyone
can read it, change it, build it and run their own copy under the AGPL.
