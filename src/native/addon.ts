// Loading the Node-API addon and checking it against the JavaScript before any
// device access (V5/V6, H5). Help and version never reach this module: it is
// imported only by code that opens a device connection.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { BRIDGE_API_EXPECTED } from "../bridge.js";
import type { BuildInfo } from "../build-info.js";

/** The addon's exports this module relies on; everything it returns is validated. */
export interface NativeAddon {
  buildIdentity(): unknown;
}

/** What the JavaScript expects the addon to have been built from. */
export interface ExpectedIdentity {
  readonly bridgeRevision: number;
  readonly commonVersion: string;
  readonly commonCommit: string;
}

export const expectedIdentity = (build: BuildInfo): ExpectedIdentity => ({
  bridgeRevision: BRIDGE_API_EXPECTED,
  commonVersion: build.commonVersion,
  commonCommit: build.commonCommit,
});

/** Why the addon cannot be used. Each one refuses device access. */
export type AddonProblem =
  | "missing" // the file is absent or cannot be loaded
  | "malformed" // it loaded but does not report a well-formed identity
  | "unverifiable" // the JavaScript or the addon does not know its urx-device commit or version
  | "bridge_mismatch"
  | "common_mismatch";

export type AddonCheck = { readonly ok: true; readonly addon: NativeAddon } | { readonly ok: false; readonly problem: AddonProblem };

/** The addon's location next to this module in the build: dist/native/urx-native.node. */
export const ADDON_URL = new URL("./urx-native.node", import.meta.url);

/** Loads the addon at `url`; a load failure is reported as `missing`, not thrown. */
export function loadAddon(url: URL = ADDON_URL, load: (url: URL) => unknown = defaultLoad): AddonCheck {
  let module: unknown;
  try {
    module = load(url);
  } catch {
    return { ok: false, problem: "missing" };
  }
  if (typeof (module as { buildIdentity?: unknown } | null)?.buildIdentity !== "function") return { ok: false, problem: "malformed" };
  return { ok: true, addon: module as NativeAddon };
}

const defaultLoad = (url: URL): unknown => createRequire(import.meta.url)(fileURLToPath(url));

const COMMIT = /^[0-9a-f]{40}$/;
/** The build scripts write either a SemVer version or "unknown". */
const isKnownVersion = (version: string) => version !== "unknown" && /^\d+\.\d+\.\d+/.test(version);

/**
 * Compares the identity an addon reports with the JavaScript's expectation.
 * Both commits and both versions must be known and equal: a build that cannot
 * name the urx-device source it was made from cannot show that the two halves
 * match.
 */
export function checkIdentity(reported: unknown, expected: ExpectedIdentity): AddonProblem | null {
  const record = reported as { bridgeRevision?: unknown; commonVersion?: unknown; commonCommit?: unknown } | null;
  if (
    typeof record !== "object" ||
    record === null ||
    !Number.isSafeInteger(record.bridgeRevision) ||
    typeof record.commonVersion !== "string" ||
    typeof record.commonCommit !== "string"
  ) {
    return "malformed";
  }
  if (record.bridgeRevision !== expected.bridgeRevision) return "bridge_mismatch";
  if (!COMMIT.test(record.commonCommit) || !COMMIT.test(expected.commonCommit)) return "unverifiable";
  if (!isKnownVersion(record.commonVersion) || !isKnownVersion(expected.commonVersion)) return "unverifiable";
  if (record.commonCommit !== expected.commonCommit || record.commonVersion !== expected.commonVersion) return "common_mismatch";
  return null;
}

/** Loads the addon and checks its identity: the one gate before device access. */
export function openAddon(expected: ExpectedIdentity, url: URL = ADDON_URL, load?: (url: URL) => unknown): AddonCheck {
  const loaded = loadAddon(url, load);
  if (!loaded.ok) return loaded;
  let reported: unknown;
  try {
    reported = loaded.addon.buildIdentity();
  } catch {
    return { ok: false, problem: "malformed" };
  }
  const problem = checkIdentity(reported, expected);
  return problem === null ? loaded : { ok: false, problem };
}
