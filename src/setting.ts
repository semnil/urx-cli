// One-shot `get` and `set` of one setting (Q1, W1–W3, W6, O10, O13): the
// target and value read from the arguments, one connection to the selected
// device, urx-device's operation for the setting, and one result. A write runs
// under the Console Lock guard (F20-L-A); a dry run sends no write.

import {
  ConsoleLockGuard,
  dryRunSetting,
  OperationContext,
  operationFailureOf,
  readSetting,
  validateSetting,
  writeSetting,
  type OperationFailure,
  type Reading,
  type VerifiedPlan,
  type WriteProgress,
  type WriteResult,
} from "@urx/device-control/operations";
import type { SettingBinding, SettingVerb } from "./cli/settings.js";
import { CommandRun } from "./command-run.js";
import { connect, disconnect, type VerifiedDevice } from "./connect.js";
import type { Diagnostics } from "./diagnostics.js";
import { ABANDONED, type CommandInterruption } from "./interrupts.js";
import { addonFailure, operationFailure } from "./messages.js";
import type { AddonCheck } from "./native/addon.js";
import { AddonTransport } from "./native/transport.js";
import type { OutputStream } from "./output.js";
import { baseExitCode, EXIT, type ResultError } from "./result.js";
import { isSupported, parseValue, valueJson, valueRuleOf, valueText } from "./values.js";

export interface SettingIo {
  readonly stdout: OutputStream;
  readonly diagnostics: Diagnostics;
  readonly addon: () => AddonCheck;
  readonly interruption: CommandInterruption;
  readonly listPort?: number;
}

export interface SettingRequest {
  readonly binding: SettingBinding;
  readonly verb: SettingVerb;
  /** The parsed named arguments: flags map to `true`. */
  readonly arguments: ReadonlyMap<string, string | true>;
}

type Target = { readonly channel: number; readonly side?: "left" | "right" };

/** A channel number: ASCII digits, leading zeros allowed (C6, C12); the model's list decides the rest. */
const CHANNEL = /^[0-9]+$/;

/** The target the arguments name, or the refusal of the argument that names none. */
function targetOf(request: SettingRequest): Target | ResultError {
  const channel = request.arguments.get("channel");
  if (typeof channel !== "string" || !CHANNEL.test(channel)) return { code: "invalid_input", message: "--channel takes a channel number." };
  const side = request.arguments.get("side");
  if (side === undefined) return { channel: Number(channel) };
  if (side !== "left" && side !== "right") return { code: "invalid_input", message: "--side takes left or right." };
  return { channel: Number(channel), side };
}

/** The explanation of a condition a dry run leaves unverified. */
const UNVERIFIED = "This condition depends on a write that has not been sent.";

const isError = (value: unknown): value is ResultError => typeof value === "object" && value !== null && "code" in value && "message" in value;

