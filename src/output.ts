// One output operation with the O7 deadline: it fails when the write has not
// completed 5 seconds after it started, and partial progress does not extend it.

export const OUTPUT_DEADLINE_MS = 5000;

/** The part of a Node writable stream an output operation needs. */
export interface OutputStream {
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
}

export type OutputFailure = "output_error" | "output_timeout";

/** Resolves with `null` once the write completes, or with the failure that ended it. */
export function writeWithDeadline(stream: OutputStream, text: string, deadlineMs = OUTPUT_DEADLINE_MS): Promise<OutputFailure | null> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (failure: OutputFailure | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(failure);
    };
    const timer = setTimeout(() => settle("output_timeout"), deadlineMs);
    try {
      stream.write(text, (error) => settle(error ? "output_error" : null));
    } catch {
      settle("output_error");
    }
  });
}
