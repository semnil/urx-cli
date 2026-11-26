import { afterEach, describe, expect, it, vi } from "vitest";
import { fileOutput, processOutput, writeWithDeadline, type OutputStream, type ProcessOutput } from "./output.js";

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

  it("report output_timeout for a write that failed after blocking past the deadline", async () => {
    let clock = 0;
    const failing: OutputStream = { write: (_, done) => ((clock += 6100), done(new Error("EIO")), false) };
    expect(await writeWithDeadline(failing, "x", 5000, () => clock)).toBe("output_timeout");
    clock = 0;
    const early: OutputStream = { write: (_, done) => ((clock += 100), done(new Error("EIO")), false) };
    expect(await writeWithDeadline(early, "x", 5000, () => clock)).toBe("output_error");
  });

  it("report output_timeout for a write that blocked past the deadline and then completed", async () => {
    let clock = 0;
    const blocking: OutputStream = { write: (_, done) => ((clock += 5700), done(), true) };
    expect(await writeWithDeadline(blocking, "x", 5000, () => clock)).toBe("output_timeout");
    clock = 0;
    const quick: OutputStream = { write: (_, done) => ((clock += 4999), done(), true) };
    expect(await writeWithDeadline(quick, "x", 5000, () => clock)).toBeNull();
  });
});

describe("file output", () => {
  const writer = (sizes: (number | Error)[]) => {
    const calls: [number, number][] = [];
    const write = ((_fd: number, _buffer: Buffer, offset: number, length: number) => {
      calls.push([offset, length]);
      const next = sizes.shift();
      if (next instanceof Error) throw next;
      return Math.min(next ?? length, length);
    }) as unknown as NonNullable<NonNullable<Parameters<typeof fileOutput>[1]>["write"]>;
    return { write, calls };
  };
  const result = (stream: OutputStream, text: string) =>
    new Promise<Error | null>((resolve) => stream.write(text, (error) => resolve(error ?? null)));

  it("write the remainder after a short write until every byte is written", async () => {
    const { write, calls } = writer([3, 2]);
    expect(await result(fileOutput(1, { write }), "abcdefgh")).toBeNull();
    expect(calls).toEqual([
      [0, 8],
      [3, 5],
      [5, 3],
    ]);
  });

  it("count UTF-8 bytes, not characters", async () => {
    const { write, calls } = writer([]);
    expect(await result(fileOutput(1, { write }), "名前")).toBeNull();
    expect(calls).toEqual([[0, 6]]);
  });

  it("start no further write once a short write returns at or past the deadline", async () => {
    let clock = 0;
    const calls: number[] = [];
    const slow = ((_fd: number, _buffer: Buffer, offset: number) => (calls.push(offset), (clock += 2800), 2)) as unknown as NonNullable<
      NonNullable<Parameters<typeof fileOutput>[1]>["write"]
    >;
    const output = fileOutput(1, { write: slow, now: () => clock });
    expect(await writeWithDeadline(output, "abcdefgh", 5000, () => clock)).toBe("output_timeout");
    expect(calls).toEqual([0, 2]);
  });

  it("judge the remainder against the operation's own deadline, not a later start time", async () => {
    for (const [returned, expected, remainder] of [
      [4999, null, true],
      [5000, "output_timeout", false],
      [5000.5, "output_timeout", false],
      [5001, "output_timeout", false],
    ] as const) {
      // The clock moves 1 ms between the operation's start and the file write's start.
      let clock = 0;
      const tick = () => clock;
      const calls: number[] = [];
      const write = ((_fd: number, _buffer: Buffer, offset: number, length: number) => {
        calls.push(offset);
        if (offset === 0) {
          clock = returned;
          return 1;
        }
        return length;
      }) as unknown as NonNullable<NonNullable<Parameters<typeof fileOutput>[1]>["write"]>;
      const output = fileOutput(1, { write, now: tick });
      const stepped: OutputStream = { write: output.write, writeBefore: (chunk, deadline, done) => ((clock += 1), output.writeBefore?.(chunk, deadline, done)) };
      expect(await writeWithDeadline(stepped, "abc", 5000, tick), String(returned)).toBe(expected);
      expect(calls.length > 1, String(returned)).toBe(remainder);
    }
  });

  it("fail when the remainder cannot be written or no byte is accepted", async () => {
    expect(await result(fileOutput(1, { write: writer([3, Object.assign(new Error("full"), { code: "ENOSPC" })]).write }), "abcdefgh")).toBeInstanceOf(Error);
    expect(await result(fileOutput(1, { write: writer([0]).write }), "abc")).toBeInstanceOf(Error);
  });
});

describe("process output selection", () => {
  const stream = (handle: ProcessOutput["_handle"]) => {
    const listeners: ((error: Error) => void)[] = [];
    const calls: boolean[] = [];
    const value: ProcessOutput = {
      write: () => true,
      on: (_event: "error", listener: (error: Error) => void) => listeners.push(listener),
      _handle: handle === undefined || handle === null ? handle : { setBlocking: (blocking: boolean) => calls.push(blocking) },
    };
    return { value, listeners, calls };
  };

  it("make a terminal or pipe handle non-blocking and use the stream", () => {
    const { value, listeners, calls } = stream({ setBlocking: () => 0 });
    expect(processOutput(value, 1)).toBe(value);
    expect(calls).toEqual([false]);
    expect(listeners).toHaveLength(1);
    expect(() => listeners[0]?.(new Error("EPIPE"))).not.toThrow();
  });

  it("write a stream without such a handle (a file) through the file descriptor", () => {
    for (const handle of [undefined, null]) {
      const { value, listeners } = stream(handle);
      expect(processOutput(value, 1)).not.toBe(value);
      expect(listeners).toHaveLength(1);
    }
  });
});
