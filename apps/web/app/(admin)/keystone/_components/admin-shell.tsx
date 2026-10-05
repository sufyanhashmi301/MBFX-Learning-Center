// Admin shell chrome (Module 09, reworked by changes-01): permission-
// filtered grouped sidebar with icons + active state, topbar with global
// search (⌘K), notification bell, mode toggle, and profile dropdown.
// Server component — the layout passes the already-loaded Subject in; a
// hidden sidebar entry is UX, the real boundary is each action's
// requirePermission (a hidden button is not security).
import { cookies } from "next/headers";
import { getTranslations } from "next-intl/server";
import { getAiAvailability } from "@repo/ai";
import { getAuthoringLocales } from "@repo/i18n";
import { routing } from "@repo/i18n/routing";
import { adminSessionTimeoutMs } from "@repo/contracts";
import { can, canAny, type Subject } from "@repo/rbac";
import { getSetting } from "@repo/settings";
import { getBrandAssets } from "@repo/core";
import { Toaster } from "@repo/ui/components/sonner";
import { ModeToggle } from "@repo/ui/components/mode-toggle";
import { AdminBreadcrumbs } from "./breadcrumbs.tsx";
import { AdminMobileNav } from "./admin-mobile-nav.tsx";
import { AdminSearch, type AdminSearchSection } from "./admin-search.tsx";
import { AiWriter } from "./ai-writer.tsx";
import { AdminSidebar, SIDEBAR_COOKIE } from "./admin-sidebar.tsx";
import { type AdminNavGroup, type VisitSiteLink } from "./admin-sidebar-nav.tsx";
import { IdleTimeout } from "./idle-timeout.tsx";
import { NotificationBell } from "./notification-bell.tsx";
import { loadNotificationFeed } from "./notification-items.ts";
import { ProfileMenu } from "./profile-menu.tsx";
import { SETTINGS_ENTRY_KEYS } from "../settings/_components/settings-entry-keys.ts";

// Module 16 (Website Builder / CMS) is paused per ADR-037: hidden from the
// admin UI (sidebar, mobile nav, ⌘K search — all driven by this one nav
// entry) but not deleted. Code, DB tables and the public renderer are
// untouched; flip this back to `true` to restore the nav entry.
const WEBSITE_BUILDER_ADMIN_UI_ENABLED = false;

interface NavEntryDef {
  href: string;
  labelKey:
    | "dashboard"
    | "users"
    | "roles"
    | "employees"
    | "newsletter"
    | "nav.announcements"
    | "glossary"
    | "learnCourses"
    | "learnLessons"
    | "learnQuizzes"
    | "learnVideos"
    | "learnProgress"
    | "articles"
    | "nav.promotions"
    | "websiteMedia"
    | "website"
    | "market"
    | "tools"
    | "settings"
    | "navigation"
    | "homepage"
    | "theme";
  icon: string;
  permission: string | string[] | null;
  exact?: boolean;
  enabled?: boolean;
}

