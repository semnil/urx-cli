import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { crateNotices, isLicenseFile, licenseTexts, OWN_MANIFESTS, ownOf, programCrates, programPackages, RECORDED_TEXTS, treePackages } from "./rust-notices.mjs";

const made = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

function folder() {
  const directory = mkdtempSync(join(tmpdir(), "urx-rust-notices-"));
  made.push(directory);
  return directory;
}

/** A package of `cargo metadata`: registry-sourced unless `source` says otherwise. */
const pkg = (name, { version = "1.0.0", source = "registry+https://github.com/rust-lang/crates.io-index", license = "MIT", repository = `https://example.com/${name}`, manifest = `/registry/${name}/Cargo.toml`, licenseFile = null } = {}) => ({
  id: `${name} ${version} (${source})`,
  name,
  version,
  source,
  license,
  license_file: licenseFile,
  repository,
  manifest_path: manifest,
});

describe("the notices of the Rust crates in a release's programs (K38)", () => {
  it("are of the launcher and the addon, and on macOS the maintenance tools", () => {
    expect(programPackages("darwin")).toEqual(["urx-launcher", "urx-cli-native", "urx-maintenance"]);
    expect(programPackages("win32")).toEqual(["urx-launcher", "urx-cli-native"]);
  });

  it("read the packages cargo tree names, with where each was taken from", () => {
    const output = [
      "urx-launcher v0.0.0 (/repo/launcher)",
      "libc v0.2.191",
      "itoa v1.0.19",
      "futures-util v0.3.34 (*)",
      "futures-util v0.3.34",
      "",
      "transport v0.2.0 (/repo/vendor/urx-device/crates/transport) (*)",
      "fork v1.0.0 (https://github.com/someone/fork?branch=main#0123abc)",
    ].join("\n");
    expect(treePackages(output)).toEqual([
      { name: "urx-launcher", version: "0.0.0", path: "/repo/launcher" },
      { name: "libc", version: "0.2.191" },
      { name: "itoa", version: "1.0.19" },
      { name: "futures-util", version: "0.3.34" },
      { name: "transport", version: "0.2.0", path: "/repo/vendor/urx-device/crates/transport" },
      { name: "fork", version: "1.0.0", git: "https://github.com/someone/fork?branch=main#0123abc" },
    ]);
    expect(() => treePackages("[build-dependencies]\nlibc v0.2.191")).toThrow("cargo tree printed a line that names no package");
    expect(() => treePackages("libc v0.2.191 (registry `other`)")).toThrow("cargo tree printed a package of another registry");
  });

  it("count each crate the programs link by where it was taken from, and all but this repository's and urx-device's own manifests", () => {
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    const metadata = {
      packages: [
        pkg("urx-launcher", { source: null, manifest: "/repo/launcher/Cargo.toml" }),
        pkg("transport", { source: null, manifest: "/repo/vendor/urx-device/crates/transport/Cargo.toml" }),
        pkg("libc", { source: registry }),
        // The same name and version from a folder, used only by a test: not the program's.
        pkg("libc", { source: null, manifest: "/elsewhere/libc/Cargo.toml" }),
        pkg("itoa", { source: null, manifest: "/patched/itoa/Cargo.toml" }),
        pkg("copied", { source: null, manifest: "/repo/vendor/urx-device/third/copied/Cargo.toml" }),
        pkg("fork", { source: "git+https://github.com/someone/fork?branch=main#0123abcdef" }),
      ],
    };
    const own = new Set(["/repo/launcher/Cargo.toml", "/repo/vendor/urx-device/crates/transport/Cargo.toml"]);
    const isOwn = (item) => item.source === null && own.has(item.manifest_path);
    const linked = [
      { name: "urx-launcher", version: "1.0.0", path: "/repo/launcher" },
      { name: "transport", version: "1.0.0", path: "/repo/vendor/urx-device/crates/transport" },
      { name: "libc", version: "1.0.0" },
      { name: "itoa", version: "1.0.0", path: "/patched/itoa" },
      { name: "copied", version: "1.0.0", path: "/repo/vendor/urx-device/third/copied" },
      { name: "fork", version: "1.0.0", git: "https://github.com/someone/fork?branch=main#0123abc" },
    ];
    const crates = programCrates(metadata, linked, isOwn);
    expect(crates.map((item) => `${item.name} ${item.source ?? item.manifest_path}`)).toEqual([
      "copied /repo/vendor/urx-device/third/copied/Cargo.toml",
      `fork git+https://github.com/someone/fork?branch=main#0123abcdef`,
      "itoa /patched/itoa/Cargo.toml",
      `libc ${registry}`,
    ]);
    // Both copies, when the programs link both.
    expect(programCrates(metadata, [...linked, { name: "libc", version: "1.0.0", path: "/elsewhere/libc" }], isOwn).filter((item) => item.name === "libc")).toHaveLength(2);
    expect(() => programCrates(metadata, [{ name: "gone", version: "1.0.0" }], isOwn)).toThrow("cargo metadata has 0 packages gone 1.0.0 from the registry, which cargo tree names, not one");
    expect(() => programCrates(metadata, [{ name: "libc", version: "1.0.0", path: "/nowhere/libc" }], isOwn)).toThrow("cargo metadata has 0 packages libc 1.0.0 from /nowhere/libc");
  });

  it("name as this repository's and urx-device's own only manifests that are there", () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    for (const path of OWN_MANIFESTS) expect(existsSync(join(root, path)), path).toBe(true);
  });

  it("take for this repository's and urx-device's own only the packages of those manifests", () => {
    const root = folder();
    for (const path of [...OWN_MANIFESTS, "vendor/urx-device/third/copied/Cargo.toml"]) {
      mkdirSync(join(root, path, ".."), { recursive: true });
      writeFileSync(join(root, path), "");
    }
    const isOwn = ownOf(root);
    const at = (path, source = null) => pkg("crate", { source, manifest: join(root, path) });
    for (const path of OWN_MANIFESTS) expect(isOwn(at(path)), path).toBe(true);
    expect(isOwn(at("vendor/urx-device/third/copied/Cargo.toml"))).toBe(false);
    expect(isOwn(at("launcher/Cargo.toml", "registry+https://github.com/rust-lang/crates.io-index"))).toBe(false);
  });

  it("take the license files at the top of the package and the one the manifest names, through links and folders, each once", () => {
    for (const name of ["LICENSE", "LICENSE-MIT", "license-apache", "LICENCE.txt", "COPYING", "NOTICE", "UNLICENSE", "LICENSES"]) expect(isLicenseFile(name), name).toBe(true);
    for (const name of ["README.md", "Cargo.toml", "src"]) expect(isLicenseFile(name), name).toBe(false);
    const directory = folder();
    writeFileSync(join(directory, "Cargo.toml"), "");
    writeFileSync(join(directory, "LICENSE-MIT"), "mit text\n");
    writeFileSync(join(directory, "NOTICE"), "notice text\n");
    writeFileSync(join(directory, "README.md"), "readme\n");
    mkdirSync(join(directory, "legal"));
    writeFileSync(join(directory, "legal", "terms.txt"), "terms text\n");
    const item = (licenseFile) => pkg("crate", { manifest: join(directory, "Cargo.toml"), licenseFile });
    expect(licenseTexts(item(null))).toEqual([
      ["LICENSE-MIT", "mit text\n"],
      ["NOTICE", "notice text\n"],
    ]);
    expect(licenseTexts(item("legal/terms.txt"))).toEqual([
      ["LICENSE-MIT", "mit text\n"],
      ["NOTICE", "notice text\n"],
      ["legal/terms.txt", "terms text\n"],
    ]);
    expect(licenseTexts(item("LICENSE-MIT"))).toEqual([
      ["LICENSE-MIT", "mit text\n"],
      ["NOTICE", "notice text\n"],
    ]);
    expect(licenseTexts(item(join(directory, "legal", "terms.txt"))).map(([name]) => name)).toEqual(["LICENSE-MIT", "NOTICE", "legal/terms.txt"]);
    expect(() => licenseTexts(item("legal/missing.txt"))).toThrow("names legal/missing.txt as its license file, which its package does not hold");
  });

  it.skipIf(process.platform === "win32")("read a license file through a link as the file itself, and stop at one that leads nowhere", () => {
    const linked = folder();
    writeFileSync(join(linked, "Cargo.toml"), "");
    mkdirSync(join(linked, "legal"));
    writeFileSync(join(linked, "legal", "body.txt"), "mit text\n");
    symlinkSync(join("legal", "body.txt"), join(linked, "LICENSE"));
    writeFileSync(join(linked, "NOTICE"), "notice text\n");
    const plain = folder();
    writeFileSync(join(plain, "Cargo.toml"), "");
    writeFileSync(join(plain, "LICENSE"), "mit text\n");
    writeFileSync(join(plain, "NOTICE"), "notice text\n");
    const item = (directory, licenseFile = null) => pkg("crate", { manifest: join(directory, "Cargo.toml"), licenseFile });
    expect(licenseTexts(item(linked))).toEqual(licenseTexts(item(plain)));
    expect(licenseTexts(item(linked, "LICENSE"))).toEqual(licenseTexts(item(plain, "LICENSE")));
    // Named both ways, it is one file.
    expect(licenseTexts(item(linked, "legal/body.txt"))).toEqual(licenseTexts(item(plain)));
    symlinkSync(join("legal", "gone.txt"), join(linked, "LICENSE-APACHE"));
    expect(() => licenseTexts(item(linked))).toThrow("has LICENSE-APACHE, which leads to no file");
  });

  it.skipIf(process.platform === "win32")("read nothing outside the package a license file leads out of", () => {
    const outside = folder();
    writeFileSync(join(outside, "LICENSE"), "someone else's\n");
    mkdirSync(join(outside, "LICENSES"));
    writeFileSync(join(outside, "LICENSES", "MIT.txt"), "someone else's\n");
    const make = (setUp) => {
      const directory = folder();
      writeFileSync(join(directory, "Cargo.toml"), "");
      writeFileSync(join(directory, "NOTICE"), "notice text\n");
      setUp(directory);
      return directory;
    };
    const item = (directory, licenseFile = null) => pkg("crate", { manifest: join(directory, "Cargo.toml"), licenseFile });
    const fileLink = make((directory) => symlinkSync(join(outside, "LICENSE"), join(directory, "LICENSE")));
    expect(() => licenseTexts(item(fileLink))).toThrow("has LICENSE, which leads outside its package");
    const folderLink = make((directory) => symlinkSync(join(outside, "LICENSES"), join(directory, "LICENSES")));
    expect(() => licenseTexts(item(folderLink))).toThrow("has LICENSES, which leads outside its package");
    const named = make(() => {});
    expect(() => licenseTexts(item(named, join(outside, "LICENSE")))).toThrow("which leads outside its package");
    expect(() => licenseTexts(item(named, "../outside/LICENSE"))).toThrow();
    const inFolder = make((directory) => {
      mkdirSync(join(directory, "LICENSES"));
      writeFileSync(join(directory, "LICENSES", "own.txt"), "own\n");
      symlinkSync(join(outside, "LICENSE"), join(directory, "LICENSES", "theirs.txt"));
    });
    expect(() => licenseTexts(item(inFolder))).toThrow("has LICENSES/theirs.txt, which leads outside its package");
    // A text the package shares within itself is taken.
    const shared = make((directory) => {
      mkdirSync(join(directory, "legal"));
      writeFileSync(join(directory, "legal", "MIT.txt"), "mit\n");
      symlinkSync(join("legal", "MIT.txt"), join(directory, "LICENSE-MIT"));
      symlinkSync("legal", join(directory, "LICENSES"));
    });
    expect(licenseTexts(item(shared))).toEqual([
      ["LICENSE-MIT", "mit\n"],
      ["NOTICE", "notice text\n"],
    ]);
  });

  it.skipIf(process.platform === "win32")("stop at a license file or folder that holds no text, a NOTICE beside it or not", () => {
    const cases = {
      "an empty file": (directory) => writeFileSync(join(directory, "LICENSE"), ""),
      "a file of whitespace": (directory) => writeFileSync(join(directory, "LICENSE"), " \n\t\n"),
      "an empty folder": (directory) => mkdirSync(join(directory, "LICENSES")),
      "a folder of empty folders": (directory) => mkdirSync(join(directory, "LICENSES", "inner"), { recursive: true }),
      "a link to an empty folder": (directory) => {
        mkdirSync(join(directory, "empty"));
        symlinkSync("empty", join(directory, "LICENSES"));
      },
      "a folder holding only a link to itself": (directory) => {
        mkdirSync(join(directory, "LICENSES"));
        symlinkSync(".", join(directory, "LICENSES", "again"));
      },
    };
    for (const [what, setUp] of Object.entries(cases)) {
      for (const licenseFile of [null, "LICENSES"]) {
        const directory = folder();
        writeFileSync(join(directory, "Cargo.toml"), "");
        writeFileSync(join(directory, "NOTICE"), "notice text\n");
        setUp(directory);
        const named = licenseFile !== null && existsSync(join(directory, licenseFile)) ? licenseFile : null;
        expect(() => licenseTexts(pkg("crate", { manifest: join(directory, "Cargo.toml"), licenseFile: named })), `${what} ${named}`).toThrow("which holds no license text");
      }
    }
  });

  it("read a license folder by the files in it", () => {
    const directory = folder();
    writeFileSync(join(directory, "Cargo.toml"), "");
    mkdirSync(join(directory, "LICENSES"));
    writeFileSync(join(directory, "LICENSES", "MIT.txt"), "mit\n");
    writeFileSync(join(directory, "LICENSES", "Apache-2.0.txt"), "apache\n");
    expect(licenseTexts(pkg("crate", { manifest: join(directory, "Cargo.toml") }))).toEqual([
      ["LICENSES/Apache-2.0.txt", "apache\n"],
      ["LICENSES/MIT.txt", "mit\n"],
    ]);
  });

  it("name each crate with its license and hold its texts, its own or the one recorded for exactly it", () => {
    const crates = [pkg("alpha", { license: "MIT OR Apache-2.0" }), pkg("beta", { repository: null }), pkg("napi", { version: "3.16.2" })];
    const texts = { alpha: [["LICENSE-APACHE", "apache\n"], ["LICENSE-MIT", "mit\n"]], beta: [["LICENSE", "beta license\n"]], napi: [] };
    const recorded = { napi: { version: "3.16.2", license: "MIT", repository: "https://example.com/napi", path: "notices/napi-rs.txt", from: "the LICENSE of napi-rs" } };
    const notices = crateNotices(crates, { filesOf: (item) => texts[item.name], readRecorded: (path) => `recorded ${path}\n`, recorded });
    const rule = "=".repeat(78);
    expect(notices).toBe(
      [
        "The third-party Rust crates built into this release's programs, with their licenses.",
        "",
        rule,
        "alpha 1.0.0",
        "License: MIT OR Apache-2.0",
        "Repository: https://example.com/alpha",
        "",
        "--- LICENSE-APACHE ---",
        "apache",
        "",
        "--- LICENSE-MIT ---",
        "mit",
        "",
        rule,
        "beta 1.0.0",
        "License: MIT",
        "",
        "--- LICENSE ---",
        "beta license",
        "",
        rule,
        "napi 3.16.2",
        "License: MIT",
        "Repository: https://example.com/napi",
        "",
        "--- notices/napi-rs.txt (the LICENSE of napi-rs) ---",
        "recorded notices/napi-rs.txt",
        "",
      ].join("\n"),
    );
  });

  it("stop at a crate with no license text, at a recorded text for another version, license or repository, and at a recorded text no crate takes", () => {
    const options = { filesOf: () => [], readRecorded: () => "text", recorded: {} };
    expect(() => crateNotices([pkg("gamma")], options)).toThrow("the Rust crate gamma 1.0.0 holds no license file, and none is recorded for it");
    const recorded = { napi: { version: "3.16.2", license: "MIT", repository: "https://example.com/napi", path: "notices/napi-rs.txt", from: "napi-rs" } };
    for (const changed of [{ version: "3.17.0" }, { license: "Apache-2.0" }, { repository: "https://example.com/other" }]) {
      expect(() => crateNotices([pkg("napi", { version: "3.16.2", ...changed })], { ...options, recorded }), JSON.stringify(changed)).toThrow("the license text recorded for napi is for 3.16.2 (MIT, https://example.com/napi), not");
    }
    expect(() => crateNotices([], { ...options, recorded })).toThrow("a license text is recorded for napi, which the release's programs do not take");
    // A crate that holds its own license file no longer takes the recorded one.
    expect(() => crateNotices([pkg("napi", { version: "3.16.2" })], { ...options, filesOf: () => [["LICENSE", "own"]], recorded })).toThrow("a license text is recorded for napi");
  });

  it("record napi-rs's license for the two napi crates the addon links, as checked", () => {
    expect(RECORDED_TEXTS).toEqual({
      napi: { version: "3.16.2", license: "MIT", repository: "https://github.com/napi-rs/napi-rs", path: "notices/napi-rs.txt", from: "the LICENSE of https://github.com/napi-rs/napi-rs" },
      "napi-sys": { version: "3.4.1", license: "MIT", repository: "https://github.com/napi-rs/napi-rs", path: "notices/napi-rs.txt", from: "the LICENSE of https://github.com/napi-rs/napi-rs" },
    });
  });
});
