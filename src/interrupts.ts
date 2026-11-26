// Ctrl+C while a one-shot command runs (I1, I3). The first interruption asks
// the command to stop; a later one tells it to stop waiting. The process keeps
// Node's own Ctrl+C handling whenever no command is listening, so help and
// version end on Ctrl+C as any program does.

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
