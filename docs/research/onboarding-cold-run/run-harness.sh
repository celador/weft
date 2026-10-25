#!/bin/bash
# usage: run-harness.sh <harness-id> ; cold-run collision for one harness.
# Weft config lives in a clean HOME (/tmp/weft-cold/home); harnesses run with the real HOME
# (their own logins) but nothing of John's Weft setup: hooks come only from the repo.
set -u
H=$1
R=/tmp/weft-cold
REALHOME=/Users/john
export PATH=/opt/homebrew/opt/node@24/bin:$PATH
L=${LANGX:-ts}; W=$R/w; D=$W/$H-$L-shop; OUT=$R/out/$H-$L; [ "$L" = ts ] && { D=$W/$H-shop; OUT=$R/out/$H; }; rm -rf $D $D-2 $OUT; mkdir -p $OUT
now() { python3 -c 'import time;print(f"{time.time():.1f}")'; }
(
  export HOME=$R/home
  mkdir -p $D/src && cd $D && git init -q
  if [ "$L" = py ]; then
    cat > src/pricing.py <<'EOF2'
from dataclasses import dataclass


@dataclass
class Item:
    price: float
    qty: int


def calc_total(items: list[Item]) -> float:
    return sum(i.price * i.qty for i in items)
EOF2
    cat > src/cart.py <<'EOF2'
from .pricing import Item


def render_cart(items: list[Item]) -> str:
    return "\n".join(f"{i.qty} x {i.price}" for i in items)
EOF2
    touch src/__init__.py
  elif [ "$L" = go ]; then
    printf 'module example.com/shop\n\ngo 1.22\n' > go.mod
    cat > src/pricing.go <<'EOF2'
package shop

type Item struct {
	Price float64
	Qty   int
}

func CalcTotal(items []Item) float64 {
	t := 0.0
	for _, i := range items {
		t += i.Price * float64(i.Qty)
	}
	return t
}
EOF2
    cat > src/cart.go <<'EOF2'
package shop

import "fmt"

func RenderCart(items []Item) string {
	s := ""
	for _, i := range items {
		s += fmt.Sprintf("%d x %.2f\n", i.Qty, i.Price)
	}
	return s
}
EOF2
  else
  cat > src/pricing.ts <<'EOF'
export type Item = { price: number; qty: number };

export function calcTotal(items: Item[]): number {
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}
EOF
  cat > src/cart.ts <<'EOF'
import type { Item } from "./pricing";

export function renderCart(items: Item[]): string {
  return items.map((i) => `${i.qty} x ${i.price}`).join("\n");
}
EOF
  echo '{"name":"shop","type":"module"}' > package.json
  fi
  git add -A && git commit -qm init
)
T0=$(now)
( export HOME=$R/home; cd $D && ${WEFT_BIN:-npx -y @celador/weft@${WEFT_V:-latest}} --no-open --yes ) > $OUT/init.log 2>&1
T1=$(now)
PA="In src/pricing.ts, make calcTotal take a second parameter opts: { taxRate: number } and multiply the total by (1 + opts.taxRate). Only edit src/pricing.ts. Do not run git commands."
PB0="In src/cart.ts, add an exported function cartTotal(items: Item[]): string that returns the cart total computed with calcTotal(items) from ./pricing, formatted with toFixed(2). Do not run git commands."
PB=$PB0
if [ "$L" = py ]; then PA="In src/pricing.py, make calc_total take a second required parameter opts: dict with a 'tax_rate' key and multiply the total by (1 + opts['tax_rate']). Only edit src/pricing.py. Do not run git commands."; PB="In src/cart.py, add a function cart_total(items: list[Item]) -> str that returns the cart total computed with calc_total(items) from .pricing, formatted with two decimals. Do not run git commands."; fi
if [ "$L" = go ]; then PA="In src/pricing.go, make CalcTotal take a second parameter taxRate float64 and multiply the total by (1 + taxRate). Only edit src/pricing.go. Do not run git commands."; PB="In src/cart.go, add a function CartTotal(items []Item) string that returns the cart total computed with CalcTotal(items), formatted with two decimals. Do not run git commands."; fi
run() { # dir prompt
  cd $1
  case $H in
    claude-code) claude -p "$2" --permission-mode acceptEdits --max-turns 25 ;;
    codex) codex exec --dangerously-bypass-hook-trust --skip-git-repo-check -s workspace-write "$2" ;;
    cursor) cursor-agent -p --trust --force "$2" ;;
    opencode) opencode run -m opencode/big-pickle "$2" ;;
    gemini) gemini -p "$2" --yolo --skip-trust ;;
    copilot) copilot -p "$2" --allow-all-tools --no-ask-user --trust-folder ;;
    antigravity) agy -p "$2" --dangerously-skip-permissions --print-timeout 600s ;;
  esac
}
export HOME=$REALHOME
( run $D "$PA" ) > $OUT/a.log 2>&1 < /dev/null; echo "a exit $?" >> $OUT/a.log
T2=$(now)
( run $D-2 "$PB" ) > $OUT/b.log 2>&1 < /dev/null; echo "b exit $?" >> $OUT/b.log
T3=$(now)
( export HOME=$R/home; cd $D && ${WEFT_BIN:-npx -y @celador/weft@${WEFT_V:-latest}} status ) > $OUT/status.log 2>&1
cp -r $D/.weft/log $OUT/log-a 2>/dev/null; cp -r $D-2/.weft/log $OUT/log-b 2>/dev/null
(cd $D && git diff) > $OUT/a.diff; (cd $D-2 && git diff) > $OUT/b.diff
echo "init=$(python3 -c "print(round($T1-$T0,1))") a=$(python3 -c "print(round($T2-$T1,1))") b=$(python3 -c "print(round($T3-$T2,1))") total=$(python3 -c "print(round($T3-$T0,1))")" > $OUT/times.txt
cat $OUT/times.txt
echo "--- squiggle hits"; grep -l -E "stale_assumption|contract_changed" $OUT/b.log $OUT/log-b/* 2>/dev/null
