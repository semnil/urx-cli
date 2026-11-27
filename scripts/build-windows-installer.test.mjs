import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { bundleProblems, ownedFilesInclude } from "./build-windows-installer.mjs";
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
