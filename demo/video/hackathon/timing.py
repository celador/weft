#!/usr/bin/env python3
"""Find when things first appear in a filmed take (Apple Vision OCR), per tmux pane.

    python3 timing.py <live.mp4> [--fps 2] > timing.json

VHS's frame clock drifts from wall time under load, so the cut list (edl.json) is built from what is
on screen, not from live.py's wall-clock log. Prints {needle: first_time_seconds} per pane.
"""
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

RIG = Path(__file__).resolve().parent.parent / "rig"
NEEDLES = {
    "L": ["hermes chat", "Type your message", "No changes yet", "read 2 files", "enforce mode",
          "In pricing.py only", "Patch pricing.py", "edited 1 file"],
    "R": ["hermes chat", "Type your message", "No changes yet", "read 2 files", "enforce mode",
          "In cart.py, add", "Weft blocked", "stale_assumption", "1 rejected", "open conflicts (1)"],
}


def main() -> None:
    video = sys.argv[1]
    fps = float(sys.argv[sys.argv.index("--fps") + 1]) if "--fps" in sys.argv else 2.0
    ocr = Path(os.environ.get("TMPDIR", tempfile.gettempdir())) / "weft-video-ocr"
    if not ocr.exists():
        subprocess.run(["swiftc", "-O", "-o", str(ocr), str(RIG / "ocr.swift")], check=True)
    tmp = Path(tempfile.mkdtemp(prefix="weft-timing-"))
    for side, crop in (("L", "crop=iw/2:ih:0:0"), ("R", "crop=iw/2:ih:iw/2:0")):
        subprocess.run(["ffmpeg", "-loglevel", "error", "-i", video, "-vf", f"fps={fps},{crop}",
                        str(tmp / f"{side}%05d.png")], check=True)
    seen: dict = {"L": {}, "R": {}}
    files = sorted(tmp.glob("*.png"))
    for i in range(0, len(files), 60):
        out = subprocess.run([str(ocr), *map(str, files[i:i + 60])], capture_output=True, text=True).stdout
        for row in out.splitlines():
            path, _, text = row.partition("\t")
            name = Path(path).stem
            side, t = name[0], (int(name[1:]) - 1) / fps
            for n in NEEDLES[side]:
                if n in text and (n not in seen[side] or t < seen[side][n]):
                    seen[side][n] = t
    for f in files:
        f.unlink()
    tmp.rmdir()
    print(json.dumps(seen, indent=1))


if __name__ == "__main__":
    main()
