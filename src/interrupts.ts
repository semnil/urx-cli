// Ctrl+C while a one-shot command runs (I1, I3). The first interruption asks
// the command to stop; a later one tells it to stop waiting for the device.
// The process keeps Node's own Ctrl+C handling whenever no command is
// listening, so help and version end on Ctrl+C as any program does.

/** Called with the number of interruptions received while subscribed: 1, 2, … */
export type InterruptHandler = (count: number) => void;

export interface Interrupts {
  subscribe(handler: InterruptHandler): () => void;
}

/** Interruptions from SIGINT, listened to only while a handler is subscribed. */
export function processInterrupts(target: NodeJS.Process = process): Interrupts {
  const handlers = new Set<InterruptHandler>();
  let count = 0;
  const listener = () => {
    count += 1;
    for (const handler of [...handlers]) handler(count);
  };
  return {
    subscribe(handler) {
      if (handlers.size === 0) {
        count = 0;
        target.on("SIGINT", listener);
      }
      handlers.add(handler);
      return () => {
        if (handlers.delete(handler) && handlers.size === 0) target.off("SIGINT", listener);
      };
    },
  };
}

export const ABANDONED: unique symbol = Symbol("abandoned");

/**
 * Ctrl+C for one command, from the moment it is chosen until its result has
 * been written: an interruption in any part of it is the command's.
 */
export class CommandInterruption {
  #interrupted = false;
  readonly #handlers: (() => void)[] = [];
  #abandon: () => void = () => {};
  /** Settles at the second interruption: the command stops waiting for the device. */
  readonly #abandoned = new Promise<typeof ABANDONED>((resolve) => (this.#abandon = () => resolve(ABANDONED)));
  readonly #unsubscribe: () => void;

  constructor(interrupts: Interrupts) {
    this.#unsubscribe = interrupts.subscribe((count) => {
      if (count > 1) {
        this.#abandon();
        return;
      }
      this.#interrupted = true;
      for (const handler of this.#handlers) handler();
    });
  }

  get interrupted(): boolean {
    return this.#interrupted;
  }

  /** Calls `handler` at the first interruption, or now if it has arrived already. */
  onInterrupt(handler: () => void): void {
    this.#handlers.push(handler);
    if (this.#interrupted) handler();
  }

  /** `work`, or ABANDONED once a second interruption stops the wait for it. */
  race<T>(work: Promise<T>): Promise<T | typeof ABANDONED> {
    return Promise.race([work, this.#abandoned]);
  }

  /** Stops listening; the command's result has been written. */
  dispose(): void {
    this.#unsubscribe();
  }
}
