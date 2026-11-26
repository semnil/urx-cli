// One output operation with the O7 deadline: it fails when the write has not
// completed 5 seconds after it started, and partial progress does not extend it.

import { writeSync } from "node:fs";
import { performance } from "node:perf_hooks";

export const OUTPUT_DEADLINE_MS = 5000;

/** The part of a Node writable stream an output operation needs. */
export interface OutputStream {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export type OutputFailure = "output_error" | "output_timeout";

/**
 * Resolves with `null` once the write completes, or with the failure that ended
 * it. A write that completes after the deadline is still a timeout: a write that
 * blocks the thread (a file) keeps the timer from running until it returns.
 */
export function writeWithDeadline(
  stream: OutputStream,
  text: string,
  deadlineMs = OUTPUT_DEADLINE_MS,
  now: () => number = () => performance.now(),
): Promise<OutputFailure | null> {
  return new Promise((resolve) => {
    let settled = false;
    const started = now();
    const settle = (failure: OutputFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure === null && now() - started >= deadlineMs ? "output_timeout" : failure);
    };
    const timer = setTimeout(() => settle("output_timeout"), deadlineMs);
    try {
      stream.write(text, (error) => settle(error ? "output_error" : null));
    } catch {
      settle("output_error");
    }
  });
}

/**
 * Output to a file descriptor written with `writeSync` until every byte is
 * written. Node's own file stream ignores a short write, which would report a
 * truncated output (a full disk, a file size limit) as complete.
 */
export function fileOutput(fd: number, write: typeof writeSync = writeSync): OutputStream {
  return {
    write(chunk, callback) {
      const bytes = Buffer.from(chunk, "utf8");
      try {
        for (let offset = 0; offset < bytes.length; ) {
          const written = write(fd, bytes, offset, bytes.length - offset);
          if (written <= 0) throw new Error("the output accepted no bytes");
          offset += written;
        }
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
        return false;
      }
      callback(null);
      return true;
    },
  };
}

/** The parts of process.stdout and process.stderr that `processOutput` uses. */
export interface ProcessOutput extends OutputStream {
  on(event: "error", listener: (error: Error) => void): unknown;
  readonly _handle?: { setBlocking?: (blocking: boolean) => unknown } | null;
}

/**
 * The output to use for one of the process's streams.
 *
 * - A terminal (POSIX) or a pipe (Windows), which Node makes block until the
 *   reader takes the data, is switched to non-blocking, so the write completes
 *   through its callback and the deadline timer keeps running.
 * - A stream without such a handle is a file, written through `fileOutput`.
 *
 * A stream also emits "error" alongside the failed write's callback, which
 * already reports the failure, so the event is consumed instead of crashing.
 */
export function processOutput(stream: ProcessOutput, fd: number): OutputStream {
  stream.on("error", () => {});
  const handle = stream._handle;
  if (typeof handle?.setBlocking === "function") {
    handle.setBlocking(false);
    return stream;
  }
  return fileOutput(fd);
}
