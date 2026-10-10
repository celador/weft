#!/usr/bin/env bash
# Firm-claim demo for recording (asciinema). Two agents share one repo: "senior" (priority 1)
# claims src/pricing.ts#calcTotal, then "junior" (priority 0) edits the same function. The script
# runs the adapter's own `claim` and `hook` commands in two temporary checkouts against a local
# coordinator and prints the verdict for each run.
#
#   demo-firm-claim.sh soft   senior makes a soft claim: junior gets a claim_wait warning, edit goes through
#   demo-firm-claim.sh firm   senior makes a --firm claim: junior's overlapping edit is denied
#   demo-firm-claim.sh        both, soft first (the before/after pair)
#
# Needs node >= 22 and `pnpm install` in the repo. It builds the adapter and the local coordinator first.
set -euo pipefail

pkg=$(cd "$(dirname "$0")/.." && pwd)
bundle="$pkg/dist/weft-claude.mjs"
coordinator="$pkg/dist/demo-coordinator.mjs"
mode=${1:-both}
case "$mode" in
  soft|firm|both) ;;
  *) echo "usage: $0 [soft|firm]" >&2; exit 2 ;;
esac

work=$(mktemp -d)
coord_pid=""
url=""
cleanup() {
  if [[ -n "$coord_pid" ]]; then kill "$coord_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

node "$pkg/scripts/build.mjs"

# The two versions of calcTotal: the junior's edit changes its signature.
cat > "$work/v1.ts" <<'TS'
export type Item = { price: number; qty: number };

export function calcTotal(items: Item[]): number {
  return items.reduce((sum, i) => sum + i.price * i.qty, 0);
}
TS
cat > "$work/v2.ts" <<'TS'
export type Item = { price: number; qty: number };
export type PriceOptions = { taxRate: number };

export function calcTotal(items: Item[], opts: PriceOptions): number {
  const net = items.reduce((sum, i) => sum + i.price * i.qty, 0);
  return net * (1 + opts.taxRate);
}
TS

start_coordinator() {
  node "$coordinator" > "$work/coordinator-$1.log" 2>&1 &
  coord_pid=$!
  url=""
  for _ in $(seq 100); do
    url=$(sed -n 's/^listening //p' "$work/coordinator-$1.log")
    [[ -n "$url" ]] && break
    sleep 0.1
  done
  [[ -n "$url" ]] || { echo "the local coordinator did not start" >&2; exit 1; }
}

stop_coordinator() {
  kill "$coord_pid" 2>/dev/null || true
  wait "$coord_pid" 2>/dev/null || true
  coord_pid=""
}

# setup_checkout <dir> <agent> <task> <priority> <claude session>
setup_checkout() {
  mkdir -p "$1/src"
  cp "$work/v1.ts" "$1/src/pricing.ts"
  git -C "$1" init -q -b main
  git -C "$1" -c user.email=demo@weft.invalid -c user.name=demo add -A
  git -C "$1" -c user.email=demo@weft.invalid -c user.name=demo commit -qm init
  (cd "$1" && WEFT_TOKEN=demo-token node "$bundle" install --url "$url" --repo demo --agent "$2" --task "$3" --title "$3 work" --priority "$4" >/dev/null)
  printf '{"hook_event_name":"SessionStart","session_id":"%s","cwd":"%s","source":"startup"}' "$5" "$1" | node "$bundle" hook >/dev/null
}

# the text a hook or claim prints for the model: the reason lines, not the JSON envelope
reason_of() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o={};try{o=JSON.parse(s)}catch{}const h=o.hookSpecificOutput||{};const t=[o.reason,h.additionalContext,h.permissionDecisionReason].filter(Boolean).join("\n");process.stdout.write((t||"(no diagnostics)")+"\n")})'
}

scenario() {
  local firm=no
  [[ "$1" == firm ]] && firm=yes
  local senior="$work/$1-senior" junior="$work/$1-junior"

  echo
  echo "== $1 claim =="
  start_coordinator "$1"
  setup_checkout "$senior" claude-a T-1 1 sa
  setup_checkout "$junior" claude-b T-2 0 sb

  local claim_args=(claim --keys src/pricing.ts#calcTotal)
  local claim_label="soft"
  if [[ "$firm" == yes ]]; then claim_args+=(--firm); claim_label="firm"; fi
  echo "senior (claude-a): weft claim --keys src/pricing.ts#calcTotal ($claim_label)"
  (cd "$senior" && node "$bundle" "${claim_args[@]}")

  echo "junior (claude-b): Edit src/pricing.ts, changes the signature of calcTotal"
  local pre
  pre=$(node -e '
    const [root, oldS, newS] = process.argv.slice(1);
    process.stdout.write(JSON.stringify({ hook_event_name: "PreToolUse", session_id: "sb", cwd: root, tool_name: "Edit", tool_use_id: "b1",
      tool_input: { file_path: root + "/src/pricing.ts", old_string: oldS, new_string: newS } }));
  ' "$junior" "$(cat "$work/v1.ts")" "$(cat "$work/v2.ts")" | node "$bundle" hook)
  printf '%s' "$pre" | reason_of

  if grep -q '"permissionDecision":"deny"' <<<"$pre"; then
    echo "VERDICT ($1): DENIED. The junior's overlapping edit is blocked (claim_wait, error)."
  elif grep -qE 'being edited|firmly claimed' <<<"$pre"; then
    echo "VERDICT ($1): WARNING. The junior gets a claim_wait warning; the edit goes through."
  else
    echo "VERDICT ($1): no conflict reported."
  fi

  stop_coordinator
}

case "$mode" in
  soft) scenario soft ;;
  firm) scenario firm ;;
  both)
    scenario soft
    scenario firm
    ;;
esac
