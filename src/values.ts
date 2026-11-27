// Setting values at the CLI boundary, from the shared value rules (K35): how a
// `--value` is read (C6, C8), and how a value is shown in JSON (O6, O10) and
// to a person. The rules' ranges, grids and wire codecs stay in urx-device.

import { decimalValue, isDecimalValue, settingDefinitions, type DecimalValue, type SettingId, type ValueRule } from "@urx/device-control/catalog";

/** The O6 state a named special value stands for. */
const SENTINEL_STATES: Readonly<Record<string, string>> = {
  "-inf": "negative_infinity",
  inf: "positive_infinity",
  thru: "thru",
};

/** The rule kinds this CLI reads and shows; others are bound with their settings. */
type Supported = Extract<ValueRule, { kind: "switch" | "choice" | "grid" }>;

export function isSupported(rule: ValueRule | undefined): rule is Supported {
  return rule !== undefined && (rule.kind === "switch" || rule.kind === "choice" || rule.kind === "grid");
}

/** The value rule of a setting, where its definition has one. */
export const valueRuleOf = (setting: SettingId): ValueRule | undefined => (settingDefinitions[setting].rule as { readonly value?: ValueRule }).value;

/**
 * The value `text` stands for under `rule`, or undefined when it is not one.
 * A number stays C6 decimal text, in canonical form, so urx-device checks its
 * range and rounds it (W2) on its exact value, not on the binary number
 * nearest to it.
 */
export function parseValue(rule: Supported, text: string): unknown {
  switch (rule.kind) {
    case "switch":
      return text === "on" ? true : text === "off" ? false : undefined;
    case "choice":
      return rule.choices.includes(text) ? text : undefined;
    case "grid": {
      if (rule.sentinel !== undefined && text === rule.sentinel.value) return text;
      // C6 text only; its canonical form makes negative zero zero.
      return decimalValue(text);
    }
  }
}

/** A JSON number written exactly as `text`, through `JSON.stringify` (Node's `JSON.rawJSON`). */
const rawNumber = (text: string): unknown => (JSON as unknown as { rawJSON(text: string): unknown }).rawJSON(text);

/**
 * A numeric value in JSON (O6): a number with `state: "finite"`, or null with
 * its special state. A decimal value is the number its canonical text is,
 * written with every digit it has.
 */
export interface NumericJson {
  readonly value: unknown;
  readonly state: string;
  readonly unit: string | null;
}

/** `value` as JSON: a boolean for on/off, a string for a choice, O6 numbers otherwise. */
export function valueJson(rule: Supported, value: unknown): unknown {
  if (rule.kind !== "grid") return value;
  if (typeof value === "string") return { value: null, state: SENTINEL_STATES[value] ?? value, unit: rule.unit } satisfies NumericJson;
  if (isDecimalValue(value)) return { value: rawNumber(value.decimal), state: "finite", unit: rule.unit } satisfies NumericJson;
  return { value: value as number, state: "finite", unit: rule.unit } satisfies NumericJson;
}

/** The text of a numeric value: a decimal value's canonical text, or the number as it prints. */
const numberText = (value: unknown): string => (isDecimalValue(value) ? (value as DecimalValue).decimal : String(value));

/** `value` for a person: on/off, the choice, or the number with its unit. */
export function valueText(rule: Supported, value: unknown): string {
  if (rule.kind === "switch") return value === true ? "on" : "off";
  if (rule.kind === "choice") return String(value);
  return rule.unit === null ? numberText(value) : `${numberText(value)} ${rule.unit}`;
}

/** Whether two values are the same: decimal values by their canonical text, others as they are. */
export function sameValue(a: unknown, b: unknown): boolean {
  return isDecimalValue(a) && isDecimalValue(b) ? a.decimal === b.decimal : a === b;
}
