// One-shot `get` and `set` of the basic channel controls through the built
// CLI, the addon and the production Rust transport, against a controlled
// local peer (K30). Each case compares the requests the command sent. Needs
// `pnpm build` and `pnpm build:native`.

import { afterEach, describe, expect, it, vi } from "vitest";
import { startPeer, type Peer, type PeerUnit } from "./device-center-peer.js";

const dist = new URL("../dist/", import.meta.url);

let peer: Peer | undefined;
afterEach(async () => {
  await peer?.close();
  peer = undefined;
});

/** Ctrl+C a test sends itself, counted like SIGINT. */
function interrupts() {
  const handlers = new Set<(count: number) => void>();
  let count = 0;
  return {
    value: { subscribe: (handler: (count: number) => void) => (handlers.add(handler), () => handlers.delete(handler)) },
    send: () => {
      count += 1;
      for (const handler of [...handlers]) handler(count);
    },
  };
}

interface Options {
  readonly stderrFailure?: (chunk: string) => Error | null;
  readonly interrupts?: ReturnType<typeof interrupts>;
}

/** Runs the built `main` with `args` against Device Center at `listPort`. */
async function urx(args: string[], listPort: number, options: Options = {}) {
  const { main } = (await import(new URL("main.js", dist).href)) as typeof import("../src/main.js");
  const { BUILD_INFO } = (await import(new URL("build-info.js", dist).href)) as typeof import("../src/build-info.js");
  const chunks = { stdout: [] as string[], stderr: [] as string[] };
  const stream = (name: "stdout" | "stderr") => ({
    write: (chunk: string, done: (error?: Error | null) => void) => {
      const error = name === "stderr" ? (options.stderrFailure?.(chunk) ?? null) : null;
      if (error === null) chunks[name].push(chunk);
      done(error);
      return error === null;
    },
  });
  const exit = await main(args, {
    stdout: stream("stdout"),
    stderr: stream("stderr"),
    build: BUILD_INFO,
    runtime: { version: process.versions.node, platform: process.platform, arch: process.arch },
    device: { interrupts: options.interrupts?.value ?? { subscribe: () => () => {} }, now: () => performance.now(), listPort },
  });
  return { exit, stdout: chunks.stdout.join(""), stderr: chunks.stderr.join("") };
}

const UNIT = { id: "<id-a>", model: "URX44", firmware: "1.5.0.1" };
/** The requests every command sends to reach the unit: the discovery's and the opening's. */
const CONNECT = ["list get /vddp_srv/devices", "<id-a> get /vd/synchronize", "<id-a> get /vd/synchronize", "<id-a> get /vd/device"];
const LOCK = "/vd/parameters/895:0:0";
/** The Console Lock guard around a write: its registration and one fresh read, then the release (F20-L-A). */
const guarded = (write: string) => [`<id-a> post ${LOCK}?operation=regist`, `<id-a> get ${LOCK}`, write, `<id-a> post ${LOCK}?operation=unregist`];

async function unit(settings: Partial<PeerUnit> = {}) {
  peer = await startPeer([{ ...UNIT, ...settings, parameters: { "895:0:0": 0, ...settings.parameters } }]);
  return peer;
}

const WARNING = "urx: Firmware compatibility has not been verified.\n";

