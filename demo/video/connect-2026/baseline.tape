# "Without Weft" clip for slide 6a: the landing step of the real Weft-OFF baseline run
# (demo/m1-baseline.mjs, evidence in demo/evidence/m1-baseline/) replayed on its actual commits.
# Each branch already passed tsc + tests on its own in that run. Run from the repo root:
#   BASELINE_WORK=<summary.json "work"> vhs demo/video/connect-2026/baseline.tape
#   -> demo/video/connect-2026/baseline.mp4 (~20 s)
Output demo/video/connect-2026/baseline.mp4
Set Shell "bash"
Set FontSize 30
Set Width 1920
Set Height 1080
Set Padding 50
Set Theme "Builtin Solarized Light"
Set TypingSpeed 25ms
Hide
Type `export PATH=/opt/homebrew/opt/node@24/bin:$PWD/node_modules/.bin:$PATH PS1='main $ ' && cd "$(demo/video/connect-2026/baseline-replay.sh "$BASELINE_WORK")" && git config advice.mergeConflict false && clear`
Enter
Sleep 2s
Show
Type "# Without Weft. Two agents, two branches. Each passed tsc and its tests alone."
Enter
Sleep 1500ms
Type "git merge --no-edit agent-a  # sessions expire: createSession(userId, opts)"
Enter
Sleep 1500ms
Type "git merge --no-edit agent-b  # POST /api/signup"
Enter
Sleep 2s
Type "tsc -p ."
Enter
Sleep 3s
Type "node --test 'test/**/*.test.ts' 2>&1 | grep -E '^(✖|ℹ (pass|fail))' | head -3"
Enter
Sleep 2500ms
Type "# Git merged cleanly. The build broke after the merge."
Enter
Sleep 3s
