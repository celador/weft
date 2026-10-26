#!/usr/bin/env bash
# Cloudflare Connect (Wed Oct 21 2026) preflight for the Weft demo.
#   scripts/connect-preflight.sh            # every check, about 20 s
#   scripts/connect-preflight.sh --quick    # skip the write test (read-only)
# One line per check: green "ok" or red "FAIL", in plain words. Exits 1 if anything is red.
# Needs only curl, dig and Node 22+ (for the WebSocket and the two-agent test). Runs no repo code.
# The two-agent test writes to the private repo `connect-preflight` (never shown on demo.weft.mx)
# with tokens in ~/.config/weft/connect-preflight.json (mode 600; minted once with the admin token).
set -uo pipefail
export PATH="/opt/homebrew/opt/node@24/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"

QUICK=0; [ "${1:-}" = "--quick" ] && QUICK=1
PUBLIC="https://demo.weft.mx"
SITE="https://weft-site.elier.ai"
GATEWAY="https://weft-gateway-preview.elier.ai"
MEDIA="https://weft-media.elier.ai"
UA="weft-connect-preflight/1"
CREDS="$HOME/.config/weft/connect-preflight.json"
# The deck, runbook and Q&A live in the private repo celador/weft-talks (clone it next to weft).
CONNECT_DECK_DIR="${CONNECT_DECK_DIR:-$(cd "$(dirname "$0")/.." && pwd)/../weft-talks/connect-2026}"
FAILS=0; WARNS=0
if [ -t 1 ]; then G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; N=$'\e[0m'; else G=; R=; Y=; N=; fi
ok()   { printf '%s  ok  %s %s\n' "$G" "$N" "$*"; }
bad()  { printf '%s FAIL %s %s\n' "$R" "$N" "$*"; FAILS=$((FAILS+1)); }
warn() { printf '%s warn %s %s\n' "$Y" "$N" "$*"; WARNS=$((WARNS+1)); }
code() { curl -s -o /dev/null -m 15 -A "$UA" -w '%{http_code}' "$@"; }
body() { curl -s -m 15 -A "$UA" "$@"; }

echo "Weft Connect preflight  $(date -u '+%Y-%m-%d %H:%M UTC')  ($(date '+%a %H:%M %Z'))"
echo

echo "Names (asked of Cloudflare's public DNS, 1.1.1.1)"
for h in demo.weft.mx weft-site.elier.ai weft-media.elier.ai weft-gateway-preview.elier.ai; do
  ips=$(dig +short +time=3 +tries=2 @1.1.1.1 "$h" A 2>/dev/null | grep -E '^[0-9.]+$' | tr '\n' ' ')
  if [ -z "$ips" ]; then bad "$h does not resolve"
  elif echo "$ips" | grep -qE '^(10\.|192\.168\.|127\.|172\.(1[6-9]|2[0-9]|3[01])\.)'; then bad "$h points at a private address ($ips)"
  else ok "$h resolves to Cloudflare ($ips)"; fi
done
echo

