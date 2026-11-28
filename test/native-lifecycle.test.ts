// Discovery and the connection lifecycle through the built addon and the
// production transport, against a controlled local peer (K30). Needs
// `pnpm build` and `pnpm build:native`.

import { afterEach, describe, expect, it } from "vitest";
import { startPeer, type Peer, type PeerUnit } from "./device-center-peer.js";

const dist = new URL("../dist/", import.meta.url);

async function modules() {
  const addonModule = (await import(new URL("native/addon.js", dist).href)) as typeof import("../src/native/addon.js");
  const device = (await import(new URL("native/device.js", dist).href)) as typeof import("../src/native/device.js");
  const build = (await import(new URL("build-info.js", dist).href)) as typeof import("../src/build-info.js");
  const opened = addonModule.openAddon(addonModule.expectedIdentity(build.BUILD_INFO));
  if (!opened.ok) throw new Error(`the built addon was refused: ${opened.problem}`);
  return { addon: opened.addon, device };
}

let peer: Peer | undefined;
afterEach(async () => {
  await peer?.close();
  peer = undefined;
});

const units = (...list: PeerUnit[]) => list;

describe("discovery through the addon", () => {
  it("list the online units in Device Center's order, skipping units that are not online", async () => {
    const { addon, device } = await modules();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44" }, { id: "<id-b>", model: "URX22", status: "offline" }, { id: "<id-c>", model: "URX44V" }));
    const outcome = await device.discoverDevices(addon, new addon.Control(), false, peer.listPort);
    expect(outcome).toEqual({
      kind: "success",
      value: [
        { id: "<id-a>", model: "URX44" },
        { id: "<id-c>", model: "URX44V" },
      ],
    });
    // The list, then each listed unit's synchronize; no firmware read without metadata.
    expect(peer.requests).toEqual(["list get /vddp_srv/devices", "<id-a> get /vd/synchronize", "<id-b> get /vd/synchronize", "<id-c> get /vd/synchronize"]);
  });

  it("read each online unit's System firmware, or null, only with metadata", async () => {
    const { addon, device } = await modules();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44", firmware: "1.5.0.1" }, { id: "<id-b>", model: "URX22", firmware: null }));
    expect(await device.discoverDevices(addon, new addon.Control(), true, peer.listPort)).toEqual({
      kind: "success",
      value: [
        { id: "<id-a>", model: "URX44", firmware: "1.5.0.1" },
        { id: "<id-b>", model: "URX22", firmware: null },
      ],
    });
    expect(peer.requests).toEqual([
      "list get /vddp_srv/devices",
      "<id-a> get /vd/synchronize",
      "<id-a> get /vd/device",
      "<id-b> get /vd/synchronize",
      "<id-b> get /vd/device",
    ]);
  });

  it("complete with no unit, fail on a malformed list, and fail when Device Center is not there", async () => {
    const { addon, device } = await modules();
    peer = await startPeer([]);
    expect(await device.discoverDevices(addon, new addon.Control(), false, peer.listPort)).toEqual({ kind: "success", value: [] });
    expect(peer.requests).toEqual(["list get /vddp_srv/devices"]);
    await peer.close();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44" }), { malformedList: true });
    expect(await device.discoverDevices(addon, new addon.Control(), false, peer.listPort)).toMatchObject({
      kind: "failure",
      failure: { kind: "cause", code: "invalid_response", phase: "discovery", request: null },
      cleanup: { state: "complete", failure: null },
    });
    expect(peer.requests).toEqual(["list get /vddp_srv/devices"]);
    const closedPort = peer.listPort;
    await peer.close();
    peer = undefined;
    expect(await device.discoverDevices(addon, new addon.Control(), false, closedPort)).toMatchObject({
      kind: "failure",
      failure: { kind: "cause", code: "connection_failed", phase: "discovery", request: null },
    });
  });

  it("stop as cancelled when its control is cancelled first", async () => {
    const { addon, device } = await modules();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44" }));
    const control = new addon.Control();
    control.cancel();
    expect(await device.discoverDevices(addon, control, false, peer.listPort)).toEqual({
      kind: "failure",
      failure: { kind: "cancelled", phase: "discovery" },
      cleanup: { state: "complete", failure: null },
    });
    expect(peer.requests).toEqual([]);
  });
});

