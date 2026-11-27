// urx-device's connection-bound Transport (K2, K37) over one addon
// connection. Each request method returns the native K34 record as it came;
// urx-device's operations validate it before adopting anything. Subscription
// lifecycle records are validated here, and their failures thrown as
// urx-device's OperationFailureError.

import {
  OperationFailureError,
  validateLifecycle,
  type Cleanup,
  type LifecycleFailure,
  type OperationCause,
  type OperationPhase,
  type ParameterAddress,
  type Transport,
  type TransportNotification,
  type TransportOperation,
  type TransportRequest,
  type TransportSubscription,
} from "@urx/device-control/operations";
import type { NotificationRouter, Route } from "./notifications.js";

/** The addon's per-operation owner (K37). */
export interface NativeOperation {
  cancel(): void;
  finish(): void;
}

/** The request and subscription side of the addon's connection object. */
export interface NativeRequests {
  createOperation(): NativeOperation;
  /** A ticket the connection never issued before, whichever adapter asks. */
  newRequestTicket(): string;
  getNumeric(operation: NativeOperation, ticket: string, paramId: number, x: string, y: string): Promise<unknown>;
  getText(operation: NativeOperation, ticket: string, paramId: number, x: string, y: string): Promise<unknown>;
  getName(operation: NativeOperation, ticket: string, paramId: number, x: string, y: string): Promise<unknown>;
  setNumeric(operation: NativeOperation, ticket: string, paramId: number, x: string, y: string, value: string): Promise<unknown>;
  setText(operation: NativeOperation, ticket: string, paramId: number, x: string, y: string, value: string): Promise<unknown>;
  adoptResult(ticket: string): boolean;
  failDelivery(ticket: string): Promise<boolean>;
  terminate(ticket: string): Promise<boolean>;
  /** Admits a subscription locally (K11), with no traffic; returns its lifecycle record at once. */
  prepareSubscription(addresses: readonly NativeSubscriptionAddress[]): unknown;
}

/** A subscription address as the addon takes it (K37). */
export type NativeSubscriptionAddress =
  | { readonly family: "parameter"; readonly paramId: number; readonly x: string; readonly y: string }
  | { readonly family: "meter"; readonly meterId: number; readonly x: string };

/** The addon's subscription object (K37). */
export interface NativeSubscription {
  /** The token its notification records name as a recipient. */
  readonly token: string;
  activate(operation: NativeOperation): Promise<unknown>;
  release(): Promise<unknown>;
}

/** The evidence a failed subscription call carries: how far its cleanup got (K37). */
export interface SubscriptionProgress {
  readonly cleanup: Cleanup;
}

const REQUEST_CAUSES: readonly string[] = [
  "invalid_input",
  "precondition_failed",
  "not_connected",
  "send_timeout",
  "response_timeout",
  "teardown_timeout",
  "device_rejected",
  "invalid_response",
  "connection_lost",
  "notification_overflow",
  "internal_error",
];

/**
 * Where a subscription call stopped, as an operation phase. Admission is its
 * own phase. Registration and unregistration requests are native-owned, so
 * their record names the lifecycle phase only; the operation phase follows
 * the cause as K34 places it: causes before sending at admission, a send
 * deadline, a lost link or a cancellation while sending, a verdict or its
 * absence at the response, and the remaining causes at delivery.
 */
function phaseOf(failure: LifecycleFailure): OperationPhase {
  if (failure.phase === "admission") return "admission";
  if (failure.kind === "cancelled") return "send";
  switch (failure.code) {
    case "invalid_input":
    case "precondition_failed":
    case "not_connected":
      return "admission";
    case "send_timeout":
    case "connection_lost":
    case "teardown_timeout":
      return "send";
    case "device_rejected":
    case "response_timeout":
    case "invalid_response":
      return "response";
    default:
      return "delivery";
  }
}

/**
 * The structured failure of a subscription call's failure record. A
 * cancellation reports internal_error: the adapter does not know the owner's
 * stopping cause, and K34 invents none.
 */
function subscriptionFailure(failure: LifecycleFailure, cleanup: Cleanup): OperationFailureError<SubscriptionProgress> {
  const code: OperationCause = failure.kind === "cause" && REQUEST_CAUSES.includes(failure.code) ? (failure.code as OperationCause) : "internal_error";
  return new OperationFailureError({ code, phase: phaseOf(failure), progress: { cleanup } });
}

/** A record or a binding failure the adapter cannot trust: nothing is known of its effect. */
const untrusted = (phase: OperationPhase) => new OperationFailureError({ code: "internal_error", phase, progress: null });

/** Validates a subscription call's unit record; throws its failure. */
async function settleUnit(call: () => Promise<unknown>, phase: OperationPhase): Promise<void> {
  let record: unknown;
  try {
    record = await call();
  } catch {
    throw untrusted(phase);
  }
  const outcome = validateLifecycle(record, (value) => (value === null ? null : undefined));
  if (outcome === undefined) throw untrusted(phase);
  if (outcome.kind === "failure") throw subscriptionFailure(outcome.failure, outcome.cleanup);
}

const isNativeSubscription = (value: unknown): value is NativeSubscription => {
  const candidate = value as Partial<Record<keyof NativeSubscription, unknown>> | null;
  return (
    typeof value === "object" &&
    value !== null &&
    typeof candidate?.token === "string" &&
    candidate.token !== "" &&
    typeof candidate.activate === "function" &&
    typeof candidate.release === "function"
  );
};

/**
 * One admitted subscription. Its route is installed before activation and
 * started when activation is called; release stops it before anything else,
 * so no record reaches the consumer once release has been called.
 */
