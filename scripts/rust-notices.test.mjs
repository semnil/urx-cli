import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { crateNotices, isLicenseFile, licenseFiles, programCrates, programPackages, RECORDED_TEXTS } from "./rust-notices.mjs";

const made = [];
afterEach(() => {
  for (const path of made.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** A package of `cargo metadata`: registry-sourced unless `path`, a library unless `macro`. */
const pkg = (name, { path = false, macro = false, license = "MIT", repository = `https://example.com/${name}` } = {}) => ({
  id: `${name}-id`,
  name,
  version: "1.0.0",
  source: path ? null : "registry+https://github.com/rust-lang/crates.io-index",
  license,
  repository,
  manifest_path: `/registry/${name}/Cargo.toml`,
  targets: [{ kind: [macro ? "proc-macro" : "lib"] }],
});

/** A dependency edge of the kinds `kinds` (null is a normal dependency). */
const dep = (name, ...kinds) => ({ pkg: `${name}-id`, dep_kinds: (kinds.length > 0 ? kinds : [null]).map((kind) => ({ kind, target: null })) });

function metadata() {
  const packages = [
    pkg("urx-launcher", { path: true }),
    pkg("urx-cli-native", { path: true }),
    pkg("urx-output", { path: true }),
    pkg("transport", { path: true }),
    pkg("linked"),
    pkg("shared"),
    pkg("derive", { macro: true }),
    pkg("macro-only"),
    pkg("build-only"),
    pkg("dev-only"),
    pkg("tool-only"),
    pkg("through-path"),
  ];
  const nodes = [
    { id: "urx-launcher-id", deps: [dep("linked"), dep("derive"), dep("build-only", "build"), dep("dev-only", "dev")] },
    { id: "urx-cli-native-id", deps: [dep("shared"), dep("transport"), dep("linked", "dev", null)] },
    { id: "urx-output-id", deps: [dep("tool-only")] },
    { id: "transport-id", deps: [dep("through-path")] },
    { id: "linked-id", deps: [dep("shared")] },
    { id: "derive-id", deps: [dep("macro-only")] },
    ...["shared", "macro-only", "build-only", "dev-only", "tool-only", "through-path"].map((name) => ({ id: `${name}-id`, deps: [] })),
  ];
  return { packages, resolve: { nodes }, workspace_members: ["urx-launcher-id", "urx-cli-native-id", "urx-output-id"] };
}

describe("the notices of the Rust crates in a release's programs (K38)", () => {
  it("are of the launcher and the addon, and on macOS the maintenance tools", () => {
    expect(programPackages("darwin")).toEqual(["urx-launcher", "urx-cli-native", "urx-maintenance"]);
    expect(programPackages("win32")).toEqual(["urx-launcher", "urx-cli-native"]);
  });

  it("count the third-party crates the programs link, through path crates too, and nothing only a macro, a build script, a test or another program uses", () => {
    expect(programCrates(metadata(), ["urx-launcher", "urx-cli-native"]).map((item) => item.name)).toEqual(["linked", "shared", "through-path"]);
    expect(() => programCrates(metadata(), ["urx-launcher", "urx-maintenance"])).toThrow("the workspace has no package urx-maintenance");
  });

  it("take the license files at the top of a crate's package", () => {
    for (const name of ["LICENSE", "LICENSE-MIT", "license-apache", "LICENCE.txt", "COPYING", "NOTICE", "UNLICENSE"]) expect(isLicenseFile(name), name).toBe(true);
    for (const name of ["README.md", "Cargo.toml", "src"]) expect(isLicenseFile(name), name).toBe(false);
    const directory = mkdtempSync(join(tmpdir(), "urx-rust-notices-"));
    made.push(directory);
    writeFileSync(join(directory, "LICENSE-MIT"), "mit text\n");
    writeFileSync(join(directory, "LICENSE-APACHE"), "apache text\n");
    writeFileSync(join(directory, "README.md"), "readme\n");
    mkdirSync(join(directory, "license"));
    expect(licenseFiles(directory)).toEqual([
      ["LICENSE-APACHE", "apache text\n"],
      ["LICENSE-MIT", "mit text\n"],
    ]);
  });

  it("name each crate with its license and hold its texts, its own or the one recorded for it", () => {
    const crates = [pkg("alpha", { license: "MIT OR Apache-2.0" }), pkg("beta", { repository: null }), pkg("napi")];
    const texts = { alpha: [["LICENSE-APACHE", "apache\n"], ["LICENSE-MIT", "mit\n"]], beta: [["LICENSE", "beta license\n"]], napi: [] };
    const notices = crateNotices(crates, {
      filesOf: (item) => texts[item.name],
      readRecorded: (path) => `recorded ${path}\n`,
      recorded: { napi: { path: "notices/napi-rs.txt", from: "the LICENSE of napi-rs" } },
    });
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
        "napi 1.0.0",
        "License: MIT",
        "Repository: https://example.com/napi",
        "",
        "--- notices/napi-rs.txt (the LICENSE of napi-rs) ---",
        "recorded notices/napi-rs.txt",
        "",
      ].join("\n"),
    );
  });

  it("stop at a crate with no license text, and at a recorded text no crate takes", () => {
    const options = { filesOf: () => [], readRecorded: () => "text", recorded: {} };
    expect(() => crateNotices([pkg("gamma")], options)).toThrow("the Rust crate gamma 1.0.0 holds no license file, and none is recorded for it");
    const recorded = { napi: { path: "notices/napi-rs.txt", from: "napi-rs" } };
    expect(() => crateNotices([], { ...options, recorded })).toThrow("a license text is recorded for napi, which the release's programs do not hold");
    // A crate that holds its own license file no longer takes the recorded one.
    expect(() => crateNotices([pkg("napi")], { ...options, filesOf: () => [["LICENSE", "own"]], recorded })).toThrow("a license text is recorded for napi");
  });

  it("record napi-rs's license for the two napi crates the addon links", () => {
    expect(Object.keys(RECORDED_TEXTS).sort()).toEqual(["napi", "napi-sys"]);
    for (const text of Object.values(RECORDED_TEXTS)) expect(text.path).toBe("notices/napi-rs.txt");
  });
});
