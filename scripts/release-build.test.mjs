import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { cargoArtifact, cargoEnvironment, cleanUp, exportRelease, isModuleFormat, isRecordedPath, launcherArtifact, maintenanceTools, outputTool, publishOutput, recordedProblems, releaseRecord, removeExport, requireNoOutput, sha256, writeReleaseFiles } from "./release-build.mjs";
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
  let tool;
  beforeAll(() => {
    tool = outputTool(fileURLToPath(new URL("../", import.meta.url)));
  }, 300_000);
  const directory = (name, content) => {
    const path = join(scratch, name);
    mkdirSync(join(path, "native"), { recursive: true });
    writeFileSync(join(path, "main.js"), content);
    writeFileSync(join(path, "native", "urx-native.node"), content);
    return path;
  };
  const contents = (path) => [readFileSync(join(path, "main.js"), "utf8"), readFileSync(join(path, "native", "urx-native.node"), "utf8")];

  const workFolders = () => readdirSync(scratch).filter((name) => name.includes(".work-"));

  it("publish the staged files, the record last, as an output where nothing was", () => {
    const output = join(scratch, "dist-release");
    expect(() => requireNoOutput(output)).not.toThrow();
    const staging = directory("staging", "new");
    writeFileSync(join(staging, "release-files.json"), "record");
    publishOutput(staging, output, { last: "release-files.json", tool });
    expect(contents(output)).toEqual(["new", "new"]);
    expect(readFileSync(join(output, "release-files.json"), "utf8")).toBe("record");
    expect(workFolders()).toEqual([]);
  });

  it("leave whatever is at the output as it is and stop, an empty folder included", () => {
    const previous = directory("dist-release", "previous");
    writeFileSync(join(previous, "keep.txt"), "the user's");
    expect(() => requireNoOutput(previous)).toThrow(/already exists; the release build leaves it as it is, so remove it to build again/);
    // Put there after the build started, so the error names it as another's and asks nothing about it.
    expect(() => publishOutput(directory("staging", "new"), previous, { tool })).toThrow(/was put in place by another build or program while the release build ran; it is left as it is/);
    expect(() => publishOutput(directory("staging", "new"), previous, { tool })).not.toThrow(/remove it to build again/);
    expect(contents(previous)).toEqual(["previous", "previous"]);
    expect(readFileSync(join(previous, "keep.txt"), "utf8")).toBe("the user's");

    const empty = join(scratch, "dist-bundle");
    mkdirSync(empty);
    const before = statSync(empty).ino;
    expect(() => requireNoOutput(empty, "bundle build")).toThrow(/already exists; the bundle build leaves it as it is/);
    expect(() => publishOutput(directory("staging", "new"), empty, { label: "bundle build", tool })).toThrow(/while the bundle build ran; it is left as it is/);
    expect(statSync(empty).ino).toBe(before);
    expect(readdirSync(empty)).toEqual([]);

    const file = join(scratch, "dist-installer");
    writeFileSync(file, "the user's");
    expect(() => publishOutput(directory("staging", "new"), file, { label: "installer build", tool })).toThrow(/while the installer build ran; it is left as it is/);
    expect(readFileSync(file, "utf8")).toBe("the user's");
    expect(workFolders()).toEqual([]);
  });

  it("leave a link at the output as it is, a dangling one included", () => {
    const target = directory("elsewhere", "the user's");
    const output = join(scratch, "dist-release");
    const dangling = join(scratch, "dist-bundle");
    try {
      symlinkSync(target, output, "dir");
      symlinkSync(join(scratch, "nowhere"), dangling, "dir");
    } catch {
      return; // Creating a link needs a privilege this Windows account may lack.
    }
    expect(() => requireNoOutput(output)).toThrow(/already exists/);
    expect(() => publishOutput(directory("staging", "new"), output, { tool })).toThrow(/it is left as it is/);
    expect(contents(output)).toEqual(["the user's", "the user's"]);
    expect(() => publishOutput(directory("staging", "new"), dangling, { label: "bundle build", tool })).toThrow(/it is left as it is/);
    expect(existsSync(join(scratch, "nowhere"))).toBe(false);
  });

  it.skipIf(process.platform === "win32")("keep the staged folders' and files' modes in the output", () => {
    const output = join(scratch, "dist-bundle");
    const staging = directory("staging", "new");
    chmodSync(staging, 0o755);
    chmodSync(join(staging, "native"), 0o700);
    chmodSync(join(staging, "main.js"), 0o755);
    chmodSync(join(staging, "native", "urx-native.node"), 0o600);
    publishOutput(staging, output, { label: "bundle build", tool });
    const mode = (...path) => (statSync(join(output, ...path)).mode & 0o7777).toString(8);
    expect([mode(), mode("native"), mode("main.js"), mode("native", "urx-native.node")]).toEqual(["755", "700", "755", "600"]);
  });

  it("turn a failed removal of the build's own scratch into a warning, so it changes neither the result nor the error", () => {
    const warnings = [];
    expect(() =>
      cleanUp("bundle build", "/tmp/urx-bundle-x", () => {
        throw Object.assign(new Error("ENOTEMPTY: directory not empty"), { code: "ENOTEMPTY" });
      }, (message) => warnings.push(message)),
    ).not.toThrow();
    expect(warnings).toEqual(["bundle build: /tmp/urx-bundle-x could not be removed and is left there: ENOTEMPTY: directory not empty"]);
    let ran = false;
    cleanUp("release build", "/tmp/urx-release-x", () => (ran = true), (message) => warnings.push(message));
    expect(ran).toBe(true);
    expect(warnings).toHaveLength(1);
  });

  it("tell the package.json that says the output's modules are ES modules", () => {
    expect(isModuleFormat(Buffer.from('{"type":"module"}\n'))).toBe(true);
    expect(isModuleFormat(Buffer.from('{\r\n  "type": "module"\r\n}\r\n'))).toBe(true);
    expect(isModuleFormat(Buffer.from('{"type":"commonjs"}'))).toBe(false);
    expect(isModuleFormat(Buffer.from('{"type":"module","main":"x.js"}'))).toBe(false);
    expect(isModuleFormat(Buffer.from("not json"))).toBe(false);
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

  it("read no record with a path that is not one file inside the output, or with one file named twice", () => {
    const entry = (path) => ({ path, sha256: sha256(Buffer.from("previous")), size: 8 });
    const record = (...paths) => {
      const output = directory("dist-release", "previous");
      writeFileSync(join(output, "release-files.json"), JSON.stringify({ product: "urx-cli", output: "release", files: paths.map(entry) }));
      return releaseRecord(output);
    };
    expect(record("main.js", "native/urx-native.node")).toEqual([entry("main.js"), entry("native/urx-native.node")]);
    for (const path of ["", "/main.js", "../main.js", "native/../main.js", "./main.js", "native//urx-native.node", "native/", "native\\urx-native.node", "C:/main.js", "main.js\u0000"]) {
      expect(isRecordedPath(path), JSON.stringify(path)).toBe(false);
      expect(record(path), JSON.stringify(path)).toBe(null);
    }
    expect(record("main.js", "main.js")).toBe(null);
    expect(record("main.js", "MAIN.js")).toBe(null);
    expect(record("main.js", "release-files.json")).toBe(null);
  });

  it("read a recorded path only as a regular file under the output, reached through no link", () => {
    const output = directory("dist-release", "previous");
    writeReleaseFiles(output);
    const files = releaseRecord(output);
    // A directory where the record names a file is missing.
    rmSync(join(output, "main.js"));
    mkdirSync(join(output, "main.js"));
    expect(recordedProblems(output, files)).toEqual(["main.js is missing"]);
    // A path the record could not have named, outside the output, is never read.
    writeFileSync(join(scratch, "outside.js"), "previous");
    expect(recordedProblems(output, [{ path: "../outside.js", sha256: sha256(Buffer.from("previous")), size: 8 }])).toEqual(["../outside.js is missing"]);
  });

  it.skipIf(process.platform === "win32")("refuse an output that holds a link, where a recorded file could be read through it", () => {
    const output = directory("dist-release", "previous");
    writeReleaseFiles(output);
    const files = releaseRecord(output);
    rmSync(join(output, "native"), { recursive: true });
    mkdirSync(join(scratch, "elsewhere"));
    writeFileSync(join(scratch, "elsewhere", "urx-native.node"), "previous");
    symlinkSync(join(scratch, "elsewhere"), join(output, "native"));
    expect(() => recordedProblems(output, files)).toThrow(/may hold no link/);
  });

});

describe("the cargo builds' environment", () => {
  it("names one folder as both the target and the build directory, over the caller's settings of either", () => {
    expect(cargoEnvironment({ PATH: "/bin", CARGO_TARGET_DIR: "/mine/target", CARGO_BUILD_BUILD_DIR: "/mine/build" }, "/scratch/target")).toEqual({
      PATH: "/bin",
      CARGO_TARGET_DIR: "/scratch/target",
      CARGO_BUILD_BUILD_DIR: "/scratch/target",
    });
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

  it("names the maintenance tool by its own executable, built for macOS only", () => {
    const executable = "/scratch/target/release/urx-uninstall";
    expect(cargoArtifact(artifact("urx-uninstall", ["bin"], executable), "urx-uninstall")).toBe(executable);
    expect(() => cargoArtifact(artifact("urx-install", ["bin"], "/x"), "urx-uninstall")).toThrow(/no urx-uninstall executable/);
    expect(maintenanceTools("darwin")).toEqual(["urx-uninstall"]);
    expect(maintenanceTools("win32")).toEqual([]);
  });
});
