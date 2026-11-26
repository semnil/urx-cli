// Routing the addon's notification batches to the CLI's subscriptions (K12,
// K37). The addon hands over one batch at a time and forms the next only once
// this one is acknowledged. The router validates the whole batch, hands each
// record to the active routes of its recipient tokens in receive order, and
// then acknowledges it. A batch it cannot validate or fully hand over is never
// acknowledged: the connection is closed instead, so no unadopted record is
// reported as adopted.

import { isI64Text, isU32, type I64Text } from "@urx/device-control/catalog";
import type { TransportNotification } from "@urx/device-control/operations";

/** One routed notification and its PC receipt time (K37). */
export interface RoutedNotification {
  readonly notification: TransportNotification;
  /** Milliseconds since the Unix epoch, within the JavaScript Date range. */
  readonly receivedAtMs: I64Text;
}

export type Deliver = (routed: RoutedNotification) => void;

/** The addon connection calls the router makes. */
export interface NativeNotifications {
  adoptNotifications(batchTicket: string): boolean;
  close(): Promise<unknown>;
}

/** One token's route: inactive until started, and gone once stopped. */
export interface Route {
  /** Starts handing this token's records to its consumer; nothing once stopped. */
  start(): void;
  /** Stops for good; later records for the token are not handed over. */
  stop(): void;
}

interface Batch {
  readonly generation: I64Text;
  readonly batchTicket: string;
  readonly records: readonly { readonly recipients: readonly string[]; readonly routed: RoutedNotification }[];
}

type Fields = Readonly<Record<string, unknown>>;

function hasExactly(value: unknown, keys: readonly string[]): value is Fields {
  if (typeof value !== "object" || value === null || Object.getPrototypeOf(value) !== Object.prototype) return false;
  const own = Object.keys(value);
  return own.length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

/** The largest |milliseconds| a JavaScript Date can represent. */
const DATE_RANGE_MS = 8_640_000_000_000_000n;

function receiptTime(value: unknown): I64Text | undefined {
  if (!isI64Text(value)) return undefined;
  const ms = BigInt(value);
  return ms >= -DATE_RANGE_MS && ms <= DATE_RANGE_MS ? value : undefined;
}

/** A K37 payload as the common package names it, or undefined when invalid. */
function notificationOf(payload: unknown): TransportNotification | undefined {
  if (hasExactly(payload, ["kind", "paramId", "x", "y", "value"])) {
    const { kind, paramId, x, y, value } = payload;
    if (!isU32(paramId) || !isI64Text(x) || !isI64Text(y)) return undefined;
    const address = { paramId, x, y };
    if (kind === "numeric" && isI64Text(value)) return { kind, address, value };
    if (kind === "text" && typeof value === "string") return { kind, address, value };
    return undefined;
  }
  if (hasExactly(payload, ["kind", "meterId", "x", "value"])) {
    const { kind, meterId, x, value } = payload;
    return kind === "meter" && isU32(meterId) && isI64Text(x) && isI64Text(value) ? { kind, meterId, x, value } : undefined;
  }
  if (hasExactly(payload, ["kind"]) && payload.kind === "bulk_change") return { kind: "bulk-change" };
  return undefined;
}

/** A complete valid batch, or undefined: there is no partly valid batch. */
function batchOf(value: unknown): Batch | undefined {
  if (!hasExactly(value, ["generation", "batchTicket", "records"])) return undefined;
  const { generation, batchTicket, records } = value;
  if (!isI64Text(generation) || typeof batchTicket !== "string" || batchTicket === "" || !Array.isArray(records)) return undefined;
  const parsed: Batch["records"][number][] = [];
  for (const record of records as unknown[]) {
    if (!hasExactly(record, ["recipients", "receivedAtMs", "payload"])) return undefined;
    const { recipients, receivedAtMs, payload } = record;
    // Recipients are the eligible tokens, never none and each once.
    if (!Array.isArray(recipients) || recipients.length === 0) return undefined;
    if (!recipients.every((token) => typeof token === "string" && token !== "") || new Set(recipients).size !== recipients.length) return undefined;
    const time = receiptTime(receivedAtMs);
    const notification = notificationOf(payload);
    if (time === undefined || notification === undefined) return undefined;
    parsed.push({ recipients: recipients as string[], routed: { notification, receivedAtMs: time } });
  }
  return { generation, batchTicket, records: parsed };
}

interface RouteState {
  readonly deliver: Deliver;
  active: boolean;
}

/** Ends `connection`, joining any close already running; never throws. */
function end(connection: NativeNotifications): void {
  try {
    // Its outcome is the CLI's own close's, which joins this one.
    connection.close().catch(() => undefined);
  } catch {
    // A binding failure leaves the CLI's own close to end the connection.
  }
}

export class NotificationRouter {
  #connection: NativeNotifications | undefined;
  /** Batches that arrived before `bind`; the addon delivers at most one unacknowledged. */
  #early: unknown[] = [];
  readonly #routes = new Map<string, RouteState>();
  #generation: I64Text | undefined;
  /** Set once a batch could not be handed over; the connection is then closing. */
  #failed = false;

  /**
   * The function the addon calls with each batch. It never throws: the
   * addon has no channel for an exception, and one would end the process.
   */
  readonly receive = (batch: unknown): void => {
    try {
      this.#receive(batch);
    } catch {
      this.#fail();
    }
  };

  /** Attaches the opened connection; batches that came before it are handled now. */
  bind(connection: NativeNotifications): void {
    if (this.#connection !== undefined) throw new Error("the router is already bound");
    this.#connection = connection;
    if (this.#failed) {
      end(connection);
      return;
    }
    const early = this.#early;
    this.#early = [];
    for (const batch of early) this.receive(batch);
  }

  /**
   * Installs the route of `token`, inactive until started. A token already
   * routed is refused; the addon never issues a token name twice.
   */
  route(token: string, deliver: Deliver): Route {
    if (this.#routes.has(token)) throw new Error("the token is already routed");
    const state: RouteState = { deliver, active: false };
    this.#routes.set(token, state);
    return {
      start: () => {
        if (!this.#failed && this.#routes.get(token) === state) state.active = true;
      },
      stop: () => {
        state.active = false;
        if (this.#routes.get(token) === state) this.#routes.delete(token);
      },
    };
  }

  #receive(raw: unknown): void {
    if (this.#failed) return;
    const connection = this.#connection;
    if (connection === undefined) {
      this.#early.push(raw);
      return;
    }
    const batch = batchOf(raw);
    // One router serves one connection, whose batches share one generation.
    if (batch === undefined || (this.#generation !== undefined && batch.generation !== this.#generation)) {
      this.#fail();
      return;
    }
    this.#generation = batch.generation;
    for (const record of batch.records) {
      for (const token of record.recipients) {
        const route = this.#routes.get(token);
        if (route?.active === true) route.deliver(record.routed);
      }
    }
    if (!connection.adoptNotifications(batch.batchTicket)) this.#fail();
  }

  /** Stops delivery and ends the connection, without acknowledging the batch. */
  #fail(): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#early = [];
    for (const route of this.#routes.values()) route.active = false;
    if (this.#connection !== undefined) end(this.#connection);
  }
}
