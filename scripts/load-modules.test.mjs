import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { loadModules } from "./load-modules.mjs";

const temporary = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});
/** A directory of ES modules with the given sources, and the file URL of each. */
const modules = (sources) => {
  const dir = mkdtempSync(join(tmpdir(), "urx-load-modules-"));
  temporary.push(dir);
  writeFileSync(join(dir, "package.json"), `${JSON.stringify({ type: "module" })}\n`);
  for (const [name, source] of Object.entries(sources)) writeFileSync(join(dir, name), source);
  return (name) => pathToFileURL(join(dir, name)).href;
};

describe("loading a copied CLI's modules", () => {
  it("loads the modules a module imports only when it runs", async () => {
    const url = modules({ "main.js": 'export const run = () => import("./command.js");\n', "command.js": "export const ok = true;\n" });
    await expect(loadModules([url("main.js")])).resolves.toBeUndefined();
  });

  it("fails when a module imported on demand is missing", async () => {
    const url = modules({ "main.js": 'export const run = () => import("./command.js");\n' });
    await expect(loadModules([url("main.js")])).rejects.toThrow();
  });

  it("fails on a dynamic import it cannot follow", async () => {
    const url = modules({ "main.js": "export const run = (name) => import(name);\n" });
    await expect(loadModules([url("main.js")])).rejects.toThrow(/cannot follow/);
  });
});
