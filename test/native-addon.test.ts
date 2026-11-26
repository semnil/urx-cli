// The built CLI and its built addon together (K30): `pnpm build` and
// `pnpm build:native` must have run. A missing build fails here rather than
// skipping, so CI cannot pass without it.

import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
// @ts-expect-error -- a JavaScript module without type declarations
import { commitOf, revParse, versionOf } from "../scripts/build-info.mjs";
import { BRIDGE_API_EXPECTED } from "../src/bridge.js";

const dist = new URL("../dist/", import.meta.url);
const common = fileURLToPath(new URL("../vendor/urx-device/", import.meta.url));

/** The distributed modules, loaded from dist/ as the CLI loads them. */
async function distributed() {
  const addon = (await import(new URL("native/addon.js", dist).href)) as typeof import("../src/native/addon.js");
  const build = (await import(new URL("build-info.js", dist).href)) as typeof import("../src/build-info.js");
  return { addon, build };
}

describe("the built CLI and addon", () => {
  it("exist (run `pnpm build` and `pnpm build:native` first)", () => {
    expect(existsSync(new URL("native/urx-native.node", dist))).toBe(true);
    expect(existsSync(new URL("native/addon.js", dist))).toBe(true);
    expect(existsSync(new URL("build-info.js", dist))).toBe(true);
  });

  it("accept each other: the distributed JavaScript loads the addon from its default place with its own expectation", async () => {
    const { addon, build } = await distributed();
    expect(addon.openAddon(addon.expectedIdentity(build.BUILD_INFO))).toMatchObject({ ok: true });
  });

  it("both describe this checkout's urx-device and bridge revision", async () => {
    const { addon, build } = await distributed();
    expect(addon.expectedIdentity(build.BUILD_INFO)).toEqual({
      bridgeRevision: BRIDGE_API_EXPECTED,
      commonVersion: versionOf(readFileSync(new URL("../vendor/urx-device/package.json", import.meta.url), "utf8")),
      commonCommit: commitOf(revParse(common)),
    });
  });

  it("refuse the addon for any other expectation", async () => {
    const { addon, build } = await distributed();
    const expected = addon.expectedIdentity(build.BUILD_INFO);
    expect(addon.openAddon({ ...expected, bridgeRevision: expected.bridgeRevision + 1 })).toEqual({ ok: false, problem: "bridge_mismatch" });
    expect(addon.openAddon({ ...expected, commonCommit: "f".repeat(40) })).toEqual({ ok: false, problem: "common_mismatch" });
    expect(addon.openAddon({ ...expected, commonVersion: "99.0.0" })).toEqual({ ok: false, problem: "common_mismatch" });
  });
});
