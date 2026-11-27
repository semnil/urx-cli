// The notices of the third-party Rust crates built into a release's programs
// (K38): the launcher, the addon and, on macOS, the maintenance tools. The
// crates are those `cargo tree` gives for each of those packages as it is
// built, for the platform the release is built on, with only the
// dependencies that go into the program: not procedural macros, which run
// only while it is compiled, nor build scripts' or tests' dependencies, nor
// what only they use, and with the features that build enables, not those
// another package of the workspace enables. Every crate that is not this
// repository's or urx-device's own (whose licenses the bundle carries
// already) counts, wherever Cargo takes it from. For each, the notices name
// the crate, its version, license expression and repository, and hold the
// text of the license file its manifest names (`license-file`) and of every
// license file at the top of its package. A crate whose package holds none
// takes the text this repository records for exactly that version, license
// and repository (RECORDED_TEXTS); a crate with neither, a recorded text for
// another version, license or repository, and a recorded text no crate
// takes each stop the build.

import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
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

/** The packages `cargo tree --prefix none --format "{p}"` printed, each as `name@version`. */
export function treePackages(output) {
  const found = new Set();
  for (const line of output.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    const match = /^(\S+) v(\S+)/.exec(line);
    if (match === null) throw new Error(`cargo tree printed a line that names no package: ${JSON.stringify(line)}`);
    found.add(`${match[1]}@${match[2]}`);
  }
  return found;
}

/**
 * The packages of `metadata` (`cargo metadata --format-version 1`) that
 * `linked` names (`name@version`) and `isOwn` does not take for this
 * repository's or urx-device's own, sorted by name and version.
 */
export function programCrates(metadata, linked, isOwn) {
  const crates = [];
  for (const key of linked) {
    const found = metadata.packages.filter((item) => `${item.name}@${item.version}` === key);
    if (found.length === 0) throw new Error(`cargo metadata has no package ${key}, which cargo tree names`);
    crates.push(...found.filter((item) => !isOwn(item)));
  }
  const order = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return crates.sort((a, b) => order(a.name, b.name) || order(a.version, b.version) || order(String(a.source), String(b.source)));
}

/**
 * The license texts of the package `item` as [name, text], sorted by name
 * (code unit order, whatever the locale):
 * the file its manifest names (`license_file`, which must be there) and every
 * license file at the top of its package folder, each once.
 */
export function licenseTexts(item) {
  const directory = dirname(item.manifest_path);
  const texts = new Map();
  for (const name of readdirSync(directory)) {
    if (isLicenseFile(name) && lstatSync(join(directory, name)).isFile()) texts.set(name, readFileSync(join(directory, name), "utf8"));
  }
  if (item.license_file) {
    const path = isAbsolute(item.license_file) ? item.license_file : join(directory, item.license_file);
    if (!existsSync(path) || !lstatSync(path).isFile()) throw new Error(`the Rust crate ${item.name} ${item.version} names ${item.license_file} as its license file, which its package does not hold`);
    const name = relative(directory, path).split(sep).join("/");
    texts.set(name, readFileSync(path, "utf8"));
  }
  return [...texts].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
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
  const linked = new Set();
  for (const program of programPackages(platform)) {
    const tree = run("cargo", ["tree", "--locked", "--target", host, "-p", program, "-e", "normal,no-proc-macro", "--prefix", "none", "--format", "{p}"]);
    for (const key of treePackages(tree)) linked.add(key);
  }
  const metadata = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", host]));
  const workspace = new Set(metadata.workspace_members);
  const common = realpathSync(join(source, "vendor", "urx-device"));
  const isOwn = (item) => {
    if (workspace.has(item.id)) return true;
    if (item.source !== null) return false;
    const inside = relative(common, realpathSync(dirname(item.manifest_path)));
    return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
  };
  return crateNotices(programCrates(metadata, linked, isOwn), {
    filesOf: licenseTexts,
    readRecorded: (path) => readFileSync(join(source, ...path.split("/")), "utf8"),
  });
}
