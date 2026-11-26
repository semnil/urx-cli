import { describe, expect, it } from "vitest";
import { AddonTransport, type NativeOperation, type NativeRequests } from "./transport.js";

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

  it("refuse a subscription admission by throwing", () => {
    const transport = new AddonTransport(native().connection);
    expect(() => transport.prepareSubscription([address], transport.createOperation(), () => {})).toThrow();
  });
});
