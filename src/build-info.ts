// Build identification embedded in the compiled CLI. `pnpm build` replaces the
// emitted dist/build-info.js with the values of the checkout it builds
// (scripts/build-info.mjs); running from source, every field is "unknown".

export interface BuildInfo {
  readonly appVersion: string;
  readonly appCommit: string;
  readonly commonVersion: string;
  readonly commonCommit: string;
}

export const BUILD_INFO: BuildInfo = Object.freeze({
  appVersion: "unknown",
  appCommit: "unknown",
  commonVersion: "unknown",
  commonCommit: "unknown",
});
