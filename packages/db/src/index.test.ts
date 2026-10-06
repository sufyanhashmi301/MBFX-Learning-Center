import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { TRANSACTION_OPTIONS, UserType, db } from "./index.ts";

describe("@repo/db", () => {
  it("exports the client singleton and generated enums without needing a live DB connection", () => {
    // The client is a lazy Proxy (see index.ts) — importing the module and
    // reading a re-exported enum must not touch DATABASE_URL at all.
    expect(db).toBeDefined();
    expect(UserType.LEARNER).toBe("LEARNER");
    expect(UserType.STAFF).toBe("STAFF");
  });

  // Regression (2026-10-06): a production build with a second live language
  // failed when a relation read's implicit transaction outlived Prisma's 5 s
  // default under prerender load. The client must be built with roomier limits.
  it("builds the client with transaction limits above Prisma's defaults", () => {
    expect(TRANSACTION_OPTIONS.timeout).toBeGreaterThan(5_000);
    expect(TRANSACTION_OPTIONS.maxWait).toBeGreaterThan(2_000);
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(source).toMatch(
      /new PrismaClient\(\{ adapter, transactionOptions: TRANSACTION_OPTIONS \}\)/,
    );
  });
});
