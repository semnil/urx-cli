// The notices of the third-party Rust crates built into a release's programs
// (K38): the launcher, the addon and, on macOS, the maintenance tools. The
// crates are taken from the release build's own report: each of those
// programs is built for the platform the release is built on, named
// explicitly (`--target`), with `--message-format=json-render-diagnostics`,
// and every unit Cargo compiles into the target's folder (`<target
// directory>/<triple>/`) is part of a program. The release build gives Cargo
// one folder as both its target and its build directory, and a `cargo
// metadata` that names them apart stops the notices, so no unit lies
// elsewhere. Build scripts, procedural
// macros and what only they use are built for the host outside that folder,
// and features another package of the workspace enables are not built at
// all, so neither is counted. Each unit names its package by ID, which
// carries where Cargo took it from. Every package that is not one of this
// repository's or urx-device's own manifests (OWN_MANIFESTS, whose licenses
// the bundle carries already) counts, wherever it lies. For each, the
// notices name the crate, its version, license expression and repository,
// and hold the text of the license file its manifest names (`license-file`)
// and of every license file at the top of its package, read through a link,
// a folder by its files, only inside what Cargo took of it. A crate whose
// package holds none takes the text this repository records for exactly that
// version, license and repository (RECORDED_TEXTS); a crate with neither, a
// recorded text for another version, license or repository, a recorded text
// no crate takes, and any text that is only whitespace each stop the build.

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
 * The package IDs of the units that the reports `reports` (Cargo's JSON
 * messages, one a line, as `cargo build --message-format=json-render-diagnostics`
 * prints them) say were compiled into `<targetDirectory>/<triple>/`: what the
 * programs built for `triple` are made of. Build scripts and procedural
 * macros, and the units only they use, are compiled for the host outside that
 * folder and are not taken.
 */
export function compiledPackages(reports, targetDirectory, triple) {
  const into = `${join(targetDirectory, triple)}${sep}`;
  const ids = new Set();
  for (const report of reports) {
    for (const line of report.split(/\r?\n/)) {
      if (!line.startsWith("{")) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        throw new Error(`cargo's report holds a line that is not a message: ${JSON.stringify(line.slice(0, 80))}`);
      }
      if (message.reason !== "compiler-artifact") continue;
      const kinds = message.target?.kind ?? [];
      if (kinds.includes("custom-build") || kinds.includes("proc-macro")) continue;
      if (!Array.isArray(message.filenames) || message.filenames.length === 0 || !message.filenames.every((file) => file.startsWith(into))) continue;
      ids.add(message.package_id);
    }
  }
  return ids;
}

/**
 * The folder `compiledPackages` looks in for the units of `metadata`'s
 * workspace (`cargo metadata --format-version 1`): its target directory,
 * where Cargo also builds when its build directory is the same. A build
 * directory apart from it would hold the dependencies' units where they are
 * not looked for, so it stops the notices.
 */
export function unitFolder(metadata) {
  const build = metadata.build_directory ?? metadata.target_directory;
  if (build !== metadata.target_directory) {
    throw new Error(`cargo builds in ${build}, apart from its target directory ${metadata.target_directory}; build the release with both the same (CARGO_BUILD_BUILD_DIR)`);
  }
  return metadata.target_directory;
}

/**
 * The third-party packages of `metadata` (`cargo metadata --format-version
 * 1`) that `ids` (`compiledPackages`) names, without those `isOwn` takes for
 * this repository's or urx-device's own, sorted by name, version and source.
 * Every program of `programs` must be among `ids`, so that the report covers
 * it, and every ID must be a package of `metadata`.
 */
