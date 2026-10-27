// The header's repo strip: a token that sees 100 repos must not fill the panel with idle
// "0 agents · 0 changes" lines (VS Code panel bug, t_d992bca5), and a session can be scoped
// to the workspace's repos after it was created.

import { describe, expect, it } from "vitest";
import { FeedSession, IDLE_REPO_MS, ObserverClient, type RepoSummary, stripRepos } from "../src";

const NOW = Date.parse("2026-10-27T12:00:00Z");
const repo = (name: string, o: Partial<RepoSummary> = {}): RepoSummary =>
  ({ repo: name, head_seq: 0, active_agents: 0, active_changes: 0, open_conflicts: 0, policy: {}, ...o }) as RepoSummary;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe("stripRepos", () => {
  it("hides idle repos and counts them", () => {
    const list = [
      repo("ForceCode"),
      repo("old", { last_event_at: ago(IDLE_REPO_MS + 60_000) }),
      repo("busy", { active_agents: 2 }),
      repo("changing", { active_changes: 1 }),
      repo("conflicted", { open_conflicts: 1 }),
      repo("recent", { last_event_at: ago(60_000) }),
      ...Array.from({ length: 98 }, (_, i) => repo(`idle-${i}`)),
    ];
    const s = stripRepos(list, { now: NOW });
    expect(s.shown.map((l) => l.repo)).toEqual(["busy", "changing", "conflicted", "recent"]);
    expect(s.idle).toBe(100);
  });

  it("keeps a single repo even when idle (the workspace's own repo)", () => {
    const s = stripRepos([repo("lawnstarter-take-home", { head_seq: 23 })], { now: NOW });
    expect(s.shown.map((l) => l.text)).toEqual(["lawnstarter-take-home · 0 agents · 0 changes"]);
    expect(s.idle).toBe(0);
  });

  it("reports all-idle lists as idle with nothing shown", () => {
    const s = stripRepos([repo("a"), repo("b")], { now: NOW });
    expect(s).toEqual({ shown: [], idle: 2 });
  });
});

describe("FeedSession scope", () => {
  it("streams only the scoped repos after setScope, and every repo after clearing it", async () => {
    const opened: string[][] = [];
    const client = new ObserverClient({ baseUrl: "http://weft.invalid", token: "t", fetch: () => Promise.reject(new Error("offline")) });
    client.repos = async () => [repo("a"), repo("b"), repo("lawnstarter-take-home")];
    client.events = async (r: string) => ({ type: "events", repo: r, events: [], head_seq: 0 }) as never;
    const streams: string[] = [];
    client.streamRepo = (r: string) => {
      streams.push(r);
      return { close() {}, wake() {}, status: "live" as const };
    };
    const opts = { perRepoStreams: true };
    const s = new FeedSession(client, opts);
    await s.start();
    opened.push(streams.splice(0));
    s.setScope(["lawnstarter-take-home"]);
    expect(s.scope).toEqual(["lawnstarter-take-home"]);
    await s.start();
    opened.push(streams.splice(0));
    s.setScope(undefined);
    await s.start();
    opened.push(streams.splice(0));
    expect(opened).toEqual([["a", "b", "lawnstarter-take-home"], ["lawnstarter-take-home"], ["a", "b", "lawnstarter-take-home"]]);
    expect(opts).toEqual({ perRepoStreams: true }); // the caller's options object is not mutated
    s.stop();
  });
});
