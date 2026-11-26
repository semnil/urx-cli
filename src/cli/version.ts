// `urx --version` (H5): fixed text lines from the embedded build information and
// the running Node. It loads no addon, reads no file and runs no git command.

import type { BuildInfo } from "../build-info.js";

export interface Runtime {
  /** Node's own version, without a leading "v". */
  readonly version: string;
  /** Node's `process.platform`. */
  readonly platform: string;
  /** Node's `process.arch`. */
  readonly arch: string;
}

/** OS family names for the distribution targets (K16); any other platform is shown as Node names it. */
const OS_FAMILY: Readonly<Record<string, string>> = Object.freeze({ darwin: "macos", win32: "windows" });

export function renderVersion(build: BuildInfo, bridgeRevision: number, runtime: Runtime): string {
  return [
    `urx ${build.appVersion} (${build.appCommit})`,
    `common ${build.commonVersion} (${build.commonCommit})`,
    `bridge-api-expected ${bridgeRevision}`,
    `runtime ${runtime.version} ${OS_FAMILY[runtime.platform] ?? runtime.platform} ${runtime.arch}`,
    "",
  ].join("\n");
}
