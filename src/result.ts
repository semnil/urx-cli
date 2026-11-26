// The result record every command emits (O9), its failure causes (E2) and the
// exit code a failure takes when nothing else decides it (E1, OV-EXIT).

/** The fixed E2 cause identifiers. Scripts branch on these, never on messages. */
export type CauseCode =
  | "invalid_input"
  | "unsupported_operation"
  | "precondition_failed"
  | "not_connected"
  | "device_not_found"
  | "multiple_devices"
  | "identity_error"
  | "connection_failed"
  | "connection_lost"
  | "discovery_timeout"
  | "connect_timeout"
  | "send_timeout"
  | "response_timeout"
  | "teardown_timeout"
  | "output_timeout"
  | "meter_timeout"
  | "device_rejected"
  | "invalid_response"
  | "notification_overflow"
  | "file_error"
  | "input_closed"
  | "input_error"
  | "output_error"
  | "interrupted"
  | "internal_error";

/** The E1 exit codes. */
export const EXIT = Object.freeze({
  success: 0,
  failure: 1,
  invalidInput: 2,
  connection: 3,
  rejected: 4,
  uncertain: 5,
  partial: 6,
  interrupted: 130,
});

/**
 * The exit code of a failure from its cause alone: E1's category, or the base
 * code OV-EXIT assigns a cause that fits no single category. The `5`, `6` and
 * `130` precedence is applied by the caller, which knows the outcomes.
 */
export function baseExitCode(code: CauseCode): number {
  switch (code) {
    case "invalid_input":
    case "file_error":
      return EXIT.invalidInput;
    case "device_not_found":
    case "multiple_devices":
    case "identity_error":
    case "not_connected":
    case "connection_failed":
    case "connection_lost":
    case "discovery_timeout":
    case "connect_timeout":
      return EXIT.connection;
    case "device_rejected":
      return EXIT.rejected;
    case "interrupted":
      return EXIT.interrupted;
    case "unsupported_operation":
    case "precondition_failed":
    case "send_timeout":
    case "response_timeout":
    case "teardown_timeout":
    case "output_timeout":
    case "meter_timeout":
    case "invalid_response":
    case "notification_overflow":
    case "input_closed":
    case "input_error":
    case "output_error":
    case "internal_error":
      return EXIT.failure;
  }
}

/** One failure: its cause and an English explanation built from known fields (P5). */
export interface ResultError {
  readonly code: CauseCode;
  readonly message: string;
}

/** The record that ends one command (O9). `data` is null only when there is no result information. */
export interface ResultRecord {
  readonly type: "result";
  /** The canonical command path, or null when the input cannot be identified. */
  readonly command: string | null;
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly error: ResultError | null;
}

/** One JSON line: non-ASCII characters as UTF-8, with ordinary JSON escaping (K26). */
export const jsonLine = (record: ResultRecord): string =>
  `${JSON.stringify({ type: record.type, command: record.command, data: record.data, error: record.error })}\n`;
