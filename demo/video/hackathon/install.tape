# Films the catalog install into the isolated Hermes home (env from env.sh). Output: $HX/install.mp4
Output "/tmp/hx/install.mp4"
Set Shell "bash"
Set Width 1920
Set Height 940
Set FontSize 22
Set FontFamily "JetBrains Mono, SF Mono, Menlo"
Set Padding 40
Set Margin 0
Set Framerate 30
Set Theme "Catppuccin Mocha"
Set TypingSpeed 40ms
Hide
Type "export PS1='$ '; cd /tmp; clear"
Enter
Sleep 300ms
Show
Sleep 1s
Type "hermes plugins search weft"
Sleep 400ms
Enter
Wait+Screen /Install: hermes plugins install/
Sleep 3s
Hide
Type "clear"
Enter
Sleep 200ms
Show
Type "hermes plugins install weft --enable"
Sleep 400ms
Enter
Wait+Screen@90s /Installed/
Sleep 4s
