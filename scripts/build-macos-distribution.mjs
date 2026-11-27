// The macOS distribution files (K41, K20), made from the installer tree in
// dist-installer/ and written to dist-macos/:
//
//   urx-cli-<release>-macos-arm64.dmg            the read-only disk image the
//                                                release publishes: urx-install
//                                                beside urx-cli/
//   urx-cli-<release>-macos-arm64-recovery.zip   the removal tool urx-uninstall
//                                                with the notices, for removing
//                                                an installation whose own copy
//                                                is gone
//
// The tree is copied first, and the copy checked: it holds exactly urx-install,
// urx-cli/ and the record installer.json; urx-install is the file the record
// names, built for the release manifest the record names (whose SHA-256 is in
// the program), which is the bundle's; and the bundle holds exactly the files
// its release manifest lists with their modes and is a macOS arm64 bundle of
// the commit HEAD names. Every entry is a directory or a regular file before
// any mode is set. The record is left out of what is published. Both
// files are made from that copy and checked against it afterwards: the image
// is mounted read-only and the ZIP extracted, and each must hold exactly the
// copy's files with their contents and modes. Like the other builds, it stops
// before reading anything when anything is at dist-macos/, and publishes the
// files with tools/output: in a work folder beside it, then renamed to
// dist-macos/ only where nothing is. Neither file is signed here.
//
// Usage: node scripts/build-macos-distribution.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleProblems, normalizeModes, platformOf, snapshotRelease } from "./build-bundle.mjs";
import { EXECUTABLES, INSTALLER_RECORD, macosBundleProblems } from "./build-macos-installer.mjs";
import { cleanUp, outputTool, publishOutput, requireNoOutput, sha256 } from "./release-build.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const MANIFEST = "release-manifest.json";
const TOOL = "maintenance/urx-uninstall";

/** The names of the distribution files of the release `release`. */
export function distributionNames(release) {
  return {
    image: `urx-cli-${release}-macos-arm64.dmg`,
    volume: `urx-cli ${release}`,
    recovery: `urx-cli-${release}-macos-arm64-recovery.zip`,
    recoveryFolder: `urx-cli-${release}-recovery`,
  };
}

/**
 * Every entry under `root`, by relative path, sorted: its kind, its mode and,
 * for a file, the SHA-256 of what it holds. Anything but a directory or a
 * regular file is refused, so nothing is followed through a link.
 */
export function treeOf(root) {
  const entries = [];
  const walk = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const inside = relative(root, path).split(sep).join("/");
      const stat = lstatSync(path);
      const mode = stat.mode & 0o7777;
      if (stat.isDirectory()) {
        entries.push({ path: inside, kind: "directory", mode });
        walk(path);
      } else if (stat.isFile()) {
        entries.push({ path: inside, kind: "file", mode, sha256: sha256(readFileSync(path)) });
      } else {
        throw new Error(`${path} is not a regular file or a directory`);
      }
    }
  };
  walk(root);
  return entries;
}

/** The first difference between the trees `actual` and `expected` (`treeOf`), or null. */
export function treeDifference(actual, expected) {
  const byPath = (entries) => new Map(entries.map((entry) => [entry.path, entry]));
  const have = byPath(actual);
  const want = byPath(expected);
  for (const [path, entry] of want) {
    const found = have.get(path);
    if (found === undefined) return `${path} is missing`;
    if (found.kind !== entry.kind) return `${path} is a ${found.kind}, not a ${entry.kind}`;
    if (found.mode !== entry.mode) return `${path} has mode ${found.mode.toString(8)}, not ${entry.mode.toString(8)}`;
    if (found.sha256 !== entry.sha256) return `${path} does not hold what it should`;
  }
  for (const path of have.keys()) if (!want.has(path)) return `${path} should not be there`;
  return null;
}

/** The executables of an installer tree, by path from its top. */
export const TREE_EXECUTABLES = ["urx-install", ...EXECUTABLES.map((path) => `urx-cli/${path}`)];

/**
 * Gives the copy of an installer tree at `tree` the modes it is distributed
 * with, once every entry in it is checked to be a directory or a regular
 * file: no mode is set through a link on anything outside the copy.
 */
export function prepareTree(tree) {
  normalizeModes(tree, TREE_EXECUTABLES);
}

/**
 * What keeps the installer tree at `tree` from being the one its record
 * describes, urx-install of the bundle beside it whose manifest bytes are
 * `manifestBytes`: exactly urx-install, urx-cli and the record; urx-install
 * the SHA-256 and size the record names; the release manifest the record
 * names, the bundle's; and that manifest's SHA-256 in the program.
 */
