// The built addon itself (K30): `pnpm build:native` must have run. A missing
// addon fails here rather than skipping, so CI cannot pass without it.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a JavaScript module without type declarations
import { commitOf, revParse, versionOf } from "../scripts/build-info.mjs";
import { BRIDGE_API_EXPECTED } from "../src/bridge.js";
import { openAddon, type ExpectedIdentity } from "../src/native/addon.js";

const built = new URL("../dist/native/urx-native.node", import.meta.url);
const common = fileURLToPath(new URL("../vendor/urx-device/", import.meta.url));
const checkout: ExpectedIdentity = {
  bridgeRevision: BRIDGE_API_EXPECTED,
  commonVersion: versionOf(readFileSync(new URL("../vendor/urx-device/package.json", import.meta.url), "utf8")),
  commonCommit: commitOf(revParse(common)),
};

describe("the built addon", () => {
  it("exists (run `pnpm build:native` first)", () => {
    expect(existsSync(built)).toBe(true);
  });

  it("report the urx-device version and commit of this checkout and the expected bridge revision", () => {
    expect(openAddon(checkout, built)).toMatchObject({ ok: true });
  });

  it("is refused for any other expectation", () => {
    expect(openAddon({ ...checkout, bridgeRevision: checkout.bridgeRevision + 1 }, built)).toEqual({ ok: false, problem: "bridge_mismatch" });
    expect(openAddon({ ...checkout, commonCommit: "f".repeat(40) }, built)).toEqual({ ok: false, problem: "common_mismatch" });
    expect(openAddon({ ...checkout, commonVersion: "99.0.0" }, built)).toEqual({ ok: false, problem: "common_mismatch" });
  });
});