const ADMIN_NAV_GROUPS: {
  labelKey: "navPeople" | "navLearning" | "navContent" | "navSystem" | null;
  entries: NavEntryDef[];
}[] = [
  {
    labelKey: null,
    entries: [
      {
        href: "/keystone/dashboard",
        labelKey: "dashboard",
        icon: "dashboard",
        permission: null,
        exact: true,
      },
    ],
  },
  {
    // Learning (Module 11, changes-11 Phase 3). Its own group rather than a
    // pair of rows under Content: a course is a structure an editor works
    // INSIDE for hours, not one more filed item beside a glossary term.
    // Sections get no entry on purpose — they exist only within a course
    // (plan §8.1), and a top-level screen for them would invite editing a
    // curriculum without seeing the course it belongs to.
    labelKey: "navLearning",
    entries: [
      {
        href: "/keystone/learn/courses",
        labelKey: "learnCourses",
        icon: "learnCourses",
        permission: "courses.view",
      },
      {
        href: "/keystone/learn/lessons",
        labelKey: "learnLessons",
        icon: "learnLessons",
        permission: "lessons.view",
      },
      {
        // Own keys since ADR-177 (ADR-058 #8 had quizzes on the lesson keys).
        href: "/keystone/learn/quizzes",
        labelKey: "learnQuizzes",
        icon: "learnQuizzes",
        permission: "quizzes.view",
      },
      {
        // Own keys since ADR-177 (ADR-068 §3 had videos on the lesson keys).
        href: "/keystone/learn/videos",
        labelKey: "learnVideos",
        icon: "learnVideos",
        // Not `exact` since changes-48 #3: Categories is a tab of this
        // section, not a row of its own, so this row stays lit on it.
        permission: "videos.view",
      },
      {
        // Analytics has its own seeded key and its own audience — a manager who
        // reads numbers is not necessarily an editor who writes lessons, so
        // this row does NOT reuse lessons.view the way the quiz row does.
        href: "/keystone/learn/progress",
        labelKey: "learnProgress",
        icon: "learnProgress",
        permission: "analytics.view",
      },
    ],
  },
  {
    labelKey: "navContent",
    entries: [
      {
        href: "/keystone/glossary",
        labelKey: "glossary",
        icon: "glossary",
        // Topics is a tab of the glossary since changes-48 #3 (D27: a topic
        // IS glossary data), so this row covers both and is not `exact`.
        permission: "glossary.view",
      },
      // News & Analysis (Module 15) — either key opens the section; each
      // action re-checks the kind-specific gate (ADR-015 #5).
      {
        href: "/keystone/articles",
        labelKey: "articles",
        icon: "articles",
        permission: ["analysis.view", "news.manage"],
      },
      // Promotions (ADR-167). Beside News & Analysis because the permission
      // group is: time-boxed notices an editor writes, not site structure.
      // The label is `admin.nav.promotions` (code-style #29) — the section's
      // own strings are the `admin.promotions` object.
      {
        href: "/keystone/promotions",
        labelKey: "nav.promotions",
        icon: "promotions",
        permission: "promotions.view",
      },
      // Trading tools (Module 13, ADR-086). Its OWN permission group, the
      // fourteenth, because this screen governs nothing market.* does: the
      // words on a tool page and whether the site offers it at all.
      {
        href: "/keystone/tools",
        labelKey: "tools",
        icon: "tools",
        permission: "tools.view",
      },
      // Market data (Module 13, ADR-087). Its own destination rather than a
      // settings card: instruments are content an editor curates, and the
      // provider behind them is a credential, which a card grid buries.
      {
        href: "/keystone/market",
        labelKey: "market",
        icon: "market",
        permission: "market.view",
      },
      // Standalone media library (ADR-037 Decision #4's follow-up) — the
      // same MediaLibrary component the paused Website Builder screen uses,
      // reachable independent of it so News & Analysis and other content
      // modules always have a working upload/reuse entry point. After Market
      // data since changes-51 (owner: "place media menu after the market
      // data"): the library serves every section above it, so it closes the
      // group rather than sitting between two of them.
      {
        href: "/keystone/media",
        labelKey: "websiteMedia",
        icon: "websiteMedia",
        permission: "media.view",
      },
      // Website builder (Module 16) — paused, ADR-037. Kept in the array
      // (rather than deleted) so re-enabling is a one-line flip of
      // WEBSITE_BUILDER_ADMIN_UI_ENABLED above.
      {
        href: "/keystone/website",
        labelKey: "website",
        icon: "website",
        permission: ["cms.pages.view", "redirects.manage"],
        enabled: WEBSITE_BUILDER_ADMIN_UI_ENABLED,
      },
    ],
  },
  {
    // AFTER Content since changes-49 (owner: "users section place after the
    // content"). The sidebar leads with what an editor works on every day —
    // courses, lessons, articles — and People, which most sessions never
    // open, follows it.
    labelKey: "navPeople",
    entries: [
      { href: "/keystone/users", labelKey: "users", icon: "users", permission: "users.view" },
      { href: "/keystone/roles", labelKey: "roles", icon: "roles", permission: "roles.view" },
      {
        href: "/keystone/employees",
        labelKey: "employees",
        icon: "employees",
        permission: "employees.view",
      },
      // Subscribers (ADR-080 #7). Under People rather than System: a
      // newsletter list is an AUDIENCE, and the person who curates it is the
      // one who manages users — not the one who can repoint the SMTP host.
      {
        href: "/keystone/newsletter",
        labelKey: "newsletter",
        icon: "newsletter",
        permission: "newsletter.view",
      },
      // Announcement emails (ADR-171). After Newsletter, because both are
      // audiences: an announcement is SENT TO people, not published content.
      // The label is `admin.nav.announcements` (code-style #29).
      {
        href: "/keystone/announcements",
        labelKey: "nav.announcements",
        icon: "announcements",
        permission: "announcements.view",
      },
    ],
  },
  {
    labelKey: "navSystem",
    entries: [
      // Settings is the ONLY system entry in the main sidebar (changes-05):
      // Features, Navigation, Homepage and Theme are all settings-shaped
      // screens the hub already fronts as cards, each reachable from any
      // settings page's own SettingsNav sub-sidebar (settings-shared.ts) —
      // duplicating them here just re-lists the same destinations twice.
      // The settings hub also fronts social links (social.manage) — anyone
      // holding either key gets the entry; each sub-page re-checks its own.
      // `email.log.view` is here for the same reason: `support` holds it and
      // nothing else under settings (ADR-078 #4), so without it the one key
      // that role was granted would have no route to reach.
      //
      // changes-51: AI is no longer an entry of its own — "only show in the
      // settings page". It is Settings → AI, so the three AI keys open
      // Settings too, or an `ai.usage.view`-only role would lose its way in.
      {
        href: "/keystone/settings",
        labelKey: "settings",
        icon: "settings",
        // ADR-177: one list with the hub page, so a key whose only screen is
        // a settings tab (translations.view, theme.update, ...) can reach it.
        permission: [...SETTINGS_ENTRY_KEYS],
      },
    ],
  },
];

