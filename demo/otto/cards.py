#!/usr/bin/env python3
"""Create the Otto demo's cards on board weft-demo-site through the Otto relay.

    python3 demo/otto/cards.py --run 4 t1 t2 ... t7     # or t8 for the planted card

Sends exactly what Otto's "New card" button sends: POST http://127.0.0.1:8650/kanban/tasks?board=weft-demo-site
with the app's bearer (API_SERVER_KEY from ~/.hermes/.env, never printed). Hermes kanban workers cannot
create cards on another board (their tools are pinned to their own board via HERMES_KANBAN_DB), so the
driver goes through the app's own path. Prints {task key: card id} as JSON.
"""
import json
import sys
import urllib.request
from pathlib import Path

RELAY = "http://127.0.0.1:8650"
BOARD = "weft-demo-site"
WT = "~/github/weft/.worktrees/t_83def502"

CARDS = {
    "t1": ("Member sessions expire after an hour", "Claude Code + Codex"),
    "t2": ("Gift signup: create the account and sign in", "Claude Code + OpenCode + Gemini CLI"),
    "t3": ("Remember me: refresh a member's session", "Claude Code + Codex"),
    "t4": ("Bulk discount: 10% off 10+ bags", "Codex + Hermes"),
    "t5": ("Free shipping on orders of $50+", "Claude Code + Gemini CLI"),
    "t6": ("Add Ethiopia Guji to the menu", "Claude Code + Codex + Hermes"),
    "t7": ("Roast-date freshness helper", "Gemini CLI + OpenCode"),
    "t8": ("Quote API: price by the gram (?unit=g)", "scripted (planted bug)"),
}


def body(key: str, run: int) -> str:
    title, harnesses = CARDS[key]
    final = (
        "3. This card lands a planted bug on purpose. On FINAL with result reverted: kanban_block(reason = "
        "\"Weft reverted the landing after production errors; card reopened\" + the FINAL line). On landed "
        "without a revert or on an error: kanban_block(reason = the FINAL line)."
        if key == "t8"
        else "3. On FINAL with result landed: kanban_complete(summary = winner, land op, layer). On FINAL with "
        "an error or no_candidates: kanban_block(reason = the FINAL line). While the phase is awaiting_approval, "
        "comment \"approve in Otto\" once and keep waiting."
    )
    return (
        f"Northbound Coffee card {key} (Weft demo run {run}). Harnesses: {harnesses}, one candidate each, "
        "each in its own Weft fork with its own Weft adapter. No coordinator: the candidates meet only in the Weft log.\n\n"
        "You are this card's lane. Do only this:\n"
        f"1. Run: `cd {WT} && node demo/otto/lane.mjs start --run {run} --task {key} --card $HERMES_KANBAN_TASK`\n"
        f"2. Loop: `cd {WT} && node demo/otto/lane.mjs wait --run {run} --task {key} --timeout 540` until its last "
        "line starts with FINAL. After each wait, if the phase changed, kanban_comment one short progress line "
        "(phase + note). Do not edit any files.\n"
        f"{final}\nNever print tokens."
    )


def main() -> None:
    args = sys.argv[1:]
    run = int(args[args.index("--run") + 1])
    keys = [a for a in args if a in CARDS]
    env = {}
    for line in (Path.home() / ".hermes/.env").read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            k, v = line.split("=", 1)
            env[k.strip()] = v.strip().strip("'\"")
    key = env["API_SERVER_KEY"]
    out = {}
    for k in keys:
        data = json.dumps({"title": CARDS[k][0], "body": body(k, run), "assignee": "default"}).encode()
        req = urllib.request.Request(f"{RELAY}/kanban/tasks?board={BOARD}", data=data, method="POST")
        req.add_header("Authorization", f"Bearer {key}")
        req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=30) as resp:
            got = json.loads(resp.read())
        task = got.get("task", got)
        out[k] = task.get("id")
    print(json.dumps(out))


if __name__ == "__main__":
    main()
