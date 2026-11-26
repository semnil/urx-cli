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
  /** Parameter values by `paramId:x:y`; a write replaces the value it accepts. */
  readonly parameters?: Record<string, number | string>;
  /** The response code every write is answered with; 200 when omitted. */
  readonly writeResponse?: number;
  /** Parameter URIs (`/vd/parameters/...`) the unit never answers. */
  readonly silent?: readonly string[];
}

export interface PeerOptions {
  /** Answer the list request with a reply that has no `list`. */
  readonly malformedList?: boolean;
  /** Tests of the peer itself: make the server at this index (units first, then the list port) fail to listen. */
  readonly failListenAt?: number;
  /** Tests of the peer itself: called with each port that started listening. */
  readonly onListen?: (port: number) => void;
}

export interface Peer {
  readonly listPort: number;
  /**
   * Every line the peer received, in order, recorded before it decides
   * whether to answer: `<port> <method> <uri>`, where `<port>` is `list` or a
   * unit's ID and an unparsable line is `<port> unreadable`.
   */
  readonly requests: readonly string[];
  /** Sockets the peer accepted that are still open. */
  readonly openSockets: () => number;
  close(): Promise<void>;
}

const line = (message: unknown) => `${JSON.stringify(message)}\n`;

/** `<method> <uri>` of a request under `envelope`, or `unreadable`. */
function describe(message: unknown, envelope: "vdp" | "vddp"): string {
  const body = (message as Record<string, unknown> | null)?.[envelope] as { method?: unknown; uri?: unknown } | undefined;
  return typeof body?.method === "string" && typeof body.uri === "string" ? `${body.method} ${body.uri}` : "unreadable";
}

function serveLines(onLine: (socket: Socket, message: Record<string, unknown> | null) => void, sockets: Set<Socket>): Server {
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
        let message: Record<string, unknown> | null = null;
        try {
          message = JSON.parse(text) as Record<string, unknown>;
        } catch {
          // Not JSON: recorded as unreadable and not answered.
        }
        onLine(socket, message);
      }
    });
  });
}

/** A documentation address (RFC 5737) no local interface has, so listening on it fails. */
const UNASSIGNED = "192.0.2.1";

/** Listens on a free port of `host`; a failure to listen rejects with the original error. */
const listen = (server: Server, host = "127.0.0.1") =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => {
      server.off("error", reject);
      resolve((server.address() as { port: number }).port);
    });
  });

async function closeAll(servers: readonly Server[], sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => (server.listening ? server.close(() => resolve()) : resolve()))));
}

/**
 * Starts the list port and one port per unit. When any of them cannot listen,
 * everything this call opened is closed and the original error is thrown.
 */
export async function startPeer(units: readonly PeerUnit[], options: PeerOptions = {}): Promise<Peer> {
  const requests: string[] = [];
  const sockets = new Set<Socket>();
  const servers: Server[] = [];
  const ports: number[] = [];
  const opened = async (server: Server) => {
    const host = servers.length === options.failListenAt ? UNASSIGNED : undefined;
    servers.push(server);
    const port = await listen(server, host);
    options.onListen?.(port);
    return port;
  };
  try {
    for (const unit of units) ports.push(await opened(unitServer(unit, requests, sockets)));
    const listPort = await opened(listServer(units, ports, requests, sockets, options));
    return { listPort, requests, openSockets: () => sockets.size, close: () => closeAll(servers, sockets) };
  } catch (error) {
    await closeAll(servers, sockets);
    throw error;
  }
}

const PARAMETERS = "/vd/parameters/";

function unitServer(unit: PeerUnit, requests: string[], sockets: Set<Socket>): Server {
  let synchronizations = 0;
  const parameters = new Map(Object.entries(unit.parameters ?? {}));
  return serveLines((socket, message) => {
    requests.push(`${unit.id} ${describe(message, "vdp")}`);
    const vdp = message?.["vdp"] as { method?: string; uri?: string; data?: { current_value?: unknown } } | undefined;
    if (typeof vdp?.uri === "string" && vdp.uri.startsWith(PARAMETERS)) {
      const [path] = vdp.uri.split("?") as [string];
      if (unit.silent?.includes(path)) return;
      const key = path.slice(PARAMETERS.length);
      if (vdp.method === "get" && parameters.has(key)) {
        socket.write(line({ vdp: { method: "get", uri: vdp.uri, data: { current_value: parameters.get(key) } } }));
      } else if (vdp.method === "post") {
        const code = unit.writeResponse ?? 200;
        if (code === 200) parameters.set(key, vdp.data?.current_value as number | string);
        socket.write(line({ vdp: { method: "post", uri: vdp.uri, data: { response_code: code } } }));
      }
      return;
    }
    if (vdp?.method !== "get") return;
    if (vdp.uri === "/vd/synchronize") {
      synchronizations += 1;
      const id = synchronizations > 1 && unit.laterId !== undefined ? unit.laterId : unit.id;
      socket.write(line({ vdp: { method: "get", uri: vdp.uri, data: { sync_status: unit.status ?? "online", usb_id: id } } }));
    } else if (vdp.uri === "/vd/device") {
      const firmList = unit.firmware === null ? [{ firm_name: "Boot", firm_version: "1.0" }] : [{ firm_name: "System", firm_version: unit.firmware ?? "1.5.0.1" }];
      socket.write(line({ vdp: { method: "get", uri: vdp.uri, data: { firm_list: firmList } } }));
    }
  }, sockets);
}

function listServer(units: readonly PeerUnit[], ports: readonly number[], requests: string[], sockets: Set<Socket>, options: PeerOptions): Server {
  return serveLines((socket, message) => {
    requests.push(`list ${describe(message, "vddp")}`);
    const vddp = message?.["vddp"] as { method?: string; uri?: string } | undefined;
    if (vddp?.method !== "get" || vddp.uri !== "/vddp_srv/devices") return;
    const data = options.malformedList === true ? {} : { list: units.map((unit, index) => ({ vdpport: ports[index], model: unit.model })) };
    socket.write(line({ vddp: { method: "get", uri: vddp.uri, data } }));
  }, sockets);
}
