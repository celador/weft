# Top 8 judge questions

Say the answer, then stop. Full list with sources: `../qa.md`.

**1. Did you write the code?**
No. Agents wrote it, coordinated by Weft itself. I designed it in one conversation on Oct 3, then made the decisions and kept final sign-off.

**2. Did a human review the code?** (John: confirm this is true before you say it)
Not line by line. I reviewed evidence instead: tests, a recorded demo and Weft's public log, and I signed off on anything public.

**3. How is this different from git merge or a merge queue?**
Git and merge queues find conflicts after the code is written. Weft checks each edit while it is being made, at the level of functions and types, so the agent hears about it before a commit exists.

**4. Why Cloudflare?**
The core need is one ordered log per repo. A Durable Object is exactly that: one copy per repo with its own database, so I didn't build leader election or run a database cluster.

**5. What do you use Artifacts for?**
Each repo's main branch lives in Artifacts, and every agent attempt gets its own fork with a repo-scoped token. Push events from the forks come back into Weft's log.

**6. Who uses it?**
Weft's own build, and my own agents across my repos. No outside team runs it in production yet; that's the next step.

**7. What breaks today?**
The code analysis is TypeScript and JavaScript only. If the coordinator is down, agents keep working unchecked, and the fully local mode isn't merged yet.

**8. What would you do with the $25k in credits?**
Run a free hosted coordinator for outside teams, and a public benchmark: many agents on real repos, with and without Weft, measuring the rework it saves.

If asked about speed: a check takes a median 558 ms (`demo/evidence/m1-report.md`); agents spend seconds per turn.
