// English explanations of failures, built only from the cause and the stage
// (P5): no device ID, path, value or text from outside the CLI.

import type { LifecycleFailure, LifecyclePhase } from "@urx/device-control/operations";
import type { AddonProblem } from "./native/addon.js";
import type { CauseCode, ResultError } from "./result.js";

const BASE: Record<CauseCode, string> = {
  invalid_input: "The input is not valid",
  unsupported_operation: "The operation is not supported for this device",
  precondition_failed: "A required condition was not met",
  not_connected: "There is no usable connection",
  device_not_found: "The device is not online",
  multiple_devices: "More than one device is online",
  identity_error: "A device reported a missing, inconsistent or duplicate ID",
  connection_failed: "A connection could not be opened",
  connection_lost: "The connection was lost",
  discovery_timeout: "Discovery did not finish within 10 seconds",
  connect_timeout: "The connection was not ready within 5 seconds",
  send_timeout: "A request could not be sent within 3 seconds",
  response_timeout: "A response did not arrive within 3 seconds",
  teardown_timeout: "Closing the connection did not finish within 2 seconds",
  output_timeout: "The output did not accept the result within 5 seconds",
  meter_timeout: "Meter data did not arrive within 3 seconds",
  device_rejected: "The device rejected the request",
  invalid_response: "A response could not be read",
  notification_overflow: "Notifications arrived faster than they could be handled",
  file_error: "A file could not be read",
  input_closed: "The input closed",
  input_error: "The input could not be read",
  output_error: "The output could not be written",
  interrupted: "Interrupted",
  internal_error: "An internal error occurred",
};

const DURING: Record<LifecyclePhase, string> = {
  discovery: "during discovery",
  connect: "while connecting",
  identity: "while checking the device's identity",
  admission: "before anything was sent",
  subscription: "while registering for notifications",
  teardown: "while closing the connection",
};

/** The deadlines whose message already names their stage. */
const STAGED: ReadonlySet<CauseCode> = new Set(["discovery_timeout", "connect_timeout", "teardown_timeout"]);

/** A failure from its cause alone. */
export const failure = (code: CauseCode): ResultError => ({ code, message: `${BASE[code]}.` });

/**
 * A lifecycle call's failure, naming the stage it stopped in. A cancellation
 * is the CLI's own response to Ctrl+C, so it reports `interrupted`.
 */
export function lifecycleFailure(record: LifecycleFailure): ResultError {
  if (record.kind === "cancelled") return failure("interrupted");
  if (STAGED.has(record.code)) return failure(record.code);
  return { code: record.code, message: `${BASE[record.code]} ${DURING[record.phase]}.` };
}

/** A failed write of standard output, the stream that carries the result. */
export const stdoutFailure = (code: "output_error" | "output_timeout"): ResultError => ({
  code,
  message: code === "output_timeout" ? "Standard output did not accept the output within 5 seconds." : "Standard output could not be written.",
});

/** A failed write of standard error, the stream that carries diagnostics. */
export const stderrFailure = (code: "output_error" | "output_timeout"): ResultError => ({
  code,
  message: code === "output_timeout" ? "Standard error did not accept the output within 5 seconds." : "Standard error could not be written.",
});

/** The human-readable line of a device command's failure: its cause code, then its explanation. */
export const failureLine = (error: ResultError): string => `urx: ${error.code}: ${error.message}\n`;

/** Why the native addon cannot be used: device access is refused before it starts. */
export function addonFailure(problem: AddonProblem): ResultError {
  const message = {
    missing: "The native addon could not be loaded.",
    malformed: "The native addon does not report a usable build identity.",
    unverifiable: "The native addon or this CLI cannot name the urx-device source it was built from.",
    bridge_mismatch: "The native addon was built for another bridge revision than this CLI.",
    common_mismatch: "The native addon was built from another urx-device source than this CLI.",
  }[problem];
  return { code: "internal_error", message };
}
