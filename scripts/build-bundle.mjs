// The installed bundle (K18, K38): the release output and the pinned Node
// runtime assembled into the fixed layout, with a release manifest that lists
// every file it owns by its SHA-256 and names the identities it was built
// from. It reads dist-release/ and writes dist-bundle/, both at the
// repository root, and removes a previous dist-bundle/ only when it holds
// just the files its manifest lists. The Node archive is given by path and read once: the bytes whose
// hash matches the one build-inputs.json records for this platform are the
// bytes extracted. Nothing is downloaded here, the bundle has no links, and
// on macOS its directories and executables are 0755 and its other files 0644.
//
//   bin/urx[.exe]                the launcher (K22)
//   runtime/node[.exe]           the bundled Node
//   app/                         the compiled CLI and the real common package
//   native/urx-native.node       the addon
//   notices/                     the licenses of the CLI, urx-device and Node
//   release-manifest.json        relative paths, hashes and identities
//
// Usage: node scripts/build-bundle.mjs --node-archive <path>
//        node scripts/build-bundle.mjs --archive-url   (prints where this platform's archive is published)

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filesUnder, publishOutput, RELEASE_FILES } from "./release-build.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const PRODUCT = "urx-cli";
const FORMAT = 1;

/** This platform's key in build-inputs.json and its executable names. */
export function platformOf(platform = process.platform, arch = process.arch) {
  if (platform === "darwin" && arch === "arm64") return { key: "darwin-arm64", exe: "", runtimeInArchive: ["bin", "node"] };
  if (platform === "win32" && arch === "x64") return { key: "win-x64", exe: ".exe", runtimeInArchive: ["node.exe"] };
  throw new Error(`no bundle is built for ${platform}-${arch} (K16)`);
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

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

/** The files a bundle build made in the bundle at `path`, its manifest included, or null when it is not a bundle. */
export function bundleFiles(path) {
  try {
    const manifest = JSON.parse(readFileSync(join(path, "release-manifest.json"), "utf8"));
    if (manifest?.product !== PRODUCT || manifest?.format !== FORMAT || !Array.isArray(manifest.files)) return null;
    return [...manifest.files.map((file) => file.path), "release-manifest.json"];
  } catch {
    return null;
  }
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
  // The compiled CLI and the common package; the addon and the launcher have places of their own,
  // and the release output's record of its files describes that output, not the bundle.
  mkdirSync(join(staging, "app"), { recursive: true });
  cpSync(release, join(staging, "app"), {
    recursive: true,
    filter: (path) => {
      const inside = relative(release, path).split(sep).join("/");
      return inside !== "launcher" && !inside.startsWith("launcher/") && inside !== "native/urx-native.node" && inside !== RELEASE_FILES;
    },
  });
  copy(join(release, "native", "urx-native.node"), "native", "urx-native.node");
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
  const recorded = inputs.node.archives[platform.key];
  const archive = verifiedArchive(argv[1], recorded.sha256);

  const scratch = mkdtempSync(join(tmpdir(), "urx-bundle-"));
  try {
    const snapshot = join(scratch, "release");
    snapshotRelease(release, snapshot);
    const { BUILD_INFO } = await import(pathToFileURL(join(snapshot, "build-info.js")).href);
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
    // Built next to the output, so the final rename stays on one file system.
    const staging = mkdtempSync(`${output}-`);
    let manifest;
    try {
      assemble({
        release: snapshot,
        node,
        staging,
        platform,
        notices: { "urx-cli.txt": join(notices, "urx-cli.txt"), "urx-device.txt": join(notices, "urx-device.txt"), "node.txt": join(node, "LICENSE") },
      });
      manifest = manifestOf(staging, {
        release: BUILD_INFO.appVersion,
        app: { version: BUILD_INFO.appVersion, commit: BUILD_INFO.appCommit },
        common: { version: BUILD_INFO.commonVersion, commit: BUILD_INFO.commonCommit },
        runtime: { version: inputs.node.version, archive: recorded.file, sha256: recorded.sha256 },
      });
      writeFileSync(join(staging, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
      normalizeModes(staging, [`bin/urx${platform.exe}`, `runtime/node${platform.exe}`]);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    // Replaces a bundle at the output, or removes `staging` and throws.
    publishOutput(staging, output, { label: "bundle build", ownedFiles: bundleFiles });
    process.stderr.write(`bundle written to ${output} (${manifest.files.length} files)\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main(process.argv.slice(2));
}
