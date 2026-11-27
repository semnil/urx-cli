// Loading the Node-API addon and checking it against the JavaScript before any
// device access (V5/V6, H5). Help and version never reach this module: it is
// imported only by code that opens a device connection.

import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { BRIDGE_API_EXPECTED } from "../bridge.js";
import type { BuildInfo } from "../build-info.js";
import type { LifecycleAddon } from "./device.js";

/** The addon's exports this module relies on; everything they return is validated. */
export interface NativeAddon extends LifecycleAddon {
  buildIdentity(): unknown;
}

/** The exports an addon must have to be used at all. */
const FUNCTIONS = ["buildIdentity", "discover", "openConnection", "Control", "Connection"] as const;
/** The methods its connections must have. */
const CONNECTION_METHODS = [
  "close",
  "createOperation",
  "newRequestTicket",
  "getNumeric",
  "getText",
  "getName",
  "setNumeric",
  "setText",
  "adoptResult",
  "failDelivery",
  "terminate",
  "prepareSubscription",
  "adoptNotifications",
] as const;

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

/**
 * Where the addon is for this module's layout. In an installed bundle (K18)
 * the compiled CLI is under `app` and the addon under the bundle's own
 * `native`, beside the bundle's release manifest; in a build it is next to
 * this module: dist/native/urx-native.node. The layout is the bundle's
 * manifest being there, never the addon being found in either place.
 */
export function addonUrl(module: string | URL = import.meta.url, exists: (url: URL) => boolean = existsSync): URL {
  const manifest = new URL("../../release-manifest.json", module);
  return exists(manifest) ? new URL("../../native/urx-native.node", module) : new URL("./urx-native.node", module);
}

export const ADDON_URL = addonUrl();

/** Loads the addon at `url`; a load failure is reported as `missing`, not thrown. */
export function loadAddon(url: URL = ADDON_URL, load: (url: URL) => unknown = defaultLoad): AddonCheck {
  let module: unknown;
  try {
    module = load(url);
  } catch {
    return { ok: false, problem: "missing" };
  }
  return missingExports(module) ? { ok: false, problem: "malformed" } : { ok: true, addon: module as NativeAddon };
}

/** Whether `module` lacks an export, or its connections a method, this bridge revision needs. */
function missingExports(module: unknown): boolean {
  const exports = module as Record<string, unknown> | null;
  if (typeof exports !== "object" || exports === null || FUNCTIONS.some((name) => typeof exports[name] !== "function")) return true;
  const connection = (exports["Connection"] as { prototype?: Record<string, unknown> }).prototype;
  return CONNECTION_METHODS.some((name) => typeof connection?.[name] !== "function");
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

/**
 * Loads the addon and checks it: the one gate before device access. The
 * identity comes first, so an addon of another bridge revision is
 * `bridge_mismatch` whatever it exports; only an addon of this revision is
 * then required to have every export and method this revision uses.
 */
export function openAddon(expected: ExpectedIdentity, url: URL = ADDON_URL, load: (url: URL) => unknown = defaultLoad): AddonCheck {
  let module: unknown;
  try {
    module = load(url);
  } catch {
    return { ok: false, problem: "missing" };
  }
  const identify = (module as { buildIdentity?: unknown } | null)?.buildIdentity;
  if (typeof identify !== "function") return { ok: false, problem: "malformed" };
  let reported: unknown;
  try {
    reported = identify.call(module);
  } catch {
    return { ok: false, problem: "malformed" };
  }
  const problem = checkIdentity(reported, expected);
  if (problem !== null) return { ok: false, problem };
  return missingExports(module) ? { ok: false, problem: "malformed" } : { ok: true, addon: module as NativeAddon };
}
