Output "/Users/john/.hermes/cache/scratch/weft-npx-first-run.mp4"
Set Shell "bash"
Set FontSize 15
Set Width 1700
Set Height 980
Set Padding 16
Set TypingSpeed 35ms
Set Framerate 10
Set Theme "Builtin Dark"
Hide
Type "source /Users/john/.hermes/cache/scratch/rec-rc.sh"
Enter
Sleep 3s
Show
Type "# a clean macOS account: empty HOME, only node and claude installed"
Enter
Type "ls -A ~; node --version; claude --version"
Enter
Sleep 2s
Type "# a scratch repo"
Enter
Type "git log --oneline; ls src; date +%T"
Enter
Sleep 2s
Type "npx --package=/Users/john/.hermes/cache/scratch/celador-weft-0.1.0.tgz weft"
Enter
Wait+Screen@120s /proceed/
Sleep 1s
Type "y"
Enter
Wait+Screen@120s /second worktree/
Sleep 1s
Enter
Wait+Screen@120s /Agents already running/
Sleep 4s
Type "date +%T; two-agents   # two Claude Code agents at once (tmux), Weft's feed below"
Enter
Sleep 150s
