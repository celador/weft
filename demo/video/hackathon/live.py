#!/usr/bin/env python3
"""Drive two REAL Hermes chat sessions (model inference) in tmux panes, for filming.

Left pane: agent A in /tmp/shop. Right pane: agent B in /tmp/shop-2 (the paired Git worktree).
Every keystroke goes through `tmux send-keys`; nothing is pasted into the output. The filmed
terminal (VHS, see live.tape) attaches to the same tmux session and records what Hermes prints.

    source env.sh && python3 live.py prepare    # tmux session, panes, prompts (before filming)
    python3 live.py run                         # waits for $HX/go (written by the tape), then drives
Writes $HX/live-log.json: wall-clock time of every action, for cutting.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import time

HX = os.environ["HX"]
SOCK = ["tmux", "-L", "hx"]
LOG: list[dict] = []
T0 = [0.0]

A_PROMPT = "In pricing.py only, change calc_total to calc_total(items, opts) and multiply the sum by 1 + opts['tax']."
B_PROMPT = ("In cart.py, add cart_total(items) that returns round(calc_total(items), 2). "
            "If Weft blocks the edit, don't retry: quote its error.")
READ_PROMPT = "Read pricing.py and cart.py. No changes yet."


def tmux(*args: str) -> str:
    return subprocess.run([*SOCK, *args], capture_output=True, text=True).stdout


def mark(label: str) -> None:
    t = time.time()
    LOG.append({"label": label, "t": t, "rel": round(t - T0[0], 2) if T0[0] else None})
    print(f"{LOG[-1]['rel']!s:>8}  {label}", flush=True)


def pane(i: int) -> str:
    return tmux("capture-pane", "-p", "-J", "-S", "-400", "-t", f"demo.{i}")


DONE = re.compile(r"^─ [\d.]+m?s · ", re.M)


def turns(i: int) -> int:
    return len(DONE.findall(pane(i)))


def send(i: int, text: str, label: str, typing: float = 0.02) -> None:
    mark(f"{label}: start typing")
    for word in re.findall(r"\S+\s*", text):   # word by word, so the prompt is readable as it appears
        tmux("send-keys", "-t", f"demo.{i}", "-l", word)
        time.sleep(typing)
    time.sleep(0.4)
    tmux("send-keys", "-t", f"demo.{i}", "Enter")
    mark(f"{label}: sent")


def wait_turn(i: int, before: int, label: str, timeout: float = 150) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if turns(i) > before:
            mark(f"{label}: done")
            return
        time.sleep(0.3)
    mark(f"{label}: TIMEOUT")
    raise SystemExit(f"timeout waiting for {label}")


def wait_text(i: int, needle: str, label: str, timeout: float = 90) -> None:
    end = time.time() + timeout
    while time.time() < end:
        if needle in pane(i):
            mark(label)
            return
        time.sleep(0.3)
    mark(f"{label}: TIMEOUT")
    raise SystemExit(f"timeout waiting for {label!r}")


def prepare() -> None:
    subprocess.run([*SOCK, "kill-server"], capture_output=True)
    rc = os.path.join(HX, "tmux.conf")
    with open(rc, "w") as f:
        f.write("\n".join([
            "set -g status off",
            "set -g pane-border-status top",
            'set -g pane-border-format " #{pane_title} "',
            "set -g pane-border-style fg=colour240",
            "set -g pane-active-border-style fg=colour240",
            "set -g pane-border-lines heavy",
            "set -g allow-rename off",
            "set -g default-terminal xterm-256color",
            "set -g history-limit 5000",
            "",
        ]))
    shell = ["env", "-i", f"PATH={os.environ['PATH']}", f"HOME={os.environ['HOME']}", "TERM=xterm-256color",
             "LANG=en_US.UTF-8", *[f"{k}={os.environ[k]}" for k in
             ("HERMES_HOME", "HERMES_GATEWAY_LOCK_DIR", "WEFT_HOME", "WEFT_HERMES_CACHE", "HX", "SHOP")],
             "bash", "--noprofile", "--norc"]
    tmux("-f", rc, "new-session", "-d", "-s", "demo", "-x", "174", "-y", "48", "-c", "/tmp/shop", *shell)
    tmux("split-window", "-h", "-t", "demo", "-c", "/tmp/shop-2", *shell)
    tmux("select-pane", "-t", "demo.0", "-T", "Agent A · Hermes session in /tmp/shop")
    tmux("select-pane", "-t", "demo.1", "-T", "Agent B · Hermes session in /tmp/shop-2 (its own Git worktree)")
    for i in (0, 1):
        tmux("send-keys", "-t", f"demo.{i}", "export PS1='\\W $ '; clear", "Enter")
    print("prepared")


def run() -> None:
    go = os.path.join(HX, "go")
    while not os.path.exists(go):
        time.sleep(0.1)
    T0[0] = os.path.getmtime(go)
    mark("go (tape attached)")
    time.sleep(2.5)
    for i in (0, 1):
        tmux("send-keys", "-t", f"demo.{i}", "-l", "hermes chat")
        time.sleep(0.6)
        tmux("send-keys", "-t", f"demo.{i}", "Enter")
    mark("chats launched")
    for i in (0, 1):
        wait_text(i, "Type your message", f"chat {'AB'[i]} ready", timeout=60)
    time.sleep(2)
    a0, b0 = turns(0), turns(1)
    send(0, READ_PROMPT, "A read")
    send(1, READ_PROMPT, "B read")
    wait_turn(0, a0, "A read")
    wait_turn(1, b0, "B read")
    time.sleep(1.5)
    send(0, "/weft status", "A /weft status")
    time.sleep(1.0)
    send(1, "/weft status", "B /weft status")
    time.sleep(5)
    a1 = turns(0)
    send(0, A_PROMPT, "A edit")
    wait_turn(0, a1, "A edit")
    time.sleep(2)
    b1 = turns(1)
    send(1, B_PROMPT, "B edit")
    wait_turn(1, b1, "B edit", timeout=180)
    time.sleep(3)
    send(1, "/weft status", "B /weft status after")
    time.sleep(8)
    mark("end")
    with open(os.path.join(HX, "live-log.json"), "w") as f:
        json.dump(LOG, f, indent=1)
    with open(os.path.join(HX, "pane-A.txt"), "w") as f:
        f.write(pane(0))
    with open(os.path.join(HX, "pane-B.txt"), "w") as f:
        f.write(pane(1))
    with open(os.path.join(HX, "done"), "w") as f:
        f.write("1")


if __name__ == "__main__":
    {"prepare": prepare, "run": run}[sys.argv[1]]()
