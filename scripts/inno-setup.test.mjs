import { describe, expect, it } from "vitest";
import { installerProblem } from "./inno-setup.mjs";
import { sha256 } from "./release-build.mjs";

describe("the Inno Setup installer", () => {
  const bytes = Buffer.from("installer");
  const record = { version: "7.1.1", installer: "innosetup-7.1.1-x64.exe", sha256: sha256(bytes) };

  it("is taken when its SHA-256 is the recorded one", () => {
    expect(installerProblem(bytes, record)).toBeNull();
  });

  it("is refused otherwise, naming both hashes", () => {
    const other = Buffer.from("something else");
    expect(installerProblem(other, record)).toBe(
      `the installer is not innosetup-7.1.1-x64.exe of Inno Setup 7.1.1: its SHA-256 is ${sha256(other)}, not ${record.sha256}`,
    );
  });
});
