import { operationFailureOf, type OperationCause } from "@urx/device-control/operations";
import { describe, expect, it } from "vitest";
import { NotificationRouter, type NativeNotifications } from "./notifications.js";
import { AddonTransport as Adapter, type NativeOperation, type NativeRequests, type NativeSubscription } from "./transport.js";

/** An adapter with a router of its own, for tests that route nothing. */
class AddonTransport extends Adapter {
  constructor(connection: NativeRequests, notifications: NotificationRouter = new NotificationRouter()) {
    super(connection, notifications);
  }
}

function native(overrides: Partial<NativeRequests> = {}) {
  const calls: unknown[][] = [];
  const operation: NativeOperation = { cancel: () => calls.push(["cancel"]), finish: () => calls.push(["finish"]) };
  const record = (name: string) => (...args: unknown[]) => (calls.push([name, ...args.slice(1)]), Promise.resolve({ name }));
  const connection: NativeRequests = {
    createOperation: () => operation,
    newRequestTicket: (() => {
      let next = 0;
      return () => `request-${++next}`;
    })(),
    getNumeric: record("getNumeric"),
    getText: record("getText"),
    getName: record("getName"),
    setNumeric: record("setNumeric"),
    setText: record("setText"),
    adoptResult: () => true,
    failDelivery: () => Promise.resolve(true),
    terminate: () => Promise.resolve(true),
    prepareSubscription: () => {
      throw new Error("not used by this test");
    },
    ...overrides,
  };
  return { connection, calls, operation };
}

const address = { paramId: 140, x: "0", y: "-1" };

describe("the addon transport", () => {
  it("forward each request with its native owner, ticket and address, and return the native record as it came", async () => {
    const { connection, calls } = native();
    const transport = new AddonTransport(connection);
    const operation = transport.createOperation();
    const request = { operation, requestTicket: transport.newRequestTicket() };
    expect(await transport.getNumeric(address, request)).toEqual({ name: "getNumeric" });
    await transport.getText(address, request);
    await transport.getName(address, request);
    await transport.setNumeric(address, "-5", request);
    await transport.setText(address, "Vocal", request);
    expect(calls).toEqual([
      ["getNumeric", request.requestTicket, 140, "0", "-1"],
      ["getText", request.requestTicket, 140, "0", "-1"],
      ["getName", request.requestTicket, 140, "0", "-1"],
      ["setNumeric", request.requestTicket, 140, "0", "-1", "-5"],
      ["setText", request.requestTicket, 140, "0", "-1", "Vocal"],
    ]);
    operation.cancel();
    operation.finish();
    expect(calls.slice(-2)).toEqual([["cancel"], ["finish"]]);
  });

  it("take tickets from the connection, so two adapters over one connection never share one", () => {
    const { connection } = native();
    const first = new AddonTransport(connection);
    const second = new AddonTransport(connection);
    const tickets = new Set(Array.from({ length: 500 }, () => [first.newRequestTicket(), second.newRequestTicket()]).flat());
    expect(tickets.size).toBe(1000);
  });

  it("reject a request whose operation another transport created, sending nothing", async () => {
    const { connection, calls } = native();
    const transport = new AddonTransport(connection);
    const foreign = new AddonTransport(native().connection).createOperation();
    await expect(transport.getNumeric(address, { operation: foreign, requestTicket: transport.newRequestTicket() })).rejects.toThrow();
    await expect(transport.setNumeric(address, "1", { operation: { cancel() {}, finish() {} }, requestTicket: "x" })).rejects.toThrow();
    expect(calls).toEqual([]);
  });

  it("turn a synchronous binding failure into a rejection", async () => {
    const transport = new AddonTransport(
      native({
        getNumeric: () => {
          throw new Error("binding");
        },
      }).connection,
    );
    const operation = transport.createOperation();
    await expect(transport.getNumeric(address, { operation, requestTicket: transport.newRequestTicket() })).rejects.toThrow("binding");
  });

  it("settle adoption and delivery reports from the native answer", async () => {
    await expect(new AddonTransport(native().connection).adoptResult("t")).resolves.toBeUndefined();
    await expect(new AddonTransport(native({ adoptResult: () => false }).connection).adoptResult("t")).rejects.toThrow();
    await expect(new AddonTransport(native().connection).failDelivery("t")).resolves.toBeUndefined();
    await expect(new AddonTransport(native({ failDelivery: () => Promise.resolve(false) }).connection).failDelivery("t")).rejects.toThrow();
    await expect(new AddonTransport(native({ terminate: () => Promise.resolve(false) }).connection).terminate("t")).resolves.toBeUndefined();
  });

});

const complete = { state: "complete", failure: null };
const success = { kind: "success", value: null };

