// changes-62 #2: the modules public client components read on EVERY page must
// not load Zod. One value import of a schema-building module evaluates its
// `z.object(...)` calls at load time, and the `z` namespace keeps all of Zod
// (~370 KB, every locale and the JSON Schema converter) in the bundle.
//
// The fix was to split these out of their schema modules; this guards the
// split. A type import is fine (erased); a value import of another contracts
// module is not, because that module may build schemas.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const ZOD_FREE = [
  "routes.ts",
  "account-paths.ts",
  "newsletter-honeypot.ts",
  "promotion-rules.ts",
  "captcha-names.ts",
] as const;

const source = (file: string) =>
  readFileSync(new URL(`../../../packages/contracts/src/${file}`, import.meta.url), "utf8");

describe("contracts modules a browser loads on every page", () => {
  it.each(ZOD_FREE)("%s imports no Zod and no other module's values", (file) => {
    const code = source(file);
    expect(code).not.toMatch(/from "zod/);
    const valueImports = [...code.matchAll(/^import (?!type )[^;]*;/gm)].map((m) => m[0]);
    expect(valueImports).toEqual([]);
  });

  it.each(ZOD_FREE)("%s is exported from the barrel", (file) => {
    expect(source("index.ts")).toContain(`export * from "./${file}";`);
  });
});
