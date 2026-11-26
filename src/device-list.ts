// `urx device list` (D14): a complete discovery with each unit's System
// firmware, as one result. A discovery that does not complete lists nothing.

import type { DiscoveredDevice } from "@urx/device-control/operations";
import type { Diagnostics } from "./diagnostics.js";
import { escapeForDisplay } from "./escape.js";
import type { Interrupts } from "./interrupts.js";
import { addonFailure, failure, lifecycleFailure } from "./messages.js";
import type { AddonCheck } from "./native/addon.js";
import { discoverDevices } from "./native/device.js";
import { stdoutFailureLine, writeWithDeadline, type OutputFailure, type OutputStream } from "./output.js";
import { baseExitCode, EXIT, jsonLine, type ResultError, type ResultRecord } from "./result.js";

const COMMAND = "device list";

export interface DeviceListIo {
  readonly stdout: OutputStream;
  readonly diagnostics: Diagnostics;
  /** Loads the addon and checks its identity; called only here, never for help or version. */
  readonly addon: () => AddonCheck;
  readonly interrupts: Interrupts;
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

type Listing = { readonly kind: "listed"; readonly devices: readonly DiscoveredDevice[] } | { readonly kind: "failed"; readonly error: ResultError; readonly additional: ResultError | null };

/** Discovers through the addon. A second Ctrl+C stops waiting for the discovery (I3). */
async function list(io: DeviceListIo): Promise<Listing> {
  const check = io.addon();
  if (!check.ok) return { kind: "failed", error: addonFailure(check.problem), additional: null };
  const { addon } = check;
  const control = new addon.Control();
  let interrupted = false;
  let abandon: () => void = () => {};
  const abandoned = new Promise<"abandoned">((resolve) => (abandon = () => resolve("abandoned")));
  const unsubscribe = io.interrupts.subscribe((count) => {
    interrupted = true;
    control.cancel();
    if (count > 1) abandon();
  });
  try {
    await io.diagnostics.stage("discovery", "started");
    const outcome = await Promise.race([discoverDevices(addon, control, true, io.listPort), abandoned]);
    // Ctrl+C during the discovery is its outcome, whatever the discovery then returned.
    if (interrupted || outcome === "abandoned") {
      await io.diagnostics.stage("discovery", "failed", "interrupted");
      return { kind: "failed", error: failure("interrupted"), additional: null };
    }
    if (outcome.kind === "failure") {
      const error = lifecycleFailure(outcome.failure);
      await io.diagnostics.stage("discovery", "failed", error.code);
      const cleanup = outcome.cleanup.failure;
      return { kind: "failed", error, additional: cleanup === null ? null : lifecycleFailure(cleanup) };
    }
    await io.diagnostics.stage("discovery", "finished");
    return { kind: "listed", devices: byId(outcome.value) };
  } finally {
    unsubscribe();
  }
}

/** Runs `urx device list` and returns its exit code. */
export async function runDeviceList(io: DeviceListIo, json: boolean): Promise<number> {
  const listing = await list(io);
  if (listing.kind === "failed" && listing.additional !== null) await io.diagnostics.additional(listing.additional);
  const record: ResultRecord = {
    type: "result",
    command: COMMAND,
    data: { mode: "execute", device: null, target: null, devices: listing.kind === "listed" ? listing.devices : null },
    error: listing.kind === "listed" ? null : listing.error,
  };
  const exit = listing.kind === "listed" ? EXIT.success : baseExitCode(listing.error.code);
  await io.diagnostics.stage("result output", "started");
  // JSON carries a failure in its record; human-readable output reports it on standard error.
  let written: OutputFailure | null = null;
  if (json) written = await writeWithDeadline(io.stdout, jsonLine(record));
  else if (listing.kind === "listed") written = await writeWithDeadline(io.stdout, renderDevices(listing.devices));
  else await io.diagnostics.line(`urx: ${listing.error.message}\n`);
  if (written !== null) {
    await io.diagnostics.stage("result output", "failed", written);
    await io.diagnostics.line(stdoutFailureLine(written));
    return exit === EXIT.success ? EXIT.failure : exit;
  }
  await io.diagnostics.stage("result output", "finished");
  // A diagnostic that could not be written is an output failure too (U5).
  if (io.diagnostics.failure !== null && exit === EXIT.success) return EXIT.failure;
  return exit;
}
