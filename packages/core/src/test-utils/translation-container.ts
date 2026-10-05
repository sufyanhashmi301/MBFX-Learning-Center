// Shared bootstrap for the Phase 5 machine-translation integration suites —
// factored out for the reason `cms-container.ts` gives: several files need the
// identical thing (a real MariaDB with en + es ACTIVE, a staff user, and Google
// switched on against the MSW fake at the network edge, testing.md).
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { MariaDbContainer, type StartedMariaDbContainer } from "@testcontainers/mariadb";
import type { db as DbClient } from "@repo/db";
import type { Subject } from "@repo/rbac";
import { generateSecretKey } from "@repo/secrets";
import { fakeGoogleTranslate } from "@repo/translate/testing";
import { setupServer, type SetupServer } from "msw/node";

const dbPackageRoot = fileURLToPath(new URL("../../../db", import.meta.url));
const prismaCli = createRequire(import.meta.url).resolve("prisma/build/index.js");

/** The key the fake accepts. */
export const FAKE_KEY = "AIza-test";

export interface TranslationTestContext {
  container: StartedMariaDbContainer;
  db: typeof DbClient;
  server: SetupServer;
  /** A STAFF subject holding exactly `permissions`. */
  editor: Subject;
  stop: () => Promise<void>;
}

/**
 * Starts the database, applies every migration, seeds en (default) and es
 * (active), creates a staff user and switches Google on through the real
 * settings service. The MSW server is listening; install a handler per test
 * with `useFakeGoogle`.
 */
export async function startTranslationTestDb(
  name: string,
  permissions: readonly string[],
): Promise<TranslationTestContext> {
  const container = await new MariaDbContainer("mariadb:11.4")
    .withDatabase(name)
    .withUsername("test")
    .withUserPassword("test")
    .start();
  const url = container.getConnectionUri().replace(/^mariadb:/, "mysql:");
  execFileSync(process.execPath, [prismaCli, "migrate", "deploy"], {
    cwd: dbPackageRoot,
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  process.env.DATABASE_URL = url;
  process.env.TRANSLATE_SECRET_KEY = generateSecretKey();
  const db = (await import("@repo/db")).db;
  const translate = await import("@repo/translate");

  const server = setupServer();
  server.listen({ onUnhandledRequest: "error" });

  const user = await db.user.create({
    data: {
      id: crypto.randomUUID(),
      email: `${name}@x.com`,
      name: "Editor",
      status: "ACTIVE",
      userType: "STAFF",
    },
  });
  await db.locale.createMany({
    data: [
      {
        code: "en",
        name: "English",
        nativeName: "English",
        isDefault: true,
        isActive: true,
        sortOrder: 1,
      },
      {
        code: "es",
        name: "Spanish",
        nativeName: "Español",
        isActive: true,
        sortOrder: 2,
        fallbackCode: "en",
      },
    ],
  });

  server.use(fakeGoogleTranslate({ validKey: FAKE_KEY }).handler);
  const saved = await translate.saveTranslateSettings(user.id, {
    kind: "GOOGLE",
    enabled: true,
    apiKey: FAKE_KEY,
    pricePerMillionChars: 20,
    monthlyCharBudget: null,
  });
  if (!saved.ok) throw new Error("could not switch the fake translator on");
  server.resetHandlers();

  return {
    container,
    db,
    server,
    editor: {
      id: user.id,
      userType: "STAFF",
      roleKeys: [],
      maxRoleLevel: 90,
      allowed: new Set(permissions),
      denied: new Set(),
    },
    stop: async () => {
      server.close();
      await db.$disconnect();
      await container.stop();
    },
  };
}

/** Installs the fake for one test; returns it so calls can be inspected. */
export function useFakeGoogle(
  server: SetupServer,
  options: Parameters<typeof fakeGoogleTranslate>[0] = {},
) {
  server.resetHandlers();
  const google = fakeGoogleTranslate({ validKey: FAKE_KEY, ...options });
  server.use(google.handler);
  return google;
}
