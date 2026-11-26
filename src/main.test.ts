import { describe, expect, it } from "vitest";
import { main, type Io } from "./main.js";
import type { OutputStream } from "./output.js";

const capture = (fail?: Error) => {
  const chunks: string[] = [];
  const stream: OutputStream = { write: (chunk, done) => (chunks.push(chunk), done(fail ?? null), fail === undefined) };
  return { stream, text: () => chunks.join("") };
};

function io(stdoutFailure?: Error, stderrFailure?: Error) {
  const stdout = capture(stdoutFailure);
  const stderr = capture(stderrFailure);
  const value: Io = {
    stdout: stdout.stream,
    stderr: stderr.stream,
    build: { appVersion: "0.1.0", appCommit: "unknown", commonVersion: "0.1.0", commonCommit: "unknown" },
    runtime: { version: "26.13.0", platform: "darwin", arch: "arm64" },
  };
  return { value, stdout: stdout.text, stderr: stderr.text };
}

describe("one-shot invocation", () => {
  it("print help on stdout and exit 0", async () => {
    for (const args of [[], ["--help"], ["device", "--help"], ["run", "--help"]]) {
      const run = io();
      expect(await main(args, run.value), args.join(" ")).toBe(0);
      expect(run.stdout().startsWith("Usage: urx ")).toBe(true);
      expect(run.stderr()).toBe("");
    }
  });

  it("print the version on stdout and exit 0", async () => {
    const run = io();
    expect(await main(["--version"], run.value)).toBe(0);
    expect(run.stdout()).toBe("urx 0.1.0 (unknown)\ncommon 0.1.0 (unknown)\nbridge-api-expected 3\nruntime 26.13.0 macos arm64\n");
  });

  it("report an input error on stderr only and exit 2", async () => {
    for (const args of [["device"], ["--version", "--json"], ["run"], ["console", "--json"], ["exit"]]) {
      const run = io();
      expect(await main(args, run.value), args.join(" ")).toBe(2);
      expect(run.stdout()).toBe("");
      expect(run.stderr()).toMatch(/^urx: .+\n$/);
    }
  });

  it("report an input error as a JSON result when --json is given, naming the command where the line names one", async () => {
    const run = io();
    expect(await main(["channel", "fader", "get", "--json"], run.value)).toBe(2);
    expect(JSON.parse(run.stdout())).toEqual({
      type: "result",
      command: "channel fader get",
      data: null,
      error: { code: "invalid_input", message: "`urx channel fader get` needs --channel. See `urx channel fader get --help`." },
    });
    expect(run.stderr()).toBe("");
    const unknown = io();
    expect(await main(["channel", "mute", "get", "--json"], unknown.value)).toBe(2);
    expect(JSON.parse(unknown.stdout())).toMatchObject({ command: null, data: null, error: { code: "invalid_input" } });
    // A command without --json keeps its error on standard error.
    const plain = io();
    expect(await main(["console", "--json"], plain.value)).toBe(2);
    expect(plain.stdout()).toBe("");
  });

  it("exit 1 when the input error cannot be written to stderr", async () => {
    const run = io(undefined, new Error("EPIPE"));
    expect(await main(["device"], run.value)).toBe(1);
    expect(run.stdout()).toBe("");
  });

  it("try stderr once when both stdout and stderr fail, and exit 1", async () => {
    const run = io(new Error("EPIPE"), new Error("EPIPE"));
    expect(await main(["--version"], run.value)).toBe(1);
    expect(run.stderr()).toBe("urx: standard output could not be written.\n");
  });

  it("exit 1 with a stderr line when stdout fails", async () => {
    const run = io(new Error("EPIPE"));
    expect(await main(["--help"], run.value)).toBe(1);
    expect(run.stderr()).toBe("urx: standard output could not be written.\n");
  });

  it("exit 1 for a command this build does not run, without stdout output", async () => {
    const run = io();
    expect(await main(["run", "commands.txt"], run.value)).toBe(1);
    expect(run.stdout()).toBe("");
    expect(run.stderr()).toBe("urx: `urx run` is not available in this build.\n");
  });
});
