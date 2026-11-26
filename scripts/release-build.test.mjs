import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportRelease, publishOutput, removeExport } from "./release-build.mjs";
import { COMMON_PATH } from "./release-source.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const environment = withoutGitLocation(process.env);
const git = (directory, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", "-C", directory, ...args],
    { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
  ).trim();

let scratch;
let root;
let common;
let first;
let second;
/** The worktrees registered for the CLI repository, its main one included. */
const worktreeCount = () => git(root, "worktree", "list", "--porcelain").split("\n").filter((line) => line.startsWith("worktree ")).length;
/** File contents without the CRLF line endings a Windows checkout gives them. */
const text = (path) => readFileSync(path, "utf8").replaceAll("\r\n", "\n");

/** A CLI repository whose gitlink pins the second of two urx-device commits. */
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "release-build-"));
  const origin = join(scratch, "urx-device");
  git(scratch, "init", "-q", "urx-device");
  writeFileSync(join(origin, "lib.txt"), "first\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "first");
  first = git(origin, "rev-parse", "HEAD");
  writeFileSync(join(origin, "lib.txt"), "second\n");
  git(origin, "commit", "-q", "-am", "second");
  second = git(origin, "rev-parse", "HEAD");
  root = join(scratch, "cli");
  git(scratch, "init", "-q", "cli");
  writeFileSync(join(root, "app.txt"), "recorded\n");
  git(root, "submodule", "add", "-q", origin, COMMON_PATH);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "pin");
  common = join(root, COMMON_PATH);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("release export", () => {
  it("export the recorded commits whatever the working tree, the index and Git's display settings hold", () => {
    // A staged gitlink to another commit, then unstaged and hidden changes in both repositories.
    git(common, "checkout", "-q", first);
    git(root, "add", COMMON_PATH);
    git(common, "checkout", "-q", second);
    writeFileSync(join(root, "app.txt"), "edited\n");
    git(root, "update-index", "--assume-unchanged", "app.txt");
    writeFileSync(join(common, "lib.txt"), "edited\n");
    git(common, "update-index", "--skip-worktree", "lib.txt");
    expect(git(root, "diff", "--cached", "--name-only")).toBe(COMMON_PATH);

    const destination = join(scratch, "export");
    const commits = exportRelease(root, destination);
    try {
      expect(commits).toEqual({ appCommit: git(root, "rev-parse", "HEAD"), commonCommit: second });
      expect(text(join(destination, "app.txt"))).toBe("recorded\n");
      expect(text(join(destination, COMMON_PATH, "lib.txt"))).toBe("second\n");
      expect(git(join(destination, COMMON_PATH), "rev-parse", "HEAD")).toBe(second);
      expect(git(destination, "status", "--porcelain=v1", "--untracked-files=no")).toBe("");
    } finally {
      removeExport(root, destination);
    }
    expect(existsSync(destination)).toBe(false);
    expect(worktreeCount()).toBe(1);
  });

  it("export every tracked file when the caller has a sparse checkout, and leave the caller's sparse checkout as it is", () => {
    mkdirSync(join(root, "kept"));
    writeFileSync(join(root, "kept", "a.txt"), "a\n");
    mkdirSync(join(root, "excluded"));
    writeFileSync(join(root, "excluded", "b.txt"), "b\n");
    git(root, "add", ".");
    git(root, "commit", "-q", "-m", "two directories");
    git(root, "sparse-checkout", "set", "kept");
    expect(existsSync(join(root, "excluded", "b.txt"))).toBe(false);

    const destination = join(scratch, "export");
    exportRelease(root, destination);
    try {
      expect(text(join(destination, "excluded", "b.txt"))).toBe("b\n");
      expect(text(join(destination, "app.txt"))).toBe("recorded\n");
      expect(git(destination, "ls-files", "-v").split("\n").filter((line) => !line.startsWith("H "))).toEqual([]);
    } finally {
      removeExport(root, destination);
    }
    expect(existsSync(join(root, "excluded", "b.txt"))).toBe(false);
  });

  it("remove only its own worktree, keeping another whose directory is out of sight", () => {
    const other = join(scratch, "other");
    git(root, "worktree", "add", "-q", "--detach", other);
    const moved = join(scratch, "other-moved");
    renameSync(other, moved);
    const destination = join(scratch, "export");
    exportRelease(root, destination);
    removeExport(root, destination);
    expect(worktreeCount()).toBe(2);
    // A pruned registration would leave the moved-back worktree unusable.
    renameSync(moved, other);
    expect(git(other, "status", "--porcelain")).toBe("");
  });

  it("clean up an export that was never created", () => {
    const destination = join(scratch, "never");
    expect(() => removeExport(root, destination)).not.toThrow();
  });
});

