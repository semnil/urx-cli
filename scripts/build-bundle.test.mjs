import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { archiveUrl, assemble, filesUnder, manifestOf, normalizeModes, platformOf, sha256, snapshotRelease, verifiedArchive } from "./build-bundle.mjs";

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
    expect(platformOf("darwin", "arm64")).toMatchObject({ key: "darwin-arm64", exe: "", maintenance: ["urx-uninstall"] });
    expect(platformOf("win32", "x64")).toMatchObject({ key: "win-x64", exe: ".exe", maintenance: [] });
    expect(() => platformOf("linux", "x64")).toThrow();
    expect(() => platformOf("darwin", "x64")).toThrow();
  });

  it("fetches the archive build-inputs.json records from nodejs.org", () => {
    const inputs = JSON.parse(readFileSync(new URL("../build-inputs.json", import.meta.url), "utf8"));
    const { version } = inputs.node;
    expect(archiveUrl(inputs, platformOf("darwin", "arm64"))).toBe(`https://nodejs.org/dist/v${version}/node-v${version}-darwin-arm64.tar.gz`);
    expect(archiveUrl(inputs, platformOf("win32", "x64"))).toBe(`https://nodejs.org/dist/v${version}/node-v${version}-win-x64.zip`);
  });

  it("refuses a Node archive whose SHA-256 is not the recorded one, and returns the bytes it checked", () => {
    const dir = scratch();
    write(dir, "node.tar.gz", "archive");
    expect(verifiedArchive(join(dir, "node.tar.gz"), sha256(Buffer.from("archive"))).toString()).toBe("archive");
    expect(() => verifiedArchive(join(dir, "node.tar.gz"), sha256(Buffer.from("other")))).toThrow(/not the recorded/);
  });

  it("copies the release output once, and refuses a copy taken while a release build replaced it", () => {
    const dir = scratch();
    const release = join(dir, "dist-release");
    write(release, "main.js", "first");
    snapshotRelease(release, join(dir, "kept"));
    expect(readFileSync(join(dir, "kept", "main.js"), "utf8")).toBe("first");
    // A release build publishes by renaming its new output into place.
    const replacing = (from, to, options) => {
      cpSync(from, to, options);
      renameSync(release, join(dir, "aside"));
      write(join(dir, "next"), "main.js", "second");
      renameSync(join(dir, "next"), release);
    };
    expect(() => snapshotRelease(release, join(dir, "mixed"), replacing)).toThrow(/was replaced while it was copied/);
  });

  it.skipIf(process.platform === "win32")("gives directories and executables 0755 and other files 0644, whatever they had", () => {
    const dir = scratch();
    write(dir, "bin/urx");
    write(dir, "app/main.js");
    chmodSync(join(dir, "bin", "urx"), 0o700);
    chmodSync(join(dir, "app", "main.js"), 0o666);
    chmodSync(join(dir, "app"), 0o700);
    chmodSync(dir, 0o700);
    normalizeModes(dir, ["bin/urx"]);
    const mode = (...path) => statSync(join(dir, ...path)).mode & 0o7777;
    expect([mode(), mode("app"), mode("bin"), mode("bin", "urx"), mode("app", "main.js")]).toEqual([0o755, 0o755, 0o755, 0o755, 0o644]);
  });

  it.skipIf(process.platform === "win32")("refuses a tree with a link before setting any mode, so nothing outside it changes", () => {
    for (const make of [(dir, outside) => symlinkSync(join(outside, "file"), join(dir, "app", "link")), (dir, outside) => symlinkSync(outside, join(dir, "app", "folder"))]) {
      const dir = scratch();
      const outside = scratch();
      write(dir, "app/main.js");
      write(outside, "file");
      chmodSync(join(outside, "file"), 0o600);
      chmodSync(outside, 0o700);
      chmodSync(join(dir, "app", "main.js"), 0o600);
      make(dir, outside);
      expect(() => normalizeModes(dir, [])).toThrow(/is not a regular file or a directory/);
      expect([statSync(outside).mode & 0o7777, statSync(join(outside, "file")).mode & 0o7777]).toEqual([0o700, 0o600]);
      // Nothing inside it was changed either.
      expect(statSync(join(dir, "app", "main.js")).mode & 0o7777).toBe(0o600);
    }
  });

  it("lays out the release output, the runtime and the notices in the fixed places", () => {
    const dir = scratch();
    const release = join(dir, "release");
    const releaseFiles = [
      "main.js",
      "build-info.js",
      "package.json",
      "native/addon.js",
      "native/urx-native.node",
      "launcher/urx",
      "maintenance/urx-uninstall",
      "node_modules/@urx/device-control/package.json",
    ];
    for (const path of releaseFiles) write(release, path);
    // Beside the release, not made by it: never copied.
    for (const path of ["release-files.json", "download.tar.gz", "native/measurements.txt", "launcher/notes.txt", "maintenance/notes.txt"]) write(release, path);
    const node = join(dir, "node-v26");
    write(node, "bin/node", "node");
    write(node, "LICENSE", "node license");
    write(dir, "LICENSE", "cli license");
    const staging = join(dir, "bundle");
    mkdirSync(staging);
    assemble({ release, releaseFiles, node, staging, platform: platformOf("darwin", "arm64"), notices: { "urx-cli.txt": join(dir, "LICENSE"), "node.txt": join(node, "LICENSE") } });
    expect(filesUnder(staging)).toEqual([
      "app/build-info.js",
      "app/main.js",
      "app/native/addon.js",
      "app/node_modules/@urx/device-control/package.json",
      "app/package.json",
      "bin/urx",
      "maintenance/urx-uninstall",
      "native/urx-native.node",
      "notices/node.txt",
      "notices/urx-cli.txt",
      "runtime/node",
    ]);
    expect(readFileSync(join(staging, "runtime", "node"), "utf8")).toBe("node");
  });

  it("refuses a record path outside the release output, and a file named twice", () => {
    const dir = scratch();
    const release = join(dir, "release");
    const named = ["main.js", "native/urx-native.node", "launcher/urx", "maintenance/urx-uninstall"];
    for (const path of named) write(release, path);
    write(dir, "outside.js");
    write(dir, "bin/node");
    write(release, "maintenance/other");
    const lay = (...extra) => {
      const staging = mkdtempSync(join(dir, "bundle-"));
      assemble({ release, releaseFiles: [...named, ...extra], node: dir, staging, platform: platformOf("darwin", "arm64"), notices: {} });
    };
    expect(() => lay("../outside.js")).toThrow(/a path outside it/);
    expect(() => lay("/outside.js")).toThrow(/a path outside it/);
    expect(() => lay("Main.js")).toThrow(/a file twice/);
    expect(() => lay("maintenance/other")).toThrow(/an unknown maintenance file/);
    // A macOS bundle cannot be without its removal tool (K20); a Windows one has none from the release.
    const without = mkdtempSync(join(dir, "bundle-"));
    expect(() =>
      assemble({ release, releaseFiles: named.filter((path) => !path.startsWith("maintenance/")), node: dir, staging: without, platform: platformOf("darwin", "arm64"), notices: {} }),
    ).toThrow(/names no maintenance\/urx-uninstall/);
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
