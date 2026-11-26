import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInfoModule, commitOf, revParse, versionOf } from "./build-info.mjs";

describe("embedded build information", () => {
  it("read a version, or unknown", () => {
    expect(versionOf('{"version":"0.1.0"}')).toBe("0.1.0");
    expect(versionOf('{"version":"1.2.3-rc.1"}')).toBe("1.2.3-rc.1");
    for (const text of [null, "", "{", "{}", '{"version":1}', '{"version":"latest"}', '{"version":"1.2"}']) {
      expect(versionOf(text), String(text)).toBe("unknown");
    }
  });

  it("read a full commit, or unknown", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(commitOf(`${commit}\n`)).toBe(commit);
    for (const output of [null, "", "0123456", `${commit}0`, commit.toUpperCase(), "HEAD"]) {
      expect(commitOf(output), String(output)).toBe("unknown");
    }
  });

  it("write a module with exactly the four fields", async () => {
    const text = buildInfoModule({ appVersion: "0.1.0", appCommit: "unknown", commonVersion: "0.1.0", commonCommit: "x", extra: "y" });
    const directory = mkdtempSync(join(tmpdir(), "build-info-"));
    try {
      const file = join(directory, "build-info.mjs");
      writeFileSync(file, text);
      const { BUILD_INFO } = await import(pathToFileURL(file).href);
      expect(BUILD_INFO).toEqual({ appVersion: "0.1.0", appCommit: "unknown", commonVersion: "0.1.0", commonCommit: "x" });
      expect(Object.isFrozen(BUILD_INFO)).toBe(true);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("take a commit only from the top level of a repository, not from an enclosing one", () => {
    const directory = mkdtempSync(join(tmpdir(), "build-info-git-"));
    try {
      const git = (...args) => execFileSync("git", ["-C", directory, ...args], { encoding: "utf8" });
      git("init", "-q");
      git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "test");
      const head = git("rev-parse", "HEAD").trim();
      mkdirSync(join(directory, "vendor"));
      expect(commitOf(revParse(directory))).toBe(head);
      expect(revParse(join(directory, "vendor"))).toBeNull();
      expect(revParse(join(directory, "missing"))).toBeNull();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
