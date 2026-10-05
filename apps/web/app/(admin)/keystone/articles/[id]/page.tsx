import { notFound } from "next/navigation";
import { getTranslations } from "next-intl/server";
import {
  articleKindPermission,
  listArticlesAdmin,
  loadArticleAdminDetail,
  loadArticleCategoriesAdmin,
  loadArticleTagsAdmin,
} from "@repo/core";
import { can, canAny, requireAnyPermission } from "@repo/rbac";
import { getAuthoringLocales } from "@repo/i18n";
import { routing } from "@repo/i18n/routing";
import { getAiAvailability } from "@repo/ai";
import { TRANSLATE_REASONS } from "@repo/contracts";
import { getAutoTranslateProvider } from "@repo/translate";
import { EditorPage } from "../../_components/admin-page.tsx";
import {
  aiAssistantLabels,
  aiFillLabels,
  aiSeoLabels,
  aiTranslateLabels,
  takeawaysLabels,
} from "../../_components/ai-labels.ts";
import { richTextLabels } from "../../_components/editor-labels.ts";
import { ArticleEditor } from "./article-editor.tsx";
import type { TranslationDraft } from "./editor-types.ts";
import { formatDateTime, siteOrigin } from "@repo/utils";

// Article editor v2 (changes-07 PRs 4–6). Rebuilt to the reference screen's
// information architecture; the kind-specific and publish gates still live in
// the service, and the flags computed here only shape the UI — a hidden button
// is not security (security.md #1).
export default async function ArticleEditPage({
  params,
  searchParams,
}: PageProps<"/keystone/articles/[id]">) {
  const subject = await requireAnyPermission(["analysis.view", "news.manage"]);
  const { id } = await params;
  // `?locale=xx` opens that language's tab (the translation review queue links
  // here, ADR-163). Only a code the editor offers is honoured; anything else
  // is ignored, never an error.
  const requested = (await searchParams).locale;
  // Every language row, live or not (ADR-178 #6), never the routing list.
  const locales = (await getAuthoringLocales()).map((locale) => locale.code);
  const initialLocale =
    typeof requested === "string" && locales.includes(requested) ? requested : undefined;

  const [t, tAi, detail, categories, tags, availability] = await Promise.all([
    getTranslations("admin"),
    getTranslations("admin.ai"),
    loadArticleAdminDetail(id),
    loadArticleCategoriesAdmin(),
    loadArticleTagsAdmin(),
    // ONE server read for the whole screen (ADR-097 #6). What comes back is
    // already folded with the global switch and the budget, so a feature's
    // boolean cannot be true on a platform whose cap was reached an hour ago.
    getAiAvailability(),
  ]);
  if (!detail) notFound();

  // Spending is gated on `ai.use`; what a suggestion may be saved INTO is
  // gated by the article key this page already required. Neither is decided
  // here — both are re-checked server-side on the run endpoint and the save
  // action (security.md #1). The absence of this prop is what makes an AI-off
  // install ship no AI client code.
  const canUseAi = can(subject, "ai.use");
  const tAiKey = (key: string) => tAi(key as "assistantMenu");
  const assistant =
    canUseAi && availability.features.writing_assistant
      ? {
          config: { entity: { type: "article", id: detail.id } },
          labels: aiAssistantLabels(tAiKey),
        }
      : undefined;
  // Gated per FEATURE, not per platform: an admin may switch the assistant on
  // and leave SEO off, and each affordance then appears or does not on its own.
  const seo =
    canUseAi && availability.features.seo_generation
      ? { labels: aiSeoLabels(tAiKey, (key) => t(key as "cancel")) }
      : undefined;
  const translate =
    canUseAi && availability.features.translation
      ? {
          labels: aiTranslateLabels(
            (key, values) => tAi(key as "translateAction", values),
            (key) => t(key as "cancel"),
            routing.defaultLocale,
          ),
        }
      : undefined;
  const summarize = canUseAi && availability.features.summarization;
  // ADR-160/186: "Translate with Google" or "… with DeepL" — present only when
  // automatic translation is switched on AND the viewer can save an article
  // (the prefill action refuses anyone else, so a viewer would get a button
  // that always fails). The prop keeps its ADR-160 name.
  const translateProvider = canAny(subject, ["analysis.update", "news.manage"])
    ? await getAutoTranslateProvider()
    : null;
  const providerName = translateProvider ? t(`translate.providerNames.${translateProvider}`) : "";
  const google =
    translateProvider !== null
      ? {
          labels: {
            action: t("translate.editor.action", {
              source: routing.defaultLocale,
              provider: providerName,
            }),
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
  // ADR-126: the brief bar and the per-field menus. Also gated on the keys that
  // can SAVE an article — the run route refuses anyone else, so a viewer would
  // otherwise get a bar whose every press fails.
  const fill =
    canUseAi &&
    availability.features.form_fill &&
    canAny(subject, ["news.manage", "analysis.update"])
      ? {
          module: "article" as const,
          entity: { type: "article", id: detail.id },
          labels: aiFillLabels(tAiKey, (key) => t(key as "cancel")),
          // The body's toolbar has the assistant's ✨; no second one by its label.
          richHasAssistant: Boolean(assistant),
        }
      : undefined;
  const ai =
    assistant || seo || translate || summarize || fill
      ? {
          ...(assistant ? { assistant } : {}),
          ...(fill ? { fill } : {}),
          ...(seo ? { seo } : {}),
          ...(translate ? { translate } : {}),
          ...(summarize ? { summarize: true } : {}),
        }
      : undefined;

  const canPublish = can(subject, articleKindPermission(detail.kind, "publish"));
  const canDelete = can(subject, articleKindPermission(detail.kind, "delete"));
  const canCreate = can(subject, "analysis.create") || can(subject, "news.manage");

  // Candidates for the Related Posts picker. Capped rather than unbounded —
  // the picker is a select, not a search, and a 500-row select is unusable.
  const candidates = await listArticlesAdmin({
    page: 0,
    pageSize: 100,
    sortBy: "updatedAt",
    sortDir: "desc",
  });
  const relatedOptions = candidates.rows
    .filter((row) => row.id !== detail.id && row.deletedAt === null)
    .map((row) => ({ id: row.id, title: row.title ?? t("untitled") }));

  // DB nulls → "" at this boundary: the editor's fields are controlled inputs,
  // and the save maps "" back to null on the way out.
  const translations: TranslationDraft[] = detail.translations.map((tr) => ({
    locale: tr.locale,
    title: tr.title,
    slug: tr.slug,
    excerpt: tr.excerpt ?? "",
    body: tr.body ?? "",
    seoTitle: tr.seoTitle ?? "",
    seoDescription: tr.seoDescription ?? "",
    ogImageUrl: tr.ogImageUrl ?? "",
    ogImageAssetId: tr.ogImageAssetId,
    canonicalUrl: tr.canonicalUrl ?? "",
    noIndex: tr.noIndex,
    focusKeywords: tr.focusKeywords ?? "",
    noFollow: tr.noFollow,
    ogTitle: tr.ogTitle ?? "",
    ogDescription: tr.ogDescription ?? "",
    twitterCard: tr.twitterCard ?? "",
    twitterImageUrl: tr.twitterImageUrl ?? "",
    twitterImageAssetId: tr.twitterImageAssetId,
    faqItems: tr.faqItems.map((f) => ({ id: f.id, question: f.question, answer: f.answer })),
    keyTakeaways: tr.keyTakeaways,
    translationStatus: tr.translationStatus,
  }));

  const statusLabels: Record<string, string> = {
    DRAFT: t("statusDraft"),
    IN_REVIEW: t("statusInReview"),
    SCHEDULED: t("statusScheduled"),
    PUBLISHED: t("statusPublished"),
    ARCHIVED: t("statusArchived"),
    OUTDATED: t("statusOutdated"),
    TRANSLATED: t("statusTranslated"),
    NEEDS_REVIEW: t("statusInReview"),
    MACHINE_TRANSLATED: t("statusMACHINE_TRANSLATED"),
  };

  return (
    // The editor is NOT a fourth tab (ADR-106): it carries a back link to the
    // list it came from, not the section strip, which would have highlighted
    // "Articles" while showing something that is not the article list.
    // ADR-140 §3: a static heading ("Edit news"), never the record's title —
    // the title is the editor's first field, one screen below.
    <EditorPage
      title={t(`editorHeading.article.${detail.kind}`)}
      description={t("editPostDescription")}
      backHref="/keystone/articles"
      backLabel={t("articles")}
    >
      <ArticleEditor
        ai={ai}
        google={google}
        // The takeaways control is drawn whether or not AI exists — only its
        // Generate button is conditional — so its labels are not optional.
        takeawaysLabels={takeawaysLabels(
          (key) => t(key as "cancel"),
          (key) => tAi(key as "assistantMenu"),
        )}
        article={{
          id: detail.id,
          kind: detail.kind,
          status: detail.status,
          isActive: detail.isActive,
          isPremium: detail.isPremium,
          isFeatured: detail.isFeatured,
          coverImageUrl: detail.coverImageUrl,
          coverImageAssetId: detail.coverImageAssetId,
          headerImageUrl: detail.headerImageUrl,
          headerImageAssetId: detail.headerImageAssetId,
          videoUrl: detail.videoUrl,
          showRelated: detail.showRelated,
          relatedCount: detail.relatedCount,
          categoryId: detail.categoryId,
          source: detail.source,
          sourceUrl: detail.sourceUrl,
          publishedAt: detail.publishedAt ? formatDateTime(detail.publishedAt) : null,
          updatedAt: formatDateTime(detail.updatedAt),
          deleted: detail.deletedAt !== null,
          tagIds: detail.tagIds,
          relatedArticleIds: detail.relatedArticleIds,
          translations,
          legalTransitions: detail.legalTransitions,
        }}
        categories={categories.map((c) => ({
          id: c.id,
          name: c.name ?? c.id,
          count: c.articleCount,
        }))}
        tags={tags.map((tag) => ({
          id: tag.id,
          name: tag.name ?? tag.id,
          count: tag.articleCount,
        }))}
        relatedOptions={relatedOptions}
        locales={locales}
        initialLocale={initialLocale}
        siteUrl={siteOrigin()}
        defaultLocale={routing.defaultLocale}
        canPublish={canPublish}
        canDelete={canDelete}
        canCreate={canCreate}
        labels={{
          kinds: {
            NEWS: t("kindNews"),
            ANALYSIS: t("kindAnalysis"),
            TRADE_IDEA: t("kindTradeIdea"),
          },
          statusLabels,

          cancel: t("cancel"),
          confirm: t("confirm"),
          previewDraft: t("previewDraft"),
          viewLive: t("viewLive"),
          updatePost: t("updatePost"),
          publishPost: t("publishPost"),
          publishedToast: t("publishedToast"),
          openActions: t("openActions"),
          duplicate: t("duplicate"),
          softDelete: t("softDelete"),
          restore: t("restore"),
          confirmDeleteTitle: t("confirmDeleteArticleTitle"),
          confirmDeleteBody: t("confirmDeleteArticleBody"),
          saved: t("saved"),

          content: t("contentSection"),
          contentDescription: t("contentSectionDescription"),
          localeLabel: t("localeLabel"),
          titleLabel: t("titleLabel"),
          slugLabel: t("slugLabel"),
          postUrl: t("postUrlLabel"),
          body: t("articleBodyLabel"),
          excerpt: t("excerptLabel"),

          seoSection: t("seoSection"),
          seoSectionDescription: t("seoSectionDescription"),
          seoTabBasic: t("seoTabBasic"),
          seoTabSocial: t("seoTabSocial"),
          socialIntro: t("socialIntro"),
          sharePreview: t("sharePreviewLabel"),
          seoTabAnalysis: t("seoTabAnalysis"),
          seoTitle: t("seoTitleLabel"),
          seoTitleHint: t("seoTitleHint"),
          seoDescription: t("seoDescriptionLabel"),
          seoDescriptionHint: t("seoDescriptionHint"),
          focusKeywords: t("focusKeywordsLabel"),
          focusKeywordsHint: t("focusKeywordsHint"),
          canonicalUrl: t("canonicalUrlLabel"),
          canonicalUrlHint: t("canonicalUrlHint"),
          allowIndex: t("allowIndexLabel"),
          allowFollow: t("allowFollowLabel"),
          ogTitle: t("ogTitleLabel"),
          ogDescription: t("ogDescriptionLabel"),
          ogImageUrl: t("ogImageLabel"),
          twitterCard: t("twitterCardLabel"),
          twitterCardOptions: {
            summary: t("twitterCardSummary"),
            summary_large_image: t("twitterCardLargeImage"),
          },
          twitterImage: t("twitterImageLabel"),

          postSettings: t("postSettingsSection"),
          postSettingsDescription: t("postSettingsSectionDescription"),
          mediaTabImage: t("mediaTabImage"),
          mediaTabVideo: t("mediaTabVideo"),
          coverImageUrl: t("coverImageLabel"),
          videoUrl: t("videoUrlLabel"),
          videoInvalid: t("videoUrlInvalid"),
          headerImage: t("headerImageLabel"),
          headerImageHint: t("headerImageHint"),
          featuredPost: t("featuredPostLabel"),
          activeLabel: t("activeLabel"),
          premium: t("premiumLabel"),
          premiumHint: t("premiumHint"),

          postInfo: t("postInfoSection"),
          postInfoDescription: t("postInfoSectionDescription"),
          kind: t("kind"),
          createdLabel: t("createdLabel"),
          createdValue: formatDateTime(detail.createdAt),
          updatedLabel: t("updatedLabel"),
          idLabel: t("idLabel"),
          sourceLabel: t("sourceLabel"),
          sourceUrlLabel: t("sourceUrlLabel"),

          stats: {
            words: t("wordsLabel"),
            characters: t("charactersLabel"),
            readingTime: t("readingTimeLabel"),
            minutesSuffix: t("minutesSuffix"),
            keywords: t("keywordsLabel"),
            densityTitle: t("keywordDensityLabel"),
            densityHint: t("keywordDensityHint"),
            densityEmpty: t("keywordDensityEmpty"),
          },
          faq: {
            section: t("faqSection"),
            description: t("faqSectionDescription"),
            emptyTitle: t("faqEmptyTitle"),
            emptyBody: t("faqEmptyBody"),
            add: t("addFaq"),
            addFirst: t("addFirstFaq"),
            edit: t("editFaq"),
            dialogDescription: t("faqDialogDescription"),
            answerHint: t("faqAnswerHint"),
            saveItem: t("faqSaveItem"),
            unanswered: t("faqUnanswered"),
            question: t("questionLabel"),
            answer: t("answerLabel"),
            remove: t("remove"),
            cancel: t("cancel"),
            confirm: t("confirm"),
            confirmRemoveTitle: t("confirmRemoveFaqTitle"),
            confirmRemoveBody: t("confirmRemoveFaqBody"),
            moveUp: t("moveUp"),
            moveDown: t("moveDown"),
          },
          related: {
            section: t("relatedPostsSection"),
            description: t("relatedPostsSectionDescription"),
            countSuffix: t("relatedPostsSection"),
            hint: t("relatedPostsHint"),
            emptyTitle: t("relatedEmptyTitle"),
            emptyBody: t("relatedEmptyBody"),
            addLabel: t("addRelatedPosts"),
            addPlaceholder: t("selectPlaceholder"),
            remove: t("remove"),
            moveUp: t("moveUp"),
            moveDown: t("moveDown"),
            settingsSection: t("relatedSettingsSection"),
            settingsDescription: t("relatedSettingsSectionDescription"),
            showRelated: t("showRelatedLabel"),
            relatedCount: t("relatedCountLabel"),
            postsSuffix: t("postsSuffix"),
          },
          publish: {
            section: t("publishSection"),
            description: t("publishSectionDescription"),
            hint: t("publishHint"),
            statusLabel: t("statusLabel"),
            statusLabels,
            publishedLabel: t("publishedLabel"),
            updatedLabel: t("updatedLabel"),
            scheduleFor: t("scheduleForLabel"),
            transitions: {
              PUBLISHED: t("publishNow"),
              SCHEDULED: t("scheduleAction"),
              DRAFT: t("revertToDraft"),
              ARCHIVED: t("archiveAction"),
            },
            presetPlusHour: t("schedulePlusHour"),
            presetTomorrow9: t("scheduleTomorrow9"),
            presetNextWeek: t("scheduleNextWeek"),
            presetClear: t("scheduleClear"),
            confirmArchiveTitle: t("confirmArchiveArticleTitle"),
            confirmArchiveBody: t("confirmArchiveArticleBody"),
            confirm: t("confirm"),
            cancel: t("cancel"),
          },
          taxonomy: {
            categoriesSection: t("articleCategories"),
            categoriesDescription: t("categoriesSectionDescription"),
            tagsSection: t("articleTags"),
            tagsDescription: t("tagsSectionDescription"),
            category: t("categoryLabel"),
            noTags: t("noResults"),
            addCategory: t("addCategory"),
            addTag: t("addTag"),
            newCategory: t("newCategory"),
            newCategoryDescription: t("dialogDesc.newCategory"),
            newTag: t("newTag"),
            newTagDescription: t("dialogDesc.newTag"),
            name: t("nameLabel"),
            tagName: t("tagName"),
            slugOptional: t("slugOptional"),
            description: t("descriptionLabel"),
            create: t("create"),
            cancel: t("cancel"),
            categoryCreated: t("categoryCreated"),
            tagCreated: t("tagCreated"),
            search: t("taxonomySearch"),
          },
          editor: richTextLabels(t),
          upload: {
            upload: t("uploadImage"),
            replace: t("replaceImage"),
            remove: t("removeImage"),
            uploading: t("uploading"),
            hint: t("uploadHint"),
            cancel: t("cancel"),
            confirmRemoveTitle: t("confirmRemoveImageTitle"),
            confirmRemoveBody: t("confirmRemoveImageBody"),
          },
        }}
      />
    </EditorPage>
  );
}
