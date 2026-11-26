import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { checkBuildInputs } from "./build-inputs.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf8");
const actual = () => ({
  manifest: JSON.parse(read("build-inputs.json")),
  nodeVersionFile: read(".node-version"),
  packageJson: JSON.parse(read("package.json")),
  rustToolchainFile: read("rust-toolchain.toml"),
});

describe("build inputs", () => {
  it("agree across build-inputs.json, .node-version and package.json", () => {
    expect(checkBuildInputs(actual())).toEqual([]);
  });

  it("accept .node-version with an LF or a CRLF line ending, and nothing else around the version", () => {
    const { version } = actual().manifest.node;
    for (const [content, problems] of [
      [`${version}\n`, 0],
      [`${version}\r\n`, 0],
      [version, 1],
      [`${version}\n\n`, 1],
      [`${version}\r\n\r\n`, 1],
      [`${version} \n`, 1],
      [`\n${version}\n`, 1],
    ]) {
      const files = actual();
      files.nodeVersionFile = content;
      expect(checkBuildInputs(files), JSON.stringify(content)).toHaveLength(problems);
    }
  });

  it("report each disagreement", () => {
    const pinned = actual().manifest.node.version.split(".").map(Number);
    const otherVersion = `${pinned[0]}.${pinned[1]}.${pinned[2] + 1}`;
    const cases = [
      [(f) => (f.nodeVersionFile = `${otherVersion}\n`), ".node-version"],
      [(f) => (f.packageJson.engines.node = ">=26 <27"), "engines.node"],
      [(f) => (f.packageJson.packageManager = "pnpm@10.7.1"), "packageManager"],
      [(f) => (f.manifest.node.checksums = "https://example.com/SHASUMS256.txt"), "node.checksums"],
      [(f) => delete f.manifest.node.archives["win-x64"], "node.archives lists"],
      [(f) => (f.manifest.node.archives["linux-x64"] = { file: "x", sha256: "0".repeat(64) }), "node.archives lists"],
      [(f) => (f.manifest.node.archives["darwin-arm64"].file = "node-v26.13.0-darwin-x64.tar.gz"), "darwin-arm64.file"],
      [(f) => (f.manifest.node.archives["win-x64"].sha256 = "ABC"), "win-x64.sha256"],
      [(f) => (f.rustToolchainFile = f.rustToolchainFile.replace(/channel = "[^"]*"/, 'channel = "1.0.0"')), "rust-toolchain.toml"],
      [(f) => (f.rustToolchainFile = "[other]\nchannel = \"1.96.0\"\n"), "rust-toolchain.toml"],
    ];
    for (const [mutate, fragment] of cases) {
      const files = actual();
      mutate(files);
      const problems = checkBuildInputs(files);
      expect(problems.length, fragment).toBe(1);
      expect(problems[0], fragment).toContain(fragment);
    }
  });

  it("stop at a malformed version or hash before comparing the other files", () => {
    for (const mutate of [
      (f) => (f.manifest.node.version = "26"),
      (f) => (f.manifest.pnpm.version = "latest"),
      (f) => (f.manifest.pnpm.sha512 = "00"),
      (f) => (f.manifest.rust.channel = "stable"),
    ]) {
      const files = actual();
      mutate(files);
      expect(checkBuildInputs(files)).toHaveLength(1);
    }
  });
});
