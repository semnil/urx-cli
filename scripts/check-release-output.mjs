// Checks a release output away from the checkout: it holds exactly the files
// its record names, each as the release build made it; then it copies it to a
// new temporary directory, under a package.json that declares CommonJS, then runs
// `--help` and `--version`, checks that it holds exactly the modules the
// release's commits compile to and loads each of them, opens the addon and
// loads the device module there.
// Reading anything from outside the copy (the checkout's vendor directory or
// node_modules), or depending on the module format of a directory above it,
// makes the check fail.

import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { filesUnder } from "./build-bundle.mjs";
import { recordedProblems, RELEASE_FILES, releaseRecord, RUST_NOTICES } from "./release-build.mjs";
import { compiledModules, moduleProblems } from "./compiled-modules.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const fail = (message) => {
  throw new Error(`release output check: ${message}`);
};

const output = resolve(process.argv[2] ?? "dist-release");
const recorded = releaseRecord(output);
if (recorded === null) fail("the output has no well-formed record of the files the release build made");
const problems = recordedProblems(output, recorded);
const unrecorded = filesUnder(output).filter((path) => path !== RELEASE_FILES && !recorded.some((file) => file.path === path));
// The licenses of the Rust crates in its programs are one of its files.
if (!recorded.some((file) => file.path === RUST_NOTICES)) problems.push(`${RUST_NOTICES} is not one of its files`);
if (problems.length > 0 || unrecorded.length > 0) {
  fail(`the output is not as the release build made it: ${[...problems, ...unrecorded.map((path) => `${path} is not one of its files`)].join("; ")}`);
}
// The real path, so the comparison below holds where the temporary directory is a symlink (macOS /var).
const scratch = realpathSync.native(mkdtempSync(join(tmpdir(), "urx-release-output-")));
try {
  // A project above the output that declares its own `.js` files CommonJS.
  writeFileSync(join(scratch, "package.json"), `${JSON.stringify({ type: "commonjs" })}\n`);
  const copy = join(scratch, "tools", "urx");
  cpSync(output, copy, { recursive: true });
  const url = (path) => JSON.stringify(pathToFileURL(join(copy, path)).href);
  const APP = copy;
  // The copy holds exactly the modules the release's commits compile to, and each of them loads from it.
  const { BUILD_INFO } = await import(pathToFileURL(join(APP, "build-info.js")).href);
  const expected = compiledModules(root, BUILD_INFO);
  const scripts = filesUnder(APP).filter((path) => path.endsWith(".js"));
  const moduleIssues = moduleProblems(scripts, expected);
  if (moduleIssues.length > 0) fail(moduleIssues.join("; "));
  const modules = scripts.map((path) => pathToFileURL(join(APP, path)).href);
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
