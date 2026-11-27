// Inno Setup, the compiler of the Windows installer (K17), in the version
// build-inputs.json records. `--url` prints where that release's installer is
// published. `--install <installer> <folder>` reads the downloaded installer
// once, refuses it unless its SHA-256 is the recorded one, and runs a copy of
// exactly what it read to install Inno Setup silently into <folder>. The
// folder must not exist yet, so the compiler found in it afterwards is the one
// that installer put there; its path is printed.
//
// Usage: node scripts/inno-setup.mjs --url
//        node scripts/inno-setup.mjs --install <installer> <folder>

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sha256 } from "./release-build.mjs";

const USAGE = "usage: node scripts/inno-setup.mjs --url | --install <installer> <folder>";

/** The Inno Setup record of build-inputs.json. */
function recorded() {
  return JSON.parse(readFileSync(new URL("../build-inputs.json", import.meta.url), "utf8")).innoSetup;
}

/**
 * Whether `bytes` are the installer build-inputs.json records: an error
 * message when they are not, otherwise null.
 */
export function installerProblem(bytes, record) {
  const digest = sha256(bytes);
  return digest === record.sha256 ? null : `the installer is not ${record.installer} of Inno Setup ${record.version}: its SHA-256 is ${digest}, not ${record.sha256}`;
}

function install(installerPath, folderPath) {
  if (process.platform !== "win32") throw new Error("Inno Setup is installed on Windows");
  const record = recorded();
  const bytes = readFileSync(installerPath);
  const problem = installerProblem(bytes, record);
  if (problem) throw new Error(problem);
  const folder = resolve(folderPath);
  if (existsSync(folder)) throw new Error(`${folder} already exists; Inno Setup is installed into a new folder`);

  const scratch = mkdtempSync(join(tmpdir(), "urx-inno-setup-"));
  try {
    // Runs what was checked, not the downloaded file, which could change after it was read.
    const copy = join(scratch, record.installer);
    writeFileSync(copy, bytes);
    const log = join(scratch, "install.log");
    // Setup is a GUI program; its own output goes to stderr so stdout carries only the compiler's path.
    const result = spawnSync(copy, ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", `/DIR=${folder}`, `/LOG=${log}`], {
      stdio: ["ignore", 2, 2],
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      const text = existsSync(log) ? readFileSync(log, "utf8") : "(no log)";
      throw new Error(`the Inno Setup installer exited ${result.status}\n${text}`);
    }
    const iscc = join(folder, "ISCC.exe");
    if (!existsSync(iscc)) throw new Error(`the Inno Setup installer put no ISCC.exe in ${folder}`);
    process.stdout.write(`${iscc}\n`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function main(argv) {
  if (argv.length === 1 && argv[0] === "--url") {
    process.stdout.write(`${recorded().url}\n`);
    return;
  }
  if (argv.length === 3 && argv[0] === "--install") {
    install(argv[1], argv[2]);
    return;
  }
  throw new Error(USAGE);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2));
}
