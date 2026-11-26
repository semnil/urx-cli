import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
    expect(git(root, "worktree", "list", "--porcelain")).not.toContain(destination);
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
    expect(git(root, "worktree", "list", "--porcelain")).toContain(other);
    renameSync(moved, other);
    expect(git(other, "status", "--porcelain")).toBe("");
  });

  it("clean up an export that was never created", () => {
    const destination = join(scratch, "never");
    expect(() => removeExport(root, destination)).not.toThrow();
  });
});

describe("release output", () => {
  it("replace the output with one complete staging directory", () => {
    const output = join(scratch, "dist-release");
    for (const content of ["first", "second"]) {
      const staging = join(scratch, `staging-${content}`);
      mkdirSync(staging);
      writeFileSync(join(staging, "main.js"), content);
      publishOutput(staging, output);
      expect(readFileSync(join(output, "main.js"), "utf8")).toBe(content);
      expect(existsSync(staging)).toBe(false);
    }
  });

  it("fail, and leave the other release's output, when another release put its output there first", () => {
    const output = join(scratch, "dist-release");
    const staging = join(scratch, "staging");
    mkdirSync(staging);
    writeFileSync(join(staging, "main.js"), "this release");
    const raced = (from, to) => {
      // Another release finishes between this one's removal and rename.
      mkdirSync(to);
      writeFileSync(join(to, "main.js"), "other release");
      renameSync(from, to);
    };
    expect(() => publishOutput(staging, output, raced)).toThrow(/another release build replaced/);
    expect(readFileSync(join(output, "main.js"), "utf8")).toBe("other release");
    expect(existsSync(staging)).toBe(false);
  });
});
