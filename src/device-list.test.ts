import { describe, expect, it } from "vitest";
import { renderDevices, runDeviceList } from "./device-list.js";
import { Diagnostics } from "./diagnostics.js";
import type { InterruptHandler, Interrupts } from "./interrupts.js";
import type { AddonCheck, NativeAddon } from "./native/addon.js";
import type { OutputStream } from "./output.js";

const capture = (fail?: Error) => {
  const chunks: string[] = [];
  const stream: OutputStream = { write: (chunk, done) => (chunks.push(chunk), done(fail ?? null), fail === undefined) };
  return { stream, text: () => chunks.join("") };
};

/** Interruptions a test sends itself. */
function interrupts() {
  const handlers = new Set<InterruptHandler>();
  let count = 0;
  const value: Interrupts = {
    subscribe: (handler) => (handlers.add(handler), () => handlers.delete(handler)),
  };
  return { value, send: () => (count += 1, [...handlers].forEach((handler) => handler(count))), listening: () => handlers.size };
}

/** An addon whose discovery resolves with `record`, or waits for `release` when given a promise. */
function addon(discover: (control: { cancelled: boolean }) => Promise<unknown>): AddonCheck {
  class Control {
    cancelled = false;
    cancel() {
      this.cancelled = true;
    }
  }
  const module = {
    buildIdentity: () => null,
    Control,
    Connection: class {},
    discover: (control: Control, metadata: boolean) => (metadata ? discover(control) : Promise.reject(new Error("metadata is required"))),
    openConnection: () => Promise.reject(new Error("not used")),
  };
  return { ok: true, addon: module as unknown as NativeAddon };
}

const build = { appVersion: "0.1.0", appCommit: "a".repeat(40), commonVersion: "0.1.0", commonCommit: "b".repeat(40) };
const runtime = { version: "26.13.0", platform: "darwin" as const, arch: "arm64" };
const complete = { state: "complete", failure: null };

async function run(check: AddonCheck, json: boolean, options: { verbose?: boolean; stdoutFailure?: Error; interrupt?: ReturnType<typeof interrupts> } = {}) {
  const stdout = capture(options.stdoutFailure);
  const stderr = capture();
  let clock = 0;
  const diagnostics = new Diagnostics({ stderr: stderr.stream, verbose: options.verbose ?? false, build, runtime, now: () => (clock += 5) }, "device list");
  const interrupt = options.interrupt ?? interrupts();
  const exit = await runDeviceList({ stdout: stdout.stream, diagnostics, addon: () => check, interrupts: interrupt.value }, json);
  return { exit, stdout: stdout.text(), stderr: stderr.text(), listening: interrupt.listening() };
}

const listed = (devices: unknown[]) => () => Promise.resolve({ kind: "success", value: devices });

