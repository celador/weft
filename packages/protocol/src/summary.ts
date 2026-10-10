import type { EventRecord, SymbolKey, Write } from "./types";

export type ParsedKey = { path: string; name: string; short: string };

const KEY = /^([^#\s]+)#([^#\s]+)$/;

export function isSymbolKey(key: string): boolean {
  return KEY.test(key);
}

export function parseKey(key: SymbolKey): ParsedKey {
  const m = KEY.exec(key);
  if (!m) throw new Error(`invalid symbol key ${JSON.stringify(key)}`);
  const name = m[2]!;
  return { path: m[1]!, name, short: name.split(".").pop()! };
}

export function fileOf(key: SymbolKey): string {
  return parseKey(key).path;
}

export const SUMMARY_MAX = 140;

function clip(s: string, max = SUMMARY_MAX): string {
  const one = s.replace(/\s+/g, " ").trim();
  const chars = [...one];
  return chars.length <= max ? one : chars.slice(0, max - 1).join("").trimEnd() + "…";
}

function names(keys: SymbolKey[]): string {
  const shorts = [...new Set(keys.map((k) => parseKey(k).name))];
  if (shorts.length === 0) return "";
  if (shorts.length <= 2) return shorts.join(", ");
  return `${shorts.slice(0, 2).join(", ")} +${shorts.length - 2} more`;
}

function editHead(writes: Write[]): string {
  const by = (kind: Write["kind"]) => writes.filter((w) => w.kind === kind).map((w) => w.key);
  const parts: string[] = [];
  const sig = by("signature");
  const body = by("body");
  const added = by("new");
  const deleted = by("deleted");
  if (sig.length) parts.push(`changed signature of ${names(sig)}`);
  if (body.length) parts.push(`edited ${names(body)}`);
  if (added.length) parts.push(`added ${names(added)}`);
  if (deleted.length) parts.push(`removed ${names(deleted)}`);
  const files = [...new Set(writes.map((w) => parseKey(w.key).path))];
  const where = files.length === 1 ? ` in ${files[0]}` : files.length > 1 ? ` in ${files.length} files` : "";
  return (parts.join(", ") || "edited") + where;
}

type Summarizable = Pick<EventRecord, "kind" | "status" | "actor" | "writes"> &
  Partial<Pick<EventRecord, "agent" | "intent" | "payload" | "change" | "task">> & { summary_hint?: string };

function who(r: Summarizable): string {
  return r.agent ?? r.actor.id;
}

function target(p: Record<string, unknown> | undefined): string {
  const to = (p?.to ?? p?.target) as { agent?: string; change?: string } | undefined;
  return to?.agent ?? to?.change ?? "?";
}

/**
 * Reference one-line human summary (spec §6.4). Coordinators MUST attach a summary of at
 * most 140 characters to every record; this function is the reference template.
 */
export function summarize(r: Summarizable): string {
  const p = r.payload;
  // Escalations carry their reason (spec §7.6); other negotiation records keep the template.
  const negotiationWhy = r.kind === "negotiate.escalate" && typeof p?.reason === "string" ? p.reason : "";
  const why = (r.summary_hint?.trim() || r.intent?.split("\n")[0]?.trim() || negotiationWhy.split("\n")[0]?.trim() || "").trim();
  const a = who(r);
  let head: string;
  switch (r.kind) {
    case "intent":
      head = `${a} plans`;
      break;
    case "edit":
      head = `${a} ${editHead(r.writes)}`;
      break;
    case "checkpoint":
      head = `${a} pushed checkpoint ${String(p?.sha ?? "").slice(0, 7)}`;
      break;
    case "claim":
      head = `${a} ${p?.source === "predicted" ? "is predicted to touch" : p?.firm ? "firmly claimed" : "claimed"} ${names(r.writes.map((w) => w.key))}`;
      break;
    case "release": {
      const keys = (p?.keys as string[] | undefined) ?? [];
      head = `${a} released ${keys.length ? names(keys) : "all claims"}${p?.reason ? ` (${String(p.reason).replace(/_/g, " ")})` : ""}`;
      break;
    }
    case "negotiate.propose": {
      const terms = p?.terms as { kind?: string } | undefined;
      head = `${a} → ${target(p)}: proposes ${terms?.kind ?? "terms"} on ${names((p?.keys as string[]) ?? [])}`;
      break;
    }
    case "negotiate.counter":
      head = `${a} countered #${p?.reply_to}`;
      break;
    case "negotiate.accept":
      head = `${a} accepted #${p?.reply_to}`;
      break;
    case "negotiate.reject":
      head = `${a} rejected #${p?.reply_to}`;
      break;
    case "negotiate.escalate": {
      const w = p?.with as { agent?: string; change?: string } | undefined;
      head = `${a} escalated conflict with ${w?.agent ?? w?.change ?? "?"} to the coordinator (merge tasks)`;
      break;
    }
    case "land":
      head = `${a} landed ${r.change ?? "change"} (${r.writes.length} symbol${r.writes.length === 1 ? "" : "s"})`;
      break;
    case "revert":
      head = `reverted ${p?.reverts_seq ? `#${p.reverts_seq}` : String(p?.reverts_op_id ?? "op")}${p?.reason ? `: ${p.reason}` : ""}`;
      break;
    case "message":
      head = `${a} → ${target(p)}: ${String(p?.text ?? "")}`;
      break;
    case "control": {
      const action = String(p?.action ?? "");
      const verb = { pause: "paused", resume: "resumed", approve: "approved", undo: "requested undo of", merge: "merged the tasks of" }[action] ?? action;
      const t = p?.target as { agent?: string; change?: string; seq?: number; op_id?: string; changes?: string[] } | undefined;
      const obj = t?.agent ?? t?.change ?? (t?.seq ? `#${t.seq}` : t?.op_id) ?? (t?.changes?.length ? t.changes.join(" + ") : "?");
      head = `${a} ${verb} ${obj}`;
      break;
    }
    case "join":
      head = `${a} joined (${String(p?.harness ?? "?")}, L${String(p?.level ?? "?")})`;
      break;
    case "leave":
      head = `${a} left`;
      break;
  }
  const prefix = r.status === "rejected" ? "Blocked: " : "";
  const tail = why && r.kind !== "message" && r.kind !== "revert" ? ` — ${why}` : "";
  return clip(prefix + head + tail);
}
