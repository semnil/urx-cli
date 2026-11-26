// One device command's run (U5, I1, I3, E1–E3): its stopping causes in the
// order the CLI detects them, the diagnostics of its stages, and the end that
// every device command shares, which decides the result, writes it, reports
// the other stops and returns the exit code.

import type { Diagnostics, Stage } from "./diagnostics.js";
import { ABANDONED, type CommandInterruption } from "./interrupts.js";
import { failure, failureLine, stderrFailure, stdoutFailure as stdoutFailureOf } from "./messages.js";
import { writeWithDeadline, type OutputFailure, type OutputStream } from "./output.js";
import { baseExitCode, EXIT, jsonLine, type CauseCode, type ResultError } from "./result.js";

/** The command's first stopping cause and the failures found after it (E3). */
class Stops {
  #first: ResultError | null = null;
  readonly #later: ResultError[] = [];

  /** Read through a method: an interruption can set it while the command awaits. */
  first(): ResultError | null {
    return this.#first;
  }

  stop(error: ResultError): void {
    if (this.#first === null) this.#first = error;
    else this.#later.push(error);
  }

  /** Every stop, in the order found. */
  all(): ResultError[] {
    return this.#first === null ? [] : [this.#first, ...this.#later];
  }
}

/**
 * What a decided result contributes: its record's data, and its human-readable
 * text, which a failed result can have too, such as a write's outcome.
 */
export interface Outcome {
  readonly data: Readonly<Record<string, unknown>> | null;
  readonly human: string | null;
}

export class CommandRun {
  readonly #stops = new Stops();
  readonly #diagnostics: Diagnostics;
  readonly #interruption: CommandInterruption;
  /** A Ctrl+C is a stop only until the result is decided; after that it sets the exit code alone. */
  #decided = false;
  #stderrNoted = false;

  constructor(diagnostics: Diagnostics, interruption: CommandInterruption) {
    this.#diagnostics = diagnostics;
    this.#interruption = interruption;
    interruption.onInterrupt(() => {
      if (!this.#decided) this.#stops.stop(failure("interrupted"));
    });
  }

  get interruption(): CommandInterruption {
    return this.#interruption;
  }

  /** The first stopping cause so far; no new device work starts once there is one. */
  first(): ResultError | null {
    return this.#stops.first();
  }

  stop(error: ResultError): void {
    this.#stops.stop(error);
  }

  /**
   * A stage event in the diagnostics. Standard error that stops accepting
   * lines is an output failure: it stops the command (U5).
   */
  async note(stage: Stage, event: "started" | "finished" | "failed", cause?: CauseCode): Promise<void> {
    await this.#diagnostics.stage(stage, event, cause);
    const broken = this.#diagnostics.failure;
    if (broken !== null && !this.#stderrNoted) {
      this.#stderrNoted = true;
      this.#stops.stop(stderrFailure(broken));
    }
  }

  /** A position in the stops, taken when a stage starts. */
  mark(): number {
    return this.#stops.all().length;
  }

  /** A stage that ends now: failed with the first stop found since `since`, or finished. */
  async ended(stage: Stage, since: number): Promise<void> {
    const cause = this.#stops.all()[since]?.code;
    await this.note(stage, cause === undefined ? "finished" : "failed", cause);
  }

  /**
   * Decides the result, writes it and reports every other stop, and returns
   * the exit code. `decide` builds the outcome for the decided error;
   * `exitOf` gives the exit code of a failed result, by default its cause's.
   */
  async finish(
    stdout: OutputStream,
    json: boolean,
    command: string,
    decide: (error: ResultError | null) => Outcome,
    exitOf: (error: ResultError) => number = (error) => baseExitCode(error.code),
  ): Promise<number> {
    const diagnostics = this.#diagnostics;
    const interruption = this.#interruption;
    await this.note("result output", "started");
    // A second Ctrl+C stops every wait, and nothing more is written (I3).
    if (interruption.abandoned) return EXIT.interrupted;
    // The result is decided here. The only stop found after it is a failed write of the result.
    this.#decided = true;
    const error = this.first();
    const outcome = decide(error);
    const record = { type: "result" as const, command, data: outcome.data, error };
    // JSON carries a failure in its record; human-readable output reports it on standard error,
    // beside whatever the result still has to show.
    const text = json ? jsonLine(record) : outcome.human;
    const written = text === null ? null : await interruption.race(writeWithDeadline(stdout, text));
    if (written === ABANDONED) return EXIT.interrupted;
    // A failed write of the result stops the command where the CLI detects it, after any earlier stop.
    const stdoutFailure: { readonly failure: OutputFailure; readonly error: ResultError } | null =
      written === null ? null : { failure: written, error: stdoutFailureOf(written) };
    if (stdoutFailure !== null) this.#stops.stop(stdoutFailure.error);
    // Every failure line carries its cause code, so none is reported without it.
    if (!json && error !== null) await diagnostics.line(failureLine(error));
    // Every stop besides the recorded one, once each, in the order found (E3). After a result
    // without an error, the first of them is the command's own failure. No stop is added while
    // these lines are written.
    for (const [index, stop] of this.#stops.all().filter((stop) => stop !== error).entries()) {
      if (error === null && index === 0) await diagnostics.line(failureLine(stop));
      else await diagnostics.additional(stop);
    }
    await diagnostics.stage("result output", stdoutFailure === null ? "finished" : "failed", stdoutFailure?.failure);
    // Ctrl+C during the command takes precedence (E1), even once its result is out.
    if (interruption.interrupted || interruption.abandoned) return EXIT.interrupted;
    if (error !== null) return exitOf(error);
    const first = this.first();
    if (first !== null) return baseExitCode(first.code);
    // A diagnostic that could not be written fails a command that otherwise succeeded (U5).
    return diagnostics.failure === null ? EXIT.success : EXIT.failure;
  }
}
