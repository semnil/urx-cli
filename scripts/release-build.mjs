// The release build: the JavaScript and the addon are both built from the
// recorded commits, not from the working tree. The CLI commit HEAD names and
// the urx-device commit its gitlink pins are exported into a temporary
// worktree of their own, so edits to the working tree, the index, Git's
// change-display settings (assume-unchanged, skip-worktree), a sparse checkout
// and the build order cannot change what is built. Both builds run there with
// `--release` and a Cargo folder of their own, which every cargo the build
// runs takes as both its target and its build directory, whatever Cargo's
// settings say, so that what each build compiles lies where the notices look
// for it. The build stops
// before building when anything is at dist-release/, and publishes its
// output with tools/output: complete, record included, in a work folder
// beside it, then renamed to dist-release/ only where nothing is, so the path
// shows nothing or the whole output and nothing there is removed or
// replaced. The launcher is built from the same export into the same target
// directory and placed at dist-release/launcher/ for the bundle
// (scripts/build-bundle.mjs), and on macOS the removal tool with it, at
// dist-release/maintenance/urx-uninstall (K20). Each program is built for
// this platform named explicitly (`--target`), and the licenses of the
// third-party Rust crates Cargo reports compiling into them
// (scripts/rust-notices.mjs) are written to
// dist-release/notices/rust-crates.txt.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMON_PATH, gitlinkOf } from "./release-source.mjs";
import { hostTriple, rustNotices } from "./rust-notices.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const environment = withoutGitLocation(process.env);

/**
 * Makes a build's scratch folder under the system's temporary folder and
 * returns its absolute path: Cargo and Git run in other folders than the
 * build, where a path relative to a relative temporary folder (TMPDIR=tmp)
 * would name another folder, which the build's clean-up does not remove.
 */
export function scratchFolder(prefix) {
  return mkdtempSync(resolve(tmpdir(), prefix));
}

/**
 * The environment of the cargo builds and `cargo metadata` of a release build:
 * `folder` as both the target directory and the build directory, over any
 * Cargo setting of either, so that every unit lies under it.
 */
export function cargoEnvironment(base, folder) {
  return { ...base, CARGO_TARGET_DIR: folder, CARGO_BUILD_BUILD_DIR: folder };
}
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

/**
 * The package files the release build writes beside the compiled modules:
 * Node reads the CLI's `.js` files as ES modules by the first, whatever lies
 * above the output, and finds the common package's entry points by the
 * second.
 */
export const PACKAGE_FILES = Object.freeze({ module: "package.json", common: "node_modules/@urx/device-control/package.json" });

/** Whether `bytes` are the package.json `markModuleFormat` writes. */
export const isModuleFormat = (bytes) => {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    return JSON.stringify(value) === JSON.stringify({ type: "module" });
  } catch {
    return false;
  }
};

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

/** The licenses of the third-party Rust crates in a release's programs, in its output. */
export const RUST_NOTICES = "notices/rust-crates.txt";

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
 * The executable `name` that `cargo build --message-format=json` reports
 * building, wherever the target in use puts it.
 */
export function cargoArtifact(messages, name) {
  let found;
  for (const line of messages.split("\n")) {
    if (!line.startsWith("{")) continue;
    const message = JSON.parse(line);
    if (message.reason === "compiler-artifact" && message.target?.name === name && message.target.kind?.includes("bin") && typeof message.executable === "string") {
      found = message.executable;
    }
  }
  if (found === undefined) throw new Error(`cargo reported building no ${name} executable`);
  return found;
}

/** The maintenance tools a release of this platform carries in its bundle: macOS's removal tool (K20). */
export const maintenanceTools = (platform = process.platform) => (platform === "darwin" ? ["urx-uninstall"] : []);

/** The `urx` executable that `cargo build --message-format=json` reports building. */
export const launcherArtifact = (messages) => cargoArtifact(messages, "urx");

/**
 * Builds `tools/output` in the checkout at `root` and returns its executable,
 * which publishes a build's output (see its main.rs). It is
 * build tooling, built from the working tree; nothing of it is in an output.
 * Cargo builds it in `folder`, the build's own Cargo folder
 * (`cargoEnvironment`), so the caller's Cargo folders take no part in the
 * build; without one (the tests), where the caller's settings say.
 */
