// `urx device list` through the built CLI, the addon and the production Rust
// transport, against a controlled local peer (K30). Needs `pnpm build` and
// `pnpm build:native`.

import { afterEach, describe, expect, it } from "vitest";
import { startPeer, type Peer } from "./device-center-peer.js";

const dist = new URL("../dist/", import.meta.url);

let peer: Peer | undefined;
afterEach(async () => {
  await peer?.close();
  peer = undefined;
});

/** Runs the built `main` with `args` against Device Center at `listPort`. */
async function urx(args: string[], listPort: number) {
  const { main } = (await import(new URL("main.js", dist).href)) as typeof import("../src/main.js");
  const { BUILD_INFO } = (await import(new URL("build-info.js", dist).href)) as typeof import("../src/build-info.js");
  const chunks = { stdout: [] as string[], stderr: [] as string[] };
  const stream = (name: "stdout" | "stderr") => ({ write: (chunk: string, done: (error?: Error | null) => void) => (chunks[name].push(chunk), done(null), true) });
  const exit = await main(args, {
    stdout: stream("stdout"),
    stderr: stream("stderr"),
    build: BUILD_INFO,
    runtime: { version: process.versions.node, platform: process.platform, arch: process.arch },
    device: { interrupts: { subscribe: () => () => {} }, now: () => performance.now(), listPort },
  });
  return { exit, stdout: chunks.stdout.join(""), stderr: chunks.stderr.join("") };
}

describe("urx device list through the addon", () => {
  it("list every online unit with its System firmware, sorted by ID, reading each unit's identity and firmware", async () => {
    peer = await startPeer([
      { id: "<id-b>", model: "URX44", firmware: "1.5.0.1" },
      { id: "<id-a>", model: "URX22", firmware: null },
    ]);
    const result = await urx(["device", "list", "--json"], peer.listPort);
    expect(result.exit).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      command: "device list",
      data: {
        mode: "execute",
        device: null,
        target: null,
        devices: [
          { id: "<id-a>", model: "URX22", firmware: null },
          { id: "<id-b>", model: "URX44", firmware: "1.5.0.1" },
        ],
      },
      error: null,
    });
    expect([...peer.requests].sort()).toEqual(
      ["list get /vddp_srv/devices", "<id-a> get /vd/synchronize", "<id-a> get /vd/device", "<id-b> get /vd/synchronize", "<id-b> get /vd/device"].sort(),
    );
    const human = await urx(["device", "list"], peer.listPort);
    expect(human.stdout).toBe("ID      MODEL  FIRMWARE\n<id-a>  URX22  -\n<id-b>  URX44  1.5.0.1\n");
  });

  it("list nothing when a unit is not online or Device Center's list cannot be read", async () => {
    peer = await startPeer([{ id: "<id-a>", model: "URX44", status: "offline" }]);
    expect((await urx(["device", "list"], peer.listPort)).stdout).toBe("No online devices.\n");
    await peer.close();
    peer = await startPeer([{ id: "<id-a>", model: "URX44" }], { malformedList: true });
    const malformed = await urx(["device", "list", "--json"], peer.listPort);
    expect(malformed.exit).toBe(1);
    expect(JSON.parse(malformed.stdout).error.code).toBe("invalid_response");
  });

  it("report Device Center not listening as connection_failed and exit 3", async () => {
    peer = await startPeer([]);
    const { listPort } = peer;
    await peer.close();
    peer = undefined;
    const result = await urx(["device", "list"], listPort);
    expect(result.exit).toBe(3);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("urx: A connection could not be opened during discovery.\n");
  });
});
