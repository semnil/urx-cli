// The installed bundle (K18, K38): the release output and the pinned Node
// runtime assembled into the fixed layout, with a release manifest that lists
// every file it owns by its SHA-256 and names the identities it was built
// from. It reads dist-release/ and writes dist-bundle/, both at the
// repository root. It stops before reading anything when anything is at
// dist-bundle/, and publishes the bundle with tools/output: complete,
// manifest included, in a work folder beside it, then renamed to
// dist-bundle/ only where nothing is. The Node archive is given by path and
// read once: the bytes whose
// hash matches the one build-inputs.json records for this platform are the
// bytes extracted. Nothing is downloaded here, the bundle has no links, and
// on macOS its directories and executables are 0755 and its other files 0644.
//
//   bin/urx[.exe]                the launcher (K22)
//   runtime/node[.exe]           the bundled Node
//   app/                         the compiled CLI and the real common package
//   native/urx-native.node       the addon
//   maintenance/urx-uninstall    the removal tool (macOS only, K20)
//   notices/                     the licenses of the CLI, urx-device and Node
//   release-manifest.json        relative paths, hashes and identities
//
// Usage: node scripts/build-bundle.mjs --node-archive <path>
//        node scripts/build-bundle.mjs --archive-url   (prints where this platform's archive is published)

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cleanUp, describeFiles, filesUnder, isModuleFormat, isRecordedPath, maintenanceTools, outputTool, PACKAGE_FILES, publishOutput, recordedProblems, releaseRecord, requireNoOutput, sha256 } from "./release-build.mjs";
import { compiledModules, moduleProblems } from "./compiled-modules.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const PRODUCT = "urx-cli";
const FORMAT = 1;

/** This platform's key in build-inputs.json and its executable names. */
export function platformOf(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return { key: "darwin-arm64", exe: "", runtimeInArchive: ["bin", "node"], maintenance: maintenanceTools("darwin") };
  if (platform === "win32" && arch === "x64") return { key: "win-x64", exe: ".exe", runtimeInArchive: ["node.exe"], maintenance: maintenanceTools("win32") };
  throw new Error(`no bundle is built for ${platform}-${arch} (K16)`);
}

export { sha256 };

/** Where nodejs.org publishes the archive build-inputs.json records for `platform`. */
export function archiveUrl(inputs, platform) {
  const { version, archives } = inputs.node;
  return `https://nodejs.org/dist/v${version}/${archives[platform.key].file}`;
}

/**
 * A file's bytes as `commit` records them in the repository at `directory`,
 * whatever the working tree holds, so the notices are those of the commits the
 * release output was built from.
 */
