# VHS tape: before (main 5d8da26) vs after (wt/leases) — soft. Reproduce: see README.md.
Output demo/evidence/leases/soft.gif
Output demo/evidence/leases/soft.mp4
Set Shell "bash"
Set FontSize 14
Set Width 1500
Set Height 900
Set TypingSpeed 15ms
Set Theme "Builtin Dark"
Hide
Type "export PATH=/opt/homebrew/opt/node@24/bin:$PATH PS1='$ '; cd /Users/john/.hermes/cache/scratch; clear"
Enter
Show
Type "# BEFORE: coordinator from main (5d8da26), fake clock"
Enter
Type "node lease-before.mjs soft"
Enter
Sleep 2500ms
Type "# AFTER: coordinator from wt/leases, same script"
Enter
Type "node lease-after.mjs soft"
Enter
Sleep 4000ms
