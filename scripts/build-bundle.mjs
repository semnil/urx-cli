// The installed bundle (K18, K38): the release output and the pinned Node
// runtime assembled into the fixed layout, with a release manifest that lists
// every file it owns by its SHA-256 and names the identities it was built
// from. The Node archive is given by path and checked against the hash
// build-inputs.json records for this platform before anything is extracted.
// Nothing is downloaded here, and the bundle has no links.
//
//   bin/urx[.exe]                the launcher (K22)
//   runtime/node[.exe]           the bundled Node
//   app/                         the compiled CLI and the real common package
//   native/urx-native.node       the addon
//   notices/                     the licenses of the CLI, urx-device and Node
//   release-manifest.json        relative paths, hashes and identities
//
// Usage: node scripts/build-bundle.mjs --node-archive <path> [--release dist-release] [--output dist-bundle]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { publishOutput } from "./release-build.mjs";

const PRODUCT = "urx-cli";
const FORMAT = 1;

/** This platform's key in build-inputs.json and its executable names. */
export function platformOf(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return { key: "darwin-arm64", exe: "", runtimeInArchive: ["bin", "node"] };
  if (platform === "win32" && arch === "x64") return { key: "win-x64", exe: ".exe", runtimeInArchive: ["node.exe"] };
  throw new Error(`no bundle is built for ${platform}-${arch} (K16)`);
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The archive's bytes when they have the hash recorded for this platform; refuses anything else. */
export function verifyArchive(path, expected) {
  const actual = sha256(readFileSync(path));
  if (actual !== expected) throw new Error(`the Node archive's SHA-256 is ${actual}, not the recorded ${expected}`);
}

/** Every regular file under `root`, as sorted relative paths with `/` separators. */
export function filesUnder(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`the bundle may hold no link: ${relative(root, path)}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`the bundle may hold regular files only: ${relative(root, path)}`);
    }
  };
  walk(root);
  return found.sort();
}

/** The release manifest of the bundle at `root`: identities, then each owned file with its hash and size. */
export function manifestOf(root, identities) {
  const files = filesUnder(root)
    .filter((path) => path !== "release-manifest.json")
    .map((path) => {
      const bytes = readFileSync(join(root, ...path.split("/")));
      return { path, sha256: sha256(bytes), size: bytes.length };
    });
  return { product: PRODUCT, format: FORMAT, ...identities, files };
}

/**
 * Lays out the bundle in `staging` from the release output, the extracted
 * Node archive (its single top directory) and the notices.
 */
export function assemble({ release, node, notices, staging, platform }) {
  const copy = (from, ...to) => {
    mkdirSync(join(staging, ...to.slice(0, -1)), { recursive: true });
    cpSync(from, join(staging, ...to), { recursive: true });
  };
  copy(join(release, "launcher", `urx${platform.exe}`), "bin", `urx${platform.exe}`);
  copy(join(node, ...platform.runtimeInArchive), "runtime", `node${platform.exe}`);
  // The compiled CLI and the common package; the addon and the launcher have places of their own.
  mkdirSync(join(staging, "app"), { recursive: true });
  cpSync(release, join(staging, "app"), {
    recursive: true,
    filter: (path) => {
      const inside = relative(release, path).split(sep).join("/");
      return inside !== "launcher" && !inside.startsWith("launcher/") && inside !== "native/urx-native.node";
    },
  });
  copy(join(release, "native", "urx-native.node"), "native", "urx-native.node");
  for (const [name, path] of Object.entries(notices)) copy(path, "notices", name);
}

async function main(argv) {
  const option = (name, fallback) => {
    const at = argv.indexOf(name);
    return at >= 0 && argv[at + 1] !== undefined ? argv[at + 1] : fallback;
  };
  const archive = option("--node-archive", undefined);
  if (archive === undefined) throw new Error("usage: node scripts/build-bundle.mjs --node-archive <path> [--release dist-release] [--output dist-bundle]");
  const root = fileURLToPath(new URL("../", import.meta.url));
  const release = resolve(option("--release", join(root, "dist-release")));
  const output = resolve(option("--output", join(root, "dist-bundle")));
  const platform = platformOf();
  const inputs = JSON.parse(readFileSync(join(root, "build-inputs.json"), "utf8"));
  const recorded = inputs.node.archives[platform.key];
  verifyArchive(archive, recorded.sha256);

  const { BUILD_INFO } = await import(pathToFileURL(join(release, "build-info.js")).href);
  const scratch = mkdtempSync(join(tmpdir(), "urx-bundle-"));
  try {
    execFileSync("tar", ["-xf", archive, "-C", scratch], { stdio: "inherit" });
    const [top, ...others] = readdirSync(scratch);
    if (top === undefined || others.length > 0 || !statSync(join(scratch, top)).isDirectory()) throw new Error("the Node archive does not hold one top directory");
    const node = join(scratch, top);
    // Built next to the output, so the final rename stays on one file system.
    const staging = mkdtempSync(`${output}-`);
    assemble({
      release,
      node,
      staging,
      platform,
      notices: { "urx-cli.txt": join(root, "LICENSE"), "urx-device.txt": join(root, "vendor", "urx-device", "LICENSE"), "node.txt": join(node, "LICENSE") },
    });
    const manifest = manifestOf(staging, {
      release: BUILD_INFO.appVersion,
      app: { version: BUILD_INFO.appVersion, commit: BUILD_INFO.appCommit },
      common: { version: BUILD_INFO.commonVersion, commit: BUILD_INFO.commonCommit },
      runtime: { version: inputs.node.version, archive: recorded.file, sha256: recorded.sha256 },
    });
    writeFileSync(join(staging, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    publishOutput(staging, output);
    process.stderr.write(`bundle written to ${output} (${manifest.files.length} files)\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