function recordedFile(directory, commit, path) {
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`the release output names no commit to read ${path} from`);
  return execFileSync("git", ["-C", directory, "cat-file", "blob", `${commit}:${path}`], {
    env: withoutGitLocation(process.env),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * The tar that reads this platform's archive: macOS's own, and on Windows the
 * system's, which reads a zip where a GNU tar earlier on PATH would not.
 */
function systemTar() {
  if (process.platform !== "win32") return "/usr/bin/tar";
  const systemRoot = process.env.SystemRoot;
  if (systemRoot === undefined || systemRoot === "") throw new Error("SystemRoot is not set, so the system's tar cannot be found");
  return join(systemRoot, "System32", "tar.exe");
}

/** The archive's bytes, read once, when they have the hash recorded for this platform; refuses anything else. */
export function verifiedArchive(path, expected) {
  const bytes = readFileSync(path);
  const actual = sha256(bytes);
  if (actual !== expected) throw new Error(`the Node archive's SHA-256 is ${actual}, not the recorded ${expected}`);
  return bytes;
}

/** The identity of the directory at `path`; a release build that replaces it leaves a different one there. */
export function directoryIdentity(path) {
  const stats = lstatSync(path, { bigint: true });
  if (!stats.isDirectory()) throw new Error(`${path} is not a directory`);
  return `${stats.dev}:${stats.ino}:${stats.birthtimeNs}`;
}

/**
 * Copies the release output to `snapshot`, which this build alone then reads.
 * A copy during which a release build replaced the output may mix two
 * releases, so it is refused.
 */
export function snapshotRelease(release, snapshot, copy = cpSync) {
  const before = directoryIdentity(release);
  copy(release, snapshot, { recursive: true });
  if (directoryIdentity(release) !== before) throw new Error(`${release} was replaced while it was copied; build the bundle again`);
}

export { filesUnder };

/** What keeps the bundle at `bundle` from being the one its manifest describes, by path. */
export function bundleProblems(bundle, manifest) {
  if (manifest?.product !== PRODUCT || manifest?.format !== FORMAT || !Array.isArray(manifest.files)) return ["the bundle has no urx-cli format 1 manifest"];
  const listed = new Set(manifest.files.map((file) => file.path));
  const unlisted = filesUnder(bundle).filter((path) => path !== "release-manifest.json" && !listed.has(path));
  return [...recordedProblems(bundle, manifest.files), ...unlisted.map((path) => `${path} is not one of its files`)];
}

/**
 * Gives the bundle at `root` the modes it is distributed with, whatever the
 * umask or its sources gave it: 0755 for directories and for the
 * `executables` (relative paths), 0644 for every other file. Windows has no
 * such modes.
 */
export function normalizeModes(root, executables, platform = process.platform) {
  if (platform === "win32") return;
  const walk = (directory) => {
    chmodSync(directory, 0o755);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else chmodSync(path, executables.includes(relative(root, path).split(sep).join("/")) ? 0o755 : 0o644);
    }
  };
  walk(root);
}

/** The release manifest of the bundle at `root`: identities, then each owned file with its hash and size. */
export function manifestOf(root, identities) {
  return { product: PRODUCT, format: FORMAT, ...identities, files: describeFiles(root, "release-manifest.json") };
}

/**
 * Lays out the bundle in `staging` from the files the release output's
 * record names (`releaseFiles`, relative paths), the extracted Node archive
 * (its single top directory) and the notices. A file the record does not name
 * is not copied, whatever else lies in the release output.
 */
export function assemble({ release, releaseFiles, node, notices, staging, platform }) {
  const copy = (from, ...to) => {
    mkdirSync(join(staging, ...to.slice(0, -1)), { recursive: true });
    cpSync(from, join(staging, ...to));
  };
  const launcher = `launcher/urx${platform.exe}`;
  const addon = "native/urx-native.node";
  const tools = platform.maintenance.map((tool) => `maintenance/${tool}`);
  // Each named file is one file inside `release`, and lands in one place inside `staging`.
  const bad = releaseFiles.find((path) => !isRecordedPath(path));
  if (bad !== undefined) throw new Error(`the release output's record names a path outside it: ${JSON.stringify(bad)}`);
  if (new Set(releaseFiles.map((path) => path.toLowerCase())).size !== releaseFiles.length) throw new Error("the release output's record names a file twice");
  for (const required of [launcher, addon, "main.js", ...tools]) {
    if (!releaseFiles.includes(required)) throw new Error(`the release output's record names no ${required}`);
  }
  copy(join(release, ...launcher.split("/")), "bin", `urx${platform.exe}`);
  copy(join(node, ...platform.runtimeInArchive), "runtime", `node${platform.exe}`);
  copy(join(release, ...addon.split("/")), "native", "urx-native.node");
  for (const tool of tools) copy(join(release, ...tool.split("/")), ...tool.split("/"));
  // The compiled CLI and the common package; the addon, the launcher and the maintenance tools have places of their own.
  for (const path of releaseFiles) {
    if (path === launcher || path === addon || tools.includes(path)) continue;
    if (path.startsWith("launcher/")) throw new Error(`the release output's record names an unknown launcher file ${path}`);
    if (path.startsWith("maintenance/")) throw new Error(`the release output's record names an unknown maintenance file ${path}`);
    copy(join(release, ...path.split("/")), "app", ...path.split("/"));
  }
  for (const [name, path] of Object.entries(notices)) copy(path, "notices", name);
}

const USAGE = "usage: node scripts/build-bundle.mjs --node-archive <path> | --archive-url";

async function main(argv) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const platform = platformOf();
  const inputs = JSON.parse(readFileSync(join(root, "build-inputs.json"), "utf8"));
  if (argv.length === 1 && argv[0] === "--archive-url") {
    process.stdout.write(`${archiveUrl(inputs, platform)}\n`);
    return;
  }
  if (argv.length !== 2 || argv[0] !== "--node-archive") throw new Error(USAGE);
  const release = join(root, "dist-release");
  const output = join(root, "dist-bundle");
  // Checked before reading anything; the rename that publishes the bundle checks again.
  requireNoOutput(output, "bundle build");
  const tool = outputTool(root);
  let scratch;
  try {
    const recorded = inputs.node.archives[platform.key];
    const archive = verifiedArchive(argv[1], recorded.sha256);
    scratch = mkdtempSync(join(tmpdir(), "urx-bundle-"));
    const snapshot = join(scratch, "release");
    snapshotRelease(release, snapshot);
    // Only what the release build made goes into the bundle, each file as it was built.
    const recordedFiles = releaseRecord(snapshot);
    if (recordedFiles === null) throw new Error(`${release} has no well-formed record of the files a release build made; run pnpm build:release`);
    const problems = recordedProblems(snapshot, recordedFiles);
    if (problems.length > 0) throw new Error(`${release} is not as the release build made it: ${problems.join("; ")}`);
    const recordedPaths = recordedFiles.map((file) => file.path);
    // The build information, and the two package files by which Node reads the CLI as ES modules and finds the
    // common package's entry points, are required; the first package file is the one the release build writes.
    for (const path of ["build-info.js", ...Object.values(PACKAGE_FILES)]) {
      if (!recordedPaths.includes(path)) throw new Error(`${release}'s record names no ${path}; run pnpm build:release`);
    }
    if (!isModuleFormat(readFileSync(join(snapshot, PACKAGE_FILES.module)))) throw new Error(`${release}'s ${PACKAGE_FILES.module} does not say its modules are ES modules`);
    // The build information is read only as recorded and checked above.
    const { BUILD_INFO } = await import(pathToFileURL(join(snapshot, "build-info.js")).href);
    // The record names exactly the modules the release's commits compile to, so the bundle holds every one.
    const moduleIssues = moduleProblems(recordedPaths, compiledModules(root, BUILD_INFO));
    if (moduleIssues.length > 0) throw new Error(`${release}'s record is not of the release its commits compile to: ${moduleIssues.join("; ")}`);
    // The common package's package.json is the one its commit holds, line endings aside.
    const commonPackage = (bytes) => JSON.stringify(JSON.parse(bytes.toString("utf8")));
    const committedPackage = recordedFile(join(root, "vendor", "urx-device"), BUILD_INFO.commonCommit, "packages/control/package.json");
    if (commonPackage(readFileSync(join(snapshot, ...PACKAGE_FILES.common.split("/")))) !== commonPackage(committedPackage)) {
      throw new Error(`${release}'s ${PACKAGE_FILES.common} is not the common package's at its commit`);
    }
    // The checked bytes, written where nothing else replaces them, are what is extracted.
    const archiveCopy = join(scratch, recorded.file);
    writeFileSync(archiveCopy, archive);
    const extracted = join(scratch, "node");
    mkdirSync(extracted);
    execFileSync(systemTar(), ["-xf", archiveCopy, "-C", extracted], { stdio: "inherit" });
    const [top, ...others] = readdirSync(extracted);
    if (top === undefined || others.length > 0 || !statSync(join(extracted, top)).isDirectory()) throw new Error("the Node archive does not hold one top directory");
    const node = join(extracted, top);
    const notices = join(scratch, "notices");
    mkdirSync(notices);
    writeFileSync(join(notices, "urx-cli.txt"), recordedFile(root, BUILD_INFO.appCommit, "LICENSE"));
    writeFileSync(join(notices, "urx-device.txt"), recordedFile(join(root, "vendor", "urx-device"), BUILD_INFO.commonCommit, "LICENSE"));
    // Laid out in this run's scratch, then published, its manifest last.
    const staging = join(scratch, "bundle");
    mkdirSync(staging);
    assemble({
      release: snapshot,
      releaseFiles: recordedPaths,
      node,
      staging,
      platform,
      notices: { "urx-cli.txt": join(notices, "urx-cli.txt"), "urx-device.txt": join(notices, "urx-device.txt"), "node.txt": join(node, "LICENSE") },
    });
    const manifest = manifestOf(staging, {
      release: BUILD_INFO.appVersion,
      app: { version: BUILD_INFO.appVersion, commit: BUILD_INFO.appCommit },
      common: { version: BUILD_INFO.commonVersion, commit: BUILD_INFO.commonCommit },
      runtime: { version: inputs.node.version, archive: recorded.file, sha256: recorded.sha256 },
    });
    writeFileSync(join(staging, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    normalizeModes(staging, [`bin/urx${platform.exe}`, `runtime/node${platform.exe}`, ...platform.maintenance.map((tool) => `maintenance/${tool}`)]);
    publishOutput(staging, output, { last: "release-manifest.json", label: "bundle build", tool });
    process.stderr.write(`bundle written to ${output} (${manifest.files.length} files)\n`);
  } finally {
    // The bundle is published or not by now; removing the scratch changes neither.
    if (scratch !== undefined) cleanUp("bundle build", scratch, () => rmSync(scratch, { recursive: true, force: true }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
