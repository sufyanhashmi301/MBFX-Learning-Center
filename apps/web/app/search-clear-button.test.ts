// A search field shows ONE clear button (2026-10-06).
//
// Two bugs drew a second ×. The browser draws its own clear button on any
// `type="search"` input (`SearchInput` defaults to that type), so the
// glossary and learn shelves showed it beside ours. And the glossary's own
// button used `inset-inline-end-2`, which is not a Tailwind class, so it was
// never pinned to the field's end. Read as source, like `grid-base`.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOTS = [resolve(process.cwd(), "app"), resolve(process.cwd(), "../../packages/ui/src")];

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

describe("search clear button", () => {
  it("hides the browser's native clear button on search inputs", () => {
    const css = readFileSync(
      resolve(process.cwd(), "../../packages/ui/src/styles/globals.css"),
      "utf8",
    );
    expect(css).toMatch(/input\[type="search"\]::-webkit-search-cancel-button/);
  });

  it("uses no `inset-inline-*` class, which Tailwind does not generate", () => {
    const offenders = ROOTS.flatMap(tsxFiles).filter((file) =>
      /className=[^\n]*\binset-inline-(start|end)-/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });
});
