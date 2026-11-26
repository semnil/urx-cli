// Single requests through urx-device's operations, the addon's transport and
// the production Rust transport, against a controlled local peer (K30).
// Needs `pnpm build` and `pnpm build:native`.

import { afterEach, describe, expect, it } from "vitest";
import { startPeer, type Peer, type PeerUnit } from "./device-center-peer.js";

const dist = new URL("../dist/", import.meta.url);
/** channel.on of channel 1 on URX44: parameter 140 at 0:0, 0 or 1. */
const CHANNEL_1_ON = "/vd/parameters/140:0:0";

async function modules() {
  const addonModule = (await import(new URL("native/addon.js", dist).href)) as typeof import("../src/native/addon.js");
  const device = (await import(new URL("native/device.js", dist).href)) as typeof import("../src/native/device.js");
  const transportModule = (await import(new URL("native/transport.js", dist).href)) as typeof import("../src/native/transport.js");
  const build = (await import(new URL("build-info.js", dist).href)) as typeof import("../src/build-info.js");
  const operations = await import("@urx/device-control/operations");
  const opened = addonModule.openAddon(addonModule.expectedIdentity(build.BUILD_INFO));
  if (!opened.ok) throw new Error(`the built addon was refused: ${opened.problem}`);
  return { addon: opened.addon, device, transportModule, operations };
}

let peer: Peer | undefined;
let close: (() => Promise<unknown>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
  await peer?.close();
  peer = undefined;
});

/** Opens the only unit of a peer with `unit`'s settings and returns its transport and requests so far. */
async function connected(unit: Omit<PeerUnit, "id" | "model">) {
  const { addon, device, transportModule, operations } = await modules();
  peer = await startPeer([{ id: "<id-a>", model: "URX44", ...unit }]);
  const control = new addon.Control();
  await device.discoverDevices(addon, control, false, peer.listPort);
  const opened = await device.openDevice(addon, control, "<id-a>");
  if (opened.kind !== "success") throw new Error(JSON.stringify(opened));
  close = () => device.closeConnection(opened.value);
  const transport = new transportModule.AddonTransport(opened.value);
  const opening = peer.requests.length;
  return { transport, operations, connection: opened.value, newRequests: () => (peer as Peer).requests.slice(opening) };
}

describe("reads and writes through urx-device's operations", () => {
  it("read a setting with one GET and write it with one POST, adopting each result", async () => {
    const { transport, operations, newRequests } = await connected({ parameters: { "140:0:0": 1 } });
    const context = new operations.OperationContext(transport, "URX44");
    expect((await operations.readSetting(context, "channel.on", { channel: 1 })).value).toBe(true);
    await operations.writeSetting(context, "channel.on", { channel: 1 }, false);
    expect((await operations.readSetting(context, "channel.on", { channel: 1 })).value).toBe(false);
    context.finish();
    expect(newRequests()).toEqual([`<id-a> get ${CHANNEL_1_ON}`, `<id-a> post ${CHANNEL_1_ON}?operation=value`, `<id-a> get ${CHANNEL_1_ON}`]);
  });

  it("keep a device rejection as a rejected write with its response code", async () => {
    const { transport, operations, newRequests } = await connected({ parameters: { "140:0:0": 1 }, writeResponse: 403 });
    const context = new operations.OperationContext(transport, "URX44");
    const failure = await operations.writeSetting(context, "channel.on", { channel: 1 }, false).then(
      () => undefined,
      (error: unknown) => operations.operationFailureOf(error),
    );
    expect(failure?.code).toBe("device_rejected");
    expect(newRequests()).toEqual([`<id-a> post ${CHANNEL_1_ON}?operation=value`]);
  });
});