echo "Pages people will open"
c=$(code "$SITE/"); s=$(body "$SITE/")
if [ "$c" = 200 ] && echo "$s" | grep -q 627; then ok "marketing page $SITE loads (shows the 627-event stat)"
else bad "marketing page $SITE: HTTP $c"; fi
c=$(code "$PUBLIC/")
[ "$c" = 200 ] && ok "live UI $PUBLIC loads" || bad "live UI $PUBLIC: HTTP $c (must be 200, not a login redirect)"
c=$(code https://github.com/celador/weft)
[ "$c" = 200 ] && ok "public repo github.com/celador/weft is up" || bad "github.com/celador/weft: HTTP $c"
for f in weft-demo-short.mp4 weft-demo.mp4 connect-2026-backup.mp4; do
  len=$(curl -sI -m 15 -A "$UA" "$MEDIA/$f" | awk 'tolower($1)=="content-length:"{print $2+0}')
  if [ "${len:-0}" -gt 1000000 ]; then ok "video $MEDIA/$f is online ($((len/1000000)) MB)"
  else bad "video $MEDIA/$f is missing"; fi
done
echo

echo "Live UI talks to the coordinator"
me=$(body "$PUBLIC/api/me")
if echo "$me" | grep -q '"readOnly":true' && echo "$me" | grep -q '"ok":true'; then ok "UI reaches the coordinator and is read-only for guests"
else bad "UI /api/me unexpected: ${me:0:160}"; fi
repos=$(body "$PUBLIC/api/repos")
names=$(echo "$repos" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).repos.map(r=>r.repo).join(","))}catch{console.log("")}})')
head_seq=$(echo "$repos" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s).repos.find(r=>r.repo==="weft");console.log(r?`${r.head_seq} ${r.last_event_at}`:"")}catch{console.log("")}})')
if [ "$names" = "weft" ]; then ok "UI lists exactly one repo, weft (log head #${head_seq% *}, last event ${head_seq#* })"
else bad "UI repo list should be exactly 'weft', got '$names'"; fi
n=$(body "$PUBLIC/api/repos/weft/events?limit=5" | grep -o '"seq":' | wc -l | tr -d ' ')
[ "${n:-0}" -ge 1 ] && ok "weft event log reads back ($n recent events)" || bad "weft event log returned nothing"
c=$(code -X POST -H 'content-type: application/json' -d '{}' "$PUBLIC/api/repos/weft/actions")
[ "$c" = 403 ] && ok "guests cannot act (POST refused with 403)" || bad "guest POST returned $c, expected 403"
c=$(code "$PUBLIC/api/repos/connect-preflight/events")
[ "$c" = 404 ] && ok "other repos stay private (404)" || bad "private repo visible on public UI: HTTP $c"
from=$(( ${head_seq% *} > 3 ? ${head_seq% *} - 3 : 0 ))
ws=$(PUBLIC="$PUBLIC" FROM="$from" node -e '
  const ws = new WebSocket(process.env.PUBLIC.replace("https","wss") + "/api/repos/weft/stream?after=" + process.env.FROM);
  const t = setTimeout(() => { console.log("timeout"); process.exit(0); }, 12000);
  ws.onmessage = (m) => { clearTimeout(t); console.log("frame " + String(m.data).slice(0, 60)); process.exit(0); };
  ws.onerror = (e) => { console.log("error " + (e.message || "")); process.exit(0); };' 2>&1)
case "$ws" in frame*) ok "live stream (WebSocket) delivers events to the browser";;
  *) bad "live stream did not deliver a frame: $ws";; esac
echo

echo "Coordinator and supporting Workers"
h=$(body "$GATEWAY/v1/health")
echo "$h" | grep -q '"ok":true' && ok "coordinator (weft-gateway-preview) healthy, $(echo "$h" | grep -o 'wcp/[0-9.]*')" || bad "coordinator health: ${h:0:120}"
for w in weft-sandbox-preview weft-workflows-preview weft-previews-preview; do
  c=$(code "https://$w.elier.ai/")
  if [ "$c" != 000 ] && [ "$c" -lt 500 ]; then ok "$w answers (HTTP $c)"; else bad "$w down (HTTP $c)"; fi
done
echo

