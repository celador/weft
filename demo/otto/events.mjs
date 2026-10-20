// Print the Weft log (no heartbeats) after a sequence number: node demo/otto/events.mjs <after>
import { events } from "./lib.mjs";
const ev = await events(Number(process.argv[2] ?? 0));
const pick = ev.filter(e => !["heartbeat"].includes(e.kind));
for (const e of pick) {
  const extra = e.kind.startsWith("negotiate") ? JSON.stringify(e.payload).slice(0,160) : e.kind==="edit" ? (e.writes??[]).map(w=>w.key+":"+w.kind).join(",")+(e.diagnostics?.length? " DIAG "+JSON.stringify(e.diagnostics).slice(0,200):"") : (e.diagnostics?.length? JSON.stringify(e.diagnostics).slice(0,200):"");
  console.log(e.seq, e.at?.slice(11,19) ?? "", e.kind, e.status ?? "", e.agent ?? "", extra);
}
