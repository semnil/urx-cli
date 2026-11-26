// The release build: the JavaScript and the addon are both built from the
// recorded commits, not from the working tree. The CLI commit HEAD names and
// the urx-device commit its gitlink pins are exported into a temporary
// worktree of their own, so edits to the working tree, the index, Git's
// change-display settings (assume-unchanged, skip-worktree), a sparse checkout
// and the build order cannot change what is built. Both builds run there with
// `--release` and a Cargo target directory of their own, and the result
// replaces dist-release/ as one directory, so concurrent release builds never
// mix their halves.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { COMMON_PATH, gitlinkOf } from "./release-source.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const environment = withoutGitLocation(process.env);

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
 * Makes `staging` the directory at `output`: the old output is removed and
 * `staging` is renamed into its place. When another release has put its own
 * output there in between, the rename fails and this release fails, so
 * `output` always holds one release's complete result.
 */
export function publishOutput(staging, output, rename = renameSync) {
  rmSync(output, { recursive: true, force: true });
  try {
    rename(staging, output);
  } catch (error) {
    rmSync(staging, { recursive: true, force: true });
    throw new Error(`another release build replaced ${output} while this one finished`, { cause: error });
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
    run([pnpm, "exec", "tsc", "-p", "tsconfig.json"]);
    run(["scripts/build-info.mjs", "--release"]);
    run(["scripts/build-native.mjs", "--release"]);
    const output = join(root, "dist-release");
    // Copied next to the output first, so the final rename stays on one file system.
    const staging = mkdtempSync(join(root, "dist-release-"));
    rmSync(staging, { recursive: true, force: true });
    cpSync(join(source, "dist"), staging, { recursive: true });
    publishOutput(staging, output);
    process.stderr.write(`release build written to ${output}\n`);
  } finally {
    removeExport(root, source);
    rmSync(scratch, { recursive: true, force: true });
  }
}