export function outputTool(root, folder) {
  const messages = execFileSync("cargo", ["build", "--locked", "-p", "urx-output", "--message-format=json-render-diagnostics"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
    env: folder === undefined ? environment : cargoEnvironment(environment, folder),
  });
  return cargoArtifact(messages, "urx-output");
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
 * Runs `clean`, a build's removal of its own scratch or export, so that its
 * failure changes neither the build's result nor its error: a failure is a
 * warning naming `label` and what is left at `path`.
 */
export function cleanUp(label, path, clean, warn = (message) => process.stderr.write(`${message}\n`)) {
  try {
    clean();
  } catch (error) {
    warn(`${label}: ${path} could not be removed and is left there: ${error?.message ?? error}`);
  }
}

/**
 * Stops the build when anything is at `output`, an empty folder or a link
 * included: a build never removes or replaces a previous output, so the user
 * removes it before building again. Checked before building anything; the
 * rename that publishes the output checks again.
 */
export function requireNoOutput(output, label = "release build") {
  try {
    lstatSync(output);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw new Error(`${output} could not be examined`, { cause: error });
  }
  throw new Error(`${output} already exists; the ${label} leaves it as it is, so remove it to build again`);
}

/**
 * Publishes the files of `staging` as `output` with `tool` (`outputTool`):
 * written into a work folder beside `output` through the open folder, each
 * folder and file created where nothing is, folder modes kept outside
 * Windows, read back against `staging`, then `last`, the record at the top of
 * the output that marks it finished, and last the work folder renamed to
 * `output` only where nothing is. That rename is the moment the build
 * succeeds and the next stage can see the output. When anything is at
 * `output` by then, another build's or program's, it is left as it is and the
 * error does not ask to remove it; on any failure the output's path is
 * untouched and the work folder is left, without the record, under a name the
 * error gives.
 */
export function publishOutput(staging, output, { last, label = "release build", tool }) {
  const result = spawnSync(tool, ["publish", staging, output, ...(last === undefined ? [] : ["--last", last])], { encoding: "utf8" });
  if (result.error) throw result.error;
  const detail = result.stderr.trim().replace(/^urx-output: /, "");
  // It was not there when the build started (requireNoOutput): another build or program put it there meanwhile.
  if (result.status === 3) throw new Error(`${output} was put in place by another build or program while the ${label} ran; it is left as it is (${detail})`);
  if (result.status !== 0) throw new Error(`the ${label} could not publish ${output}: ${detail}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const output = join(root, "dist-release");
  // Checked before building anything; the rename that publishes the output checks again.
  requireNoOutput(output);
  const scratch = scratchFolder("urx-release-");
  const source = join(scratch, "source");
  // A Cargo folder of this run's own for every cargo it runs, the output tool's
  // included: a shared one would let a concurrent release build overwrite this
  // run's addon, and the caller's Cargo folders take no part in the build.
  const cargoBuild = cargoEnvironment(environment, join(scratch, "target"));
  try {
    const tool = outputTool(root, join(scratch, "target"));
    const { appCommit, commonCommit } = exportRelease(root, source);
    process.stderr.write(`release build of urx-cli ${appCommit} with urx-device ${commonCommit}\n`);
    const run = (args) =>
      execFileSync(process.execPath, args, {
        cwd: source,
        stdio: "inherit",
        env: cargoBuild,
      });
    // `pnpm build:release` runs this script; pnpm names its own JavaScript entry.
    const pnpm = process.env.npm_execpath;
    if (pnpm === undefined || !/pnpm/i.test(pnpm)) throw new Error("run the release build through `pnpm build:release`");
    run([pnpm, "install", "--frozen-lockfile", "--prefer-offline"]);
    run([pnpm, "exec", "tsc", "-p", "vendor/urx-device/packages/control/tsconfig.json"]);
    run([pnpm, "exec", "tsc", "-p", "tsconfig.json"]);
    run(["scripts/build-info.mjs", "--release"]);
    // Each program is built for this platform named explicitly, as napi builds the addon, so that what Cargo
    // compiles into it lies in the target's own folder and its report tells that from what runs on the host.
    const triple = hostTriple(source, environment);
    const nativeUnits = join(scratch, "native-units.jsonl");
    run(["scripts/build-native.mjs", "--release", "--units", nativeUnits]);
    // The installed command, from the same export and target directory (K22): the `urx` program only, not the
    // stand-in runtime the launcher's tests run.
    const messages = execFileSync("cargo", ["build", "--release", "--locked", "--target", triple, "-p", "urx-launcher", "--bin", "urx", "--message-format=json-render-diagnostics"], {
      cwd: source,
      encoding: "utf8",
      maxBuffer: 256 * 1024 * 1024,
      stdio: ["ignore", "pipe", "inherit"],
      env: cargoBuild,
    });
    // Laid out in this run's scratch, then published, its record last.
    const staging = join(scratch, "output");
    cpSync(join(source, "dist"), staging, { recursive: true });
    const launcher = process.platform === "win32" ? "urx.exe" : "urx";
    cpSync(launcherArtifact(messages), join(staging, "launcher", launcher));
    // The macOS removal tool, installed in the bundle's maintenance folder (K20);
    // Windows' uninstaller is Inno Setup's.
    const reports = [readFileSync(nativeUnits, "utf8"), messages];
    for (const tool of maintenanceTools()) {
      const built = execFileSync("cargo", ["build", "--release", "--locked", "--target", triple, "-p", "urx-maintenance", "--bin", tool, "--message-format=json-render-diagnostics"], {
        cwd: source,
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "inherit"],
        env: cargoBuild,
      });
      cpSync(cargoArtifact(built, tool), join(staging, "maintenance", tool));
      reports.push(built);
    }
    copyCommonPackage(source, staging);
    markModuleFormat(staging);
    // The licenses of the third-party Rust crates those builds compiled into the programs.
    mkdirSync(join(staging, "notices"), { recursive: true });
    writeFileSync(join(staging, RUST_NOTICES), rustNotices(source, cargoBuild, triple, reports));
    writeReleaseFiles(staging);
    publishOutput(staging, output, { last: RELEASE_FILES, tool });
    process.stderr.write(`release build written to ${output}\n`);
  } finally {
    // The output is published or not by now; removing the scratch changes neither.
    cleanUp("release build", source, () => removeExport(root, source));
    cleanUp("release build", scratch, () => rmSync(scratch, { recursive: true, force: true }));
  }
}
