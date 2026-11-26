import { describe, expect, it } from "vitest";
import { NotificationRouter, type NativeNotifications, type RoutedNotification } from "./notifications.js";

function connection(adopts = true) {
  const adopted: string[] = [];
  let closes = 0;
  const native: NativeNotifications = {
    adoptNotifications: (ticket) => (adopted.push(ticket), adopts),
    close: () => (closes++, Promise.resolve({ kind: "success", value: null })),
  };
  return { native, adopted, closes: () => closes };
}

const at = "1700000000000";
const numeric = (value: string) => ({ kind: "numeric", paramId: 895, x: "0", y: "0", value });
const record = (recipients: string[], payload: unknown = numeric("1"), receivedAtMs: unknown = at) => ({ recipients, receivedAtMs, payload });
const batch = (batchTicket: string, records: unknown[], generation = "1") => ({ generation, batchTicket, records });

/** A bound router with one started route per token, recording what each receives. */
function routed(tokens: string[], native = connection()) {
  const router = new NotificationRouter();
  router.bind(native.native);
  const received: [string, RoutedNotification][] = [];
  for (const token of tokens) router.route(token, (routed) => received.push([token, routed])).start();
  return { router, received, ...native };
}

describe("notification routing (K12, K37)", () => {
  it("hand each record to its recipients in receive order, then acknowledge the batch", () => {
    const { router, received, adopted } = routed(["token-1", "token-2"]);
    router.receive(batch("batch-1", [record(["token-1"], numeric("1")), record(["token-2", "token-1"], numeric("2"))]));
    router.receive(batch("batch-2", [record(["token-2"], numeric("3"))]));
    const address = { paramId: 895, x: "0", y: "0" };
    expect(received).toEqual([
      ["token-1", { notification: { kind: "numeric", address, value: "1" }, receivedAtMs: at }],
      ["token-2", { notification: { kind: "numeric", address, value: "2" }, receivedAtMs: at }],
      ["token-1", { notification: { kind: "numeric", address, value: "2" }, receivedAtMs: at }],
      ["token-2", { notification: { kind: "numeric", address, value: "3" }, receivedAtMs: at }],
    ]);
    expect(adopted).toEqual(["batch-1", "batch-2"]);
  });

  it("name every payload variant as the common package does", () => {
    const { router, received } = routed(["t"]);
    router.receive(
      batch("b", [
        record(["t"], { kind: "text", paramId: 1, x: "-1", y: "9223372036854775807", value: "" }),
        record(["t"], { kind: "meter", meterId: 7, x: "-1", value: "-120" }),
        record(["t"], { kind: "bulk_change" }),
      ]),
    );
    expect(received.map(([, routed]) => routed.notification)).toEqual([
      { kind: "text", address: { paramId: 1, x: "-1", y: "9223372036854775807" }, value: "" },
      { kind: "meter", meterId: 7, x: "-1", value: "-120" },
      { kind: "bulk-change" },
    ]);
  });

  it("acknowledge a record no started route takes, and an empty batch, without handing anything over", () => {
    const { router, received, adopted } = routed([]);
    const route = router.route("t", () => {
      throw new Error("not started");
    });
    router.receive(batch("b1", [record(["t"]), record(["unknown"])]));
    router.receive(batch("b2", []));
    route.stop();
    route.start();
    router.receive(batch("b3", [record(["t"])]));
    expect(received).toEqual([]);
    expect(adopted).toEqual(["b1", "b2", "b3"]);
  });

  it("close the connection without acknowledging an invalid batch, and hand nothing over afterwards", () => {
    const invalid: unknown[] = [
      null,
      [],
      batch("", [record(["t"])]),
      batch("b", [record([])]),
      batch("b", [record(["t", "t"])]),
      batch("b", [record([""])]),
      batch("b", [record(["t"], numeric("1"), "8640000000000001")]),
      batch("b", [record(["t"], numeric("1"), 1)]),
      batch("b", [record(["t"], numeric("01"))]),
      batch("b", [record(["t"], { kind: "numeric", paramId: -1, x: "0", y: "0", value: "1" })]),
      batch("b", [record(["t"], { kind: "numeric", paramId: 1, x: "0", y: "0", value: 1 })]),
      batch("b", [record(["t"], { kind: "text", paramId: 1, x: "0", y: "0", value: 1 })]),
      batch("b", [record(["t"], { kind: "meter", meterId: 1, x: "0", value: "1", extra: 1 })]),
      batch("b", [record(["t"], { kind: "bulk-change" })]),
      batch("b", [record(["t"], { kind: "other" })]),
      { ...batch("b", [record(["t"])]), extra: 1 },
      batch("b", [record(["t"])], "1.0"),
    ];
    for (const raw of invalid) {
      const { router, received, adopted, closes } = routed(["t"]);
      router.receive(raw);
      router.receive(batch("later", [record(["t"])]));
      expect({ received, adopted, closes: closes() }, JSON.stringify(raw)).toEqual({ received: [], adopted: [], closes: 1 });
    }
  });

  it("close the connection when a batch carries another generation", () => {
    const { router, received, adopted, closes } = routed(["t"]);
    router.receive(batch("b1", [record(["t"])], "1"));
    router.receive(batch("b2", [record(["t"])], "2"));
    expect(received).toHaveLength(1);
    expect(adopted).toEqual(["b1"]);
    expect(closes()).toBe(1);
  });

  it("close the connection without acknowledging when a consumer throws or the acknowledgment is refused", () => {
    const throwing = routed([]);
    throwing.router.route("t", () => {
      throw new Error("consumer");
    }).start();
    expect(() => throwing.router.receive(batch("b", [record(["t"])]))).not.toThrow();
    expect(throwing.adopted).toEqual([]);
    expect(throwing.closes()).toBe(1);
    const refused = routed(["t"], connection(false));
    refused.router.receive(batch("b1", [record(["t"])]));
    refused.router.receive(batch("b2", [record(["t"])]));
    expect(refused.adopted).toEqual(["b1"]);
    expect(refused.received).toHaveLength(1);
    expect(refused.closes()).toBe(1);
  });

  it("never throw from the addon's call, even when closing fails", () => {
    const router = new NotificationRouter();
    router.bind({
      adoptNotifications: () => true,
      close: () => {
        throw new Error("binding");
      },
    });
    expect(() => router.receive(null)).not.toThrow();
    const rejecting = new NotificationRouter();
    rejecting.bind({ adoptNotifications: () => true, close: () => Promise.reject(new Error("closed")) });
    expect(() => rejecting.receive(null)).not.toThrow();
  });

  it("handle a batch that came before the connection was bound once it is", () => {
    const router = new NotificationRouter();
    const received: RoutedNotification[] = [];
    router.route("t", (routed) => received.push(routed)).start();
    router.receive(batch("b", [record(["t"])]));
    expect(received).toEqual([]);
    const native = connection();
    router.bind(native.native);
    expect(received).toHaveLength(1);
    expect(native.adopted).toEqual(["b"]);
    expect(() => router.bind(native.native)).toThrow();
  });

  it("refuse a token already routed, and reclaim a stopped route", () => {
    const { router } = routed(["t"]);
    expect(() => router.route("t", () => {})).toThrow();
    const route = router.route("u", () => {});
    route.stop();
    expect(() => router.route("u", () => {})).not.toThrow();
  });
});
