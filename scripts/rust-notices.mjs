// The notices of the third-party Rust crates built into a release's programs
// (K38): the launcher, the addon and, on macOS, the maintenance tools. The
// crates are those `cargo tree` gives for each of those packages as it is
// built, for the platform the release is built on, with only the
// dependencies that go into the program: not procedural macros, which run
// only while it is compiled, nor build scripts' or tests' dependencies, nor
// what only they use, and with the features that build enables, not those
// another package of the workspace enables. Each is matched to its package
// by its name, version and where Cargo took it from, and every crate that is
// not one of this repository's or urx-device's own manifests (OWN_MANIFESTS,
// whose licenses the bundle carries already) counts, wherever it lies. For
// each, the notices name the crate, its version, license expression and
// repository, and hold the text of the license file its manifest names
// (`license-file`) and of every license file at the top of its package, read
// through a link, a folder by its files. A crate whose package holds none
// takes the text this repository records for exactly that version, license
// and repository (RECORDED_TEXTS); a crate with neither, a recorded text for
// another version, license or repository, and a recorded text no crate
// takes each stop the build.

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

/** The packages whose programs a release holds, by platform. */
export function programPackages(platform = process.platform) {
  return ["urx-launcher", "urx-cli-native", ...(platform === "darwin" ? ["urx-maintenance"] : [])];
}

/**
 * The license texts this repository records for crates whose packages hold
 * none, by crate name: the version, license expression and repository they
 * were checked for, the path of the text in the repository, and where it was
 * taken from.
 */
export const RECORDED_TEXTS = {
  // The LICENSE of https://github.com/napi-rs/napi-rs (blob 7fe7e35, last changed in ab2a003),
  // the repository both crates name; their packages hold no license file.
  napi: { version: "3.16.2", license: "MIT", repository: "https://github.com/napi-rs/napi-rs", path: "notices/napi-rs.txt", from: "the LICENSE of https://github.com/napi-rs/napi-rs" },
  "napi-sys": { version: "3.4.1", license: "MIT", repository: "https://github.com/napi-rs/napi-rs", path: "notices/napi-rs.txt", from: "the LICENSE of https://github.com/napi-rs/napi-rs" },
};

/** Whether `name` is a license file's: LICENSE, LICENCE, COPYING, NOTICE or UNLICENSE, with any suffix. */
export function isLicenseFile(name) {
  return /^(licen[cs]e|copying|notice|unlicense)/i.test(name);
}

/**
 * This repository's and urx-device's own packages, by the path of their
 * manifest in the export: their licenses are the bundle's urx-cli and
 * urx-device notices. Any other package is a third party's, wherever Cargo
 * takes it from.
 */
export const OWN_MANIFESTS = ["launcher/Cargo.toml", "maintenance/Cargo.toml", "native/Cargo.toml", "tools/output/Cargo.toml", "vendor/urx-device/crates/transport/Cargo.toml"];

/**
 * Whether a package of `cargo metadata` is one of OWN_MANIFESTS in the
 * export at `source`: taken from a folder, and that manifest.
 */
export function ownOf(source) {
  const own = new Set(OWN_MANIFESTS.map((path) => realpathSync(join(source, ...path.split("/")))));
  return (item) => item.source === null && own.has(realpathSync(item.manifest_path));
}

/**
 * The packages `cargo tree --prefix none --format "{p}"` printed, each once:
 * its name, version and where Cargo took it from (`path` for a folder, `git`
 * for a repository, neither for a registry).
 */
export function treePackages(output) {
  const found = new Map();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^(\S+) v(\S+)((?: \([^)]*\))*)$/.exec(line.trimEnd());
    if (match === null) throw new Error(`cargo tree printed a line that names no package: ${JSON.stringify(line)}`);
    const notes = [...match[3].matchAll(/ \(([^)]*)\)/g)].map((note) => note[1]).filter((note) => note !== "*");
    if (notes.length > 1) throw new Error(`cargo tree printed a package from more than one place: ${JSON.stringify(line)}`);
    const [note] = notes;
    const origin = note === undefined ? {} : /^(https?|ssh|git):/.test(note) ? { git: note } : { path: note };
    if (note !== undefined && note.startsWith("registry ")) throw new Error(`cargo tree printed a package of another registry: ${JSON.stringify(line)}`);
    found.set(`${match[1]}@${match[2]}@${JSON.stringify(origin)}`, { name: match[1], version: match[2], ...origin });
  }
  return [...found.values()];
}

/**
 * The packages of `metadata` (`cargo metadata --format-version 1`) that
 * `linked` (`treePackages`) names, each matched by its name, version and
 * where it was taken from, without those `isOwn` takes for this
 * repository's or urx-device's own, sorted by name, version and source.
 * `samePath` tells whether two folders are one.
 */
