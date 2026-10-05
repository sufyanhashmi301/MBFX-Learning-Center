import { getTranslations } from "next-intl/server";
import { TRANSLATE_PROVIDER_KINDS, TRANSLATE_REASONS } from "@repo/contracts";
import { requirePermission } from "@repo/rbac";
import { loadTranslateSettings } from "@repo/translate";
import { TranslateSettingsForm, type TranslateSettingsLabels } from "./translate-settings-form.tsx";

// Settings → Translation → Provider (ADR-160, ADR-186): which service
// translates (Google Cloud Translation or DeepL), its key, its price and the
// monthly character budget. The section's other tabs (ADR-163) moved it here
// from the section root.
//
// **The gate is the provider's own key, `translations.provider.manage`**
// (super_admin only), not `settings.view`: this screen holds the key that
// spends money. The server actions re-check it.
export default async function TranslationProviderPage() {
  await requirePermission("translations.provider.manage");
  const t = await getTranslations("admin");

  const settings = await loadTranslateSettings();
  const perProvider = <T,>(read: (kind: (typeof TRANSLATE_PROVIDER_KINDS)[number]) => T) =>
    Object.fromEntries(TRANSLATE_PROVIDER_KINDS.map((kind) => [kind, read(kind)])) as Record<
      (typeof TRANSLATE_PROVIDER_KINDS)[number],
      T
    >;

  const labels: TranslateSettingsLabels = {
    section: t("translate.section"),
    sectionDescription: t("translate.sectionDescription"),
    enabled: t("translate.enabled"),
    enabledHint: t("translate.enabledHint"),
    provider: t("translate.provider"),
    providerHint: t("translate.providerHint"),
    providerOptions: perProvider((kind) => t(`translate.providerOptions.${kind}`)),
    apiKey: perProvider((kind) => t(`translate.providerKeys.${kind}.apiKey`)),
    apiKeyHint: perProvider((kind) => t(`translate.providerKeys.${kind}.apiKeyHint`)),
    keyForOtherProvider: t("translate.keyForOtherProvider", {
      provider: t(`translate.providerNames.${settings.kind}`),
    }),
    apiKeySaved: t("translate.apiKeySaved"),
    showKey: t("translate.showKey"),
    hideKey: t("translate.hideKey"),
    price: t("translate.price"),
    priceHint: perProvider((kind) => t(`translate.providerKeys.${kind}.priceHint`)),
    budget: t("translate.budget"),
    budgetHint: t("translate.budgetHint"),
    save: t("save"),
    saved: t("saved"),
    test: t("translate.test"),
    testOk: t("translate.testOk"),
    lastTested: t("translate.lastTested"),
    never: t("translate.never"),
    usageTitle: t("translate.usageTitle"),
    usageDescription: t("translate.usageDescription"),
    usageCharacters: t("translate.usageCharacters"),
    usageCost: t("translate.usageCost"),
    usageRequests: t("translate.usageRequests"),
    usageRemaining: t("translate.usageRemaining"),
    noBudget: t("translate.noBudget"),
    sealKeyMissingTitle: t("translate.sealKeyMissingTitle"),
    sealKeyMissingBody: t("translate.sealKeyMissingBody"),
    refusals: {
      sealKeyMissing: t("translate.refusals.sealKeyMissing"),
      keyRequired: t("translate.refusals.keyRequired"),
      ...Object.fromEntries(
        TRANSLATE_REASONS.map((reason) => [reason, t(`translate.reasons.${reason}`)]),
      ),
    } as TranslateSettingsLabels["refusals"],
    results: Object.fromEntries(
      ["ok", ...TRANSLATE_REASONS].map((result) => [
        result,
        result === "ok" ? t("translate.testOk") : t(`translate.reasons.${result}`),
      ]),
    ),
  };

  return <TranslateSettingsForm settings={settings} labels={labels} />;
}
