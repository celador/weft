# Top 8 judge questions

Say the answer, then stop. Full list with sources: `../qa.md`.

**1. Did you write the code?**
No. Agents wrote it, coordinated by Weft itself. I designed it in one conversation on Oct 3, then made the decisions and kept final sign-off.

**2. Did a human review the code?**
Not line by line. I reviewed evidence instead: tests, a recorded demo and Weft's public log, and I signed off on anything public.

The scale is why. From my first message to the submitted entry took 64 hours (Sat Oct 3, 10:00 PM to Mon Oct 6, 1:40 PM). In that time the agents wrote 231 files: 38,593 lines of code and tests, about 2 million characters. The usual industry figure for a human is 10 to 50 finished lines a day (Steve McConnell, *Code Complete*). At 50 a day, writing it by hand would have taken me about 770 working days, roughly three years. Even at the best small-project rate McConnell reports, 125 a day, it's over a year. Today the repo has about 44,000 agent-written lines in roughly 270 files, plus about 1,400 lines from an outside contributor.

Lines of code aren't a measure of quality. They show why line-by-line review stops working, and why the checks have to happen while the agents are writing.

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
