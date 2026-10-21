# WCP explained (one page)

A plain-language companion to the normative spec, [wcp-v0.md](wcp-v0.md). If they disagree, the spec wins.

**What it is.** WCP is a set of rules for how coding agents editing the same repo at the same time find out about each other's changes. It is a spec plus a JSON schema and conformance tests, not a product. Weft runs it on Cloudflare (a Durable Object per repo), but it could run on a single local server or in memory; `packages/protocol/src/reference.ts` is an in-memory reference coordinator.

## Two layers

1. **Agent Hooks Core** ([hooks-core-v0.md](hooks-core-v0.md)). Every agent tool (Claude Code, Codex, Cursor, Gemini, OpenCode) lets plugins hook in, but each wires it differently. The core gives one vocabulary and four levels:
   - **L0 observe:** see what the agent did.
   - **L1 inject:** put text in front of the model ("heads up...").
   - **L2 block:** refuse an edit before it happens, and tell the model why.
   - **L3 gate:** refuse to let the agent say "I'm done."

   Each adapter declares honestly which level it actually reaches on that tool.
2. **WCP**: coordination built on top of those hooks.

## How WCP works, in database terms

1. **One ordered log per repo.** Like a database's write-ahead log, or a queue with sequence numbers. Every agent action becomes an event with a number (#1, #2, #3...). Only the coordinator assigns order, so there is exactly one history, and replaying the log always gives the same results.
2. **Events describe code at the symbol level, not the file level.** For example: "I read `src/auth/session.ts#refreshToken` and changed the body of `src/api/client.ts#fetchWithAuth`." Each write is tagged as a signature change, body change, new symbol, or deletion.
3. **Base.** Each submission says "I've seen everything up to #N." The coordinator checks the edit only against what *other* agents did after #N, which is what this agent might not know about. This is optimistic concurrency, like in a database.
4. **Validation rules** produce diagnostics:
   - **Stale overwrite (error):** you're changing something that landed on main after you started.
   - **Stale assumption (error):** you call a function whose signature changed or that was deleted.
   - **Stale read (warning):** a function you call had its body changed.
   - **Claim conflict:** someone else is actively working on that symbol (point 6).
5. **Diagnostics are the messaging layer. This is the new idea.** Each diagnostic looks like a compiler error (a red squiggle): file, line, message, suggested fix, plus the event number and agent that caused it. The hooks feed it straight into the agent's run, so agents coordinate through something models already understand, error messages, instead of chatting with each other.
6. **Claims are leases on symbols.** Editing a symbol gives the agent a soft claim: 2 minutes, renewed while it's active, so a crashed agent's claims expire on their own. An agent can take a firm claim, capped at 10 minutes. When two agents want the same symbol, seniority decides: task priority first, then who started first. With the default rule, wound-wait, the senior agent takes it and the junior one waits, so the two can't both back off forever.
7. **The losing agent has four options:** retreat (work around it), wait, negotiate, or escalate. Negotiating means proposing, countering, accepting or rejecting terms, such as transfer, share, or "keep the old signature as an overload." Escalating merges the two tasks into one group.
8. **Each edit is checked twice.** Before the edit, a *check* can block it (L2). After the edit, the real diff is *committed* to the log. Rejected attempts are logged too, so humans can see them.
9. **Inbox.** Each agent session has a queue for things like "contract you depend on changed," "trunk moved, rebase," or "you've got a proposal." Items stay there until the agent acknowledges them (at-least-once delivery).
10. **Gates.** Unresolved errors belong to the change, not the connection. An agent can't stop or commit while it has unresolved errors or owes a reply to a negotiation, and reconnecting doesn't clear them.
11. **Humans** watch the same log as a feed, with one-line summaries ("Blocked: codex-b edited fetchWithAuth..."). They can approve, undo a landing, pause or resume an agent, message an agent, or merge tasks. Every human action is also an event in the log.
12. **Fail-open.** If the coordinator is down, agents keep working; Weft never blocks a tool because it's offline.

## The demo collision, end to end

1. Codex edits `fetchWithAuth`, which calls `refreshToken`. The edit is accepted as #3.
2. Claude changes `refreshToken`'s signature. The edit is accepted as #4, and Codex's inbox gets a "contract changed" warning.
3. Codex tries its next edit with its base still at #3. The check rejects it: "stale assumption: refreshToken changed in #4 by claude-a." The hook denies the edit, and the model reads the reason.
4. Codex proposes an overload, and Claude accepts and adds a compatible version. Codex catches up, its edit passes, and its gate opens.

No human was involved, and every step is in the log. See the spec's Appendix A for the same exchange on the wire.

**In one sentence:** a shared, ordered log of who changed which function, checked like database transactions, with conflicts delivered back to each agent as compiler-style errors through the hooks every agent tool already has.
