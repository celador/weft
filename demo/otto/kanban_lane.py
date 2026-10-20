#!/usr/bin/env python3
"""Kanban side of the Otto demo: the board's cards mirror what the Weft candidates are doing.

Run with the Hermes venv python (it imports hermes_cli.kanban_db). One JSON request on stdin,
one JSON answer on stdout. The demo driver (demo/otto/run.mjs) is the only caller.

    {"op": "board"}                                   create board `weft-demo-site` if missing
    {"op": "create", "cards": [{key, title, body, assignee}]}  -> {"ids": {key: task_id}}
    {"op": "claim", "ids": [...]}                     ready -> running (claimer weft-demo-lanes)
    {"op": "heartbeat", "ids": [...]}
    {"op": "comment", "id": .., "body": ..}
    {"op": "review", "id": .., "summary": ..}         running -> review (waiting on the human)
    {"op": "complete", "id": .., "summary": .., "metadata": {...}}
    {"op": "reopen", "id": .., "reason": ..}          done -> blocked + `reopened` event (Weft revert)
    {"op": "archive", "ids": [...]}                   clear a previous run's cards
    {"op": "list"}                                    the board's cards

Cards are claimed by the lane launcher, never by the dispatcher: the cards' assignee is a
harness label (not a Hermes profile), so the dispatcher has nothing to spawn for them. Nobody
splits the work: each card was written up front and its candidates only see their own card.
"""
from __future__ import annotations

import json
import sys
import time

from hermes_cli import kanban_db as kb
from hermes_cli.kanban_db_boards import create_board
from hermes_cli.kanban_db_connect import write_txn

BOARD = "weft-demo-site"
CLAIMER = "weft-demo-lanes"
TTL = 3 * 3600


def conn():
    return kb.connect(board=BOARD)


def main() -> None:
    req = json.load(sys.stdin)
    op = req["op"]
    out: dict = {"ok": True}
    if op == "board":
        if not kb.board_exists(BOARD):
            create_board(BOARD, name="Northbound Coffee (Weft demo)", icon="☕",
                         description="Weft demo: independent cards, peer agents on different harnesses, one repo.",
                         default_workdir="/Users/john/github/weft-demo-site")
            out["created"] = True
        kb.init_db(board=BOARD)
    elif op == "create":
        c = conn()
        ids = {}
        for card in req["cards"]:
            ids[card["key"]] = kb.create_task(
                c, title=card["title"], body=card.get("body"), assignee=card.get("assignee"),
                created_by="john", workspace_kind="dir", workspace_path="/Users/john/github/weft-demo-site",
                priority=int(card.get("priority", 0)), board=BOARD,
                idempotency_key=card.get("idempotency_key"))
        out["ids"] = ids
    elif op == "claim":
        c = conn()
        out["claimed"] = {i: bool(kb.claim_task(c, i, ttl_seconds=TTL, claimer=CLAIMER)) for i in req["ids"]}
    elif op == "heartbeat":
        c = conn()
        out["alive"] = {i: kb.heartbeat_claim(c, i, ttl_seconds=TTL, claimer=CLAIMER) for i in req["ids"]}
    elif op == "comment":
        out["comment"] = kb.add_comment(conn(), req["id"], req.get("author", "weft"), req["body"])
    elif op == "review":
        out["review"] = bool(kb.request_review(conn(), req["id"], summary=req["summary"], force=True))
    elif op == "complete":
        out["done"] = bool(kb.complete_task(conn(), req["id"], summary=req["summary"], result=req.get("result"),
                                            metadata=req.get("metadata"), force=True))
    elif op == "reopen":
        # A landed card whose landing Weft reverted from production errors. There is no
        # done -> open transition in the board API, so this mirrors one: status `blocked`
        # (never dispatched), completion cleared, and a `reopened` event with the reason.
        c = conn()
        with write_txn(c):
            cur = c.execute("UPDATE tasks SET status = 'blocked', completed_at = NULL, claim_lock = NULL, "
                            "claim_expires = NULL WHERE id = ? AND status = 'done'", (req["id"],))
            if cur.rowcount == 1:
                kb._append_event(c, req["id"], "reopened", {"by": "weft auto-revert", "reason": req["reason"][:500]})
        out["reopened"] = cur.rowcount == 1
        kb.add_comment(c, req["id"], "weft", req["reason"])
    elif op == "archive":
        c = conn()
        out["archived"] = {}
        for i in req["ids"]:
            t = kb.get_task(c, i)
            if t and t.status == "running":
                kb.reclaim_task(c, i)
            if t and t.status not in ("done", "archived"):
                try:
                    kb.block_task(c, i, reason="demo reset")
                except Exception:
                    pass
            out["archived"][i] = bool(kb.archive_task(c, i))
    elif op == "list":
        out["tasks"] = [{"id": t.id, "title": t.title, "status": t.status, "assignee": t.assignee}
                        for t in kb.list_tasks(conn())]
    else:
        raise SystemExit(f"unknown op {op}")
    out["at"] = time.time()
    json.dump(out, sys.stdout)


if __name__ == "__main__":
    main()
