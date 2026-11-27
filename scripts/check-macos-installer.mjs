// Checks the macOS installer tree in dist-installer/ on a disposable Mac
// (K29): it installs into, and removes from, the system-wide fixed places
// (/usr/local/lib/urx-cli, /usr/local/bin/urx and
// /Library/Application Support/urx-cli-maintenance) with sudo, so it refuses
// to run unless URX_DISPOSABLE_MACHINE=1 says the machine is a throwaway one,
// unless sudo needs no password, and unless nothing of urx-cli is there yet.
//
// 1. A preview changes nothing, and an apply without sudo stops before
//    changing anything.
// 2. An apply with sudo completes: the state record says `complete` and names
//    the installed release manifest, the gate is an empty root file, the link
//    points to the installed launcher, and `/usr/local/bin/urx --version` runs.
// 3. While something holds the gate shared, as a running urx does, a second
//    apply stops at once and changes nothing.
// 4. An installed file changed by someone else is put back by running the
//    same installer again.
// 5. The installed urx-uninstall previews, then removes every installed file,
//    the link and the state record, keeps a file the user put in the
//    installation and the gate with its folder, and a second removal finds
//    nothing to remove.
//
// Usage: URX_DISPOSABLE_MACHINE=1 node scripts/check-macos-installer.mjs

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./release-build.mjs";

const fail = (message) => {
  throw new Error(`installer check: ${message}`);
};
if (process.platform !== "darwin") fail("this check runs on macOS");
if (process.env.URX_DISPOSABLE_MACHINE !== "1") fail("set URX_DISPOSABLE_MACHINE=1 only on a throwaway machine: this check installs and removes urx-cli");
if (spawnSync("sudo", ["-n", "true"]).status !== 0) fail("sudo asks for a password here; this check runs where sudo needs none");

const root = fileURLToPath(new URL("../", import.meta.url));
const app = "/usr/local/lib/urx-cli";
const link = "/usr/local/bin/urx";
const maintenance = "/Library/Application Support/urx-cli-maintenance";
const statePath = join(maintenance, "state.json");
const gatePath = join(maintenance, "gate.lock");
/** Whether nothing is at `path`: only "no such file" says so; any other error stops the check. */
const absent = (path) => {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    if (error?.code === "ENOENT") return true;
    throw new Error(`installer check: whether ${path} is there could not be told`, { cause: error });
  }
};
for (const path of [app, link, maintenance]) if (!absent(path)) fail(`${path} is already there; this check needs a machine without urx-cli`);

