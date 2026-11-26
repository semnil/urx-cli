// Help and version must not load the addon (H5): no module that main.ts reaches
// through static imports may be under src/native/.

import { readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = fileURLToPath(new URL("./", import.meta.url));

/** The local modules reachable from `entry` through static `import ... from "./x.js"` statements. */
function staticGraph(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(/^\s*(?:import|export)\s[^;]*?from\s+"(\.[^"]+)"/gms)) {
      visit(join(dirname(file), (match[1] as string).replace(/\.js$/, ".ts")));
    }
  };
  visit(entry);
  return [...seen].map((file) => relative(source, file).replaceAll("\\", "/")).sort();
}

describe("the one-shot entry point", () => {
  it("reaches no addon module through static imports", () => {
    const graph = staticGraph(join(source, "main.ts"));
    expect(graph).toContain("cli/parse.ts");
    expect(graph.filter((file) => file.startsWith("native/"))).toEqual([]);
  });

  it("finds the addon module from a file that imports it", () => {
    expect(staticGraph(join(source, "native", "addon.test.ts"))).toContain("native/addon.ts");
  });
});
