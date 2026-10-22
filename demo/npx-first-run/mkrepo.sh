#!/bin/sh
# Make a tiny scratch TypeScript repo (used for CLI smoke runs and the recording). Usage: mkrepo.sh DIR
set -e
d="$1"; rm -rf "$d"; mkdir -p "$d/src"; cd "$d"
git init -q -b main
cat > src/pricing.ts <<'EOF'
export type Item = { price: number; qty: number };

export function calcTotal(items: Item[]): number {
  return items.reduce((s, i) => s + i.price * i.qty, 0);
}
EOF
cat > src/cart.ts <<'EOF'
import { calcTotal, type Item } from "./pricing";

export function cartSummary(items: Item[]): string {
  return `${items.length} items`;
}
EOF
git add -A
git -c user.name=demo -c user.email=demo@example.invalid commit -qm "sample shop"
echo "repo ready: $d"
