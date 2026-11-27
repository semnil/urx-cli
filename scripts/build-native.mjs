// Builds the Node-API addon into dist/native/urx-native.node with the pinned
// napi CLI and a locked Cargo build. The urx-device version and commit the
// addon embeds are read here, the same way scripts/build-info.mjs reads them
// for the JavaScript, so both sides describe one checkout. With
// `--units <path>`, Cargo's report of every unit it compiles
// (`--message-format=json-render-diagnostics`, which napi passes on) is
// written to <path>, one JSON message a line, and napi's other output is
// shown as usual; the release build reads it for the Rust notices.
//
// Usage: node scripts/build-native.mjs [--release] [--units <path>]

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
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

const argv = process.argv.slice(2);
const unitsAt = argv.indexOf("--units");
const units = unitsAt === -1 ? undefined : argv[unitsAt + 1];
if (unitsAt !== -1 && (units === undefined || units.startsWith("--"))) throw new Error("usage: node scripts/build-native.mjs [--release] [--units <path>]");
const args = [
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
  ...(units === undefined ? [] : ["--message-format=json-render-diagnostics"]),
];
if (units === undefined) {
  execFileSync(process.execPath, args, { cwd: root, env, stdio: "inherit" });
} else {
  const output = execFileSync(process.execPath, args, { cwd: root, env, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["inherit", "pipe", "inherit"] });
  const lines = output.split(/\r?\n/);
  const messages = lines.filter((line) => line.startsWith("{"));
  const others = lines.filter((line) => !line.startsWith("{") && line !== "");
  if (others.length > 0) process.stdout.write(`${others.join("\n")}\n`);
  writeFileSync(units, `${messages.join("\n")}\n`);
}
