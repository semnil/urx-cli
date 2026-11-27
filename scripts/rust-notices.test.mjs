import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { crateNotices, isLicenseFile, licenseTexts, OWN_MANIFESTS, ownOf, programCrates, programPackages, RECORDED_TEXTS, treeNames } from "./rust-notices.mjs";

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

  it("read only the names and versions cargo tree gives, whatever it says of where each came from", () => {
    const output = [
      "urx-launcher v0.0.0 (/tmp/release (local)/launcher)",
      "libc v0.2.191",
      "futures-util v0.3.34 (*)",
      "",
      "nohash-hasher v0.2.0 (registry `review`)",
      "fork v1.0.0 (file:///tmp/fork#0123abc)",
    ].join("\n");
    expect([...treeNames(output)]).toEqual(["urx-launcher@0.0.0", "libc@0.2.191", "futures-util@0.3.34", "nohash-hasher@0.2.0", "fork@1.0.0"]);
    expect(() => treeNames("[build-dependencies]\nlibc v0.2.191")).toThrow("cargo tree printed a line that names no package");
    expect(() => treeNames("\u001b[1mlibc\u001b[0m v0.2.191")).toThrow("cargo tree printed a line that names no package");
  });

  it("count by package ID the crates each program's graph reaches and cargo tree gives, all but this repository's and urx-device's own", () => {
    const registry = "registry+https://github.com/rust-lang/crates.io-index";
    const review = "sparse+https://review.example/index/";
    const node = (item, deps = []) => ({ id: item.id, deps: deps.map(([to, kind = null]) => ({ pkg: to.id, dep_kinds: [{ kind, target: null }] })) });
    const launcher = pkg("urx-launcher", { source: null, manifest: "/repo/launcher/Cargo.toml" });
    const native = pkg("urx-cli-native", { source: null, manifest: "/repo/native/Cargo.toml" });
    const output = pkg("urx-output", { source: null, manifest: "/repo/tools/output/Cargo.toml" });
    const transport = pkg("transport", { source: null, manifest: "/repo/vendor/urx-device/crates/transport/Cargo.toml" });
    const libc = pkg("libc", { source: registry });
    const libcTestOnly = pkg("libc", { source: review });
    const itoa = pkg("itoa", { source: null, manifest: "/patched/itoa/Cargo.toml" });
    const fork = pkg("fork", { source: "git+file:///tmp/fork#0123abc" });
    const ctor = pkg("ctor", { source: registry });
    const section = pkg("link-section", { source: registry });
    const derive = { ...pkg("derive", { source: registry }), targets: [{ kind: ["proc-macro"] }] };
    const macroOnly = pkg("macro-only", { source: registry });
    const shared = pkg("shared", { source: registry });
    const sharedReview = pkg("shared", { source: review });
    const all = [launcher, native, output, transport, libc, libcTestOnly, itoa, fork, ctor, section, derive, macroOnly, shared, sharedReview];
    for (const item of all) item.targets ??= [{ kind: ["lib"] }];
    const metadata = {
      packages: all,
      workspace_members: [launcher.id, native.id, output.id],
      resolve: {
        nodes: [
          node(launcher, [[libc], [libcTestOnly, "dev"], [itoa], [fork], [derive], [shared], [sharedReview]]),
          node(native, [[transport], [ctor], [libcTestOnly, "build"]]),
          node(output, [[macroOnly]]),
          node(transport, [[libc]]),
          // A feature only urx-output enables gives ctor this edge in the workspace's unified graph.
          node(ctor, [[section]]),
          node(derive, [[macroOnly]]),
          ...[libc, libcTestOnly, itoa, fork, section, macroOnly, shared, sharedReview].map((item) => node(item)),
        ],
      },
    };
    const own = new Set(["/repo/launcher/Cargo.toml", "/repo/native/Cargo.toml", "/repo/tools/output/Cargo.toml", "/repo/vendor/urx-device/crates/transport/Cargo.toml"]);
    const isOwn = (item) => item.source === null && own.has(item.manifest_path);
    const programs = [
      { name: "urx-launcher", linked: new Set(["urx-launcher@1.0.0", "libc@1.0.0", "itoa@1.0.0", "fork@1.0.0", "shared@1.0.0"]) },
      { name: "urx-cli-native", linked: new Set(["urx-cli-native@1.0.0", "transport@1.0.0", "libc@1.0.0", "ctor@1.0.0"]) },
    ];
    expect(programCrates(metadata, programs, isOwn).map((item) => `${item.name} ${item.source ?? item.manifest_path}`)).toEqual([
      `ctor ${registry}`,
      "fork git+file:///tmp/fork#0123abc",
      "itoa /patched/itoa/Cargo.toml",
      `libc ${registry}`,
      `shared ${registry}`,
      `shared ${review}`,
    ]);
    expect(() => programCrates(metadata, [{ name: "urx-launcher", linked: new Set(["gone@1.0.0"]) }], isOwn)).toThrow(
      "cargo tree gives gone@1.0.0 for urx-launcher, which its dependency graph in cargo metadata does not reach",
    );
    expect(() => programCrates(metadata, [{ name: "urx-maintenance", linked: new Set() }], isOwn)).toThrow("the workspace has no package urx-maintenance");
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
