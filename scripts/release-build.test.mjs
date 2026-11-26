import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportRelease, launcherArtifact, publishOutput, recordedProblems, releaseRecord, removeExport, sha256, writeReleaseFiles } from "./release-build.mjs";
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

  it("create the output from one complete staging directory", () => {
    const output = join(scratch, "dist-release");
    const staging = directory("staging", "new");
    publishOutput(staging, output);
    expect(contents(output)).toEqual(["new", "new"]);
    expect(existsSync(staging)).toBe(false);
  });

  it("leave whatever is at the output as it is, remove the new one and stop", () => {
    const previous = directory("dist-release", "previous");
    writeFileSync(join(previous, "keep.txt"), "the user's");
    const staging = directory("staging", "new");
    expect(() => publishOutput(staging, previous)).toThrow(/already exists; the release build leaves it as it is, so remove it to build again/);
    expect(contents(previous)).toEqual(["previous", "previous"]);
    expect(readFileSync(join(previous, "keep.txt"), "utf8")).toBe("the user's");
    expect(existsSync(staging)).toBe(false);

    const file = join(scratch, "dist-bundle");
    writeFileSync(file, "the user's");
    expect(() => publishOutput(directory("staging", "new"), file, { label: "bundle build" })).toThrow(/already exists; the bundle build leaves it/);
    expect(readFileSync(file, "utf8")).toBe("the user's");
  });

  it("leave a link at the output as it is", () => {
    const target = directory("elsewhere", "the user's");
    const output = join(scratch, "dist-release");
    try {
      symlinkSync(target, output, "dir");
    } catch {
      return; // Creating a link needs a privilege this Windows account may lack.
    }
    expect(() => publishOutput(directory("staging", "new"), output)).toThrow(/already exists/);
    expect(contents(output)).toEqual(["the user's", "the user's"]);
  });

  it("leave the output another build created first, and remove the new one", () => {
    const output = join(scratch, "dist-release");
    const staging = directory("staging", "this");
    const raced = (from, to) => {
      directory("dist-release", "other");
      renameSync(from, to);
    };
    expect(() => publishOutput(staging, output, { rename: raced })).toThrow(/could not be created; another release build may have created it first/);
    expect(contents(output)).toEqual(["other", "other"]);
    expect(existsSync(staging)).toBe(false);
  });

  it("warn, naming the build, when the new output cannot be removed", () => {
    const output = directory("dist-bundle", "previous");
    const staging = directory("staging", "new");
    const warnings = [];
    const stuck = () => {
      throw Object.assign(new Error("read-only"), { code: "EACCES" });
    };
    expect(() => publishOutput(staging, output, { remove: stuck, warn: (message) => warnings.push(message), label: "bundle build" })).toThrow(/already exists/);
    expect(warnings).toEqual([`bundle build: the new output could not be removed from ${staging}`]);
    expect(contents(output)).toEqual(["previous", "previous"]);
  });

  it("record the files a release build made, with their hashes and sizes, and read them back", () => {
    const output = directory("dist-release", "previous");
    expect(releaseRecord(output)).toBe(null);
    writeReleaseFiles(output);
    const hash = sha256(Buffer.from("previous"));
    expect(releaseRecord(output)).toEqual([
      { path: "main.js", sha256: hash, size: 8 },
      { path: "native/urx-native.node", sha256: hash, size: 8 },
    ]);
  });

  it("tell a recorded file that is missing or not as it was built", () => {
    const output = directory("dist-release", "previous");
    writeReleaseFiles(output);
    const files = releaseRecord(output);
    expect(recordedProblems(output, files)).toEqual([]);
    writeFileSync(join(output, "main.js"), "");
    rmSync(join(output, "native", "urx-native.node"));
    expect(recordedProblems(output, files)).toEqual(["main.js is not as it was built", "native/urx-native.node is missing"]);
  });

  it("read no record whose entries lack a hash", () => {
    const output = directory("dist-release", "previous");
    writeFileSync(join(output, "release-files.json"), JSON.stringify({ product: "urx-cli", output: "release", files: ["main.js"] }));
    expect(releaseRecord(output)).toBe(null);
  });

});

describe("the launcher's location", () => {
  const artifact = (name, kind, executable) => JSON.stringify({ reason: "compiler-artifact", target: { name, kind }, executable });

  it("is the urx executable cargo reports building, wherever the target in use puts it", () => {
    const executable = "/scratch/target/aarch64-apple-darwin/release/urx";
    const messages = [artifact("sha2", ["lib"], null), "not json", artifact("urx", ["bin"], executable), JSON.stringify({ reason: "build-finished", success: true })].join("\n");
    expect(launcherArtifact(messages)).toBe(executable);
  });

  it("is refused when cargo reports building no urx executable", () => {
    expect(() => launcherArtifact(artifact("urx_launcher", ["lib"], null))).toThrow(/no urx executable/);
  });
});