const tree = join(root, "dist-installer");
const installer = join(tree, "urx-install");
const manifestBytes = readFileSync(join(tree, "urx-cli", "release-manifest.json"));
const manifest = JSON.parse(manifestBytes.toString("utf8"));
const run = (command, args, { sudo = false } = {}) => {
  const result = spawnSync(sudo ? "sudo" : command, sudo ? ["-n", command, ...args] : args, { encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};
const expectRun = (what, result, status) => {
  if (result.status !== status) fail(`${what} exited ${result.status}, not ${status}: ${JSON.stringify(result.stdout)} ${JSON.stringify(result.stderr)}`);
  return result;
};
const state = () => JSON.parse(readFileSync(statePath, "utf8"));

// 1. A preview, and an apply without sudo, change nothing.
expectRun("the preview", run(installer, []), 0);
const unprivileged = expectRun("an apply without sudo", run(installer, ["--apply"]), 1);
if (!unprivileged.stderr.includes("sudo")) fail(`an apply without sudo said ${JSON.stringify(unprivileged.stderr)}`);
for (const path of [app, link, maintenance]) if (!absent(path)) fail(`${path} was made by a preview or an apply without sudo`);

// 2. An apply with sudo completes.
expectRun("the installation", run(installer, ["--apply"], { sudo: true }), 0);
const installed = state();
if (installed.phase !== "complete" || installed.manifest !== sha256(manifestBytes) || installed.release !== manifest.release) {
  fail(`the state record after installing is ${JSON.stringify(installed)}`);
}
const gate = statSync(gatePath);
if (gate.size !== 0 || gate.uid !== 0 || (gate.mode & 0o7777) !== 0o644) fail("the gate is not an empty root file of mode 0644");
if (readlinkSync(link) !== join(app, "bin", "urx")) fail(`${link} points to ${readlinkSync(link)}`);
const version = expectRun("the installed urx --version", run(link, ["--version"]), 0);
if (!version.stdout.startsWith(`urx ${manifest.app.version} (${manifest.app.commit})`)) fail(`the installed urx --version printed ${JSON.stringify(version.stdout)}`);

// 3. A running urx (a shared hold on the gate) stops a second apply at once.
const holder = spawn("/usr/bin/perl", ["-e", 'use Fcntl ":flock"; open(my $g, "<", $ARGV[0]) or die; flock($g, LOCK_SH|LOCK_NB) or die; print "held\\n"; sleep 60', gatePath], {
  stdio: ["ignore", "pipe", "inherit"],
});
try {
  await new Promise((resolve, reject) => {
    holder.stdout.once("data", resolve);
    holder.once("exit", () => reject(new Error("installer check: the gate holder ended before holding it")));
  });
  const before = readFileSync(statePath);
  const busy = expectRun("an apply while urx runs", run(installer, ["--apply"], { sudo: true }), 1);
  if (!busy.stderr.includes("urx is running")) fail(`an apply while urx runs said ${JSON.stringify(busy.stderr)}`);
  if (!readFileSync(statePath).equals(before)) fail("an apply while urx runs changed the state record");
} finally {
  // The hold ends with the holder, before anything else runs.
  if (holder.exitCode === null && holder.signalCode === null) {
    const ended = new Promise((resolve) => holder.once("exit", resolve));
    holder.kill();
    await ended;
  }
}

// 4. The same installer puts back a changed file.
const entry = join(app, "app", "main.js");
const listed = manifest.files.find((file) => file.path === "app/main.js");
execFileSync("sudo", ["-n", "/bin/sh", "-c", 'printf changed > "$1"', "sh", entry]);
expectRun("the repair", run(installer, ["--apply"], { sudo: true }), 0);
if (sha256(readFileSync(entry)) !== listed.sha256) fail("the repair did not put back app/main.js");

// 5. The installed removal tool keeps the user's file and the gate.
const uninstall = join(app, "maintenance", "urx-uninstall");
expectRun("the removal preview", run(uninstall, []), 0);
if (state().phase !== "complete") fail("the removal preview changed the state record");
const note = join(app, "notices", "user-note");
execFileSync("sudo", ["-n", "/usr/bin/touch", note]);
const removed = expectRun("the removal", run(uninstall, ["--apply"], { sudo: true }), 0);
if (!removed.stdout.includes(`Kept ${app}`)) fail(`the removal did not report the kept folder: ${JSON.stringify(removed.stdout)}`);
if (!absent(link) || !absent(statePath)) fail("the removal left the link or the state record");
if (absent(gatePath) || statSync(gatePath).size !== 0) fail("the removal did not keep the empty gate");
const left = (folder) =>
  readdirSync(folder, { withFileTypes: true }).flatMap((item) => (item.isDirectory() ? left(join(folder, item.name)).map((name) => `${item.name}/${name}`) : [item.name]));
const remaining = left(app);
if (JSON.stringify(remaining) !== JSON.stringify(["notices/user-note"])) fail(`the removal left ${JSON.stringify(remaining)}`);
execFileSync("sudo", ["-n", "/bin/rm", note]);
execFileSync("sudo", ["-n", "/bin/rmdir", join(app, "notices"), app]);
// The installed tool is gone; the copy in the release tree, as in the recovery ZIP, runs the same.
const recovery = join(tree, "urx-cli", "maintenance", "urx-uninstall");
const again = expectRun("a second removal", run(recovery, ["--apply"], { sudo: true }), 0);
if (!again.stdout.includes("not installed")) fail(`a second removal said ${JSON.stringify(again.stdout)}`);
process.stdout.write("the macOS installer installs, refuses while urx runs, repairs and removes as specified\n");
