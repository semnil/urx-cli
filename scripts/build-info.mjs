// Writes dist/build-info.js after `tsc`: the CLI version from package.json, the
// urx-device version from vendor/urx-device/package.json, and both full commits
// from the checkout. A value that cannot be read is "unknown", never a guess.

import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

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

/** The module text that replaces the compiled src/build-info.ts. */
export function buildInfoModule(info) {
  const fields = ["appVersion", "appCommit", "commonVersion", "commonCommit"];
  const values = Object.fromEntries(fields.map((field) => [field, typeof info[field] === "string" ? info[field] : "unknown"]));
  return `export const BUILD_INFO = Object.freeze(${JSON.stringify(values)});\n`;
}

const readOrNull = (url) => {
  try {
    return readFileSync(url, "utf8");
  } catch {
    return null;
  }
};

/**
 * The HEAD commit of the repository whose top level is `directory`, or null. A
 * directory inside another repository (an uninitialized submodule, an unpacked
 * archive) gives null rather than the enclosing repository's commit.
 */
export const revParse = (directory) => {
  try {
    const [topLevel, head] = execFileSync("git", ["-C", directory, "rev-parse", "--show-toplevel", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).split("\n");
    return realpathSync(topLevel) === realpathSync(directory) ? head : null;
  } catch {
    return null;
  }
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const common = new URL("vendor/urx-device/", root);
  const info = {
    appVersion: versionOf(readOrNull(new URL("package.json", root))),
    appCommit: commitOf(revParse(fileURLToPath(root))),
    commonVersion: versionOf(readOrNull(new URL("package.json", common))),
    commonCommit: commitOf(revParse(fileURLToPath(common))),
  };
  writeFileSync(new URL("dist/build-info.js", root), buildInfoModule(info));
}
