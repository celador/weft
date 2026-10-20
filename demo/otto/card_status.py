#!/usr/bin/env python3
"""Move a card on board weft-demo-site back to ready through the Otto relay (same PATCH as Otto's
card status menu). Used when a lane was reattached after its card's worker had blocked the card.

    python3 demo/otto/card_status.py t_abc123 ready
"""
import json
import sys
import urllib.request
from pathlib import Path

tid, status = sys.argv[1], sys.argv[2]
env = {}
for line in (Path.home() / ".hermes/.env").read_text().splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        k, v = line.split("=", 1)
        env[k.strip()] = v.strip().strip("'\"")
req = urllib.request.Request(f"http://127.0.0.1:8650/kanban/tasks/{tid}?board=weft-demo-site", data=json.dumps({"status": status}).encode(), method="PATCH")
req.add_header("Authorization", f"Bearer {env['API_SERVER_KEY']}")
req.add_header("Content-Type", "application/json")
with urllib.request.urlopen(req, timeout=30) as resp:
    got = json.loads(resp.read())
t = got.get("task", got)
print(json.dumps({"id": t.get("id"), "status": t.get("status")}))
