import { getTranslations } from "next-intl/server";
import { loadLanguagesView } from "@repo/core";
import { can, requirePermission } from "@repo/rbac";
import { Alert, AlertDescription, AlertTitle } from "@repo/ui/components/alert";
import { LanguagesTable, type LanguageRowView, type LanguagesLabels } from "./languages-table.tsx";

// Settings → Translation → Languages (ADR-163 #2/#3): which languages are live,
// whether each one's interface text is complete, and what switching it on
// would cost. Languages are added, edited and deleted here too (ADR-178 #2).
// `locales.manage`, re-checked by every action.
//
// Switching on is refused for a language the site cannot serve properly — the
// service decides and names the reason; this page only shows it beforehand.
export default async function TranslationLanguagesPage() {
  const subject = await requirePermission("locales.manage");
  const t = await getTranslations("admin.translate");
  const tAdmin = await getTranslations("admin");
  const view = await loadLanguagesView();
  const number = new Intl.NumberFormat("en");
  const usd = (value: string) => `$${Number(value).toFixed(2)}`;

  const rows: LanguageRowView[] = view.rows.map((row) => ({
    code: row.code,
    name: row.name,
    nativeName: row.nativeName,
    direction: row.direction === "RTL" ? t("languages.rtl") : t("languages.ltr"),
    isActive: row.isActive,
    flagEmoji: row.flagEmoji,
    fallbackCode: row.fallbackCode,
    sortOrder: row.sortOrder,
    contentRows: row.contentRows,
    catalog:
      row.catalogGaps === null
        ? t("languages.catalogUnroutable")
        : row.catalogGaps === 0
          ? t("languages.catalogComplete")
          : t("languages.catalogMissing", { count: row.catalogGaps }),
    catalogComplete: row.catalogGaps === 0,
    catalogGaps: row.catalogGaps,
    refusal: row.refusal ? t(`languages.refusals.${row.refusal}`) : null,
    estimate:
      row.estimate.characters === 0
        ? t("languages.estimateNone")
        : t("languages.estimateValue", {
            characters: number.format(row.estimate.characters),
            cost: usd(row.estimate.costUsd),
          }),
    activateBody: [
      t("languages.activateBody", {
        language: row.name,
        characters: number.format(row.estimate.characters),
        cost: usd(row.estimate.costUsd),
      }),
      view.remainingCharacters === null
        ? null
        : t("languages.activateBudget", { remaining: number.format(view.remainingCharacters) }),
      view.enabled ? null : t("languages.offNote"),
    ]
      .filter((line): line is string => line !== null)
      .join(" "),
  }));

  const labels: LanguagesLabels = {
    table: {
      search: t("languages.search"),
      columns: tAdmin("columns"),
      export: tAdmin("export"),
      selectedSuffix: tAdmin("selectedCount"),
      pageWord: tAdmin("pageWord"),
      ofWord: tAdmin("ofWord"),
      previous: tAdmin("previous"),
      next: tAdmin("next"),
      noResults: tAdmin("noResults"),
      actionsCol: tAdmin("actionsCol"),
    },
    languageCol: t("overview.colLanguage"),
    directionCol: t("languages.colDirection"),
    catalogCol: t("languages.colCatalog"),
    statusCol: t("overview.colStatus"),
    estimateCol: t("languages.colEstimate"),
    live: t("overview.live"),
    notLive: t("overview.notLive"),
    activate: t("languages.activate"),
    deactivate: t("languages.deactivate"),
    activateTitle: t("languages.activateTitle", { language: "{language}" }),
    deactivateTitle: t("languages.deactivateTitle", { language: "{language}" }),
    deactivateBody: t("languages.deactivateBody"),
    activated: t("languages.activated", { language: "{language}" }),
    deactivated: t("languages.deactivated", { language: "{language}" }),
    cancel: tAdmin("cancel"),
    refusals: {
      notFound: t("languages.refusals.notFound"),
      isDefault: t("languages.refusals.isDefault"),
      unroutable: t("languages.refusals.unroutable"),
      catalogIncomplete: t("languages.refusals.catalogIncomplete"),
    },
    emptyTitle: t("overview.noLocalesTitle"),
    emptyBody: t("overview.noLocalesBody"),
  };

  return (
    <>
      <Alert>
        <AlertTitle>{t("languages.howTitle")}</AlertTitle>
        <AlertDescription>{t("languages.howBody")}</AlertDescription>
      </Alert>
      <p className="text-xs text-muted-foreground">{t("overview.costNote")}</p>
      <LanguagesTable
        rows={rows}
        labels={labels}
        available={view.available}
        all={view.all}
        defaultCode={view.defaultLocale}
        // The checklist links only to a screen this person can open, which
        // re-checks its own key.
        canEditInterfaceText={can(subject, "translations.update")}
        canSync={can(subject, "translations.approve")}
      />
    </>
  );
}
