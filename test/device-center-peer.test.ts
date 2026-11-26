import { connect } from "node:net";
import { describe, expect, it } from "vitest";
import { startPeer } from "./device-center-peer.js";

/** Whether something accepts a connection on `port` now. */
const accepting = (port: number) =>
  new Promise<boolean>((resolve) => {
    const socket = connect(port, "127.0.0.1");
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });

describe("the controlled peer", () => {
  it("record every line it receives, answered or not", async () => {
    const peer = await startPeer([{ id: "<id-a>", model: "URX44" }]);
    try {
      const socket = connect(peer.listPort, "127.0.0.1");
      await new Promise((resolve) => socket.once("connect", resolve));
      socket.write('{"vddp":{"method":"post","uri":"/other"}}\nnot json\n{"vddp":{"method":"get","uri":"/vddp_srv/devices"}}\n');
      await new Promise((resolve) => socket.once("data", resolve));
      socket.destroy();
      expect(peer.requests).toEqual(["list post /other", "list unreadable", "list get /vddp_srv/devices"]);
    } finally {
      await peer.close();
    }
  });

  it("reject with the original error and close what it opened when a port cannot listen", async () => {
    for (const failListenAt of [0, 1, 2]) {
      const listened: number[] = [];
      const units = [
        { id: "<id-a>", model: "URX44" },
        { id: "<id-b>", model: "URX22" },
      ];
      await expect(startPeer(units, { failListenAt, onListen: (port) => listened.push(port) })).rejects.toMatchObject({ syscall: "listen" });
      expect(listened).toHaveLength(failListenAt);
      for (const port of listened) expect(await accepting(port), `port ${port} after a failure at ${failListenAt}`).toBe(false);
    }
  });
});