/**
 * Whether the AI Writer renders (ADR-129 §5): `ai.use` AND the feature's own
 * availability, which already folds in the global switch and the budget.
 *
 * A failed READ hides the writer rather than failing the shell. The writer is
 * optional chrome on every admin page; the AI area itself still reports the
 * problem, and the run route re-checks everything on each request.
 */
async function aiWriterAvailable(subject: Subject): Promise<boolean> {
  if (!can(subject, "ai.use")) return false;
  try {
    const availability = await getAiAvailability();
    return availability.features.writing_studio === true;
  } catch (error) {
    console.error("AI Writer availability could not be read", error);
    return false;
  }
}

/**
 * The languages the writer can write in, named in English (ADR-043 #2).
 * Every language row, active or not: writing a draft in a language is not
 * serving a page in it (ADR-091), and a language added in the admin is
 * offered at once (ADR-178 #6).
 */
async function writerLanguages(): Promise<{ value: string; label: string }[]> {
  return (await getAuthoringLocales()).map((locale) => ({
    value: locale.code,
    label: locale.name,
  }));
}

function allows(subject: Subject, entry: NavEntryDef): boolean {
  if (entry.enabled === false) return false;
  if (entry.permission === null) return true;
  return Array.isArray(entry.permission)
    ? canAny(subject, entry.permission)
    : can(subject, entry.permission);
}