describe("urx device list (D14)", () => {
  it("print every device sorted by the UTF-8 bytes of its ID, with `-` for an absent version", async () => {
    const devices = [
      { id: "b", model: "URX22", firmware: "1.5.0.1" },
      { id: "é", model: "URX44", firmware: null },
      { id: "B", model: "URX44V", firmware: "1.5.0.1" },
    ];
    const result = await run(addon(listed(devices)), false);
    expect(result).toEqual({
      exit: 0,
      stdout: "ID  MODEL   FIRMWARE\nB   URX44V  1.5.0.1\nb   URX22   1.5.0.1\né   URX44   -\n",
      stderr: "",
      listening: 0,
    });
  });

  it("emit one JSON result with the devices in the same order and their exact values", async () => {
    const devices = [
      { id: "<id-b>\u001b", model: "URX44", firmware: null },
      { id: "<id-a>", model: "URX22", firmware: "1.5.0.1" },
    ];
    const result = await run(addon(listed(devices)), true);
    expect(result.exit).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      type: "result",
      command: "device list",
      data: { mode: "execute", device: null, target: null, devices: [devices[1], devices[0]] },
      error: null,
    });
  });

  it("report a complete empty list as success", async () => {
    expect((await run(addon(listed([])), false)).stdout).toBe("No online devices.\n");
    expect(JSON.parse((await run(addon(listed([])), true)).stdout).data.devices).toEqual([]);
  });

  it("escape control characters in human-readable output only", () => {
    expect(renderDevices([{ id: "x\u001b[31m", model: "URX\n44", firmware: "1\u0007" }])).toBe("ID         MODEL      FIRMWARE\nx\\x1b[31m  URX\\x0a44  1\\x07\n");
  });

  it("list nothing when discovery fails, keeping its cause and exit code", async () => {
    const cases: [string, string, number][] = [
      ["discovery_timeout", "discovery", 3],
      ["connection_failed", "discovery", 3],
      ["identity_error", "discovery", 3],
      ["invalid_response", "discovery", 1],
      ["internal_error", "discovery", 1],
    ];
    for (const [code, phase, exit] of cases) {
      const record = { kind: "failure", failure: { kind: "cause", code, phase }, cleanup: complete };
      const human = await run(addon(() => Promise.resolve(record)), false);
      expect(human.exit, code).toBe(exit);
      expect(human.stdout).toBe("");
      expect(human.stderr).toMatch(/^urx: [^\n]+\.\n$/);
      const json = await run(addon(() => Promise.resolve(record)), true);
      expect(json.exit).toBe(exit);
      expect(json.stderr).toBe("");
      const parsed = JSON.parse(json.stdout);
      expect(parsed.data).toEqual({ mode: "execute", device: null, target: null, devices: null });
      expect(parsed.error.code).toBe(code);
    }
  });

  it("refuse an addon that cannot be used before any discovery, as internal_error", async () => {
    for (const problem of ["missing", "malformed", "unverifiable", "bridge_mismatch", "common_mismatch"] as const) {
      const result = await run({ ok: false, problem }, true);
      expect(result.exit).toBe(1);
      expect(JSON.parse(result.stdout).error.code).toBe("internal_error");
    }
  });

  it("report Ctrl+C during discovery as interrupted and exit 130, cancelling the discovery", async () => {
    const interrupt = interrupts();
    let control: { cancelled: boolean } | undefined;
    const pending = run(
      addon((given) => {
        control = given;
        // The discovery ends once it is cancelled.
        return new Promise((resolve) => setTimeout(() => resolve({ kind: "failure", failure: { kind: "cancelled", phase: "discovery" }, cleanup: complete }), 20));
      }),
      true,
      { interrupt },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    interrupt.send();
    const result = await pending;
    expect(control?.cancelled).toBe(true);
    expect(result.exit).toBe(130);
    expect(JSON.parse(result.stdout).error.code).toBe("interrupted");
    expect(result.listening).toBe(0);
  });

  it("stop waiting at a second Ctrl+C (I3), still reporting interrupted", async () => {
    const interrupt = interrupts();
    const pending = run(addon(() => new Promise(() => {})), false, { interrupt });
    await new Promise((resolve) => setTimeout(resolve, 5));
    interrupt.send();
    interrupt.send();
    const result = await pending;
    expect(result.exit).toBe(130);
    expect(result.stderr).toBe("urx: Interrupted.\n");
  });

  it("report Ctrl+C even when the discovery then completes", async () => {
    const interrupt = interrupts();
    const pending = run(addon(() => new Promise((resolve) => setTimeout(() => resolve({ kind: "success", value: [] }), 20))), true, { interrupt });
    await new Promise((resolve) => setTimeout(resolve, 5));
    interrupt.send();
    expect((await pending).exit).toBe(130);
  });

  it("exit 1 when stdout fails after a successful list, saying so on stderr", async () => {
    const result = await run(addon(listed([])), false, { stdoutFailure: new Error("EPIPE") });
    expect(result.exit).toBe(1);
    expect(result.stderr).toBe("urx: standard output could not be written.\n");
  });

  it("show stages with --verbose, without device IDs, after the build context", async () => {
    const result = await run(addon(listed([{ id: "<id-a>", model: "URX44", firmware: null }])), true, { verbose: true });
    expect(result.exit).toBe(0);
    const lines = result.stderr.trimEnd().split("\n");
    expect(lines[0]).toBe(`urx: verbose: urx 0.1.0 (${"a".repeat(40)}), common 0.1.0 (${"b".repeat(40)}), bridge-api-expected 3, runtime 26.13.0 macos arm64`);
    expect(lines.slice(1)).toEqual([
      "urx: verbose: device list: discovery started at 5 ms",
      "urx: verbose: device list: discovery finished at 10 ms",
      "urx: verbose: device list: result output started at 15 ms",
      "urx: verbose: device list: result output finished at 20 ms",
    ]);
    expect(result.stderr).not.toContain("<id-a>");
  });
});
