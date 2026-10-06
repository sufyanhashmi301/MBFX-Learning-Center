import { getTranslations } from "next-intl/server";
import { loadSiteText } from "@repo/core";
import { loadAuthoringLocales } from "@repo/i18n";
import { requirePermission } from "@repo/rbac";
import { SiteTextForm, type SiteTextLabels } from "./site-text-form.tsx";
import { SiteTextLanguagePicker } from "./language-picker.tsx";

// Settings → Translation → Site text (ADR-165 #8): the words from Settings a
// reader sees, in another language. Any non-default language, live or not,
// so a person can correct the machine's words before it is switched on.
//
// `settings.update` and `translations.update`, both re-checked by the action.
export default async function SiteTextPage({
  searchParams,
}: {
  searchParams: Promise<{ locale?: string | string[] }>;
}) {
  await requirePermission("settings.update");
  await requirePermission("translations.update");
  const t = await getTranslations("admin.translate");

  const targets = (await loadAuthoringLocales()).filter((locale) => !locale.isDefault);
  if (targets.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("siteText.noLanguages")}</p>;
  }
  const requested = (await searchParams).locale;
  // An unknown or absent `?locale=` opens the first language in display order.
  const current = targets.find((locale) => locale.code === requested) ?? targets[0]!;
  const entries = await loadSiteText(current.code);

  const labels: SiteTextLabels = {
    english: t("siteText.english"),
    translation: t("siteText.translation"),
    save: t("siteText.save"),
    saved: t("siteText.saved"),
    cleared: t("siteText.cleared"),
    blankHint: t("siteText.blankHint"),
    emptyEnglish: t("siteText.emptyEnglish"),
    machineHint: t("siteText.machineHint"),
    statuses: {
      missing: t("siteText.statusMissing"),
      MACHINE_TRANSLATED: t("siteText.statusMachine"),
      TRANSLATED: t("siteText.statusTranslated"),
      OUTDATED: t("siteText.statusOutdated"),
      NEEDS_REVIEW: t("siteText.statusNeedsReview"),
      DRAFT: t("siteText.statusDraft"),
    },
    refusals: {
      unknownLocale: t("siteText.refusals.unknownLocale"),
      isDefault: t("siteText.refusals.isDefault"),
      notSeeded: t("siteText.refusals.notSeeded"),
    },
    fields: {
      value: t("siteText.fields.value"),
      text: t("siteText.fields.text"),
      promoText: t("siteText.fields.promoText"),
      label: t("siteText.fields.label"),
    },
  };

  return (
    <>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">{t("siteText.intro")}</p>
        <SiteTextLanguagePicker
          value={current.code}
          options={targets.map((locale) => ({ value: locale.code, label: locale.name }))}
          label={t("siteText.language")}
        />
      </div>
      <SiteTextForm
        entries={entries}
        locale={current.code}
        direction={current.direction === "RTL" ? "rtl" : "ltr"}
        labels={labels}
      />
    </>
  );
}
