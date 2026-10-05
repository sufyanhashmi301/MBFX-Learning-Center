// One human-readable date format for the whole site.
//
// The quiz editor handed `toISOString()` to `ContentStatusPanel`, which prints
// its props verbatim, so an editor read "Scheduled for: 2026-09-18T04:00:00.000Z".
// The other four editors formatted first — each with its own
// `new Intl.DateTimeFormat`, one of ~25 private copies, a few of which printed
// `2026-09-17` instead. `formatDate`/`formatDateTime` (`@repo/utils`) are now
// the only definition; this guard keeps the copies from growing back.
//
// ISO stays correct where a MACHINE reads it (`<time dateTime>`, JSON-LD,
// OpenGraph, API bodies, a filename stamp), which is why the guard looks for
// the display shapes rather than banning `toISOString` outright.
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(process.cwd(), "app");

// The cancelled Website Builder (ADR-042) is retained, not maintained. The
// tool widgets format CLOCK times and numbers, not dates.
const OUT_OF_SCOPE = [
  "keystone/website/",
  "keystone\\website\\",
  "tools/_widgets/",
  "tools\\_widgets\\",
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")
      ? [path]
      : [];
  });
}

const files = sourceFiles(ROOT).filter((path) => !OUT_OF_SCOPE.some((f) => path.includes(f)));

/** A private date formatter: an Intl constructor or an inline `dateStyle`. */
function privateDateFormats(src: string): string[] {
  return [
    ...src.matchAll(/new Intl\.DateTimeFormat\([^)]*dateStyle[^)]*\)/g),
    ...src.matchAll(/\{\s*dateStyle:\s*"[a-z]+"[^}]*\}/g),
    ...src.matchAll(/\.toLocaleDateString\(/g),
  ].map((m) => m[0]);
}

// ISO that deliberately crosses to the client, which formats it itself.
const ISO_FOR_CLIENT = [
  // The notification bell renders it as relative time ("3 hours ago").
  // Mapped in one loader since changes-65, shared by the shell and the bell's feed.
  "notification-items.ts: createdAt: n.createdAt.toISOString()",
];

/** ISO rendered to a person: a day slice used as a value, or a date prop. */
function isoOnScreen(src: string): string[] {
  return [
    // `{x.toISOString().slice(0, 10)}` in JSX or `key: x.toISOString().slice(0, 10)`
    // in props — not `const key = …`, which is a grouping key nobody reads.
    ...src.matchAll(/(?:\{|:)\s*[\w.]+\??\.toISOString\(\)\.slice\(0, 10\)/g),
    ...src.matchAll(
      /(publishedAt|scheduledFor|updatedAt|createdAt)\??:\s*[\w.]+\??\.toISOString\(\)/g,
    ),
  ].map((m) => m[0]);
}

describe("one human-readable date format", () => {
  it("scans the app at all", () => {
    expect(files.length).toBeGreaterThan(200);
  });

  it("recognises the shapes it forbids (guards the guard)", () => {
    expect(
      privateDateFormats('new Intl.DateTimeFormat("en", { dateStyle: "medium" })'),
    ).not.toHaveLength(0);
    expect(isoOnScreen("updatedAt: detail.updatedAt.toISOString(),")).toHaveLength(1);
    expect(isoOnScreen("<dd>{user.createdAt.toISOString().slice(0, 10)}</dd>")).toHaveLength(1);
    expect(isoOnScreen("dateTime={item.date.toISOString()}")).toHaveLength(0);
  });

  it("no screen builds its own date formatter", () => {
    const offenders = files.flatMap((path) =>
      privateDateFormats(readFileSync(path, "utf8")).map((hit) => `${path}: ${hit}`),
    );
    expect(offenders).toEqual([]);
  });

  it("no screen prints an ISO timestamp", () => {
    const offenders = files.flatMap((path) =>
      isoOnScreen(readFileSync(path, "utf8"))
        .map((hit) => `${path}: ${hit}`)
        .filter((line) => !ISO_FOR_CLIENT.some((allowed) => line.endsWith(allowed))),
    );
    expect(offenders).toEqual([]);
  });
});
