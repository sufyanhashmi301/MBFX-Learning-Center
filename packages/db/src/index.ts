// @repo/db — Prisma client singleton.
//
// The only package that imports the generated client directly. Everything
// else in the monorepo imports from here (architecture.md #8: route handlers
// and server actions never touch Prisma directly either — they go through
// @repo/core, which imports this singleton).
import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "./generated/client/client.ts";
import * as generatedNamespace from "./generated/client/internal/prismaNamespace.ts";

declare global {
  var __prisma: { client: PrismaClient; shape: string } | undefined;
}

// The generated schema's SHAPE: every model and every column, as the model-name
// and scalar-field enums spell them. Two copies of the same generated client
// agree on it; a client generated from a different schema does not.
const SCHEMA_SHAPE = JSON.stringify(
  Object.entries(generatedNamespace)
    .filter(([name]) => name === "ModelName" || name.endsWith("ScalarFieldEnum"))
    .sort(([a], [b]) => a.localeCompare(b)),
);

/**
 * The default limits of every transaction that does not set its own —
 * including the IMPLICIT one Prisma opens around a read that loads a relation
 * (`findUnique({ select: { translations: … } })`), which is the case nobody
 * sees in the source.
 *
 * Prisma's defaults are `maxWait` 2 s and `timeout` 5 s, and the timeout
 * counts from the start, time queued behind other queries included. A
 * production build prerenders every page of every LIVE language at once (five
 * workers, each with its own pool), so switching Urdu on was enough to push
 * one settings read past 5 s, and `next build` failed on `/ur/glossary` with
 * "A rollback cannot be executed on an expired transaction" (2026-10-06).
 * These are ceilings, not targets: a fast query is no slower for them.
 */
export const TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

function createClient() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  const adapter = new PrismaMariaDb(url);
  return new PrismaClient({ adapter, transactionOptions: TRANSACTION_OPTIONS });
}

// Lazy: DATABASE_URL isn't necessarily set yet at *import* time — ESM hoists
// import evaluation above any same-file dotenv-loading code that textually
// precedes it (seed.ts learned this the hard way), and Next.js itself only
// guarantees .env is loaded before request handling, not before module
// graph construction. Building the client on first property access instead
// of at module load sidesteps needing every consumer to get import order
// exactly right.
//
// Reused across Next.js dev-server hot reloads so each edit doesn't open a
// fresh MariaDB connection pool — but only while the generated SCHEMA is the
// same one. `prisma generate` after a schema change reloads this module with a
// new PrismaClient, and an instance of the old one has no delegate for the new
// model: `db.reviewPlatform` was `undefined` until the dev server restarted.
//
// The test is the schema's shape, NOT the class's identity. Next's dev server
// bundles this package once per layer (RSC, SSR, route handlers), each with
// its own PrismaClient class, so `ctor === PrismaClient` failed on every
// cross-layer call: each layer disconnected the other's pool mid-query, and
// Better Auth's session update died with "connection closed" (45013).
function currentClient(): PrismaClient {
  const cached = globalThis.__prisma;
  if (cached?.shape === SCHEMA_SHAPE) return cached.client;
  void cached?.client.$disconnect().catch(() => {});
  const client = createClient();
  globalThis.__prisma = { client, shape: SCHEMA_SHAPE };
  return client;
}

export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    return Reflect.get(currentClient() as object, prop, receiver);
  },
});

export * from "./generated/client/enums.ts";
export type * from "./generated/client/models.ts";
// `Prisma.TransactionClient` — the type of the `tx` callback parameter of
// `db.$transaction(async (tx) => ...)`. Needed by any @repo/core service
// (Module 16's cms/* is the first) that factors transaction steps into a
// separate exported function instead of one inline callback.
export type { Prisma } from "./generated/client/client.ts";

// The JSON-null sentinels, as VALUES (changes-29 B4).
//
// `Prisma` above is a type-only export, so `Prisma.DbNull` is not reachable
// through it. A nullable `Json` column needs the distinction these two carry:
// `DbNull` is the COLUMN being SQL NULL, `JsonNull` is the column holding the
// JSON value `null`. Writing a bare `null` does not typecheck, and picking the
// wrong one of the two is the kind of bug that only shows up in a reader.
export { DbNull, JsonNull } from "./generated/client/internal/prismaNamespace.ts";

// The starting CONTENT of every email template (Module 17, ADR-078 #5) — read
// by `prisma/seed.ts` on a fresh database and by @repo/core's
// `resetEmailTemplate()` when an admin reverts one.
export {
  EMAIL_TEMPLATE_DEFAULTS,
  emailTemplateDefault,
  type EmailTemplateDefault,
} from "./email-template-defaults.ts";

// Which permissions nothing below `super_admin` may hold (security.md #4,
// ADR-078 #4). Read by `prisma/seed.ts` when it builds the `admin` role.
export {
  SUPER_ADMIN_ONLY_PERMISSIONS,
  isSuperAdminOnlyPermission,
  type SuperAdminOnlyPermission,
} from "./role-exclusions.ts";

// The role editor's permission cards, in order (ADR-083). Read by
// `prisma/seed.ts` when it assigns each permission a group, and by
// @repo/core's `loadRoleMatrix()` when it orders them for the screen.
export {
  PERMISSION_GROUPS,
  CONTENT_LIFECYCLE_GROUPS,
  PERMISSION_SECTIONS,
  PERMISSION_GROUP_SECTIONS,
  UNUSED_PERMISSIONS,
  isUnusedPermission,
  permissionGroupOrder,
  permissionGroupSection,
  type PermissionGroupName,
  type PermissionSectionName,
} from "./permission-groups.ts";

// Which settings are translatable (ADR-165 #1), for the seed's
// `isTranslatable` column. Mirrors `TRANSLATABLE_SETTINGS` in @repo/contracts;
// @repo/settings' test holds the two equal.
export { TRANSLATABLE_SETTING_KEY_LIST } from "./translatable-settings.ts";

// ADR-169: the review platforms the seed creates, held equal to
// `REVIEW_PLATFORM_KEYS` (@repo/contracts) by a @repo/core test.
export { REVIEW_PLATFORM_SEED_KEYS, REVIEW_PLATFORM_SEED_DEFAULTS } from "./review-platforms.ts";
