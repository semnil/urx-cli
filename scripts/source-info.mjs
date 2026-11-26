// Reading a checkout's versions and commits: the CLI's build information and
// the addon's identity are both made from these functions, so the two halves of
// a build describe their sources the same way. A value that cannot be read is
// "unknown", never a guess.

import { execFileSync } from "node:child_process";
import { realpathSync } from "node:fs";

const COMMIT = /^[0-9a-f]{40}$/;
// The SemVer 2.0.0 grammar (semver.org), including pre-release and build metadata.
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

/** The version field of a package.json text, or "unknown". */
export function versionOf(packageJsonText) {
  try {
    const { version } = JSON.parse(packageJsonText);
    return typeof version === "string" && VERSION.test(version) ? version : "unknown";
  } catch {
    return "unknown";
  }
}

/** A full commit from `git rev-parse HEAD` output, or "unknown". */
export function commitOf(revParseOutput) {
  const commit = typeof revParseOutput === "string" ? revParseOutput.trim() : "";
  return COMMIT.test(commit) ? commit : "unknown";
}


/**
 * The environment without the variables that point git at a particular
 * repository (GIT_DIR, GIT_WORK_TREE and the rest of `git rev-parse
 * --local-env-vars`), so that git finds the repository from the directory alone,
 * as it does when a build runs from a hook. Configuration variables (GIT_CONFIG*)
 * stay, since they carry settings such as safe.directory.
 */
export function withoutGitLocation(environment, localVariables = gitLocalVariables(environment)) {
  // Windows treats environment variable names case-insensitively, so `Git_Dir` is GIT_DIR there.
  const drop = new Set(localVariables.filter((name) => !name.startsWith("GIT_CONFIG")).map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !drop.has(name.toUpperCase())));
}

/** The variables git treats as local to one repository. */
function gitLocalVariables(environment) {
  const output = execFileSync("git", ["rev-parse", "--local-env-vars"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], env: environment });
  return output.split(/\r?\n/).filter((name) => name.length > 0);
}

/**
 * The HEAD commit of the repository whose top level is `directory`, or null. A
 * directory inside another repository (an uninitialized submodule, an unpacked
 * archive) gives null rather than the enclosing repository's commit.
 */
export const revParse = (directory, environment = process.env) => {
  try {
    const [topLevel, head] = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      env: withoutGitLocation(environment),
    }).split("\n");
    // The native form resolves Windows short (8.3) names, which git does not print.
    return realpathSync.native(topLevel) === realpathSync.native(directory) ? head : null;
  } catch {
    return null;
  }
};
