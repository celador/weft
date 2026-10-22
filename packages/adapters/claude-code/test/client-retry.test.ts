// HttpTransport: one quick retry after a failed connection, none after a timeout.
import { describe, expect, it } from "vitest";
import { HttpTransport, WcpError } from "../src/client";

const ok = () => new Response(JSON.stringify({ type: "heartbeat.ack" }), { status: 200, headers: { "content-type": "application/json" } });

describe("HttpTransport retries", () => {
  it("retries once when the connection fails, then succeeds", async () => {
    let n = 0;
    const t = new HttpTransport("http://gw.test", "tok", "repo", 2000, (async () => {
      if (n++ === 0) throw new TypeError("fetch failed");
      return ok();
    }) as typeof fetch);
    await expect(t.heartbeat("s1")).resolves.toMatchObject({ type: "heartbeat.ack" });
    expect(n).toBe(2);
  });

  it("gives up after the second failure (fail open upstream)", async () => {
    let n = 0;
    const t = new HttpTransport("http://gw.test", "tok", "repo", 2000, (async () => {
      n++;
      throw new TypeError("fetch failed");
    }) as typeof fetch);
    await expect(t.heartbeat("s1")).rejects.toBeInstanceOf(WcpError);
    expect(n).toBe(2);
  });

  it("does not retry a timeout", async () => {
    let n = 0;
    const t = new HttpTransport("http://gw.test", "tok", "repo", 50, ((_u: string, init: RequestInit) => {
      n++;
      return new Promise((_r, reject) => init.signal!.addEventListener("abort", () => reject(new DOMException("timed out", "TimeoutError"))));
    }) as unknown as typeof fetch);
    await expect(t.heartbeat("s1")).rejects.toBeInstanceOf(WcpError);
    expect(n).toBe(1);
  });
});
