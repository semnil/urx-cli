import { afterEach, describe, expect, it, vi } from "vitest";
import { writeWithDeadline, type OutputStream } from "./output.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("one output operation (O7)", () => {
  it("resolve null when the write completes", async () => {
    const written: string[] = [];
    const stream: OutputStream = { write: (chunk, done) => (written.push(chunk), done(), true) };
    expect(await writeWithDeadline(stream, "text")).toBeNull();
    expect(written).toEqual(["text"]);
  });

  it("report output_error for a failed or throwing write", async () => {
    expect(await writeWithDeadline({ write: (_, done) => (done(new Error("EPIPE")), false) }, "x")).toBe("output_error");
    expect(
      await writeWithDeadline(
        {
          write: () => {
            throw new Error("closed");
          },
        },
        "x",
      ),
    ).toBe("output_error");
  });

  it("report output_timeout 5 seconds after the write started, and ignore a later completion", async () => {
    vi.useFakeTimers();
    let complete: (() => void) | undefined;
    const pending = writeWithDeadline({ write: (_, done) => ((complete = () => done()), false) }, "x");
    let result: string | null | undefined;
    void pending.then((value) => (result = value));
    await vi.advanceTimersByTimeAsync(4999);
    expect(result).toBeUndefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toBe("output_timeout");
    complete?.();
    expect(await pending).toBe("output_timeout");
  });
});
