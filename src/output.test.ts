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
    }) as unknown as Parameters<typeof fileOutput>[1];
    return { write, calls };
  };
  const result = (stream: OutputStream, text: string) =>
    new Promise<Error | null>((resolve) => stream.write(text, (error) => resolve(error ?? null)));

  it("write the remainder after a short write until every byte is written", async () => {
    const { write, calls } = writer([3, 2]);
    expect(await result(fileOutput(1, write), "abcdefgh")).toBeNull();
    expect(calls).toEqual([
      [0, 8],
      [3, 5],
      [5, 3],
    ]);
  });

  it("count UTF-8 bytes, not characters", async () => {
    const { write, calls } = writer([]);
    expect(await result(fileOutput(1, write), "名前")).toBeNull();
    expect(calls).toEqual([[0, 6]]);
  });

  it("fail when the remainder cannot be written or no byte is accepted", async () => {
    expect(await result(fileOutput(1, writer([3, Object.assign(new Error("full"), { code: "ENOSPC" })]).write), "abcdefgh")).toBeInstanceOf(Error);
    expect(await result(fileOutput(1, writer([0]).write), "abc")).toBeInstanceOf(Error);
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
