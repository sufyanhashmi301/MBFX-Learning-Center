// Fills a locale's PUBLIC catalog from en.json by machine translation
// (plan §4.4, ADR-160). Dev-run, once per language, before the activation PR.
//
//   pnpm translate:catalog -- --locale ar            # the chosen provider, through the door
//   pnpm translate:catalog -- --locale ar --fake     # no network, no database
//   pnpm translate:catalog -- --locale ar --dry-run  # report only, write nothing
//
// What it will and will not do:
//
//   - It fills MISSING keys only. A value already in `<locale>.json` is a
//     person's (or an earlier run's) and is never overwritten.
//   - Admin namespaces are skipped: the portal is English-only (ADR-043).
//   - Arguments, tags and plurals go through `translateCatalogMessages`
//     (src/icu.ts); a message it cannot translate safely is left missing and
//     listed, never written broken.
//   - Keys whose plural forms were rebuilt for the target language are listed
//     in a review file, for a person to read before the PR merges.
//
// The real run goes through `translateSegments`, so it is metered, budgeted
// and needs Settings → Translation switched on, exactly like the site.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { translateCatalogMessages } from "../src/icu.ts";

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
const MESSAGES_DIR = join(REPO_ROOT, "packages", "i18n", "messages");

// The same split `scripts/check-catalog-completeness.mjs` enforces
// (ADMIN_NAMESPACES there). A namespace not listed is public.
const ADMIN_NAMESPACES = new Set(["admin", "cms"]);

type Tree = { [key: string]: string | Tree };

function flatten(
  tree: Tree,
  prefix = "",
  out: Record<string, string> = {},
): Record<string, string> {
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") out[path] = value;
    else flatten(value, path, out);
  }
  return out;
}

/**
 * The target tree in en.json's key order: existing target values win, new
 * translations fill the gaps, admin namespaces keep only what the target
 * already had, and keys only the target has are kept at the end.
 */
function merge(en: Tree, target: Tree, added: Record<string, string>, prefix = ""): Tree {
  const out: Tree = {};
  for (const [key, value] of Object.entries(en)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const existing = target[key];
    if (!prefix && ADMIN_NAMESPACES.has(key)) {
      if (existing !== undefined) out[key] = existing;
      continue;
    }
    if (typeof value === "string") {
      if (typeof existing === "string") out[key] = existing;
      else if (added[path] !== undefined) out[key] = added[path];
    } else {
      const child = merge(value, typeof existing === "object" ? existing : {}, added, path);
      if (Object.keys(child).length > 0) out[key] = child;
    }
  }
  for (const [key, value] of Object.entries(target)) {
    if (!(key in out)) out[key] = value;
  }
  return out;
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      locale: { type: "string" },
      fake: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });
  const locale = values.locale;
  if (!locale || !/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) || locale === "en") {
    console.error("Usage: translate-catalog --locale <code> [--fake] [--dry-run]");
    return 2;
  }

  const en = JSON.parse(readFileSync(join(MESSAGES_DIR, "en.json"), "utf8")) as Tree;
  const targetPath = join(MESSAGES_DIR, `${locale}.json`);
  const target = existsSync(targetPath)
    ? (JSON.parse(readFileSync(targetPath, "utf8")) as Tree)
    : {};

  const have = flatten(target);
  const missing = Object.fromEntries(
    Object.entries(flatten(en)).filter(
      ([key]) => !ADMIN_NAMESPACES.has(key.split(".")[0] ?? "") && typeof have[key] !== "string",
    ),
  );
  const count = Object.keys(missing).length;
  const characters = Object.values(missing).reduce((sum, m) => sum + m.length, 0);
  console.log(`${locale}: ${count} public keys missing (${characters} characters of English).`);
  if (count === 0) return 0;
  if (values["dry-run"]) return 0;

  let translateUnits: (units: string[]) => Promise<string[]>;
  if (values.fake) {
    translateUnits = async (units) => units.map((unit) => `[${locale}] ${unit}`);
  } else {
    // The real run needs the database (provider row, usage, budget). Load the
    // repo's .env before `@repo/db` is imported: the client reads it lazily.
    const envFile = join(REPO_ROOT, ".env");
    if (existsSync(envFile)) process.loadEnvFile(envFile);
    const { translateSegments } = await import("../src/translate.ts");
    translateUnits = (units) =>
      translateSegments(units, "html", {
        source: "en",
        target: locale,
        entity: { type: "catalog", id: locale },
      });
  }

  const result = await translateCatalogMessages(missing, locale, translateUnits);
  const merged = merge(en, target, result.translated);
  writeFileSync(targetPath, `${JSON.stringify(merged, null, 2)}\n`, "utf8");

  const reviewPath = join(tmpdir(), `translate-catalog.${locale}.review.txt`);
  const lines = [
    `# ${locale}: plural forms rebuilt — read each before the activation PR merges`,
    ...result.review,
    "",
    "# Not translated (left missing, fill by hand):",
    ...result.failed.map((f) => `${f.key}\t${f.reason}`),
    "",
  ];
  writeFileSync(reviewPath, lines.join("\n"), "utf8");

  console.log(
    `Wrote ${Object.keys(result.translated).length} keys to ${targetPath}.\n` +
      `${result.review.length} with rebuilt plurals, ${result.failed.length} not translated.\n` +
      `Review list: ${reviewPath}`,
  );
  return result.failed.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error((error as Error).message);
    process.exit(1);
  },
);
