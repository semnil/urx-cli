import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleProblems, innoVersionNumber, ownedFilesInclude, windowsBundleProblems } from "./build-windows-installer.mjs";
import { sha256 } from "./release-build.mjs";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const hash = (text) => sha256(Buffer.from(text));
const digest = "f".repeat(64);

describe("the Windows installer's list of owned files", () => {
  it("lists each bundle file as a Windows path with its SHA-256, then the manifest", () => {
    const include = ownedFilesInclude({ files: [{ path: "bin/urx.exe", sha256: hash("a") }, { path: "app/it's.js", sha256: hash("b") }] }, digest);
    expect(include.split("\r\n")).toEqual([
      "procedure LoadOwnedFiles(var Paths, Hashes: TArrayOfString);",
      "begin",
      "  SetArrayLength(Paths, 3);",
      "  SetArrayLength(Hashes, 3);",
      "  Paths[0] := 'bin\\urx.exe';",
      `  Hashes[0] := '${hash("a")}';`,
      "  Paths[1] := 'app\\it''s.js';",
      `  Hashes[1] := '${hash("b")}';`,
      "  Paths[2] := 'release-manifest.json';",
      `  Hashes[2] := '${digest}';`,
      "end;",
      "",
    ]);
  });

  it("refuses a path that leaves the installation or that Windows cannot hold, a file named twice, and a missing hash", () => {
    for (const path of ["../outside.js", "app//main.js", "app/a:b.js", "/absolute.js", "app/a\u0001.js", ""]) {
      expect(() => ownedFilesInclude({ files: [{ path, sha256: hash("a") }] }, digest), JSON.stringify(path)).toThrow(/cannot hold/);
    }
    expect(() => ownedFilesInclude({ files: [{ path: "app/main.js", sha256: "x" }] }, digest)).toThrow(/no SHA-256/);
    const twice = [{ path: "app/main.js", sha256: hash("a") }, { path: "APP/Main.js", sha256: hash("b") }];
    expect(() => ownedFilesInclude({ files: twice }, digest)).toThrow(/names APP\/Main.js twice/);
    expect(() => ownedFilesInclude({ files: [{ path: "release-manifest.json", sha256: hash("a") }] }, digest)).toThrow(/names release-manifest.json twice/);
  });
});

describe("the bundle the installer is built from", () => {
  const bundle = (files) => {
    const dir = mkdtempSync(join(tmpdir(), "urx-installer-test-"));
    temporary.push(dir);
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(dir, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(dir, ...path.split("/")), text);
    }
    return dir;
  };
  const manifest = (files) => ({ product: "urx-cli", format: 1, files: Object.entries(files).map(([path, text]) => ({ path, sha256: hash(text), size: text.length })) });

  it("is exactly what its manifest lists, each file as built", () => {
    const files = { "bin/urx.exe": "launcher", "app/main.js": "cli" };
    expect(bundleProblems(bundle({ ...files, "release-manifest.json": "{}" }), manifest(files))).toEqual([]);
  });

  it("is refused with a changed or missing file, or one the manifest does not list", () => {
    const dir = bundle({ "bin/urx.exe": "changed", "notes.txt": "mine", "release-manifest.json": "{}" });
    expect(bundleProblems(dir, manifest({ "bin/urx.exe": "launcher", "app/main.js": "cli" }))).toEqual([
      "bin/urx.exe is not as it was built",
      "app/main.js is missing",
      "notes.txt is not one of its files",
    ]);
    expect(bundleProblems(dir, { product: "other", format: 1, files: [] })).toEqual(["the bundle has no urx-cli format 1 manifest"]);
  });
});

describe("the Windows bundle and its compiler", () => {
  const inputs = { node: { archives: { "win-x64": { file: "node-v26.13.0-win-x64.zip", sha256: "a".repeat(64) } } } };
  const files = ["bin/urx.exe", "runtime/node.exe", "native/urx-native.node", "app/main.js"].map((path) => ({ path, sha256: "b".repeat(64), size: 1 }));
  const runtime = { archive: "node-v26.13.0-win-x64.zip", sha256: "a".repeat(64) };

  it("take a bundle built with the recorded Windows x64 Node archive and holding its required files", () => {
    expect(windowsBundleProblems({ runtime, files }, inputs)).toEqual([]);
  });

  it("refuse another platform's bundle and one without a required file", () => {
    const mac = { archive: "node-v26.13.0-darwin-arm64.tar.gz", sha256: "c".repeat(64) };
    expect(windowsBundleProblems({ runtime: mac, files: [] }, inputs)).toEqual([
      "the bundle's runtime is not node-v26.13.0-win-x64.zip, the Windows x64 Node archive build-inputs.json records",
      "the bundle lists no bin/urx.exe",
      "the bundle lists no runtime/node.exe",
      "the bundle lists no native/urx-native.node",
      "the bundle lists no app/main.js",
    ]);
  });

  it("encode the recorded Inno Setup version as ISPP's Ver without its build number", () => {
    expect(innoVersionNumber("7.1.1")).toBe(String(0x070101));
    expect(innoVersionNumber("6.7.4")).toBe(String(0x060704));
    for (const version of ["7.1", "7.1.1.0", "", undefined, "7.256.0"]) expect(() => innoVersionNumber(version), String(version)).toThrow();
  });
});
