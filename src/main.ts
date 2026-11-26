// Entry point of the `urx` command. Help and version need only this module's
// static imports: no addon, no connection and no file reads (H5). A device
// command's module, and through it the addon, is loaded only when it runs.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRIDGE_API_EXPECTED } from "./bridge.js";
import { BUILD_INFO, type BuildInfo } from "./build-info.js";
import { renderHelp } from "./cli/help.js";
import { identifiedCommand, parse } from "./cli/parse.js";
import { settingCommandOf } from "./cli/settings.js";
import { renderVersion, type Runtime } from "./cli/version.js";
import { Diagnostics } from "./diagnostics.js";
import { ABANDONED, CommandInterruption, processInterrupts, type Interrupts } from "./interrupts.js";
import type { AddonCheck } from "./native/addon.js";
import { processOutput, stdoutFailureLine, writeWithDeadline, type OutputStream } from "./output.js";
import { EXIT, jsonLine } from "./result.js";

/** What a device command needs beyond the streams; tests supply their own. */
export interface DeviceIo {
  /** Loads the addon and checks its identity; the default loads dist/native/urx-native.node. */
  readonly addon?: () => AddonCheck;
  readonly interrupts: Interrupts;
  readonly now: () => number;
  /** A local peer's list port, for tests; Device Center's own when absent. */
  readonly listPort?: number;
}

export interface Io {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly build: BuildInfo;
  readonly runtime: Runtime;
  readonly device?: DeviceIo;
}

/** Runs one one-shot invocation and returns its exit code. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const parsed = parse(args, "one-shot");
  switch (parsed.kind) {
    case "empty": // only a console or command-file line can be empty
      return EXIT.success;
    case "help":
      return emit(io, renderHelp(parsed.path, "one-shot"));
    case "version":
      return emit(io, renderVersion(io.build, BRIDGE_API_EXPECTED, io.runtime));
    case "error": {
      // With --json, a refused line is a result too (O9): of its command where the line names
      // one that takes --json, and of no command (null) where it names none. Help and version
      // requests are not commands and keep their errors on standard error.
      const command = identifiedCommand(args);
      const requestsJson = args.includes("--json") && args[0] !== "--version" && args[0] !== "--help";
      if (requestsJson && (command === undefined || command.arguments.some((argument) => argument.name === "json"))) {
        const error = { code: "invalid_input" as const, message: parsed.message };
        const failure = await writeWithDeadline(io.stdout, jsonLine({ type: "result", command: command?.path.join(" ") ?? null, data: null, error }));
        if (failure === null) return EXIT.invalidInput;
        await writeWithDeadline(io.stderr, stdoutFailureLine(failure));
        return EXIT.failure;
      }
      // An input error the user never sees is an output failure (exit 1), not exit 2.
      return (await writeWithDeadline(io.stderr, `urx: ${parsed.message}\n`)) === null ? EXIT.invalidInput : EXIT.failure;
    }
    case "command": {
      const path = parsed.command.path.join(" ");
      const setting = settingCommandOf(parsed.command.path);
      if (path === "device list" || setting !== undefined) {
        const device = io.device ?? { interrupts: processInterrupts(), now: () => performance.now() };
        // From here until the result is written, Ctrl+C belongs to the command.
        const interruption = new CommandInterruption(device.interrupts);
        try {
          const diagnostics = new Diagnostics(
            { stderr: io.stderr, verbose: parsed.arguments.has("verbose"), build: io.build, runtime: io.runtime, now: device.now, interruption },
            path,
          );
          const modules = await interruption.race(Promise.all([import("./device-list.js"), import("./setting.js"), import("./native/addon.js")]));
          if (modules === ABANDONED) return EXIT.interrupted;
          const [{ runDeviceList }, { runSetting }, { expectedIdentity, openAddon }] = modules;
          const addon = device.addon ?? (() => openAddon(expectedIdentity(io.build)));
          const json = parsed.arguments.has("json");
          const shared = { stdout: io.stdout, diagnostics, addon, interruption, listPort: device.listPort };
          if (setting === undefined) return await runDeviceList(shared, json);
          return await runSetting(shared, { binding: setting.binding, verb: setting.verb, arguments: parsed.arguments }, json);
        } finally {
          interruption.dispose();
        }
      }
      await writeWithDeadline(io.stderr, `urx: \`urx ${path}\` is not available in this build.\n`);
      return EXIT.failure;
    }
  }
}

/**
 * Writes a successful result to stdout. An output failure exits 1 after one
 * attempt to say so on stderr; a failure of that attempt is not retried.
 */
async function emit(io: Io, text: string): Promise<number> {
  const failure = await writeWithDeadline(io.stdout, text);
  if (failure === null) return EXIT.success;
  await writeWithDeadline(io.stderr, stdoutFailureLine(failure));
  return EXIT.failure;
}

function isEntryPoint(): boolean {
  const script = process.argv[1];
  if (script === undefined) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const runtime: Runtime = { version: process.versions.node, platform: process.platform, arch: process.arch };
  // A write past a file size limit then fails with EFBIG instead of the signal ending the process.
  if (process.platform !== "win32") process.on("SIGXFSZ", () => {});
  const stdout = processOutput(process.stdout, 1);
  const stderr = processOutput(process.stderr, 2);
  const code = await main(process.argv.slice(2), { stdout, stderr, build: BUILD_INFO, runtime });
  // A write that missed its deadline may still be pending; exiting abandons it.
  process.exit(code);
}
