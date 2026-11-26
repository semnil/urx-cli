// Entry point of the `urx` command. Help and version need only this module's
// static imports: no addon, no connection and no file reads (H5).

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { BRIDGE_API_EXPECTED } from "./bridge.js";
import { BUILD_INFO, type BuildInfo } from "./build-info.js";
import { renderHelp } from "./cli/help.js";
import { parse } from "./cli/parse.js";
import { renderVersion, type Runtime } from "./cli/version.js";
import { processOutput, writeWithDeadline, type OutputStream } from "./output.js";

/** E1 exit codes used here. */
export const EXIT = Object.freeze({ success: 0, failure: 1, invalidInput: 2 });

export interface Io {
  readonly stdout: OutputStream;
  readonly stderr: OutputStream;
  readonly build: BuildInfo;
  readonly runtime: Runtime;
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
    case "error":
      // An input error the user never sees is an output failure (exit 1), not exit 2.
      return (await writeWithDeadline(io.stderr, `urx: ${parsed.message}\n`)) === null ? EXIT.invalidInput : EXIT.failure;
    case "command":
      await writeWithDeadline(io.stderr, `urx: \`urx ${parsed.command.path.join(" ")}\` is not available in this build.\n`);
      return EXIT.failure;
  }
}

/**
 * Writes a successful result to stdout. An output failure exits 1 after one
 * attempt to say so on stderr; a failure of that attempt is not retried.
 */
async function emit(io: Io, text: string): Promise<number> {
  const failure = await writeWithDeadline(io.stdout, text);
  if (failure === null) return EXIT.success;
  const reason = failure === "output_timeout" ? "did not accept the output within 5 seconds" : "could not be written";
  await writeWithDeadline(io.stderr, `urx: standard output ${reason}.\n`);
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
