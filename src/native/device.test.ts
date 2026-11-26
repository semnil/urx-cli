import { describe, expect, it } from "vitest";
import { closeConnection, discoverDevices, openDevice, selectDevice, type LifecycleAddon, type NativeConnection } from "./device.js";

const unused = () => {
  throw new Error("not used by these tests");
};

class FakeConnection implements NativeConnection {
  readonly firmware = "1.5.0.1";
  readonly createOperation = unused;
  readonly getNumeric = unused;
  readonly getText = unused;
  readonly getName = unused;
  readonly setNumeric = unused;
  readonly setText = unused;
  readonly adoptResult = unused;
  readonly failDelivery = unused;
  readonly terminate = unused;
  constructor(private readonly closing: () => Promise<unknown>) {}
  close() {
    return this.closing();
  }
}

const fake = (discover: () => Promise<unknown>, open: () => Promise<unknown> = () => Promise.resolve(null)): LifecycleAddon => ({
  Control: class {
    cancel() {}
  },
  Connection: FakeConnection,
  discover,
  openConnection: open,
});
const control = { cancel() {} };
const complete = { state: "complete", failure: null };

describe("device selection (D13)", () => {
  const a = { id: "<id-a>", model: "URX44" };
  const b = { id: "<id-b>", model: "URX44" };

  it("select the requested ID exactly, never another unit", () => {
    expect(selectDevice([a, b], "<id-b>")).toEqual({ kind: "selected", device: b });
    expect(selectDevice([a], "<id-b>")).toEqual({ kind: "none", code: "device_not_found" });
    expect(selectDevice([a], "<ID-A>")).toEqual({ kind: "none", code: "device_not_found" });
    expect(selectDevice([a], "<id-a> ")).toEqual({ kind: "none", code: "device_not_found" });
  });

  it("select the only online unit when no ID is requested", () => {
    expect(selectDevice([a], undefined)).toEqual({ kind: "selected", device: a });
    expect(selectDevice([], undefined)).toEqual({ kind: "none", code: "device_not_found" });
    expect(selectDevice([a, b], undefined)).toEqual({ kind: "none", code: "multiple_devices" });
  });
});

describe("native lifecycle records", () => {
  it("adopt a valid discovery record", async () => {
    const record = { kind: "success", value: [{ id: "<id-a>", model: "URX44" }] };
    expect(await discoverDevices(fake(() => Promise.resolve(record)), control, false)).toEqual(record);
  });

  it("turn an invalid record or a rejected Promise into internal_error, never success", async () => {
    const internal = { kind: "failure", failure: { kind: "cause", code: "internal_error", phase: "discovery" }, cleanup: complete };
    for (const record of [null, {}, { kind: "success" }, { kind: "success", value: [{ id: "", model: "URX44" }] }, { kind: "success", value: [{ id: "x", model: "URX44", extra: 1 }] }]) {
      expect(await discoverDevices(fake(() => Promise.resolve(record)), control, false), JSON.stringify(record)).toEqual(internal);
    }
    // With metadata, an entry without firmware is incomplete.
    expect(await discoverDevices(fake(() => Promise.resolve({ kind: "success", value: [{ id: "x", model: "URX44" }] })), control, true)).toEqual(internal);
    expect(await discoverDevices(fake(() => Promise.reject(new Error("binding"))), control, false)).toEqual(internal);
  });

  it("adopt only a connection object the addon created", async () => {
    const connection = new FakeConnection(() => Promise.resolve({ kind: "success", value: null }));
    expect(await openDevice(fake(() => Promise.resolve(null), () => Promise.resolve({ kind: "success", value: connection })), control, "<id-a>")).toEqual({
      kind: "success",
      value: connection,
    });
    const unconfirmed = { kind: "failure", failure: { kind: "cause", code: "internal_error", phase: "connect" }, cleanup: { state: "incomplete", failure: null } };
    for (const value of [{ firmware: "x", close: () => Promise.resolve(null) }, null, "connection"]) {
      expect(await openDevice(fake(() => Promise.resolve(null), () => Promise.resolve({ kind: "success", value })), control, "<id-a>")).toEqual(unconfirmed);
    }
    expect(await openDevice(fake(() => Promise.resolve(null), () => Promise.reject(new Error("binding"))), control, "<id-a>")).toEqual(unconfirmed);
  });

  it("pass a declared open failure through as it is", async () => {
    const failure = { kind: "failure", failure: { kind: "cause", code: "connect_timeout", phase: "identity" }, cleanup: complete };
    expect(await openDevice(fake(() => Promise.resolve(null), () => Promise.resolve(failure)), control, "<id-a>")).toEqual(failure);
  });

  it("validate a close record, and report an unconfirmed close as incomplete", async () => {
    expect(await closeConnection(new FakeConnection(() => Promise.resolve({ kind: "success", value: null })))).toEqual({ kind: "success", value: null });
    const teardown = { kind: "failure", failure: { kind: "cause", code: "teardown_timeout", phase: "teardown" }, cleanup: { state: "incomplete", failure: null } };
    expect(await closeConnection(new FakeConnection(() => Promise.resolve(teardown)))).toEqual(teardown);
    const unconfirmed = { kind: "failure", failure: { kind: "cause", code: "internal_error", phase: "teardown" }, cleanup: { state: "incomplete", failure: null } };
    expect(await closeConnection(new FakeConnection(() => Promise.resolve({ kind: "success", value: 1 })))).toEqual(unconfirmed);
    expect(await closeConnection(new FakeConnection(() => Promise.reject(new Error("binding"))))).toEqual(unconfirmed);
  });
});
