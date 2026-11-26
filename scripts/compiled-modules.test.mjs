import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { compiledModules, moduleDifference } from "./compiled-modules.mjs";
import { COMMON_PATH, gitlinkOf } from "./release-source.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8", env: withoutGitLocation(process.env) });

describe("the modules a release compiles to", () => {
  it("are the committed sources of the CLI and the common package, without tests", () => {
    const appCommit = git("rev-parse", "HEAD").trim();
    const commonCommit = gitlinkOf(git("ls-tree", "HEAD", COMMON_PATH));
    const { cli, common } = compiledModules(root, { appCommit, commonCommit });
    expect(cli).toEqual(expect.arrayContaining(["main.js", "device-list.js", "native/addon.js"]));
    expect(cli.some((path) => path.includes(".test"))).toBe(false);
    expect(common.length).toBeGreaterThan(0);
    expect(common.some((path) => path.includes(".test") || path.endsWith(".d.js"))).toBe(false);
  });

  it("are refused when the build information names no commit", () => {
    expect(() => compiledModules(root, { appCommit: "unknown", commonCommit: "unknown" })).toThrow(/names no commit/);
  });

  it("tell what a copy lacks and what it holds beyond them", () => {
    expect(moduleDifference(["main.js", "stale.js"], ["device-list.js", "main.js"])).toEqual({ missing: ["device-list.js"], extra: ["stale.js"] });
    expect(moduleDifference(["main.js"], ["main.js"])).toEqual({ missing: [], extra: [] });
  });
});
