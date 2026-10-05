import type { Metadata } from "next";
import { defaultShareImage, siteName } from "../../_lib/seo.ts";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getMessages, getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import { getBrandAssets } from "@repo/core";
import { getSetting } from "@repo/settings";
import { ADMIN_MESSAGE_NAMESPACES, getServableLocales, isServableLocale } from "@repo/i18n";
import { LOCALE_DIRECTION, routing } from "@repo/i18n/routing";
import { buildThemeStyleSheet, getActiveTheme } from "@repo/theme";
import { curatedFontVariables } from "@repo/ui/fonts";
import { RevealObserver } from "@repo/ui/components/reveal-observer";
import { ScrollToTop } from "@repo/ui/components/scroll-to-top";
import { SiteLoader } from "@repo/ui/components/site-loader";
import { SiteFooter } from "./_components/footer.tsx";
import { ImpersonationBanner } from "./_components/impersonation-banner.tsx";
import { PromotionBars } from "./_components/promotion-bars.tsx";
import { PromotionHost } from "./_components/promotion-host.tsx";
import { PublicSessionProvider } from "./_components/public-session.tsx";
import { SessionHintScript } from "./_components/session-hint-script.tsx";
import { VisitorCta } from "./_components/visitor-cta.tsx";
import { SiteHeader } from "./_components/header.tsx";
import { faviconIcons } from "../../_lib/favicon.ts";
import { siteUrl } from "../../_lib/site-url.ts";
import { loadSiteTimeZone } from "../../_lib/site-time-zone.ts";
import { SiteTimeZone } from "../../_components/site-time-zone.tsx";
import { ThemeProvider } from "@repo/ui/components/theme-provider";
import { ThemeScript } from "@repo/ui/components/theme-script";
import "@repo/ui/globals.css";

// Root layout for the PUBLIC surface (ADR-006: (public) and (admin) each own
// a root layout, no top-level app/layout.tsx). This is [locale], not
// (public) itself, because `lang`/`dir` on <html> need the resolved locale
// (architecture doc §4.3) — a route group folder has no params to read.
//
// Header/footer land in Module 08/12. Fonts are curated + self-hosted
// (ADR-005, @repo/ui/fonts) — no next/font/google anywhere.
//
// generateMetadata (not a static export) because the favicon is a
// BrandAsset upload (changes-02, ADR-017) — falls back to the static
// /favicon.ico in public/ when no admin upload has replaced it.
//
// This is the site-wide metadata FALLBACK: any public route that doesn't
// define its own `generateMetadata` inherits it, so it must be
// locale-aware — it was two hardcoded English literals (including a
// "scaffold in progress" placeholder), which both broke code-style.md #2
// and shipped English metadata to `es`/`ar`/`ur`. Now read per-locale from
// the catalogs, which carry real translations for both keys.
export async function generateMetadata({ params }: LayoutProps<"/[locale]">): Promise<Metadata> {
  const { locale } = await params;
  if (!hasLocale(routing.locales, locale)) return {};
  setRequestLocale(locale);

  const [brandAssets, t, name, allowIndexing, googleVerification, shareImage] = await Promise.all([
    getBrandAssets(),
    getTranslations("common"),
    siteName(),
    getSetting("seo.robotsIndex"),
    getSetting("seo.googleSiteVerification"),
    defaultShareImage(),
  ]);
  return {
    // ADR-090. Every relative URL in the tree below — an OG image stored as
    // `/uploads/…`, a canonical path, a JSON-LD `url` — resolves against this.
    // Without it Next falls back to localhost, which neither throws nor warns
    // in production: it just ships share cards nobody can load.
    metadataBase: new URL(siteUrl()),
    title: name,
    description: t("siteDescription"),
    icons: faviconIcons(brandAssets.favicon),
    // The share card every page inherits unless it builds its own
    // (`shareMetadata`). Next fills og:title/description from the page's own
    // title and description, and the Twitter card copies the image from here.
    openGraph: {
      type: "website",
      siteName: name,
      locale,
      ...(shareImage ? { images: [{ url: shareImage }] } : {}),
    },
    twitter: { card: "summary_large_image" },
    // ADR-090. The site-wide indexing switch — the page-side half of the rule
    // `robots.ts` applies to the crawler. A null value is an unseeded row and
    // means "do not interfere": only an explicit `false` deindexes. It reaches
    // the pages below only because no public route returns `robots: undefined`
    // any more — Next merges by key PRESENCE, so an undefined would erase it.
    ...(allowIndexing === false ? { robots: { index: false, follow: false } } : {}),
    // Seeded as "" and read by nothing until now. Empty stays ABSENT: an empty
    // `<meta name="google-site-verification">` is a failed verification, not a
    // neutral one.
    ...(googleVerification ? { verification: { google: googleVerification } } : {}),
  };
}

// Cache Components + next-intl's locale-aware <Link>/getTranslations do
// not yet compose into a fully-static shell — every attempt surfaces as
// "runtime data during prerendering" on whichever route builds first
// (three in one day: nav strings, glossary list links, home spotlight
// links). Every read on this surface is cached and tag-invalidated
// (theme/settings/navigation/content/locales), so blocking IS a cache
// hit — this trades the PPR static shell for correctness in ONE place
// instead of per-page whack-a-mole. Revisit when next-intl ships static
// Cache Components support (tracked in DEVLOG Module 14 checklist).
export const instant = false;

