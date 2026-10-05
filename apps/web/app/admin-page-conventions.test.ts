// changes-20 Phase 5 — the admin frame is `@repo/ui`, and every live screen
// has a title AND a description (ADR-044 #8).
//
// `AdminPage` keeps `description` optional in its TYPE only because the
// paused and cancelled surfaces (ADR-038/042) are out of ADR-044's scope, so
// the type cannot enforce it; this does. The second half stops the local
// re-implementations Phase 5 deleted from growing back: the shell composes
// PageHeader, Card, NavItem, Breadcrumb, MetricCard and FilterBarRow, and a
// token is referenced as `h-(--x)`, never `h-[var(--x)]`.
//
// Read as source, like `admin-dialog-conventions.test.ts`: these are async
// server components behind a session.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ADMIN_ROOT = resolve(process.cwd(), "app/(admin)");
const COMPONENTS = resolve(ADMIN_ROOT, "keystone/_components");

// The Website Builder (ADR-042), the homepage composer and the navigation
// reorder screen (ADR-038) — the surfaces ADR-044 leaves out.
const OUT_OF_SCOPE = ["website", "homepage", "navigation"].flatMap((dir) => [
  `keystone\\${dir}\\`,
  `keystone/${dir}/`,
]);

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return tsxFiles(path);
    return entry.isFile() && entry.name.endsWith(".tsx") ? [path] : [];
  });
}

const inScope = tsxFiles(ADMIN_ROOT).filter(
  (path) => !OUT_OF_SCOPE.some((fragment) => path.includes(fragment)),
);

/** The attribute text of every `<Tag …>` opening element in `src`. A `>`
 * inside `{…}` (an arrow, a JSX prop) does not end the tag. */
function openingTags(src: string, tag: string): string[] {
  const tags: string[] = [];
  let from = 0;
  for (;;) {
    const start = src.indexOf(`<${tag}`, from);
    if (start === -1) return tags;
    const next = src[start + tag.length + 1];
    from = start + tag.length + 1;
    if (next !== undefined && /[A-Za-z0-9]/.test(next)) continue; // <AdminPageHeading ≠ <AdminPage
    let depth = 0;
    let end = from;
    for (; end < src.length; end++) {
      const ch = src[end];
      if (ch === "{") depth++;
      else if (ch === "}") depth--;
      else if (ch === ">" && depth === 0) break;
    }
    tags.push(src.slice(start, end));
  }
}

const HEADED = ["AdminPage", "AdminPageHeading", "SettingsScreen", "EditorPage"];
const headedScreens = inScope
  .map((path) => ({ path, src: readFileSync(path, "utf8") }))
  .flatMap(({ path, src }) =>
    HEADED.flatMap((tag) =>
      openingTags(src, tag).map((attrs) => ({
        name: `${path.slice(ADMIN_ROOT.length + 1)} <${tag}>`,
        attrs,
      })),
    ),
  )
  .filter(({ name }) => !name.includes("_components")); // the wrappers themselves

describe("ADR-044 #8 — every live admin screen has a title and a description", () => {
  it("finds screens to check at all", () => {
    expect(headedScreens.length).toBeGreaterThan(25);
  });

  it.each(headedScreens.map((s) => [s.name, s.attrs] as const))("%s", (_name, attrs) => {
    expect(attrs).toMatch(/\btitle=/);
    expect(attrs).toMatch(/\bdescription=/);
  });
});

describe("changes-20 Phase 5 — the admin frame is @repo/ui", () => {
  const read = (file: string) => readFileSync(resolve(COMPONENTS, file), "utf8");

  it("the page heading is PageHeader and the section is Card", () => {
    const src = read("admin-page.tsx");
    expect(src).toContain('from "@repo/ui/components/page-header"');
    expect(src).toContain('from "@repo/ui/components/card"');
    // The retired hand-typed recipes.
    expect(src).not.toContain("text-2xl font-semibold");
    expect(src).not.toMatch(/rounded-lg border bg-card p-\d/);
  });

  it.each([
    ["admin-sidebar-nav.tsx", "@repo/ui/components/nav-item"],
    ["breadcrumbs.tsx", "@repo/ui/components/breadcrumb"],
    ["dashboard-stat-card.tsx", "@repo/ui/components/metric-card"],
  ])("%s composes %s", (file, module) => {
    expect(read(file)).toContain(`from "${module}"`);
  });

  it("there is no local FilterBar — DataTable filters group in FilterBarRow", () => {
    expect(existsSync(resolve(COMPONENTS, "filter-bar.tsx"))).toBe(false);
  });

  it.each(inScope.map((path) => [path.slice(ADMIN_ROOT.length + 1), path] as const))(
    "%s references tokens as (--x), not [var(--x)]",
    (_name, path) => {
      expect(readFileSync(path, "utf8")).not.toMatch(/-\[var\(--[a-z-]+\)\]/);
    },
  );
});

