import { operationFailureOf } from "@urx/device-control/operations";
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
  it("cancel every operation it created and has not finished, and none it finished", () => {
    const made: { name: string; calls: string[] }[] = [];
    const connection = native({
      createOperation: () => {
        const entry = { name: `operation-${made.length + 1}`, calls: [] as string[] };
        made.push(entry);
        return { cancel: () => entry.calls.push("cancel"), finish: () => entry.calls.push("finish") };
      },
    }).connection;
    const transport = new AddonTransport(connection);
    const first = transport.createOperation();
    const second = transport.createOperation();
    const third = transport.createOperation();
    third.finish();
    transport.cancelAll("interrupted");
    expect(made.map((entry) => [entry.name, entry.calls])).toEqual([
      ["operation-1", ["cancel"]],
      ["operation-2", ["cancel"]],
      ["operation-3", ["finish"]],
    ]);
    // A cancelled operation is still finished by its owner, and is then not cancelled again.
    first.finish();
    second.finish();
    transport.cancelAll("interrupted");
    expect(made.map((entry) => entry.calls.length)).toEqual([2, 2, 1]);
  });

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
    const refusal = { kind: "failure", failure: { kind: "cause", code: "precondition_failed", phase: "admission" }, cleanup: complete };
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

  it("report a subscription call cancelled by cancelAll with the cause it was cancelled for, and the first cause only", async () => {
    const cancelled = { kind: "failure", failure: { kind: "cancelled", phase: "subscription" }, cleanup: complete };
    const sub = subscription("token-1", cancelled).native;
    const transport = new AddonTransport(native({ prepareSubscription: () => ({ kind: "success", value: sub }) }).connection);
    const operation = transport.createOperation();
    const handle = transport.prepareSubscription([address], operation, () => {});
    transport.cancelAll("interrupted");
    transport.cancelAll("internal_error");
    expect(await failureOf(handle.activate())).toEqual({ code: "interrupted", phase: "send", progress: { cleanup: complete } });
    // An admission refused as cancelled after cancelAll reports that cause too.
    const refusing = new AddonTransport(native({ prepareSubscription: () => ({ kind: "failure", failure: { kind: "cancelled", phase: "admission" }, cleanup: complete }) }).connection);
    const owner = refusing.createOperation();
    refusing.cancelAll("interrupted");
    let thrown: unknown;
    try {
      refusing.prepareSubscription([address], owner, () => {});
    } catch (error) {
      thrown = error;
    }
    expect(operationFailureOf(thrown)).toEqual({ code: "interrupted", phase: "admission", progress: { cleanup: complete } });
    // A cancellation no cancelAll asked for stays internal_error: the adapter knows no other cause.
    const other = new AddonTransport(native({ prepareSubscription: () => ({ kind: "success", value: subscription("token-2", cancelled).native }) }).connection);
    const own = other.createOperation();
    const unasked = other.prepareSubscription([address], own, () => {});
    own.cancel();
    expect(await failureOf(unasked.activate())).toEqual({ code: "internal_error", phase: "send", progress: { cleanup: complete } });
  });

  it("reject a failed activation or release with its cause, and an untrusted record as internal_error", async () => {
    const rejected = { kind: "failure", failure: { kind: "cause", code: "device_rejected", phase: "subscription" }, cleanup: complete };
    const lost = {
      kind: "failure",
      failure: { kind: "cause", code: "connection_lost", phase: "subscription" },
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
    expect(await failureOf(make(cancelled).activate())).toEqual({ code: "internal_error", phase: "send", progress: { cleanup: complete } });
    for (const record of [{ kind: "success", value: 1 }, {}, null]) {
      expect(await failureOf(make(record).activate()), JSON.stringify(record)).toEqual({ code: "internal_error", phase: "send", progress: null });
    }
  });
});
