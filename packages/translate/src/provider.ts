// The provider row, and **the ONE reader of `apiKeyCipher`** (ADR-160 #4).
//
// `provider.test.ts` fails any other file in this package that SELECTS the
// column, the way `@repo/ai`'s provider guard does. Writing it (the settings
// save) is a different act and is allowed where the save lives.
import type { TranslateProviderKindName } from "@repo/contracts";
import { db } from "@repo/db";

import { deeplTranslateDriver } from "./deepl.ts";
import type { TranslateDriver } from "./driver.ts";
import { TranslateError } from "./errors.ts";
import { googleTranslateDriver } from "./google.ts";
import { openTranslateKey } from "./secret.ts";

export const PROVIDER_ID = "default";

export interface ProviderConfig {
  enabled: boolean;
  kind: TranslateProviderKindName;
  pricePerMillionChars: number;
  monthlyCharBudget: number | null;
}

export interface LoadedProvider {
  driver: TranslateDriver;
  config: ProviderConfig;
}

/** The driver for a provider kind (ADR-186). */
function driverFor(kind: TranslateProviderKindName, apiKey: string): TranslateDriver {
  return kind === "DEEPL" ? deeplTranslateDriver(apiKey) : googleTranslateDriver(apiKey);
}

/**
 * The driver and the row's pricing, or a `TranslateError`.
 *
 * `includeDisabled` is for the settings screen, which tests a key BEFORE the
 * switch is on. `apiKey` is a key typed on that screen and not yet saved; it
 * is used instead of the stored one and never written by this function.
 * `kind` is the provider that screen shows. With a typed key it says which
 * service to call; without one it must be the row's own kind, because the
 * stored key belongs to that provider and is never sent to another
 * (ADR-186 #1). Nothing that translates content passes any of the three.
 */
export async function loadTranslateDriver(
  options: { includeDisabled?: boolean; apiKey?: string; kind?: TranslateProviderKindName } = {},
): Promise<LoadedProvider> {
  const row = await db.translateProvider.findUnique({
    where: { id: PROVIDER_ID },
    select: {
      enabled: true,
      kind: true,
      apiKeyCipher: true,
      pricePerMillionChars: true,
      monthlyCharBudget: true,
    },
  });

  const storedKind: TranslateProviderKindName = row?.kind ?? "GOOGLE";
  const config: ProviderConfig = {
    enabled: row?.enabled ?? false,
    kind: options.kind ?? storedKind,
    pricePerMillionChars: row ? Number(row.pricePerMillionChars) : 20,
    monthlyCharBudget: row?.monthlyCharBudget ?? null,
  };

  if (!config.enabled && !options.includeDisabled) {
    throw new TranslateError("not_configured", "Automatic translation is switched off");
  }

  const typed = options.apiKey?.trim();
  let apiKey: string;
  if (typed) {
    apiKey = typed;
  } else if (config.kind !== storedKind) {
    throw new TranslateError("not_configured", "No key is saved for this provider");
  } else if (row?.apiKeyCipher) {
    // An unreadable seal switches translation OFF, never "fail every job"
    // (ADR-160 #11): the reason is `seal_unavailable`, which pauses.
    apiKey = openTranslateKey(row.apiKeyCipher);
  } else {
    throw new TranslateError("not_configured", "No translation API key is saved");
  }

  return { driver: driverFor(config.kind, apiKey), config };
}
