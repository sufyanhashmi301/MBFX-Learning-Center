import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { TRANSLATE_REASONS } from "@repo/contracts";
import { getPromotion, getPromotionStats } from "@repo/core";
import { getActiveLocales } from "@repo/i18n";
import { routing } from "@repo/i18n/routing";
import { can, requirePermission } from "@repo/rbac";
import { getAutoTranslateProvider } from "@repo/translate";
import { EditorPage } from "../../_components/admin-page.tsx";
import { loadEditorAi } from "../../_lib/editor-ai.ts";
import { PromotionEditor } from "../_components/promotion-editor.tsx";
import { PromotionResults, RESULTS_DAYS } from "../_components/promotion-results.tsx";
import { editPromotionInitial } from "../_lib/editor-initial.ts";

// The promotion editor (ADR-167, changes-52 P3). Read gate here; every write
// re-gates in its own action and again in the service (security.md #1).
//
// A trashed promotion 404s here rather than opening read-only: the list's
// Restore is the way back, and it lands as a draft by design.
export default async function PromotionEditPage({
  params,
  searchParams,
}: PageProps<"/keystone/promotions/[id]">) {
  const subject = await requirePermission("promotions.view");
  const { id } = await params;
  const canUpdate = can(subject, "promotions.update");
  const [t, detail, stats, activeLocales, ai, translateProvider] = await Promise.all([
    getTranslations("admin"),
    getPromotion(id),
    // ADR-170: approximate views, clicks and dismissals, read under the same key.
    getPromotionStats(id, RESULTS_DAYS),
    getActiveLocales(),
    // ADR-126 (changes-52 P6): the "Generate with AI" bar, the ✨ menus and
    // the body's writing assistant — each present only when available.
    loadEditorAi(subject, {
      module: "promotion",
      entity: { type: "promotion", id },
      contentKeys: ["promotions.update"],
    }),
    getAutoTranslateProvider(),
  ]);
  if (!detail || detail.deletedAt) notFound();

  // Active locales only, default first: the service refuses a translation for
  // a language that is not switched on, so offering one would be a trap.
  const defaultLocale = routing.defaultLocale;
  const locales = [
    defaultLocale,
    ...activeLocales.map((l) => l.code).filter((code) => code !== defaultLocale),
  ];

  // `?locale=xx` opens that language (the translation review queue links
  // here). Only a code the editor offers is honoured; anything else is ignored.
  const requested = (await searchParams).locale;
  const initialLocale =
    typeof requested === "string" && locales.includes(requested) ? requested : defaultLocale;

  // ADR-160/186: "Translate with Google" or "… with DeepL" — present only
  // when automatic translation is on AND the viewer can save the words (the
  // prefill action refuses anyone else, so a viewer would get a button that
  // always fails). The prop keeps its ADR-160 name.
  const providerName = translateProvider ? t(`translate.providerNames.${translateProvider}`) : "";
  const google =
    canUpdate && translateProvider !== null
      ? {
          labels: {
            action: t("translate.editor.action", { source: defaultLocale, provider: providerName }),
            confirmTitle: t("translate.editor.confirmTitle"),
            confirmDescription: t("translate.editor.confirmDescription"),
            confirm: t("translate.editor.confirm"),
            cancel: t("cancel"),
            working: t("translate.editor.working"),
            done: t("translate.editor.done", { provider: providerName }),
            failed: t("translate.editor.failed"),
            reasons: Object.fromEntries(
              TRANSLATE_REASONS.map((reason) => [reason, t(`translate.reasons.${reason}`)]),
            ),
          },
        }
      : undefined;

  return (
    <EditorPage
      title={t("editorHeading.promotion")}
      description={t("promotions.editorDescription")}
      backHref="/keystone/promotions"
      backLabel={t("nav.promotions")}
    >
      <PromotionEditor
        initial={editPromotionInitial(detail, locales)}
        locales={locales}
        defaultLocale={defaultLocale}
        initialLocale={initialLocale}
        canUpdate={canUpdate}
        canCreate={can(subject, "promotions.create")}
        canPublish={can(subject, "promotions.publish")}
        canDelete={can(subject, "promotions.delete")}
        {...(ai ? { ai } : {})}
        {...(google ? { google } : {})}
      />
      <PromotionResults stats={stats} />
    </EditorPage>
  );
}
