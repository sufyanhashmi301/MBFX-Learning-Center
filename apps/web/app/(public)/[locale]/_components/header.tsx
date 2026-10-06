// Public header (Module 08) — server component. Everything here reads
// CACHED data (tags: navigation, settings:layout, settings:general, theme,
// locales); auth state is a CLIENT chip (auth-slot.tsx), so the server
// shell carries zero per-request reads and navigations stay cheap.
import { buildNavigation, getBrandAssets } from "@repo/core";
import { getActiveLocales } from "@repo/i18n";
import { Link } from "@repo/i18n/navigation";
import { getLocalizedSetting, getSetting } from "@repo/settings";
import { BrandLogo } from "@repo/ui/components/brand-logo";
import { Button } from "@repo/ui/components/button";
import { Container } from "@repo/ui/components/container";
import { getTranslations } from "next-intl/server";
import { AnnouncementBar } from "./announcement-bar.tsx";
import { AuthSlot } from "./auth-slot.tsx";
import { LocaleSwitcher } from "./locale-switcher.tsx";
import { MobileNav } from "./mobile-nav.tsx";
import { SiteSearch } from "./site-search.tsx";
import { ModeToggle } from "./mode-toggle.tsx";
import { StickyHeaderShell } from "./sticky-header-shell.tsx";
import { TopBar } from "./top-bar.tsx";
import { SiteNav, type SiteNavItem } from "../_nav/site-nav.tsx";

