// Subscriptions and notification delivery through the addon's transport and
// the production Rust transport, against a controlled local peer (K30, K37).
// Needs `pnpm build` and `pnpm build:native`.

import { afterEach, describe, expect, it, vi } from "vitest";
import type { TransportNotification } from "@urx/device-control/operations";
import { startPeer, type Peer, type PeerUnit } from "./device-center-peer.js";

const dist = new URL("../dist/", import.meta.url);
const LOCK = "/vd/parameters/895:0:0";
const LOCK_ADDRESS = { paramId: 895, x: "0", y: "0" };
/** channel.on of channel 1 on URX44, read as a barrier: its reply is released only after earlier notifications are adopted (K12). */
const BARRIER = "/vd/parameters/140:0:0";

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

/** Opens the only unit of a peer with `unit`'s settings. */
async function connected(unit: Omit<PeerUnit, "id" | "model"> = {}) {
  const { addon, device, transportModule, operations } = await modules();
  peer = await startPeer([{ id: "<id-a>", model: "URX44", ...unit, parameters: { "140:0:0": 1, "895:0:0": 0, ...unit.parameters } }]);
  const control = new addon.Control();
  await device.discoverDevices(addon, control, false, peer.listPort);
  const opened = await device.openDevice(addon, control, "<id-a>");
  if (opened.kind !== "success") throw new Error(JSON.stringify(opened));
  const { connection, notifications } = opened.value;
  close = () => device.closeConnection(connection);
  const transport = new transportModule.AddonTransport(connection, notifications);
  const opening = peer.requests.length;
  /** Completes one read, so every notification the peer pushed before it has been handed over. */
  const barrier = async () => {
    const operation = transport.createOperation();
    const requestTicket = transport.newRequestTicket();
    await transport.getNumeric({ paramId: 140, x: "0", y: "0" }, { operation, requestTicket });
    await transport.adoptResult(requestTicket);
    operation.finish();
  };
  const closeNow = () => device.closeConnection(connection);
  return { transport, operations, connection, notifications, peer, barrier, closeNow, newRequests: () => (peer as Peer).requests.slice(opening) };
}

const failureOf = async (promise: Promise<unknown>) => {
  const { operationFailureOf } = await import("@urx/device-control/operations");
  return promise.then(
    () => undefined,
    (error: unknown) => operationFailureOf(error),
  );
};

