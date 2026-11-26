// urx-device's connection-bound Transport (K2, K37) over one addon
// connection. Each request method returns the native K34 record as it came;
// urx-device's operations validate it before adopting anything.

import type {
  ParameterAddress,
  Transport,
  TransportNotification,
  TransportOperation,
  TransportRequest,
  TransportSubscription,
} from "@urx/device-control/operations";

/** The addon's per-operation owner (K37). */
export interface NativeOperation {
  cancel(): void;
  finish(): void;
}

/** The request side of the addon's connection object. */
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
}

/** The TransportOperation the adapter hands out, keeping its native owner. */
class AdapterOperation implements TransportOperation {
  constructor(readonly native: NativeOperation) {}
  cancel(): void {
    this.native.cancel();
  }
  finish(): void {
    this.native.finish();
  }
}

export class AddonTransport implements Transport {
  readonly #connection: NativeRequests;
  /** The operations this transport created; no other is forwarded to its connection. */
  readonly #operations = new WeakSet<AdapterOperation>();

  constructor(connection: NativeRequests) {
    this.#connection = connection;
  }

  createOperation(): TransportOperation {
    const operation = new AdapterOperation(this.#connection.createOperation());
    this.#operations.add(operation);
    return operation;
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

  prepareSubscription(
    _addresses: readonly ParameterAddress[],
    _operation: TransportOperation,
    _deliver: (notification: TransportNotification) => void,
  ): TransportSubscription {
    // Subscriptions and notification delivery are not bound to the addon yet;
    // a refused admission throws.
    throw new Error("subscriptions are not available on this connection");
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
