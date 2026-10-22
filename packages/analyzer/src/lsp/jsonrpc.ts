// A minimal JSON-RPC 2.0 client for language servers over stdio (LSP base protocol:
// `Content-Length` framed messages). No dependencies; enough for initialize, document sync,
// definition/references requests, server-to-client requests and published diagnostics.
import { spawn, type ChildProcess } from "node:child_process";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json | undefined };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };
type Handler = (params: unknown) => unknown;

export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

/** One JSON-RPC peer on a readable/writable byte stream pair (a server's stdout/stdin). */
export class JsonRpc {
  private nextId = 1;
  private buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private readonly notifications = new Map<string, Handler[]>();
  private readonly requests = new Map<string, Handler>();
  private closedError: Error | undefined;

  constructor(
    private readonly input: NodeJS.ReadableStream,
    private readonly output: NodeJS.WritableStream,
    private readonly timeoutMs = 15_000,
  ) {
    input.on("data", (chunk: Buffer) => this.onData(chunk));
    input.on("end", () => this.close(new Error("language server closed its output")));
    input.on("error", (err: Error) => this.close(err));
  }

  get closed(): boolean {
    return this.closedError !== undefined;
  }

  request<T = unknown>(method: string, params?: unknown, timeoutMs = this.timeoutMs): Promise<T> {
    if (this.closedError) return Promise.reject(this.closedError);
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) });
    });
  }

  notify(method: string, params?: unknown): void {
    if (this.closedError) return;
    this.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
  }

  /** Subscribe to a server notification (e.g. `textDocument/publishDiagnostics`). */
  on(method: string, handler: Handler): () => void {
    const list = this.notifications.get(method) ?? [];
    list.push(handler);
    this.notifications.set(method, list);
    return () => {
      const l = this.notifications.get(method);
      if (l) this.notifications.set(method, l.filter((h) => h !== handler));
    };
  }

  /** Answer a server-to-client request (e.g. `workspace/configuration`). Unhandled ones get `null`. */
  handle(method: string, handler: Handler): void {
    this.requests.set(method, handler);
  }

  close(err: Error = new Error("connection closed")): void {
    if (this.closedError) return;
    this.closedError = err;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
      this.pending.delete(id);
    }
  }

  private send(message: object): void {
    const body = Buffer.from(JSON.stringify(message), "utf8");
    try {
      this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
    } catch (err) {
      this.close(err instanceof Error ? err : new Error(String(err)));
    }
  }

  private onData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const match = /content-length:\s*(\d+)/i.exec(header);
      if (!match) {
        // Not LSP framing: drop up to the separator and resynchronize.
        this.buffer = this.buffer.subarray(headerEnd + 4);
        continue;
      }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (this.buffer.length < start + length) return;
      const body = this.buffer.subarray(start, start + length).toString("utf8");
      this.buffer = this.buffer.subarray(start + length);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } };
      try {
        message = JSON.parse(body);
      } catch {
        continue;
      }
      this.dispatch(message);
    }
  }

  private dispatch(m: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { code: number; message: string } }): void {
    if (m.method !== undefined && m.id !== undefined) {
      // Server -> client request.
      const handler = this.requests.get(m.method);
      Promise.resolve()
        .then(() => (handler ? handler(m.params) : null))
        .then(
          (result) => this.send({ jsonrpc: "2.0", id: m.id, result: result ?? null }),
          (err: unknown) => this.send({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: String(err) } }),
        );
      return;
    }
    if (m.method !== undefined) {
      for (const h of this.notifications.get(m.method) ?? []) {
        try {
          h(m.params);
        } catch {
          /* a subscriber's failure is its own */
        }
      }
      return;
    }
    if (typeof m.id !== "number") return;
    const p = this.pending.get(m.id);
    if (!p) return;
    this.pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.reject(new RpcError(m.error.code, m.error.message));
    else p.resolve(m.result ?? null);
  }
}

/** A language server child process plus its JSON-RPC connection. */
export type ServerProcess = { rpc: JsonRpc; child: ChildProcess; stderr: () => string };

export function spawnServer(command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv = process.env, timeoutMs?: number): ServerProcess {
  const child = spawn(command, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr!.on("data", (c: Buffer) => {
    stderr = (stderr + c.toString("utf8")).slice(-8000);
  });
  const rpc = new JsonRpc(child.stdout!, child.stdin!, timeoutMs);
  child.on("error", (err) => rpc.close(err));
  child.on("exit", (code, signal) => rpc.close(new Error(`language server exited (${signal ?? code})`)));
  child.stdin!.on("error", () => {
    /* EPIPE after exit: reported through the exit handler */
  });
  return { rpc, child, stderr: () => stderr };
}