describe("subscriptions through the addon transport", () => {
  it("register on activation, deliver pushed notifications in order, and unregister on release", async () => {
    const { transport, peer, barrier, newRequests } = await connected();
    const delivered: TransportNotification[] = [];
    const operation = transport.createOperation();
    const subscription = transport.prepareSubscription([LOCK_ADDRESS], operation, (notification) => delivered.push(notification));
    // Admission is local.
    expect(newRequests()).toEqual([]);
    await subscription.activate();
    peer.notify("<id-a>", LOCK, 1);
    peer.notify("<id-a>", LOCK, "locked");
    peer.notify("<id-a>", LOCK, 0);
    await barrier();
    expect(delivered).toEqual([
      { kind: "numeric", address: LOCK_ADDRESS, value: "1" },
      { kind: "text", address: LOCK_ADDRESS, value: "locked" },
      { kind: "numeric", address: LOCK_ADDRESS, value: "0" },
    ]);
    await subscription.release();
    peer.notify("<id-a>", LOCK, 1);
    await barrier();
    expect(delivered).toHaveLength(3);
    operation.finish();
    expect(newRequests()).toEqual([`<id-a> post ${LOCK}?operation=regist`, `<id-a> get ${BARRIER}`, `<id-a> post ${LOCK}?operation=unregist`, `<id-a> get ${BARRIER}`]);
  });

  it("latch urx-device's Console Lock guard on a lock notification", async () => {
    const { transport, operations, peer, barrier, newRequests } = await connected();
    const context = new operations.OperationContext(transport, "URX44");
    const guard = await operations.ConsoleLockGuard.open(context);
    const detach = await guard.begin(context);
    expect(guard.stop).toBeUndefined();
    peer.notify("<id-a>", LOCK, 1);
    await barrier();
    expect(guard.stop).toBe("precondition_failed");
    detach();
    await guard.release();
    context.finish();
    expect(newRequests()).toEqual([`<id-a> post ${LOCK}?operation=regist`, `<id-a> get ${LOCK}`, `<id-a> get ${BARRIER}`, `<id-a> post ${LOCK}?operation=unregist`]);
  });

  it("deliver a notification that arrives before the registration reply", async () => {
    const { transport, peer, newRequests } = await connected({ holdRegistrations: true });
    const delivered: TransportNotification[] = [];
    const operation = transport.createOperation();
    const subscription = transport.prepareSubscription([LOCK_ADDRESS], operation, (notification) => delivered.push(notification));
    let active = false;
    const activation = subscription.activate().then(() => (active = true));
    await vi.waitFor(() => expect(newRequests()).toEqual([`<id-a> post ${LOCK}?operation=regist`]));
    peer.notify("<id-a>", LOCK, 1);
    await vi.waitFor(() => expect(delivered).toEqual([{ kind: "numeric", address: LOCK_ADDRESS, value: "1" }]));
    expect(active).toBe(false);
    peer.answerHeld();
    await activation;
    const release = subscription.release();
    await vi.waitFor(() => expect(newRequests()).toHaveLength(2));
    peer.answerHeld();
    await release;
    operation.finish();
  });

  it("clean up what a rejected registration's attempt registered, and reject with the device's verdict", async () => {
    const second = "/vd/parameters/896:0:0";
    const { transport, newRequests } = await connected({ registrationResponses: { [`${second}?operation=regist`]: 403 } });
    const operation = transport.createOperation();
    const subscription = transport.prepareSubscription([LOCK_ADDRESS, { paramId: 896, x: "0", y: "0" }, { paramId: 897, x: "0", y: "0" }], operation, () => {});
    expect(await failureOf(subscription.activate())).toEqual({
      code: "device_rejected",
      phase: "response",
      progress: { cleanup: { state: "complete", failure: null } },
    });
    // The third address is never sent; nothing registered is left to release.
    await subscription.release();
    operation.finish();
    expect(newRequests()).toEqual([`<id-a> post ${LOCK}?operation=regist`, `<id-a> post ${second}?operation=regist`, `<id-a> post ${LOCK}?operation=unregist`]);
  });

  it("release a subscription never activated without traffic", async () => {
    const { transport, newRequests } = await connected();
    const operation = transport.createOperation();
    const subscription = transport.prepareSubscription([LOCK_ADDRESS], operation, () => {});
    await subscription.release();
    operation.finish();
    expect(newRequests()).toEqual([]);
  });

  it("hand one notification to two subscribers of one address, and unregister it once the last releases", async () => {
    const { transport, peer, barrier, newRequests } = await connected();
    const first: TransportNotification[] = [];
    const second: TransportNotification[] = [];
    const operation = transport.createOperation();
    const a = transport.prepareSubscription([LOCK_ADDRESS], operation, (notification) => first.push(notification));
    const b = transport.prepareSubscription([LOCK_ADDRESS], operation, (notification) => second.push(notification));
    await a.activate();
    await b.activate();
    peer.notify("<id-a>", LOCK, 1);
    await barrier();
    expect([first, second]).toEqual([[{ kind: "numeric", address: LOCK_ADDRESS, value: "1" }], [{ kind: "numeric", address: LOCK_ADDRESS, value: "1" }]]);
    await a.release();
    peer.notify("<id-a>", LOCK, 0);
    await barrier();
    expect([first.length, second.length]).toEqual([1, 2]);
    await b.release();
    operation.finish();
    expect(newRequests()).toEqual([
      `<id-a> post ${LOCK}?operation=regist`,
      `<id-a> get ${BARRIER}`,
      `<id-a> get ${BARRIER}`,
      `<id-a> post ${LOCK}?operation=unregist`,
    ]);
  });

  it("refuse an admission over the token limit with precondition_failed, sending nothing", async () => {
    const { transport, newRequests } = await connected();
    const operation = transport.createOperation();
    const admitted = Array.from({ length: 32 }, () => transport.prepareSubscription([LOCK_ADDRESS], operation, () => {}));
    let thrown: unknown;
    try {
      transport.prepareSubscription([LOCK_ADDRESS], operation, () => {});
    } catch (error) {
      thrown = error;
    }
    const { operationFailureOf } = await import("@urx/device-control/operations");
    expect(operationFailureOf(thrown)).toEqual({ code: "precondition_failed", phase: "admission", progress: { cleanup: { state: "complete", failure: null } } });
    await Promise.all(admitted.map((subscription) => subscription.release()));
    operation.finish();
    expect(newRequests()).toEqual([]);
  });

  it("unregister an active subscription when the connection closes", async () => {
    const { transport, closeNow, newRequests } = await connected();
    const operation = transport.createOperation();
    await transport.prepareSubscription([LOCK_ADDRESS], operation, () => {}).activate();
    expect(await closeNow()).toEqual({ kind: "success", value: null });
    expect(newRequests()).toEqual([`<id-a> post ${LOCK}?operation=regist`, `<id-a> post ${LOCK}?operation=unregist`]);
  });

  it("end the connection when a consumer throws, so later requests are refused", async () => {
    const { transport, peer, newRequests } = await connected();
    const operation = transport.createOperation();
    const subscription = transport.prepareSubscription([LOCK_ADDRESS], operation, () => {
      throw new Error("consumer");
    });
    await subscription.activate();
    peer.notify("<id-a>", LOCK, 1);
    // The close the router starts refuses new work, then unregisters the lock.
    await vi.waitFor(() => expect(newRequests()).toEqual([`<id-a> post ${LOCK}?operation=regist`, `<id-a> post ${LOCK}?operation=unregist`]));
    expect(await transport.getNumeric({ paramId: 140, x: "0", y: "0" }, { operation, requestTicket: transport.newRequestTicket() })).toMatchObject({
      failure: { code: "not_connected" },
      evidence: { state: "not_sent" },
    });
    expect(newRequests()).toHaveLength(2);
  });
});

