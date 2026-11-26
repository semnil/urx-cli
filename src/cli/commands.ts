// The command-binding table: every command path, the modes it runs in, and the
// named arguments it accepts. The parser and help read this table and nothing
// else, so a command or argument exists in both or in neither.

import { channelHelp, SETTING_BINDINGS, type SettingBinding } from "./settings.js";

/** Where a command line comes from: the OS shell, the console prompt or a command file. */
export type Mode = "one-shot" | "console" | "command-file";

export const MODES: readonly Mode[] = Object.freeze(["one-shot", "console", "command-file"]);

/** A named argument: a valueless flag (`--json`) or one that takes a value (`--device <id>`). */
export interface ArgumentSpec {
  readonly name: string;
  readonly kind: "flag" | "value";
  /** For a value argument, the placeholder shown in usage lines. */
  readonly placeholder?: string;
  readonly description: string;
  readonly required?: boolean;
  /** The modes the argument is accepted in, when narrower than the command's own. */
  readonly modes?: readonly Mode[];
}

export interface PositionalSpec {
  readonly name: string;
  readonly description: string;
}

export interface CommandSpec {
  readonly path: readonly string[];
  readonly summary: string;
  readonly modes: readonly Mode[];
  readonly arguments: readonly ArgumentSpec[];
  /** A command takes at most one positional argument, and it is then required. */
  readonly positional?: PositionalSpec;
}

const JSON_FLAG: ArgumentSpec = Object.freeze({
  name: "json",
  kind: "flag",
  description: "Print the result as JSON on standard output",
});

const VERBOSE_FLAG: ArgumentSpec = Object.freeze({
  name: "verbose",
  kind: "flag",
  description: "Print diagnostics on standard error",
  modes: Object.freeze(["one-shot"] as const),
});

const DEVICE_ARGUMENT: ArgumentSpec = Object.freeze({
  name: "device",
  kind: "value",
  placeholder: "<device-id>",
  description: "Use the device with this ID from `device list`. Without it, the only online device is used",
});

const DRY_RUN_FLAG: ArgumentSpec = Object.freeze({
  name: "dry-run",
  kind: "flag",
  description: "Show the operations that would run, without changing the device",
});

const ONE_SHOT_DRY_RUN: ArgumentSpec = Object.freeze({
  ...DRY_RUN_FLAG,
  description: "Show the write that would be sent, without sending it",
  modes: Object.freeze(["one-shot"] as const),
});

const command = (spec: CommandSpec): CommandSpec =>
  Object.freeze({ ...spec, path: Object.freeze([...spec.path]), modes: Object.freeze([...spec.modes]), arguments: Object.freeze([...spec.arguments]) });

/** The `get` and `set` commands of one bound setting (K35). */
function settingCommands(setting: SettingBinding): CommandSpec[] {
  const target: ArgumentSpec[] = [{ name: "channel", kind: "value", placeholder: "<n>", description: channelHelp(), required: true }];
  if (setting.target === "channel-side") {
    target.push({ name: "side", kind: "value", placeholder: "left|right", description: "The side of a stereo channel: required for a stereo channel, refused for a mono one" });
  }
  const modes: Mode[] = ["one-shot", "console", "command-file"];
  return [
    command({ path: [...setting.path, "get"], summary: `Read ${lowerFirst(setting.summary)}`, modes, arguments: [...target, DEVICE_ARGUMENT, JSON_FLAG, VERBOSE_FLAG] }),
    command({
      path: [...setting.path, "set"],
      summary: `Write ${lowerFirst(setting.summary)}`,
      modes,
      arguments: [...target, { name: "value", kind: "value", placeholder: setting.placeholder, description: setting.value, required: true }, DEVICE_ARGUMENT, JSON_FLAG, VERBOSE_FLAG, ONE_SHOT_DRY_RUN],
    }),
  ];
}

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

/** Every command, in the order help lists them. */
export const COMMANDS: readonly CommandSpec[] = Object.freeze([
  command({
    path: ["console"],
    summary: "Start an interactive session connected to one device",
    modes: ["one-shot"],
    arguments: [DEVICE_ARGUMENT, VERBOSE_FLAG],
  }),
  command({
    path: ["device", "list"],
    summary: "List the online devices and their IDs",
    modes: ["one-shot", "console"],
    arguments: [JSON_FLAG, VERBOSE_FLAG],
  }),
  command({
    path: ["device", "current"],
    summary: "Show the selected device, or that none is connected",
    modes: ["console"],
    arguments: [JSON_FLAG],
  }),
  command({
    path: ["device", "use"],
    summary: "Close the current connection and connect to another device",
    modes: ["console"],
    arguments: [
      {
        name: "id",
        kind: "value",
        placeholder: "<device-id>",
        description: "The ID of the device to connect to, from `device list`",
        required: true,
      },
      JSON_FLAG,
    ],
  }),
  command({
    path: ["exit"],
    summary: "End the console session",
    modes: ["console"],
    arguments: [],
  }),
  command({
    path: ["run"],
    summary: "Run the commands in a command file against one device",
    modes: ["one-shot"],
    arguments: [DEVICE_ARGUMENT, JSON_FLAG, VERBOSE_FLAG, DRY_RUN_FLAG],
    positional: {
      name: "<file>",
      description: "The command file. A relative path is resolved against the working directory",
    },
  }),
  ...SETTING_BINDINGS.flatMap(settingCommands),
]);

/** Whether an argument is accepted in a mode: the command's modes, narrowed by the argument's own. */
export function acceptsArgument(argument: ArgumentSpec, mode: Mode): boolean {
  return argument.modes === undefined || argument.modes.includes(mode);
}
