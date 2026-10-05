// ADR-160 #4 — **one reader** of the sealed key, and one door to Google,
// asserted as source guards (`@repo/ai`'s provider.test.ts is the precedent):
// which FILE does something is an invariant no runtime assertion can express.
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SRC = dirname(fileURLToPath(import.meta.url));

function sourceFiles(): string[] {
  return readdirSync(SRC).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
}

function withoutComments(source: string): string {
  return source.replaceAll(/\/\*[\s\S]*?\*\//g, "").replaceAll(/\/\/.*$/gm, "");
}

describe("the sealed key has exactly one reader", () => {
  it("selects apiKeyCipher in provider.ts and nowhere else", () => {
    const readers = sourceFiles().filter((file) =>
      /apiKeyCipher:\s*true/.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(readers).toEqual(["provider.ts"]);
  });

  it("opens the seal in provider.ts and nowhere else", () => {
    const openers = sourceFiles().filter(
      (file) =>
        file !== "secret.ts" && /openTranslateKey\(/.test(readFileSync(join(SRC, file), "utf8")),
    );
    expect(openers).toEqual(["provider.ts"]);
  });
});

describe("one door to the provider", () => {
  it("exports neither the driver nor its loader", () => {
    const index = withoutComments(readFileSync(join(SRC, "index.ts"), "utf8"));
    for (const leak of [
      "googleTranslateDriver",
      "deeplTranslateDriver",
      "loadTranslateDriver",
      "openTranslateKey",
    ]) {
      expect(index, `index.ts must not export ${leak}`).not.toContain(leak);
    }
  });

  it("calls the driver only from the door and the settings test", () => {
    const callers = sourceFiles().filter((file) =>
      /driver\.translate\(/.test(withoutComments(readFileSync(join(SRC, file), "utf8"))),
    );
    expect(callers.sort()).toEqual(["settings.ts", "translate.ts"]);
  });
});
