// Loads a copied CLI's modules for the release output and bundle checks:
// each module at the given file URLs, with what it imports, and also every
// module it imports only when it runs (a dynamic `import("./…")`), so a module
// a command loads on demand has to be in the copy too. A dynamic import this
// cannot follow, a computed or bare specifier, fails the check rather than
// going unchecked.

import { readFileSync } from "node:fs";

const DYNAMIC = /\bimport\(/g;
const RELATIVE = /\bimport\(\s*(["'])(\.\.?\/[^"']*)\1\s*\)/g;

export async function loadModules(urls) {
  for (const url of urls) {
    await import(url);
    const text = readFileSync(new URL(url), "utf8");
    const followed = [...text.matchAll(RELATIVE)].map((match) => match[2]);
    if (followed.length !== [...text.matchAll(DYNAMIC)].length) throw new Error(`${url} has a dynamic import this check cannot follow`);
    for (const specifier of followed) await import(new URL(specifier, url).href);
  }
}
