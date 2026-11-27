import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { compiledPackages, crateNotices, isLicenseFile, licenseTexts, metadataArguments, OWN_MANIFESTS, ownOf, programCrates, programPackages, RECORDED_TEXTS, unitFolder } from "./rust-notices.mjs";

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

  it("take the packages of the units cargo compiled into the target's folder, not build scripts, macros or what only they use", () => {
    const target = join("/repo", "target");
    const unit = (id, kind, folder, extra = {}) =>
      JSON.stringify({ reason: "compiler-artifact", package_id: id, target: { kind: [kind], name: id }, filenames: [join(target, ...folder, `lib${id.length}.rlib`)], ...extra });
    const report = [
      "   Compiling libc v0.2.191",
      unit("registry+https://github.com/rust-lang/crates.io-index#libc@0.2.191", "lib", ["aarch64-apple-darwin", "release", "deps"]),
      unit("registry+https://github.com/rust-lang/crates.io-index#libc@0.2.191", "custom-build", ["release", "build", "libc-1"]),
      // The same name and version from another registry, built only for a build script, on the host.
      unit("sparse+https://review.example/index/#libc@0.2.191", "lib", ["release", "deps"]),
      unit("registry+https://github.com/rust-lang/crates.io-index#napi-derive@3.7.2", "proc-macro", ["release", "deps"]),
      unit("registry+https://github.com/rust-lang/crates.io-index#syn@3.0.10", "lib", ["release", "deps"]),
      unit("path+file:///repo/launcher#urx-launcher@0.0.0", "bin", ["aarch64-apple-darwin", "release"]),
      JSON.stringify({ reason: "build-script-executed", package_id: "registry+https://github.com/rust-lang/crates.io-index#libc@0.2.191" }),
      JSON.stringify({ reason: "build-finished", success: true }),
    ].join("\n");
    expect([...compiledPackages([report], target, "aarch64-apple-darwin")]).toEqual([
      "registry+https://github.com/rust-lang/crates.io-index#libc@0.2.191",
      "path+file:///repo/launcher#urx-launcher@0.0.0",
    ]);
    // Another platform's units are not this release's.
    expect([...compiledPackages([report], target, "x86_64-pc-windows-msvc")]).toEqual([]);
    expect(() => compiledPackages(["{not json"], target, "aarch64-apple-darwin")).toThrow("cargo's report holds a line that is not a message");
  });

  it("read cargo metadata for the platform the programs are built for only", () => {
    const args = metadataArguments("aarch64-apple-darwin");
    expect(args.slice(args.indexOf("--filter-platform"), args.indexOf("--filter-platform") + 2)).toEqual(["--filter-platform", "aarch64-apple-darwin"]);
    expect(args).toContain("--locked");
  });

  it("look for the units in the target directory, and stop when cargo builds apart from it", () => {
    expect(unitFolder({ target_directory: "/scratch/target", build_directory: "/scratch/target" })).toBe("/scratch/target");
    // A cargo older than its build directory builds in its target directory.
    expect(unitFolder({ target_directory: "/scratch/target" })).toBe("/scratch/target");
    expect(() => unitFolder({ target_directory: "/scratch/target", build_directory: "/scratch/build" })).toThrow(
      "cargo builds in /scratch/build, apart from its target directory /scratch/target; build the release with both the same (CARGO_BUILD_BUILD_DIR)",
    );
  });

  it("count every compiled package but this repository's and urx-device's own, and require a unit of each program", () => {
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    const metadata = {
      packages: [
        pkg("urx-launcher", { source: null, manifest: "/repo/launcher/Cargo.toml" }),
        pkg("urx-cli-native", { source: null, manifest: "/repo/native/Cargo.toml" }),
        pkg("transport", { source: null, manifest: "/repo/vendor/urx-device/crates/transport/Cargo.toml" }),
        pkg("libc", { source: registry }),
        pkg("libc", { source: "sparse+https://review.example/index/" }),
        pkg("itoa", { source: null, manifest: "/patched/itoa/Cargo.toml" }),
        pkg("fork", { source: "git+file:///tmp/fork#0123abc" }),
      ],
      workspace_members: [],
    };
    const id = (name, source = registry) => metadata.packages.find((item) => item.name === name && item.source === source).id;
    metadata.workspace_members = [id("urx-launcher", null), id("urx-cli-native", null)];
    const own = new Set(["/repo/launcher/Cargo.toml", "/repo/native/Cargo.toml", "/repo/vendor/urx-device/crates/transport/Cargo.toml"]);
    const isOwn = (item) => item.source === null && own.has(item.manifest_path);
    const ids = new Set([id("urx-launcher", null), id("urx-cli-native", null), id("transport", null), id("libc"), id("libc", "sparse+https://review.example/index/"), id("itoa", null), id("fork", "git+file:///tmp/fork#0123abc")]);
    expect(programCrates(metadata, ids, isOwn, ["urx-launcher", "urx-cli-native"]).map((item) => `${item.name} ${item.source ?? item.manifest_path}`)).toEqual([
      "fork git+file:///tmp/fork#0123abc",
      "itoa /patched/itoa/Cargo.toml",
      `libc ${registry}`,
      "libc sparse+https://review.example/index/",
    ]);
    expect(() => programCrates(metadata, new Set([id("urx-launcher", null)]), isOwn, ["urx-launcher", "urx-cli-native"])).toThrow(
      "cargo's report holds no unit of urx-cli-native: it does not cover that program",
    );
    expect(() => programCrates(metadata, new Set([id("urx-launcher", null), "registry+x#gone@1.0.0"]), isOwn, ["urx-launcher"])).toThrow(
      "cargo's report names the package registry+x#gone@1.0.0, which cargo metadata does not have",
    );
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
    expect(() => licenseTexts(item(fileLink))).toThrow("has LICENSE, which leads outside what Cargo took of it");
    const folderLink = make((directory) => symlinkSync(join(outside, "LICENSES"), join(directory, "LICENSES")));
    expect(() => licenseTexts(item(folderLink))).toThrow("has LICENSES, which leads outside what Cargo took of it");
    const named = make(() => {});
    expect(() => licenseTexts(item(named, join(outside, "LICENSE")))).toThrow("which leads outside what Cargo took of it");
    expect(() => licenseTexts(item(named, "../outside/LICENSE"))).toThrow();
    const inFolder = make((directory) => {
      mkdirSync(join(directory, "LICENSES"));
      writeFileSync(join(directory, "LICENSES", "own.txt"), "own\n");
      symlinkSync(join(outside, "LICENSE"), join(directory, "LICENSES", "theirs.txt"));
    });
    expect(() => licenseTexts(item(inFolder))).toThrow("has LICENSES/theirs.txt, which leads outside what Cargo took of it");
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

  it("read a license text a crate from a folder or a repository shares within it, and none from outside", () => {
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    for (const [marker, source] of [[".git", null], [".cargo-ok", "git+https://example.com/shared#0123abc"]]) {
      const repository = folder();
      mkdirSync(join(repository, marker === ".git" ? ".git" : "crates"), { recursive: true });
      if (marker === ".cargo-ok") writeFileSync(join(repository, ".cargo-ok"), "");
      writeFileSync(join(repository, "LICENSE"), "shared license\n");
      const crate = join(repository, "crates", "member");
      mkdirSync(crate, { recursive: true });
      writeFileSync(join(crate, "Cargo.toml"), "");
      const item = (licenseFile, from = source) => pkg("member", { source: from, manifest: join(crate, "Cargo.toml"), licenseFile });
      expect(licenseTexts(item("../../LICENSE")), marker).toEqual([["../../LICENSE", "shared license\n"]]);
      // A registry crate is what Cargo extracted: its own folder.
      expect(() => licenseTexts(item("../../LICENSE", registry)), marker).toThrow("which leads outside what Cargo took of it");
      // Nothing above the repository.
      const outside = folder();
      writeFileSync(join(outside, "LICENSE"), "someone else's\n");
      expect(() => licenseTexts(item(join(outside, "LICENSE"))), marker).toThrow("which leads outside what Cargo took of it");
    }
    // A crate from a folder in no repository: its own folder.
    const lone = folder();
    mkdirSync(join(lone, "member"));
    writeFileSync(join(lone, "member", "Cargo.toml"), "");
    writeFileSync(join(lone, "LICENSE"), "beside it\n");
    expect(() => licenseTexts(pkg("member", { source: null, manifest: join(lone, "member", "Cargo.toml"), licenseFile: "../LICENSE" }))).toThrow("which leads outside what Cargo took of it");
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
    // No text of the list may be only whitespace, whichever way it came.
    expect(() => crateNotices([pkg("napi", { version: "3.16.2" })], { ...options, readRecorded: () => " \n", recorded })).toThrow(
      "the Rust crate napi 3.16.2 has notices/napi-rs.txt (napi-rs), which holds no license text",
    );
    expect(() => crateNotices([pkg("gamma")], { ...options, filesOf: () => [["LICENSES/Apache-2.0.txt", "apache\n"], ["LICENSES/MIT.txt", "\t\n"]] })).toThrow(
      "the Rust crate gamma 1.0.0 has LICENSES/MIT.txt, which holds no license text",
    );
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
