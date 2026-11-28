// `urx device list` (D14): a complete discovery with each unit's System
// firmware, as one result. A discovery that does not complete lists nothing.

import type { DiscoveredDevice } from "@urx/device-control/operations";
import { CommandRun } from "./command-run.js";
import type { Diagnostics } from "./diagnostics.js";
import { escapeForDisplay } from "./escape.js";
import { ABANDONED, type CommandInterruption } from "./interrupts.js";
import { addonFailure, lifecycleFailure } from "./messages.js";
import type { AddonCheck } from "./native/addon.js";
import { discoverDevices } from "./native/device.js";
import type { OutputStream } from "./output.js";

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

/** Runs `urx device list` and returns its exit code. */
export async function runDeviceList(io: DeviceListIo, json: boolean): Promise<number> {
  const { interruption } = io;
  const run = new CommandRun(io.diagnostics, interruption);
  let devices: readonly DiscoveredDevice[] | null = null;
  // Nothing is loaded once the command has stopped, as after a Ctrl+C while it was being loaded.
  const check = run.first() === null ? io.addon() : null;
  if (check !== null && !check.ok) run.stop(addonFailure(check.problem));
  else if (check !== null && run.first() === null) {
    const { addon } = check;
    const control = new addon.Control();
    interruption.onInterrupt(() => control.cancel());
    await run.note("discovery", "started");
    const since = run.mark();
    if (run.first() === null) {
      const outcome = await interruption.race(discoverDevices(addon, control, true, io.listPort));
      if (outcome === ABANDONED) {
        // A second Ctrl+C: the discovery is no longer waited for (I3).
      } else if (outcome.kind === "failure") {
        // A cancellation the interruption asked for is not another failure.
        if (!(outcome.failure.kind === "cancelled" && interruption.interrupted)) run.stop(lifecycleFailure(outcome.failure));
        if (outcome.cleanup.failure !== null) run.stop(lifecycleFailure(outcome.cleanup.failure));
      } else {
        devices = byId(outcome.value);
      }
      await run.ended("discovery", since);
    }
  }
  return run.finish(io.stdout, json, COMMAND, (error) => {
    const listed = error === null ? devices : null;
    return { data: { mode: "execute", device: null, target: null, devices: listed }, human: listed === null ? null : renderDevices(listed) };
  });
}