export async function SiteHeader({ locale }: { locale: string }) {
  const [nav, siteName, sticky, cta, announcement, topBar, showSearch, locales, t, brandAssets] =
    await Promise.all([
      buildNavigation("main", locale, null),
      getSetting("site.name"),
      getSetting("header.sticky"),
      // Their words are translatable (ADR-165); switches and URLs stay English.
      getLocalizedSetting("header.cta", locale),
      getLocalizedSetting("header.announcementBar", locale),
      getLocalizedSetting("header.topBar", locale),
      getSetting("header.showSearch"),
      getActiveLocales(),
      getTranslations({ locale, namespace: "nav" }),
      getBrandAssets(),
    ]);

  // One serializable projection of the menu tree, shared by both the
  // desktop panel and the mobile sheet — they render the SAME rows, so a
  // destination can never appear on one and not the other. `title` is the
  // per-row description a panel shows under the label.
  const navItems: SiteNavItem[] = nav.map((item) => ({
    id: item.id,
    label: item.label,
    title: item.title,
    href: item.href,
    isExternal: item.isExternal,
    openInNewTab: item.openInNewTab,
    children: item.children.map((child) => ({
      id: child.id,
      label: child.label,
      title: child.title,
      href: child.href,
      isExternal: child.isExternal,
      openInNewTab: child.openInNewTab,
    })),
  }));

  return (
    <StickyHeaderShell sticky={Boolean(sticky)}>
      {announcement?.enabled && (
        <AnnouncementBar text={announcement.text} dismissible={announcement.dismissible} />
      )}
      {topBar?.enabled && (
        <TopBar phone={topBar.phone} promoText={topBar.promoText} promoUrl={topBar.promoUrl} />
      )}
      {/* `.header-enter` is the menu's own entrance on page load (ADR-111 §4).
          It sits on the <header>, not on StickyHeaderShell's div: a transform
          on the sticky element's wrapper is how a sticky bar stops sticking. */}
      <header className="header-enter bg-glow-primary relative isolate border-b border-border/70 bg-background/95 shadow-sm backdrop-blur-md">
        <Container className="relative flex h-(--height-header) items-center gap-3 md:gap-6">
          {/* Below xl the nav lives behind the hamburger; same rows
              (changes-21 D-1 — the desktop nav does not fit under 1280). */}
          <MobileNav
            items={navItems}
            menuLabel={t("openMenu")}
            locales={locales}
            brand={
              <BrandLogo
                light={brandAssets.logo_light?.url ?? null}
                dark={brandAssets.logo_dark?.url ?? null}
                alt={siteName ?? ""}
                className="h-9"
                fallback={<span className="text-lg font-semibold tracking-tight">{siteName}</span>}
              />
            }
          />

          {/* Uploaded logo (changes-02, ADR-017) when set — light/dark
              variants swap via the `dark:` class variant, same as every
              other theme-aware surface; falls back to the site name.
              Below xl the logo is CENTRED in the bar (changes-49): the
              hamburger holds the start and the account controls the end, so
              the middle is the one place it does not read as a third button.
              `inset-x-0 mx-auto w-fit` rather than `left-1/2` + a translate,
              because it is direction-neutral and leaves `transform` free for
              the hover scale. A phone gets the h-9 mark the menu sheet uses,
              which leaves room either side for the end cluster. */}
          <Link
            href="/"
            className="flex shrink-0 items-center truncate transition-transform duration-(--duration-base) ease-(--ease-out-quint) hover:scale-103 max-xl:absolute max-xl:inset-x-0 max-xl:mx-auto max-xl:w-fit"
          >
            <BrandLogo
              light={brandAssets.logo_light?.url ?? null}
              dark={brandAssets.logo_dark?.url ?? null}
              alt={siteName ?? ""}
              className="h-9 sm:h-11"
              fallback={<span className="text-lg font-semibold tracking-tight">{siteName}</span>}
            />
          </Link>

          {/* Desktop nav is a CLIENT component (ADR-048): the mega-menu panel
              registry carries icon components, which cannot cross the
              server/client boundary as props, so the arrangement lives with
              the registry and the server passes only serializable rows. */}
          <SiteNav items={navItems} ariaLabel={t("mainNavigation")} />

          {/* `relative z-10`: below xl the logo is absolutely positioned, and a
              positioned box paints over in-flow siblings — on a narrow phone
              it covered the language globe and swallowed its taps. The
              controls are what a reader needs to reach; they stay on top. */}
          <div className="relative z-10 ms-auto flex items-center gap-1 sm:gap-2">
            {/* ADR-108: a real site-wide search, reachable with ⌘K from any
                page. It used to be a magnifying glass linking to `/news` —
                the article listing's own `q` filter, standing in for a
                backend that did not exist. `admin-search.tsx` is still
                admin-only and still must not be imported here
                (architecture #5); this is its public twin over published
                content, sharing @repo/ui's Command and nothing else. */}
            {showSearch && (
              <SiteSearch
                locale={locale}
                menu={navItems}
                labels={{
                  trigger: t("searchTrigger"),
                  title: t("searchTitle"),
                  description: t("searchDescription"),
                  placeholder: t("searchPlaceholder"),
                  empty: t("searchEmpty"),
                  prompt: t("searchPrompt"),
                  searching: t("searchSearching"),
                  pages: t("searchPages"),
                  close: t("searchClose"),
                  filterAll: t("searchFilterAll"),
                  filterLabel: t("searchFilterLabel"),
                  legendOpen: t("searchLegendOpen"),
                  legendNavigate: t("searchLegendNavigate"),
                  legendClose: t("searchLegendClose"),
                  kinds: {
                    article: t("searchKindArticle"),
                    glossary: t("searchKindGlossary"),
                    course: t("searchKindCourse"),
                    lesson: t("searchKindLesson"),
                    quiz: t("searchKindQuiz"),
                    video: t("searchKindVideo"),
                    tool: t("searchKindTool"),
                  },
                }}
              />
            )}
            <LocaleSwitcher locales={locales} />
            {/* Below sm the header row cannot hold hamburger + logo + toggle
                + Sign in + Join us on a 360px phone, so the toggle moves into
                the mobile sheet as its "Appearance" row (changes-21 D-2) — the
                one control that can move without dropping an ADR-052 entry
                point or shrinking type. With no menu there is no sheet, so it
                stays here at every width. */}
            <div className={navItems.length > 0 ? "hidden sm:flex" : "flex"}>
              <ModeToggle />
            </div>
            <AuthSlot inMenuBelowXl={navItems.length > 0} />
            {cta?.enabled && (
              <Button className="glow-on-hover" render={<a href={cta.url}>{cta.label}</a>} />
            )}
          </div>
        </Container>
        {/* Thin brand hairline under the header — a large-fill gradient
            wash, not a thin literal border color (ADR-018 rule 5). */}
        <div
          aria-hidden
          className="absolute inset-x-0 bottom-0 h-px bg-gradient-to-r from-transparent via-primary-interactive/40 to-transparent"
        />
      </header>
    </StickyHeaderShell>
  );
}
