# Terminal beat for the Connect backup recording: the real preflight against production,
# ending on the two-agents-one-symbol check. Run from the repo root:
#   vhs demo/video/connect-2026/connect-term.tape   -> demo/video/connect-2026/term.mp4
Output demo/video/connect-2026/term.mp4
Set Shell "bash"
Set FontSize 22
Set Width 1920
Set Height 1080
Set Padding 40
Set Theme "Builtin Solarized Light"
Set TypingSpeed 45ms
Hide
Type "export PS1='$ ' && clear"
Enter
Show
Sleep 1s
Type "# Two agents edit the same function. Weft tells the second one to wait."
Enter
Sleep 1500ms
Type "scripts/connect-preflight.sh"
Sleep 600ms
Enter
Sleep 30s
Sleep 9s
