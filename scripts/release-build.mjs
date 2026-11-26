// The release build: the JavaScript and the addon are both built from the
// recorded commits, not from the working tree. The CLI commit HEAD names and
// the urx-device commit its gitlink pins are exported into a temporary
// worktree of their own, so edits to the working tree, the index, Git's
// change-display settings (assume-unchanged, skip-worktree), a sparse checkout
// and the build order cannot change what is built. Both builds run there with
// `--release` and a Cargo target directory of their own, and the result
// replaces dist-release/ as one directory, so concurrent release builds never
// mix their halves. The launcher is built from the same export into the same
// target directory and placed at dist-release/launcher/ for the bundle
// (scripts/build-bundle.mjs).

import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cpSync, lstatSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMON_PATH, gitlinkOf } from "./release-source.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const environment = withoutGitLocation(process.env);
/** The common TypeScript package inside the export. */
const CONTROL_PATH = join(COMMON_PATH, "packages", "control");

function git(directory, args, extra = {}) {
  return execFileSync("git", ["-C", directory, ...args], { encoding: "utf8", env: environment, stdio: ["ignore", "pipe", "pipe"], ...extra });
}

/**
 * Exports HEAD of `root`, with vendor/urx-device at the commit HEAD pins, into
 * a new detached worktree at `destination`. The submodule is fetched from the
 * local submodule repository, never from a network URL. Returns both commits.
 */
export function exportRelease(root, destination) {
  const appCommit = git(root, ["rev-parse", "HEAD"]).trim();
  const commonCommit = gitlinkOf(git(root, ["ls-tree", "HEAD", COMMON_PATH]));
  if (commonCommit === null) throw new Error(`HEAD pins no commit for ${COMMON_PATH}`);
  // A new worktree inherits the caller's sparse checkout; checking out with it
  // turned off for that one command populates every tracked file.
  git(root, ["worktree", "add", "--detach", "--no-checkout", "--quiet", destination, appCommit]);
  git(destination, ["-c", "core.sparseCheckout=false", "checkout", "--quiet", "--force", "--detach", appCommit]);
  const localCommon = git(join(root, COMMON_PATH), ["rev-parse", "--absolute-git-dir"]).trim();
  git(destination, [
    "-c",
    "protocol.file.allow=always",
    "-c",
    `submodule.${COMMON_PATH}.url=${localCommon}`,
    "submodule",
    "update",
    "--init",
    "--checkout",
    "--quiet",
    "--",
    COMMON_PATH,
  ]);
  return { appCommit, commonCommit };
}

/**
 * Copies the compiled common package from the export into the output's own
 * node_modules, as real files: the output then loads the urx-device code of
 * this release wherever it is placed, without the checkout or a symlink.
 */
export function copyCommonPackage(source, output) {
  const from = join(source, CONTROL_PATH);
  const to = join(output, "node_modules", "@urx", "device-control");
  cpSync(join(from, "package.json"), join(to, "package.json"));
  cpSync(join(from, "dist"), join(to, "dist"), { recursive: true, dereference: true });
}

/**
 * Gives the output a package.json of its own that says its `.js` files are ES
 * modules, so a `"type": "commonjs"` in a directory above it cannot change how
 * Node reads them.
 */
export function markModuleFormat(output) {
  writeFileSync(join(output, "package.json"), MODULE_FORMAT);
}

const MODULE_FORMAT = `${JSON.stringify({ type: "module" })}\n`;

/** Every regular file under `root`, as sorted relative paths with `/` separators; a link or another kind of file is refused. */
export function filesUnder(root) {
  const found = [];
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`the output may hold no link: ${relative(root, path)}`);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) found.push(relative(root, path).split(sep).join("/"));
      else throw new Error(`the output may hold regular files only: ${relative(root, path)}`);
    }
  };
  walk(root);
  return found.sort();
}

export const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** The record of the files a release build made in its output, each with its SHA-256 and size, kept in that output. */
export const RELEASE_FILES = "release-files.json";

/** Each file under `root` but `excluded`, with its SHA-256 and size. */
export function describeFiles(root, excluded) {
  return filesUnder(root)
    .filter((path) => path !== excluded)
    .map((path) => {
      const bytes = readFileSync(join(root, ...path.split("/")));
      return { path, sha256: sha256(bytes), size: bytes.length };
    });
}

