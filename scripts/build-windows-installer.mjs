// The Windows installer (K17, K23): compiles installer/windows/urx-cli.iss
// with Inno Setup's command-line compiler over dist-bundle/, after checking
// that the bundle holds exactly the files its release manifest lists, each as
// built, in a copy of dist-bundle/ it compiles from, that the bundle is a Windows
// x64 one, and that the compiler is the Inno Setup version build-inputs.json
// records; it writes the setup program to dist-installer/. The installer is
// given the list of those files with their SHA-256, and checks each one after
// installing it. Like the other builds, it stops before reading anything when
// anything is at dist-installer/, and publishes the setup program with
// tools/output: in a work folder beside it, then renamed to dist-installer/
// only where nothing is.
//
// Usage: node scripts/build-windows-installer.mjs --iscc <path to ISCC.exe>

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleProblems, platformOf, snapshotRelease } from "./build-bundle.mjs";
import { cleanUp, isRecordedPath, outputTool, publishOutput, requireNoOutput, sha256 } from "./release-build.mjs";

const MANIFEST = "release-manifest.json";

/** A Pascal string literal of `text`. */
const pascal = (text) => `'${text.replaceAll("'", "''")}'`;

/**
 * The [Code] include that lists each file of the bundle, as a Windows path
 * relative to the installation, with its SHA-256: the files the manifest
 * lists, then the manifest itself with `manifestDigest`.
 */
export function ownedFilesInclude(manifest, manifestDigest) {
  const owned = [...manifest.files.map((file) => ({ path: file.path, sha256: file.sha256 })), { path: MANIFEST, sha256: manifestDigest }];
  const names = new Set();
  for (const file of owned) {
    // The same paths a release record may name: one file inside the installation on either platform.
    if (!isRecordedPath(file.path)) throw new Error(`the manifest names a path the installer cannot hold: ${JSON.stringify(file.path)}`);
    // Windows compares names without regard to letter case.
    if (names.has(file.path.toLowerCase())) throw new Error(`the manifest names ${file.path} twice`);
    names.add(file.path.toLowerCase());
    if (!/^[0-9a-f]{64}$/.test(file.sha256 ?? "")) throw new Error(`the manifest names no SHA-256 for ${file.path}`);
  }
  return [
    "procedure LoadOwnedFiles(var Paths, Hashes: TArrayOfString);",
    "begin",
    `  SetArrayLength(Paths, ${owned.length});`,
    `  SetArrayLength(Hashes, ${owned.length});`,
    ...owned.flatMap((file, index) => [`  Paths[${index}] := ${pascal(file.path.replaceAll("/", "\\"))};`, `  Hashes[${index}] := ${pascal(file.sha256)};`]),
    "end;",
    "",
  ].join("\r\n");
}

export { bundleProblems };

/** The files a Windows bundle cannot be without: the launcher, the runtime, the addon, the CLI's entry and the Rust crates' licenses. */
const REQUIRED = ["bin/urx.exe", "runtime/node.exe", "native/urx-native.node", "app/main.js", "notices/rust-crates.txt"];

/**
 * What keeps the bundle `manifest` describes from being a Windows x64 bundle
 * built with the Node archive `inputs` (build-inputs.json) records for it.
 */
export function windowsBundleProblems(manifest, inputs) {
  const problems = [];
  const archive = inputs.node.archives["win-x64"];
  if (manifest.runtime?.archive !== archive.file || manifest.runtime?.sha256 !== archive.sha256) {
    problems.push(`the bundle's runtime is not ${archive.file}, the Windows x64 Node archive build-inputs.json records`);
  }
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const path of REQUIRED) if (!listed.has(path)) problems.push(`the bundle lists no ${path}`);
  return problems;
}

/**
 * The Inno Setup version `version` (x.y.z), encoded as ISPP's `Ver` is without
 * its build number, so the script can refuse any other compiler.
 */
export function innoVersionNumber(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? "");
  if (match === null) throw new Error(`build-inputs.json records no Inno Setup version x.y.z: ${version}`);
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major > 255 || minor > 255 || patch > 255) throw new Error(`the Inno Setup version ${version} does not fit ISPP's version number`);
  return String(major * 65536 + minor * 256 + patch);
}

const USAGE = "usage: node scripts/build-windows-installer.mjs --iscc <path to ISCC.exe>";

function main(argv) {
  if (platformOf().key !== "win-x64") throw new Error("the Windows installer is built on Windows x64");
  if (argv.length !== 2 || argv[0] !== "--iscc") throw new Error(USAGE);
  const iscc = argv[1];
  const root = fileURLToPath(new URL("../", import.meta.url));
  const bundle = join(root, "dist-bundle");
  const output = join(root, "dist-installer");
  // Checked before reading anything; the rename that publishes the setup program checks again.
  requireNoOutput(output, "installer build");
  let scratch;
  try {
    const inputs = JSON.parse(readFileSync(join(root, "build-inputs.json"), "utf8"));
    const innoVersion = innoVersionNumber(inputs.innoSetup?.version);
    scratch = mkdtempSync(join(tmpdir(), "urx-installer-"));
    // The output tool is built in this build's own Cargo folder, not the caller's.
    const tool = outputTool(root, join(scratch, "target"));
    // The installer is compiled from this copy, the one checked, whatever happens to dist-bundle/ meanwhile.
    const snapshot = join(scratch, "bundle");
    snapshotRelease(bundle, snapshot);
    const manifestBytes = readFileSync(join(snapshot, MANIFEST));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const problems = bundleProblems(snapshot, manifest);
    if (problems.length === 0) problems.push(...windowsBundleProblems(manifest, inputs));
    if (problems.length > 0) throw new Error(`${bundle} is not the Windows bundle its manifest describes: ${problems.join("; ")}`);
    // The version is written into the installer's [Setup] section and its state record as it is.
    if (!/^[0-9A-Za-z.+-]+$/.test(manifest.release ?? "")) throw new Error(`the bundle's manifest names no release version the installer can carry: ${manifest.release}`);
    const include = join(scratch, "owned-files.iss");
    writeFileSync(include, ownedFilesInclude(manifest, sha256(manifestBytes)));
    // Compiled into this run's scratch, then published.
    const staging = join(scratch, "output");
    execFileSync(
      iscc,
      [
        "/Qp",
        `/DAppVersion=${manifest.release}`,
        `/DManifestDigest=${sha256(manifestBytes)}`,
        `/DBundleDir=${snapshot}`,
        `/DOwnedFiles=${include}`,
        `/DInnoVersion=${innoVersion}`,
        `/O${staging}`,
        join(root, "installer", "windows", "urx-cli.iss"),
      ],
      { stdio: "inherit" },
    );
    publishOutput(staging, output, { label: "installer build", tool });
    process.stderr.write(`installer written to ${output}\n`);
  } finally {
    // The setup program is published or not by now; removing the scratch changes neither.
    if (scratch !== undefined) cleanUp("installer build", scratch, () => rmSync(scratch, { recursive: true, force: true }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