describe("get of a basic channel control", () => {
  it("read the value with one GET and show it with its observation time", async () => {
    const at = await unit({ parameters: { "139:0:0": -600, "140:0:0": 1, "141:0:0": -63, "24:0:0": 1 } });
    const fader = await urx(["channel", "fader", "get", "--channel", "1", "--json"], at.listPort);
    expect(fader.exit).toBe(0);
    expect(fader.stderr).toBe(WARNING);
    const record = JSON.parse(fader.stdout);
    expect(record).toMatchObject({
      type: "result",
      command: "channel fader get",
      data: { mode: "execute", device: { id: "<id-a>", model: "URX44" }, target: { channel: 1 }, reading: { value: -6, state: "finite", unit: "dB" } },
      error: null,
    });
    expect(record.data.reading.observed_at).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(at.requests).toEqual([...CONNECT, "<id-a> get /vd/parameters/139:0:0"]);
    const human = await urx(["channel", "on", "get", "--channel", "1"], at.listPort);
    expect(human.stdout).toMatch(/^channel 1: on \(observed \d{4}-.+Z\)\n$/);
    expect(JSON.parse((await urx(["channel", "pan", "get", "--channel", "1", "--json"], at.listPort)).stdout).data.reading).toMatchObject({ value: -63, state: "finite", unit: null });
    expect(JSON.parse((await urx(["channel", "polarity", "get", "--channel", "1", "--json"], at.listPort)).stdout).data.reading.value).toBe("inverted");
  });

  it("read negative infinity as its O6 state, and a stereo channel's side", async () => {
    const at = await unit({ parameters: { "266:0:0": -32768, "212:0:0": 0 } });
    expect(JSON.parse((await urx(["channel", "fader", "get", "--channel", "5", "--json"], at.listPort)).stdout).data.reading).toMatchObject({
      value: null,
      state: "negative_infinity",
      unit: "dB",
    });
    const right = JSON.parse((await urx(["channel", "polarity", "get", "--channel", "5", "--side", "right", "--json"], at.listPort)).stdout);
    expect(right.data).toMatchObject({ target: { channel: 5, side: "right" }, reading: { value: "normal" } });
    expect(at.requests.filter((line) => line.includes("/vd/parameters/"))).toEqual(["<id-a> get /vd/parameters/266:0:0", "<id-a> get /vd/parameters/212:0:0"]);
  });

  it("refuse a target the model lacks, or a side on a mono channel, without a parameter request", async () => {
    const at = await unit();
    for (const args of [
      ["channel", "fader", "get", "--channel", "6"],
      ["channel", "polarity", "get", "--channel", "1", "--side", "left"],
      ["channel", "polarity", "get", "--channel", "5"],
    ]) {
      const result = await urx([...args, "--json"], at.listPort);
      expect(result.exit, args.join(" ")).toBe(2);
      expect(JSON.parse(result.stdout).error.code).toBe("invalid_input");
    }
    expect(at.requests.filter((line) => line.includes("/vd/parameters/"))).toEqual([]);
  });
});