/** Records in `output` the files it holds, as the files this release build made there. */
export function writeReleaseFiles(output) {
  const files = describeFiles(output, RELEASE_FILES);
  writeFileSync(join(output, RELEASE_FILES), `${JSON.stringify({ product: "urx-cli", output: "release", files }, null, 2)}\n`);
}

const isFileRecord = (file) =>
  typeof file?.path === "string" && /^[0-9a-f]{64}$/.test(file?.sha256 ?? "") && Number.isSafeInteger(file?.size) && file.size >= 0;

/** The files the record at `path` says a release build made there, with their hashes, or null when it is not a release output. */
export function releaseRecord(path) {
  try {
    const record = JSON.parse(readFileSync(join(path, RELEASE_FILES), "utf8"));
    if (record?.product !== "urx-cli" || record?.output !== "release" || !Array.isArray(record.files) || !record.files.every(isFileRecord)) return null;
    return record.files;
  } catch {
    return null;
  }
}

/** The files a release build made in the output at `path`, its record included, or null when it is not a release output. */
export function releaseOutputFiles(path) {
  const files = releaseRecord(path);
  return files === null ? null : [...files.map((file) => file.path), RELEASE_FILES];
}

/** How the files under `root` differ from `files` (path, SHA-256, size): each one missing or changed, by path. */
export function recordedProblems(root, files) {
  const problems = [];
  for (const file of files) {
    let bytes;
    try {
      bytes = readFileSync(join(root, ...file.path.split("/")));
    } catch {
      problems.push(`${file.path} is missing`);
      continue;
    }
    if (bytes.length !== file.size || sha256(bytes) !== file.sha256) problems.push(`${file.path} is not as it was built`);
  }
  return problems;
}

/**
 * The `urx` executable that `cargo build --message-format=json` reports
 * building, wherever the target in use puts it.
 */
export function launcherArtifact(messages) {
  let found;
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.target?.name === "urx" && message.target.kind?.includes("bin") && typeof message.executable === "string") {
      found = message.executable;
    }
  }
  if (found === undefined) throw new Error("cargo reported building no urx executable");
  return found;
}

/**
 * Removes a worktree made by `exportRelease`, including one it left half made.
 * Only that worktree's registration is touched: a repository-wide prune would
 * also drop another worktree whose directory is out of sight for a while.
 */
export function removeExport(root, destination) {
  try {
    git(root, ["worktree", "remove", "--force", "--force", destination]);
  } catch {
    // Not registered (the export failed before creating it) or already gone.
  }
  rmSync(destination, { recursive: true, force: true });
}

/**
 * Makes `staging` the directory at `output`, one directory rename at a time:
 *
 * 1. the previous output is renamed aside, whole, to `<output>-previous-<id>`;
 * 2. `staging` is renamed into its place;
 * 3. the set-aside output is removed.
 *
 * When step 2 fails (another build put its output there in between, or the
 * rename itself failed), the previous output is renamed back, so `output`
 * always holds one build's complete result, never a partly removed one. An
 * interruption between the steps leaves the previous output complete under its
 * set-aside name. A failed step 3 only warns: the new output is complete, and
 * whatever could not be removed stays under the set-aside name. Warnings start
 * with `label`, the build that publishes (the release build or the bundle build).
 *
 * `ownedFiles` names the files a previous output of this build made, or
 * returns null for something that is not one. Something at `output` that is
 * not one, a link included, is left as it is: `staging` is removed and
 * nothing is published. In step 3 the set-aside output is removed only when it
 * holds exactly the files it names; one that holds anything else, a file added
 * to it or a directory that took its place in between, is kept under its
 * set-aside name with a warning.
 */
