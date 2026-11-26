import { describe, expect, it } from "vitest";
import { escapeForDisplay } from "./escape.js";
import { lifecycleFailure } from "./messages.js";
import { baseExitCode, jsonLine, type CauseCode } from "./result.js";

describe("exit codes from a cause (E1, OV-EXIT)", () => {
  it("take E1's category, and OV-EXIT's base code for the causes that fit none", () => {
    const expected: Record<number, CauseCode[]> = {
      1: [
        "unsupported_operation",
        "precondition_failed",
        "send_timeout",
        "response_timeout",
        "teardown_timeout",
        "output_timeout",
        "meter_timeout",
        "invalid_response",
        "notification_overflow",
        "input_closed",
        "input_error",
        "output_error",
        "internal_error",
      ],
      2: ["invalid_input", "file_error"],
      3: ["device_not_found", "multiple_devices", "identity_error", "not_connected", "connection_failed", "connection_lost", "discovery_timeout", "connect_timeout"],
      4: ["device_rejected"],
      130: ["interrupted"],
    };
    for (const [exit, codes] of Object.entries(expected)) {
      for (const code of codes) expect(baseExitCode(code), code).toBe(Number(exit));
    }
  });
});

describe("the result record (O9)", () => {
  it("is one JSON line with its four fields, non-ASCII text as UTF-8", () => {
    const line = jsonLine({ type: "result", command: "device list", data: { devices: [{ model: "名前\u0001" }] }, error: null });
    expect(line).toBe('{"type":"result","command":"device list","data":{"devices":[{"model":"名前\\u0001"}]},"error":null}\n');
    expect(JSON.parse(line)).toEqual({ type: "result", command: "device list", data: { devices: [{ model: "名前\u0001" }] }, error: null });
  });
});

describe("display escaping", () => {
  it("write C0, DEL and C1 controls as \\xHH and keep everything else", () => {
    expect(escapeForDisplay("a\u001b[2Jb\n\u007f\u0085")).toBe("a\\x1b[2Jb\\x0a\\x7f\\x85");
    expect(escapeForDisplay("URX44V 名前 \\x1b 😀")).toBe("URX44V 名前 \\x1b 😀");
  });
});

describe("lifecycle failures (E2)", () => {
  it("keep the cause and name the stage, and report a cancellation as interrupted", () => {
    expect(lifecycleFailure({ kind: "cause", code: "discovery_timeout", phase: "discovery" })).toEqual({
      code: "discovery_timeout",
      message: "Discovery did not finish within 10 seconds.",
    });
    expect(lifecycleFailure({ kind: "cause", code: "invalid_response", phase: "discovery" })).toEqual({
      code: "invalid_response",
      message: "A response could not be read during discovery.",
    });
    expect(lifecycleFailure({ kind: "cancelled", phase: "discovery" })).toEqual({ code: "interrupted", message: "Interrupted." });
  });
});
