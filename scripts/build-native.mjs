// Builds the Node-API addon into dist/native/urx-native.node with the pinned
// napi CLI and a locked Cargo build. The urx-device version and commit the
// addon embeds are read here, the same way scripts/build-info.mjs reads them
// for the JavaScript, so both sides describe one checkout.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { commitOf, revParse, versionOf } from "./source-info.mjs";
import { requireReleaseSourceIfAsked } from "./release-source.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const common = join(root, "vendor", "urx-device");
// `--release` refuses a checkout that is not exactly the recorded source.
requireReleaseSourceIfAsked(root);

/** The JavaScript entry of the pinned napi CLI, run with this Node rather than through a shell shim. */
function napiCli() {
  const require = createRequire(import.meta.url);
  const manifestPath = require.resolve("@napi-rs/cli/package.json");
  const { bin } = JSON.parse(readFileSync(manifestPath, "utf8"));
  return join(dirname(manifestPath), typeof bin === "string" ? bin : bin.napi);
}

const read = (path) => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
};

const env = {
  ...process.env,
  URX_COMMON_VERSION: versionOf(read(join(common, "package.json"))),
  URX_COMMON_COMMIT: commitOf(revParse(common)),
};

execFileSync(
  process.execPath,
  [
    napiCli(),
    "build",
    "--release",
    "--manifest-path",
    join(root, "native", "Cargo.toml"),
    "--package-json-path",
    join(root, "package.json"),
    "--output-dir",
    join(root, "dist", "native"),
    "--",
    "--locked",
  ],
  { cwd: root, env, stdio: "inherit" },
);
