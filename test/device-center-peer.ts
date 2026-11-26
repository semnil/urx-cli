// A controlled local peer for the addon's integration tests (K30): a Device
// Center list port and one port per unit, answering the transport's requests
// with newline-delimited JSON. It supplies protocol replies and deliberate
// faults, not a model of a unit.

import { createServer, type Server, type Socket } from "node:net";

export interface PeerUnit {
  readonly id: string;
  readonly model: string;
  /** The `sync_status` the unit reports; `online` when omitted. */
  readonly status?: string;
  /** The System firmware version, or null for a `firm_list` without one. */
  readonly firmware?: string | null;
  /** The identity reported after the first `/vd/synchronize` (the discovery's). */
  readonly laterId?: string;
}

export interface PeerOptions {
  /** Answer the list request with a reply that has no `list`. */
  readonly malformedList?: boolean;
}

export interface Peer {
  readonly listPort: number;
  /** Every request URI the peer received, in order, prefixed with the port's role. */
  readonly requests: readonly string[];
  /** Sockets the peer accepted that are still open. */
  readonly openSockets: () => number;
  close(): Promise<void>;
}

const line = (message: unknown) => `${JSON.stringify(message)}\n`;

function serveLines(onLine: (socket: Socket, message: Record<string, unknown>) => void, sockets: Set<Socket>): Server {
  return createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          onLine(socket, JSON.parse(text) as Record<string, unknown>);
        } catch {
          // Not JSON: ignored, as a peer that does not understand it would.
        }
      }
    });
  });
}

const listen = (server: Server) =>
  new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

export async function startPeer(units: readonly PeerUnit[], options: PeerOptions = {}): Promise<Peer> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const ports: number[] = [];
  for (const unit of units) {
    let synchronizations = 0;
    const server = serveLines((socket, message) => {
      const vdp = message["vdp"] as { method?: string; uri?: string } | undefined;
      if (vdp?.method !== "get") return;
      requests.push(`${unit.id} ${vdp.uri}`);
      if (vdp.uri === "/vd/synchronize") {
        synchronizations += 1;
        const id = synchronizations > 1 && unit.laterId !== undefined ? unit.laterId : unit.id;
        socket.write(line({ vdp: { method: "get", uri: vdp.uri, data: { sync_status: unit.status ?? "online", usb_id: id } } }));
      } else if (vdp.uri === "/vd/device") {
        const firmList = unit.firmware === null ? [{ firm_name: "Boot", firm_version: "1.0" }] : [{ firm_name: "System", firm_version: unit.firmware ?? "1.5.0.1" }];
        socket.write(line({ vdp: { method: "get", uri: vdp.uri, data: { firm_list: firmList } } }));
      }
    }, sockets);
    servers.push(server);
    ports.push(await listen(server));
  }
  const list = serveLines((socket, message) => {
    const vddp = message["vddp"] as { method?: string; uri?: string } | undefined;
    if (vddp?.method !== "get" || vddp.uri !== "/vddp_srv/devices") return;
    requests.push(`list ${vddp.uri}`);
    const data = options.malformedList === true ? {} : { list: units.map((unit, index) => ({ vdpport: ports[index], model: unit.model })) };
    socket.write(line({ vddp: { method: "get", uri: vddp.uri, data } }));
  }, sockets);
  servers.push(list);
  const listPort = await listen(list);
  return {
    listPort,
    requests,
    openSockets: () => sockets.size,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
    },
  };
}