export function programCrates(metadata, linked, isOwn, samePath = (a, b) => a === b) {
  const crates = new Map();
  for (const entry of linked) {
    const matches = metadata.packages.filter((item) => {
      if (item.name !== entry.name || item.version !== entry.version) return false;
      if (entry.path !== undefined) return item.source === null && samePath(dirname(item.manifest_path), entry.path);
      if (entry.git !== undefined) return typeof item.source === "string" && item.source.startsWith("git+") && item.source.slice(4).split("#")[0] === entry.git.split("#")[0];
      return typeof item.source === "string" && /^(registry|sparse)\+/.test(item.source);
    });
    const where = entry.path ?? entry.git ?? "the registry";
    if (matches.length !== 1) throw new Error(`cargo metadata has ${matches.length} packages ${entry.name} ${entry.version} from ${where}, which cargo tree names, not one`);
    const [item] = matches;
    if (!isOwn(item)) crates.set(item.id, item);
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...crates.values()].sort((a, b) => order(a.name, b.name) || order(a.version, b.version) || order(String(a.source), String(b.source)));
}

/**
 * The license texts of the package `item` as [name, text], sorted by name
 * (code unit order, whatever the locale): every license file at the top of
 * its package folder and the file its manifest names (`license_file`), each
 * read through a link to where it is, a folder by the files in it, and each
 * file once. One that leads to no file stops the build with its path.
 */
export function licenseTexts(item) {
  const directory = dirname(item.manifest_path);
  const texts = new Map();
  const visited = new Set();
  const add = (name, path) => {
    let real;
    try {
      real = realpathSync(path);
    } catch {
      throw new Error(`the Rust crate ${item.name} ${item.version} has ${name}, which leads to no file`);
    }
    const stat = statSync(real);
    if (stat.isDirectory()) {
      if (visited.has(real)) return;
      visited.add(real);
      for (const entry of readdirSync(real).sort()) add(`${name}/${entry}`, join(real, entry));
    } else if (stat.isFile()) {
      if (!texts.has(real)) texts.set(real, [name, readFileSync(real, "utf8")]);
    } else {
      throw new Error(`the Rust crate ${item.name} ${item.version} has ${name}, which is not a file`);
    }
  };
  for (const name of readdirSync(directory).sort()) if (isLicenseFile(name)) add(name, join(directory, name));
  if (item.license_file) {
    const path = isAbsolute(item.license_file) ? item.license_file : join(directory, item.license_file);
    if (!existsSync(path)) throw new Error(`the Rust crate ${item.name} ${item.version} names ${item.license_file} as its license file, which its package does not hold`);
    add(relative(directory, path).split(sep).join("/"), path);
  }
  return [...texts.values()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const RULE = "=".repeat(78);

/**
 * The notices of `crates` (`programCrates`): each crate's name, version,
 * license expression and repository, then each of its license texts, its
 * package's own (`filesOf`) or the one `recorded` holds for exactly that
 * version, license and repository (`readRecorded`, by repository path).
 */
export function crateNotices(crates, { filesOf, readRecorded, recorded = RECORDED_TEXTS }) {
  const used = new Set();
  const blocks = crates.map((item) => {
    let texts = filesOf(item);
    const text = recorded[item.name];
    if (texts.length === 0) {
      if (text === undefined) throw new Error(`the Rust crate ${item.name} ${item.version} holds no license file, and none is recorded for it`);
      if (text.version !== item.version || text.license !== item.license || text.repository !== item.repository) {
        throw new Error(
          `the license text recorded for ${item.name} is for ${text.version} (${text.license}, ${text.repository}), not ${item.version} (${item.license}, ${item.repository}); check the crate's license and record its text again`,
        );
      }
      used.add(item.name);
      texts = [[`${text.path} (${text.from})`, readRecorded(text.path)]];
    }
    const header = [`${item.name} ${item.version}`, `License: ${item.license ?? "(none stated)"}`, ...(item.repository ? [`Repository: ${item.repository}`] : [])];
    return [RULE, ...header, ...texts.flatMap(([name, body]) => ["", `--- ${name} ---`, body.trimEnd()])].join("\n");
  });
  const unused = Object.keys(recorded).filter((name) => !used.has(name));
  if (unused.length > 0) throw new Error(`a license text is recorded for ${unused.join(", ")}, which the release's programs do not take`);
  return `The third-party Rust crates built into this release's programs, with their licenses.\n\n${blocks.join("\n\n")}\n`;
}

/**
 * The notices of the Rust crates in the programs of the export at `source`
 * (its Cargo.lock, for the platform this runs on), its recorded texts read
 * from it. `environment` is the cargo builds' environment.
 */
export function rustNotices(source, environment, platform = process.platform) {
  const run = (command, args) =>
    execFileSync(command, args, { cwd: source, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "inherit"], env: environment });
  const host = /^host: (\S+)$/m.exec(run("rustc", ["-vV"]))?.[1];
  if (host === undefined) throw new Error("rustc names no host platform");
  const linked = programPackages(platform).flatMap((program) =>
    treePackages(run("cargo", ["tree", "--locked", "--target", host, "-p", program, "-e", "normal,no-proc-macro", "--prefix", "none", "--format", "{p}"])),
  );
  const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", host]));
  const isOwn = ownOf(source);
  const samePath = (a, b) => realpathSync(a) === realpathSync(b);
  return crateNotices(programCrates(metadata, linked, isOwn, samePath), {
    filesOf: licenseTexts,
    readRecorded: (path) => readFileSync(join(source, ...path.split("/")), "utf8"),
  });
}
