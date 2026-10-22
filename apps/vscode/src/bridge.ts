// Messages between the extension host and the feed webview. The webview has no network
// access and never sees a token: the host owns the gateway connection (one ObserverClient,
// one FeedSession) and the webview mirrors its log through these messages.

import type { ActionKind, FeedEvent, RepoSummary, StreamStatus } from "@weft/feed";

export type RpcMethod = "repos" | "event" | "act";

export type ToHost =
  | { t: "ready" }
  | { t: "rpc"; id: number; m: RpcMethod; args: unknown[] }
  | { t: "openDiff"; id: string }
  | { t: "openFile"; repo: string; file: string }
  | { t: "selected"; id?: string }
  | { t: "command"; command: "setToken" | "reconnect" };

export type RpcError = { status: number; code: string; message: string; readOnly: boolean };

export type ToView =
  | { t: "init"; events: FeedEvent[]; repos: RepoSummary[]; status: StreamStatus; error?: string; title: string; selected?: string; canAct: boolean; tokenWhere?: string }
  | { t: "events"; events: FeedEvent[]; live: boolean }
  | { t: "repos"; repos: RepoSummary[] }
  | { t: "status"; status: StreamStatus; detail?: string }
  | { t: "rpc"; id: number; ok: true; value: unknown }
  | { t: "rpc"; id: number; ok: false; error: RpcError }
  | { t: "select"; id: string }
  | { t: "acted"; kind: ActionKind; seq: number };