export function installerTreeProblems(tree, manifestBytes) {
  const names = readdirSync(tree).sort();
  if (JSON.stringify(names) !== JSON.stringify([INSTALLER_RECORD, "urx-cli", "urx-install"])) {
    return [`the installer tree holds ${JSON.stringify(names)}, not urx-install beside urx-cli with ${INSTALLER_RECORD}`];
  }
  let record;
  try {
    record = JSON.parse(readFileSync(join(tree, INSTALLER_RECORD), "utf8"));
  } catch {
    return [`${INSTALLER_RECORD} is not a record the installer build writes`];
  }
  const problems = [];
  const program = readFileSync(join(tree, "urx-install"));
  const installer = record?.installer;
  if (installer?.path !== "urx-install" || installer?.sha256 !== sha256(program) || installer?.size !== program.length) {
    problems.push(`urx-install is not the file ${INSTALLER_RECORD} names`);
  }
  if (record?.releaseManifest !== sha256(manifestBytes)) problems.push(`${INSTALLER_RECORD} names another release manifest than the bundle's`);
  if (!program.includes(Buffer.from(sha256(manifestBytes), "ascii"))) problems.push("urx-install is not built for the bundle beside it");
  return problems;
}

function run(command, args) {
  execFileSync(command, args, { stdio: ["ignore", "inherit", "inherit"] });
}

function main(argv) {
  if (platformOf().key !== "darwin-arm64") throw new Error("the macOS distribution is built on macOS arm64");
  if (argv.length !== 0) throw new Error("usage: node scripts/build-macos-distribution.mjs");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const installer = join(root, "dist-installer");
  const output = join(root, "dist-macos");
  // Checked before reading anything; the rename that publishes the files checks again.
  requireNoOutput(output, "distribution build");
  const tool = outputTool(root);
  let scratch;
  let mounted;
  try {
    const inputs = JSON.parse(readFileSync(join(root, "build-inputs.json"), "utf8"));
    const head = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8", env: withoutGitLocation(process.env) }).trim();
    scratch = mkdtempSync(join(tmpdir(), "urx-distribution-"));
    // Both files are made from this copy, the one checked, whatever happens to dist-installer/ meanwhile.
    const tree = join(scratch, "tree");
    snapshotRelease(installer, tree);
    const bundle = join(tree, "urx-cli");
    prepareTree(tree);
    const manifestBytes = readFileSync(join(bundle, MANIFEST));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const problems = bundleProblems(bundle, manifest);
    if (problems.length === 0) problems.push(...macosBundleProblems(manifest, inputs, head), ...installerTreeProblems(tree, manifestBytes));
    if (problems.length > 0) throw new Error(`${installer} is not the macOS installer tree of HEAD: ${problems.join("; ")}`);
    // The record has done its work: the image holds urx-install beside urx-cli/ alone.
    rmSync(join(tree, INSTALLER_RECORD));
    const names = distributionNames(manifest.release);
    process.stderr.write(`distribution build of urx-cli ${manifest.release} (${head})\n`);
    const files = join(scratch, "output");
    mkdirSync(files);

    // The disk image, read back read-only.
    const image = join(files, names.image);
    run("hdiutil", ["create", "-quiet", "-volname", names.volume, "-srcfolder", tree, "-fs", "APFS", "-format", "UDZO", image]);
    const mount = join(scratch, "mount");
    mkdirSync(mount);
    run("hdiutil", ["attach", "-quiet", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mount, image]);
    mounted = mount;
    const imageDifference = treeDifference(treeOf(mount), treeOf(tree));
    if (imageDifference !== null) throw new Error(`the disk image does not hold the installer tree: ${imageDifference}`);
    run("hdiutil", ["detach", "-quiet", mount]);
    mounted = undefined;

    // The recovery ZIP: the removal tool of the bundle, the same file, with the notices.
    const recovery = join(scratch, "recovery", names.recoveryFolder);
    mkdirSync(recovery, { recursive: true });
    cpSync(join(bundle, TOOL), join(recovery, "urx-uninstall"));
    cpSync(join(bundle, "notices"), join(recovery, "notices"), { recursive: true });
    normalizeModes(recovery, ["urx-uninstall"]);
    const archive = join(files, names.recovery);
    run("ditto", ["-c", "-k", "--norsrc", "--noextattr", "--keepParent", recovery, archive]);
    const extracted = join(scratch, "extracted");
    mkdirSync(extracted);
    run("ditto", ["-x", "-k", "--norsrc", "--noextattr", archive, extracted]);
    const archiveDifference = treeDifference(treeOf(extracted), treeOf(join(scratch, "recovery")));
    if (archiveDifference !== null) throw new Error(`the recovery ZIP does not hold the removal tool and the notices: ${archiveDifference}`);

    normalizeModes(files, []);
    publishOutput(files, output, { label: "distribution build", tool });
    process.stderr.write(`distribution written to ${output}\n`);
  } finally {
    // A mounted image goes before its scratch; the files are published or not by now.
    if (mounted !== undefined) {
      const detached = spawnSync("hdiutil", ["detach", "-quiet", mounted]).status === 0 || spawnSync("hdiutil", ["detach", "-quiet", "-force", mounted]).status === 0;
      if (!detached) process.stderr.write(`distribution build: the disk image mounted at ${mounted} could not be detached\n`);
    }
    if (scratch !== undefined) cleanUp("distribution build", scratch, () => rmSync(scratch, { recursive: true, force: true }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
