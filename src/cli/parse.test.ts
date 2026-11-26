import { describe, expect, it } from "vitest";
import { COMMANDS, MODES, type Mode } from "./commands.js";
import { SETTING_BINDINGS } from "./settings.js";
import { parse, type ParseResult } from "./parse.js";

const shell = (line: string) => parse(line === "" ? [] : line.split(" "), "one-shot");
const kind = (result: ParseResult) => result.kind;
const args = (result: ParseResult) => (result.kind === "command" ? Object.fromEntries(result.arguments) : null);

describe("help and version invocation (H4, H5)", () => {
  it("show root help for a bare invocation and for --help alone", () => {
    expect(shell("")).toEqual({ kind: "help", path: [] });
    expect(shell("--help")).toEqual({ kind: "help", path: [] });
  });

  it("show help for a known command path followed by --help only", () => {
    expect(shell("device --help")).toEqual({ kind: "help", path: ["device"] });
    expect(shell("device list --help")).toEqual({ kind: "help", path: ["device", "list"] });
    expect(shell("run --help")).toEqual({ kind: "help", path: ["run"] });
  });

  it("reject help mixed with other arguments, and unknown names even with --help", () => {
    for (const line of ["device list --unknown --help", "device list --json --help", "run file --help", "--help --json", "--help device", "nothing --help", "device nothing --help"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("say why help mixed with other arguments is rejected", () => {
    const result = shell("device list --json --help");
    expect(result.kind === "error" ? result.message : "").toContain("--help cannot be combined with other arguments");
  });

  it("accept --version only alone", () => {
    expect(shell("--version")).toEqual({ kind: "version" });
    for (const line of ["--version --json", "--version --verbose", "--version --help", "--version device", "device --version", "device list --version"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("run nothing for an empty console or command-file line", () => {
    expect(parse([], "console")).toEqual({ kind: "empty" });
    expect(parse([], "command-file")).toEqual({ kind: "empty" });
    for (const mode of MODES) expect(kind(parse([""], mode)), mode).toBe("error");
  });

  it("accept help and version in the console, and neither in a command file", () => {
    expect(parse(["--version"], "console")).toEqual({ kind: "version" });
    expect(parse(["device", "list", "--help"], "console")).toEqual({ kind: "help", path: ["device", "list"] });
    for (const tokens of [["--version"], ["--help"], ["device", "list", "--help"]]) {
      expect(kind(parse(tokens, "command-file")), tokens.join(" ")).toBe("error");
    }
  });
});

describe("command path and argument placement (C10)", () => {
  it("require the complete command path before any named argument", () => {
    expect(kind(shell("run --json commands.txt"))).toBe("command");
    expect(kind(shell("run commands.txt --json"))).toBe("command");
    for (const line of ["--json run commands.txt", "--device x device list", "device --json list"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("say that arguments go after the command when one comes first", () => {
    const result = shell("--json run commands.txt");
    expect(result.kind === "error" ? result.message : "").toMatch(/^Arguments go after the command\. /);
  });

  it("treat an incomplete or unknown path as an input error", () => {
    for (const line of ["device", "nothing", "device nothing", "devices list", "Device list"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("match command words token by token, not a token that contains spaces", () => {
    for (const mode of MODES) {
      for (const tokens of [["device list"], ["device list", "--help"], ["device current"], ["device use", "--id", "x"], ["device", "list --json"], ["run f"]]) {
        expect(kind(parse(tokens, mode)), `${JSON.stringify(tokens)} in ${mode}`).toBe("error");
      }
    }
    expect(shell("run my-file --device=a")).toMatchObject({ positional: "my-file" });
    expect(parse(["run", "my file.txt", "--device", "a b"], "one-shot")).toMatchObject({ positional: "my file.txt", arguments: new Map([["device", "a b"]]) });
  });

  it("accept canonical names only (H3)", () => {
    for (const line of ["dev list", "device ls", "run commands.txt --js", "run commands.txt --dry", "run commands.txt --JSON"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("accept console --device and reject console --json (O8)", () => {
    expect(args(shell("console --device <device-id>"))).toEqual({ device: "<device-id>" });
    expect(kind(shell("console --json"))).toBe("error");
  });
});

describe("named arguments (C4, C5)", () => {
  it("accept a value after a space or after the first =", () => {
    expect(args(shell("run f --device abc"))).toEqual({ device: "abc" });
    expect(args(shell("run f --device=a=b"))).toEqual({ device: "a=b" });
    expect(args(parse(["run", "f", "--device="], "one-shot"))).toEqual({ device: "" });
    expect(args(parse(["run", "f", "--device", ""], "one-shot"))).toEqual({ device: "" });
    expect(args(parse(["run", "f", "--device", "-6"], "one-shot"))).toEqual({ device: "-6" });
  });

  it("take a value that starts with -- only after =", () => {
    expect(args(shell("run f --device=--help"))).toEqual({ device: "--help" });
    for (const line of ["run f --device --help", "run f --device --json", "run f --device"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("reject a repeated argument in either form, even with the same value", () => {
    for (const line of ["run f --json --json", "run f --device a --device a", "run f --device=a --device b", "run f --dry-run --dry-run"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("reject a value on a flag", () => {
    for (const line of ["run f --json=true", "run f --json=false", "run f --verbose=", "run f --dry-run=1"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("reject a standalone --", () => {
    expect(kind(shell("run f --"))).toBe("error");
    expect(kind(shell("run -- f"))).toBe("error");
  });
});

describe("the run positional argument", () => {
  it("require exactly one file, before or after the named arguments", () => {
    expect(shell("run commands.txt")).toMatchObject({ kind: "command", positional: "commands.txt" });
    expect(shell("run --json --dry-run commands.txt")).toMatchObject({ kind: "command", positional: "commands.txt" });
    expect(shell("run ./--commands.txt")).toMatchObject({ kind: "command", positional: "./--commands.txt" });
    for (const line of ["run", "run --json", "run a b", "run --commands.txt"]) {
      expect(kind(shell(line)), line).toBe("error");
    }
  });

  it("does not read a named argument's value as the file", () => {
    expect(kind(shell("run --device commands.txt"))).toBe("error");
    expect(shell("run --device x commands.txt")).toMatchObject({ positional: "commands.txt", arguments: new Map([["device", "x"]]) });
  });

  it("reject a positional argument on a command without one", () => {
    expect(kind(shell("device list extra"))).toBe("error");
  });
});

describe("modes", () => {
  it("accept each command only in its modes", () => {
    const sample: Record<string, string[]> = {
      console: ["console"],
      "device list": ["device", "list"],
      "device current": ["device", "current"],
      "device use": ["device", "use", "--id", "x"],
      exit: ["exit"],
      run: ["run", "f"],
    };
    // Each setting command, with its required target and value.
    for (const { path } of SETTING_BINDINGS) {
      sample[[...path, "get"].join(" ")] = [...path, "get", "--channel", "1"];
      sample[[...path, "set"].join(" ")] = [...path, "set", "--channel", "1", "--value", "1"];
    }
    expect(Object.keys(sample).sort()).toEqual(COMMANDS.map((command) => command.path.join(" ")).sort());
    for (const command of COMMANDS) {
      for (const mode of MODES) {
        const tokens = sample[command.path.join(" ")] as string[];
        expect(kind(parse(tokens, mode)), `${tokens.join(" ")} in ${mode}`).toBe(command.modes.includes(mode) ? "command" : "error");
      }
    }
  });

  it("accept --verbose from the shell only (P5)", () => {
    expect(args(shell("device list --verbose"))).toEqual({ verbose: true });
    expect(kind(parse(["device", "list", "--verbose"], "console"))).toBe("error");
    expect(args(parse(["device", "list", "--json"], "console"))).toEqual({ json: true });
  });

  it("require --id for device use", () => {
    expect(args(parse(["device", "use", "--id", "x"], "console"))).toEqual({ id: "x" });
    expect(kind(parse(["device", "use"], "console"))).toBe("error");
    expect(kind(parse(["device", "use", "--json"], "console"))).toBe("error");
  });
});

describe("messages", () => {
  it("never repeat a token the user typed", () => {
    const secret = "private-token-5f3a";
    const lines: [readonly string[], Mode][] = [
      [[secret], "one-shot"],
      [["device", secret], "one-shot"],
      [[`--${secret}`], "one-shot"],
      [["run", "f", `--${secret}`], "one-shot"],
      [["run", "f", secret], "one-shot"],
      [["device", "list", secret], "console"],
      [["run", "f", "--device", secret, "--device", secret], "one-shot"],
      [["run", "f", `--json=${secret}`], "one-shot"],
    ];
    for (const [tokens, mode] of lines) {
      const result = parse(tokens, mode);
      expect(result.kind, tokens.join(" ")).toBe("error");
      expect(result.kind === "error" ? result.message : "", tokens.join(" ")).not.toContain(secret);
    }
  });

  it("omit the urx prefix in the console", () => {
    const result = parse(["device"], "console");
    expect(result.kind === "error" ? result.message : "").toContain("`device --help`");
    expect(result.kind === "error" ? result.message : "").not.toContain("urx");
  });
});
