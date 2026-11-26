// Diagnostics on standard error (P4, P5, E3). Lines name the canonical command,
// the processing stage, the elapsed milliseconds from the command's start and
// an E2 cause; never a device ID, a file path, a setting value or text that
// came from outside the CLI.

import type { BuildInfo } from "./build-info.js";
import { BRIDGE_API_EXPECTED } from "./bridge.js";
import { renderVersion, type Runtime } from "./cli/version.js";
import { ABANDONED, type CommandInterruption } from "./interrupts.js";
import { writeWithDeadline, type OutputFailure, type OutputStream } from "./output.js";
import type { CauseCode, ResultError } from "./result.js";

/** The processing stages diagnostics distinguish (P5). */
export type Stage = "preflight" | "discovery" | "connection" | "prerequisite checks" | "execution" | "result output" | "teardown";

export interface DiagnosticsOptions {
  readonly stderr: OutputStream;
  readonly verbose: boolean;
  readonly build: BuildInfo;
  readonly runtime: Runtime;
  readonly now: () => number;
  /** The command's Ctrl+C: a second one stops a write that has not completed, and every later one. */
  readonly interruption?: Pick<CommandInterruption, "race" | "abandoned">;
}

export class Diagnostics {
  readonly #options: DiagnosticsOptions;
  readonly #command: string;
  readonly #started: number;
  #contextShown = false;
  /** The first failure writing to standard error; nothing more is written after it. */
  #failure: OutputFailure | null = null;

  constructor(options: DiagnosticsOptions, command: string) {
    this.#options = options;
    this.#command = command;
    this.#started = options.now();
  }

  /** Why standard error stopped accepting lines, once it has. */
  get failure(): OutputFailure | null {
    return this.#failure;
  }

  /** A stage event, with `--verbose` only. */
  async stage(stage: Stage, event: "started" | "finished" | "failed", cause?: CauseCode): Promise<void> {
    if (!this.#options.verbose) return;
    if (!this.#contextShown) {
      this.#contextShown = true;
      // Build context, once per process, from what the CLI already holds.
      const context = renderVersion(this.#options.build, BRIDGE_API_EXPECTED, this.#options.runtime).trimEnd().split("\n").join(", ");
      await this.#write(`urx: verbose: ${context}\n`);
    }
    const elapsed = Math.max(0, Math.round(this.#options.now() - this.#started));
    await this.#write(`urx: verbose: ${this.#command}: ${stage} ${event} at ${elapsed} ms${cause === undefined ? "" : `: ${cause}`}\n`);
  }

  /** A failure reported beside the command's first one (E3), with or without `--verbose`. */
  async additional(error: ResultError): Promise<void> {
    await this.#write(`urx: also: ${error.code}: ${error.message}\n`);
  }

  /** A line written as it is, such as a human-readable error. */
  async line(text: string): Promise<void> {
    await this.#write(text);
  }

  async #write(text: string): Promise<void> {
    const { interruption } = this.#options;
    if (this.#failure !== null || interruption?.abandoned === true) return;
    const write = writeWithDeadline(this.#options.stderr, text);
    const outcome = interruption === undefined ? await write : await interruption.race(write);
    // A write given up at the second Ctrl+C is neither a success nor a failure seen.
    if (outcome !== ABANDONED) this.#failure = outcome;
  }
}
