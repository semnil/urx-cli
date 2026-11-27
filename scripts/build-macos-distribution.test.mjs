import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { installerRecord } from "./build-macos-installer.mjs";
import { distributionNames, installerTreeProblems, prepareTree, treeDifference, treeOf } from "./build-macos-distribution.mjs";

const made = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** Modes are a property of macOS (and other POSIX) trees only. */
const posix = process.platform !== "win32";

/** A folder holding `files` (path, contents, mode), each folder in it 0755 whatever the umask. */
function folder(files) {
  const root = mkdtempSync(join(tmpdir(), "urx-distribution-test-"));
  made.push(root);
  for (const [path, contents, mode] of files) {
    const at = join(root, path);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, contents);
    chmodSync(at, mode);
  }
  const settle = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      chmodSync(join(directory, entry.name), 0o755);
      settle(join(directory, entry.name));
    }
  };
  settle(root);
  return root;
}

const files = [
  ["urx-install", "installer", 0o755],
  ["urx-cli/bin/urx", "launcher", 0o755],
  ["urx-cli/release-manifest.json", "{}", 0o644],
];
const changed = (index, entry) => files.map((file, at) => (at === index ? entry : file));

describe("the macOS distribution files (K41, K20)", () => {
  it("are named after the release", () => {
    expect(distributionNames("0.1.0")).toEqual({
      image: "urx-cli-0.1.0-macos-arm64.dmg",
      volume: "urx-cli 0.1.0",
      recovery: "urx-cli-0.1.0-macos-arm64-recovery.zip",
      recoveryFolder: "urx-cli-0.1.0-recovery",
    });
  });

  it("hold exactly the tree they are made from, with what each file holds", () => {
    const expected = treeOf(folder(files));
    expect(expected.map((entry) => `${entry.kind} ${entry.path}`)).toEqual([
      "directory urx-cli",
      "directory urx-cli/bin",
      "file urx-cli/bin/urx",
      "file urx-cli/release-manifest.json",
      "file urx-install",
    ]);
    expect(treeDifference(treeOf(folder(files)), expected)).toBeNull();
    expect(treeDifference(treeOf(folder(changed(1, ["urx-cli/bin/urx", "other", 0o755]))), expected)).toBe("urx-cli/bin/urx does not hold what it should");
    expect(treeDifference(treeOf(folder(files.slice(1))), expected)).toBe("urx-install is missing");
    expect(treeDifference(treeOf(folder([...files, ["urx-cli/extra", "", 0o644]])), expected)).toBe("urx-cli/extra should not be there");
    expect(treeDifference(treeOf(folder(changed(1, ["urx-cli/bin", "file", 0o644]))), expected)).toBe("urx-cli/bin is a file, not a directory");
  });

  it.skipIf(!posix)("hold each entry with the mode it is distributed with", () => {
    const expected = treeOf(folder(files));
    expect(expected.map((entry) => `${entry.path} ${entry.mode.toString(8)}`)).toEqual([
      "urx-cli 755",
      "urx-cli/bin 755",
      "urx-cli/bin/urx 755",
      "urx-cli/release-manifest.json 644",
      "urx-install 755",
    ]);
    expect(treeDifference(treeOf(folder(changed(1, ["urx-cli/bin/urx", "launcher", 0o644]))), expected)).toBe("urx-cli/bin/urx has mode 644, not 755");
    const folderMode = folder(files);
    chmodSync(join(folderMode, "urx-cli/bin"), 0o775);
    expect(treeDifference(treeOf(folderMode), expected)).toBe("urx-cli/bin has mode 775, not 755");
  });

  it.skipIf(!posix)("refuse a link in the tree", () => {
    const root = folder([["urx-install", "installer", 0o755]]);
    symlinkSync("urx-install", join(root, "link"));
    expect(() => treeOf(root)).toThrow("is not a regular file or a directory");
  });

  it.skipIf(!posix)("set no mode through a link anywhere in the installer tree", () => {
    const outside = folder([["target", "outside", 0o600]]);
    const target = join(outside, "target");
    for (const at of ["urx-install", "urx-cli", "urx-cli/bin/urx", "extra"]) {
      const tree = folder(files.filter(([path]) => path !== at && !path.startsWith(`${at}/`)));
      mkdirSync(join(tree, at, ".."), { recursive: true });
      symlinkSync(target, join(tree, at));
      expect(() => prepareTree(tree), at).toThrow();
      expect(statSync(target).mode & 0o777, at).toBe(0o600);
    }
    const tree = folder(files.map(([path, contents]) => [path, contents, 0o600]));
    prepareTree(tree);
    expect(treeDifference(treeOf(tree), treeOf(folder(files)))).toBeNull();
  });

  it("are made only from the urx-install the installer build recorded for the bundle beside it", () => {
    const manifest = Buffer.from('{"release":"0.1.0"}');
    const program = Buffer.from(`program ${installerRecord(Buffer.alloc(0), manifest).releaseManifest} end`);
    const tree = ({ installer = program, record = installerRecord(program, manifest), extra = [] } = {}) =>
      folder([
        ["urx-install", installer, 0o755],
        ["urx-cli/release-manifest.json", manifest, 0o644],
        ["installer.json", typeof record === "string" ? record : JSON.stringify(record), 0o644],
        ...extra,
      ]);
    expect(installerTreeProblems(tree(), manifest)).toEqual([]);
    // Cut short, or one byte changed: not the file the record names.
    expect(installerTreeProblems(tree({ installer: program.subarray(0, program.length - 4) }), manifest)).toEqual(["urx-install is not the file installer.json names"]);
    const changedByte = Buffer.from(program);
    changedByte[0] ^= 1;
    expect(installerTreeProblems(tree({ installer: changedByte }), manifest)).toEqual(["urx-install is not the file installer.json names"]);
    expect(installerTreeProblems(tree({ record: installerRecord(program, Buffer.from("{}")) }), manifest)).toEqual([
      "installer.json names another release manifest than the bundle's",
    ]);
    const other = Buffer.from(`program ${"0".repeat(64)} end`);
    expect(installerTreeProblems(tree({ installer: other, record: installerRecord(other, manifest) }), manifest)).toEqual(["urx-install is not built for the bundle beside it"]);
    expect(installerTreeProblems(tree({ record: "not json" }), manifest)).toEqual(["installer.json is not a record the installer build writes"]);
    expect(installerTreeProblems(tree({ extra: [["README", "", 0o644]] }), manifest)).toEqual([
      'the installer tree holds ["README","installer.json","urx-cli","urx-install"], not urx-install beside urx-cli with installer.json',
    ]);
  });
});
