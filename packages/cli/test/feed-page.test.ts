// The feed page's inline script lives inside a TypeScript template literal, where a stray `\/` or
// `\d` silently changes meaning. This parses what the gateway really serves (a workerd test cannot:
// code generation from strings is off there) and runs the parts that need no network.
import { describe, expect, it } from "vitest";
import { FEED_HTML } from "../../../apps/gateway/src/feed-page";

const script = FEED_HTML.slice(FEED_HTML.indexOf("<script>") + "<script>".length, FEED_HTML.indexOf("</script>"));

describe("feed page script", () => {
  it("parses as JavaScript", () => {
    expect(script.length).toBeGreaterThan(1000);
    expect(() => new Function(script)).not.toThrow();
  });
  it("sends no Authorization header and builds no credential from the URL", () => {
    expect(script.toLowerCase()).not.toContain("authorization");
    expect(script).not.toMatch(/location\.hash[^;]*(?:headers|fetch)/);
  });
  it("retires #t= links before doing anything else", () => {
    const retire = script.indexOf("history.replaceState(null, \"\", location.pathname + location.search)");
    expect(retire).toBeGreaterThan(0);
    expect(retire).toBeLessThan(script.indexOf("/v1/viewer"));
  });
});
