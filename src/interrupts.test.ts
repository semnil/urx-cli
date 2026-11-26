import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { processInterrupts } from "./interrupts.js";

describe("Ctrl+C while a command listens", () => {
  it("listen to SIGINT only while subscribed, counting from 1 for each subscription period", () => {
    const target = new EventEmitter();
    const interrupts = processInterrupts(target as unknown as NodeJS.Process);
    expect(target.listenerCount("SIGINT")).toBe(0);
    const counts: number[] = [];
    const unsubscribe = interrupts.subscribe((count) => counts.push(count));
    expect(target.listenerCount("SIGINT")).toBe(1);
    target.emit("SIGINT");
    target.emit("SIGINT");
    unsubscribe();
    expect(target.listenerCount("SIGINT")).toBe(0);
    const again = interrupts.subscribe((count) => counts.push(count));
    target.emit("SIGINT");
    again();
    expect(counts).toEqual([1, 2, 1]);
  });
});
