// The notices of the third-party Rust crates built into a release's programs
// (K38): the launcher, the addon and, on macOS, the maintenance tools. The
// crates are those `cargo tree` gives for each of those packages as it is
// built, for the platform the release is built on, with only the
// dependencies that go into the program: not procedural macros, which run
// only while it is compiled, nor build scripts' or tests' dependencies, nor
// what only they use, and with the features that build enables, not those
// another package of the workspace enables. Each is identified by its
// package ID in `cargo metadata`'s dependency graph, followed from the
// program, which carries where Cargo took it from; cargo tree gives only the
// names and versions the program's build takes. Every crate that is not one
// of this repository's or urx-device's own manifests (OWN_MANIFESTS, whose
// licenses the bundle carries already) counts, wherever it lies. For
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
 * The crates `cargo tree --prefix none --format "{p}" --color never`
 * printed, each as `name@version`; what it says of where each was taken
 * from is not read (packages are told apart by `cargo metadata`).
 */
export function treeNames(output) {
  const names = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^([A-Za-z0-9_-]+) v(\S+)/.exec(line);
    if (match === null) throw new Error(`cargo tree printed a line that names no package: ${JSON.stringify(line)}`);
    names.add(`${match[1]}@${match[2]}`);
  }
  return names;
}

/**
 * The third-party packages of `metadata` (`cargo metadata --format-version
 * 1`, for one platform) in the programs `programs` ([{ name, linked }]): from
 * each program's workspace package, its dependency graph is followed along
 * normal dependencies, not into procedural macros, and of the packages it
 * reaches those whose name and version cargo tree gave for that program
 * (`linked`, `treeNames`) are taken, by package ID, without those `isOwn`
 * takes for this repository's or urx-device's own. Sorted by name, version
 * and source. A crate cargo tree gives that the graph does not reach stops
 * it.
 */
export function programCrates(metadata, programs, isOwn) {
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const isMacro = (item) => item.targets.some((target) => target.kind.includes("proc-macro"));
  const crates = new Map();
  for (const { name, linked } of programs) {
    const start = metadata.workspace_members.find((id) => packages.get(id).name === name);
    if (start === undefined) throw new Error(`the workspace has no package ${name}`);
    const reached = new Set();
    const pending = [start];
    while (pending.length > 0) {
      const id = pending.pop();
      if (reached.has(id)) continue;
      reached.add(id);
      for (const dep of nodes.get(id).deps) {
        if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue;
        if (isMacro(packages.get(dep.pkg))) continue;
        pending.push(dep.pkg);
      }
    }
    const taken = [...reached].map((id) => packages.get(id)).filter((item) => linked.has(`${item.name}@${item.version}`));
    const missing = [...linked].filter((key) => !taken.some((item) => `${item.name}@${item.version}` === key));
    if (missing.length > 0) throw new Error(`cargo tree gives ${missing.join(", ")} for ${name}, which its dependency graph in cargo metadata does not reach`);
    for (const item of taken) if (!isOwn(item)) crates.set(item.id, item);
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...crates.values()].sort((a, b) => order(a.name, b.name) || order(a.version, b.version) || order(String(a.source), String(b.source)));
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
  const programs = programPackages(platform).map((name) => ({
    name,
    linked: treeNames(run("cargo", ["tree", "--locked", "--color", "never", "--target", host, "-p", name, "-e", "normal,no-proc-macro", "--prefix", "none", "--format", "{p}"])),
  }));
  const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked", "--color", "never", "--filter-platform", host]));
  return crateNotices(programCrates(metadata, programs, ownOf(source)), {
    filesOf: licenseTexts,
    readRecorded: (path) => readFileSync(join(source, ...path.split("/")), "utf8"),
  });
}
