// Checks a release output away from the checkout: copies it to a new
// temporary directory, under a package.json that declares CommonJS, then runs
// `--help` and `--version`, loads every one of its modules, opens the addon
// and loads the device module there.
// Reading anything from outside the copy (the checkout's vendor directory or
// node_modules), or depending on the module format of a directory above it,
// makes the check fail.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { filesUnder } from "./build-bundle.mjs";

const output = resolve(process.argv[2] ?? "dist-release");
// The real path, so the comparison below holds where the temporary directory is a symlink (macOS /var).
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "urx-release-output-")));
try {
  // A project above the output that declares its own `.js` files CommonJS.
  writeFileSync(join(scratch, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
  const copy = join(scratch, "tools", "urx");
  cpSync(output, copy, { recursive: true });
  const url = (path) => JSON.stringify(pathToFileURL(join(copy, path)).href);
  // Every module of the CLI loads from the copy, with the modules it imports.
  const modules = filesUnder(copy)
    .filter((path) => path.endsWith(".js") && !path.startsWith("node_modules/"))
    .map((path) => pathToFileURL(join(copy, path)).href);
  const node = (args) => execFileSync(process.execPath, args, { cwd: scratch, encoding: "utf8" });
  node([join(copy, "main.js"), "--help"]);
  process.stdout.write(node([join(copy, "main.js"), "--version"]));
  node([
    "--input-type=module",
    "-e",
    `
    import { createRequire } from "node:module";
    for (const module of ${JSON.stringify(modules)}) await import(module);
    const addon = await import(${url("native/addon.js")});
    const device = await import(${url("native/device.js")});
    const build = await import(${url("build-info.js")});
    const opened = addon.openAddon(addon.expectedIdentity(build.BUILD_INFO));
    if (!opened.ok) throw new Error("the addon was refused: " + opened.problem);
    if (device.selectDevice([], undefined).code !== "device_not_found") throw new Error("unexpected selection");
    const common = createRequire(${url("native/device.js")}).resolve("@urx/device-control/operations");
    if (!common.startsWith(${JSON.stringify(copy)})) throw new Error("the common package was loaded from " + common);
    `,
  ]);
  process.stdout.write("the release output loads on its own\n");
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
