// Discovery, device selection and the connection lifecycle over the addon
// (K37, D13, N2). Every native outcome is validated with urx-device's own
// validators before it is used; a record that fails validation, or a Promise
// that rejects, is an internal_error and never a success (K33).

import {
  validateDiscovery,
  validateLifecycle,
  type DiscoveredDevice,
  type LifecycleOutcome,
} from "@urx/device-control/operations";

/** The addon's control object (K37): created before discovery, cancelled by the CLI. */
export interface NativeControl {
  cancel(): void;
}

/** The addon's connection object (K31). */
export interface NativeConnection {
  readonly firmware: string | null;
  close(): Promise<unknown>;
}

/** The lifecycle exports of the addon. */
export interface LifecycleAddon {
  readonly Control: new () => NativeControl;
  readonly Connection: abstract new (...args: never[]) => NativeConnection;
  discover(control: NativeControl, metadata: boolean, listPort?: number): Promise<unknown>;
  openConnection(deviceId: string, control: NativeControl): Promise<unknown>;
}

/** The failure the CLI reports for a record it could not trust. */
const internal = <T>(phase: "discovery" | "connect" | "teardown", state: "complete" | "incomplete"): LifecycleOutcome<T> => ({
  kind: "failure",
  failure: { kind: "cause", code: "internal_error", phase },
  cleanup: { state, failure: null },
});

/** Settles `call` and validates what it fulfils with; a rejection is not a record. */
async function settled<T>(call: () => Promise<unknown>, validate: (record: unknown) => T | undefined, otherwise: T): Promise<T> {
  let record: unknown;
  try {
    record = await call();
  } catch {
    return otherwise;
  }
  return validate(record) ?? otherwise;
}

/** Lists the online devices (D14), with each one's System firmware when `metadata` is set. */
export function discoverDevices(addon: LifecycleAddon, control: NativeControl, metadata: boolean, listPort?: number): Promise<LifecycleOutcome<DiscoveredDevice[]>> {
  return settled(
    () => addon.discover(control, metadata, listPort),
    (record) => validateDiscovery(record, metadata),
    internal("discovery", "complete"),
  );
}

export type Selection =
  | { readonly kind: "selected"; readonly device: DiscoveredDevice }
  | { readonly kind: "none"; readonly code: "device_not_found" | "multiple_devices" };

/**
 * Picks the device to operate from a complete discovery (D13): the one with
 * exactly the requested ID, or, with no ID requested, the only online device.
 * An absent requested ID is never replaced by another unit.
 */
export function selectDevice(devices: readonly DiscoveredDevice[], requestedId: string | undefined): Selection {
  if (requestedId !== undefined) {
    const device = devices.find((candidate) => candidate.id === requestedId);
    return device === undefined ? { kind: "none", code: "device_not_found" } : { kind: "selected", device };
  }
  if (devices.length === 1) return { kind: "selected", device: devices[0] as DiscoveredDevice };
  return { kind: "none", code: devices.length === 0 ? "device_not_found" : "multiple_devices" };
}

/** Opens the device `control`'s discovery found, verifying its identity (N2). */
export function openDevice(addon: LifecycleAddon, control: NativeControl, deviceId: string): Promise<LifecycleOutcome<NativeConnection>> {
  return settled(
    () => addon.openConnection(deviceId, control),
    (record) => validateLifecycle(record, (value) => (value instanceof addon.Connection ? value : undefined)),
    // An open that could not be confirmed may have left a connection behind.
    internal<NativeConnection>("connect", "incomplete"),
  );
}

/** Closes a connection (K4, N2); repeated calls join the same close. */
export function closeConnection(connection: NativeConnection): Promise<LifecycleOutcome<null>> {
  return settled(
    () => connection.close(),
    (record) => validateLifecycle(record, (value) => (value === null ? null : undefined)),
    internal<null>("teardown", "incomplete"),
  );
}