export function publishOutput(
  staging,
  output,
  {
    rename = renameSync,
    remove = (path) => rmSync(path, { recursive: true, force: true }),
    warn = (message) => process.stderr.write(`${message}\n`),
    label = "release build",
    ownedFiles,
    list = filesUnder,
  } = {},
) {
  if (typeof ownedFiles !== "function") throw new Error("publishOutput needs ownedFiles");
  const abandon = (error) => {
    try {
      remove(staging);
    } catch {
      warn(`${label}: the new output could not be removed from ${staging}`);
    }
    throw error;
  };
  let existing;
  try {
    existing = lstatSync(output);
  } catch (error) {
    if (error?.code !== "ENOENT") abandon(new Error(`${output} could not be examined`, { cause: error }));
  }
  if (existing !== undefined && (!existing.isDirectory() || ownedFiles(output) === null)) {
    abandon(new Error(`${output} is not a ${label}'s output, so it is left as it is`));
  }
  const aside = `${output}-previous-${process.pid}-${randomUUID()}`;
  let setAside = false;
  try {
    rename(output, aside);
    setAside = true;
  } catch (error) {
    if (error?.code !== "ENOENT") abandon(new Error(`the previous ${output} could not be set aside`, { cause: error }));
  }
  try {
    rename(staging, output);
  } catch (error) {
    // Restoring comes first, so a failing cleanup cannot leave `output` empty.
    if (setAside) {
      try {
        rename(aside, output);
      } catch {
        warn(`${label}: the previous output is kept at ${aside}`);
      }
    }
    try {
      remove(staging);
    } catch {
      warn(`${label}: the new output could not be removed from ${staging}`);
    }
    throw new Error(`${output} could not be replaced; another ${label} may have replaced it first`, { cause: error });
  }
  if (setAside) {
    const made = ownedFiles(aside);
    let held = null;
    try {
      held = list(aside);
    } catch {
      // A link or a special file: not something this build made.
    }
    if (made === null || held === null || JSON.stringify([...made].sort()) !== JSON.stringify(held)) {
      warn(`${label}: the previous output held files it had not made, so it is kept at ${aside}`);
      return;
    }
    try {
      remove(aside);
    } catch {
      warn(`${label}: the previous output could not be removed from ${aside}`);
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const scratch = mkdtempSync(join(tmpdir(), "urx-release-"));
  const source = join(scratch, "source");
  try {
    const { appCommit, commonCommit } = exportRelease(root, source);
    process.stderr.write(`release build of urx-cli ${appCommit} with urx-device ${commonCommit}\n`);
    const run = (args) =>
      execFileSync(process.execPath, args, {
        cwd: source,
        stdio: "inherit",
        // A target directory of this run's own: a shared one would let a
        // concurrent release build overwrite this run's addon.
        env: { ...environment, CARGO_TARGET_DIR: join(scratch, "target") },
      });
    // `pnpm build:release` runs this script; pnpm names its own JavaScript entry.
    const pnpm = process.env.npm_execpath;
    if (pnpm === undefined || !/pnpm/i.test(pnpm)) throw new Error("run the release build through `pnpm build:release`");
    run([pnpm, "install", "--frozen-lockfile", "--prefer-offline"]);
    run([pnpm, "exec", "tsc", "-p", "vendor/urx-device/packages/control/tsconfig.json"]);
    run([pnpm, "exec", "tsc", "-p", "tsconfig.json"]);
    run(["scripts/build-info.mjs", "--release"]);
    run(["scripts/build-native.mjs", "--release"]);
    // The installed command, from the same export and target directory (K22).
    const messages = execFileSync("cargo", ["build", "--release", "--locked", "-p", "urx-launcher", "--message-format=json-render-diagnostics"], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...environment, CARGO_TARGET_DIR: join(scratch, "target") },
    });
    const output = join(root, "dist-release");
    // Copied next to the output first, so the final rename stays on one file system.
    const staging = mkdtempSync(join(root, "dist-release-"));
    try {
      rmSync(staging, { recursive: true, force: true });
      cpSync(join(source, "dist"), staging, { recursive: true });
      const launcher = process.platform === "win32" ? "urx.exe" : "urx";
      cpSync(launcherArtifact(messages), join(staging, "launcher", launcher));
      copyCommonPackage(source, staging);
      markModuleFormat(staging);
      writeReleaseFiles(staging);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    // Replaces the output, or removes `staging` and throws.
    publishOutput(staging, output, { ownedFiles: releaseOutputFiles });
    process.stderr.write(`release build written to ${output}\n`);
  } finally {
    removeExport(root, source);
    rmSync(scratch, { recursive: true, force: true });
  }
}
