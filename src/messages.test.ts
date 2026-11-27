import { describe, expect, it } from "vitest";
import { operationFailure } from "./messages.js";

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
  });
});
