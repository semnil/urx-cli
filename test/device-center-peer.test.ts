import { connect, type Socket } from "node:net";
import { describe, expect, it, vi } from "vitest";
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

  it("answer registrations with their configured code, hold them on request, and push notifications to one unit's connections", async () => {
    const uri = "/vd/meters/7:-1?operation=regist";
    const peer = await startPeer([
      { id: "<id-a>", model: "URX44", registrationResponses: { [uri]: 403 } },
      { id: "<id-b>", model: "URX44", holdRegistrations: true },
    ]);
    const opened: Socket[] = [];
    try {
      const lines = (socket: Socket) => {
        const received: unknown[] = [];
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            received.push(JSON.parse(buffer.slice(0, end)));
            buffer = buffer.slice(end + 1);
          }
        });
        return received;
      };
      const connected = (port: number) =>
        new Promise<Socket>((resolve) => {
          const socket = connect(port, "127.0.0.1", () => resolve(socket));
          opened.push(socket);
        });
      const list = await connected(peer.listPort);
      const listed = lines(list);
      list.write('{"vddp":{"method":"get","uri":"/vddp_srv/devices"}}\n');
      await vi.waitFor(() => expect(listed).toHaveLength(1));
      const ports = (listed[0] as { vddp: { data: { list: { vdpport: number }[] } } }).vddp.data.list.map((entry) => entry.vdpport);
      const a = await connected(ports[0] as number);
      const b = await connected(ports[1] as number);
      const fromA = lines(a);
      const fromB = lines(b);
      a.write(`{"vdp":{"method":"post","uri":"${uri}"}}\n{"vdp":{"method":"post","uri":"/vd/meters/8:0?operation=unregist"}}\n`);
      b.write(`{"vdp":{"method":"post","uri":"${uri}"}}\n`);
      await vi.waitFor(() => expect(fromA).toHaveLength(2));
      expect(fromA).toEqual([
        { vdp: { method: "post", uri, data: { response_code: 403 } } },
        { vdp: { method: "post", uri: "/vd/meters/8:0?operation=unregist", data: { response_code: 200 } } },
      ]);
      await vi.waitFor(() => expect(peer.requests).toContain(`<id-b> post ${uri}`));
      peer.notify("<id-a>", "/vd/parameters/895:0:0", 1);
      peer.notify("<id-a>", "/vd/parameters");
      await vi.waitFor(() => expect(fromA).toHaveLength(4));
      expect(fromA.slice(2)).toEqual([
        { vdp: { method: "notify", uri: "/vd/parameters/895:0:0", data: { current_value: 1 } } },
        { vdp: { method: "notify", uri: "/vd/parameters", data: {} } },
      ]);
      expect(fromB).toEqual([]);
      peer.answerHeld();
      await vi.waitFor(() => expect(fromB).toEqual([{ vdp: { method: "post", uri, data: { response_code: 200 } } }]));
    } finally {
      for (const socket of opened) socket.destroy();
      await peer.close();
    }
  });

  it("answer a parameter read with its configured code in place of the value, and hold it on request", async () => {
    const lock = "/vd/parameters/895:0:0";
    const fader = "/vd/parameters/139:0:0";
    const peer = await startPeer([{ id: "<id-a>", model: "URX44", parameters: { "895:0:0": 0, "139:0:0": -600 }, readResponses: { [lock]: 404 }, holdReads: [lock] }]);
    const opened: Socket[] = [];
    try {
      const connected = (port: number) =>
        new Promise<Socket>((resolve) => {
          const socket = connect(port, "127.0.0.1", () => resolve(socket));
          opened.push(socket);
        });
      const received: unknown[] = [];
      const collect = (socket: Socket) => {
        let buffer = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          buffer += chunk;
          for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
            received.push(JSON.parse(buffer.slice(0, end)));
            buffer = buffer.slice(end + 1);
          }
        });
      };
      const list = await connected(peer.listPort);
      collect(list);
      list.write('{"vddp":{"method":"get","uri":"/vddp_srv/devices"}}\n');
      await vi.waitFor(() => expect(received).toHaveLength(1));
      const port = (received[0] as { vddp: { data: { list: { vdpport: number }[] } } }).vddp.data.list[0]?.vdpport as number;
      received.length = 0;
      const unit = await connected(port);
      collect(unit);
      unit.write(`{"vdp":{"method":"get","uri":"${lock}"}}\n{"vdp":{"method":"get","uri":"${fader}"}}\n`);
      // The read it holds waits; another is answered with its value.
      await vi.waitFor(() => expect(received).toEqual([{ vdp: { method: "get", uri: fader, data: { current_value: -600 } } }]));
      peer.answerHeld();
      await vi.waitFor(() => expect(received).toHaveLength(2));
      expect(received[1]).toEqual({ vdp: { method: "get", uri: lock, data: { response_code: 404 } } });
    } finally {
      for (const socket of opened) socket.destroy();
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
