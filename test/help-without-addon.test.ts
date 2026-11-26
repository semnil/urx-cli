// Help and version must not load the addon (H5). The built CLI runs in a child
// Node that records every module it loads (a module load hook) and every native
// library it opens (`process.dlopen`, which a `.node` file goes through and the
// load hook does not see); nothing recorded may be under dist/native/. A
// type-only reference loads nothing and passes; any runtime import or open,
// direct or indirect, fails.

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
      'import { pathToFileURL } from "node:url";',
      'const record = (url) => appendFileSync(process.env.URX_LOADS_FILE, url + "\\n");',
      "registerHooks({",
      "  load(url, context, nextLoad) {",
      "    record(url);",
      "    return nextLoad(url, context);",
      "  },",
      "});",
      "const dlopen = process.dlopen;",
      "process.dlopen = function (module, filename, ...rest) {",
      "  record(pathToFileURL(filename).href);",
      "  return dlopen.call(this, module, filename, ...rest);",
      "};",
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

  it("would include the native library if something opened it directly", () => {
    const opener = join(scratch, "opener.mjs");
    writeFileSync(
      opener,
      `import { createRequire } from "node:module";\ncreateRequire(import.meta.url)(${JSON.stringify(join(dist, "native", "urx-native.node"))});\n`,
    );
    expect(loadsOf("opener", opener, []).filter((url) => url.startsWith(native))).toContain(`${native}urx-native.node`);
  });
});
