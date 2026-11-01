// The pairing half of the space API, for the CLI tests' stand-in gateways (the real one is tested
// in apps/gateway/test/spaces.test.ts): one-time codes, and the device list `weft viewers` shows.
export type Device = { id: string; label: string; created_at: string; last_seen_at: string; expires_at: string; space: string; token?: string; revoked?: boolean };

export function pairingStub() {
  const devices: Device[] = [];
  const codes: Array<{ code: string; space: string }> = [];
  let n = 0;
  /** Handle the pairing routes; returns true when it answered. `devicesAuth` = does this token belong to a live device. */
  function handle(method: string, path: string, body: string, space: string, origin: string, send: (status: number, j?: unknown) => void): boolean {
    const live = () => devices.filter((d) => d.space === space && !d.revoked);
    const view = (d: Device) => ({ id: d.id, label: d.label, created_at: d.created_at, last_seen_at: d.last_seen_at, expires_at: d.expires_at });
    if (path === "/v1/space/pairings" && method === "POST") {
      const code = `ABCDE-${String(++n).padStart(5, "F")}`;
      codes.push({ code, space });
      send(201, { type: "space.pairing", space, code, url: `${origin}/feed?space=${space}`, expires_in: 600, expires_at: new Date(Date.now() + 600_000).toISOString() });
      return true;
    }
    if (path === "/v1/space/viewers" && method === "POST") {
      const now = new Date().toISOString();
      const d: Device = { id: `dev_${++n}`, label: (JSON.parse(body || "{}").label as string) ?? "", created_at: now, last_seen_at: now, expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(), space, token: `weft_dev_${n}` };
      devices.push(d);
      send(201, { type: "space.viewer", token: d.token, device: view(d) });
      return true;
    }
    if (path === "/v1/space/viewers" && method === "GET") {
      send(200, { type: "space.viewers", viewers: live().map(view) });
      return true;
    }
    if (path === "/v1/space/viewers" && method === "DELETE") {
      const all = live();
      all.forEach((d) => (d.revoked = true));
      send(200, { type: "space.viewers.revoked", revoked: all.length });
      return true;
    }
    const m = /^\/v1\/space\/viewers\/(.+)$/.exec(path);
    if (m && method === "DELETE") {
      const d = live().find((x) => x.id === m[1]);
      if (!d) send(404, { type: "error", error: { code: "not_found", message: "no such paired device in this space" } });
      else {
        d.revoked = true;
        send(204);
      }
      return true;
    }
    return false;
  }
  /** Is this bearer a live device session (so the stand-in's read routes accept it)? */
  const accepts = (token: string) => devices.some((d) => d.token === token && !d.revoked);
  return { handle, devices, codes, accepts };
}
