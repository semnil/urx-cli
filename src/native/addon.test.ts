import { describe, expect, it } from "vitest";
import { checkIdentity, expectedIdentity, loadAddon, openAddon, type ExpectedIdentity } from "./addon.js";

const commit = "0123456789abcdef0123456789abcdef01234567";
const expected: ExpectedIdentity = { bridgeRevision: 3, commonVersion: "0.1.0", commonCommit: commit };
const reported = (overrides: Record<string, unknown> = {}) => ({ bridgeRevision: 3, commonVersion: "0.1.0", commonCommit: commit, ...overrides });
const url = new URL("file:///nowhere/urx-native.node");
/** An addon module with every export the loader requires. */
/** A connection class with every method the loader requires. */
const method = () => undefined;
class CompleteConnection {
  close = method;
}
for (const name of ["close", "createOperation", "newRequestTicket", "getNumeric", "getText", "getName", "setNumeric", "setText", "adoptResult", "failDelivery", "terminate", "prepareSubscription", "adoptNotifications"]) {
  (CompleteConnection.prototype as unknown as Record<string, unknown>)[name] = method;
}
const addonWith = (buildIdentity: () => unknown, Connection: unknown = CompleteConnection) => ({
  buildIdentity,
  discover: () => Promise.resolve(null),
  openConnection: () => Promise.resolve(null),
  Control: class {},
  Connection,
});

describe("addon identity check", () => {
  it("accept an addon built from the same urx-device commit for the same bridge revision", () => {
    expect(checkIdentity(reported(), expected)).toBeNull();
  });

  it("refuse a different bridge revision, version or commit", () => {
    expect(checkIdentity(reported({ bridgeRevision: 1 }), expected)).toBe("bridge_mismatch");
    expect(checkIdentity(reported({ commonVersion: "0.2.0" }), expected)).toBe("common_mismatch");
    expect(checkIdentity(reported({ commonCommit: "f".repeat(40) }), expected)).toBe("common_mismatch");
  });

  it("refuse when either side cannot name its urx-device commit", () => {
    expect(checkIdentity(reported({ commonCommit: "unknown" }), expected)).toBe("unverifiable");
    expect(checkIdentity(reported(), { ...expected, commonCommit: "unknown" })).toBe("unverifiable");
    expect(checkIdentity(reported({ commonCommit: "unknown" }), { ...expected, commonCommit: "unknown" })).toBe("unverifiable");
    expect(checkIdentity(reported({ commonVersion: "unknown" }), { ...expected, commonVersion: "unknown" })).toBe("unverifiable");
    expect(checkIdentity(reported({ commonVersion: "unknown" }), expected)).toBe("unverifiable");
    expect(checkIdentity(reported(), { ...expected, commonVersion: "unknown" })).toBe("unverifiable");
  });

  it("refuse a malformed identity", () => {
    for (const value of [null, undefined, 1, "x", {}, reported({ bridgeRevision: "1" }), reported({ bridgeRevision: 1.5 }), reported({ commonVersion: 1 }), reported({ commonCommit: null })]) {
      expect(checkIdentity(value, expected), JSON.stringify(value)).toBe("malformed");
    }
  });

  it("take the expectation from the embedded build information and bridge revision", () => {
    expect(expectedIdentity({ appVersion: "0.1.0", appCommit: "a", commonVersion: "0.1.0", commonCommit: commit })).toEqual(expected);
  });
});

describe("addon loading", () => {
  it("report a load failure as missing instead of throwing", () => {
    expect(
      loadAddon(url, () => {
        throw new Error("Cannot find module");
      }),
    ).toEqual({ ok: false, problem: "missing" });
  });

  it("report an addon without one of its required exports as malformed", () => {
    for (const module of [null, {}, { buildIdentity: 1 }]) expect(loadAddon(url, () => module)).toEqual({ ok: false, problem: "malformed" });
    for (const name of ["buildIdentity", "discover", "openConnection", "Control", "Connection"]) {
      const module: Record<string, unknown> = addonWith(() => reported());
      delete module[name];
      expect(loadAddon(url, () => module), name).toEqual({ ok: false, problem: "malformed" });
    }
  });

  it("refuse an addon of another bridge revision as bridge_mismatch whatever it exports", () => {
    class Lifecycle {
      close() {}
    }
    // As the revision-1 addon: its connections have no request methods.
    expect(openAddon(expected, url, () => addonWith(() => reported({ bridgeRevision: 1 }), Lifecycle))).toEqual({ ok: false, problem: "bridge_mismatch" });
    expect(openAddon(expected, url, () => addonWith(() => reported({ bridgeRevision: 1 })))).toEqual({ ok: false, problem: "bridge_mismatch" });
    // As the revision-2 addon: its connections have no subscription methods.
    expect(openAddon(expected, url, () => ({ buildIdentity: () => reported({ bridgeRevision: 2 }) }))).toEqual({ ok: false, problem: "bridge_mismatch" });
    expect(openAddon(expected, url, () => ({ buildIdentity: () => reported({ bridgeRevision: 4 }) }))).toEqual({ ok: false, problem: "bridge_mismatch" });
  });

  it("refuse an addon of this revision that lacks an export or a connection method as malformed", () => {
    class Lifecycle {
      close() {}
    }
    expect(openAddon(expected, url, () => addonWith(() => reported(), Lifecycle))).toEqual({ ok: false, problem: "malformed" });
    expect(openAddon(expected, url, () => ({ buildIdentity: () => reported() }))).toEqual({ ok: false, problem: "malformed" });
    expect(loadAddon(url, () => addonWith(() => reported(), Lifecycle))).toEqual({ ok: false, problem: "malformed" });
    expect(openAddon(expected, url, () => addonWith(() => reported()))).toMatchObject({ ok: true });
  });

  it("open only an addon whose identity matches", () => {
    expect(openAddon(expected, url, () => addonWith(() => reported()))).toMatchObject({ ok: true });
    expect(openAddon(expected, url, () => addonWith(() => reported({ bridgeRevision: 9 })))).toEqual({ ok: false, problem: "bridge_mismatch" });
    expect(
      openAddon(expected, url, () =>
        addonWith(() => {
          throw new Error("boom");
        }),
      ),
    ).toEqual({ ok: false, problem: "malformed" });
  });
});
