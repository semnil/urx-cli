import { BASIC_RULES } from "@urx/device-control/catalog";
import { describe, expect, it } from "vitest";
import { renderHelp } from "./cli/help.js";
import { parse } from "./cli/parse.js";
import { settingCommandOf } from "./cli/settings.js";
import { isSupported, parseValue, valueJson, valueText } from "./values.js";

const rule = (id: keyof typeof BASIC_RULES) => {
  const value = (BASIC_RULES[id] as { value: unknown }).value;
  if (!isSupported(value as never)) throw new Error(`${id} is not supported`);
  return value as Parameters<typeof parseValue>[0];
};

describe("setting values at the CLI (C6, C8, O6)", () => {
  it("read on/off as booleans, and nothing else", () => {
    const on = rule("channel.on");
    expect([parseValue(on, "on"), parseValue(on, "off")]).toEqual([true, false]);
    for (const text of ["ON", "true", "1", "o", ""]) expect(parseValue(on, text), text).toBeUndefined();
    expect([valueJson(on, true), valueText(on, false)]).toEqual([true, "off"]);
  });

  it("read decimal numbers and exact named values only", () => {
    const fader = rule("channel.fader");
    expect(parseValue(fader, "-6")).toBe(-6);
    expect(parseValue(fader, "-15.005")).toBe(-15.005);
    expect(parseValue(fader, "007")).toBe(7);
    expect(Object.is(parseValue(fader, "-0"), 0)).toBe(true);
    expect(parseValue(fader, "-inf")).toBe("-inf");
    for (const text of ["+1", "1e3", "5e-1", "1.", ".5", "1,000", "６", "-6dB", "NaN", "Infinity", "-Inf", "inf", "", " 1"]) {
      expect(parseValue(fader, text), text).toBeUndefined();
    }
  });

  it("show numbers with their O6 state and unit, and a named value as its state", () => {
    const fader = rule("channel.fader");
    expect(valueJson(fader, -6)).toEqual({ value: -6, state: "finite", unit: "dB" });
    expect(valueJson(fader, "-inf")).toEqual({ value: null, state: "negative_infinity", unit: "dB" });
    expect([valueText(fader, -15.01), valueText(fader, "-inf")]).toEqual(["-15.01 dB", "-inf dB"]);
    expect(valueJson(rule("channel.pan"), -63)).toEqual({ value: -63, state: "finite", unit: null });
    expect(valueText(rule("channel.pan"), 0)).toBe("0");
    expect([parseValue(rule("channel.polarity"), "inverted"), parseValue(rule("channel.polarity"), "Inverted")]).toEqual(["inverted", undefined]);
  });
});

describe("the setting commands (K35, F03-H)", () => {
  it("bind get and set of the four basic channel controls, with their required arguments", () => {
    for (const path of ["on", "fader", "pan", "polarity"].map((name) => ["channel", name])) {
      expect(settingCommandOf([...path, "get"])?.verb).toBe("get");
      expect(parse([...path, "get"], "one-shot")).toMatchObject({ kind: "error" });
      expect(parse([...path, "set", "--channel", "1"], "one-shot")).toMatchObject({ kind: "error" });
    }
    expect(settingCommandOf(["channel", "mute", "get"])).toBeUndefined();
    expect(parse(["channel", "fader", "set", "--channel", "1", "--value=-6"], "one-shot")).toMatchObject({ kind: "command" });
  });

  it("take --side only where a side exists, and --dry-run only from the shell", () => {
    expect(parse(["channel", "polarity", "get", "--channel", "5", "--side", "left"], "one-shot")).toMatchObject({ kind: "command" });
    expect(parse(["channel", "fader", "get", "--channel", "5", "--side", "left"], "one-shot")).toMatchObject({ kind: "error" });
    expect(parse(["channel", "fader", "set", "--channel", "1", "--value", "0", "--dry-run"], "one-shot")).toMatchObject({ kind: "command" });
    expect(parse(["channel", "fader", "set", "--channel", "1", "--value", "0", "--dry-run"], "console")).toMatchObject({ kind: "error" });
    expect(parse(["channel", "fader", "get", "--channel", "1", "--dry-run"], "one-shot")).toMatchObject({ kind: "error" });
  });

  it("name a stereo channel by its first number in help", () => {
    const help = renderHelp(["channel", "fader", "get"], "one-shot");
    expect(help).toContain("5 (CH 5/6)");
    expect(help).toContain("3 (CH 3/4)");
    expect(renderHelp(["channel", "pan", "set"], "one-shot")).toContain("PAN/BAL mode");
  });
});