describe("the addon's notification records (K37)", () => {
  it("route meter readings and namespace changes by token, with the PC receipt time", async () => {
    const { connection, notifications, peer, barrier, newRequests } = await connected();
    const native = connection.createOperation();
    const meter = connection.prepareSubscription([{ family: "meter", meterId: 7, x: "-1" }]) as { kind: string; value: { token: string; activate(operation: unknown): Promise<unknown>; release(): Promise<unknown> } };
    const parameter = connection.prepareSubscription([{ family: "parameter", paramId: 895, x: "0", y: "0" }]) as typeof meter;
    expect([meter.kind, parameter.kind]).toEqual(["success", "success"]);
    const received: [string, unknown, string][] = [];
    for (const [name, subscription] of [["meter", meter.value], ["parameter", parameter.value]] as const) {
      notifications.route(subscription.token, (routed) => received.push([name, routed.notification, routed.receivedAtMs])).start();
      expect(await subscription.activate(native)).toEqual({ kind: "success", value: null });
    }
    const before = Date.now();
    peer.notify("<id-a>", "/vd/meters/7:-1", -120);
    peer.notify("<id-a>", "/vd/parameters");
    await barrier();
    const after = Date.now();
    expect(received.map(([name, notification]) => [name, notification])).toEqual([
      ["meter", { kind: "meter", meterId: 7, x: "-1", value: "-120" }],
      ["parameter", { kind: "bulk-change" }],
    ]);
    for (const [, , at] of received) {
      expect(Number(at)).toBeGreaterThanOrEqual(before);
      expect(Number(at)).toBeLessThanOrEqual(after);
    }
    for (const subscription of [meter.value, parameter.value]) expect(await subscription.release()).toEqual({ kind: "success", value: null });
    native.finish();
    expect(newRequests()).toEqual([
      "<id-a> post /vd/meters/7:-1?operation=regist",
      `<id-a> post ${LOCK}?operation=regist`,
      `<id-a> get ${BARRIER}`,
      "<id-a> post /vd/meters/7:-1?operation=unregist",
      `<id-a> post ${LOCK}?operation=unregist`,
    ]);
  });

  it("refuse an acknowledgment of a batch the connection never delivered", async () => {
    const { connection } = await connected();
    expect(connection.adoptNotifications("batch-1")).toBe(false);
    expect(connection.adoptNotifications("")).toBe(false);
  });
});