class AdapterSubscription implements TransportSubscription {
  readonly #native: NativeSubscription;
  readonly #operation: NativeOperation;
  readonly #route: Route;
  #released: Promise<void> | undefined;

  constructor(native: NativeSubscription, operation: NativeOperation, route: Route) {
    this.#native = native;
    this.#operation = operation;
    this.#route = route;
  }

  activate(): Promise<void> {
    this.#route.start();
    return settleUnit(() => this.#native.activate(this.#operation), "send");
  }

  release(): Promise<void> {
    this.#released ??= (() => {
      this.#route.stop();
      return settleUnit(() => this.#native.release(), "send");
    })();
    return this.#released;
  }
}

/** The TransportOperation the adapter hands out, keeping its native owner. */
class AdapterOperation implements TransportOperation {
  readonly #finished: (operation: AdapterOperation) => void;
  constructor(
    readonly native: NativeOperation,
    finished: (operation: AdapterOperation) => void,
  ) {
    this.#finished = finished;
  }
  cancel(): void {
    this.native.cancel();
  }
  finish(): void {
    this.#finished(this);
    this.native.finish();
  }
}

export class AddonTransport implements Transport {
  readonly #connection: NativeRequests;
  readonly #notifications: NotificationRouter;
  /** The operations this transport created; no other is forwarded to its connection. */
  readonly #operations = new WeakSet<AdapterOperation>();
  /** The operations this transport created that are not finished yet. */
  readonly #open = new Set<AdapterOperation>();

  /** `notifications` is the router `connection` was opened with. */
  constructor(connection: NativeRequests, notifications: NotificationRouter) {
    this.#connection = connection;
    this.#notifications = notifications;
  }

  createOperation(): TransportOperation {
    const operation = new AdapterOperation(this.#connection.createOperation(), (finished) => this.#open.delete(finished));
    this.#operations.add(operation);
    this.#open.add(operation);
    return operation;
  }

  /**
   * Cancels every operation this transport created and has not finished,
   * those that operations of its own create (a write guard's) included: a
   * request still waiting is completed unsent, one already sent settles as
   * it would. Releasing what was registered is not an operation's and is
   * not stopped.
   */
  cancelAll(): void {
    for (const operation of [...this.#open]) operation.cancel();
  }

  /** Issued by the connection, so two adapters over one connection never share a ticket. */
  newRequestTicket(): string {
    return this.#connection.newRequestTicket();
  }

  getNumeric(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#call((operation) => this.#connection.getNumeric(operation, request.requestTicket, address.paramId, address.x, address.y), request);
  }

  getText(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#call((operation) => this.#connection.getText(operation, request.requestTicket, address.paramId, address.x, address.y), request);
  }

  getName(address: ParameterAddress, request: TransportRequest): Promise<unknown> {
    return this.#call((operation) => this.#connection.getName(operation, request.requestTicket, address.paramId, address.x, address.y), request);
  }

  setNumeric(address: ParameterAddress, value: string, request: TransportRequest): Promise<unknown> {
    return this.#call((operation) => this.#connection.setNumeric(operation, request.requestTicket, address.paramId, address.x, address.y, value), request);
  }

  setText(address: ParameterAddress, value: string, request: TransportRequest): Promise<unknown> {
    return this.#call((operation) => this.#connection.setText(operation, request.requestTicket, address.paramId, address.x, address.y, value), request);
  }

  /**
   * Admits a subscription to parameter `addresses` (K11); a refusal throws
   * its structured failure. Nothing is sent until `activate`.
   */
  prepareSubscription(
    addresses: readonly ParameterAddress[],
    operation: TransportOperation,
    deliver: (notification: TransportNotification) => void,
  ): TransportSubscription {
    if (!(operation instanceof AdapterOperation) || !this.#operations.has(operation)) throw untrusted("admission");
    let record: unknown;
    try {
      record = this.#connection.prepareSubscription(
        addresses.map((address) => ({ family: "parameter", paramId: address.paramId, x: address.x, y: address.y })),
      );
    } catch {
      throw untrusted("admission");
    }
    const outcome = validateLifecycle(record, (value) => (isNativeSubscription(value) ? value : undefined));
    if (outcome === undefined) throw untrusted("admission");
    if (outcome.kind === "failure") throw subscriptionFailure(outcome.failure, outcome.cleanup);
    const native = outcome.value;
    let route: Route;
    try {
      route = this.#notifications.route(native.token, (routed) => deliver(routed.notification));
    } catch {
      // A token the router already knows cannot be told apart: give this one up.
      try {
        native.release().catch(() => undefined);
      } catch {
        // The connection's close releases it.
      }
      throw untrusted("admission");
    }
    return new AdapterSubscription(native, operation.native, route);
  }

  async adoptResult(requestTicket: string): Promise<void> {
    if (!this.#connection.adoptResult(requestTicket)) throw new Error("the result's slot could not be released");
  }

  async failDelivery(requestTicket: string): Promise<void> {
    if (!(await this.#connection.failDelivery(requestTicket))) throw new Error("the undelivered result could not be reported");
  }

  async terminate(requestTicket: string): Promise<void> {
    await this.#connection.terminate(requestTicket);
  }

  /**
   * Runs one native request call. An operation this transport did not create
   * is never forwarded, and a synchronous binding failure becomes a rejection;
   * callers treat either as no evidence (K33).
   */
  #call(call: (operation: NativeOperation) => Promise<unknown>, request: TransportRequest): Promise<unknown> {
    try {
      const { operation } = request;
      if (!(operation instanceof AdapterOperation) || !this.#operations.has(operation)) {
        throw new Error("the operation was not created by this transport");
      }
      return call(operation.native);
    } catch (error) {
      return Promise.reject(error);
    }
  }
}
