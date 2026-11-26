import { describe, expect, it } from "vitest";
import { BUILD_INFO } from "../build-info.js";
import { renderVersion } from "./version.js";

const build = {
  appVersion: "0.1.0",
  appCommit: "a".repeat(40),
  commonVersion: "0.1.0",
  commonCommit: "b".repeat(40),
};

describe("urx --version (H5)", () => {
  it("print the four fixed lines", () => {
    expect(renderVersion(build, 1, { version: "26.13.0", platform: "darwin", arch: "arm64" })).toBe(
      [`urx 0.1.0 (${"a".repeat(40)})`, `common 0.1.0 (${"b".repeat(40)})`, "bridge-api-expected 1", "runtime 26.13.0 macos arm64", ""].join("\n"),
    );
  });

  it("name the two target OS families, and any other platform as Node names it", () => {
    const os = (platform: string, arch: string) => renderVersion(build, 1, { version: "26.13.0", platform, arch }).split("\n")[3];
    expect(os("win32", "x64")).toBe("runtime 26.13.0 windows x64");
    expect(os("linux", "x64")).toBe("runtime 26.13.0 linux x64");
  });

  it("show unknown for metadata a source run does not have", () => {
    expect(BUILD_INFO).toEqual({ appVersion: "unknown", appCommit: "unknown", commonVersion: "unknown", commonCommit: "unknown" });
    expect(renderVersion(BUILD_INFO, 1, { version: "26.13.0", platform: "darwin", arch: "arm64" })).toContain("urx unknown (unknown)\ncommon unknown (unknown)\n");
  });
});
