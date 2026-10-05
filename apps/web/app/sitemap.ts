import type { MetadataRoute } from "next";
import {
  articleCategoryPath,
  articlePath,
  articleTagPath,
  glossaryTermPath,
  getSitemapEntries,
} from "@repo/core";
import {
  learnTrackGlossaryPath,
  learnTrackPath,
  learnTrackQuizzesPath,
  learnTrackVideosPath,
  LEARN_TRACK_KEYS,
  LEGAL_DOCUMENT_KEYS,
  LEGAL_DOCUMENT_SETTING,
  ROUTE_PATHS,
  STORED_UPLOAD_PREFIX,
  toolPath,
  publicPagePath,
} from "@repo/contracts";
import { getServableLocales } from "@repo/i18n";
import { routing } from "@repo/i18n/routing";
import { getSetting, isFeatureVisible } from "@repo/settings";
import { siteUrl } from "./_lib/site-url.ts";

// Per-locale sitemap from PUBLISHED content only (the loaders are
// query-scoped to published/publicly-visible + non-deleted; article
// translations flagged noIndex are excluded at the query). Base URL from
// env — the same var Better Auth already requires, read through the one
// helper that owns its fallback (ADR-090).
//
// The seven content reads are ONE cached call now (`getSitemapEntries`,
// tagged `content`): this route used to run every loader uncached on every
// crawler hit, alone among the public surfaces.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const base = siteUrl();
  const [entries, flags, legalStored] = await Promise.all([
    getSitemapEntries(),
    // The same anonymous-subject flag reads the pages themselves 404 on. A
    // section switched off is a 404, and a sitemap entry for a 404 is a crawl
    // hint pointing at an error page — the rule this file already applied to
    // a disabled tool and to unpublished content, now applied to sections.
    Promise.all(
      (
        [
          "news",
          "analysis",
          "glossary",
          "courses",
          "quizzes",
          "videos",
          "calculators",
          "economic_calendar",
          "market_data",
        ] as const
      ).map(async (flag) => [flag, await isFeatureVisible(flag, null)] as const),
    ).then((pairs) => Object.fromEntries(pairs) as Record<(typeof pairs)[number][0], boolean>),
    // A legal document with no stored file 404s (ADR-110); only a published
    // one is listed.
    Promise.all(LEGAL_DOCUMENT_KEYS.map((key) => getSetting(LEGAL_DOCUMENT_SETTING[key]))),
  ]);
  // ADR-091: active locales, not the static superset. Listing /es and /ar
  // when neither is served is a crawl hint pointing at a 404 — the reasoning
  // ADR-086 #5 already applied to a disabled tool, and that this file already
  // applies twice below to unpublished content.
  const servableLocales = await getServableLocales();
  const servable = new Set<string>(servableLocales);

  /**
   * Content rows carry their OWN locale, so the same rule has to be applied a
   * second time here. A glossary term translated into `es` is a published row
   * whose URL 404s while `es` is inactive — filtering the locale list alone
   * would fix the static paths and leave every translated row behind.
   */
  const served = <T extends { locale: string }>(rows: T[]): T[] =>
    rows.filter((row) => servable.has(row.locale));

  const {
    glossary: glossaryEntries,
    articles: articleEntries,
    articleCategories: categoryEntries,
    articleTags: tagEntries,
    pages: pageEntries,
    learn: learnEntries,
    glossaryTopics: topicEntries,
    videos: videoEntries,
  } = entries;

  // Coded routes — the home page, `/support` (ADR-109), the reader's sitemap
  // (ADR-110) and the economic calendar (ADR-050). These are files, not
  // content rows, so they are listed statically rather than loaded: nothing in
  // the database knows they exist.
  // `/learn` joins the static list, not the loaded one: the index is a route
  // file, and `loadLearnSitemapEntries` returns COURSE and LESSON URLs only.
  // Each TRACK's four indexes join it for the same reason (ADR-065 §1) — they
  // are route files over a code registry, so they are enumerated from the
  // registry rather than loaded, and registering a third track puts its four
  // URLs in the sitemap with no edit here.
  // Quiz RUNNER pages are NOT listed: each is `noindex, follow`, and a
  // sitemap that submits a URL its own page refuses to be indexed under is
  // reported as an error by every search console. The track's quiz INDEX is
  // the indexable surface, and it links to every runner.
  const staticPaths = [
    "/",
    ROUTE_PATHS.support,
    ROUTE_PATHS.sitemap,
    ...(flags.economic_calendar ? [ROUTE_PATHS["economic-calendar"]] : []),
    ...(flags.news ? ["/news"] : []),
    ...(flags.analysis ? ["/analysis"] : []),
    ...(flags.glossary ? [ROUTE_PATHS.glossary, `${ROUTE_PATHS.glossary}/topics`] : []),
    ...(flags.courses
      ? [
          ROUTE_PATHS.learn,
          ...LEARN_TRACK_KEYS.flatMap((track) => [
            learnTrackPath(track),
            ...(flags.quizzes ? [learnTrackQuizzesPath(track)] : []),
            ...(flags.videos ? [learnTrackVideosPath(track)] : []),
            ...(flags.glossary ? [learnTrackGlossaryPath(track)] : []),
          ]),
        ]
      : []),
    // The tools index. The tools THEMSELVES are loaded below, per locale
    // (ADR-159 #2): a tool page's words are content, and machine-written ones
    // are not submitted until a person saves them.
    ...(flags.calculators
      ? [
          ROUTE_PATHS.tools,
          // The market boards (ADR-136 §5): route files, not `Tool` rows.
          ROUTE_PATHS.volatility,
        ]
      : []),
    // Both pages behind `market_data` (changes-40): the live board and the
    // headline feed share the flag because both are the vendor's market feed
    // under our chrome.
    ...(flags.market_data ? [ROUTE_PATHS["live-rates"], ROUTE_PATHS["market-news"]] : []),
    // Only a document the route SERVES. One pointing at a committed file under
    // `public/` answers 307 (ADR-110), and a sitemap URL that redirects is
    // reported by Search Console as "Page with redirect" — the crawl hint names
    // a URL Google will not index. The footer still links it; a crawler finds
    // the PDF from there.
    ...LEGAL_DOCUMENT_KEYS.filter((_, index) =>
      Boolean(legalStored[index]?.startsWith(STORED_UPLOAD_PREFIX)),
    ).map((key) => `/legal/${key}`),
  ];
  // `publicPagePath`, not a bare prefix: the Arabic home is `/ar`, and
  // `/ar` + `/` listed `/ar/`, which answers a 308 (changes-62 #7).
  const staticPages: MetadataRoute.Sitemap = servableLocales.flatMap((locale) =>
    staticPaths.map((path) => ({
      url: `${base}${publicPagePath(locale, routing.defaultLocale, path)}`,
      lastModified: new Date(),
    })),
  );

  const glossaryPages: MetadataRoute.Sitemap = (flags.glossary ? served(glossaryEntries) : []).map(
    (entry) => ({
      url: `${base}${glossaryTermPath(entry.locale, routing.defaultLocale, entry.slug)}`,
      lastModified: entry.updatedAt,
    }),
  );

  const articlePages: MetadataRoute.Sitemap = served(articleEntries).map((entry) => ({
    url: `${base}${articlePath(entry.locale, routing.defaultLocale, entry.slug)}`,
    lastModified: entry.updatedAt,
  }));

  // Category and tag archives live under `/news` and 404 with it.
  const taxonomyPages: MetadataRoute.Sitemap = flags.news
    ? [
        ...served(categoryEntries).map((entry) => ({
          url: `${base}${articleCategoryPath(entry.locale, routing.defaultLocale, entry.slug)}`,
          lastModified: entry.updatedAt,
        })),
        ...served(tagEntries).map((entry) => ({
          url: `${base}${articleTagPath(entry.locale, routing.defaultLocale, entry.slug)}`,
          lastModified: entry.updatedAt,
        })),
      ]
    : [];

  // Module 16: CMS STATIC/COLLECTION pages (Phase 1 has only STATIC — the
  // home page is excluded by construction until it is published, PR 2.7).
  const cmsPages: MetadataRoute.Sitemap = served(pageEntries).map((entry) => ({
    url: `${base}${publicPagePath(entry.locale, routing.defaultLocale, entry.path)}`,
    lastModified: entry.updatedAt,
  }));

  /**
   * The learn loaders return an UNPREFIXED path plus the locale it belongs to,
   * so the prefix is applied here.
   *
   * This corrects a latent bug rather than adding a feature: the comment that
   * used to sit here claimed the loaders built the prefix themselves, and they
   * do not — `loadLearnSitemapEntries` returns `/learn/<slug>`. With only `en`
   * active (ADR-007) every entry was correct by coincidence, and activating a
   * second locale would have put unprefixed duplicates in the sitemap.
   */
  const localised = (entries: { path: string; locale: string; updatedAt: Date }[]) =>
    served(entries).map((entry) => ({
      url: `${base}${entry.locale === routing.defaultLocale ? "" : `/${entry.locale}`}${entry.path}`,
      lastModified: entry.updatedAt,
    }));

  // Already filtered to published + PUBLIC visibility — a draft or gated course
  // is ABSENT rather than `noindex`, because an unpublished learn route 404s
  // and a sitemap entry for a 404 is worse than no entry (plan §11).
  const learnPages: MetadataRoute.Sitemap = flags.courses ? localised(learnEntries) : [];
  // D27. A topic with no published terms is omitted by the loader, so this
  // never lists a page that renders an empty list.
  const topicPages: MetadataRoute.Sitemap = flags.glossary ? localised(topicEntries) : [];
  // ADR-068. Category VIEWS are not listed: they are filtered views over the
  // same topics, so every URL they contain is already here on its own page.
  const videoPages: MetadataRoute.Sitemap =
    flags.courses && flags.videos ? localised(videoEntries) : [];
  // Every ENABLED tool (ADR-086 #5: a disabled one 404s), in each locale whose
  // words a person saved (ADR-159 #2).
  const toolPages: MetadataRoute.Sitemap = flags.calculators
    ? localised(
        entries.tools.map((tool) => ({
          path: toolPath(tool.key),
          locale: tool.locale,
          updatedAt: new Date(),
        })),
      )
    : [];

  return [
    ...staticPages,
    ...glossaryPages,
    ...articlePages,
    ...taxonomyPages,
    ...cmsPages,
    ...learnPages,
    ...topicPages,
    ...videoPages,
    ...toolPages,
  ];
}
