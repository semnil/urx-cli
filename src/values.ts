// Setting values at the CLI boundary, from the shared value rules (K35): how a
// `--value` is read (C6, C8), and how a value is shown in JSON (O6, O10) and
// to a person. The rules' ranges, grids and wire codecs stay in urx-device.

import { settingDefinitions, type SettingId, type ValueRule } from "@urx/device-control/catalog";

/** A decimal number as C6 allows it: ASCII digits, an optional leading minus, digits on both sides of a point. */
const DECIMAL = /^-?[0-9]+(\.[0-9]+)?$/;

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
 * Ranges and grids are checked by urx-device, which also rounds (W2).
 */
export function parseValue(rule: Supported, text: string): unknown {
  switch (rule.kind) {
    case "switch":
      return text === "on" ? true : text === "off" ? false : undefined;
    case "choice":
      return rule.choices.includes(text) ? text : undefined;
    case "grid": {
      if (rule.sentinel !== undefined && text === rule.sentinel.value) return text;
      if (!DECIMAL.test(text)) return undefined;
      // Negative zero is zero (C6).
      return Number(text) + 0;
    }
  }
}

/** A numeric value in JSON (O6): a number with `state: "finite"`, or null with its special state. */
export interface NumericJson {
  readonly value: number | null;
  readonly state: string;
  readonly unit: string | null;
}

/** `value` as JSON: a boolean for on/off, a string for a choice, O6 numbers otherwise. */
export function valueJson(rule: Supported, value: unknown): unknown {
  if (rule.kind !== "grid") return value;
  if (typeof value === "string") return { value: null, state: SENTINEL_STATES[value] ?? value, unit: rule.unit } satisfies NumericJson;
  return { value: value as number, state: "finite", unit: rule.unit } satisfies NumericJson;
}

/** `value` for a person: on/off, the choice, or the number with its unit. */
export function valueText(rule: Supported, value: unknown): string {
  if (rule.kind === "switch") return value === true ? "on" : "off";
  if (rule.kind === "choice") return String(value);
  return rule.unit === null ? String(value) : `${String(value)} ${rule.unit}`;
}