if [ "$QUICK" = 0 ]; then
  echo "Two agents, one symbol (the demo's core moment), on private repo connect-preflight"
  if [ ! -r "$CREDS" ]; then
    bad "no $CREDS (preflight tokens); see $CONNECT_DECK_DIR/runbook.md (github.com/celador/weft-talks)"
  else
    CREDS="$CREDS" node --input-type=module -e '
      import { readFileSync } from "node:fs";
      const c = JSON.parse(readFileSync(process.env.CREDS, "utf8"));
      const U = c.url, R = c.repo, run = Date.now().toString(36);
      const caps = { level: 3, observe: "sync", inject: "immediate", deny_edit: true, refuse_stop: true, commit_gate: "tool_interception" };
      const call = async (tok, m, p, b) => {
        const r = await fetch(`${U}/v1/repos/${R}${p}`, { method: m, headers: { authorization: `Bearer ${tok}`, "content-type": "application/json", "wcp-version": "0.1", "user-agent": "weft-connect-preflight/1" }, body: b ? JSON.stringify(b) : undefined });
        const t = await r.text(); let j; try { j = JSON.parse(t); } catch { j = t; }
        if (!r.ok) throw new Error(`${m} ${p} -> ${r.status} ${t.slice(0, 160)}`);
        return j;
      };
      const out = (good, msg) => console.log(`${good ? "OK" : "FAIL"} ${msg}`);
      const A = c["preflight-a"], B = c["preflight-b"];
      let sa, sb;
      try {
        const t0 = Date.now();
        const wa = await call(A, "POST", "/sessions", { type: "hello", protocol: "wcp/0.1", agent: { id: "preflight-a", harness: "claude-code" }, capabilities: caps, task: { id: `pf-a-${run}` }, change: `pf-a-${run}` });
        const wb = await call(B, "POST", "/sessions", { type: "hello", protocol: "wcp/0.1", agent: { id: "preflight-b", harness: "codex" }, capabilities: caps, task: { id: `pf-b-${run}` }, change: `pf-b-${run}` });
        sa = wa.session; sb = wb.session;
        out(sa && sb, `two agents joined (${Date.now() - t0} ms)`);
        const key = `src/checkout/cart.ts#applyCoupon_${run}`;
        // base_seq = what each agent has seen (its welcome delivered_through), as a real adapter sends.
        const edit = (base) => ({ type: "submit", mode: "commit", event: { kind: "edit", base_seq: base, writes: [{ key, kind: "body" }], summary: "preflight edit" } });
        const ra = await call(A, "POST", `/sessions/${sa}/events`, edit(wa.delivered_through));
        out(ra.verdict === "accept", `agent A edits applyCoupon: ${ra.verdict}`);
        const rb = await call(B, "POST", `/sessions/${sb}/events`, edit(wb.delivered_through));
        const d = (rb.diagnostics ?? []).map((x) => `${x.severity}:${x.code}`).join(",");
        out(/claim_wait/.test(d), `agent B touches the same function: Weft says ${d || "nothing"} (${rb.verdict})`);
        const ev = await call(A, "GET", "/events?limit=10&tail=1");
        out((ev.events ?? []).some((e) => e.session === sb || e.agent === "preflight-b"), "both edits are in the shared log");
      } catch (e) { out(false, String(e.message || e)); }
      for (const [t, s] of [[A, sa], [B, sb]]) if (s) await call(t, "DELETE", `/sessions/${s}`).catch(() => {});
    ' 2>&1 | while IFS= read -r line; do
      case "$line" in OK\ *) ok "${line#OK }";; FAIL\ *) bad "${line#FAIL }"; echo x >> "${TMPDIR:-/tmp}/weft-pf.$$";; *) bad "$line"; echo x >> "${TMPDIR:-/tmp}/weft-pf.$$";; esac
    done
    if [ -f "${TMPDIR:-/tmp}/weft-pf.$$" ]; then FAILS=$((FAILS + $(wc -l < "${TMPDIR:-/tmp}/weft-pf.$$"))); rm -f "${TMPDIR:-/tmp}/weft-pf.$$"; fi
  fi
  echo
fi

echo "Nothing scheduled to tear the demo down early"
JOBS="$HOME/.hermes/cron/jobs.json"
if [ -r "$JOBS" ]; then
  r=$(JOBS="$JOBS" node -e '
    const j = JSON.parse(require("fs").readFileSync(process.env.JOBS, "utf8"));
    const jobs = Array.isArray(j) ? j : j.jobs;
    const w = jobs.find((x) => /wind-down/i.test(x.name || "") && /weft/i.test(x.name || ""));
    if (!w) { console.log("none"); process.exit(0); }
    const at = new Date(w.next_run_at || w.schedule?.run_at);
    const ok = at.getTime() > Date.parse("2026-10-22T06:59:00Z");
    console.log(`${ok ? "late" : "early"} ${w.enabled ? "enabled" : "disabled"} ${at.toISOString()}`);')
  case "$r" in
    none) ok "no Weft wind-down job on this Mac";;
    late*) set -- $r; ok "wind-down job runs $3 ($2), after the talk (Oct 22 06:59 UTC = Oct 21 23:59 PT)";;
    *) set -- $r; bad "wind-down job would run $3, BEFORE the talk ends";;
  esac
else warn "cannot read $JOBS (not on John's Mac?); wind-down timing not checked"; fi
[ -e "$HOME/github/weft/KEEP_LIVE" ] && ok "KEEP_LIVE present: wind-down will skip" || ok "KEEP_LIVE absent: wind-down deletes the sandbox/workflows/previews Workers on Oct 22 (UI, coordinator, video stay)"
echo

if [ "$FAILS" -eq 0 ]; then printf '%sAll green.%s Demo is ready.\n' "$G" "$N"; exit 0; fi
printf '%s%d check(s) failed.%s Use the backup: %s/connect-2026-backup.mp4 or the stills in demo/video/connect-2026/stills/\n' "$R" "$FAILS" "$N" "$MEDIA"
exit 1