describe("ADR-044 #5 — the breadcrumb never prints a record id", () => {
  // Admin visual pass: /keystone/users/<cuid> rendered "zwV2IP9bE6Ff…" as its
  // last crumb. The record's name is the page's h1; the crumb says "Details".
  const src = readFileSync(resolve(COMPONENTS, "breadcrumbs.tsx"), "utf8");

  it("labels an id segment from the catalog", () => {
    expect(src).toContain('t("breadcrumbDetail")');
    const en = JSON.parse(
      readFileSync(resolve(process.cwd(), "../../packages/i18n/messages/en.json"), "utf8"),
    );
    expect(en.admin.breadcrumbDetail).toBeTruthy();
  });

  it("does not slice the id into the label", () => {
    expect(src).not.toMatch(/segment\.slice\(/);
  });
});

describe("the breadcrumb never links to a route that does not exist", () => {
  // Admin visual pass: "Learning" linked to /keystone/learn, which has no page.
  // Every static admin folder with no page.tsx must be a GROUP segment
  // (rendered as text); a new such folder fails here until it is listed.
  const src = readFileSync(resolve(COMPONENTS, "breadcrumbs.tsx"), "utf8");
  const listed = new Set(
    [
      ...(src.match(/GROUP_SEGMENTS = new Set\(\[([^\]]*)\]\)/)?.[1] ?? "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]),
  );
  const ADMIN = resolve(ADMIN_ROOT, "keystone");
  /**
   * Does this folder answer its own URL? Its own `page.tsx`, or one inside a
   * route GROUP it contains — `(group)` adds no URL segment, so
   * `articles/(browse)/page.tsx` is what `/keystone/articles` renders (ADR-106).
   * Reading only the folder's own `page.tsx` called that a dead crumb.
   */
  const hasPage = (dir: string): boolean =>
    existsSync(resolve(dir, "page.tsx")) ||
    readdirSync(dir, { withFileTypes: true }).some(
      (entry) =>
        entry.isDirectory() && entry.name.startsWith("(") && hasPage(resolve(dir, entry.name)),
    );
  const pageless = (dir: string, rel = ""): string[] =>
    readdirSync(dir, { withFileTypes: true })
      .filter(
        (e) =>
          e.isDirectory() &&
          // Private (_x), dynamic ([x]), grouped ((x)) and encoded (%5F) folders
          // never appear as a static crumb; `api` holds route handlers, not
          // screens.
          !/^[_[(%]/.test(e.name) &&
          e.name !== "api" &&
          !OUT_OF_SCOPE.some((f) => `keystone/${rel}${e.name}/`.includes(f)),
      )
      .flatMap((e) => {
        const path = resolve(dir, e.name);
        // Or a SIBLING group answers it: `glossary/topics/` holds only the
        // `[id]` editor, and `/keystone/glossary/topics` is the tab at
        // `glossary/(browse)/topics/page.tsx` (changes-48 #3).
        const answered =
          hasPage(path) ||
          readdirSync(dir, { withFileTypes: true }).some(
            (group) =>
              group.isDirectory() &&
              group.name.startsWith("(") &&
              existsSync(resolve(dir, group.name, e.name)) &&
              hasPage(resolve(dir, group.name, e.name)),
          );
        const own = answered ? [] : [e.name];
        return [...own, ...pageless(path, `${rel}${e.name}/`)];
      });

  it("finds the GROUP_SEGMENTS list", () => {
    expect(listed.size).toBeGreaterThan(0);
  });

  it.each(pageless(ADMIN))("%s is a group segment", (name) => {
    expect(listed.has(name)).toBe(true);
  });
});

describe("the design-system board has one h1", () => {
  const src = readFileSync(
    resolve(ADMIN_ROOT, "keystone/design-system/design-system-client.tsx"),
    "utf8",
  );

  it("renders every PageHeader specimen as an h2 (only the board's own header is the h1)", () => {
    const headers = (src.match(/<PageHeader\b/g) ?? []).length;
    const demoted = (src.match(/titleRender=\{<h2 \/>\}/g) ?? []).length;
    expect(headers).toBeGreaterThan(1);
    expect(demoted).toBe(headers - 1);
  });
});

describe("the admin top bar fits a phone", () => {
  // Admin phone-width pass: Button's recipe is `shrink-0`, so the w-full ⌘K
  // trigger held 256px and pushed the theme toggle and avatar 74px past a
  // 390px screen. It is the one top-bar item that must give way.
  it("lets the search trigger shrink", () => {
    const src = readFileSync(resolve(COMPONENTS, "admin-search.tsx"), "utf8");
    expect(src).toMatch(/className="[^"]*\bw-full\b[^"]*\bmin-w-0\b[^"]*\bshrink\b(?!-)/);
  });
});

describe("ADR-140 §3 — an editor's heading is static, and its actions share the row", () => {
  // The record's title is the editor's first field. Repeating it as the h1 at
  // page-title size is what pushed Save / Preview / View live onto a second
  // row, so the heading is a catalog string ("Edit course") and never an
  // expression over the loaded record.
  // ADR-142 §4: the three PERSON records are not editors. They have no title
  // field for the heading to repeat, and the owner's reference puts the
  // person's name in the heading with their id and address under it, so a
  // support admin knows at a glance whose account they are about to change.
  const RECORD_PAGES = /[\\/](users|employees|newsletter)[\\/]\[id\][\\/]page\.tsx$/;
  const editorRoutes = inScope.filter(
    (path) =>
      /[\\/](\[[a-z]+\]|new)[\\/]page\.tsx$/.test(path) &&
      // `settings/[group]` is a form, not a record. The AI provider editor
      // moved under settings in changes-51 and is still an editor.
      !/[\\/]settings[\\/]\[group\][\\/]/.test(path) &&
      !RECORD_PAGES.test(path),
  );

  it("exempts exactly the three person records", () => {
    expect(inScope.filter((path) => RECORD_PAGES.test(path))).toHaveLength(3);
  });
  // `title={t("…")}` or a catalog key picked by kind, `title={t(`….${kind}`)}`.
  const RECORD_TITLE = /\btitle=\{(?!\s*t(?:Ai)?\(["`])/;

  it("finds editor routes to check at all", () => {
    expect(editorRoutes.length).toBeGreaterThan(10);
  });

  it.each(editorRoutes.map((path) => [path.slice(ADMIN_ROOT.length + 1), path] as const))(
    "%s titles its page from the catalog",
    (_name, path) => {
      const src = readFileSync(path, "utf8");
      for (const tag of [...openingTags(src, "AdminPage"), ...openingTags(src, "EditorPage")]) {
        expect(tag).not.toMatch(RECORD_TITLE);
      }
    },
  );

  const EDITORS = [
    "articles/[id]/article-editor.tsx",
    "glossary/[id]/glossary-editor.tsx",
    "glossary/topics/[id]/topic-editor.tsx",
    "learn/courses/[id]/course-editor.tsx",
    "learn/lessons/[id]/lesson-editor.tsx",
    "learn/quizzes/[id]/quiz-editor.tsx",
    "learn/videos/[id]/video-editor.tsx",
    "tools/[key]/tool-editor.tsx",
  ];

  it.each(EDITORS)("%s portals its actions into the heading row", (file) => {
    const src = readFileSync(resolve(ADMIN_ROOT, "keystone", file), "utf8");
    expect(src).toContain("<HeaderActions>");
    // The old free-standing sticky bar under the heading.
    expect(src).not.toMatch(/sticky top-\(--height-header\)/);
  });

  it.each(EDITORS)("%s's page renders the pinned EditorPage frame", (file) => {
    const page = resolve(ADMIN_ROOT, "keystone", file.replace(/[^/]+$/, "page.tsx"));
    expect(readFileSync(page, "utf8")).toContain("<EditorPage");
  });
});

describe("changes-65 — the portal root is never a crumb", () => {
  // The trail read "Keystone > Learning > Lessons > Details": the root segment
  // humanised into a crumb that links to the staff sign-in.
  const src = readFileSync(resolve(COMPONENTS, "breadcrumbs.tsx"), "utf8");

  it("drops the keystone segment before labelling", () => {
    expect(src).toContain('const ROOT_SEGMENT = "keystone"');
    expect(src).toMatch(/all\.slice\(base\)/);
  });

  it("keeps the full /keystone path in each crumb's href", () => {
    expect(src).toMatch(/all\.slice\(0, base \+ index \+ 1\)/);
  });
});
