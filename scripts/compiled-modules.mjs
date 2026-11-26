// The modules a release's commits compile to, for the release output and
// bundle checks: one `.js` file for every `.ts` file under the CLI's `src` and
// under the common package's `packages/control/src`, tests and declarations
// left out, as the two tsconfig.json files include and exclude them. A copy
// is checked to hold exactly these, so one that lacks a module a command
// loads, on demand or not, fails however the code around its import is
// written; the checks then import every one of them.

import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { COMMON_PATH } from "./release-source.mjs";
import { withoutGitLocation } from "./source-info.mjs";

const environment = withoutGitLocation(process.env);

/** The compiled module paths of the `.ts` sources under `directory` at `commit` in the repository at `repository`. */
function modulesOf(repository, commit, directory) {
  if (!/^[0-9a-f]{40}$/.test(commit ?? "")) throw new Error(`the build information names no commit for ${directory}`);
  const listed = execFileSync("git", ["-C", repository, "ls-tree", "-r", "--name-only", commit, "--", directory], {
    encoding: "utf8",
    env: environment,
    stdio: ["ignore", "pipe", "pipe"],
  });
  return listed
    .split("\n")
    .filter((path) => path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith(".d.ts"))
    .map((path) => `${path.slice(directory.length + 1, -".ts".length)}.js`)
    .sort();
}

/**
 * The modules of the CLI (relative to the release output) and of the common
 * package (relative to its `dist`) that the commits in `build` compile to.
 */
export function compiledModules(root, build) {
  return {
    cli: modulesOf(root, build.appCommit, "src"),
    common: modulesOf(join(root, COMMON_PATH), build.commonCommit, "packages/control/src"),
  };
}

/** What `present` lacks of `expected` and holds beyond it, both sorted. */
export function moduleDifference(present, expected) {
  return {
    missing: expected.filter((path) => !present.includes(path)).sort(),
    extra: present.filter((path) => !expected.includes(path)).sort(),
  };
}
