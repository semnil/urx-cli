// Writes dist/build-info.js after `tsc`: the CLI version from package.json, the
// urx-device version from vendor/urx-device/package.json, and both full commits
// from the checkout. A value that cannot be read is "unknown", never a guess.

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { requireReleaseSourceIfAsked } from "./release-source.mjs";
import { commitOf, revParse, versionOf } from "./source-info.mjs";

export { commitOf, revParse, versionOf, withoutGitLocation } from "./source-info.mjs";

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

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  // `--release` refuses a checkout that is not exactly the recorded source.
  requireReleaseSourceIfAsked(fileURLToPath(root));
  const common = new URL("vendor/urx-device/", root);
  const info = {
    appVersion: versionOf(readOrNull(new URL("package.json", root))),
    appCommit: commitOf(revParse(fileURLToPath(root))),
    commonVersion: versionOf(readOrNull(new URL("package.json", common))),
    commonCommit: commitOf(revParse(fileURLToPath(common))),
  };
  writeFileSync(new URL("dist/build-info.js", root), buildInfoModule(info));
}
