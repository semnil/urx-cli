// Checks an installed bundle's layout and contents away from the checkout
// (K18, K38): the release manifest lists exactly the bundle's files with
// their hashes; on macOS its directories and executables are 0755 and its
// other files 0644; a copy under a directory that declares CommonJS runs the
// CLI with the bundled Node, loads every one of its modules, opens the addon
// from the bundle's `native` and loads the common package from the bundle's
// own `app`; and the launcher, run away from any bundle, starts nothing and
// exits 1 with one line, whatever is installed on this machine.
//
// Usage: node scripts/check-bundle.mjs [dist-bundle]

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
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

// The modes it is distributed with: anyone can reach and run the launcher and the runtime, and only the owner can write.
if (process.platform !== "win32") {
  const executables = [`bin/urx${platform.exe}`, `runtime/node${platform.exe}`];
  const walk = (directory) => {
    const mode = (path) => statSync(path).mode & 0o7777;
    if (mode(directory) !== 0o755) fail(`${relative(bundle, directory) || "the bundle"} is not mode 0755`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const inside = relative(bundle, path).split(sep).join("/");
      if (entry.isDirectory()) walk(path);
      else if (mode(path) !== (executables.includes(inside) ? 0o755 : 0o644)) fail(`${inside} has mode ${mode(path).toString(8)}`);
    }
  };
  walk(bundle);
}

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
  // Every module of the CLI loads from the bundle, with the modules it imports.
  const modules = filesUnder(join(copy, "app"))
    .filter((path) => path.endsWith(".js") && !path.startsWith("node_modules/"))
    .map((path) => pathToFileURL(join(copy, "app", path)).href);
  node([
    "--input-type=module",
    "-e",
    `
    import { createRequire } from "node:module";
    for (const module of ${JSON.stringify(modules)}) await import(module);
    const addon = await import(${url("app/native/addon.js")});
    const build = await import(${url("app/build-info.js")});
    if (addon.ADDON_URL.href !== ${url("native/urx-native.node")}) throw new Error("the addon is looked for at " + addon.ADDON_URL.href);
    const opened = addon.openAddon(addon.expectedIdentity(build.BUILD_INFO));
    if (!opened.ok) throw new Error("the addon was refused: " + opened.problem);
    const common = createRequire(${url("app/native/device.js")}).resolve("@urx/device-control/operations");
    if (!common.startsWith(${JSON.stringify(join(copy, "app"))})) throw new Error("the common package was loaded from " + common);
    `,
  ]);
  // Away from any bundle the launcher starts nothing: exit 1, empty stdout, one line on stderr. Its
  // bundle would be `scratch`, which has no release manifest, so an installation on this machine,
  // complete or not, cannot make it start Node; the launcher's own tests cover the installation states.
  const away = join(scratch, "away");
  mkdirSync(away);
  cpSync(join(copy, "bin", `urx${platform.exe}`), join(away, `urx${platform.exe}`));
  const launched = spawnSync(join(away, `urx${platform.exe}`), ["--version"], { cwd: scratch, encoding: "utf8" });
  if (launched.status !== 1 || launched.stdout !== "" || launched.stderr.split("\n").filter(Boolean).length !== 1) {
    fail(`the launcher away from any bundle exited ${launched.status} with ${JSON.stringify(launched.stdout)} and ${JSON.stringify(launched.stderr)}`);
  }
  process.stdout.write("the bundle is complete and runs on its own\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
