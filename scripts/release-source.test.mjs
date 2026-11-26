import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { withoutGitLocation } from "./build-info.mjs";
import { COMMON_PATH, gitlinkOf, releaseSourceProblems } from "./release-source.mjs";

const environment = withoutGitLocation(process.env);
const git = (directory, ...args) =>
  execFileSync(
    "git",
    ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", "-c", "protocol.file.allow=always", "-C", directory, ...args],
    { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );

let scratch;
let root;
let common;

/** A CLI repository with a urx-device submodule at its pinned commit, both clean. */
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), "release-source-"));
  const origin = join(scratch, "urx-device");
  git(scratch, "init", "-q", "urx-device");
  writeFileSync(join(origin, "package.json"), '{"version":"0.1.0"}\n');
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "first");
  writeFileSync(join(origin, "lib.txt"), "first\n");
  git(origin, "add", ".");
  git(origin, "commit", "-q", "-m", "second");
  root = join(scratch, "cli");
  git(scratch, "init", "-q", "cli");
  writeFileSync(join(root, "package.json"), '{"version":"0.1.0"}\n');
  git(root, "submodule", "add", "-q", origin, COMMON_PATH);
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "pin");
  common = join(root, COMMON_PATH);
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe("release source check", () => {
  it("accept a clean checkout at the pinned commit, with untracked files", () => {
    writeFileSync(join(root, "untracked.txt"), "x\n");
    writeFileSync(join(common, "untracked.txt"), "x\n");
    expect(releaseSourceProblems(root)).toEqual([]);
  });

  it("refuse a submodule at another commit", () => {
    git(common, "checkout", "-q", "HEAD~1");
    expect(releaseSourceProblems(root)).toEqual([`${COMMON_PATH} is not at the commit that HEAD pins`]);
  });

  it("refuse unstaged and staged changes to tracked files in either repository", () => {
    writeFileSync(join(common, "lib.txt"), "changed\n");
    expect(releaseSourceProblems(root)).toEqual([`${COMMON_PATH} has staged or unstaged changes to tracked files`]);
    git(common, "add", "lib.txt");
    expect(releaseSourceProblems(root)).toEqual([`${COMMON_PATH} has staged or unstaged changes to tracked files`]);
    git(common, "checkout", "-q", "HEAD", "--", "lib.txt");
    writeFileSync(join(root, "package.json"), '{"version":"0.1.0","x":1}\n');
    expect(releaseSourceProblems(root)).toEqual(["the CLI has staged or unstaged changes to tracked files"]);
    git(root, "add", "package.json");
    expect(releaseSourceProblems(root)).toEqual(["the CLI has staged or unstaged changes to tracked files"]);
  });

  it("refuse an unknown version on either side", () => {
    rmSync(join(common, "package.json"));
    git(common, "commit", "-q", "-am", "drop the version");
    git(root, "add", COMMON_PATH);
    git(root, "commit", "-q", "-m", "pin again");
    expect(releaseSourceProblems(root)).toEqual(["the urx-device version is unknown"]);
  });

  it("refuse an uninitialized submodule", () => {
    git(root, "submodule", "deinit", "-q", "--force", COMMON_PATH);
    expect(releaseSourceProblems(root)).toContain(`${COMMON_PATH} is not at the commit that HEAD pins`);
  });

  it("read the gitlink only for the submodule path", () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    expect(gitlinkOf(`160000 commit ${commit}\t${COMMON_PATH}\n`)).toBe(commit);
    expect(gitlinkOf(`160000 commit ${commit}\tvendor/other\n`)).toBeNull();
    expect(gitlinkOf(`100644 blob ${commit}\t${COMMON_PATH}\n`)).toBeNull();
    expect(gitlinkOf(null)).toBeNull();
  });
});
