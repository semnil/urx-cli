// Checks an installed bundle's layout and contents away from the checkout
// (K18, K38): the release manifest lists exactly the bundle's files with
// their hashes; a copy under a directory that declares CommonJS runs the CLI
// with the bundled Node, opens the addon from the bundle's `native` and loads
// the common package from the bundle's own `app`; and the launcher, run
// outside an installation, starts nothing and exits 1 with one line.
//
// Usage: node scripts/check-bundle.mjs [dist-bundle]

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { filesUnder, platformOf, sha256 } from "./build-bundle.mjs";

const bundle = resolve(process.argv[2] ?? "dist-bundle");
const platform = platformOf();
const fail = (message) => {
  throw new Error(`bundle check: ${message}`);
};

// The manifest lists every file but itself, each with its hash and size, and nothing else.
const manifest = JSON.parse(readFileSync(join(bundle, "release-manifest.json"), "utf8"));
if (manifest.product !== "urx-cli" || manifest.format !== 1) fail("the manifest is not a urx-cli format 1 manifest");
const listed = manifest.files.map((file) => file.path);
const present = filesUnder(bundle).filter((path) => path !== "release-manifest.json");
if (JSON.stringify(listed) !== JSON.stringify(present)) fail("the manifest does not list exactly the bundle's files");
for (const file of manifest.files) {
  const bytes = readFileSync(join(bundle, ...file.path.split("/")));
  if (sha256(bytes) !== file.sha256 || bytes.length !== file.size) fail(`${file.path} does not match the manifest`);
}
for (const path of [`bin/urx${platform.exe}`, `runtime/node${platform.exe}`, "app/main.js", "native/urx-native.node"]) {
  if (!listed.includes(path)) fail(`the bundle has no ${path}`);
}
if (listed.some((path) => path.startsWith("app/") && path.endsWith(".node"))) fail("the addon is inside app");

const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "urx-bundle-check-")));
try {
  writeFileSync(join(scratch, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
  const copy = join(scratch, "tools", "urx cli");
  cpSync(bundle, copy, { recursive: true });
  const runtime = join(copy, "runtime", `node${platform.exe}`);
  // No NODE_ variable from this process reaches the bundled Node, removed as the launcher removes
  // them (K24): in any case on Windows, whose variable names ignore case, and exactly elsewhere.
  const inherited = (name) => (process.platform === "win32" ? name.toUpperCase() : name).startsWith("NODE_");
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => !inherited(name)));
  const node = (args) => execFileSync(runtime, args, { cwd: scratch, encoding: "utf8", env });
  const version = node(["--version"]).trim();
  if (version !== `v${manifest.runtime.version}`) fail(`the bundled Node is ${version}, not v${manifest.runtime.version}`);
  node([join(copy, "app", "main.js"), "--help"]);
  process.stdout.write(node([join(copy, "app", "main.js"), "--version"]));
  const url = (path) => JSON.stringify(pathToFileURL(join(copy, path)).href);
  node([
    "--input-type=module",
    "-e",
    `
    import { createRequire } from "node:module";
    const addon = await import(${url("app/native/addon.js")});
    const build = await import(${url("app/build-info.js")});
    if (addon.ADDON_URL.href !== ${url("native/urx-native.node")}) throw new Error("the addon is looked for at " + addon.ADDON_URL.href);
    const opened = addon.openAddon(addon.expectedIdentity(build.BUILD_INFO));
    if (!opened.ok) throw new Error("the addon was refused: " + opened.problem);
    const common = createRequire(${url("app/native/device.js")}).resolve("@urx/device-control/operations");
    if (!common.startsWith(${JSON.stringify(join(copy, "app"))})) throw new Error("the common package was loaded from " + common);
    `,
  ]);
  // Outside an installation the launcher starts nothing: exit 1, empty stdout, one line on stderr.
  const launched = spawnSync(join(copy, "bin", `urx${platform.exe}`), ["--version"], { cwd: scratch, encoding: "utf8" });
  if (launched.status !== 1 || launched.stdout !== "" || launched.stderr.split("\n").filter(Boolean).length !== 1) {
    fail(`the launcher outside an installation exited ${launched.status} with ${JSON.stringify(launched.stdout)} and ${JSON.stringify(launched.stderr)}`);
  }
  process.stdout.write("the bundle is complete and runs on its own\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
