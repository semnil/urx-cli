import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { buildInfoModule, commitOf, revParse, versionOf, withoutGitLocation } from "./build-info.mjs";

describe("embedded build information", () => {
  it("read a version, or unknown", () => {
    expect(versionOf('{"version":"0.1.0"}')).toBe("0.1.0");
    for (const version of ["1.2.3-rc.1", "1.2.3+build.5", "1.2.3-rc.1+build.6", "0.0.0", "10.20.30-alpha.beta-1"]) {
      expect(versionOf(JSON.stringify({ version })), version).toBe(version);
    }
    const invalid = ["01.2.3", "1.02.3", "1.2.03", "1.2.3-..", "1.2.3-01", "1.2.3+", "1.2.3-", "v1.2.3", " 1.2.3"];
    for (const text of [null, "", "{", "{}", '{"version":1}', '{"version":"latest"}', '{"version":"1.2"}', ...invalid.map((version) => JSON.stringify({ version }))]) {
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
      // A GIT_DIR inherited from a hook does not redirect the lookup.
      const elsewhere = { ...process.env, GIT_DIR: join(directory, ".git"), GIT_WORK_TREE: directory };
      expect(revParse(join(directory, "vendor"), elsewhere)).toBeNull();
      expect(commitOf(revParse(directory, elsewhere))).toBe(head);
      // A repository that only safe.directory lets git read keeps its commit.
      const foreign = { ...process.env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" };
      expect(revParse(directory, foreign)).toBeNull();
      const allowed = { ...foreign, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*" };
      expect(commitOf(revParse(directory, allowed))).toBe(head);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("remove git's repository-local variables but keep configuration and the rest", () => {
    const environment = { GIT_DIR: "a", GIT_WORK_TREE: "b", GIT_INDEX_FILE: "i", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "safe.directory", GIT_CONFIG_VALUE_0: "*", GIT_CONFIG_GLOBAL: "g", PATH: "p" };
    expect(withoutGitLocation(environment, ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_CONFIG", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"])).toEqual({
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "safe.directory",
      GIT_CONFIG_VALUE_0: "*",
      GIT_CONFIG_GLOBAL: "g",
      PATH: "p",
    });
    expect(Object.keys(withoutGitLocation({ ...process.env, GIT_DIR: "a", GIT_WORK_TREE: "b", GIT_COMMON_DIR: "c" }))).not.toEqual(expect.arrayContaining(["GIT_DIR"]));
  });
});
