// Help and version must not load the addon (H5). The built CLI runs in a child
// Node with a module hook that records every module it loads; no recorded
// module may be under dist/native/. A type-only reference loads nothing and
// passes; any runtime import, direct or indirect, fails.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));
let scratch: string;
let hook: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), "urx-loads-"));
  hook = join(scratch, "record-loads.mjs");
  writeFileSync(
    hook,
    [
      'import { appendFileSync } from "node:fs";',
      'import { registerHooks } from "node:module";',
      "registerHooks({",
      "  load(url, context, nextLoad) {",
      '    appendFileSync(process.env.URX_LOADS_FILE, url + "\\n");',
      "    return nextLoad(url, context);",
      "  },",
      "});",
      "",
    ].join("\n"),
  );
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** The URLs of the modules Node loads while running `script` with `args`. */
function loadsOf(name: string, script: string, args: readonly string[]): string[] {
  const record = join(scratch, `${name}.txt`);
  writeFileSync(record, "");
  execFileSync(process.execPath, ["--import", pathToFileURL(hook).href, script, ...args], {
    env: { ...process.env, URX_LOADS_FILE: record },
    stdio: ["ignore", "ignore", "ignore"],
  });
  return readFileSync(record, "utf8").split("\n").filter((line) => line.length > 0);
}

const native = pathToFileURL(join(dist, "native")).href + "/";

describe("modules the built CLI loads", () => {
  it("include no addon module for help or version", () => {
    for (const args of [["--help"], ["--version"], ["run", "--help"], []]) {
      const loads = loadsOf(`main-${args.join("-") || "bare"}`, join(dist, "main.js"), args);
      expect(loads, args.join(" ")).toContain(pathToFileURL(join(dist, "cli", "parse.js")).href);
      expect(loads.filter((url) => url.startsWith(native)), args.join(" ")).toEqual([]);
    }
  });

  it("would include the addon module if something imported it", () => {
    const importer = join(scratch, "importer.mjs");
    writeFileSync(importer, `import ${JSON.stringify(pathToFileURL(join(dist, "native", "addon.js")).href)};\n`);
    expect(loadsOf("importer", importer, []).filter((url) => url.startsWith(native))).toContain(`${native}addon.js`);
  });
});
