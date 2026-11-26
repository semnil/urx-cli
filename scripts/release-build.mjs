// The release build: the JavaScript and the addon are both built from the
// recorded commits, not from the working tree. The CLI commit HEAD names and
// the urx-device commit its gitlink pins are exported into a temporary
// worktree of their own, so edits to the working tree, the index, Git's
// change-display settings (assume-unchanged, skip-worktree), a sparse checkout
// and the build order cannot change what is built. Both builds run there with
// `--release` and a Cargo target directory of their own. The build claims
// dist-release/ before building, by creating it where nothing is, so two
// release builds never write into one output, and it stops when anything is
// already there rather than remove or replace it. The result is written into
// the claimed folder without replacing anything, its record last; a build
// that stops after claiming it leaves it without that record. The launcher is
// built from the same export into the same target directory and placed at
// dist-release/launcher/ for the bundle (scripts/build-bundle.mjs).

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, constants, copyFileSync, cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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

/**
 * Whether `path` is a file path as `filesUnder` gives one: relative, with `/`
 * between non-empty segments, none of them `.` or `..`, and no character that
 * Windows cannot hold in a name, so it names one file inside the directory it
 * is joined to on either platform.
 */
export function isRecordedPath(path) {
  return typeof path === "string" && path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".." && !/[\\:*?"<>|\u0000-\u001f]/.test(segment));
}

const isFileRecord = (file) => isRecordedPath(file?.path) && /^[0-9a-f]{64}$/.test(file?.sha256 ?? "") && Number.isSafeInteger(file?.size) && file.size >= 0;

/**
 * The files the record at `path` says a release build made there, with their
 * hashes, or null when it is not a release output: a record whose paths are
 * not each one file inside the output, or name one file twice (letter case
 * aside, as the file systems of both platforms compare names), is not one.
 */
export function releaseRecord(path) {
  try {
    const record = JSON.parse(readFileSync(join(path, RELEASE_FILES), "utf8"));
    if (record?.product !== "urx-cli" || record?.output !== "release" || !Array.isArray(record.files) || !record.files.every(isFileRecord)) return null;
    const names = new Set(record.files.map((file) => file.path.toLowerCase()));
    if (names.size !== record.files.length || names.has(RELEASE_FILES)) return null;
    return record.files;
  } catch {
    return null;
  }
}

/**
 * How the files under `root` differ from `files` (path, SHA-256, size): each
 * one missing or changed, by path. A recorded path is read only when it is a
 * regular file under `root` reached through no link, as `filesUnder` lists
 * them; anything else at that path is missing. A link anywhere under `root`
 * throws, as in `filesUnder`.
 */
export function recordedProblems(root, files) {
  const present = new Set(filesUnder(root));
  const problems = [];
  for (const file of files) {
    let bytes;
    try {
      if (!present.has(file.path)) throw new Error("not a regular file under the root");
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
 * Claims `output` for one build by creating it, empty, where nothing is. A
 * build never removes or replaces a previous output: when anything is at
 * `output`, an empty folder or a link included, it is left as it is and the
 * build stops, before building anything; the user removes it before building
 * again. The claimed folder is not removed afterwards either: a build that
 * stops after claiming it leaves it, without the record that marks a finished
 * output, for the user to remove.
 */
export function claimOutput(output, label = "release build") {
  try {
    mkdirSync(output);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error(`${output} already exists; the ${label} leaves it as it is, so remove it to build again`);
    throw new Error(`${output} could not be created`, { cause: error });
  }
}

/** Says, when a build stops after claiming `output`, that the folder stays and is the user's to remove. */
export function leftBehind(output, label = "release build") {
  return `${label}: ${output} is left as it is, without its record; remove it before building again`;
}

/**
 * Writes the files of `staging` into `output`, the empty folder `claimOutput`
 * made, without replacing anything: each folder is created where nothing is,
 * each file is copied where nothing is, and `last`, the record at the top of
 * the output that marks it finished, is copied after every other file. When
 * anything is in the way, it is left as it is and this throws, leaving
 * `output` without that record. Outside Windows, folders and files keep the
 * modes they have in `staging`.
 */
export function publishOutput(staging, output, { last, label = "release build" } = {}) {
  const keepMode = (from, to) => {
    if (process.platform !== "win32") chmodSync(to, statSync(from).mode & 0o7777);
  };
  const copyTree = (from, to) => {
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const source = join(from, entry.name);
      const target = join(to, entry.name);
      if (from === staging && entry.name === last) continue;
      if (entry.isDirectory()) {
        mkdirSync(target);
        copyTree(source, target);
        keepMode(source, target);
      } else if (entry.isFile()) {
        copyFileSync(source, target, constants.COPYFILE_EXCL);
      } else {
        throw new Error(`${source} is neither a regular file nor a folder`);
      }
    }
  };
  try {
    copyTree(staging, output);
    if (last !== undefined) copyFileSync(join(staging, last), join(output, last), constants.COPYFILE_EXCL);
    keepMode(staging, output);
  } catch (error) {
    throw new Error(`the ${label} could not write ${output} without replacing what is in it`, { cause: error });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = join(root, "dist-release");
  // Claimed before building anything, so nothing at the output is ever replaced.
  claimOutput(output);
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
    // Laid out in this run's scratch, then written into the claimed output, its record last.
    const staging = join(scratch, "output");
    cpSync(join(source, "dist"), staging, { recursive: true });
    const launcher = process.platform === "win32" ? "urx.exe" : "urx";
    cpSync(launcherArtifact(messages), join(staging, "launcher", launcher));
    copyCommonPackage(source, staging);
    markModuleFormat(staging);
    writeReleaseFiles(staging);
    publishOutput(staging, output, { last: RELEASE_FILES });
    process.stderr.write(`release build written to ${output}\n`);
  } catch (error) {
    process.stderr.write(`${leftBehind(output)}\n`);
    throw error;
  } finally {
    removeExport(root, source);
    rmSync(scratch, { recursive: true, force: true });
  }
}