describe("set of a basic channel control", () => {
  it("write the planned value once under the Console Lock guard, and report acceptance", async () => {
    const at = await unit({ parameters: { "139:0:0": 0 } });
    const result = await urx(["channel", "fader", "set", "--channel", "1", "--value=-15.005", "--json"], at.listPort);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      command: "channel fader set",
      data: {
        mode: "execute",
        device: { id: "<id-a>", model: "URX44" },
        target: { channel: 1 },
        requested: { value: -15.005, state: "finite", unit: "dB" },
        planned: { value: -15.01, state: "finite", unit: "dB" },
        outcome: "accepted",
      },
      error: null,
    });
    expect(at.requests).toEqual([...CONNECT, ...guarded("<id-a> post /vd/parameters/139:0:0?operation=value")]);
    const human = await urx(["channel", "on", "set", "--channel", "1", "--value", "off"], at.listPort);
    expect(human.stdout).toBe("channel 1: off accepted\n");
  });

  it("show the requested value beside a rounded one, and write -inf as its raw value", async () => {
    const at = await unit();
    expect((await urx(["channel", "pan", "set", "--channel", "1", "--value=-0.5"], at.listPort)).stdout).toBe("channel 1: -1 accepted (requested -0.5)\n");
    expect((await urx(["channel", "fader", "set", "--channel", "5", "--value=-inf"], at.listPort)).exit).toBe(0);
  });

  it("preview a write under the same Console Lock guard, without sending it (W3, O13, F20-L-A)", async () => {
    const at = await unit();
    const result = await urx(["channel", "fader", "set", "--channel", "1", "--value", "3", "--dry-run", "--json"], at.listPort);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout).data).toMatchObject({ mode: "dry_run", planned: { value: 3 }, outcome: "not_sent", unverified: [] });
    expect(at.requests).toEqual([...CONNECT, `<id-a> post ${LOCK}?operation=regist`, `<id-a> get ${LOCK}`, `<id-a> post ${LOCK}?operation=unregist`]);
    expect((await urx(["channel", "fader", "set", "--channel", "1", "--value", "3", "--dry-run"], at.listPort)).stdout).toBe(
      "channel 1: would send 3 dB; nothing was sent (dry run)\n",
    );
  });

  it("refuse a value outside the range or not in its syntax, sending no write", async () => {
    const at = await unit();
    const syntax = await urx(["channel", "fader", "set", "--channel", "1", "--value", "1e3", "--json"], at.listPort);
    expect(syntax.exit).toBe(2);
    expect(JSON.parse(syntax.stdout)).toMatchObject({ data: { device: null, requested: null, outcome: "not_sent" }, error: { code: "invalid_input" } });
    // Nothing is discovered for a value that cannot be read.
    expect(at.requests).toEqual([]);
    const range = await urx(["channel", "fader", "set", "--channel", "1", "--value=-96.5", "--json"], at.listPort);
    expect(range.exit).toBe(2);
    expect(JSON.parse(range.stdout)).toMatchObject({ data: { requested: { value: -96.5 }, outcome: "not_sent" }, error: { code: "invalid_input" } });
    expect(at.requests.filter((line) => line.includes("/vd/parameters/"))).toEqual([]);
  });

  it("refuse a write, and its dry run, while the Console Lock is on, sending no setting write", async () => {
    const at = await unit({ parameters: { "895:0:0": 1 } });
    for (const dryRun of [[], ["--dry-run"]]) {
      const before = at.requests.length;
      const result = await urx(["channel", "on", "set", "--channel", "1", "--value", "on", ...dryRun, "--json"], at.listPort);
      expect(result.exit).toBe(1);
      expect(JSON.parse(result.stdout)).toMatchObject({ data: { planned: true, outcome: "not_sent" }, error: { code: "precondition_failed" } });
      expect(at.requests.slice(before + CONNECT.length)).toEqual([`<id-a> post ${LOCK}?operation=regist`, `<id-a> get ${LOCK}`, `<id-a> post ${LOCK}?operation=unregist`]);
    }
    const human = await urx(["channel", "on", "set", "--channel", "1", "--value", "on"], at.listPort);
    expect(human.stdout).toBe("channel 1: on not sent\n");
  });

  it("start no request once standard error has failed", async () => {
    const at = await unit();
    for (const args of [
      ["channel", "on", "get", "--channel", "1"],
      ["channel", "on", "set", "--channel", "1", "--value", "on"],
    ]) {
      const failing = (chunk: string) => (chunk.includes("execution started") ? new Error("EPIPE") : null);
      const before = at.requests.length;
      const result = await urx([...args, "--json", "--verbose"], at.listPort, { stderrFailure: failing });
      expect(result.exit).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("output_error");
      expect(at.requests.slice(before + CONNECT.length)).toEqual([]);
    }
  });

  it("report a Ctrl+C once, as the first stop, when the operation it cancels ends", async () => {
    const at = await unit({ holdRegistrations: true });
    const interrupt = interrupts();
    const pending = urx(["channel", "on", "set", "--channel", "1", "--value", "on", "--json"], at.listPort, { interrupts: interrupt });
    await vi.waitFor(() => expect(at.requests).toContain(`<id-a> post ${LOCK}?operation=regist`));
    interrupt.send();
    // The held registration reply, and any later held reply, are answered from here on.
    const timer = setInterval(() => at.answerHeld(), 10);
    const result = await pending;
    clearInterval(timer);
    expect(result.exit).toBe(130);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { outcome: "not_sent" }, error: { code: "interrupted" } });
    expect(result.stderr).not.toContain("also: interrupted");
    expect(at.requests.filter((line) => line.endsWith("operation=value"))).toEqual([]);
  });

  it("report a device rejection as rejected with exit 4", async () => {
    const at = await unit({ writeResponse: 403 });
    const result = await urx(["channel", "on", "set", "--channel", "1", "--value", "on", "--json"], at.listPort);
    expect(result.exit).toBe(4);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { outcome: "rejected" }, error: { code: "device_rejected" } });
    const human = await urx(["channel", "on", "set", "--channel", "1", "--value", "on"], at.listPort);
    expect(human.stdout).toBe("channel 1: on rejected by the device\n");
    expect(human.stderr).toMatch(/^urx: Firmware compatibility has not been verified\.\nurx: device_rejected: .+\.\n$/);
  });

  it("report an unanswered write as uncertain with exit 5", async () => {
    const at = await unit({ silent: ["/vd/parameters/140:0:0"] });
    const result = await urx(["channel", "on", "set", "--channel", "1", "--value", "on", "--json"], at.listPort);
    expect(result.exit).toBe(5);
    expect(JSON.parse(result.stdout)).toMatchObject({ data: { outcome: "uncertain" }, error: { code: "response_timeout" } });
  }, 15000);
});

describe("device selection for a setting command (D13)", () => {
  it("refuse to choose among several online units, and an ID that is not online", async () => {
    peer = await startPeer([UNIT, { ...UNIT, id: "<id-b>" }]);
    const several = await urx(["channel", "on", "get", "--channel", "1", "--json"], peer.listPort);
    expect(several.exit).toBe(3);
    expect(JSON.parse(several.stdout)).toMatchObject({ data: { device: null }, error: { code: "multiple_devices" } });
    const absent = await urx(["channel", "on", "get", "--channel", "1", "--device", "<id-c>", "--json"], peer.listPort);
    expect(absent.exit).toBe(3);
    expect(JSON.parse(absent.stdout).error.code).toBe("device_not_found");
    expect(peer.requests.filter((line) => line.includes("/vd/parameters/") || line.endsWith("/vd/device"))).toEqual([]);
  });
});
