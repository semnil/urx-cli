import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveUrl, assemble, filesUnder, manifestOf, platformOf, sha256, verifyArchive } from "./build-bundle.mjs";

const temporary = [];
const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), "urx-bundle-test-"));
  temporary.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const write = (root, path, text = path) => {
  const file = join(root, ...path.split("/"));
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
};

describe("the installed bundle (K18, K38)", () => {
  it("is built for the two distributed platforms only (K16)", () => {
    expect(platformOf("darwin", "arm64")).toMatchObject({ key: "darwin-arm64", exe: "" });
    expect(platformOf("win32", "x64")).toMatchObject({ key: "win-x64", exe: ".exe" });
    expect(() => platformOf("linux", "x64")).toThrow();
    expect(() => platformOf("darwin", "x64")).toThrow();
  });

  it("fetches the archive build-inputs.json records from nodejs.org", () => {
    const inputs = JSON.parse(readFileSync(new URL("../build-inputs.json", import.meta.url), "utf8"));
    const { version } = inputs.node;
    expect(archiveUrl(inputs, platformOf("darwin", "arm64"))).toBe(`https://nodejs.org/dist/v${version}/node-v${version}-darwin-arm64.tar.gz`);
    expect(archiveUrl(inputs, platformOf("win32", "x64"))).toBe(`https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`);
  });

  it("refuses a Node archive whose SHA-256 is not the recorded one", () => {
    const dir = scratch();
    write(dir, "node.tar.gz", "archive");
    expect(() => verifyArchive(join(dir, "node.tar.gz"), sha256(Buffer.from("archive")))).not.toThrow();
    expect(() => verifyArchive(join(dir, "node.tar.gz"), sha256(Buffer.from("other")))).toThrow(/not the recorded/);
  });

  it("lays out the release output, the runtime and the notices in the fixed places", () => {
    const dir = scratch();
    const release = join(dir, "release");
    for (const path of ["main.js", "build-info.js", "package.json", "native/addon.js", "native/urx-native.node", "launcher/urx", "node_modules/@urx/device-control/package.json"]) write(release, path);
    const node = join(dir, "node-v26");
    write(node, "bin/node", "node");
    write(node, "LICENSE", "node license");
    write(dir, "LICENSE", "cli license");
    const staging = join(dir, "bundle");
    mkdirSync(staging);
    assemble({ release, node, staging, platform: platformOf("darwin", "arm64"), notices: { "urx-cli.txt": join(dir, "LICENSE"), "node.txt": join(node, "LICENSE") } });
    expect(filesUnder(staging)).toEqual([
      "app/build-info.js",
      "app/main.js",
      "app/native/addon.js",
      "app/node_modules/@urx/device-control/package.json",
      "app/package.json",
      "bin/urx",
      "native/urx-native.node",
      "notices/node.txt",
      "notices/urx-cli.txt",
      "runtime/node",
    ]);
    expect(readFileSync(join(staging, "runtime", "node"), "utf8")).toBe("node");
  });

  it("lists every file but the manifest itself, with its hash and size, after the identities", () => {
    const dir = scratch();
    write(dir, "b.txt", "bb");
    write(dir, "a/c.txt", "c");
    write(dir, "release-manifest.json", "{}");
    const manifest = manifestOf(dir, { release: "0.1.0" });
    expect(manifest).toEqual({
      product: "urx-cli",
      format: 1,
      release: "0.1.0",
      files: [
        { path: "a/c.txt", sha256: sha256(Buffer.from("c")), size: 1 },
        { path: "b.txt", sha256: sha256(Buffer.from("bb")), size: 2 },
      ],
    });
  });

  it("refuses a link inside the bundle", () => {
    const dir = scratch();
    write(dir, "real.txt");
    try {
      symlinkSync(join(dir, "real.txt"), join(dir, "link.txt"));
    } catch {
      return; // Creating a link needs a privilege this Windows account may lack.
    }
    expect(() => filesUnder(dir)).toThrow(/no link/);
  });
});
