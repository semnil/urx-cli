import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { EXECUTABLES, installerRecord, macosBundleProblems } from "./build-macos-installer.mjs";
import { sha256 } from "./release-build.mjs";
import { maintenanceTools } from "./release-build.mjs";

const inputs = JSON.parse(readFileSync(new URL("../build-inputs.json", import.meta.url), "utf8"));
const archive = inputs.node.archives["darwin-arm64"];
const commit = "a".repeat(40);
const manifest = (overrides = {}) => ({
  product: "urx-cli",
  format: 1,
  release: "0.1.0",
  app: { version: "0.1.0", commit },
  runtime: { version: inputs.node.version, archive: archive.file, sha256: archive.sha256 },
  files: ["bin/urx", "runtime/node", "native/urx-native.node", "app/main.js", "maintenance/urx-uninstall"].map((path) => ({ path, sha256: "0".repeat(64), size: 1 })),
  ...overrides,
});

describe("the macOS installer tree (K41)", () => {
  it("takes a macOS arm64 bundle of HEAD's commit with every required file", () => {
    expect(macosBundleProblems(manifest(), inputs, commit)).toEqual([]);
  });

  it("refuses another platform's runtime, another commit, an unrecordable release and a missing required file", () => {
    const windows = inputs.node.archives["win-x64"];
    expect(macosBundleProblems(manifest({ runtime: { archive: windows.file, sha256: windows.sha256 } }), inputs, commit)).toEqual([
      `the bundle's runtime is not ${archive.file}, the macOS arm64 Node archive build-inputs.json records`,
    ]);
    expect(macosBundleProblems(manifest(), inputs, "b".repeat(40))).toEqual([`the bundle is of urx-cli ${commit}, not of HEAD ${"b".repeat(40)}`]);
    expect(macosBundleProblems(manifest({ release: "0.1.0 beta" }), inputs, commit)).toEqual(["the bundle names no release version the installer can record: 0.1.0 beta"]);
    expect(macosBundleProblems(manifest({ files: manifest().files.filter((file) => file.path !== "maintenance/urx-uninstall") }), inputs, commit)).toEqual([
      "the bundle lists no maintenance/urx-uninstall",
    ]);
    const unicode = [...manifest().files, { path: "app/caf\u00e9.js", sha256: "0".repeat(64), size: 1 }];
    expect(macosBundleProblems(manifest({ files: unicode }), inputs, commit)).toEqual([`the bundle lists a path the installer cannot take: "app/caf\u00e9.js"`]);
  });

  it("runs the launcher, the runtime and the bundle's maintenance tools as programs", () => {
    expect(EXECUTABLES).toEqual(["bin/urx", "runtime/node", ...maintenanceTools("darwin").map((tool) => `maintenance/${tool}`)]);
  });

  it("records urx-install, by its SHA-256 and size, with the release manifest it is built for", () => {
    const program = Buffer.from("program");
    const manifestBytes = Buffer.from("{}");
    expect(installerRecord(program, manifestBytes)).toEqual({
      installer: { path: "urx-install", sha256: sha256(program), size: 7 },
      releaseManifest: sha256(manifestBytes),
    });
  });
});