describe("the connection lifecycle through the addon", () => {
  it("open a discovered unit, verify its identity and firmware, and close it once for repeated calls", async () => {
    const { addon, device } = await modules();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44", firmware: "1.5.0.1" }));
    const control = new addon.Control();
    expect((await device.discoverDevices(addon, control, false, peer.listPort)).kind).toBe("success");
    const discovered = peer.requests.length;
    const opened = await device.openDevice(addon, control, "<id-a>");
    if (opened.kind !== "success") throw new Error(JSON.stringify(opened));
    expect(opened.value.connection.firmware).toBe("1.5.0.1");
    expect(peer.requests.slice(discovered)).toEqual(["<id-a> get /vd/synchronize", "<id-a> get /vd/device"]);
    const beforeClose = peer.requests.length;
    const [first, second] = await Promise.all([device.closeConnection(opened.value.connection), device.closeConnection(opened.value.connection)]);
    expect(first).toEqual({ kind: "success", value: null });
    expect(second).toEqual({ kind: "success", value: null });
    expect(await device.closeConnection(opened.value.connection)).toEqual({ kind: "success", value: null });
    // With nothing subscribed, closing sends nothing.
    expect(peer.requests.slice(beforeClose)).toEqual([]);
  });

  it("refuse a connection whose firm_list the version cannot be read from, closing it (D15-B, R1-F-A)", async () => {
    const { addon, device } = await modules();
    // An empty or missing System version, an entry without a name, no list, and System versions that disagree.
    const unreadable: unknown[] = [
      [{ firm_name: "System", firm_version: "" }],
      [{ firm_name: "System" }],
      [{ firm_name: "", firm_version: "1.0" }],
      "not a list",
      [
        { firm_name: "System", firm_version: "1.5.0.1" },
        { firm_name: "System", firm_version: "1.5.0.2" },
      ],
    ];
    for (const firmList of unreadable) {
      peer = await startPeer(units({ id: "<id-a>", model: "URX44", firmList }));
      const control = new addon.Control();
      expect((await device.discoverDevices(addon, control, false, peer.listPort)).kind).toBe("success");
      expect(await device.openDevice(addon, control, "<id-a>"), JSON.stringify(firmList)).toEqual({
        kind: "failure",
        failure: { kind: "cause", code: "invalid_response", phase: "connect", request: null },
        // The connection that was opened is closed again before the refusal.
        cleanup: { state: "connection_closed", failure: null },
      });
      await peer.close();
      peer = undefined;
    }
  });

  it("refuse a unit its control did not discover, without connecting", async () => {
    const { addon, device } = await modules();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44" }));
    expect(await device.openDevice(addon, new addon.Control(), "<id-a>")).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "device_not_found", phase: "connect", request: null },
      cleanup: { state: "complete", failure: null },
    });
    expect(peer.requests).toEqual([]);
    const control = new addon.Control();
    await device.discoverDevices(addon, control, false, peer.listPort);
    const discovered = peer.requests.length;
    expect(await device.openDevice(addon, control, "<id-other>")).toMatchObject({ failure: { code: "device_not_found", phase: "connect" } });
    expect(peer.requests.slice(discovered)).toEqual([]);
  });

  it("refuse a unit that answers with another identity on the operational connection", async () => {
    const { addon, device } = await modules();
    peer = await startPeer(units({ id: "<id-a>", model: "URX44", laterId: "<id-b>" }));
    const control = new addon.Control();
    expect((await device.discoverDevices(addon, control, false, peer.listPort)).kind).toBe("success");
    const discovered = peer.requests.length;
    expect(await device.openDevice(addon, control, "<id-a>")).toEqual({
      kind: "failure",
      failure: { kind: "cause", code: "device_not_found", phase: "identity", request: null },
      cleanup: { state: "complete", failure: null },
    });
    // The firmware is not read from a unit whose identity did not match.
    expect(peer.requests.slice(discovered)).toEqual(["<id-a> get /vd/synchronize"]);
  });
});
