// Checks the Windows installer in dist-installer/ on a disposable Windows
// machine (K29): it installs into, and removes from, the current user's fixed
// installation (%LOCALAPPDATA%\Programs\urx-cli) and PATH, so it refuses to
// run unless URX_DISPOSABLE_MACHINE=1 says the machine is a throwaway one, and
// unless no urx-cli is installed there yet.
//
// 1. A silent installation completes: the state record says `complete` and
//    names the installed release manifest, the gate is an empty file, the
//    bin folder is on the user's PATH, and the installed `urx --version` runs.
// 2. While something holds the gate, as a running urx does, a second
//    installation stops before changing anything.
// 3. An installation told to go elsewhere (/DIR) stops before changing
//    anything and writes nothing there.
// 4. Running the same installer again completes again.
// 5. A removal without the state record changes nothing.
// 6. A silent removal leaves the gate and its folder, removes the state
//    record, every installed file and the PATH entry, and keeps a file the
//    user put in the installation folder.
//
// Usage: URX_DISPOSABLE_MACHINE=1 node scripts/check-windows-installer.mjs

import { execFileSync, spawnSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./release-build.mjs";

const fail = (message) => {
  throw new Error(`installer check: ${message}`);
};
if (process.platform !== "win32") fail("this check runs on Windows");
if (process.env.URX_DISPOSABLE_MACHINE !== "1") fail("set URX_DISPOSABLE_MACHINE=1 only on a throwaway machine: this check installs and removes urx-cli");

const root = fileURLToPath(new URL("../", import.meta.url));
const local = process.env.LOCALAPPDATA;
if (!local) fail("LOCALAPPDATA is not set");
const app = join(local, "Programs", "urx-cli");
const maintenance = join(local, "urx-cli-maintenance");
const statePath = join(maintenance, "state.json");
const gatePath = join(maintenance, "gate.lock");
const bin = join(app, "bin");
/** Whether nothing is at `path`: only "no such file" says so; any other error is not an answer and stops the check. */
const absent = (path) => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw new Error(`installer check: whether ${path} is there could not be told`, { cause: error });
  }
};
if (!absent(app) || !absent(statePath)) fail(`urx-cli is already installed here (${app}); this check needs a machine without it`);