/** A native subscription answering activation and release with the given records. */
function subscription(token: string, activation: unknown = success, release: unknown = success) {
  const calls: unknown[] = [];
  const native: NativeSubscription = {
    token,
    activate: (operation) => (calls.push(["activate", operation]), Promise.resolve(activation)),
    release: () => (calls.push(["release"]), Promise.resolve(release)),
  };
  return { native, calls };
}

/** A router bound to a connection that acknowledges every batch. */
function bound() {
  const router = new NotificationRouter();
  const native: NativeNotifications = { adoptNotifications: () => true, close: () => Promise.resolve(success) };
  router.bind(native);
  return router;
}

const batch = (ticket: string, recipients: string[], value: string) => ({
  generation: "1",
  batchTicket: ticket,
  records: [{ recipients, receivedAtMs: "1700000000000", payload: { kind: "numeric", paramId: 140, x: "0", y: "-1", value } }],
});

const failureOf = (promise: Promise<unknown>) => promise.then(
  () => undefined,
  (error: unknown) => operationFailureOf(error),
);

describe("subscriptions through the addon transport", () => {
  it("admit parameter addresses with their family, and deliver the token's notifications from activation until release", async () => {
    const admitted: unknown[] = [];
    const { native: sub, calls } = subscription("token-1");
    const { connection, operation } = native({ prepareSubscription: (addresses) => (admitted.push(addresses), { kind: "success", value: sub }) });
    const router = bound();
    const transport = new AddonTransport(connection, router);
    const delivered: unknown[] = [];
    const handle = transport.prepareSubscription([address], transport.createOperation(), (notification) => delivered.push(notification));
    expect(admitted).toEqual([[{ family: "parameter", paramId: 140, x: "0", y: "-1" }]]);
    router.receive(batch("batch-1", ["token-1"], "1"));
    expect(delivered).toEqual([]);
    await handle.activate();
    expect(calls).toEqual([["activate", operation]]);
    router.receive(batch("batch-2", ["token-1"], "2"));
    expect(delivered).toEqual([{ kind: "numeric", address, value: "2" }]);
    const releases = [handle.release(), handle.release()];
    expect(releases[0]).toBe(releases[1]);
    await Promise.all(releases);
    router.receive(batch("batch-3", ["token-1"], "3"));
    expect(delivered).toHaveLength(1);
    expect(calls).toEqual([["activate", operation], ["release"]]);
  });

  it("throw an admission refusal with its cause and cleanup", () => {
    const refusal = { kind: "failure", failure: { kind: "cause", code: "precondition_failed", phase: "admission", request: null }, cleanup: complete };
    const transport = new AddonTransport(native({ prepareSubscription: () => refusal }).connection);
    let thrown: unknown;
    try {
      transport.prepareSubscription([address], transport.createOperation(), () => {});
    } catch (error) {
      thrown = error;
    }
    expect(operationFailureOf(thrown)).toEqual({ code: "precondition_failed", phase: "admission", progress: { cleanup: complete } });
  });

  it("refuse an untrusted admission as internal_error: a foreign operation, a binding failure or an invalid record", () => {
    const internal = { code: "internal_error", phase: "admission", progress: null };
    const attempt = (transport: Adapter, operation = transport.createOperation()) => {
      try {
        transport.prepareSubscription([address], operation, () => {});
      } catch (error) {
        return operationFailureOf(error);
      }
      return undefined;
    };
    let admitted = 0;
    const counting = native({ prepareSubscription: () => (admitted++, { kind: "success", value: subscription("token-1").native }) }).connection;
    expect(attempt(new AddonTransport(counting), new AddonTransport(native().connection).createOperation())).toEqual(internal);
    expect(admitted).toBe(0);
    expect(attempt(new AddonTransport(native().connection))).toEqual(internal);
    for (const record of [null, { kind: "success", value: { token: "", activate() {}, release() {} } }, { kind: "success", value: { token: "t" } }, { kind: "failure" }]) {
      expect(attempt(new AddonTransport(native({ prepareSubscription: () => record }).connection)), JSON.stringify(record)).toEqual(internal);
    }
  });

  it("give up a subscription whose token is already routed", () => {
    const first = subscription("token-1");
    const second = subscription("token-1");
    const subs = [first.native, second.native];
    const transport = new AddonTransport(native({ prepareSubscription: () => ({ kind: "success", value: subs.shift() }) }).connection);
    transport.prepareSubscription([address], transport.createOperation(), () => {});
    expect(() => transport.prepareSubscription([address], transport.createOperation(), () => {})).toThrow();
    expect(second.calls).toEqual([["release"]]);
  });

  it("reject a failed activation or release with its cause, and an untrusted record as internal_error", async () => {
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "subscription", request: null }, cleanup: complete };
    const lost = {
      kind: "failure",
      failure: { kind: "cause", code: "connection_lost", phase: "subscription", request: null },
      cleanup: { state: "connection_closed", failure: null },
    };
    const make = (activation: unknown, release: unknown = success) => {
      const sub = subscription("token-1", activation, release).native;
      const transport = new AddonTransport(native({ prepareSubscription: () => ({ kind: "success", value: sub }) }).connection);
      return transport.prepareSubscription([address], transport.createOperation(), () => {});
    };
    expect(await failureOf(make(rejected).activate())).toEqual({ code: "device_rejected", phase: "response", progress: { cleanup: complete } });
    expect(await failureOf(make(success, lost).release())).toEqual({
      code: "connection_lost",
      phase: "send",
      progress: { cleanup: { state: "connection_closed", failure: null } },
    });
    const cancelled = { kind: "failure", failure: { kind: "cancelled", phase: "subscription" }, cleanup: complete };
    // A cancellation with no cause given reports internal_error, marked.
    expect(await failureOf(make(cancelled).activate())).toEqual({ code: "internal_error", phase: "send", progress: { cleanup: complete }, cancelled: true });
    // Only a cancellation is marked.
    expect(await failureOf(make(rejected).activate())).not.toHaveProperty("cancelled");
    for (const record of [{ kind: "success", value: 1 }, {}, null]) {
      expect(await failureOf(make(record).activate()), JSON.stringify(record)).toEqual({ code: "internal_error", phase: "send", progress: null });
    }
  });

  it("place a registration's own failure at the phase of its request where the record names one", async () => {
    const make = (activation: unknown) => {
      const sub = subscription("token-1", activation).native;
      const transport = new AddonTransport(native({ prepareSubscription: () => ({ kind: "success", value: sub }) }).connection);
      return transport.prepareSubscription([address], transport.createOperation(), () => {});
    };
    const failed = (code: string, request: string | null, cleanup: unknown = complete) => ({
      kind: "failure",
      failure: { kind: "cause", code, phase: "subscription", request },
      cleanup,
    });
    // A lost link while the reply was awaited is at the response, not at the send its cause would suggest.
    expect(await failureOf(make(failed("connection_lost", "response", { state: "connection_closed", failure: null })).activate())).toMatchObject({
      code: "connection_lost",
      phase: "response",
    });
    expect(await failureOf(make(failed("response_timeout", "delivery")).activate())).toMatchObject({ code: "response_timeout", phase: "delivery" });
    // Without a request phase, the cause places it.
    expect(await failureOf(make(failed("connection_lost", null, { state: "connection_closed", failure: null })).activate())).toMatchObject({ phase: "send" });
    // A request phase outside a subscription call is not a record the adapter trusts.
    const admission = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "admission", request: "response" }, cleanup: complete };
    expect(await failureOf(make(admission).activate())).toEqual({ code: "internal_error", phase: "send", progress: null });
  });

  it("report a cancelled activation or admission with the first cause its operation's owner gave cancel", async () => {
    const cancelled = { kind: "failure", failure: { kind: "cancelled", phase: "subscription" }, cleanup: complete };
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "subscription", request: null }, cleanup: complete };
    const activated = (activation: unknown, causes: readonly (OperationCause | undefined)[]) => {
      const sub = subscription("token-1", activation).native;
      const transport = new AddonTransport(native({ prepareSubscription: () => ({ kind: "success", value: sub }) }).connection);
      const operation = transport.createOperation();
      const prepared = transport.prepareSubscription([address], operation, () => {});
      for (const cause of causes) operation.cancel(cause);
      return failureOf(prepared.activate());
    };
    expect(await activated(cancelled, ["interrupted"])).toEqual({ code: "interrupted", phase: "send", progress: { cleanup: complete }, cancelled: true });
    // The first cause given stays; a cancel with none before it gives none.
    expect(await activated(cancelled, ["response_timeout", "interrupted"])).toMatchObject({ code: "response_timeout", cancelled: true });
    expect(await activated(cancelled, [undefined, "interrupted"])).toMatchObject({ code: "interrupted", cancelled: true });
    // A call's own failure keeps its cause and carries no mark, whatever the owner gave.
    const own = await activated(rejected, ["interrupted"]);
    expect(own).toEqual({ code: "device_rejected", phase: "response", progress: { cleanup: complete } });
    // An admission the cancellation refused names the cause too.
    const transport = new AddonTransport(native({ prepareSubscription: () => cancelled }).connection);
    const operation = transport.createOperation();
    operation.cancel("interrupted");
    let refused: unknown;
    try {
      transport.prepareSubscription([address], operation, () => {});
    } catch (error) {
      refused = operationFailureOf(error);
    }
    expect(refused).toMatchObject({ code: "interrupted", cancelled: true });
  });
});
