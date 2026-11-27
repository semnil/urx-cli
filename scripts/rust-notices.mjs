// The notices of the third-party Rust crates built into a release's programs
// (K38): the launcher, the addon and, on macOS, the maintenance tools. The
// crates are those the release's Cargo.lock resolves, for the platform the
// release is built on, as dependencies that go into those programs: a
// procedural macro runs only while they are compiled, so neither it nor what
// only it uses is counted, and neither are build scripts' dependencies. For
// each, the notices name the crate, its version and license expression, and
// hold the text of every license file its package holds at its top. A crate
// whose package holds none takes the text this repository records for it
// (RECORDED_TEXTS); a crate with neither stops the build, as does a recorded
// text no crate takes.

import { execFileSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** The packages whose programs a release holds, by platform. */
export function programPackages(platform = process.platform) {
  return ["urx-launcher", "urx-cli-native", ...(platform === "darwin" ? ["urx-maintenance"] : [])];
}

/**
 * The license texts this repository records for crates whose packages hold
 * none, by crate name: the path of the text in the repository, and where it
 * was taken from.
 */
export const RECORDED_TEXTS = {
  // The LICENSE of https://github.com/napi-rs/napi-rs (blob 7fe7e35, last changed in ab2a003),
  // the repository both crates name; their packages hold no license file.
  napi: { path: "notices/napi-rs.txt", from: "the LICENSE of https://github.com/napi-rs/napi-rs" },
  "napi-sys": { path: "notices/napi-rs.txt", from: "the LICENSE of https://github.com/napi-rs/napi-rs" },
};

/** Whether `name` is a license file's: LICENSE, LICENCE, COPYING, NOTICE or UNLICENSE, with any suffix. */
export function isLicenseFile(name) {
  return /^(licen[cs]e|copying|notice|unlicense)/i.test(name);
}

/**
 * The third-party packages of `metadata` (`cargo metadata --format-version 1`,
 * filtered to one platform) that go into the programs of the workspace
 * packages named `roots`, sorted by name and version.
 */
export function programCrates(metadata, roots) {
  const packages = new Map(metadata.packages.map((item) => [item.id, item]));
  const nodes = new Map(metadata.resolve.nodes.map((node) => [node.id, node]));
  const workspace = new Set(metadata.workspace_members);
  const starts = [...workspace].filter((id) => roots.includes(packages.get(id).name));
  const missing = roots.filter((name) => !starts.some((id) => packages.get(id).name === name));
  if (missing.length > 0) throw new Error(`the workspace has no package ${missing.join(", ")}`);
  const isMacro = (item) => item.targets.some((target) => target.kind.includes("proc-macro"));
  const seen = new Set();
  const pending = [...starts];
  while (pending.length > 0) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    for (const dep of nodes.get(id).deps) {
      // Only dependencies the program links: not a build script's or a test's.
      if (!dep.dep_kinds.some((kind) => kind.kind === null)) continue;
      if (isMacro(packages.get(dep.pkg))) continue;
      pending.push(dep.pkg);
    }
  }
  return [...seen]
    .map((id) => packages.get(id))
    .filter((item) => item.source !== null)
    .sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** The license files at the top of the folder `directory`, as [name, text], sorted by name. */
export function licenseFiles(directory) {
  return readdirSync(directory)
    .filter((name) => isLicenseFile(name) && lstatSync(join(directory, name)).isFile())
    .sort()
    .map((name) => [name, readFileSync(join(directory, name), "utf8")]);
}

const RULE = "=".repeat(78);

/**
 * The notices of `crates` (`programCrates`): each crate's name, version,
 * license expression and repository, then each of its license texts, its
 * package's own (`filesOf`, by package) or the one `recorded` holds for it
 * (`readRecorded`, by repository path).
 */
export function crateNotices(crates, { filesOf, readRecorded, recorded = RECORDED_TEXTS }) {
  const used = new Set();
  const blocks = crates.map((item) => {
    let texts = filesOf(item);
    if (texts.length === 0) {
      const text = recorded[item.name];
      if (text === undefined) throw new Error(`the Rust crate ${item.name} ${item.version} holds no license file, and none is recorded for it`);
      used.add(item.name);
      texts = [[`${text.path} (${text.from})`, readRecorded(text.path)]];
    }
    const header = [`${item.name} ${item.version}`, `License: ${item.license ?? "(none stated)"}`, ...(item.repository ? [`Repository: ${item.repository}`] : [])];
    return [RULE, ...header, ...texts.flatMap(([name, text]) => ["", `--- ${name} ---`, text.trimEnd()])].join("\n");
  });
  const unused = Object.keys(recorded).filter((name) => !used.has(name));
  if (unused.length > 0) throw new Error(`a license text is recorded for ${unused.join(", ")}, which the release's programs do not hold`);
  return `The third-party Rust crates built into this release's programs, with their licenses.\n\n${blocks.join("\n\n")}\n`;
}

/**
 * The notices of the Rust crates in the programs of the export at `source`
 * (its Cargo.lock, for the platform this runs on), its recorded texts read
 * from it. `environment` is the cargo builds' environment.
 */
export function rustNotices(source, environment, platform = process.platform) {
  const host = /^host: (\S+)$/m.exec(execFileSync("rustc", ["-vV"], { cwd: source, encoding: "utf8", env: environment }))?.[1];
  if (host === undefined) throw new Error("rustc names no host platform");
  const metadata = JSON.parse(
    execFileSync("cargo", ["metadata", "--format-version", "1", "--locked", "--filter-platform", host], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      env: environment,
    }),
  );
  return crateNotices(programCrates(metadata, programPackages(platform)), {
    filesOf: (item) => licenseFiles(dirname(item.manifest_path)),
    readRecorded: (path) => readFileSync(join(source, ...path.split("/")), "utf8"),
  });
}
