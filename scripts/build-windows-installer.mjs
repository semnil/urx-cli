// The Windows installer (K17, K23): compiles installer/windows/urx-cli.iss
// with Inno Setup's command-line compiler over dist-bundle/, after checking
// that the bundle holds exactly the files its release manifest lists, each as
// built, and writes the setup program to dist-installer/. The installer is
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
import { filesUnder, platformOf } from "./build-bundle.mjs";
import { cleanUp, outputTool, publishOutput, recordedProblems, requireNoOutput, sha256 } from "./release-build.mjs";

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
  for (const file of owned) {
    const segments = file.path.split("/");
    if (segments.some((segment) => segment === "" || segment === "." || segment === ".." || /[\\:*?"<>|]/.test(segment))) {
      throw new Error(`the manifest names a path the installer cannot hold: ${file.path}`);
    }
    if (!/^[0-9a-f]{64}$/.test(file.sha256)) throw new Error(`the manifest names no SHA-256 for ${file.path}`);
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

/** What keeps the bundle at `bundle` from being the one its manifest describes, by path. */
export function bundleProblems(bundle, manifest) {
  if (manifest?.product !== "urx-cli" || manifest?.format !== 1 || !Array.isArray(manifest.files)) return ["the bundle has no urx-cli format 1 manifest"];
  const listed = new Set(manifest.files.map((file) => file.path));
  const unlisted = filesUnder(bundle).filter((path) => path !== MANIFEST && !listed.has(path));
  return [...recordedProblems(bundle, manifest.files), ...unlisted.map((path) => `${path} is not one of its files`)];
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
  const tool = outputTool(root);
  let scratch;
  try {
    const manifestBytes = readFileSync(join(bundle, MANIFEST));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    const problems = bundleProblems(bundle, manifest);
    if (problems.length > 0) throw new Error(`${bundle} is not the bundle its manifest describes: ${problems.join("; ")}`);
    // The version is written into the installer's [Setup] section and its state record as it is.
    if (!/^[0-9A-Za-z.+-]+$/.test(manifest.release ?? "")) throw new Error(`the bundle's manifest names no release version the installer can carry: ${manifest.release}`);
    scratch = mkdtempSync(join(tmpdir(), "urx-installer-"));
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
        `/DBundleDir=${bundle}`,
        `/DOwnedFiles=${include}`,
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
