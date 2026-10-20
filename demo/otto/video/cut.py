#!/usr/bin/env python3
"""Build the 45-60 s deck cut from the two real recordings (no re-staging): trim, crop, scale to 1920x1080, caption."""
import subprocess, os
os.chdir(os.path.dirname(os.path.abspath(__file__)))
os.makedirs("cut", exist_ok=True)
P1, P2 = "full-run4-part1.mkv", "full-run4-part2.mkv"
BOARD = (1480, 60, 1544, 868)      # board + Weft "editing now"
FEED = (1480, 1096, 1544, 868)     # Weft "every edit · live" feed
SHEET = (713, 330, 2311, 1300)     # event sheet + feed column
CARD = (270, 200, 1900, 1069)       # card detail (p2)
SEGS = [
    (P1, 474, 8, BOARD, "7 cards running at once · Claude Code, Codex, OpenCode, Gemini CLI, Hermes · no orchestrator"),
    (P1, 523, 7, SHEET, "Squiggle: Weft blocks a stale edit mid-flight (stale_assumption)"),
    (P1, 665, 8, SHEET, "Rerouted edit, then a human approves the candidate in Otto"),
    (P1, 804, 7, SHEET, "Visual change: diff + preview, screenshots, pixel diff, risk, review agent"),
    (P1, 873, 7, SHEET, "Negotiated overload: createSession keeps old callers working · Approve"),
    (P1, 888, 6, FEED, "Landings stream into Otto's Weft feed", "top"),
    (P2, 222, 7, CARD, "Planted bug lands, production errors, Weft reverts it and reopens the card"),
    (P2, 246, 8, SHEET, "Reverted 32 s after landing · trunk green 22/22 tests"),
]
parts = []
for i, (src, ss, dur, (x, y, w, h), cap, *pos) in enumerate(SEGS):
    capimg = f"cut/cap{i}.png"
    subprocess.run(["magick", "-size", "1920x96", "xc:rgba(0,0,0,0.78)", "-font", "Helvetica-Bold", "-pointsize", "38",
                    "-fill", "white", "-gravity", "center", "-annotate", "+0+0", cap, capimg], check=True)
    out = f"cut/seg{i}.mp4"
    vf = (f"[0:v]trim=start={ss}:duration={dur},setpts=PTS-STARTPTS,crop={w}:{h}:{x}:{y},scale=1920:1080:flags=lanczos,"
          f"fps=30,fade=in:st=0:d=0.25,fade=out:st={dur-0.25}:d=0.25[v];[v][1:v]overlay=0:{'0' if pos else 'H-h'}[o]")
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-ss", str(max(0, ss - 5)), "-i", src, "-i", capimg,
                    "-filter_complex", vf.replace(f"trim=start={ss}", f"trim=start={ss - max(0, ss - 5)}"), "-map", "[o]",
                    "-c:v", "libx264", "-preset", "medium", "-crf", "18", "-pix_fmt", "yuv420p", out], check=True)
    parts.append(out)
with open("cut/list.txt", "w") as f:
    f.writelines(f"file '{os.path.basename(p)}'\n" for p in parts)
subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "cut/list.txt",
                "-c", "copy", "-movflags", "+faststart", "otto-weft-demo-cut.mp4"], check=True)
print("ok")
