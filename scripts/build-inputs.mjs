// Checks that build-inputs.json is well formed and that the files repeating its
// values for other tools (.node-version, package.json) agree with it. Reads only;
// a mismatch prints every problem and exits 1.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The distribution targets (K16): one Node archive each, named as nodejs.org names it. */
export const TARGETS = Object.freeze({ "darwin-arm64": "tar.gz", "win-x64": "zip" });

const HEX = (length) => new RegExp(`^[0-9a-f]{${length}}$`);
const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * Returns the problems found, an empty array when the inputs agree.
 * @param {{ manifest: any, nodeVersionFile: string, packageJson: any }} files
 */
export function checkBuildInputs({ manifest, nodeVersionFile, packageJson }) {
  const problems = [];
  const node = manifest?.node;
  const pnpm = manifest?.pnpm;
  if (!SEMVER.test(node?.version ?? "")) problems.push("node.version is not an exact x.y.z version");
  if (!SEMVER.test(pnpm?.version ?? "")) problems.push("pnpm.version is not an exact x.y.z version");
  if (!HEX(128).test(pnpm?.sha512 ?? "")) problems.push("pnpm.sha512 is not 128 lowercase hex digits");
  if (problems.length > 0) return problems;

  const { version } = node;
  if (node.checksums !== `https://nodejs.org/dist/v${version}/SHASUMS256.txt`) {
    problems.push(`node.checksums is not the SHASUMS256.txt of v${version}`);
  }
  const archives = node.archives ?? {};
  const names = Object.keys(archives).sort();
  const expected = Object.keys(TARGETS).sort();
  if (names.join() !== expected.join()) {
    problems.push(`node.archives lists ${names.join(", ") || "nothing"}, not ${expected.join(", ")}`);
  }
  for (const [target, extension] of Object.entries(TARGETS)) {
    const archive = archives[target];
    if (archive === undefined) continue;
    if (archive.file !== `node-v${version}-${target}.${extension}`) {
      problems.push(`node.archives.${target}.file is not node-v${version}-${target}.${extension}`);
    }
    if (!HEX(64).test(archive.sha256 ?? "")) {
      problems.push(`node.archives.${target}.sha256 is not 64 lowercase hex digits`);
    }
  }

  // A checkout with CRLF line endings (Git for Windows' default) ends the line with \r\n.
  if (nodeVersionFile.replace(/\r\n$/, "\n") !== `${version}\n`) {
    problems.push(`.node-version is not "${version}" on one line`);
  }
  const engine = packageJson?.engines?.node;
  const major = version.split(".")[0];
  if (engine !== `>=${version} <${Number(major) + 1}`) {
    problems.push(`package.json engines.node is not ">=${version} <${Number(major) + 1}"`);
  }
  if (packageJson?.packageManager !== `pnpm@${pnpm.version}+sha512.${pnpm.sha512}`) {
    problems.push("package.json packageManager is not the pnpm version and sha512 in build-inputs.json");
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const root = new URL("../", import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), "utf8");
  const problems = checkBuildInputs({
    manifest: JSON.parse(read("build-inputs.json")),
    nodeVersionFile: read(".node-version"),
    packageJson: JSON.parse(read("package.json")),
  });
  for (const problem of problems) console.error(`build-inputs: ${problem}`);
  process.exitCode = problems.length > 0 ? 1 : 0;
}
