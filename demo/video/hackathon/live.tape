# Films the tmux session that live.py drives (two real Hermes chats). Output: $HX/live.mp4
Output "/tmp/hx/live.mp4"
Set Shell "bash"
Set Width 1920
Set Height 940
Set FontSize 19
Set FontFamily "JetBrains Mono, SF Mono, Menlo"
Set Padding 12
Set Margin 0
Set Framerate 30
Set Theme "Catppuccin Mocha"
Set TypingSpeed 0ms
Hide
Type "export PS1='$ '; clear; touch /tmp/hx/go; tmux -L hx attach -t demo"
Enter
Show
Sleep 110s
