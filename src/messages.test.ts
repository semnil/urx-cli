import { describe, expect, it } from "vitest";
import { laterFailure, operationFailure } from "./messages.js";

describe("a shared operation's failure message", () => {
  it("say of a send that did not finish only that it was attempted, never that the request was sent", () => {
    const at = (code: "send_timeout" | "connection_lost" | "internal_error") => operationFailure({ code, phase: "send", progress: null }).message;
    expect(at("send_timeout")).toBe("A request could not be sent within 3 seconds during the attempt to send the request.");
    expect(at("connection_lost")).toBe("The connection was lost during the attempt to send the request.");
    expect(at("internal_error")).toBe("An internal error occurred during the attempt to send the request.");
  });

  it("name the stage of every other phase without claiming more than it", () => {
    const at = (phase: "admission" | "response" | "delivery") => operationFailure({ code: "internal_error", phase, progress: null }).message;
    expect(at("admission")).toBe("An internal error occurred before the request was sent.");
    expect(at("response")).toBe("An internal error occurred while its response was awaited.");
    expect(at("delivery")).toBe("An internal error occurred while its result was handed back.");
    // A preparation may follow requests of its own, such as the Console Lock guard's.
    expect(operationFailure({ code: "precondition_failed", phase: "preparation", progress: null }).message).toBe(
      "A required condition was not met while the operation was being prepared.",
    );
  });
});

describe("a cause found after an operation's first stop", () => {
  it("name a request's phase as an operation failure does, and a lifecycle phase as a lifecycle failure does", () => {
    expect(laterFailure({ code: "device_rejected", phase: "response" }).message).toBe("The device rejected the request while its response was awaited.");
    // A cleanup failure whose record names no request is placed at its lifecycle phase.
    expect(laterFailure({ code: "connection_lost", phase: "subscription" }).message).toBe("The connection was lost while registering for notifications.");
    expect(laterFailure({ code: "teardown_timeout", phase: "subscription" })).toEqual(operationFailure({ code: "teardown_timeout", phase: "send", progress: null }));
  });
});