/** Runs one setting command and returns its exit code. */
export async function runSetting(io: SettingIo, request: SettingRequest, json: boolean): Promise<number> {
  const { binding, verb } = request;
  const command = [...binding.path, verb].join(" ");
  const run = new CommandRun(io.diagnostics, io.interruption);
  const rule = valueRuleOf(binding.setting);
  const dryRun = request.arguments.has("dry-run");

  // The arguments are read before anything else: a refusal sends nothing.
  const parsedTarget = targetOf(request);
  const target = isError(parsedTarget) ? null : parsedTarget;
  if (isError(parsedTarget)) run.stop(parsedTarget);
  let requested: unknown = undefined;
  if (verb === "set" && isSupported(rule)) {
    requested = parseValue(rule, request.arguments.get("value") as string);
    if (requested === undefined && run.first() === null) run.stop({ code: "invalid_input", message: `--value is not one of the values \`${command}\` takes.` });
  }

  let device: VerifiedDevice | null = null;
  let reading: Reading<unknown> | null = null;
  let plan: VerifiedPlan<unknown> | WriteResult<unknown> | null = null;
  let progress: WriteProgress<unknown> | null = null;

  const check = run.first() === null ? io.addon() : null;
  if (check !== null && !check.ok) run.stop(addonFailure(check.problem));
  else if (check !== null && target !== null && run.first() === null) {
    const deviceId = request.arguments.get("device");
    const connected = await connect(run, io.diagnostics, check.addon, typeof deviceId === "string" ? deviceId : undefined, io.listPort);
    if (connected !== null) {
      device = connected.device;
      if (run.first() === null) {
        const { connection, notifications } = connected.opened;
        const context = new OperationContext(new AddonTransport(connection, notifications), device.model);
        run.interruption.onInterrupt(() => context.cancel("interrupted"));
        await run.note("execution", "started");
        const executing = run.mark();
        const stopped = (error: unknown) => {
          const operation = operationFailureOf(error);
          if (operation !== undefined) {
            // Only a write's own failure carries write evidence.
            const evidence = operation.progress as WriteProgress<unknown> | null;
            if (verb === "set" && progress === null && evidence !== null && typeof evidence === "object" && "outcome" in evidence) progress = evidence;
            run.stop(operationFailure(operation as OperationFailure));
          } else run.stop({ code: "internal_error", message: "An internal error occurred." });
        };
        try {
          if (verb === "get") {
            const read = await run.interruption.race(readSetting(context, binding.setting as never, target as never));
            if (read !== ABANDONED) reading = read;
          } else if (dryRun) {
            const preview = await run.interruption.race(dryRunSetting(context, binding.setting as never, target as never, requested as never));
            if (preview !== ABANDONED) plan = preview as VerifiedPlan<unknown>;
          } else {
            plan = await write(run, context, binding, target, requested, stopped);
          }
        } catch (error) {
          stopped(error);
        } finally {
          context.finish();
        }
        await run.ended("execution", executing);
      }
      await disconnect(run, connected);
    }
  }

  const deviceJson = device === null ? null : { id: device.id, model: device.model };
  const where = target === null ? command : `${binding.path[0]} ${target.channel}${target.side === undefined ? "" : ` ${target.side}`}`;
  const present = (value: unknown) => (value === undefined || value === null || !isSupported(rule) ? null : valueJson(rule, value));
  return run.finish(
    io.stdout,
    json,
    command,
    (error) => {
      const base = { mode: dryRun ? "dry_run" : "execute", device: deviceJson, target };
      if (verb === "get") {
        const observed = error === null ? reading : null;
        const data = { ...base, reading: observed === null ? null : { ...asReading(present(observed.value)), observed_at: observed.observedAt } };
        const human = observed === null || !isSupported(rule) ? null : `${where}: ${valueText(rule, observed.value)} (observed ${observed.observedAt})\n`;
        return { data, human };
      }
      const written = (plan ?? progress) as { requested: unknown; planned: unknown; outcome?: string } | null;
      const outcome = dryRun ? "not_sent" : (written?.outcome ?? "not_sent");
      const data = {
        ...base,
        requested: present(written?.requested ?? requested),
        planned: present(written?.planned),
        outcome,
        // A single setting's dry run has no earlier unsent write, so each condition has no step (O13).
        ...(dryRun ? { unverified: ((plan as VerifiedPlan<unknown> | null)?.unverified ?? []).map((code) => ({ code, message: UNVERIFIED, step: null })) } : {}),
      };
      let human: string | null = null;
      if (error === null && written !== null && isSupported(rule)) {
        const asked = written.requested === written.planned ? "" : ` (requested ${valueText(rule, written.requested)})`;
        human = dryRun
          ? `${where}: would send ${valueText(rule, written.planned)}${asked}; nothing was sent (dry run)\n`
          : `${where}: ${valueText(rule, written.planned)} accepted${asked}\n`;
      }
      return { data, human };
    },
    // A write sent without a confirmed answer is uncertain acceptance (E1).
    (error: ResultError) => ((progress as WriteProgress<unknown> | null)?.outcome === "uncertain" ? EXIT.uncertain : baseExitCode(error.code)),
  );
}

/** A reading's value fields: O6 numbers keep their fields, other values become `value`. */
function asReading(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : { value };
}

/**
 * The single write under the Console Lock guard (F20-L-A): the shared
 * validation first, so a refused write sends nothing, then the guard's
 * registration and fresh lock read, then the write. The guard is released
 * whatever happened, after the write's own failure is recorded, so that
 * failure stays the first (E3).
 */
async function write(
  run: CommandRun,
  context: OperationContext,
  binding: SettingBinding,
  target: Target | null,
  requested: unknown,
  stopped: (error: unknown) => void,
): Promise<WriteResult<unknown> | null> {
  validateSetting(context.model, binding.setting as never, target as never, requested as never);
  const opened = await run.interruption.race(ConsoleLockGuard.open(context));
  if (opened === ABANDONED) return null;
  let result: WriteResult<unknown> | null = null;
  try {
    const detach = await run.interruption.race(opened.begin(context));
    if (detach !== ABANDONED) {
      try {
        const written = await run.interruption.race(writeSetting(context, binding.setting as never, target as never, requested as never));
        if (written !== ABANDONED) result = written as WriteResult<unknown>;
      } finally {
        detach();
      }
    }
  } catch (error) {
    stopped(error);
  }
  // A release that fails is reported beside the write's outcome; it changes no write evidence.
  const released = await run.interruption.race(opened.release().then(() => null, (error: unknown) => error));
  if (released !== ABANDONED && released !== null) {
    const operation = operationFailureOf(released);
    run.stop(operation === undefined ? { code: "internal_error", message: "An internal error occurred." } : operationFailure(operation));
  }
  return result;
}
