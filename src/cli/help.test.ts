import { describe, expect, it } from "vitest";
import { acceptsArgument, COMMANDS, MODES } from "./commands.js";
import { renderHelp } from "./help.js";
import { parse } from "./parse.js";

describe("help generated from the command table (H1)", () => {
  it("list every command at the root, in every mode", () => {
    for (const mode of MODES) {
      const help = renderHelp([], mode);
      for (const command of COMMANDS) expect(help, `${command.path.join(" ")} in ${mode}`).toContain(`  ${command.path.join(" ")} `);
    }
  });

  it("list every accepted argument of a command, and no argument the parser rejects there", () => {
    for (const command of COMMANDS) {
      for (const mode of command.modes) {
        const help = renderHelp(command.path, mode);
        for (const argument of command.arguments) {
          const shown = help.includes(`--${argument.name}`);
          expect(shown, `--${argument.name} of ${command.path.join(" ")} in ${mode}`).toBe(acceptsArgument(argument, mode));
        }
        if (command.positional !== undefined) expect(help).toContain(command.positional.name);
      }
    }
  });

  it("show the usage the parser accepts", () => {
    expect(renderHelp(["run"], "one-shot")).toContain("Usage: urx run <file> [--device <device-id>] [--json] [--verbose] [--dry-run]\n");
    expect(renderHelp(["device", "use"], "console")).toContain("Usage: device use --id <device-id> [--json]\n");
    expect(renderHelp(["device", "list"], "console")).toContain("Usage: device list [--json]\n");
  });

  it("mark commands that run only in another mode", () => {
    expect(renderHelp(["device"], "one-shot")).toMatch(/^ {2}device use +Close the current connection and connect to another device \(console only\)$/m);
    expect(renderHelp(["device"], "one-shot")).toMatch(/^ {2}device list +List the online devices and their IDs$/m);
    expect(renderHelp(["device", "list"], "one-shot")).not.toContain("only");
    expect(renderHelp(["exit"], "one-shot")).toContain("Available console only.");
  });

  it("offer help for every path the parser accepts with --help", () => {
    const paths = [[], ["device"], ...COMMANDS.map((command) => [...command.path])];
    for (const path of paths) {
      expect(parse([...path, "--help"], "one-shot")).toEqual({ kind: "help", path });
      expect(renderHelp(path, "one-shot").startsWith("Usage: urx ")).toBe(true);
    }
  });

  it("name --version only at the root outside a command file", () => {
    expect(renderHelp([], "one-shot")).toContain("`urx --version`");
    expect(renderHelp([], "command-file")).not.toContain("--version");
    expect(renderHelp(["device"], "one-shot")).not.toContain("--version");
  });
});