const [setupName, ...others] = readdirSync(join(root, "dist-installer"));
if (setupName === undefined || others.length > 0 || !setupName.endsWith("-setup.exe")) fail("dist-installer holds no single setup program");
const setup = join(root, "dist-installer", setupName);
const logs = mkdtempSync(join(tmpdir(), "urx-installer-check-"));
let runs = 0;
const runSetup = (...extra) => {
  const log = join(logs, `setup-${++runs}.log`);
  const result = spawnSync(setup, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/LOG=${log}`, ...extra], { encoding: "utf8" });
  return { status: result.status, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
};
const state = () => JSON.parse(readFileSync(statePath, "utf8"));
/** The current user's PATH as the registry holds it, unexpanded. */
const userPath = () => {
  const output = execFileSync("reg", ["query", "HKCU\\Environment", "/v", "Path"], { encoding: "utf8" });
  const line = output.split(/\r?\n/).find((text) => /^\s+Path\s+REG_(EXPAND_)?SZ\s/i.test(text));
  return line === undefined ? "" : line.replace(/^\s+Path\s+REG_(EXPAND_)?SZ\s+/i, "");
};
const onPath = () => userPath().split(";").some((entry) => entry.trim().toLowerCase() === bin.toLowerCase());

try {
  // 1. A silent installation completes.
  const first = runSetup();
  if (first.status !== 0) fail(`the installation exited ${first.status}\n${first.log}`);
  const installed = state();
  const manifestDigest = sha256(readFileSync(join(app, "release-manifest.json")));
  if (installed.product !== "urx-cli" || installed.format !== 1 || installed.phase !== "complete" || installed.manifest !== manifestDigest || installed.pathAdded !== true) {
    fail(`the state record after installing is ${JSON.stringify(installed)}`);
  }
  if (statSync(gatePath).size !== 0) fail("the gate is not an empty file");
  if (!onPath()) fail(`${bin} is not on the user's PATH`);
  const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const shown = spawnSync(join(bin, "urx.exe"), ["--version"], { encoding: "utf8" });
  if (shown.status !== 0 || !shown.stdout.includes(version)) fail(`the installed urx --version exited ${shown.status} with ${JSON.stringify(shown.stdout)} and ${JSON.stringify(shown.stderr)}`);

  // 2. A held gate stops the next installation before it changes anything.
  const held = openSync(gatePath, "r");
  let busy;
  try {
    busy = runSetup();
  } finally {
    closeSync(held);
  }
  if (busy.status === 0) fail("an installation went ahead while the gate was held");
  if (JSON.stringify(state()) !== JSON.stringify(installed)) fail(`a stopped installation changed the state record to ${JSON.stringify(state())}`);

  // 3. An installation told to go elsewhere stops and writes nothing there.
  const elsewhere = join(logs, "elsewhere");
  const moved = runSetup(`/DIR=${elsewhere}`);
  if (moved.status === 0) fail("an installation went ahead into a folder other than the fixed one");
  if (!absent(elsewhere) && readdirSync(elsewhere).length > 0) fail(`an installation told to go elsewhere wrote into ${elsewhere}`);
  if (JSON.stringify(state()) !== JSON.stringify(installed)) fail(`an installation told to go elsewhere changed the state record to ${JSON.stringify(state())}`);

  // 4. The same installer completes again.
  const again = runSetup();
  if (again.status !== 0 || state().phase !== "complete") fail(`running the installer again exited ${again.status}\n${again.log}`);

  const owned = [...JSON.parse(readFileSync(join(app, "release-manifest.json"), "utf8")).files.map((file) => file.path), "release-manifest.json"];
  let removals = 0;
  const uninstall = () => {
    const log = join(logs, `uninstall-${++removals}.log`);
    const result = spawnSync(join(app, "maintenance", "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/LOG=${log}`], { encoding: "utf8" });
    return { status: result.status, log: existsSync(log) ? readFileSync(log, "utf8") : "" };
  };
  const pause = new Int32Array(new SharedArrayBuffer(4));

  // 5. A removal without the state record changes nothing. When InitializeUninstall refuses, the
  // uninstaller's first part waits for its copy and exits 1; the log says why.
  const kept = readFileSync(statePath);
  rmSync(statePath);
  const refused = uninstall();
  if (refused.status !== 1 || !refused.log.includes("urx-cli: The installation state") || !refused.log.includes("is missing")) {
    fail(`the removal without a state record exited ${refused.status} without saying the record is missing\n${refused.log}`);
  }
  const touched = owned.filter((path) => absent(join(app, ...path.split("/"))));
  if (touched.length > 0) fail(`the removal without a state record removed ${touched.join(", ")}`);
  if (!onPath()) fail("the removal without a state record took the bin folder off the PATH");
  if (!absent(statePath)) fail("the removal without a state record wrote one");
  writeFileSync(statePath, kept);

  // 6. A silent removal removes every installed file and keeps the gate and the user's file.
  writeFileSync(join(app, "notes.txt"), "the user's");
  const removed = uninstall();
  if (removed.status !== 0) fail(`the removal exited ${removed.status}\n${removed.log}`);
  // The uninstaller finishes in a copy of itself; wait for it to leave the state record.
  const until = Date.now() + 120_000;
  while (!absent(statePath) && Date.now() < until) Atomics.wait(pause, 0, 0, 500);
  if (!absent(statePath)) fail(`the removal left the state record ${readFileSync(statePath, "utf8")}`);
  if (!existsSync(gatePath) || statSync(gatePath).size !== 0) fail("the removal did not keep the empty gate");
  const left = owned.filter((path) => !absent(join(app, ...path.split("/"))));
  if (left.length > 0) fail(`the removal left installed files: ${left.join(", ")}`);
  if (readFileSync(join(app, "notes.txt"), "utf8") !== "the user's") fail("the removal did not keep the user's file");
  if (onPath()) fail(`the removal left ${bin} on the user's PATH`);
  process.stdout.write("the installer installs, stops while urx runs, reinstalls and removes as designed\n");
} finally {
  rmSync(logs, { recursive: true, force: true });
}
