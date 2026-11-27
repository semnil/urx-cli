import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { distributionNames, installerTreeProblems, treeDifference, treeOf } from "./build-macos-distribution.mjs";
import { sha256 } from "./release-build.mjs";

const made = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A folder holding `files` (path, contents, mode). */
function folder(files) {
  const root = mkdtempSync(join(tmpdir(), "urx-distribution-test-"));
  made.push(root);
  for (const [path, contents, mode] of files) {
    const at = join(root, path);
    mkdirSync(join(at, ".."), { recursive: true });
    writeFileSync(at, contents);
    chmodSync(at, mode);
  }
  return root;
}

describe("the macOS distribution files (K41, K20)", () => {
  it("are named after the release", () => {
    expect(distributionNames("0.1.0")).toEqual({
      image: "urx-cli-0.1.0-macos-arm64.dmg",
      volume: "urx-cli 0.1.0",
      recovery: "urx-cli-0.1.0-macos-arm64-recovery.zip",
      recoveryFolder: "urx-cli-0.1.0-recovery",
    });
  });

  it("hold exactly the tree they are made from, with its contents and modes", () => {
    const files = [
      ["urx-install", "installer", 0o755],
      ["urx-cli/bin/urx", "launcher", 0o755],
      ["urx-cli/release-manifest.json", "{}", 0o644],
    ];
    const expected = treeOf(folder(files));
    expect(expected.map((entry) => `${entry.kind} ${entry.path} ${entry.mode.toString(8)}`)).toEqual([
      "directory urx-cli 755",
      "directory urx-cli/bin 755",
      "file urx-cli/bin/urx 755",
      "file urx-cli/release-manifest.json 644",
      "file urx-install 755",
    ]);
    expect(treeDifference(treeOf(folder(files)), expected)).toBeNull();
    const changed = (index, entry) => files.map((file, at) => (at === index ? entry : file));
    expect(treeDifference(treeOf(folder(changed(1, ["urx-cli/bin/urx", "other", 0o755]))), expected)).toBe("urx-cli/bin/urx does not hold what it should");
    expect(treeDifference(treeOf(folder(changed(1, ["urx-cli/bin/urx", "launcher", 0o644]))), expected)).toBe("urx-cli/bin/urx has mode 644, not 755");
    expect(treeDifference(treeOf(folder(files.slice(1))), expected)).toBe("urx-install is missing");
    expect(treeDifference(treeOf(folder([...files, ["urx-cli/extra", "", 0o644]])), expected)).toBe("urx-cli/extra should not be there");
    expect(treeDifference(treeOf(folder(changed(1, ["urx-cli/bin", "file", 0o644]))), expected)).toBe("urx-cli/bin is a file, not a directory");
  });

  it("refuse a link in the tree", () => {
    const root = folder([["urx-install", "installer", 0o755]]);
    symlinkSync("urx-install", join(root, "link"));
    expect(() => treeOf(root)).toThrow("is not a regular file or a directory");
  });

  it("are made only from urx-install beside the bundle it is built for", () => {
    const manifest = Buffer.from('{"release":"0.1.0"}');
    const digest = sha256(manifest);
    const tree = (program, extra = []) =>
      folder([["urx-install", program, 0o755], ["urx-cli/release-manifest.json", manifest, 0o644], ...extra]);
    expect(installerTreeProblems(tree(`program ${digest} end`), manifest)).toEqual([]);
    expect(installerTreeProblems(tree(`program ${"0".repeat(64)} end`), manifest)).toEqual(["urx-install is not built for the bundle beside it"]);
    expect(installerTreeProblems(tree(`program ${digest} end`, [["README", "", 0o644]]), manifest)).toEqual([
      'the installer tree holds ["README","urx-cli","urx-install"], not urx-install beside urx-cli',
    ]);
  });
});
