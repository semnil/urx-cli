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
import { randomUUID } from "node:crypto";
import { cpSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  writeFileSync(join(output, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
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
 */
export function publishOutput(
  staging,
  output,
  { rename = renameSync, remove = (path) => rmSync(path, { recursive: true, force: true }), warn = (message) => process.stderr.write(`${message}\n`), label = "release build" } = {},
) {
  const aside = `${output}-previous-${process.pid}-${randomUUID()}`;
  let setAside = false;
  try {
    rename(output, aside);
    setAside = true;
  } catch (error) {
    if (error?.code !== "ENOENT") {
      try {
        remove(staging);
      } catch {
        warn(`${label}: the new output could not be removed from ${staging}`);
      }
      throw new Error(`the previous ${output} could not be set aside`, { cause: error });
    }
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
    execFileSync("cargo", ["build", "--release", "--locked", "-p", "urx-launcher"], {
      cwd: source,
      stdio: "inherit",
      env: { ...environment, CARGO_TARGET_DIR: join(scratch, "target") },
    });
    const output = join(root, "dist-release");
    // Copied next to the output first, so the final rename stays on one file system.
    const staging = mkdtempSync(join(root, "dist-release-"));
    try {
      rmSync(staging, { recursive: true, force: true });
      cpSync(join(source, "dist"), staging, { recursive: true });
      const launcher = process.platform === "win32" ? "urx.exe" : "urx";
      cpSync(join(scratch, "target", "release", launcher), join(staging, "launcher", launcher));
      copyCommonPackage(source, staging);
      markModuleFormat(staging);
    } catch (error) {
      rmSync(staging, { recursive: true, force: true });
      throw error;
    }
    // Replaces the output, or removes `staging` and throws.
    publishOutput(staging, output);
    process.stderr.write(`release build written to ${output}\n`);
  } finally {
    removeExport(root, source);
    rmSync(scratch, { recursive: true, force: true });
  }
}
