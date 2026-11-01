# Contributing to Weft

Thanks for helping. Weft coordinates many agents editing the same code, so a small change in
wording or defaults changes what every agent does. Because of that, every change needs proof,
not just a description. The bar is the same for everyone, the maintainer and maintainer-run agents
included.

## Before you start

- For anything bigger than a small fix, open an issue first and say what you plan to change.
- Security problems: don't open a public issue. See [SECURITY.md](.github/SECURITY.md).

## What every pull request needs

1. **One behavior change per PR.** Split unrelated fixes. Small PRs get reviewed and merged fast.
2. **Defaults stay the same** unless changing a default is the whole point of the PR, stated in
   its title. Opt-in features must not change anything for people who don't opt in, including
   the text agents read (prompts, SessionStart context, diagnostics, suggestions). Add a test
   that pins the default behavior and wording.
3. **Proof the problem exists:** a test that fails on `main` and passes on your branch. Say which
   test and paste its failing output from `main`.
4. **Proof it works, before and after:** a terminal recording ([asciinema](https://asciinema.org)
   or [VHS](https://github.com/charmbracelet/vhs)) or a short video showing the old behavior and
   the new, using real agents or the adapter's `hook` command. Give the exact commands so a
   reviewer can reproduce it.
5. **Spec first:** a change to the protocol, the event journal, diagnostics or agent-facing text
   updates [docs/protocol/wcp-v0.md](docs/protocol/wcp-v0.md) and explains why. Journal replay
   must stay deterministic (spec §5.1): any setting that changes verdicts must be recorded in the
   repo's config or journal, not read from the environment at runtime.
6. **Security notes:** list any new file reads or writes, network calls, environment variables,
   config discovery, process spawning, or anything that lets one agent affect another agent's
   state. "None" is a fine answer.
7. **Green gate:** `pnpm -r typecheck && pnpm -r test`. CI on pull requests from forks runs after
   a maintainer approves it.

## How review works

- Reviews are read first; code from pull requests is never run on maintainer machines outside
  an isolated sandbox. Clear reproduction steps make that quick.
- "Request changes" means "not yet", with specific asks. Most PRs need a round or two.
- If we reimplement an idea instead of merging the PR, the commit credits you
  (`Reported-by:` / `Co-authored-by:`).

## Development

See [docs/try-it.md](docs/try-it.md) for setup, and [AGENTS.md](AGENTS.md) for repository rules.
By contributing you agree your work is licensed under the [MIT License](LICENSE).
