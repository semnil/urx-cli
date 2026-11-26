// The source check of a release build (V6): the CLI and the urx-device it
// embeds must be exactly what this repository records. vendor/urx-device must
// be at the commit the gitlink pins, neither repository may carry staged or
// unstaged changes to tracked files, and both versions must be known. Both
// release builds (the JavaScript and the addon) run it, so neither half can be
// built from other sources, whatever the build order.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { commitOf, revParse, versionOf, withoutGitLocation } from "./source-info.mjs";

export const COMMON_PATH = "vendor/urx-device";

/** Runs git in `directory` and returns its output, or null when git fails. */
function git(directory, args) {
  try {
    return execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: withoutGitLocation(process.env),
    });
  } catch {
    return null;
  }
}

/** The commit `HEAD` records for the submodule at `path`, from `git ls-tree` output. */
export function gitlinkOf(lsTreeOutput, path = COMMON_PATH) {
  const match = /^160000 commit ([0-9a-f]{40})\t(.+)$/m.exec(lsTreeOutput ?? "");
  return match !== null && match[2] === path ? match[1] : null;
}

const readOrNull = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

/** The reasons the checkout at `root` is not a release source; empty when it is. */
export function releaseSourceProblems(root, run = git) {
  const common = join(root, COMMON_PATH);
  const problems = [];
  const pinned = gitlinkOf(run(root, ["ls-tree", "HEAD", COMMON_PATH]));
  const checkedOut = commitOf(revParse(common));
  if (pinned === null) problems.push(`the commit that HEAD pins for ${COMMON_PATH} cannot be read`);
  else if (checkedOut !== pinned) problems.push(`${COMMON_PATH} is not at the commit that HEAD pins`);
  // The submodule's own commit is checked above; here, only the CLI's files.
  const appChanges = run(root, ["status", "--porcelain=v1", "--untracked-files=no", "--ignore-submodules=all"]);
  if (appChanges === null) problems.push("the CLI's changes cannot be read");
  else if (appChanges.trim() !== "") problems.push("the CLI has staged or unstaged changes to tracked files");
  const commonChanges = run(common, ["status", "--porcelain=v1", "--untracked-files=no"]);
  if (commonChanges === null) problems.push(`the changes in ${COMMON_PATH} cannot be read`);
  else if (commonChanges.trim() !== "") problems.push(`${COMMON_PATH} has staged or unstaged changes to tracked files`);
  // `git ls-files -v` tags an assume-unchanged entry in lowercase and a skip-worktree entry `S`.
  for (const [directory, name] of [
    [root, "the CLI"],
    [common, COMMON_PATH],
  ]) {
    const entries = run(directory, ["ls-files", "-v"]);
    if (entries === null) problems.push(`the index of ${name} cannot be read`);
    else if (/^(?:[a-z]|S) /m.test(entries)) problems.push(`${name} has index entries that Git does not compare with the files`);
  }
  if (versionOf(readOrNull(join(root, "package.json"))) === "unknown") problems.push("the CLI version is unknown");
  if (versionOf(readOrNull(join(common, "package.json"))) === "unknown") problems.push("the urx-device version is unknown");
  return problems;
}

/** Ends the process when `--release` is among the arguments and the source is not a release source. */
export function requireReleaseSourceIfAsked(root, argv = process.argv.slice(2)) {
  if (!argv.includes("--release")) return;
  const problems = releaseSourceProblems(root);
  for (const problem of problems) process.stderr.write(`release source: ${problem}\n`);
  if (problems.length > 0) process.exit(1);
}