describe("the native request records", () => {
  const address = { paramId: 140, x: "0", y: "0" };

  it("resolve a numeric read's K34 record and release its slot once adopted", async () => {
    const { transport } = await connected({ parameters: { "140:0:0": 7 } });
    const operation = transport.createOperation();
    const requestTicket = transport.newRequestTicket();
    expect(await transport.getNumeric(address, { operation, requestTicket })).toEqual({ kind: "success", value: "7", evidence: { state: "read" } });
    await transport.adoptResult(requestTicket);
    // At most once per ticket.
    await expect(transport.adoptResult(requestTicket)).rejects.toThrow();
    operation.finish();
  });

  it("hold the single wire slot until the result is adopted", async () => {
    const { transport, newRequests } = await connected({ parameters: { "140:0:0": 1, "140:0:1": 0 } });
    const operation = transport.createOperation();
    const first = transport.newRequestTicket();
    const second = transport.newRequestTicket();
    await transport.getNumeric(address, { operation, requestTicket: first });
    const pending = transport.getNumeric({ ...address, y: "1" }, { operation, requestTicket: second });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(newRequests()).toEqual([`<id-a> get ${CHANNEL_1_ON}`]);
    await transport.adoptResult(first);
    expect(await pending).toEqual({ kind: "success", value: "0", evidence: { state: "read" } });
    expect(newRequests()).toEqual([`<id-a> get ${CHANNEL_1_ON}`, "<id-a> get /vd/parameters/140:0:1"]);
    await transport.adoptResult(second);
  });

  it("refuse an invalid address or value before sending, and a reused ticket without touching its slot", async () => {
    const { transport, newRequests } = await connected({ parameters: { "140:0:0": 1 } });
    const operation = transport.createOperation();
    const invalid = transport.newRequestTicket();
    expect(await transport.getNumeric({ paramId: 140, x: "00", y: "0" }, { operation, requestTicket: invalid })).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "invalid_input", phase: "validation" },
      evidence: { state: "not_sent" },
    });
    await transport.adoptResult(invalid);
    const value = transport.newRequestTicket();
    expect(await transport.setNumeric(address, "1.5", { operation, requestTicket: value })).toMatchObject({ failure: { code: "invalid_input", phase: "validation" } });
    await transport.adoptResult(value);
    const used = transport.newRequestTicket();
    await transport.getNumeric(address, { operation, requestTicket: used });
    expect(await transport.getNumeric(address, { operation, requestTicket: used })).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "internal_error", phase: "admission" },
      evidence: { state: "not_sent" },
    });
    // The first use's slot is untouched and still adoptable.
    await transport.adoptResult(used);
    expect(newRequests()).toEqual([`<id-a> get ${CHANNEL_1_ON}`]);
  });

  it("refuse a parameter ID outside u32 before sending, in every request method", async () => {
    const { transport, newRequests } = await connected({ parameters: { "140:0:0": 1 } });
    const operation = transport.createOperation();
    for (const paramId of [140.9, -1, 4294967296, 4294967436, Number.NaN, Number.POSITIVE_INFINITY]) {
      const id = { paramId, x: "0", y: "0" };
      for (const call of [
        (requestTicket: string) => transport.getNumeric(id, { operation, requestTicket }),
        (requestTicket: string) => transport.getText(id, { operation, requestTicket }),
        (requestTicket: string) => transport.getName(id, { operation, requestTicket }),
        (requestTicket: string) => transport.setNumeric(id, "1", { operation, requestTicket }),
        (requestTicket: string) => transport.setText(id, "x", { operation, requestTicket }),
      ]) {
        const requestTicket = transport.newRequestTicket();
        expect(await call(requestTicket), String(paramId)).toEqual({
          kind: "failure",
          failure: { kind: "cause", code: "invalid_input", phase: "validation" },
          evidence: { state: "not_sent" },
        });
        await transport.adoptResult(requestTicket);
      }
    }
    expect(newRequests()).toEqual([]);
  });

  it("keep the connection after an undeliverable unsent result, and give two adapters over one connection distinct tickets", async () => {
    const { transport, connection, newRequests } = await connected({ parameters: { "140:0:0": 1 } });
    const cancelled = transport.createOperation();
    cancelled.cancel();
    const unsentTicket = transport.newRequestTicket();
    expect(await transport.getNumeric(address, { operation: cancelled, requestTicket: unsentTicket })).toMatchObject({ evidence: { state: "not_sent" } });
    await transport.failDelivery(unsentTicket);
    const { AddonTransport } = (await import(new URL("native/transport.js", dist).href)) as typeof import("../src/native/transport.js");
    const other = new AddonTransport(connection);
    const tickets = new Set([transport.newRequestTicket(), other.newRequestTicket(), transport.newRequestTicket(), other.newRequestTicket()]);
    expect(tickets.size).toBe(4);
    const operation = other.createOperation();
    const requestTicket = other.newRequestTicket();
    expect(await other.getNumeric(address, { operation, requestTicket })).toEqual({ kind: "success", value: "1", evidence: { state: "read" } });
    await other.adoptResult(requestTicket);
    expect(newRequests()).toEqual([`<id-a> get ${CHANNEL_1_ON}`]);
  });

  it("refuse requests of a finished or cancelled operation unsent", async () => {
    const { transport, newRequests } = await connected({ parameters: { "140:0:0": 1 } });
    const finished = transport.createOperation();
    finished.finish();
    expect(await transport.getNumeric(address, { operation: finished, requestTicket: transport.newRequestTicket() })).toMatchObject({
      failure: { code: "not_connected", phase: "admission" },
      evidence: { state: "not_sent" },
    });
    const cancelled = transport.createOperation();
    cancelled.cancel();
    expect(await transport.getNumeric(address, { operation: cancelled, requestTicket: transport.newRequestTicket() })).toMatchObject({
      failure: { kind: "cancelled", phase: "admission" },
      evidence: { state: "not_sent" },
    });
    expect(newRequests()).toEqual([]);
  });

  it("end the connection when a held result cannot be delivered, so later requests are refused", async () => {
    const { transport, newRequests } = await connected({ parameters: { "140:0:0": 1 } });
    const operation = transport.createOperation();
    const held = transport.newRequestTicket();
    await transport.getNumeric(address, { operation, requestTicket: held });
    await transport.failDelivery(held);
    expect(await transport.getNumeric(address, { operation, requestTicket: transport.newRequestTicket() })).toMatchObject({
      failure: { code: "not_connected", phase: "admission" },
      evidence: { state: "not_sent" },
    });
    // Nothing remains to end for that ticket.
    await transport.terminate(held);
    expect(newRequests()).toEqual([`<id-a> get ${CHANNEL_1_ON}`]);
  });

  it("report a response timeout with unconfirmed evidence after the 3-second deadline", async () => {
    const { transport } = await connected({ parameters: { "140:0:0": 1 }, silent: [CHANNEL_1_ON] });
    const started = performance.now();
    const operation = transport.createOperation();
    const requestTicket = transport.newRequestTicket();
    expect(await transport.setNumeric(address, "0", { operation, requestTicket })).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "response_timeout", phase: "response" },
      evidence: { state: "unconfirmed" },
    });
    expect(performance.now() - started).toBeGreaterThanOrEqual(2900);
    await transport.adoptResult(requestTicket);
  }, 15000);
});
