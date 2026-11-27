import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crateNotices, isLicenseFile, licenseTexts, programCrates, programPackages, RECORDED_TEXTS, treePackages } from "./rust-notices.mjs";

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

  it("read the packages cargo tree names", () => {
    const output = ["urx-launcher v0.0.0 (/repo/launcher)", "libc v0.2.191", "itoa v1.0.19", "futures-util v0.3.34 (*)", "", "transport v0.2.0 (/repo/vendor/urx-device/crates/transport)"].join("\n");
    expect([...treePackages(output)]).toEqual(["urx-launcher@0.0.0", "libc@0.2.191", "itoa@1.0.19", "futures-util@0.3.34", "transport@0.2.0"]);
    expect(() => treePackages("[build-dependencies]\nlibc v0.2.191")).toThrow("cargo tree printed a line that names no package");
  });

  it("count every crate the programs link that is not this repository's or urx-device's own, wherever Cargo takes it from", () => {
    const metadata = {
      packages: [
        pkg("urx-launcher", { source: null }),
        pkg("transport", { source: null }),
        pkg("libc"),
        pkg("itoa", { source: null, manifest: "/patched/itoa/Cargo.toml" }),
        pkg("libc", { version: "0.1.0" }),
        pkg("unlinked"),
      ],
    };
    const own = new Set(["urx-launcher", "transport"]);
    const crates = programCrates(metadata, new Set(["urx-launcher@1.0.0", "transport@1.0.0", "libc@1.0.0", "itoa@1.0.0"]), (item) => own.has(item.name));
    expect(crates.map((item) => `${item.name} ${item.version}`)).toEqual(["itoa 1.0.0", "libc 1.0.0"]);
    expect(() => programCrates(metadata, new Set(["gone@1.0.0"]), () => false)).toThrow("cargo metadata has no package gone@1.0.0, which cargo tree names");
  });

  it("take the license file the manifest names and those at the top of the package, each once", () => {
    for (const name of ["LICENSE", "LICENSE-MIT", "license-apache", "LICENCE.txt", "COPYING", "NOTICE", "UNLICENSE"]) expect(isLicenseFile(name), name).toBe(true);
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