export async function AdminShell({
  subject,
  userName,
  email,
  image,
  children,
}: {
  subject: Subject;
  userName: string;
  email: string;
  image: string | null;
  children: React.ReactNode;
}) {
  const [t, notificationFeed, brandAssets, cookieStore, sessionTimeout, writerOn] =
    await Promise.all([
      getTranslations("admin"),
      loadNotificationFeed(subject.id),
      getBrandAssets(),
      // Sidebar collapse state is read on the SERVER so the first paint is
      // already the right width (see admin-sidebar.tsx for why not
      // localStorage). This layout is fully dynamic anyway (`instant =
      // false`), so a cookie read costs nothing here.
      cookies(),
      getSetting("security.adminSessionTimeout"),
      aiWriterAvailable(subject),
    ]);
  // A missing row is a database seeded before ADR-105: no timeout.
  const idleTimeoutMs = sessionTimeout === null ? null : adminSessionTimeoutMs(sessionTimeout);
  const sidebarCollapsed = cookieStore.get(SIDEBAR_COOKIE)?.value === "collapsed";

  const groups: AdminNavGroup[] = ADMIN_NAV_GROUPS.map((group) => ({
    label: group.labelKey ? t(group.labelKey) : null,
    entries: group.entries
      .filter((entry) => allows(subject, entry))
      .map((entry) => ({
        href: entry.href,
        label: t(entry.labelKey),
        icon: entry.icon,
        exact: entry.exact,
      })),
  })).filter((group) => group.entries.length > 0);

  // changes-08 #8. Root-relative, so the proxy applies the visitor's own
  // locale prefix rather than the admin hard-coding one (ADR-043: the
  // public surface is multilingual, the admin portal is not).
  const visitSite: VisitSiteLink = {
    href: "/",
    label: t("visitSite"),
    hint: t("visitSiteHint"),
  };

  // The ⌘K palette lists the SIDEBAR's own sections (ADR-140 §5), each row
  // with the sidebar's glyph and a one-line hint keyed by that glyph's name —
  // never its path. The dashboard's heading-less group is "Overview" there.
  const searchHint = (icon: string) =>
    t.has(`searchHints.${icon}`) ? t(`searchHints.${icon}`) : null;
  const searchSections: AdminSearchSection[] = [
    ...groups.map((group) => ({
      label: group.label ?? t("searchOverview"),
      entries: group.entries.map((entry) => ({
        href: entry.href,
        label: entry.label,
        icon: entry.icon,
        hint: searchHint(entry.icon),
      })),
    })),
    {
      label: t("searchAccount"),
      entries: [
        {
          href: "/keystone/profile",
          label: t("profile"),
          icon: "profile",
          hint: searchHint("profile"),
        },
      ],
    },
  ];

  return (
    <div className="flex min-h-full">
      <Toaster />
      {/* Idle auto sign-out, mounted HERE and nowhere else — that is what
          scopes it to the admin surface (ADR-041). Its timeout is the
          `security.adminSessionTimeout` setting, the same value `auth()`
          enforces (ADR-128); "never" mounts nothing. */}
      {idleTimeoutMs !== null && (
        <IdleTimeout
          key={idleTimeoutMs}
          timeoutMs={idleTimeoutMs}
          labels={{
            title: t("idleTitle"),
            // t.raw, not t: the {seconds} placeholder is filled on the CLIENT
            // once a second as the countdown ticks, so the server must hand
            // over the message with its placeholder intact rather than
            // resolving it (t() would demand a value here and get a stale one).
            description: String(t.raw("idleDescription")),
            stay: t("idleStay"),
            signOut: t("signOut"),
          }}
        />
      )}
      <AdminSidebar
        groups={groups}
        visitSite={visitSite}
        initialCollapsed={sidebarCollapsed}
        logoLight={brandAssets.logo_light?.url ?? null}
        logoDark={brandAssets.logo_dark?.url ?? null}
        favicon={brandAssets.favicon?.url ?? null}
        userName={userName}
        email={email}
        labels={{
          brand: t("adminPortal"),
          signOut: t("signOut"),
          collapse: t("collapseSidebar"),
          expand: t("expandSidebar"),
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex h-(--height-header) items-center gap-3 border-b bg-background/95 px-4 backdrop-blur md:gap-4 md:px-6">
          <AdminMobileNav
            groups={groups}
            visitSite={visitSite}
            menuLabel={t("adminPortal")}
            closeLabel={t("close")}
            logoLight={brandAssets.logo_light?.url ?? null}
            logoDark={brandAssets.logo_dark?.url ?? null}
          />
          <AdminSearch
            sections={searchSections}
            labels={{
              placeholder: t("searchPlaceholder"),
              trigger: t("searchTrigger"),
              title: t("searchTitle"),
              description: t("searchDescription"),
              empty: t("noResults"),
              close: t("searchClose"),
              filterAll: t("searchFilterAll"),
              filterLabel: t("searchFilterLabel"),
              legendOpen: t("searchLegendOpen"),
              legendNavigate: t("searchLegendNavigate"),
              legendClose: t("searchLegendClose"),
              users: t("users"),
              roles: t("roles"),
              employees: t("employees"),
              settings: t("settings"),
              glossary: t("glossary"),
            }}
          />
          <div className="ms-auto flex items-center gap-1 md:gap-2">
            {writerOn && (
              <AiWriter
                languages={await writerLanguages()}
                defaultLanguage={routing.defaultLocale}
              />
            )}
            <NotificationBell
              initialFeed={notificationFeed}
              labels={{
                title: t("notificationsTitle"),
                empty: t("notificationsEmpty"),
                markAllRead: t("markAllRead"),
                openMenu: t("openNotifications"),
              }}
            />
            <ModeToggle label={t("toggleTheme")} />
            <ProfileMenu
              userName={userName}
              email={email}
              image={image}
              labels={{
                profile: t("profile"),
                settings: t("settings"),
                signOut: t("signOut"),
                openMenu: t("openProfileMenu"),
              }}
            />
          </div>
        </header>
        <div className="border-b px-4 py-2 md:px-6">
          <AdminBreadcrumbs />
        </div>
        <main className="flex-1 p-4 md:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
