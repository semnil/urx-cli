// The connection of one device command (D13, D15, N2): a discovery without
// metadata, the selection of exactly the requested or the only online device,
// the opening that verifies its identity, and the D15 firmware warning. The
// command closes what this opened, whatever happened after.

import { firmwareStatus, isModel } from "@urx/device-control/catalog";
import type { CommandRun } from "./command-run.js";
import type { Diagnostics } from "./diagnostics.js";
import { ABANDONED } from "./interrupts.js";
import { lifecycleFailure } from "./messages.js";
import type { NativeAddon } from "./native/addon.js";
import { closeConnection, discoverDevices, openDevice, selectDevice, type DeviceConnection } from "./native/device.js";

/** The device an operation's connection verified (O10). */
export interface VerifiedDevice {
  readonly id: string;
  readonly model: string;
}

export interface Connected {
  readonly device: VerifiedDevice;
  readonly opened: DeviceConnection;
}

const SELECTION_MESSAGES = {
  requested: "The requested device is not online.",
  none: "No device is online.",
  multiple: "More than one device is online; choose one with --device.",
} as const;

/**
 * Discovers and opens the device. On any failure `run` is stopped. An opened
 * connection is returned even when `run` stopped meanwhile, so that it is
 * closed; null when nothing was opened.
 */
export async function connect(run: CommandRun, diagnostics: Diagnostics, addon: NativeAddon, requested: string | undefined, listPort?: number): Promise<Connected | null> {
  const { interruption } = run;
  const control = new addon.Control();
  interruption.onInterrupt(() => control.cancel());
  const cancelled = (record: { kind: string }) => record.kind === "cancelled" && interruption.interrupted;

  await run.note("discovery", "started");
  if (run.first() !== null) return null;
  const discovering = run.mark();
  const discovery = await interruption.race(discoverDevices(addon, control, false, listPort));
  if (discovery === ABANDONED) return null;
  if (discovery.kind === "failure") {
    if (!cancelled(discovery.failure)) run.stop(lifecycleFailure(discovery.failure));
    await run.ended("discovery", discovering);
    return null;
  }
  // Selection from a complete discovery only, exactly by ID (D13).
  const selection = selectDevice(discovery.value, requested);
  if (selection.kind === "none") {
    const message = requested !== undefined ? SELECTION_MESSAGES.requested : selection.code === "device_not_found" ? SELECTION_MESSAGES.none : SELECTION_MESSAGES.multiple;
    run.stop({ code: selection.code, message });
  }
  await run.ended("discovery", discovering);
  if (selection.kind === "none" || run.first() !== null) return null;

  await run.note("connection", "started");
  if (run.first() !== null) return null;
  const openingSince = run.mark();
  const opening = await interruption.race(openDevice(addon, control, selection.device.id));
  if (opening === ABANDONED) return null;
  if (opening.kind === "failure") {
    if (!cancelled(opening.failure)) run.stop(lifecycleFailure(opening.failure));
    if (opening.cleanup.failure !== null) run.stop(lifecycleFailure(opening.cleanup.failure));
    await run.ended("connection", openingSince);
    return null;
  }
  const connected: Connected = { device: { id: selection.device.id, model: selection.device.model }, opened: opening.value };
  const { model } = connected.device;
  if (!isModel(model)) {
    run.stop({ code: "unsupported_operation", message: "This CLI does not support the device's model." });
  } else if (firmwareStatus(model, opening.value.connection.firmware) === "unverified" && run.first() === null) {
    // Once per connection, with or without --json and --verbose (D15).
    await diagnostics.line("urx: Firmware compatibility has not been verified.\n");
  }
  await run.ended("connection", openingSince);
  return connected;
}

/** Closes the connection (N2); a failure of the close is a stop like any other. */
export async function disconnect(run: CommandRun, connected: Connected): Promise<void> {
  await run.note("teardown", "started");
  const since = run.mark();
  const closing = await run.interruption.race(closeConnection(connected.opened.connection));
  if (closing === ABANDONED) return;
  if (closing.kind === "failure") {
    run.stop(lifecycleFailure(closing.failure));
    if (closing.cleanup.failure !== null) run.stop(lifecycleFailure(closing.cleanup.failure));
  }
  await run.ended("teardown", since);
}