// ADR-091: the ACTIVE locales, not `routing.locales`. Prerendering the
// static superset built every page three extra times in locales nobody has
// translated, and next-intl throws `MISSING_MESSAGE` on a missing key — so
// the 573 gaps in each of es/ar/ur were hard build errors, and enough of them
// to exhaust the build worker's heap.
//
// This reads the database, which adds no requirement the build did not
// already have: the layout below renders theme, settings, navigation and
// brand assets from it on every prerendered page.
export async function generateStaticParams() {
  const locales = await getServableLocales();
  return locales.map((locale) => ({ locale }));
}

export default async function PublicRootLayout({ children, params }: LayoutProps<"/[locale]">) {
  const { locale } = await params;

  // The proxy's matcher and next-intl's own middleware keep an unrecognized
  // locale prefix from reaching this point in normal operation — this is
  // the defense-in-depth 404 for a locale segment that isn't in
  // routing.locales (SKILL.md's required "unknown locale → 404" case).
  if (!hasLocale(routing.locales, locale)) notFound();

  // ADR-091: and a 404 for a locale that IS routable but is not active. This
  // is the boundary, not `generateStaticParams` — dropping a locale from the
  // prerender list alone would only move the missing-key error to the first
  // request for /es, which is the same defect served later instead of built.
  if (!(await isServableLocale(locale))) notFound();

  // Required for static rendering under Cache Components (ADR-004) — tells
  // next-intl which locale this render is for before any message lookup,
  // the same role loadActiveTheme/loadSubject's cache-tag calls play
  // elsewhere: declare context before the async work, not after.
  setRequestLocale(locale);

  // The admin namespaces stay on the server. They are English staff text that
  // no public client component reads, and at ~180 KB they were most of the
  // catalog and a third of every public page's HTML (changes-62 #2). Server
  // components still read the whole catalog through `getTranslations`.
  const allMessages = await getMessages();
  const messages = Object.fromEntries(
    Object.entries(allMessages).filter(([namespace]) => !ADMIN_MESSAGE_NAMESPACES.has(namespace)),
  );

  // Cached read (tag "theme", ADR-004): resolved at build/revalidate time
  // for these static routes, invalidated by an admin theme save. The style
  // element id is frozen API — Module 14's CSP nonce attaches to
  // #brand-tokens by name (security.md #14).
  const [theme, pageLoader, t, timeZone] = await Promise.all([
    getActiveTheme("web"),
    // ADR-018 rule 4d — the preloader's kill switch. A missing row (a
    // database seeded before Phase 3) reads as null and stays off.
    getSetting("layout.pageLoader"),
    getTranslations({ locale, namespace: "nav" }),
    // ADR-182: dates print in the site's timezone, not the server's or the reader's.
    loadSiteTimeZone(),
  ]);

  return (
    <html
      lang={locale}
      dir={LOCALE_DIRECTION[locale]}
      className={`h-full antialiased ${curatedFontVariables}`}
      // <ThemeScript> mutates the class list before hydration (stored mode).
      suppressHydrationWarning
    >
      {/* suppressHydrationWarning: browser extensions (e.g. ColorZilla's
          cz-shortcut-listen) inject body attributes before React hydrates —
          same rationale as this <html>'s suppression above. */}
      <body className="flex min-h-full flex-col" suppressHydrationWarning>
        {/* ADR-064: the pre-paint mode guard, server-rendered so the browser
            actually executes it. No nonce here — this layout is cached (ADR-004)
            and has no request to read one from. */}
        <ThemeScript />
        {/* ADR-124: hides the subscribe bands before first paint for a reader
            the last session read found signed in. Display only. */}
        <SessionHintScript />
        <style
          id="brand-tokens"
          dangerouslySetInnerHTML={{ __html: buildThemeStyleSheet(theme) }}
        />
        <NextIntlClientProvider messages={messages} timeZone={timeZone}>
          <SiteTimeZone value={timeZone} />
          <ThemeProvider>
            {/* ADR-018: SiteLoader renders nothing during SSR and only
                appears post-hydration, so it can never delay first paint.
                RevealObserver is the ONE observer island per page (rule 2)
                — it does nothing at all in browsers with native
                scroll-driven animation support. */}
            {pageLoader && <SiteLoader />}
            <RevealObserver />
            {/* ADR-094: the public surface's ONE session read, wrapping both
                consumers — the header's auth chip and the visitor band below
                the content. It renders no markup of its own. */}
            <PublicSessionProvider>
              <ImpersonationBanner />
              {/* ADR-173: a TOP banner, in flow so it never covers the sticky header. */}
              <PromotionBars slot="top" />
              <SiteHeader locale={locale} />
              {/* overflow-x-clip: a `Reveal variant="end"` rests 1.5rem toward
                the inline end until it scrolls into view (ADR-018 rule 2),
                and at the page edge that made phones scroll sideways (8px on
                /about/* and /economic-calendar at 390px — changes-20 Phase 6
                browser pass). `clip`, not `hidden`: it does not create a
                scroll container, so every `sticky` bar and sidebar inside
                the page keeps sticking to the viewport. */}
              <div className="flex-1 overflow-x-clip">{children}</div>
              {/* Above the footer and in flow, never fixed to the viewport —
                  visitor-cta.tsx records why. Absent for a signed-in learner
                  and while the session is still loading. */}
              <VisitorCta />
              {/* ADR-167: the promotion popup. Inside the provider for the
                  audience rule; renders nothing until a promotion is due. */}
              <PromotionHost />
              {/* ADR-173: the bottom strip and the side cards, fixed to the viewport. */}
              <PromotionBars slot="fixed" />
            </PublicSessionProvider>
            <SiteFooter locale={locale} />
            <ScrollToTop label={t("backToTop")} className="bottom-(--floating-bottom)" />
          </ThemeProvider>
        </NextIntlClientProvider>
      </body>
    </html>
  );
}