export function programCrates(metadata, ids, isOwn, programs) {
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  for (const name of programs) {
    if (![...ids].some((id) => packages.get(id)?.name === name && metadata.workspace_members.includes(id))) {
      throw new Error(`cargo's report holds no unit of ${name}: it does not cover that program`);
    }
  }
  const crates = [];
  for (const id of ids) {
    const item = packages.get(id);
    if (item === undefined) throw new Error(`cargo's report names the package ${id}, which cargo metadata does not have`);
    if (!isOwn(item)) crates.push(item);
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return crates.sort((a, b) => order(a.name, b.name) || order(a.version, b.version) || order(String(a.source), String(b.source)));
}

/**
 * The folder a crate's license texts must lie in: its package for a crate
 * from a registry (as Cargo extracted it); for one taken from a folder or a
 * repository, the repository or the checkout that holds its package (the
 * nearest folder above it with `.git` or Cargo's `.cargo-ok`), else its
 * package. Files elsewhere on the build machine are no part of what Cargo
 * took.
 */
export function sourceRoot(item) {
  const directory = realpathSync(dirname(item.manifest_path));
  if (typeof item.source === "string" && /^(registry|sparse)\+/.test(item.source)) return directory;
  for (let at = directory; ; at = dirname(at)) {
    if (existsSync(join(at, ".git")) || existsSync(join(at, ".cargo-ok"))) return at;
    if (dirname(at) === at) return directory;
  }
}

/**
 * The license texts of the package `item` as [name, text], sorted by name
 * (code unit order, whatever the locale): every license file at the top of
 * its package folder and the file its manifest names (`license_file`), each
 * read through a link to where it is, a folder by the files in it, and each
 * file once. Each must lead to a file inside what Cargo took (`sourceRoot`)
 * holding text (another than whitespace); one that leads to no file, outside
 * it, or to no text stops the build with its name.
 */
export function licenseTexts(item) {
  const directory = dirname(item.manifest_path);
  const root = sourceRoot(item);
  const fail = (name, what) => new Error(`the Rust crate ${item.name} ${item.version} has ${name}, which ${what}`);
  const texts = new Map();
  // Each folder once: whether it led to text, or null while it is being read (a cycle adds nothing).
  const folders = new Map();
  // Adds what `name` (at `path`) leads to; whether it led to text.
  const add = (name, path) => {
    let real;
    try {
      real = realpathSync(path);
    } catch {
      throw fail(name, "leads to no file");
    }
    const inside = relative(root, real);
    if (inside.startsWith("..") || isAbsolute(inside)) throw fail(name, "leads outside what Cargo took of it");
    const stat = statSync(real);
    if (stat.isDirectory()) {
      if (folders.has(real)) return folders.get(real) === true;
      folders.set(real, null);
      let found = false;
      for (const entry of readdirSync(real).sort()) found = add(`${name}/${entry}`, join(real, entry)) || found;
      folders.set(real, found);
      return found;
    }
    if (!stat.isFile()) throw fail(name, "is not a file");
    if (!texts.has(real)) texts.set(real, [name, readFileSync(real, "utf8")]);
    return texts.get(real)[1].trim() !== "";
  };
  const take = (name, path) => {
    if (!add(name, path)) throw fail(name, "holds no license text");
  };
  for (const name of readdirSync(directory).sort()) if (isLicenseFile(name)) take(name, join(directory, name));
  if (item.license_file) {
    const path = isAbsolute(item.license_file) ? item.license_file : join(directory, item.license_file);
    if (!existsSync(path)) throw new Error(`the Rust crate ${item.name} ${item.version} names ${item.license_file} as its license file, which its package does not hold`);
    take(relative(directory, path).split(sep).join("/"), path);
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
    // Every text the list holds, whichever way it came, holds more than whitespace.
    for (const [name, body] of texts) {
      if (body.trim() === "") throw new Error(`the Rust crate ${item.name} ${item.version} has ${name}, which holds no license text`);
    }
    const header = [`${item.name} ${item.version}`, `License: ${item.license ?? "(none stated)"}`, ...(item.repository ? [`Repository: ${item.repository}`] : [])];
    return [RULE, ...header, ...texts.flatMap(([name, body]) => ["", `--- ${name} ---`, body.trimEnd()])].join("\n");
  });
  const unused = Object.keys(recorded).filter((name) => !used.has(name));
  if (unused.length > 0) throw new Error(`a license text is recorded for ${unused.join(", ")}, which the release's programs do not take`);
  return `The third-party Rust crates built into this release's programs, with their licenses.\n\n${blocks.join("\n\n")}\n`;
}

/** The platform `rustc` builds for by default, in the folder `source`. */
export function hostTriple(source, environment) {
  const host = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { cwd: source, encoding: "utf8", env: environment }))?.[1];
  if (host === undefined) throw new Error("rustc names no host platform");
  return host;
}

/**
 * The arguments of the `cargo metadata` the notices read for programs built
 * for `triple`: the packages of that platform only, so that it needs no
 * package only another platform uses, which a build for `triple` does not
 * fetch.
 */
export function metadataArguments(triple) {
  return ["metadata", "--format-version", "1", "--locked", "--color", "never", "--filter-platform", triple];
}

/**
 * The notices of the Rust crates in the programs of the export at `source`,
 * built for `triple` and reported in `reports` (`compiledPackages`), their
 * recorded texts read from the export. `environment` is the cargo builds'
 * environment (its CARGO_TARGET_DIR and CARGO_BUILD_BUILD_DIR name the one
 * folder they built in).
 */
export function rustNotices(source, environment, triple, reports, platform = process.platform) {
  const metadata = JSON.parse(
    execFileSync("cargo", metadataArguments(triple), {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      env: environment,
    }),
  );
  const ids = compiledPackages(reports, unitFolder(metadata), triple);
  return crateNotices(programCrates(metadata, ids, ownOf(source), programPackages(platform)), {
    filesOf: licenseTexts,
    readRecorded: (path) => readFileSync(join(source, ...path.split("/")), "utf8"),
  });
}
