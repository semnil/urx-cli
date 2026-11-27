// The macOS installer tree (K41): `urx-install` beside `urx-cli/`, a copy of
// the bundle in dist-bundle/, written to dist-installer/. The disk image is
// made from this tree. The copy is checked to hold exactly the files its
// release manifest lists, each as built, with the modes the bundle has, and
// to be a macOS arm64 bundle of the commit HEAD names. urx-install is built
// from that commit, exported as the release build exports it, with the
// SHA-256 of the copy's release manifest compiled in: it installs that
// release and no other. Like the other builds, it stops before reading
// anything when anything is at dist-installer/, and publishes the tree with
// tools/output: in a work folder beside it, then renamed to dist-installer/
// only where nothing is.
//
// Usage: node scripts/build-macos-installer.mjs

import { execFileSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { bundleProblems, normalizeModes, platformOf, snapshotRelease } from "./build-bundle.mjs";
import { cargoArtifact, cleanUp, exportRelease, outputTool, publishOutput, removeExport, requireNoOutput, sha256 } from "./release-build.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const MANIFEST = "release-manifest.json";

/** The files a macOS bundle cannot be without (K18, K20). */
const REQUIRED = ["bin/urx", "runtime/node", "native/urx-native.node", "app/main.js", "maintenance/urx-uninstall"];

/** The files of a macOS bundle run as programs; every other file is 0644. */
export const EXECUTABLES = ["bin/urx", "runtime/node", "maintenance/urx-uninstall"];

/**
 * What keeps the bundle `manifest` describes from being a macOS arm64 bundle
 * of the CLI commit `commit`, built with the Node archive `inputs`
 * (build-inputs.json) records for it.
 */
export function macosBundleProblems(manifest, inputs, commit) {
  const problems = [];
  const archive = inputs.node.archives["darwin-arm64"];
  if (manifest.runtime?.archive !== archive.file || manifest.runtime?.sha256 !== archive.sha256) {
    problems.push(`the bundle's runtime is not ${archive.file}, the macOS arm64 Node archive build-inputs.json records`);
  }
  if (manifest.app?.commit !== commit) problems.push(`the bundle is of urx-cli ${manifest.app?.commit}, not of HEAD ${commit}`);
  if (!/^[0-9A-Za-z.+-]{1,64}$/.test(manifest.release ?? "")) problems.push(`the bundle names no release version the installer can record: ${manifest.release}`);
  const listed = new Set(manifest.files.map((file) => file.path));
  for (const path of REQUIRED) if (!listed.has(path)) problems.push(`the bundle lists no ${path}`);
  // The installer takes only printable ASCII paths, so a file system finds each under one name.
  for (const path of listed) if (!/^[\x20-\x7e]+$/.test(path)) problems.push(`the bundle lists a path the installer cannot take: ${JSON.stringify(path)}`);
  return problems;
}

function main(argv) {
  if (platformOf().key !== "darwin-arm64") throw new Error("the macOS installer is built on macOS arm64");
  if (argv.length !== 0) throw new Error("usage: node scripts/build-macos-installer.mjs");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const bundle = join(root, "dist-bundle");
  const output = join(root, "dist-installer");
  // Checked before reading anything; the rename that publishes the tree checks again.
  requireNoOutput(output, "installer build");
  const tool = outputTool(root);
  const environment = withoutGitLocation(process.env);
  let scratch;
  let source;
  try {
    const inputs = JSON.parse(readFileSync(join(root, "build-inputs.json"), "utf8"));
    scratch = mkdtempSync(join(tmpdir(), "urx-installer-"));
    // The tree is made from this copy, the one checked, whatever happens to dist-bundle/ meanwhile.
    const staging = join(scratch, "output");
    const copy = join(staging, "urx-cli");
    mkdirSync(staging);
    snapshotRelease(bundle, copy);
    normalizeModes(copy, EXECUTABLES);
    const manifestBytes = readFileSync(join(copy, MANIFEST));
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    source = join(scratch, "source");
    const { appCommit } = exportRelease(root, source);
    const problems = bundleProblems(copy, manifest);
    if (problems.length === 0) problems.push(...macosBundleProblems(manifest, inputs, appCommit));
    if (problems.length > 0) throw new Error(`${bundle} is not the macOS bundle its manifest describes: ${problems.join("; ")}`);
    const digest = sha256(manifestBytes);
    process.stderr.write(`installer build of urx-cli ${manifest.release} (${appCommit}), release manifest ${digest}\n`);
    const messages = execFileSync("cargo", ["build", "--release", "--locked", "-p", "urx-maintenance", "--bin", "urx-install", "--message-format=json-render-diagnostics"], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...environment, CARGO_TARGET_DIR: join(scratch, "target"), URX_RELEASE_MANIFEST_SHA256: digest },
    });
    cpSync(cargoArtifact(messages, "urx-install"), join(staging, "urx-install"));
    chmodSync(join(staging, "urx-install"), 0o755);
    chmodSync(staging, 0o755);
    publishOutput(staging, output, { label: "installer build", tool });
    process.stderr.write(`installer written to ${output}\n`);
  } finally {
    // The tree is published or not by now; removing the scratch changes neither.
    if (source !== undefined) cleanUp("installer build", source, () => removeExport(root, source));
    if (scratch !== undefined) cleanUp("installer build", scratch, () => rmSync(scratch, { recursive: true, force: true }));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