describe("release output", () => {
  const directory = (name, content) => {
    const path = join(scratch, name);
    mkdirSync(join(path, "native"), { recursive: true });
    writeFileSync(join(path, "main.js"), content);
    writeFileSync(join(path, "native", "urx-native.node"), content);
    return path;
  };
  const contents = (path) => [readFileSync(join(path, "main.js"), "utf8"), readFileSync(join(path, "native", "urx-native.node"), "utf8")];
  const asides = () => readdirSync(scratch).filter((name) => name.startsWith("dist-release-previous-"));

  it("replace the output with one complete staging directory and remove the previous one", () => {
    const output = join(scratch, "dist-release");
    publishOutput(directory("staging-1", "first"), output);
    expect(contents(output)).toEqual(["first", "first"]);
    publishOutput(directory("staging-2", "second"), output);
    expect(contents(output)).toEqual(["second", "second"]);
    expect(asides()).toEqual([]);
    expect(existsSync(join(scratch, "staging-2"))).toBe(false);
  });

  it("restore the previous output whole when the new one cannot be put in place", () => {
    const output = directory("dist-release", "previous");
    const staging = directory("staging", "new");
    const failing = (from, to) => {
      if (from === staging) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      renameSync(from, to);
    };
    expect(() => publishOutput(staging, output, { rename: failing })).toThrow(/could not be replaced/);
    expect(contents(output)).toEqual(["previous", "previous"]);
    expect(existsSync(staging)).toBe(false);
    expect(asides()).toEqual([]);
  });

  it("leave the other release's output when it got there first, and keep this release's previous output aside", () => {
    const output = directory("dist-release", "previous");
    const staging = directory("staging", "this");
    const warnings = [];
    const raced = (from, to) => {
      if (from === staging) {
        // Another release finishes between this one's set-aside and rename.
        directory("dist-release", "other");
      }
      renameSync(from, to);
    };
    expect(() => publishOutput(staging, output, { rename: raced, warn: (message) => warnings.push(message) })).toThrow(/could not be replaced/);
    expect(contents(output)).toEqual(["other", "other"]);
    expect(asides()).toHaveLength(1);
    expect(contents(join(scratch, asides()[0]))).toEqual(["previous", "previous"]);
    expect(warnings).toHaveLength(1);
  });

  it("keep the new output and only warn when the previous one cannot be removed", () => {
    const output = directory("dist-release", "previous");
    const warnings = [];
    const stuck = (path) => {
      if (path.includes("-previous-")) throw Object.assign(new Error("read-only"), { code: "EACCES" });
      rmSync(path, { recursive: true, force: true });
    };
    publishOutput(directory("staging", "new"), output, { remove: stuck, warn: (message) => warnings.push(message) });
    expect(contents(output)).toEqual(["new", "new"]);
    expect(asides()).toHaveLength(1);
    expect(warnings).toHaveLength(1);
  });

  it("leave the previous output complete under its set-aside name when interrupted between the renames", () => {
    const output = directory("dist-release", "previous");
    const staging = directory("staging", "new");
    const interrupted = (from, to) => {
      if (from === staging) throw new Error("interrupted");
      renameSync(from, to);
    };
    // Restoring is part of the same failure path; without it, the set-aside copy is complete.
    const noRestore = (from, to) => {
      if (from.includes("-previous-")) throw new Error("interrupted again");
      interrupted(from, to);
    };
    expect(() => publishOutput(staging, output, { rename: noRestore, warn: () => {} })).toThrow();
    expect(existsSync(output)).toBe(false);
    expect(asides()).toHaveLength(1);
    expect(contents(join(scratch, asides()[0]))).toEqual(["previous", "previous"]);
  });
});
