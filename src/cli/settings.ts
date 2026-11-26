// The setting commands' bindings (K35): each command path before its verb
// names one urx-device setting ID. The CLI owns only the spelling and the help
// text; targets, values, units and ranges come from the shared definitions.

import { MODELS, MONO_CHANNELS, STEREO_CHANNELS, settingDefinitions, type SettingId } from "@urx/device-control/catalog";
import { isSupported, valueRuleOf } from "../values.js";

export type SettingVerb = "get" | "set";

/** The target arguments a setting takes (C12). */
export type TargetSyntax = "channel" | "channel-side";

export interface SettingBinding {
  /** The command path before its verb, such as `channel fader`. */
  readonly path: readonly string[];
  readonly setting: SettingId;
  readonly summary: string;
  readonly target: TargetSyntax;
  /** The help text of `--value`. */
  readonly value: string;
  readonly placeholder: string;
}

const binding = (spec: SettingBinding): SettingBinding => {
  // The target syntax is the shared definition's, so the two cannot drift apart; and a
  // setting is bound only once the CLI reads and shows its kind of value.
  if (settingDefinitions[spec.setting].rule.target !== spec.target) throw new Error(`the target syntax of ${spec.setting} is not its definition's`);
  if (!isSupported(valueRuleOf(spec.setting))) throw new Error(`the value of ${spec.setting} is not one this CLI reads`);
  return Object.freeze({ ...spec, path: Object.freeze([...spec.path]) });
};

/** Every bound setting, in the order help lists them (F03-H). */
export const SETTING_BINDINGS: readonly SettingBinding[] = Object.freeze([
  binding({
    path: ["channel", "on"],
    setting: "channel.on",
    summary: "The channel master on or off, apart from its STEREO assignment",
    target: "channel",
    value: "on or off",
    placeholder: "on|off",
  }),
  binding({
    path: ["channel", "fader"],
    setting: "channel.fader",
    summary: "The channel fader level",
    target: "channel",
    value: "A level from -96 to 10 dB, set to the nearest 0.01 dB (a tie goes to the lower value), or -inf",
    placeholder: "<dB>|-inf",
  }),
  binding({
    path: ["channel", "pan"],
    setting: "channel.pan",
    summary: "The channel's pan or balance position; which of the two follows the device's PAN/BAL mode",
    target: "channel",
    value: "A position from -63 (left) through 0 (center) to 63 (right), set to the nearest whole step (a tie goes to the lower value)",
    placeholder: "<position>",
  }),
  binding({
    path: ["channel", "polarity"],
    setting: "channel.polarity",
    summary: "The channel's input polarity",
    target: "channel-side",
    value: "normal or inverted",
    placeholder: "normal|inverted",
  }),
]);

/** The binding and verb of a command path, if it is a setting command. */
export function settingCommandOf(path: readonly string[]): { readonly binding: SettingBinding; readonly verb: SettingVerb } | undefined {
  const verb = path[path.length - 1];
  if (verb !== "get" && verb !== "set") return undefined;
  const found = SETTING_BINDINGS.find((candidate) => candidate.path.length === path.length - 1 && candidate.path.every((word, i) => word === path[i]));
  return found === undefined ? undefined : { binding: found, verb };
}

/** The help text of `--channel`, from the shared channel lists (C12). */
export function channelHelp(): string {
  const stereo = (first: number) => `${first} (CH ${first}/${first + 1})`;
  const byModel = MODELS.map((model) => `${(MONO_CHANNELS[model] as readonly number[]).join(", ")} mono and ${(STEREO_CHANNELS[model] as readonly number[]).map(stereo).join(", ")} stereo on ${model}`);
  return `The channel number: ${byModel.join("; ")}. A stereo channel is named by its first number only`;
}
