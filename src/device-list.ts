// `urx device list` (D14): a complete discovery with each unit's System
// firmware, as one result. A discovery that does not complete lists nothing.

import type { DiscoveredDevice } from "@urx/device-control/operations";
import type { Diagnostics, Stage } from "./diagnostics.js";
import { escapeForDisplay } from "./escape.js";
import { ABANDONED, type CommandInterruption } from "./interrupts.js";
import { addonFailure, failure, lifecycleFailure } from "./messages.js";
import type { AddonCheck } from "./native/addon.js";
import { discoverDevices } from "./native/device.js";
import { stdoutFailureLine, writeWithDeadline, type OutputFailure, type OutputStream } from "./output.js";
import { baseExitCode, EXIT, jsonLine, type CauseCode, type ResultError } from "./result.js";

const COMMAND = "device list";

export interface DeviceListIo {
  readonly stdout: OutputStream;
  readonly diagnostics: Diagnostics;
  /** Loads the addon and checks its identity; called only here, never for help or version. */
  readonly addon: () => AddonCheck;
  /** The command's Ctrl+C, listened to since the command was chosen. */
  readonly interruption: CommandInterruption;
  /** A local peer's list port, for tests; Device Center's own when absent. */
  readonly listPort?: number;
}

/** Entries in the UTF-8 byte order of their IDs, without normalization (D14). */
const byId = (devices: readonly DiscoveredDevice[]) =>
  [...devices].sort((a, b) => Buffer.compare(Buffer.from(a.id, "utf8"), Buffer.from(b.id, "utf8")));

/** The human-readable list: ID, MODEL and FIRMWARE columns, `-` for an absent version. */
export function renderDevices(devices: readonly DiscoveredDevice[]): string {
  if (devices.length === 0) return "No online devices.\n";
  const rows = [["ID", "MODEL", "FIRMWARE"], ...devices.map((device) => [device.id, device.model, device.firmware ?? "-"].map(escapeForDisplay))];
  const widths = [0, 1].map((column) => Math.max(...rows.map((row) => (row[column] as string).length)));
  return rows.map(([id, model, firmware]) => `${(id as string).padEnd(widths[0] as number)}  ${(model as string).padEnd(widths[1] as number)}  ${firmware}`.trimEnd()).join("\n") + "\n";
}

/**
 * The command's first stopping cause, in the order the CLI detects causes,
 * and the failures found after it (E3).
 */
class Stops {
  #first: ResultError | null = null;
  readonly later: ResultError[] = [];

  /** Read through a method: an interruption can set it while the command awaits. */
  first(): ResultError | null {
    return this.#first;
  }

  stop(error: ResultError): void {
    if (this.#first === null) this.#first = error;
    else this.later.push(error);
  }

  /** Every stop, in the order found. */
  all(): ResultError[] {
    return this.#first === null ? [] : [this.#first, ...this.later];
  }
}

/** Runs `urx device list` and returns its exit code. */
export async function runDeviceList(io: DeviceListIo, json: boolean): Promise<number> {
  const { diagnostics, interruption } = io;
  const stops = new Stops();
  interruption.onInterrupt(() => stops.stop(failure("interrupted")));
  // Standard error that stops accepting lines is an output failure: no device work starts after it (U5).
  let errorOutputNoted = false;
  const note = async (stage: Stage, event: "started" | "finished" | "failed", cause?: CauseCode) => {
    await diagnostics.stage(stage, event, cause);
    if (diagnostics.failure !== null && !errorOutputNoted) {
      errorOutputNoted = true;
      stops.stop(failure(diagnostics.failure));
    }
  };

  let devices: readonly DiscoveredDevice[] | null = null;
  // Nothing is loaded once the command has stopped, as after a Ctrl+C while it was being loaded.
  const check = stops.first() === null ? io.addon() : null;
  if (check !== null && !check.ok) stops.stop(addonFailure(check.problem));
  else if (check !== null && stops.first() === null) {
    const { addon } = check;
    const control = new addon.Control();
    interruption.onInterrupt(() => control.cancel());
    await note("discovery", "started");
    if (stops.first() === null) {
      const outcome = await interruption.race(discoverDevices(addon, control, true, io.listPort));
      if (outcome === ABANDONED) {
        // A second Ctrl+C: the discovery is no longer waited for (I3).
      } else if (outcome.kind === "failure") {
        // A cancellation the interruption asked for is not another failure.
        if (!(outcome.failure.kind === "cancelled" && interruption.interrupted)) stops.stop(lifecycleFailure(outcome.failure));
        if (outcome.cleanup.failure !== null) stops.stop(lifecycleFailure(outcome.cleanup.failure));
      } else {
        devices = byId(outcome.value);
      }
      const cause = stops.first()?.code;
      await note("discovery", cause === undefined ? "finished" : "failed", cause);
    }
  }

  await note("result output", "started");
  // A second Ctrl+C stops every wait, and nothing more is written (I3).
  if (interruption.abandoned) return EXIT.interrupted;
  // The result is decided here. Stops found later are still collected and reported after it.
  const error = stops.first();
  const listed = error === null ? devices : null;
  const record = { type: "result" as const, command: COMMAND, data: { mode: "execute", device: null, target: null, devices: listed }, error };
  // JSON carries a failure in its record; human-readable output reports it on standard error.
  const text = json ? jsonLine(record) : listed !== null ? renderDevices(listed) : null;
  const written = text === null ? null : await interruption.race(writeWithDeadline(io.stdout, text));
  if (written === ABANDONED) return EXIT.interrupted;
  // A failed write of the result stops the command where the CLI detects it, after any earlier stop.
  const stdoutFailure: { readonly failure: OutputFailure; readonly error: ResultError } | null = written === null ? null : { failure: written, error: failure(written) };
  if (stdoutFailure !== null) stops.stop(stdoutFailure.error);
  if (!json && error !== null) await diagnostics.line(`urx: ${error.message}\n`);
  // Every stop besides the recorded one, once each, in the order found (E3). After a result
  // without an error, the first of them is the command's own failure.
  for (const [index, stop] of stops.all().filter((stop) => stop !== error).entries()) {
    if (error === null && index === 0) await diagnostics.line(stop === stdoutFailure?.error ? stdoutFailureLine(stdoutFailure.failure) : `urx: ${stop.message}\n`);
    else await diagnostics.additional(stop);
  }
  await diagnostics.stage("result output", stdoutFailure === null ? "finished" : "failed", stdoutFailure?.failure);
  // Ctrl+C during the command takes precedence (E1), even once its result is out.
  if (interruption.interrupted || interruption.abandoned) return EXIT.interrupted;
  const first = stops.first();
  if (first !== null) return baseExitCode(first.code);
  // A diagnostic that could not be written fails a command that otherwise succeeded (U5).
  return diagnostics.failure === null ? EXIT.success : EXIT.failure;
}
