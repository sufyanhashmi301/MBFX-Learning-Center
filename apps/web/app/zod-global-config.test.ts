// instrumentation-client.ts switches Zod's JIT probe off WITHOUT importing
// Zod (an import put ~370 KB on every page; changes-62 #2/#5). It relies on
// Zod adopting a pre-existing `globalThis.__zod_globalConfig`. If an upgrade
// renames that key, the probe comes back and the CSP log fills with "eval
// blocked" again, so pin the contract here.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

describe("Zod's global config contract", () => {
  it("the installed Zod adopts globalThis.__zod_globalConfig and honours jitless", () => {
    const require = createRequire(import.meta.url);
    const root = dirname(require.resolve("zod/package.json"));
    const core = readFileSync(join(root, "v4/core/core.js"), "utf8");
    expect(core).toMatch(/__zod_globalConfig \?\? \(_a\.__zod_globalConfig = \{\}\)/);
    expect(core).toContain("export const globalConfig = globalThis.__zod_globalConfig;");
    const util = readFileSync(join(root, "v4/core/util.js"), "utf8");
    expect(util).toMatch(/if \(globalConfig\.jitless\) \{\s*return false;/);
  });

  it("instrumentation-client sets the flag and imports nothing", () => {
    const source = readFileSync(new URL("../instrumentation-client.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^import /m);
    expect(source).toContain("(zodGlobal.__zod_globalConfig ??= {}).jitless = true;");
  });
});
