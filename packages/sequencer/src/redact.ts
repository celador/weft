// Secret redaction for observer views (spec §13). Diffs and intents can contain secrets an
// agent read; observers (phones, dashboards) see them with matches replaced. The log
// itself keeps the original text so agents and replay are unaffected.

import type { EventRecord, HistoryPage } from "@weft/protocol";

const PATTERNS: Array<[string, RegExp]> = [
  ["private-key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ["aws-access-key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ["github-token", /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g],
  ["slack-token", /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ["openai-key", /\bsk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}\b/g],
  ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["stripe-key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  // key = "value" assignments whose name says secret.
  [
    "assignment",
    /((?:api[_-]?key|secret|token|passw(?:or)?d|client[_-]?secret|access[_-]?key|auth)[A-Za-z0-9_]*["']?\s*[:=]\s*["'])([^"'\s]{8,})(["'])/gi,
  ],
];

export function redactText(s: string): { text: string; hits: number } {
  let hits = 0;
  let text = s;
  for (const [name, re] of PATTERNS) {
    text = text.replace(re, (...m: string[]) => {
      hits++;
      if (name === "assignment") return `${m[1]}[REDACTED:${name}]${m[3]}`;
      return `[REDACTED:${name}]`;
    });
  }
  return { text, hits };
}

/** Observer view of a record: diff and intent with secrets replaced. */
export function redactRecord(r: EventRecord): EventRecord {
  let out = r;
  if (typeof r.diff === "string") {
    const d = redactText(r.diff);
    if (d.hits) out = { ...out, diff: d.text };
  }
  if (typeof r.intent === "string") {
    const i = redactText(r.intent);
    if (i.hits) out = { ...out, intent: i.text };
  }
  return out;
}

/**
 * History view (spec §9.7, §13): the free text an entry quotes from the log (revert reasons and
 * evidence, negotiation terms and reasons, diagnostic messages) with secrets replaced, as for
 * observer reads. Agent tokens read history too, so it gets the same treatment.
 */
export function redactHistory(p: HistoryPage): HistoryPage {
  const t = (s: string) => redactText(s).text;
  return {
    ...p,
    entries: p.entries.map((e) => ({
      ...e,
      ...(e.reason !== undefined ? { reason: t(e.reason) } : {}),
      ...(e.evidence !== undefined ? { evidence: t(e.evidence) } : {}),
      ...(e.terms ? { terms: { ...e.terms, text: t(e.terms.text) } } : {}),
      ...(e.causes ? { causes: e.causes.map((d) => ({ ...d, message: t(d.message), ...(d.suggestion !== undefined ? { suggestion: t(d.suggestion) } : {}) })) } : {}),
    })),
  };
}
