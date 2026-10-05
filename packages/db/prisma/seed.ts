// packages/db/prisma/seed.ts
//
// Idempotent. Every write is an upsert keyed on a stable business key, so
// running this against an existing database repairs drift instead of
// duplicating rows or clobbering admin edits.
//
//   pnpm db:seed

import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { hash } from "@node-rs/argon2";
import type { PrismaClient } from "../src/generated/client/client.ts";
import {
  EMAIL_DESIGN_DEFAULTS,
  EMAIL_DESIGN_PREVIOUS_BODIES,
} from "../src/email-design-defaults.ts";
import {
  EMAIL_TEMPLATE_DEFAULTS,
  EMAIL_TEMPLATE_PREVIOUS_DEFAULTS,
} from "../src/email-template-defaults.ts";
import { CONTENT_LIFECYCLE_GROUPS } from "../src/permission-groups.ts";
import { isSuperAdminOnlyPermission } from "../src/role-exclusions.ts";
import { TRANSLATABLE_SETTING_KEY_LIST } from "../src/translatable-settings.ts";
import {
  REVIEW_PLATFORM_SEED_DEFAULTS,
  REVIEW_PLATFORM_SEED_KEYS,
} from "../src/review-platforms.ts";
import defaultThemeTokens from "./default-theme-tokens.json" with { type: "json" };
import homePageLayout from "./home-page-layout.json" with { type: "json" };
import { SEED_ARTICLES } from "./seed-articles.ts";
import { seedPromotions } from "./seed-promotions.ts";
import { seedEmailCampaigns } from "./seed-email-campaigns.ts";
import { seedArabicMenuLabels } from "./seed-menu-ar.ts";
import { seedArabicEmailTemplates } from "./seed-email-ar.ts";
import { seedArabicArticles } from "./seed-articles-ar.ts";
import { seedArabicDemoCourses } from "./seed-learn-ar.ts";
import { TOOL_HIGHLIGHTS } from "./seed-tool-highlights.ts";
import { DEMO_QUIZ, DEMO_QUIZ_CRYPTO } from "./seed-quizzes.ts";
import { GLOSSARY_TERMS, GLOSSARY_TOPICS } from "./seed-glossary.ts";
import { VIDEO_CATEGORIES, VIDEO_TOPICS } from "./seed-videos.ts";
import { seedArabicDemoQuizzes } from "./seed-quizzes-ar.ts";
import { seedArabicGlossary } from "./seed-glossary-ar.ts";
import { seedArabicDemoVideos } from "./seed-videos-ar.ts";
import { seedArabicPromotions } from "./seed-promotions-ar.ts";
import { seedArabicSettings } from "./seed-settings-ar.ts";
import { seedArabicTools } from "./seed-tools-ar.ts";

// The `home` page's published layout (Module 16, plan v2.2 PR 2.7) — the
// four STATIC `home.sections` migrated to blocks (hero, newsletter, faq,
// risk_disclaimer). Kept as its own JSON file rather than inlined here: it
// is long, and it is hand-verified against `@repo/contracts`'
// `layoutTreeSchema` and the real `@repo/blocks` registry before every
// change (see the PR 2.7 DEVLOG entry for how) — a JSON file diffs and
// reviews the same way whether or not this comment is nearby.
const HOME_PAGE_LAYOUT = homePageLayout;

// ─────────────────────────────────────────────────────────────
// 1. PERMISSIONS
// Flat `resource.action` keys. No wildcards — a wildcard makes it ambiguous
// whether "content.*" includes "content.delete", and that ambiguity becomes
// a security incident eventually.
// ─────────────────────────────────────────────────────────────

const PERMISSIONS = [
  // Learning — /keystone/learn/*, one card per screen (ADR-177). Quizzes and
  // videos borrowed the LESSON keys until ADR-177 (superseding ADR-058 #8 and
  // ADR-068 §3), so lesson authorship could not be granted without quiz and
  // video authorship. They have their own keys now; the migration that added
  // them granted each one to every role and override holding its lesson twin.
  ["courses", "courses.view", "View courses"],
  ["courses", "courses.create", "Create courses"],
  ["courses", "courses.update", "Edit courses and their sections"],
  ["courses", "courses.delete", "Delete courses"],
  ["courses", "courses.publish", "Publish courses"],
  ["lessons", "lessons.view", "View lessons"],
  ["lessons", "lessons.create", "Create lessons"],
  ["lessons", "lessons.update", "Edit lessons"],
  ["lessons", "lessons.delete", "Delete lessons"],
  ["lessons", "lessons.publish", "Publish lessons"],
  ["quizzes", "quizzes.view", "View quizzes"],
  ["quizzes", "quizzes.create", "Create and duplicate quizzes"],
  ["quizzes", "quizzes.update", "Edit quizzes and their questions"],
  ["quizzes", "quizzes.delete", "Delete quizzes"],
  ["quizzes", "quizzes.publish", "Publish quizzes"],
  ["videos", "videos.view", "View videos and video categories"],
  ["videos", "videos.create", "Create video topics and categories"],
  ["videos", "videos.update", "Edit video topics and categories"],
  ["videos", "videos.delete", "Delete video topics and categories"],
  ["videos", "videos.publish", "Publish video topics"],

  // Glossary — /keystone/glossary and /keystone/glossary/topics. A topic IS glossary
  // data (D27), so it reuses these keys rather than adding three nobody holds.
  ["glossary", "glossary.view", "View glossary"],
  ["glossary", "glossary.create", "Create glossary terms"],
  ["glossary", "glossary.update", "Edit glossary terms"],
  ["glossary", "glossary.delete", "Delete glossary terms"],
  ["glossary", "glossary.publish", "Publish glossary terms"],

  // Media library — /keystone/media
  ["media", "media.view", "View the media library"],
  ["media", "media.upload", "Upload media"],
  ["media", "media.update", "Edit media metadata, replace files"],
  ["media", "media.delete", "Delete media"],

  // News & Analysis — /keystone/articles (+ its categories and tags). Comments
  // hang off an article and are moderated nowhere else, so they belong here.
  ["articles", "analysis.view", "View analysis"],
  ["articles", "analysis.create", "Create analysis"],
  ["articles", "analysis.update", "Edit analysis"],
  ["articles", "analysis.delete", "Delete analysis"],
  ["articles", "analysis.publish", "Publish analysis"],
  ["articles", "news.manage", "Manage news"],
  ["articles", "comments.moderate", "Moderate comments"],

  // Promotions — /keystone/promotions (ADR-167). `publish` alone puts a
  // promotion live or archives it, so an author can draft without being able
  // to interrupt every visitor with a popup. Not super_admin-only: nothing here
  // captures or spends anything, so `admin` holds it through the registry and
  // the owner grants it to any other role in the role editor.
  ["promotions", "promotions.view", "View promotions"],
  ["promotions", "promotions.create", "Create promotions"],
  ["promotions", "promotions.update", "Edit promotions"],
  ["promotions", "promotions.delete", "Delete promotions"],
  ["promotions", "promotions.publish", "Activate or archive promotions"],

  // Website builder (Module 16 — ADR-021 pages, ADR-027 parts). CANCELLED by
  // ADR-042 and hidden, not deleted; the keys stay seeded for the same reason
  // the code does. A part publish is site-wide, hence its own key. The
  // redirects screen reuses the seeded `redirects.manage`; the media library
  // reuses `media.*`.
  ["website", "cms.pages.view", "View website pages"],
  ["website", "cms.pages.create", "Create website pages"],
  ["website", "cms.pages.update", "Edit website pages"],
  ["website", "cms.pages.delete", "Delete website pages"],
  ["website", "cms.pages.publish", "Publish website pages"],
  ["website", "cms.parts.publish", "Publish global site parts"],
  ["website", "cms.styles.manage", "Manage style presets"],
  ["website", "cms.templates.manage", "Manage layout templates"],
  ["website", "cms.cards.manage", "Manage card templates"],

  // Market data (Module 13)
  ["market", "market.view", "View market data config"],
  ["market", "market.providers.manage", "Manage data providers"],
  ["market", "market.instruments.manage", "Manage instruments"],
  ["market", "calendar.manage", "Manage economic calendar"],

  // Trading tools (Module 13, ADR-086 #6)
  ["tools", "tools.view", "View trading tools"],
  ["tools", "tools.update", "Edit tool content and configuration"],
  ["tools", "tools.publish", "Enable or disable a tool"],

  // Translations & locales (Module 06)
  ["translations", "translations.view", "View translations"],
  ["translations", "translations.update", "Edit translations"],
  ["translations", "translations.approve", "Approve translations"],
  ["translations", "locales.manage", "Manage locales"],
  // ADR-160: the Google Cloud Translation key and its budget. super_admin
  // only (role-exclusions.ts) — a key rather than a role test, as
  // `ai.providers.manage` is, so a later grant is an ADR.
  ["translations", "translations.provider.manage", "Manage the translation provider and its key"],

  // SEO & redirects
  ["seo", "seo.update", "Edit SEO fields"],
  ["seo", "redirects.manage", "Manage redirects"],
  ["seo", "sitemaps.manage", "Manage sitemaps"],

  // Users — /keystone/users. `permissions.assign` stays here rather than under
  // Roles: it is used on a USER's record (assigning a role or an override to
  // that person), not in the role editor.
  ["users", "users.view", "View users"],
  ["users", "users.create", "Create users"],
  ["users", "users.update", "Edit users"],
  ["users", "users.delete", "Delete users"],
  ["users", "users.impersonate", "Impersonate users"],
  ["users", "users.password.reset", "Reset user passwords"],
  ["users", "permissions.assign", "Assign roles and permissions to a user"],

  // Roles — /keystone/roles (ADR-177: its own sidebar entry, so its own card).
  ["roles", "roles.view", "View roles"],
  ["roles", "roles.manage", "Create and edit roles"],

  // Employees — /keystone/employees
  ["employees", "employees.view", "View employees"],
  ["employees", "employees.create", "Add employees"],
  ["employees", "employees.update", "Edit employees"],
  // ADR-177: offboarding IS removing an employee, so it is gated here. It sat
  // on `employees.update` until then, which left this key governing nothing.
  ["employees", "employees.delete", "Offboard employees"],
  ["employees", "departments.manage", "Manage departments"],

  // Newsletter (Module 17, ADR-080 #7). Administration is a list, not a CRM:
  // view, manage (unsubscribe + the hard erase an erasure request means) and
  // export, which is separate because it is the one action that leaves the
  // building with a copy of the addresses.
  ["newsletter", "newsletter.view", "View newsletter subscribers"],
  ["newsletter", "newsletter.manage", "Unsubscribe and delete subscribers"],
  ["newsletter", "newsletter.export", "Export subscribers as CSV"],

  // Announcement emails (Module 17, ADR-171 #11). `send` is its own key
  // because the bulk action is the dangerous one: an author can draft and
  // test, and only a holder of `send` can mail the audience, schedule,
  // cancel, retry or add a suppression.
  ["announcements", "announcements.view", "View announcement emails"],
  ["announcements", "announcements.create", "Draft announcement emails and send tests"],
  ["announcements", "announcements.send", "Send announcement emails to an audience"],
  // ADR-172 #7: one-to-one email from a user's or subscriber's record. Its own
  // key because it bypasses the composer's count, test gate and confirmation;
  // the action also re-checks the right to see that person.
  ["announcements", "announcements.direct", "Email one user or subscriber directly"],

  // Email (Module 17, ADR-078). Five keys, split deliberately:
  // `email.settings.manage` guards the TRANSPORT and is super_admin-only
  // (ADR-078 #4 — an editable SMTP host is a mail-interception path around
  // `canAssignRole`'s strict `<`), while editing templates, sending a test and
  // reading the delivery log stay with `admin`. That is why the email settings
  // screen splits by permission rather than hiding whole.
  ["email", "email.settings.manage", "Configure email delivery"],
  ["email", "email.templates.view", "View email templates"],
  ["email", "email.templates.update", "Edit email templates"],
  ["email", "email.templates.test", "Send test emails"],
  ["email", "email.log.view", "View email delivery log"],

  // AI platform (Module 18, ADR-097/098). Four keys, and this repo counts
  // them: `ai.use` answers "may this person spend money on generation",
  // `ai.settings.manage` "may they change the switches and the budget",
  // `ai.providers.manage` "may they hold the key and repoint the host"
  // (super_admin only — ADR-098), and `ai.usage.view` "may they see what was
  // spent and by whom". The last is separate on purpose: the usage screen
  // names WHICH member of staff spent what, which is closer to the audit log
  // than to a settings form. There is deliberately NO key per feature — the
  // feature toggle gates existence and the content key the admin already holds
  // gates the save (ADR-097 #10).
  ["ai", "ai.use", "Use AI features"],
  ["ai", "ai.settings.manage", "Configure AI switches, budget, and limits"],
  ["ai", "ai.providers.manage", "Manage AI providers, keys, and models"],
  ["ai", "ai.usage.view", "View AI usage and spend"],

  // Settings & branding — /keystone/settings and the screens its sub-nav fronts
  // (theme, navigation, features, social, integrations).
  ["settings", "settings.view", "View settings"],
  ["settings", "settings.update", "Edit settings"],
  ["settings", "theme.update", "Edit theme and branding"],
  ["settings", "navigation.manage", "Manage navigation"],
  ["settings", "features.manage", "Toggle features"],
  ["settings", "social.manage", "Manage social links"],
  ["settings", "integrations.manage", "Manage integrations"],

  // System. `analytics.view` stays here rather than under Learning even though
  // it gates /keystone/learn/progress: it also gates the dashboard, and the
  // sidebar already records why a numbers audience is not an editing one.
  ["system", "audit.view", "View audit logs"],
  ["system", "analytics.view", "View analytics"],
  ["system", "system.maintenance", "Run maintenance tasks"],
] as const;

// ─────────────────────────────────────────────────────────────
// 2. ROLES
// `level` guards privilege escalation: nobody may assign a role at or above
// their own level. Without it, an Editor with roles.manage can make
// themselves Super Admin.
// ─────────────────────────────────────────────────────────────

const ALL = "*"; // sentinel, expanded below

const ROLES: Array<{
  key: string;
  name: string;
  level: number;
  description: string;
  permissions: string[] | typeof ALL;
}> = [
  {
    key: "super_admin",
    name: "Super Admin",
    level: 100,
    description: "Unrestricted access, including roles and permissions.",
    permissions: ALL,
  },
  {
    key: "admin",
    name: "Admin",
    level: 90,
    description: "Full access except editing roles, permissions, and email delivery.",
    // The exclusion list is a named constant with a reason per entry
    // (`../src/role-exclusions.ts`), because it is the sharpest privilege rule
    // in the repo and `role-exclusions.test.ts` asserts that nothing below
    // `super_admin` is granted any of it.
    permissions: PERMISSIONS.map(([, key]) => key).filter((k) => !isSuperAdminOnlyPermission(k)),
  },
  {
    key: "content_manager",
    name: "Content Manager",
    level: 60,
    description: "Owns the full content lifecycle including publishing.",
    permissions: [
      // Every key in the four content groups (ADR-083). This used to read
      // against the single `content` group they were all cut from; the split
      // is display-shaped, so the grant set is deliberately identical. A group
      // added to the registry later does NOT land here on its own — whether a
      // content manager gets it is a privilege decision.
      ...PERMISSIONS.filter(([g]) =>
        (CONTENT_LIFECYCLE_GROUPS as readonly string[]).includes(g),
      ).map(([, k]) => k),
      "translations.view",
      "translations.update",
      "translations.approve",
      "seo.update",
      "analytics.view",
      // ADR-086 #6. A content manager writes the words on a tool page but does
      // not decide which tools the site offers — that is tools.publish, and it
      // stays with admin, exactly as a header publish does two lines down.
      "tools.view",
      "tools.update",
      // ADR-097 #10. `ai.use` is the spend gate, nothing more: what a
      // suggestion may be saved INTO is still decided by the content key
      // beside it, so this grant widens nobody's reach over content.
      "ai.use",
      // Pages, not parts: a header publish stays with admin and above.
      "cms.pages.view",
      "cms.pages.create",
      "cms.pages.update",
      "cms.pages.delete",
      "cms.pages.publish",
      "cms.styles.manage",
      "cms.templates.manage",
      "cms.cards.manage",
    ],
  },
  {
    key: "editor",
    name: "Editor",
    level: 50,
    description: "Edits and publishes content. Cannot delete.",
    permissions: [
      "lessons.view",
      "lessons.create",
      "lessons.update",
      "lessons.publish",
      // ADR-177: the quiz and video twins of the lesson keys above, so the
      // split left this role's reach exactly where it was.
      "quizzes.view",
      "quizzes.create",
      "quizzes.update",
      "quizzes.publish",
      "videos.view",
      "videos.create",
      "videos.update",
      "videos.publish",
      "courses.view",
      "courses.update",
      "courses.publish",
      "glossary.view",
      "glossary.create",
      "glossary.update",
      "glossary.publish",
      "analysis.view",
      "analysis.update",
      "analysis.publish",
      "media.view",
      "media.upload",
      "media.update",
      "seo.update",
      "translations.view",
      "translations.update",
      "ai.use",
      "cms.pages.view",
      "cms.pages.update",
    ],
  },
  {
    key: "author",
    name: "Author",
    level: 30,
    description: "Writes drafts. Cannot publish.",
    permissions: [
      "lessons.view",
      "lessons.create",
      "lessons.update",
      "quizzes.view",
      "quizzes.create",
      "quizzes.update",
      "videos.view",
      "videos.create",
      "videos.update",
      "courses.view",
      "glossary.view",
      "glossary.create",
      "glossary.update",
      "analysis.view",
      "analysis.create",
      "analysis.update",
      "media.view",
      "media.upload",
      "ai.use",
    ],
  },
  {
    key: "seo_manager",
    name: "SEO Manager",
    level: 50,
    description: "Owns SEO metadata, redirects, and sitemaps site-wide.",
    permissions: [
      "lessons.view",
      "quizzes.view",
      "videos.view",
      "courses.view",
      "glossary.view",
      "analysis.view",
      "seo.update",
      "redirects.manage",
      "sitemaps.manage",
      "analytics.view",
      "ai.use",
      "cms.pages.view",
    ],
  },
  {
    key: "market_data_manager",
    name: "Market Data Manager",
    level: 50,
    description: "Configures data providers, instruments, and the calendar.",
    permissions: [
      "market.view",
      "market.providers.manage",
      "market.instruments.manage",
      "calendar.manage",
      "tools.view",
      "settings.view",
      "integrations.manage",
    ],
  },
  {
    key: "analyst",
    name: "Analyst",
    level: 40,
    description: "Publishes market analysis only.",
    permissions: [
      "analysis.view",
      "analysis.create",
      "analysis.update",
      "analysis.publish",
      "market.view",
      "media.view",
      "media.upload",
    ],
  },
  {
    key: "moderator",
    name: "Moderator",
    level: 30,
    description: "Moderates comments and community content.",
    permissions: ["comments.moderate", "users.view"],
  },
  {
    key: "support",
    name: "Support",
    level: 20,
    description: "Reads user records and resets passwords.",
    // `email.log.view` is the answer to "I never got my reset email" — the one
    // question support is asked that only the delivery log can settle. It reads
    // the attempt, never the message (ADR-078 #10).
    permissions: ["users.view", "users.password.reset", "employees.view", "email.log.view"],
  },
  {
    key: "read_only",
    name: "Read Only",
    level: 10,
    description: "Views the admin without changing anything.",
    permissions: PERMISSIONS.map(([, k]) => k).filter((k) => k.endsWith(".view")),
  },
];

// ─────────────────────────────────────────────────────────────
// 3. SOCIAL LINKS — MBX Pro official accounts
// ─────────────────────────────────────────────────────────────

// `icon` names a glyph in @repo/ui's built-in social set (ADR-045) — these
// ARE the default icons, and they render on the public footer with no
// admin action. They used to name a `lucide-react` export, which stopped
// resolving when lucide v1 dropped its brand icons; the resolver aliases
// the old `twitter` value onto `x` so a database seeded before this change
// keeps rendering. An admin can upload their own artwork per link
// (`iconUrl`), which wins over the glyph named here.
const SOCIAL_LINKS = [
  {
    platform: "instagram",
    label: "Instagram",
    url: "https://www.instagram.com/mbxproofficial",
    icon: "instagram",
    handle: "@mbxproofficial",
    sortOrder: 1,
  },
  {
    platform: "facebook",
    label: "Facebook",
    url: "https://www.facebook.com/mbxproofficial/",
    icon: "facebook",
    handle: "mbxproofficial",
    sortOrder: 2,
  },
  {
    platform: "youtube",
    label: "YouTube",
    url: "https://www.youtube.com/@MBXProofficial",
    icon: "youtube",
    handle: "@MBXProofficial",
    sortOrder: 3,
  },
  {
    platform: "linkedin",
    label: "LinkedIn",
    url: "https://www.linkedin.com/company/mbxpro",
    icon: "linkedin",
    handle: "mbxpro",
    sortOrder: 4,
  },
  {
    platform: "x",
    label: "X",
    url: "https://x.com/MBXProOfficial",
    icon: "x",
    handle: "@MBXProOfficial",
    sortOrder: 5,
  },
];

// ─────────────────────────────────────────────────────────────
// 4. SETTINGS
// ─────────────────────────────────────────────────────────────

const SETTINGS = [
  // General
  ["general", "site.name", "MBX Learning Center", "STRING", "Site name", true],
  ["general", "site.tagline", "Learn to trade the markets", "STRING", "Tagline", true],
  [
    "general",
    "site.description",
    "Free forex and trading education, market tools, and analysis.",
    "TEXT",
    "Site description",
    true,
  ],
  ["general", "site.contactEmail", "hello@mbxpro.com", "STRING", "Contact email", true],
  // PUBLIC since ADR-131: `/support`'s Email card prints it and its contact
  // form delivers to it, so it reaches a public page by design (security.md #12).
  ["general", "site.supportEmail", "support@mbxpro.com", "STRING", "Support email", true],
  ["general", "site.defaultLocale", "en", "STRING", "Default language", true],
  ["general", "site.defaultTimezone", "UTC", "STRING", "Default timezone", true],
  ["general", "site.defaultThemeMode", "system", "SELECT", "Default colour mode", true],
  // NOTE: no `site.reviewsUrl` here any more (ADR-169). The reviews band's
  // links are `review_platforms` rows, seeded below beside the social links;
  // `20260929150000_review_platforms_changes53_adr169` moved an existing
  // install's value into the Trustpilot row and deleted this setting.
  // NOTE: there is deliberately no `site.faviconUrl` here (changes-36).
  // The favicon is a BrandAsset, set in Theme → Logos & Favicons and read by
  // `faviconIcons()` in both root layouts; this row was read by nothing, so
  // an admin could fill it in, see "Saved", and change no page on the site.
  // code-style.md #28 — a setting that is read by nothing does not ship.
  // ADR-105 — STAFF idle timeout. Seeded "never" so installing this release
  // changes nobody's behaviour until an admin chooses a duration. NOT public:
  // how long before an unattended admin screen locks is operational detail a
  // public page has no reason to serialise (security.md #12).
  ["general", "security.adminSessionTimeout", "never", "SELECT", "Admin session timeout", false],
  // changes-49 — the same timeout for LEARNER sessions, seeded "never" for
  // the same reason. Not public either.
  ["general", "security.learnerSessionTimeout", "never", "SELECT", "User session timeout", false],
  // ADR-157 — seeded OFF here so a fresh clone, CI and the integration suites
  // can sign in with the seeded admin, who has no authenticator. The live
  // defaults (`seed-live/defaults.json`) turn it ON for a deployed server.
  [
    "general",
    "security.requireStaffTwoFactor",
    false,
    "BOOLEAN",
    "Require two-factor for staff",
    false,
  ],

  // SEO
  ["seo", "seo.titleTemplate", "%s | %site%", "STRING", "Title template", true],
  ["seo", "seo.defaultOgImage", "/og-default.png", "IMAGE", "Default share image", true],
  ["seo", "seo.robotsIndex", true, "BOOLEAN", "Allow search indexing", false],
  ["seo", "seo.googleSiteVerification", "", "STRING", "Google Search Console verification", false],

  // Layout — homepage sections, ordered and toggleable without a deploy
  [
    "layout",
    "home.sections",
    [
      // `variant`/`limit` are optional (changes-03-plan.md §5.1): a section
      // with one sensible layout simply omits them. Every variant named here
      // is validated against HOME_SECTION_VARIANTS in @repo/contracts.
      // The hero opens the page — a full-bleed static band carrying the
      // brand footage, the <h1>, and the quick-start panel across its bottom
      // edge (changes-31).
      { key: "hero", enabled: true, order: 1, variant: "split" },

      // changes-52 P4 (ADR-167): live promotions set to "show in the home
      // band", directly under the hero — a webinar or an offer is the most
      // time-bound thing on the page. Seeded ENABLED because it renders
      // NOTHING while no promotion is live, the rule ADR-103 wrote for the
      // data-gated bands. Migration 20260929120000 appends it to an existing
      // install's list (create-only seed values never reach one).
      { key: "promotions", enabled: true, order: 2 },

      // OFF, and not a leftover. The video rail opened this page for two
      // years; the owner asked for the dynamic video content off the home
      // page (2026-09-15) and the hero's own footage took the position. The
      // component is still BUILT — `/learn` renders it with `variant: "grid"`,
      // which is the surface the published rows were always really for — so
      // the key stays here rather than moving to the stub list, and
      // `check:home-sections` keeps matching it against HOME_SECTION_BUILT_KEYS.
      //
      // A database seeded before this change still holds an ENABLED row, and
      // the homepage section composer is paused (ADR-038), so there is no
      // screen on which to flip it. `VideoShowcase` therefore renders nothing
      // for any variant but `grid` — see its own comment.
      //
      // changes-51 (owner): back on the home page as `strip` — a slider of
      // small cover cards straight after the glossary band (order 10, where
      // only disabled rows sat). Migration 20260922130000 moves an existing
      // install whose row still holds the old `grid` value.
      { key: "learning_videos", enabled: true, order: 10, variant: "strip", limit: 10 },
      // changes-31 (ADR-103). Placed where the reference puts them — the
      // marks a reader is asked to trust, then the figures that back the
      // claim, both directly under the hero and before the page starts
      // offering destinations.
      //
      // Seeded ENABLED, and that is not an oversight: each renders NOTHING
      // until the owner fills its dataset (ADR-103 §3), so a second off
      // switch would be a second reason for one absence. NOTE: like every
      // homepage row these are create-only — an existing database needs
      // `pnpm db:reset` to see them.
      //
      // changes-37 (ADR-121 §3): `trust_strip` is OFF at the owner's ask. The
      // demo dataset fills it with five invented publication names, and a row
      // of marks nobody can check reads as padding on a real page. The
      // component, its dataset and ADR-103's empty-renders-nothing rule are
      // untouched; re-enabling it is this one word once a real partner exists.
      { key: "trust_strip", enabled: false, order: 3 },
      // changes-39: `facts` is OFF at the owner's ask, the same way — four
      // figures ("60K+ learners taught") the owner has not supplied, filled
      // from the demo dataset. Off, not deleted: ADR-103's rule still stands.
      { key: "facts", enabled: false, order: 4 },
      { key: "explore_platform", enabled: true, order: 5, variant: "carousel" },
      // changes-32: OFF at the owner's ask. "Built to be understood, not to
      // impress" is six commitments about how the site teaches — true, and a
      // band the reader scrolls past on the way to the material those
      // commitments describe. The component and its catalog keys are kept, so
      // re-enabling it is this one word. (It named `/about` as the better home
      // for those claims; ADR-109 has since withdrawn that section, so the
      // choice is now this band or nowhere.)
      { key: "feature_highlights", enabled: false, order: 6, variant: "grid", limit: 6 },
      // changes-35 (ADR-116 §2): ONE desk band, not two feeds. `desk` renders
      // the lead NEWS story in a column of its own and a hairline-cut 2x2 of
      // ANALYSIS beside it — different size, different shape, its own label,
      // its own call to action. "What happened" and "what we make of it" stay
      // distinguishable, which is what the old comment here actually required;
      // two identical 3-up grids 400px apart was the weakest way to do it.
      //
      // `limit` is dropped: `desk` needs exactly one lead and exactly four
      // analysis rows, and a number that changes neither is a knob that lies.
      { key: "latest_news", enabled: true, order: 7, variant: "desk" },
      // OFF on the HOME PAGE only. The component, every variant and /analysis
      // itself are untouched — re-enabling this is one word, and the band
      // above degrades to news-only if it is.
      { key: "latest_analysis", enabled: false, order: 8, variant: "standard", limit: 3 },
      // changes-35 (ADR-116 §1 band C): `feature`, not `cards`. Three columns
      // — what the set is, the terms on a track, and the TERM OF THE DAY.
      // `getTermOfTheDay` has been built since changes-11 and no home band had
      // ever called it, so the day's term only ever appeared on `/glossary`,
      // the page a reader reaches once they already know they want a glossary.
      { key: "glossary_spotlight", enabled: true, order: 9, variant: "feature", limit: 8 },

      // The seven keys below are seeded but DISABLED, and that is the point:
      // nothing is built behind them, so enabling one renders the dashed
      // "Coming soon" placeholder. Seven of those between the real sections
      // is not a homepage, it is a construction site — and `explore_platform`
      // now says what is coming, in a card that looks designed.
      //
      // They stay in the list rather than being deleted so
      // `check:home-sections` keeps matching them against
      // HOME_SECTION_STUB_KEYS: a key that vanishes from the seed becomes a
      // stale stub entry and fails the check. Enabling one is a one-word
      // edit the day its component lands.
      //
      // Grouped together at the tail rather than interleaved: `order` is what
      // the page sorts on, so a disabled row's number is inert, and holding
      // them in one block is what makes "everything from here down is not
      // built yet" true by reading rather than by cross-referencing.
      { key: "learning_paths", enabled: false, order: 8, variant: "elevated", limit: 3 },
      { key: "forex_rates", enabled: false, order: 9, variant: "marquee" },
      { key: "economic_events", enabled: false, order: 10, limit: 5 },
      // Live as of changes-25 T9. OFF on the HOME PAGE since changes-35
      // (ADR-116 §7): `in_practice`'s third column names three tools and links
      // the rest, and a 4-up card grid here was the fourth grid of that shape
      // on one page. The component and `/tools` are untouched.
      { key: "popular_tools", enabled: false, order: 11, variant: "default", limit: 4 },
      { key: "featured_lessons", enabled: false, order: 12, variant: "default", limit: 3 },
      { key: "market_sentiment", enabled: false, order: 13 },
      { key: "trading_sessions", enabled: false, order: 14 },

      // changes-35 (ADR-116 §1 band D). Three kinds of proof in one band: what
      // a learner took from the material, a lesson they can watch now, and the
      // instruments to try it. It is the first home band fed by THREE datasets
      // and it degrades per COLUMN — three, two, one, or absent.
      //
      // Seeded ENABLED for the ADR-103 reason: a band that is absent when its
      // data is missing needs no second off switch.
      { key: "in_practice", enabled: true, order: 12 },

      // OFF on the HOME PAGE since changes-35 (ADR-116 §7). The quotes feed
      // `in_practice`'s first column now, one at a time on a dotted rail. The
      // cost is simultaneity and it is stated in the ADR rather than hidden:
      // re-enabling this row is one word, and `in_practice` degrades to two
      // columns by design if it comes back.
      { key: "testimonials", enabled: false, order: 13, limit: 3 },

      // changes-28 (ADR-093). Placed where the brief's screenshot puts it:
      // after the reading sections, before the newsletter ask — "here is where
      // else to find us" reads as a closing offer, not as a second header.
      // Renders nothing until an admin activates a social link. changes-35
      // took its video panel (ADR-116 §5), so it is one row now.
      // OFF since changes-49 (owner): "Follow us … remove this section from the
      // home page". The footer carries the social links and, signed out, the
      // subscribe strip; migration 20260922090000 flips an existing install.
      { key: "connect", enabled: false, order: 14 },

      // changes-35 (ADR-116 §6): questions BEFORE the ask. Answer the
      // objection, then request the email address — which is also the order
      // the reference closes in. `columns` is the two-column accordion under a
      // centred heading; `limit` is dropped so all six pairs render, three a
      // column.
      { key: "faq", enabled: true, order: 15, variant: "columns" },
      // OFF on the home page since changes-35 (owner, 2026-09-16): the
      // subscribe ask is now the inline END of the `connect` band, which had a
      // whole empty half after its video panel moved to `in_practice`. Two
      // bands making the same ask in two different colours, one of them half
      // empty, is what the merge removed.
      //
      // **Neither newsletter switch moved** (ADR-080 #5). The `newsletter`
      // FLAG and `newsletter.placements.home` still decide whether signup
      // exists and whether it is drawn on this page; `connect` reads both, and
      // the form still submits `source: "home"`. This row is the third thing —
      // whether the standalone BAND draws — and it no longer needs to.
      { key: "newsletter", enabled: false, order: 16, variant: "full-width" },
      // The page closes on a quote. `single` is the day's quote.
      { key: "quotes", enabled: true, order: 17, variant: "single" },
      // OFF since changes-35 (owner, changes-34). The disclaimer is printed in
      // full by the FOOTER's legal band, from `legal.riskDisclaimer` — the
      // admin-editable setting ADR-110 gave it — so the home page was carrying
      // a second, identical copy of it two elements above the first. One
      // source, one place it renders. `RiskDisclaimer` is untouched and every
      // other page's footer is unaffected.
      { key: "risk_disclaimer", enabled: false, order: 18 },
    ],
    "JSON",
    "Homepage sections",
    true,
  ],
  ["layout", "layout.containerWidth", "1400px", "STRING", "Max content width", true],
  ["layout", "layout.showBreadcrumbs", true, "BOOLEAN", "Show breadcrumbs", true],
  // SiteLoader's kill switch (ADR-018 rule 4d) — the brand preloader can be
  // switched off without a deploy. Default ON is safe: it is capped at 900ms,
  // shows once per tab session, and is skipped under reduced motion.
  ["layout", "layout.pageLoader", true, "BOOLEAN", "Show page loader on first visit", true],

  // Header (plan.md A6 — "Add header settings (layout group)"). Logo variant
  // per mode is already covered by BrandAsset, not a Setting.
  ["layout", "header.sticky", true, "BOOLEAN", "Sticky header", true],
  [
    "layout",
    "header.cta",
    { enabled: false, label: "Get Started", url: "/sign-up" },
    "JSON",
    "Header call-to-action button",
    true,
  ],
  [
    "layout",
    "header.announcementBar",
    { enabled: false, text: "", dismissible: true },
    "JSON",
    "Announcement bar",
    true,
  ],

  // Footer (plan.md A6 — "Add footer settings").
  [
    "layout",
    "footer.menuColumns",
    // All six footer menus, in reading order — the footer is a sitemap, not
    // a shortcut list, and since changes-36 that means a column per school
    // and a column for the Tools rows.
    //
    // **Six since changes-40, because Tools had outgrown one column.** It held
    // fifteen rows against the next-longest column's six, so the footer was
    // one tall stack beside four short ones and every row below the tenth sat
    // under a fold of empty grid. Split by what a row IS rather than by where
    // it appears in the header panel: a calculator takes numbers a reader
    // types, a market page shows numbers the market made.
    //
    // NOTE: the settings loop below never overwrites an existing VALUE, so a
    // database seeded before this line was widened keeps its old columns.
    // `20260918090000_footer_tools_split_changes40` is what moves an existing
    // install forward, bounded to a row still holding the previous seeded
    // value — an admin who edited their columns keeps their version, and
    // `footer_learn` stays in their database for exactly that case.
    [
      { menuKey: "footer_learn_forex", order: 1 },
      { menuKey: "footer_learn_crypto", order: 2 },
      { menuKey: "footer_tools", order: 3 },
      { menuKey: "footer_tools_markets", order: 4 },
      { menuKey: "footer_markets", order: 5 },
      { menuKey: "footer_company", order: 6 },
    ],
    "JSON",
    "Footer menu columns (which menus, in which order)",
    true,
  ],

  // Public design system (ADR-018 / changes-03-plan.md §5.1). All default to
  // OFF or empty: these add chrome to the public surface, so an install that
  // never touches them looks exactly as it does today.
  [
    "layout",
    "header.topBar",
    { enabled: false, phone: "", promoText: "", promoUrl: "" },
    "JSON",
    "Header top bar (contact + promo)",
    true,
  ],
  // ADR-108 — TRUE since changes-32. It was false while the control was a
  // magnifying glass linking to `/news`; there is a real ⌘K search behind it
  // now, and a site-wide search that ships switched off is a feature nobody
  // finds. `20260915180000_enable_header_search_changes32` does the same for
  // a database that already exists.
  ["layout", "header.showSearch", true, "BOOLEAN", "Show search in header", true],
  ["layout", "footer.showPaymentBadges", false, "BOOLEAN", "Show payment badges in footer", true],
  // Badge IMAGES are admin uploads (ADR-017); this stores only the links, so
  // no third-party logo is ever committed to the repo.
  ["layout", "footer.appLinks", [], "JSON", "Footer app-store links", true],

  // Legal (changes-33). The owner's own wording, which is the regulator's
  // wording: a forex risk disclaimer is the one paragraph in the footer
  // somebody is required to be able to find. Two paragraphs separated by a
  // blank line — the footer splits on it, because one 200-word block reads as
  // boilerplate nobody meant to be read.
  [
    "legal",
    "legal.riskDisclaimer",
    'Trading Contracts for Difference (CFDs) and spread bets involves a high level of risk due to the use of leverage. These instruments may not be suitable for all investors, as they can result in rapid losses as well as potential gains. Before trading with MBFX Global Limited ("MBFX"), please ensure that you fully understand how CFDs and spread bets work and carefully consider whether you can afford to take the high risk of losing your money.\n\n' +
      "MBFX Global Limited is incorporated in Saint Lucia under registration number 2023-00532. In line with its commitment to regulatory compliance and due diligence, MBFX adheres to international KYC standards and may not be able to extend certain services in jurisdictions where local regulations restrict such activities. These regions currently include Australia, the United States, Brazil, Curaçao, Indonesia, Sint Eustatius, Tahiti, Saipan, Turkey, Guinea-Bissau, Japan, Bonaire, East Timor, Liberia, Micronesia, Northern Mariana Islands, Jan Mayen, South Sudan, Svalbard, the UAE, and other regions with similar restrictions. For more details, please review our Privacy Policy.",
    "TEXT",
    "Risk disclaimer",
    true,
  ],
  // Their OWN keys rather than two more sentences inside the disclaimer: the
  // footer prints them as separate lines, a translator handles an address
  // differently from a paragraph of risk prose, and either can be read alone
  // by a page the disclaimer does not appear on. Empty is a legitimate value
  // — an install that is not a registered company prints neither line.
  [
    "legal",
    "legal.companyRegistration",
    "2023-00532",
    "STRING",
    "Company registration number",
    true,
  ],
  [
    "legal",
    "legal.registeredAddress",
    "Ground Floor, Rodney Court Building, Rodney Bay, Gros Islet, Saint Lucia.",
    "TEXT",
    "Registered address",
    true,
  ],
  // Legal documents (ADR-110). The value is a site-relative PATH, and the
  // public address is `/legal/<doc>` — which does not move when an admin
  // uploads a replacement.
  //
  // These point at COMMITTED files under `apps/web/public/legal/`, not at
  // MediaAsset rows, for the reason the brand logos above record: a
  // MediaAsset row asserts that bytes exist in the storage driver's root,
  // which is git-ignored, so a seeded row 404s on a fresh checkout. An admin
  // who uploads their own through the picker gets an `/uploads/<key>` value
  // and the route serves it INLINE — the one deliberate exception to ADR-034
  // §1's attachment default, and PDF-only.
  ["legal", "legal.termsDocument", "/legal/terms.pdf", "DOCUMENT", "Terms (PDF)", true],
  [
    "legal",
    "legal.privacyDocument",
    "/legal/privacy.pdf",
    "DOCUMENT",
    "Privacy policy (PDF)",
    true,
  ],
  [
    "legal",
    "legal.agreementDocument",
    "/legal/agreement.pdf",
    "DOCUMENT",
    "Client agreement (PDF)",
    true,
  ],
  // News & Analysis (Module 15, ADR-015 #7 — module on/off is the news/
  // analysis feature flags; title template, OG fallback and disclaimer
  // reuse seo.*/legal.* keys).
  ["articles", "articles.perPage", 12, "NUMBER", "Articles per page", true],
  ["articles", "articles.showAuthor", true, "BOOLEAN", "Show author byline", true],
  ["articles", "articles.showReadingTime", true, "BOOLEAN", "Show reading time", true],
  ["articles", "articles.relatedCount", 3, "NUMBER", "Related articles (0 = off)", true],

  // Media v2 (Module 16, ADR-034 §1) — per-kind upload caps in bytes.
  // Server-side validation only, never rendered on a public page.
  [
    "media",
    "media.maxBytes.image",
    5 * 1024 * 1024,
    "NUMBER",
    "Max image upload size (bytes)",
    false,
  ],
  [
    "media",
    "media.maxBytes.video",
    100 * 1024 * 1024,
    "NUMBER",
    "Max video upload size (bytes)",
    false,
  ],
  [
    "media",
    "media.maxBytes.audio",
    20 * 1024 * 1024,
    "NUMBER",
    "Max audio upload size (bytes)",
    false,
  ],
  [
    "media",
    "media.maxBytes.document",
    20 * 1024 * 1024,
    "NUMBER",
    "Max document upload size (bytes)",
    false,
  ],

  // Data budget (Module 16, ADR-029 §5, PR 3.4) — policy in settings, not
  // architecture. Conservative Phase-6 defaults ("a panel may hold two
  // collections of six"); raising them is a DEVLOG entry citing a
  // Lighthouse run, not a code change.
  [
    "cms",
    "cms.dataBudget",
    {
      page: { collections: { warn: 6, block: 10 }, items: { warn: 36, block: 72 } },
      part: { collections: { warn: 2, block: 4 }, items: { warn: 12, block: 24 } },
    },
    "JSON",
    "Dynamic-data budget (collections/items per page and part)",
    false,
  ],

  [
    "legal",
    "legal.copyrightNotice",
    // {year} is a rendering-time token (Module 08 owns substitution), not
    // resolved here — plan.md A6: "copyright line (translatable, {year} token)".
    "© {year} MBFX Global Limited. All rights reserved.",
    "STRING",
    "Copyright notice",
    true,
  ],

  // ─── Email (Module 17, ADR-078) ────────────────────────────
  //
  // Sender identity and the shell. None of it is public: an email address a
  // site sends FROM is a spam magnet, and none of these render on a page.
  // The SMTP credentials are not settings at all — they live in
  // EmailTransport, super_admin-only, with the password sealed.
  ["email", "email.enabled", true, "BOOLEAN", "Send email", false],
  ["email", "email.fromName", "MBX Learning Center", "STRING", "From name", false],
  ["email", "email.fromEmail", "no-reply@mbxpro.com", "STRING", "From address", false],
  ["email", "email.replyTo", "", "STRING", "Reply-to address", false],
  [
    "email",
    "email.footerText",
    "You are receiving this because you have an account with MBX Learning Center.",
    "TEXT",
    "Email footer text",
    false,
  ],
  ["email", "email.postalAddress", "", "TEXT", "Postal address (bulk mail)", false],

  // Newsletter placement (ADR-080 #5). The `newsletter` FLAG decides whether
  // signup exists at all; these decide where it shows. They live in the
  // `email` group because `layout` is paused in admin (ADR-038), which is how
  // `footer.newsletterEnabled` became uneditable — changes-21 F7 deleted that
  // key, so these four are the only placement switches.
  ["email", "newsletter.placements.footer", true, "BOOLEAN", "Newsletter in the footer", false],
  ["email", "newsletter.placements.home", true, "BOOLEAN", "Newsletter on the homepage", false],
  ["email", "newsletter.placements.news", true, "BOOLEAN", "Newsletter on /news", false],
  ["email", "newsletter.placements.analysis", true, "BOOLEAN", "Newsletter on /analysis", false],

  // Announcement emails (ADR-171 #12), all read by `@repo/core`'s
  // announcements runner. 120 a minute suits SendGrid comfortably and is
  // raised once the list size is known (owner, D2); a Workspace SMTP account
  // needs it far lower.
  ["email", "email.campaignRatePerMinute", 120, "NUMBER", "Announcement emails per minute", false],
  ["email", "email.campaignBatchSize", 50, "NUMBER", "Announcement emails per batch", false],
  ["email", "announcements.inactiveDays", "30", "SELECT", "Inactive after (days)", false],

  // ─── AI platform (Module 18, ADR-097/099/100) ──────────────
  //
  // Every key here is `isPublic: false` and that is load-bearing: security.md
  // #12 forbids a non-public setting from serialising into a public RSC
  // payload, and Module 05's leak test covers the group. The provider key is
  // not a setting at all — it lives sealed in AiProvider, super_admin-only.
  //
  // `ai.enabled` is seeded OFF: a platform that can spend money does not
  // arrive spending it.
  ["ai", "ai.enabled", false, "BOOLEAN", "Enable AI features", false],
  ["ai", "ai.maxTokensPerRequest", 2000, "NUMBER", "Max output tokens per request", false],
  ["ai", "ai.monthlyBudgetUsd", 50, "NUMBER", "Monthly budget (USD, 0 = unlimited)", false],
  ["ai", "ai.budgetWarnPercent", 80, "NUMBER", "Warn at this percent of budget", false],
  ["ai", "ai.capBehavior", "DISABLE", "STRING", "Behaviour when the budget is reached", false],
  ["ai", "ai.rateLimitPerUserHour", 120, "NUMBER", "Max AI calls per user per hour", false],
  // The three tiers (ADR-099). A tier holds a model ID string, not a row id,
  // so it keeps meaning across a provider being deleted and re-created. The
  // cost dial is ONE place: when a cheaper model lands, an admin moves the
  // light tier once rather than editing six dropdowns.
  ["ai", "ai.model.light", "claude-haiku-4-5", "STRING", "Light tier model", false],
  ["ai", "ai.model.standard", "claude-sonnet-5", "STRING", "Standard tier model", false],
  ["ai", "ai.model.heavy", "claude-opus-5", "STRING", "Heavy tier model", false],
] as const;

// ─────────────────────────────────────────────────────────────
// 4b. EMAIL TEMPLATES (Module 17, ADR-078)
//
// The starting CONTENT lives in `../src/email-template-defaults.ts`, not
// here: the admin's "Reset to default" button needs the same five bodies,
// and a second copy of them is exactly the drift check:email-templates
// exists to prevent.
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// 5. FEATURE FLAGS
// ─────────────────────────────────────────────────────────────

const FEATURE_FLAGS = [
  ["content", "courses", "Courses", true, "PUBLIC"],
  ["content", "glossary", "Glossary", true, "PUBLIC"],
  ["content", "analysis", "Market analysis", true, "PUBLIC"],
  ["content", "news", "News feed", true, "PUBLIC"],
  // ADR-058 #7 — PUBLIC, not AUTHENTICATED. The learn layout is cached and
  // evaluates section flags with a null subject, so AUTHENTICATED here would
  // hide the Quizzes tab from everyone, signed in or not. Guests read quizzes;
  // STARTING AN ATTEMPT is what needs an account, and the attempt endpoints
  // enforce that themselves.
  ["content", "quizzes", "Quizzes", true, "PUBLIC"],
  // ADR-068 / changes-16 D10 — ON since PR 7 built the public routes. It was
  // seeded OFF until they existed, because a flag-off learn section is ABSENT
  // rather than disabled (changes-11 D25): a tab that leads to a 404 is worse
  // than no tab.
  ["content", "videos", "Videos", true, "PUBLIC"],
  ["tools", "calculators", "Trading calculators", true, "PUBLIC"],
  ["tools", "currency_converter", "Currency converter", true, "PUBLIC"],
  // Read by /tools/live-rates since ADR-136 §5. Seeded from Module 01 and read
  // by nothing until then (code-style.md #28).
  ["market", "market_data", "Live market data", true, "PUBLIC"],
  ["market", "economic_calendar", "Economic calendar", true, "PUBLIC"],
  // ADR-144 §5 — `currency_strength`, `comments`, `forums`, `user_accounts`
  // and `watchlists` were seeded since Module 01 and read by NO code, so they
  // are gone (code-style.md #28); `20260920090000_all_flags_on_changes46`
  // deletes them from an existing database. Every flag that remains is read by
  // a page and is seeded ON: the flags screen was removed in the same change,
  // so a flag seeded off would be one nobody could turn on.
  ["account", "progress_tracking", "Course progress tracking", true, "AUTHENTICATED"],
  ["account", "newsletter", "Newsletter signup", true, "PUBLIC"],
] as const;

// ─────────────────────────────────────────────────────────────
// 6. DEFAULT THEME TOKENS
//
// TODO(Module 02): these are @repo/theme's DEFAULT_BRAND/DEFAULT_LIGHT_SURFACE
// /DEFAULT_DARK_SURFACE/DEFAULT_DARK_BRAND_OVERRIDES/DEFAULT_LAYOUT constants
// (docs/reference/theme-engine.ts). @repo/db can't depend on @repo/theme
// either way — architecture.md #8 has the dependency pointing core → db, not
// db → theme — so this duplication is permanent, not a stopgap; keep
// ./default-theme-tokens.json in sync with Module 02's exports by hand, or
// better, move seeding of the default theme row into Module 02 once it
// lands and drop this block here. Values live in JSON, not this file,
// because code-style.md #1 bans hex literals outside @repo/theme. The hand
// sync drifted once (fixed with ADR-072); @repo/theme's seed-sync.test.ts
// now fails the moment the JSON and the exports disagree.
// ─────────────────────────────────────────────────────────────

const {
  DEFAULT_BRAND,
  DEFAULT_LIGHT_SURFACE,
  DEFAULT_DARK_SURFACE,
  DEFAULT_DARK_BRAND_OVERRIDES,
  DEFAULT_LAYOUT,
} = defaultThemeTokens;

// ─────────────────────────────────────────────────────────────
// RUN
// ─────────────────────────────────────────────────────────────

// Takes an injected client (rather than importing the app singleton) so
// integration tests can run it against a Testcontainers-provisioned
// database instead of the real dev/prod one.
export async function seed(db: PrismaClient) {
  console.log("Seeding…");

  // Permissions. `sortOrder` is the registry index, so a card lists its keys
  // in the order they were written (view → create → update → delete → publish)
  // rather than alphabetically, where "create" precedes "view" and a reader
  // scanning a role has to hunt for the one key that grants access at all.
  let permissionSortOrder = 0;
  for (const [groupName, key, label] of PERMISSIONS) {
    const sortOrder = permissionSortOrder++;
    await db.permission.upsert({
      where: { key },
      update: { groupName, label, sortOrder },
      create: { key, groupName, label, sortOrder },
    });
  }
  console.log(`  permissions: ${PERMISSIONS.length}`);

  const allPermissions = await db.permission.findMany();
  const permissionId = new Map(allPermissions.map((p) => [p.key, p.id]));

  // Roles + their grants
  for (const role of ROLES) {
    // Name and description are create-only: ADR-016 lets an admin rename a
    // system role, and every deploy re-seeds (ADR-183). The level stays
    // code-owned — no screen can change it.
    const record = await db.role.upsert({
      where: { key: role.key },
      update: { level: role.level, isSystem: true },
      create: {
        key: role.key,
        name: role.name,
        description: role.description,
        level: role.level,
        isSystem: true,
      },
    });

    const keys = role.permissions === ALL ? allPermissions.map((p) => p.key) : role.permissions;
    const known = keys.filter((k) => permissionId.has(k));

    // ADR-183: diff the code's grants against what the seed granted LAST time,
    // never against the role's current grants — those include an admin's
    // edits. A key the code newly grants is added, a key it stopped granting
    // is revoked, and everything else on the role is left as the admin set it.
    // An unledgered role (null) only gains what it is missing.
    const ledger = Array.isArray(record.seededPermissions)
      ? new Set(record.seededPermissions as string[])
      : null;
    const toGrant = ledger ? known.filter((k) => !ledger.has(k)) : known;
    const toRevoke = ledger ? [...ledger].filter((k) => !known.includes(k)) : [];

    if (toRevoke.length > 0) {
      await db.rolePermission.deleteMany({
        where: {
          roleId: record.id,
          permissionId: {
            in: toRevoke.map((k) => permissionId.get(k)).filter((id): id is string => Boolean(id)),
          },
        },
      });
    }
    await db.rolePermission.createMany({
      data: toGrant.flatMap((k) => {
        const pid = permissionId.get(k);
        return pid ? [{ roleId: record.id, permissionId: pid }] : [];
      }),
      skipDuplicates: true,
    });
    await db.role.update({ where: { id: record.id }, data: { seededPermissions: known } });
  }
  console.log(`  roles: ${ROLES.length}`);

  // Locales
  await db.locale.upsert({
    where: { code: "en" },
    update: {},
    create: {
      code: "en",
      name: "English",
      nativeName: "English",
      direction: "LTR",
      flagEmoji: "🇬🇧",
      isDefault: true,
      isActive: true,
      sortOrder: 1,
    },
  });
  // Seeded inactive so the switcher stays clean until content is translated.
  // The set is ADR-188's offered languages (en above, then ur, ar, hi, zh).
  // Spanish is no longer seeded, so a deleted `es` row stays deleted: this
  // seed runs on every deploy (ADR-183) and an upsert would recreate it.
  // fallbackCode is per-locale config, not a special case in code (ADR-007,
  // Module 06 SKILL.md): an LTR locale falls back to English content when
  // untranslated; an RTL locale does NOT — English content in an RTL layout
  // reads worse than a "not yet translated" notice, so ar/ur get no
  // fallbackCode at all and the resolution chain stops at "not translated."
  for (const l of [
    {
      code: "ur",
      name: "Urdu",
      nativeName: "اردو",
      direction: "RTL" as const,
      flagEmoji: "🇵🇰",
      sortOrder: 2,
      fallbackCode: null,
    },
    {
      code: "ar",
      name: "Arabic",
      nativeName: "العربية",
      direction: "RTL" as const,
      flagEmoji: "🇸🇦",
      sortOrder: 3,
      fallbackCode: null,
    },
    {
      code: "hi",
      name: "Hindi",
      nativeName: "हिन्दी",
      direction: "LTR" as const,
      flagEmoji: "🇮🇳",
      sortOrder: 4,
      fallbackCode: "en",
    },
    {
      code: "zh",
      name: "Chinese (Simplified)",
      nativeName: "简体中文",
      direction: "LTR" as const,
      flagEmoji: "🇨🇳",
      sortOrder: 5,
      fallbackCode: "en",
    },
  ]) {
    await db.locale.upsert({
      where: { code: l.code },
      update: {},
      create: { ...l, isDefault: false, isActive: false },
    });
  }
  console.log("  locales: 5 (en active)");

  // Theme — brand colours shared across modes, surfaces authored per mode.
  await db.theme.upsert({
    where: { key: "mbx-pro-default" },
    update: {
      brandColors: DEFAULT_BRAND,
      lightSurface: DEFAULT_LIGHT_SURFACE,
      darkSurface: DEFAULT_DARK_SURFACE,
      darkBrandOverrides: DEFAULT_DARK_BRAND_OVERRIDES,
      layoutTokens: DEFAULT_LAYOUT,
    },
    create: {
      key: "mbx-pro-default",
      name: "MBX Pro",
      description: "Default brand theme.",
      brandColors: DEFAULT_BRAND,
      lightSurface: DEFAULT_LIGHT_SURFACE,
      darkSurface: DEFAULT_DARK_SURFACE,
      darkBrandOverrides: DEFAULT_DARK_BRAND_OVERRIDES,
      layoutTokens: DEFAULT_LAYOUT,
      defaultMode: "SYSTEM",
      // A PRESET since changes-49 (ADR-148): the live palettes are the two
      // surface rows below, so this row is what "reset to the default"
      // applies, not what either surface reads.
      isActive: false,
      isSystem: true,
      scope: "both",
    },
  });

  // The public site's and the admin's own live palettes (changes-49, ADR-148).
  // Create-only: after the first seed each belongs to the theme editor, and a
  // re-seed must not overwrite an admin's colours.
  for (const [surface, name] of [
    ["web", "Public site"],
    ["admin", "Admin portal"],
  ] as const) {
    await db.theme.upsert({
      where: { key: `surface-${surface}` },
      update: {},
      create: {
        key: `surface-${surface}`,
        name,
        brandColors: DEFAULT_BRAND,
        lightSurface: DEFAULT_LIGHT_SURFACE,
        darkSurface: DEFAULT_DARK_SURFACE,
        darkBrandOverrides: DEFAULT_DARK_BRAND_OVERRIDES,
        layoutTokens: DEFAULT_LAYOUT,
        defaultMode: "SYSTEM",
        isActive: true,
        isSystem: true,
        scope: surface,
      },
    });
  }
  console.log("  theme: mbx-pro-default (active)");

  // Brand logos (changes-32). The theme shipped with colours and no marks, so
  // every surface that renders `BrandLogo` fell through to its `fallback` —
  // the site name as text — on a fresh install.
  //
  // These are STATIC files under `apps/web/public/brand/`, not MediaAsset
  // rows, and the distinction is deliberate: a MediaAsset row asserts that
  // bytes exist in the storage driver's root, which is git-ignored, so a row
  // pointing at a file nobody checked out 404s in every picker that lists it
  // (the same trap changes-28 recorded for the video-topic covers). A static
  // path is the shape `seo.defaultOgImage` already seeds.
  //
  // `create`-only per slot: an admin who has uploaded their own logo through
  // the theme editor keeps it through a re-seed. `mediaAssetId` stays null,
  // which is exactly what it means — there is no library row to protect from
  // deletion.
  const BRAND_LOGOS = [
    {
      key: "logo_light",
      url: "/brand/logo-light.png",
      altText: "MBX Pro",
      width: 833,
      height: 309,
    },
    {
      key: "logo_dark",
      url: "/brand/logo-dark.png",
      altText: "MBX Pro",
      width: 832,
      height: 309,
    },
  ];
  let seededLogos = 0;
  for (const logo of BRAND_LOGOS) {
    const existing = await db.brandAsset.findUnique({
      where: { key: logo.key },
      select: { id: true },
    });
    if (existing) continue;
    await db.brandAsset.create({ data: { ...logo, mimeType: "image/png" } });
    seededLogos += 1;
  }
  console.log(`  brand logos: ${seededLogos} created`);

  // Settings
  const translatableSettings = new Set<string>(TRANSLATABLE_SETTING_KEY_LIST);
  for (const [groupName, key, value, type, label, isPublic] of SETTINGS) {
    // A fact about the KEY, not a value an admin chose (ADR-165 #1), so it is
    // written on update as well as create.
    const isTranslatable = translatableSettings.has(key);
    await db.setting.upsert({
      where: { key },
      // Never overwrite a value an admin has already changed.
      update: { groupName, label, type: type as never, isPublic, isTranslatable },
      create: {
        key,
        groupName,
        value: value as never,
        type: type as never,
        label,
        isPublic,
        isTranslatable,
      },
    });
  }
  console.log(`  settings: ${SETTINGS.length}`);
  // Arabic (ADR-165/166): the translatable settings that seed with English text.
  console.log(`  arabic settings: ${await seedArabicSettings(db)} created`);

  // Feature flags
  for (const [groupName, key, label, isEnabled, visibility] of FEATURE_FLAGS) {
    await db.featureFlag.upsert({
      where: { key },
      update: { groupName, label },
      create: { key, groupName, label, isEnabled, visibility: visibility as never },
    });
  }
  console.log(`  feature flags: ${FEATURE_FLAGS.length}`);

  // ─── Email templates (Module 17, ADR-078 #5) ───────────────
  //
  // Code owns the SET of keys (EMAIL_TEMPLATES in @repo/contracts);
  // `../src/email-template-defaults.ts` owns the starting CONTENT, because the
  // admin's "Reset to default" reads the same array.
  // `scripts/check-email-templates.mjs` fails when the two disagree — neither
  // file can import the registry, because @repo/db sits upstream of
  // @repo/contracts.
  //
  // Both upserts are create-only on content: an edited template is never
  // overwritten by a later seed run, exactly like a settings value.
  for (const template of EMAIL_TEMPLATE_DEFAULTS) {
    await db.emailTemplate.upsert({
      where: { key: template.key },
      update: {},
      create: { key: template.key },
    });
    await db.emailTemplateTranslation.upsert({
      where: { templateKey_locale: { templateKey: template.key, locale: "en" } },
      update: {},
      create: {
        templateKey: template.key,
        locale: "en",
        subject: template.subject,
        preheader: template.preheader,
        mode: "RICH",
        bodyHtml: template.bodyHtml,
        translationStatus: "TRANSLATED",
      },
    });
    // changes-61 (ADR-184): a row still holding EXACTLY its pre-changes-61
    // body has never been edited, so it takes the new design. Matched on the
    // whole body, so an admin's wording is never overwritten (ADR-183).
    const previous = EMAIL_TEMPLATE_PREVIOUS_DEFAULTS.find((row) => row.key === template.key);
    if (previous) {
      await db.emailTemplateTranslation.updateMany({
        where: {
          templateKey: template.key,
          locale: "en",
          mode: "RICH",
          bodyHtml: previous.bodyHtml,
        },
        data: {
          subject: template.subject,
          preheader: template.preheader,
          bodyHtml: template.bodyHtml,
        },
      });
    }
  }
  console.log(`  email templates: ${EMAIL_TEMPLATE_DEFAULTS.length}`);
  // Arabic (ADR-166), create-only, after the English rows it translates.
  console.log(`  arabic email templates: ${await seedArabicEmailTemplates(db)} created`);

  // Email designs (ADR-172 #3): starting points for a custom email, create-only
  // under a fixed id, so an admin's edit or archive survives every later run.
  for (const design of EMAIL_DESIGN_DEFAULTS) {
    await db.emailDesign.upsert({
      where: { id: design.id },
      update: {},
      create: {
        id: design.id,
        name: design.name,
        description: design.description,
        mode: "RICH",
        subject: design.subject,
        preheader: design.preheader || null,
        bodyHtml: design.bodyHtml,
        createdById: "seed",
      },
    });
    // changes-61: an unedited design takes the new body (see the defaults file).
    const previousBody = EMAIL_DESIGN_PREVIOUS_BODIES[design.id];
    if (previousBody) {
      await db.emailDesign.updateMany({
        where: { id: design.id, bodyHtml: previousBody },
        data: { bodyHtml: design.bodyHtml },
      });
    }
  }
  console.log(`  email designs: ${EMAIL_DESIGN_DEFAULTS.length}`);

  // Social links
  for (const link of SOCIAL_LINKS) {
    await db.socialLink.upsert({
      where: { platform: link.platform },
      // Create-only: an admin edits these at Settings, and a deploy re-seeds
      // (ADR-183).
      update: {},
      create: { ...link, isActive: true, showInFooter: true, showInHeader: false },
    });
  }
  console.log(`  social links: ${SOCIAL_LINKS.length}`);

  // Review platforms (ADR-169). `create`-only: an admin's switch, order,
  // identifier and link are never overwritten by a later seed run, and the
  // migration may already have created Trustpilot from `site.reviewsUrl`.
  for (const [sortOrder, platform] of REVIEW_PLATFORM_SEED_KEYS.entries()) {
    await db.reviewPlatform.upsert({
      where: { platform },
      update: {},
      create: { platform, sortOrder, ...REVIEW_PLATFORM_SEED_DEFAULTS[platform] },
    });
  }
  console.log(`  review platforms: ${REVIEW_PLATFORM_SEED_KEYS.length}`);

  // Departments
  for (const d of [
    { key: "content", name: "Content & Education", sortOrder: 1 },
    { key: "engineering", name: "Engineering", sortOrder: 2 },
    { key: "research", name: "Market Research", sortOrder: 3 },
    { key: "marketing", name: "Marketing & SEO", sortOrder: 4 },
    { key: "support", name: "Customer Support", sortOrder: 5 },
    { key: "operations", name: "Operations", sortOrder: 6 },
  ]) {
    await db.department.upsert({ where: { key: d.key }, update: { name: d.name }, create: d });
  }

  for (const d of [
    { key: "head_of_content", title: "Head of Content", level: 80 },
    { key: "senior_editor", title: "Senior Editor", level: 60 },
    { key: "content_writer", title: "Content Writer", level: 40 },
    { key: "market_analyst", title: "Market Analyst", level: 50 },
    { key: "senior_engineer", title: "Senior Engineer", level: 70 },
    { key: "engineer", title: "Software Engineer", level: 50 },
    { key: "seo_specialist", title: "SEO Specialist", level: 50 },
    { key: "support_agent", title: "Support Agent", level: 30 },
  ]) {
    await db.designation.upsert({ where: { key: d.key }, update: { title: d.title }, create: d });
  }
  console.log("  departments: 6, designations: 8");

  // Navigation
  const mainMenu = await db.menu.upsert({
    where: { key: "main" },
    update: {},
    create: { key: "main", name: "Main navigation", location: "header" },
  });

  // The header's flat rows. The learning entries are NOT here — ADR-065 §4
  // replaced the single "Learn" row with one root per track, each carrying
  // three children, and those are seeded as trees below.
  const NAV = [
    {
      routeKey: "glossary",
      label: "Glossary",
      icon: "book-a",
      requiresFeature: "glossary",
      sortOrder: 3,
    },
    {
      routeKey: "analysis",
      label: "Analysis",
      icon: "line-chart",
      requiresFeature: "analysis",
      sortOrder: 6,
    },
    { routeKey: "news", label: "News", icon: "newspaper", requiresFeature: "news", sortOrder: 8 },
    // Support (ADR-109). A FLAT row where the About section was a tree of
    // five: one page needs no dropdown, and a mega panel over a single
    // destination is a popup that says the page's own name. No
    // `requiresFeature` — it is a coded route that always exists.
    {
      routeKey: "support",
      label: "Support",
      icon: "headset",
      requiresFeature: null,
      sortOrder: 9,
    },
  ];

  // Rows a later decision replaced. An upsert seed never DELETES, so without
  // this an existing database keeps them: the `learn` umbrella root ADR-065 §4
  // replaced with one root per school, and the `markets` and `about` rows
  // ADR-109 withdrew — the latter in the header, where it was a root with five
  // children, AND in `footer_company`, where all six were flat rows.
  //
  // Deleting by routeKey is safe in exactly the way overwriting a settings
  // VALUE is not: a menu row's `routeKey` has to exist in `ROUTE_PATHS` to
  // resolve to a URL at all, and these no longer do. Leaving them would put
  // unresolvable entries in the header and the footer, not preserve an
  // admin's preference.
  //
  // `MenuTree` cascades on delete (schema.prisma), so removing a root takes
  // its children with it; the `in` list below still names the About children
  // explicitly because `footer_company` carried them as ROOTS of its own.
  const supersededLearnRoot = await db.menuItem.findFirst({
    where: { menuId: mainMenu.id, routeKey: "learn", parentId: null },
    select: { id: true },
  });
  if (supersededLearnRoot) await db.menuItem.delete({ where: { id: supersededLearnRoot.id } });

  // The flat "Calendar" header row, which ADR-115 moved INTO the Tools tree.
  //
  // Scoped to [mainMenu, routeKey, parentId: null], and the scope is doing
  // real work here in a way ADR-109's `deleteMany` did not need: unlike
  // `markets` and `about`, this routeKey still resolves in `ROUTE_PATHS`, and
  // two other rows share it — the `footer_markets` entry and the new Tools
  // child. A broad delete would take both, and `upsertNavTree` would put the
  // child back while the footer quietly lost a link.
  const supersededCalendarRow = await db.menuItem.findFirst({
    where: { menuId: mainMenu.id, routeKey: "economic-calendar", parentId: null },
    select: { id: true },
  });
  if (supersededCalendarRow) await db.menuItem.delete({ where: { id: supersededCalendarRow.id } });

  await db.menuItem.deleteMany({
    where: {
      routeKey: {
        in: [
          "markets",
          "about",
          "about-why-us",
          "about-transparency",
          "about-security",
          "about-support",
        ],
      },
    },
  });

  for (const item of NAV) {
    const existing = await db.menuItem.findFirst({
      where: { menuId: mainMenu.id, routeKey: item.routeKey },
    });
    const record = existing
      ? await db.menuItem.update({
          where: { id: existing.id },
          data: { icon: item.icon, sortOrder: item.sortOrder },
        })
      : await db.menuItem.create({
          data: {
            menuId: mainMenu.id,
            routeKey: item.routeKey,
            icon: item.icon,
            sortOrder: item.sortOrder,
            requiresFeature: item.requiresFeature,
            isActive: true,
          },
        });

    await db.menuItemTranslation.upsert({
      where: { menuItemId_locale: { menuItemId: record.id, locale: "en" } },
      update: { label: item.label },
      create: { menuItemId: record.id, locale: "en", label: item.label },
    });
  }

  // The two schools (ADR-065 §4) — the header entries that replaced "Learn",
  // each with the same three surfaces under it. The panel's COMPOSITION lives
  // in `_nav/mega-menu.ts` (ADR-048); what is here is what the database owns:
  // which rows exist, their order, their labels and their hrefs.
  //
  // `requiresFeature` per child, copied from the surface each one points at,
  // so switching `quizzes` off empties the row from both panels and both
  // section bars at once rather than leaving a link to a 404.
  const TRACK_NAV = [
    { track: "forex", label: "Learn Forex", sortOrder: 1 },
    { track: "crypto", label: "Learn Crypto", sortOrder: 2 },
  ].map(({ track, label, sortOrder }) => ({
    routeKey: `learn-${track}`,
    label,
    icon: "graduation-cap",
    requiresFeature: "courses",
    sortOrder,
    children: [
      {
        routeKey: `learn-${track}`,
        label: "Courses",
        title: "Structured lessons, start to finish",
        icon: "graduation-cap",
        requiresFeature: "courses",
        sortOrder: 1,
      },
      // Videos before Quizzes, matching `LEARN_TRACK_SURFACES` — that
      // registry declares section-bar order, and the header, the section bar
      // and the mega-menu panel all read the same sequence.
      {
        routeKey: `learn-${track}-videos`,
        label: "Videos",
        title: "Short walkthroughs, one topic each",
        icon: "video",
        requiresFeature: "videos",
        sortOrder: 2,
      },
      {
        routeKey: `learn-${track}-quizzes`,
        label: "Quizzes",
        title: "Check what stuck, one topic at a time",
        icon: "list-checks",
        requiresFeature: "quizzes",
        sortOrder: 3,
      },
      {
        routeKey: `learn-${track}-glossary`,
        label: "Glossary",
        title: "Every term this school uses, explained",
        icon: "book-a",
        requiresFeature: "glossary",
        sortOrder: 4,
      },
      // The umbrella, from inside each school. Deliberately the last row and
      // not a "view all" footer — the footer would read "Learn Forex · View
      // all" and land on a page covering both schools (ADR-065 §4).
      {
        routeKey: "learn",
        label: "All learning",
        title: "Both schools in one place",
        icon: "layers",
        requiresFeature: "courses",
        sortOrder: 5,
      },
    ],
  }));

  // The eight tools (ADR-086 §9 / changes-25 T9). A TREE rather than a flat
  // row, so the header gets a mega panel in the same shape as About and the
  // two schools — three headed columns and a "view all" footer, which
  // `mega-menu.ts` composes from these route keys.
  //
  // Built from TOOL_KEYS rather than typed out, so a ninth tool arrives in the
  // header from the same edit that registers it. The `title` is the one-line
  // description the panel renders under each label.
  // The eight tools (ADR-086 §9 / changes-25 T9). A TREE rather than a flat
  // row, so the header gets a mega panel in the same shape as About and the
  // two schools — three headed columns and a "view all" footer, which
  // `mega-menu.ts` composes from these route keys.
  //
  // **Spelled out rather than imported from `TOOLS`.** `@repo/db` does not
  // depend on `@repo/contracts`, and does not acquire the dependency for a
  // list of eight labels — the HOME_PAGE_LAYOUT note at the top of this file
  // is the same call. `contracts/tools.test.ts` is what keeps the two honest:
  // it fails on a `tool-*` route key with no registered tool, or the reverse.
  //
  // The `title` is the one-line description the mega panel renders under
  // each label.
  const TOOLS_NAV = {
    routeKey: "tools",
    label: "Tools",
    icon: "calculator",
    sortOrder: 4,
    requiresFeature: "calculators",
    children: [
      {
        routeKey: "tool-position-size",
        label: "Position size calculator",
        title: "How big a trade your risk allows",
        icon: "calculator",
        sortOrder: 1,
      },
      {
        routeKey: "tool-pip-value",
        label: "Pip calculator",
        title: "What one pip is worth to you",
        icon: "coins",
        sortOrder: 2,
      },
      // changes-41 (ADR-135): the three calculators the reference carries.
      {
        routeKey: "tool-margin",
        label: "Margin calculator",
        title: "The deposit a position ties up",
        icon: "scale",
        sortOrder: 3,
      },
      {
        routeKey: "tool-profit-loss",
        label: "Profit & loss calculator",
        title: "What a trade makes between two prices",
        icon: "trending-up",
        sortOrder: 4,
      },
      {
        routeKey: "tool-risk-reward",
        label: "Risk & reward calculator",
        title: "Risk, reward and size from three prices",
        icon: "shield-check",
        sortOrder: 5,
      },
      {
        routeKey: "tool-gain-loss",
        label: "Gain & loss calculator",
        title: "And what it takes to get back to even",
        icon: "percent",
        sortOrder: 6,
      },
      {
        routeKey: "tool-pivot-points",
        label: "Pivot points",
        title: "Five methods, one table",
        icon: "git-fork",
        sortOrder: 7,
      },
      {
        routeKey: "tool-market-hours",
        label: "Market hours",
        title: "Which sessions are open right now",
        icon: "clock",
        sortOrder: 8,
      },
      {
        routeKey: "tool-currency-converter",
        label: "Currency converter",
        title: "And what a markup really costs",
        icon: "arrow-left-right",
        requiresFeature: "currency_converter",
        sortOrder: 9,
      },
      {
        routeKey: "tool-correlation",
        label: "Correlation",
        title: "Which pairs move together",
        icon: "grid-3x3",
        sortOrder: 10,
      },
      {
        routeKey: "tool-risk-sentiment",
        label: "Risk on / risk off",
        title: "Where the market has been leaning",
        icon: "gauge",
        sortOrder: 11,
      },
      // The economic calendar, moved here from a flat header row (ADR-115).
      // NOT a ninth member of `TOOLS`: it keeps `/economic-calendar`, its own
      // flag and ADR-050's embedded widget, and has no config, no island and
      // no `Tool` row. A menu is a list of destinations, and nothing about
      // appearing in this panel requires being a registered tool — which is
      // why `contracts/tools.test.ts` still reads `tool-*` keys only.
      {
        routeKey: "economic-calendar",
        label: "Economic calendar",
        title: "What is scheduled, and when",
        icon: "calendar",
        requiresFeature: "economic_calendar",
        sortOrder: 12,
      },
      // The two market boards (ADR-136 §5). Like the calendar they are NOT
      // `TOOLS` members: coded pages with no `Tool` row, so their route keys
      // carry no `tool-` prefix.
      {
        routeKey: "live-rates",
        label: "Live rates",
        title: "Quotes for majors, minors, exotics and metals",
        icon: "candlestick-chart",
        requiresFeature: "market_data",
        sortOrder: 13,
      },
      {
        routeKey: "volatility",
        label: "Volatility",
        title: "How far each pair has been moving",
        icon: "activity",
        sortOrder: 14,
      },
      // "Around the markets" (changes-40) — the headline feed as a page of
      // its own, on the same footing as the two boards above it: a framed
      // vendor widget with our chrome and no `Tool` row.
      {
        routeKey: "market-news",
        label: "Market news",
        title: "Headlines from the major providers",
        icon: "newspaper",
        requiresFeature: "market_data",
        sortOrder: 15,
      },
    ],
  };

  /**
   * A root row and its children, matched the way every row above is: the
   * parent on [menuId, routeKey, parentId: null], the children on the same
   * plus their parent — children share the menu with their own routeKeys, so
   * the parentId is what keeps the lookup unambiguous.
   */
  async function upsertNavTree(spec: {
    routeKey: string;
    label: string;
    icon: string;
    sortOrder: number;
    requiresFeature?: string;
    children: {
      routeKey: string;
      label: string;
      title: string;
      icon: string;
      sortOrder: number;
      requiresFeature?: string;
    }[];
  }) {
    const rootExisting = await db.menuItem.findFirst({
      where: { menuId: mainMenu.id, routeKey: spec.routeKey, parentId: null },
    });
    const root = rootExisting
      ? await db.menuItem.update({
          where: { id: rootExisting.id },
          data: { icon: spec.icon, sortOrder: spec.sortOrder },
        })
      : await db.menuItem.create({
          data: {
            menuId: mainMenu.id,
            routeKey: spec.routeKey,
            icon: spec.icon,
            sortOrder: spec.sortOrder,
            requiresFeature: spec.requiresFeature,
            isActive: true,
          },
        });
    await db.menuItemTranslation.upsert({
      where: { menuItemId_locale: { menuItemId: root.id, locale: "en" } },
      update: { label: spec.label },
      create: { menuItemId: root.id, locale: "en", label: spec.label },
    });

    for (const child of spec.children) {
      const existing = await db.menuItem.findFirst({
        where: { menuId: mainMenu.id, parentId: root.id, routeKey: child.routeKey },
      });
      const record = existing
        ? await db.menuItem.update({
            where: { id: existing.id },
            data: { icon: child.icon, sortOrder: child.sortOrder },
          })
        : await db.menuItem.create({
            data: {
              menuId: mainMenu.id,
              parentId: root.id,
              routeKey: child.routeKey,
              icon: child.icon,
              sortOrder: child.sortOrder,
              requiresFeature: child.requiresFeature,
              isActive: true,
            },
          });

      await db.menuItemTranslation.upsert({
        where: { menuItemId_locale: { menuItemId: record.id, locale: "en" } },
        update: { label: child.label, title: child.title },
        create: {
          menuItemId: record.id,
          locale: "en",
          label: child.label,
          title: child.title,
        },
      });
    }
  }

  for (const tree of [...TRACK_NAV, TOOLS_NAV]) await upsertNavTree(tree);

  // Footer menus — referenced by the footer.menuColumns setting (A6).
  //
  // The footer is a SITEMAP: every destination the header offers has a footer
  // row too, so a visitor who has scrolled to the bottom never has to scroll
  // back up to reach a section. That sentence has been here since Module 08
  // and stopped being TRUE twice — ADR-065 split Learn into two schools with
  // four surfaces each, and ADR-086 put eight calculators behind one "Tools"
  // link. Three columns carrying eight rows described a header that has
  // thirty-three destinations in it (changes-36).
  //
  // So the grouping now mirrors the header's own top level: one column per
  // school, one for the Tools panel, one for the reading surfaces, one for
  // the company pages. `LINK_GRID_CLASS` in footer.tsx already answered for
  // five — column COUNT has been data since it was written.
  //
  // **`footer_learn` is deliberately no longer seeded.** It is not deleted
  // either: an existing database whose `footer.menuColumns` still names it
  // (because the changes-36 migration's bounded WHERE did not match a value
  // its admin had already edited) keeps a working three-column footer, and a
  // fresh install simply never creates it. Seeding a menu that nothing lists
  // is the same defect as seeding a setting nothing reads.
  //
  // `requiresFeature` is copied from the header row for the same route on
  // purpose: buildMenu prunes on the flag, so switching `courses` off
  // empties the school columns and the header entries together instead of
  // leaving dead links at the bottom of every page. A column whose every row
  // is pruned reserves no grid cell (footer.tsx filters on `items.length`),
  // which is what keeps a flag-off section from leaving a titled hole. The
  // Company rows carry no flag — they are coded routes that always exist.
  const FOOTER_TRACK_MENUS = [
    { track: "forex", name: "Learn Forex" },
    { track: "crypto", name: "Learn Crypto" },
  ].map(({ track, name }) => ({
    key: `footer_learn_${track}`,
    name,
    // The school's four surfaces, in `LEARN_TRACK_SURFACES` order — the same
    // sequence the section bar, the mega panel and the header tree read, so
    // the footer cannot present them in an order nobody chose.
    items: [
      { routeKey: `learn-${track}`, label: "Courses", requiresFeature: "courses" },
      { routeKey: `learn-${track}-videos`, label: "Videos", requiresFeature: "videos" },
      { routeKey: `learn-${track}-quizzes`, label: "Quizzes", requiresFeature: "quizzes" },
      { routeKey: `learn-${track}-glossary`, label: "Glossary", requiresFeature: "glossary" },
    ],
  }));

  const FOOTER_MENUS = [
    ...FOOTER_TRACK_MENUS,
    {
      // The header's Tools panel, in TWO columns since changes-40 — the rows
      // are spelled out here for the reason TOOLS_NAV above is: `@repo/db`
      // does not depend on `@repo/contracts`, and `contracts/tools.test.ts` is
      // what keeps a `tool-*` key and a registered tool from drifting apart.
      //
      // The split is by what a row IS, not by which panel column it sits in:
      // everything here takes numbers the READER supplies and works something
      // out from them. That is also why the currency converter is here rather
      // than with the rates — a reader converting 500 euros is doing
      // arithmetic about their own money, not watching a market.
      key: "footer_tools",
      name: "Calculators",
      items: [
        {
          routeKey: "tool-position-size",
          label: "Position size calculator",
          requiresFeature: "calculators",
        },
        { routeKey: "tool-pip-value", label: "Pip calculator", requiresFeature: "calculators" },
        { routeKey: "tool-margin", label: "Margin calculator", requiresFeature: "calculators" },
        {
          routeKey: "tool-profit-loss",
          label: "Profit & loss calculator",
          requiresFeature: "calculators",
        },
        {
          routeKey: "tool-risk-reward",
          label: "Risk & reward calculator",
          requiresFeature: "calculators",
        },
        {
          routeKey: "tool-gain-loss",
          label: "Gain & loss calculator",
          requiresFeature: "calculators",
        },
        {
          routeKey: "tool-currency-converter",
          label: "Currency converter",
          requiresFeature: "currency_converter",
        },
      ],
    },
    {
      // The other half: pages that SHOW the market rather than calculate
      // against it. Pivot points and the two relationship tools sit here and
      // not with the calculators because none of them asks the reader for a
      // price — they read the stored bars and report what happened.
      key: "footer_tools_markets",
      name: "Market data",
      items: [
        { routeKey: "live-rates", label: "Live rates", requiresFeature: "market_data" },
        { routeKey: "volatility", label: "Volatility", requiresFeature: "calculators" },
        { routeKey: "tool-correlation", label: "Correlation", requiresFeature: "calculators" },
        {
          routeKey: "tool-risk-sentiment",
          label: "Risk on / risk off",
          requiresFeature: "calculators",
        },
        { routeKey: "tool-pivot-points", label: "Pivot points", requiresFeature: "calculators" },
        { routeKey: "tool-market-hours", label: "Market hours", requiresFeature: "calculators" },
        // The headline feed (changes-40), on the same footing as the boards.
        { routeKey: "market-news", label: "Market news", requiresFeature: "market_data" },
        // Listed here AND in the reading column below, which is not an
        // oversight: a sitemap is meant to be findable from wherever a reader
        // is looking, and the header does the same thing with `learn` (a row
        // inside both school panels). ADR-115 put the calendar in the Tools
        // menu; it is still a market page.
        {
          routeKey: "economic-calendar",
          label: "Economic calendar",
          requiresFeature: "economic_calendar",
        },
      ],
    },
    {
      // Renamed from "Markets & Tools": the eight calculators moved to their
      // own column, so what is left is the reading surfaces plus the two
      // umbrella indexes.
      key: "footer_markets",
      name: "News & Markets",
      items: [
        { routeKey: "news", label: "News", requiresFeature: "news" },
        { routeKey: "analysis", label: "Market analysis", requiresFeature: "analysis" },
        {
          routeKey: "economic-calendar",
          label: "Economic calendar",
          requiresFeature: "economic_calendar",
        },
        { routeKey: "tools", label: "All tools", requiresFeature: "calculators" },
        { routeKey: "glossary", label: "Glossary", requiresFeature: "glossary" },
        { routeKey: "learn", label: "All learning", requiresFeature: "courses" },
      ],
    },
    {
      key: "footer_company",
      name: "Company",
      items: [
        { routeKey: "support", label: "Support", requiresFeature: null },
        { routeKey: "sitemap", label: "Sitemap", requiresFeature: null },
      ],
    },
  ] satisfies {
    key: string;
    name: string;
    items: { routeKey: string; label: string; requiresFeature: string | null }[];
  }[];

  let footerItemCount = 0;
  for (const menu of FOOTER_MENUS) {
    // `name` IS updated on re-seed, unlike the main menu's: the footer
    // renders it as the column heading, so a stale "Footer — Learn" would
    // be visible on every public page. Menu ITEMS keep the usual
    // create-or-update-ordering shape.
    const footerMenu = await db.menu.upsert({
      where: { key: menu.key },
      update: { name: menu.name, location: "footer" },
      create: { key: menu.key, name: menu.name, location: "footer" },
    });

    for (const [index, item] of menu.items.entries()) {
      const sortOrder = index + 1;
      const existing = await db.menuItem.findFirst({
        where: { menuId: footerMenu.id, routeKey: item.routeKey },
      });
      const record = existing
        ? await db.menuItem.update({
            where: { id: existing.id },
            data: { sortOrder, requiresFeature: item.requiresFeature },
          })
        : await db.menuItem.create({
            data: {
              menuId: footerMenu.id,
              routeKey: item.routeKey,
              sortOrder,
              requiresFeature: item.requiresFeature,
              isActive: true,
            },
          });
      await db.menuItemTranslation.upsert({
        where: { menuItemId_locale: { menuItemId: record.id, locale: "en" } },
        update: { label: item.label },
        create: { menuItemId: record.id, locale: "en", label: item.label },
      });
      footerItemCount += 1;
    }

    // ─── A footer menu's rows are REPLACED, not merged (changes-40) ──────
    //
    // `rolePermission`'s discipline above, for the same reason: this file is
    // the source of truth for the footer, `footer-sitemap.test.ts` asserts
    // against THIS list rather than against the database, and until now a row
    // that left a menu simply stayed in it for ever.
    //
    // It was not hypothetical. changes-40 moved eight rows out of
    // `footer_tools` into `footer_tools_markets`, and a reseeded install drew
    // both columns in full — the Calculators column still listing pivot
    // points, correlation, the two market boards and the calendar, with
    // "Market hours" appearing twice in one footer.
    //
    // Scoped to THIS menu, which is the whole safety of it: `economic-calendar`
    // is deliberately in two footer menus and `learn-forex` is in two header
    // trees, so a delete by routeKey alone would take the copy that belongs
    // somewhere else. Cascades from `menuItem` handle the translations.
    await db.menuItem.deleteMany({
      where: {
        menuId: footerMenu.id,
        routeKey: { notIn: menu.items.map((item) => item.routeKey) },
      },
    });
  }

  console.log(`  menu items: ${NAV.length + footerItemCount + 1}`);
  console.log(`  arabic menu labels: ${await seedArabicMenuLabels(db)} created`);

  // Redirects for the pages ADR-109 withdrew.
  //
  // `/about/support` → `/support` is a genuine MOVE and the one that matters:
  // it was the only page in that section a reader arrives at with a question,
  // and it is still here under a shorter address. The other four are NOT
  // moves — nothing replaced them — and they go to `/support` rather than 404
  // for the same reason `ComingSoon` was built (changes-22): a reader who
  // followed a link from somewhere still deserves a page, and `/support` is
  // the one thing this site can still offer someone who was looking for a
  // company page. `/markets` goes to `/tools`, which is the market surface
  // that actually exists.
  //
  // These work only because `about` and `markets` left RESERVED_PATHS in the
  // same change: `resolvePublicPage` returns not-found for a reserved segment
  // BEFORE it looks at this table.
  //
  // The last three are the addresses people TYPE (changes-62 #6): a
  // reader, or a crawler guessing at a company site, tries `/privacy` and
  // `/terms` before `/legal/privacy`, and `/contact` before `/support`. The
  // legal pages answer 404 by themselves while no document is chosen, so a
  // redirect never invents a page that is not there.
  //
  // `create`-only per row: an admin who has since repointed one of these
  // keeps their version.
  const WITHDRAWN_ROUTES: [string, string][] = [
    ["/about/support", "/support"],
    ["/about", "/support"],
    ["/about/why-us", "/support"],
    ["/about/transparency", "/support"],
    ["/about/security", "/support"],
    ["/markets", "/tools"],
    ["/privacy", "/legal/privacy"],
    ["/terms", "/legal/terms"],
    ["/contact", "/support"],
  ];
  let seededRedirects = 0;
  for (const [fromPath, toPath] of WITHDRAWN_ROUTES) {
    const existing = await db.redirect.findUnique({
      where: { fromPath },
      select: { id: true },
    });
    if (existing) continue;
    await db.redirect.create({ data: { fromPath, toPath, statusCode: 301 } });
    seededRedirects += 1;
  }
  console.log(`  redirects: ${seededRedirects} created`);

  // Article taxonomy (Module 15, ADR-015). Categories are required by
  // Article.categoryId, so the admin flow needs at least these to exist;
  // tags are convenience starters. Idempotent via the [locale, slug]
  // uniqueness on translation rows — no sample articles, same restraint as
  // glossary content.
  const ARTICLE_CATEGORIES = [
    { slug: "market-news", name: "Market News", sortOrder: 1 },
    { slug: "central-banks", name: "Central Banks", sortOrder: 2 },
    { slug: "technical-analysis", name: "Technical Analysis", sortOrder: 3 },
    { slug: "trade-ideas", name: "Trade Ideas", sortOrder: 4 },
  ];
  for (const c of ARTICLE_CATEGORIES) {
    const existing = await db.articleCategoryTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: c.slug } },
      select: { categoryId: true },
    });
    if (existing) {
      await db.articleCategory.update({
        where: { id: existing.categoryId },
        data: { sortOrder: c.sortOrder },
      });
    } else {
      await db.articleCategory.create({
        data: {
          sortOrder: c.sortOrder,
          translations: { create: { locale: "en", name: c.name, slug: c.slug } },
        },
      });
    }
  }

  const ARTICLE_TAGS = [
    { slug: "eur-usd", name: "EUR/USD" },
    { slug: "gbp-usd", name: "GBP/USD" },
    { slug: "usd-jpy", name: "USD/JPY" },
    { slug: "gold", name: "Gold" },
    { slug: "crude-oil", name: "Crude Oil" },
    { slug: "fed", name: "Fed" },
    { slug: "ecb", name: "ECB" },
  ];
  for (const tag of ARTICLE_TAGS) {
    const existing = await db.articleTagTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: tag.slug } },
      select: { id: true },
    });
    if (!existing) {
      await db.articleTag.create({
        data: { translations: { create: { locale: "en", name: tag.name, slug: tag.slug } } },
      });
    }
  }
  console.log(
    `  article taxonomy: ${ARTICLE_CATEGORIES.length} categories, ${ARTICLE_TAGS.length} tags`,
  );

  // ─────────────────────────────────────────────────────────────
  // LEARN AREA — demo courses (changes-11 PR 1.4, ADR-055)
  //
  // One published course per registered LEARN_TRACKS key. Both tracks ship a
  // course deliberately: `forex` and `crypto` are both registered in code, and
  // a track with no published courses must render NO band (ADR-055 #2), so
  // seeding only one would hide that rule behind an empty result rather than
  // exercising it. The empty-band case gets its own fixture in the test suite.
  //
  // Idempotent via the [locale, slug] uniqueness on course_translations, the
  // same key the article taxonomy above uses.
  //
  // `track` is a plain string here, not an import from @repo/contracts:
  // packages/db must not depend on packages/contracts (architecture.md #8
  // points core -> db/contracts, never db -> contracts). The values are
  // covered by a contracts unit test and by the service-layer validation that
  // lands in Phase 2.
  // ─────────────────────────────────────────────────────────────
  const DEMO_COURSES = [
    {
      track: "forex",
      slug: "forex-fundamentals",
      title: "Forex Fundamentals",
      summary: "How the currency market works, what moves it, and how a trade is actually placed.",
      difficulty: "BEGINNER",
      estimatedHours: 4,
      sections: [
        {
          slug_: "what-is-forex",
          title: "What Is Forex?",
          description: "The market itself: who trades it, when, and why it moves.",
          lessons: [
            {
              slug: "the-foreign-exchange-market",
              title: "The foreign exchange market",
              summary: "Who trades currencies, and why the market never really closes.",
              minutes: 6,
              content:
                "<p>The foreign exchange market is where one currency is exchanged for another. It has no central exchange: banks, brokers, funds and companies deal with each other directly, which is why it trades around the clock from Sunday evening to Friday evening.</p><h2>Why it moves</h2><p>Prices move because the demand for one currency relative to another changes — driven by interest rates, growth, trade flows and expectations about all three.</p>",
            },
            {
              slug: "currency-pairs-and-quotes",
              title: "Currency pairs and quotes",
              summary: "Reading EUR/USD, and what the two prices on a quote mean.",
              minutes: 7,
              content:
                "<p>A currency is always priced against another, so every instrument is a <em>pair</em>. In EUR/USD the first currency is the base and the second is the quote: the price says how many US dollars one euro buys.</p><h2>Bid and ask</h2><p>You are shown two prices. The bid is what you can sell at, the ask is what you can buy at, and the gap between them is the spread — the cost of entering.</p>",
            },
            {
              slug: "pips-lots-and-leverage",
              title: "Pips, lots and leverage",
              summary: "The three units that decide what a price move is worth to you.",
              minutes: 8,
              content:
                "<p>A pip is the standard increment a pair moves in. A lot is the size of the position. Together they decide what one pip is worth in money.</p><h2>Leverage cuts both ways</h2><p>Leverage lets a small deposit control a larger position. It multiplies the result of a move in both directions, which is why position sizing matters more than entry timing for most new traders.</p>",
            },
          ],
        },
        {
          slug_: "reading-a-chart",
          title: "Reading a Chart",
          description: "Turning a price series into something you can make a decision from.",
          lessons: [
            {
              slug: "candlesticks-explained",
              title: "Candlesticks explained",
              summary: "What each candle records, and what it does not.",
              minutes: 6,
              content:
                "<p>A candlestick summarises four numbers for a period: open, high, low and close. The body spans open to close; the wicks reach the extremes.</p><p>A candle tells you where price went, not why. Treat a pattern as a description of what happened, never as a prediction on its own.</p>",
              videoUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            },
            {
              slug: "support-and-resistance",
              title: "Support and resistance",
              summary: "Why certain levels keep mattering, and when they stop.",
              minutes: 7,
              content:
                "<p>Support is a level where buying has repeatedly appeared; resistance is where selling has. They matter because enough participants remember them to act again.</p><p>Levels are zones, not lines. A level that breaks convincingly often becomes the opposite kind of level afterwards.</p>",
            },
          ],
        },
        {
          slug_: "your-first-trade",
          title: "Your First Trade",
          description: "Orders, risk, and the reading that comes after this course.",
          lessons: [
            {
              slug: "order-types",
              title: "Order types",
              summary: "Market, limit, stop — and which one to reach for.",
              minutes: 5,
              content:
                "<p>A market order fills now at the best available price. A limit order fills only at your price or better. A stop order becomes a market order once a level trades.</p><p>Every position should have a stop attached before it is opened, not after.</p>",
            },
            {
              slug: "risk-and-position-sizing",
              title: "Risk and position sizing",
              summary: "Deciding size from the stop, rather than the other way round.",
              minutes: 9,
              content:
                "<p>Decide first how much of the account a single trade may lose. Then measure the distance from entry to stop. Position size is what makes those two numbers agree.</p><h2>The order matters</h2><p>Sizing first and placing the stop wherever it fits the size is the most common way a plan quietly stops being a plan.</p>",
            },
            {
              // The external-resource lesson (ADR-055 #5). It carries no body:
              // `externalUrl` is its single capability, which is exactly the
              // case `lessonInputSchema` must accept and an empty lesson must
              // not. Optional, so it does not gate course completion.
              slug: "further-reading-bis-survey",
              title: "Further reading: the BIS triennial survey",
              summary: "The primary source on how large the market actually is.",
              minutes: 15,
              externalUrl: "https://www.bis.org/statistics/rpfx22.htm",
              isRequired: false,
            },
          ],
        },
      ],
    },
    {
      track: "crypto",
      slug: "crypto-foundations",
      title: "Crypto Foundations",
      summary: "What a blockchain actually does, and how crypto markets differ from forex.",
      difficulty: "BEGINNER",
      estimatedHours: 3,
      sections: [
        {
          slug_: "how-blockchains-work",
          title: "How Blockchains Work",
          description: "The mechanism underneath, without the marketing.",
          lessons: [
            {
              slug: "what-a-blockchain-is",
              title: "What a blockchain is",
              summary: "A shared ledger that nobody in particular runs.",
              minutes: 7,
              content:
                "<p>A blockchain is a ledger copied across many independent machines, where new entries are appended in batches and each batch is linked to the one before it.</p><p>The useful property is not secrecy — most are fully public — but that no single participant can quietly rewrite history.</p>",
            },
            {
              slug: "wallets-keys-and-custody",
              title: "Wallets, keys and custody",
              summary: "Who actually controls a balance, and what that costs you.",
              minutes: 8,
              content:
                "<p>A wallet stores keys, not coins. The private key authorises spending, so whoever holds it controls the balance.</p><h2>Custody is a real choice</h2><p>Holding your own keys removes counterparty risk and adds the risk that you lose them. Neither option is the safe one by default.</p>",
            },
          ],
        },
        {
          slug_: "crypto-markets",
          title: "Crypto Markets",
          description: "Where these assets trade, and how that differs from FX.",
          lessons: [
            {
              slug: "exchanges-and-liquidity",
              title: "Exchanges and liquidity",
              summary: "Why the same asset shows different prices in different places.",
              minutes: 6,
              content:
                "<p>Crypto trades on many venues at once, each with its own order book. Prices converge through arbitrage but rarely match exactly.</p><p>Thin books move further on the same order size, which is why liquidity matters more than headline volume.</p>",
            },
            {
              slug: "volatility-and-position-sizing",
              title: "Volatility and position sizing",
              summary: "Applying the forex risk lesson to a much wider range.",
              minutes: 7,
              content:
                "<p>The sizing arithmetic is identical to forex; only the distances change. A stop placed at a forex distance on a crypto pair is usually inside the ordinary daily range.</p><p>Size from the instrument's own volatility, not from a habit formed on another one.</p>",
            },
          ],
        },
        {
          slug_: "staying-safe",
          title: "Staying Safe",
          description: "The failure modes that cost beginners the most.",
          lessons: [
            {
              slug: "common-scams-and-red-flags",
              title: "Common scams and red flags",
              summary: "The patterns behind most avoidable losses.",
              minutes: 6,
              content:
                "<p>Guaranteed returns, urgency, and a request to move funds off-platform are the three signals present in most crypto fraud.</p><p>No legitimate service needs your private key or seed phrase. There is no exception to that sentence.</p>",
            },
          ],
        },
      ],
    },
  ] as const;

  let seededCourses = 0;
  let seededLessons = 0;
  for (const course of DEMO_COURSES) {
    const existing = await db.courseTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: course.slug } },
      select: { courseId: true },
    });
    if (existing) continue; // idempotent: never clobber admin edits to a demo course

    const lessonCount = course.sections.reduce((n, sec) => n + sec.lessons.length, 0);
    const created = await db.course.create({
      data: {
        track: course.track,
        difficulty: course.difficulty,
        estimatedHours: course.estimatedHours,
        status: "PUBLISHED",
        publishedAt: new Date(),
        sortOrder: seededCourses,
        lessonCount,
        translations: {
          create: {
            locale: "en",
            title: course.title,
            slug: course.slug,
            summary: course.summary,
            translationStatus: "TRANSLATED",
          },
        },
      },
      select: { id: true },
    });

    for (const [sectionIndex, section] of course.sections.entries()) {
      const createdSection = await db.courseSection.create({
        data: {
          courseId: created.id,
          sortOrder: sectionIndex,
          isPublished: true,
          translations: {
            create: { locale: "en", title: section.title, description: section.description },
          },
        },
        select: { id: true },
      });

      for (const [lessonIndex, lesson] of section.lessons.entries()) {
        await db.lesson.create({
          data: {
            sectionId: createdSection.id,
            difficulty: course.difficulty,
            estimatedMinutes: lesson.minutes,
            videoUrl: "videoUrl" in lesson ? lesson.videoUrl : null,
            externalUrl: "externalUrl" in lesson ? lesson.externalUrl : null,
            isRequired: "isRequired" in lesson ? lesson.isRequired : true,
            sortOrder: lessonIndex,
            status: "PUBLISHED",
            publishedAt: new Date(),
            translations: {
              create: {
                locale: "en",
                title: lesson.title,
                slug: lesson.slug,
                summary: lesson.summary,
                content: "content" in lesson ? lesson.content : null,
                translationStatus: "TRANSLATED",
              },
            },
          },
        });
        seededLessons += 1;
      }
    }
    seededCourses += 1;
  }
  console.log(
    `  learn: ${seededCourses} demo course(s), ${seededLessons} lesson(s) — tracks ${DEMO_COURSES.map((c) => c.track).join(", ")}`,
  );
  // Arabic (ADR-166): both demo courses whole — see `seed-learn-ar.ts` for why
  // a partial course is worse than none in a locale with no fallback.
  const arabicLearn = await seedArabicDemoCourses(db);
  console.log(
    `  arabic learn: ${arabicLearn.courses} course(s), ${arabicLearn.lessons} lesson(s) created`,
  );

  // ─────────────────────────────────────────────────────────────
  // LEARN AREA — a demo quiz (changes-11 Phase 6, ADR-058)
  //
  // One standalone quiz, published, so `/learn/quizzes` has something on it
  // after a reset and the whole attempt path — start, answer, submit, review —
  // is exercisable without an editor authoring one first.
  //
  // It is STANDALONE and attached to nothing. Attaching it to a demo lesson
  // would seed a `QUIZ_PASS` completion rule into a course whose other lessons
  // are MANUAL, which is a confusing default to hand someone opening the admin
  // for the first time. Attaching one is two clicks in the lesson editor.
  //
  // `correctAnswer` is a plain index into `options` (ADR-058 #2), stored on the
  // untranslated question row — never on the translation.
  // ─────────────────────────────────────────────────────────────
  for (const spec of [DEMO_QUIZ, DEMO_QUIZ_CRYPTO]) {
    const existingQuiz = await db.quizTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: spec.slug } },
      select: { quizId: true },
    });
    if (existingQuiz) continue;

    const quiz = await db.quiz.create({
      data: {
        track: spec.track,
        passingScore: spec.passingScore,
        showAnswersAfter: "AFTER_SUBMIT",
        isStandalone: true,
        category: spec.category,
        status: "PUBLISHED",
        visibility: "PUBLIC",
        publishedAt: new Date(),
        translations: {
          create: {
            locale: "en",
            title: spec.title,
            slug: spec.slug,
            description: spec.description,
            translationStatus: "TRANSLATED",
          },
        },
      },
    });

    for (const [index, question] of spec.questions.entries()) {
      await db.quizQuestion.create({
        data: {
          quizId: quiz.id,
          type: question.type,
          sortOrder: index,
          points: 1,
          correctAnswer: question.correct,
          translations: {
            create: {
              locale: "en",
              prompt: question.prompt,
              options: question.options,
              explanations: question.explanations,
            },
          },
        },
      });
    }
    console.log(`  quiz: ${spec.slug} (published, ${spec.questions.length} questions)`);
  }
  // Arabic (ADR-166): both quizzes, every question.
  console.log(`  arabic quizzes: ${await seedArabicDemoQuizzes(db)} created`);

  // ─────────────────────────────────────────────────────────────
  // GLOSSARY — topics and terms (ADR-069)
  //
  // The glossary shipped its admin, its A–Z, its topic routes and its term
  // pages with NO seeded content, so every one of those surfaces rendered its
  // empty state on a fresh database and `/glossary/topics` could not render at
  // all. This block is the starter set.
  //
  // These are NOT placeholder facts in ADR-051's sense. That ADR quarantines
  // claims about MBX — awards, capital, regulation — because a demo value
  // surviving into production would be read as an assertion about the company.
  // A definition of "pip" asserts nothing about MBX; it is educational content
  // of exactly the kind the admin exists to edit, and it is correct as written.
  // So it lives here, not behind a content-mode switch.
  //
  // Idempotent via the [locale, slug] uniqueness on glossary_term_translations
  // and glossary_topic_translations — the same key the article taxonomy and
  // the demo courses use. An existing slug is SKIPPED, never updated, so a
  // re-seed cannot clobber an editor's rewording.
  //
  // `track` and `difficulty` are plain strings, not imports from
  // @repo/contracts: packages/db must not depend on packages/contracts
  // (architecture.md #8 points core -> db/contracts, never db -> contracts).
  //
  // `sourceHash` is left null, exactly as the demo courses leave it —
  // `computeSourceHash` lives in @repo/i18n and db cannot import it either.
  // Nothing breaks: the hash is written on the first admin save, and there are
  // no non-English translations here for a stale hash to mislead.
  //
  // A term with `topic: null` is UNFILED and appears only in the A–Z; a term
  // with `track: null` belongs to EVERY school (ADR-065 §3). The two nulls are
  // not the same thing, and the set below uses both deliberately.
  // ─────────────────────────────────────────────────────────────
  const glossaryTopicIds = new Map<string, string>();
  for (const [index, topic] of GLOSSARY_TOPICS.entries()) {
    const existing = await db.glossaryTopicTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: topic.slug } },
      select: { topicId: true },
    });
    if (existing) {
      glossaryTopicIds.set(topic.slug, existing.topicId);
      continue;
    }
    const created = await db.glossaryTopic.create({
      data: {
        isActive: true,
        sortOrder: index,
        translations: {
          create: {
            locale: "en",
            name: topic.name,
            slug: topic.slug,
            description: topic.description,
          },
        },
      },
      select: { id: true },
    });
    glossaryTopicIds.set(topic.slug, created.id);
  }

  let seededTerms = 0;
  for (const entry of GLOSSARY_TERMS) {
    const existing = await db.glossaryTermTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: entry.slug } },
      select: { id: true },
    });
    if (existing) continue; // idempotent: never clobber an editor's rewording

    await db.glossaryTerm.create({
      data: {
        topicId: entry.topic === null ? null : (glossaryTopicIds.get(entry.topic) ?? null),
        track: entry.track,
        difficulty: entry.difficulty,
        formula: entry.formula ?? null,
        status: "PUBLISHED",
        publishedAt: new Date(),
        translations: {
          create: {
            locale: "en",
            term: entry.term,
            slug: entry.slug,
            simpleExplanation: entry.simple,
            detailedExplanation: entry.detailed ?? null,
            advancedExplanation: entry.advanced ?? null,
            exampleScenario: entry.example ?? null,
            // Prisma reads `undefined` on a Json? column as "leave it alone",
            // which on a create means SQL NULL — the right answer for a term
            // with no questions.
            faq: entry.faq ?? undefined,
            translationStatus: "TRANSLATED",
          },
        },
      },
    });
    seededTerms += 1;
  }
  console.log(
    `  glossary: ${GLOSSARY_TOPICS.length} topics, ${seededTerms} term(s) of ${GLOSSARY_TERMS.length}`,
  );
  // Arabic (ADR-166): every topic and every term.
  const arabicGlossary = await seedArabicGlossary(db);
  console.log(
    `  arabic glossary: ${arabicGlossary.topics} topic(s), ${arabicGlossary.terms} term(s) created`,
  );

  // ─────────────────────────────────────────────────────────────
  // VIDEOS — demo categories and topics (changes-16 PR 2, ADR-068)
  //
  // Demo content for the Videos section, exactly as DEMO_COURSES and the demo
  // quizzes are for theirs: a fresh database renders a populated shelf rather
  // than an empty state. The `videos` flag is ON above since PR 7 built the
  // public routes.
  //
  // Idempotent via the [locale, slug] uniqueness on video_topic_translations
  // and video_category_translations. An existing slug is SKIPPED, never
  // updated — a re-seed must not clobber an editor's rewording.
  //
  // ─── Why almost every demo topic has a body and no video ─────────────────
  //
  // ADR-047 §3 records the rule and the reason: a video URL is a
  // FACTUAL CLAIM — it asserts "this specific recording exists and teaches
  // this" — and an invented eleven-character id resolves to whatever happens to
  // occupy it. So these rows do not invent one. The capability rule in
  // `videoTopicInputSchema` is satisfied the other legitimate way it allows: a
  // written guide filed under a category.
  //
  // ONE topic per track carries a video anyway, because the player, the facade
  // and the `videoCount` badge are the paths PRs 8 and 10 have to be able to
  // see on a fresh database. Its URL is the Blender Foundation's open test reel
  // — a real, stable, freely-licensed recording that is self-evidently NOT a
  // trading lesson, so it exercises the mechanism without asserting a
  // curriculum claim the way a plausible-looking id would.
  //
  // TODO(owner): replace those two URLs with real recordings. Nothing else
  // changes — the same row, the same parser, the same render path.
  //
  // No uploaded-source rows are seeded: an `assetId` with no bytes behind it
  // would 404 in the player, which is worse than not seeding one.
  //
  // No permission rows either — videos publish on the `lessons.*` keys
  // (ADR-068 §3).
  // ─────────────────────────────────────────────────────────────
  const videoCategoryIds = new Map<string, string>();
  for (const [index, category] of VIDEO_CATEGORIES.entries()) {
    const existing = await db.videoCategoryTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: category.slug } },
      select: { categoryId: true },
    });
    if (existing) {
      videoCategoryIds.set(category.slug, existing.categoryId);
      continue;
    }
    const created = await db.videoCategory.create({
      data: {
        isActive: true,
        sortOrder: index,
        translations: {
          create: {
            locale: "en",
            name: category.name,
            slug: category.slug,
            description: category.description,
          },
        },
      },
      select: { id: true },
    });
    videoCategoryIds.set(category.slug, created.id);
  }

  let seededVideoTopics = 0;
  for (const [index, entry] of VIDEO_TOPICS.entries()) {
    const existing = await db.videoTopicTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: entry.slug } },
      select: { id: true },
    });
    if (existing) continue; // idempotent: never clobber an editor's rewording

    await db.videoTopic.create({
      data: {
        categoryId: entry.category === null ? null : (videoCategoryIds.get(entry.category) ?? null),
        track: entry.track,
        status: "PUBLISHED",
        visibility: "PUBLIC",
        publishedAt: new Date(),
        sortOrder: index,
        translations: {
          create: {
            locale: "en",
            title: entry.title,
            slug: entry.slug,
            summary: entry.summary,
            content: entry.content,
            translationStatus: "TRANSLATED",
          },
        },
        videos: entry.videoUrl
          ? { create: [{ sortOrder: 0, externalUrl: entry.videoUrl, title: entry.title }] }
          : undefined,
        links: entry.links
          ? {
              create: entry.links.map((link, linkIndex) => ({
                sortOrder: linkIndex,
                label: link.label,
                path: link.path ?? null,
                url: link.url ?? null,
              })),
            }
          : undefined,
      },
    });
    seededVideoTopics += 1;
  }
  console.log(
    `  videos: ${VIDEO_CATEGORIES.length} categories, ${seededVideoTopics} topic(s) of ${VIDEO_TOPICS.length}`,
  );
  // Arabic (ADR-166): both categories and all six topics.
  console.log(`  arabic video topics: ${await seedArabicDemoVideos(db)} created`);

  // Bootstrap super admin.
  //
  // Written directly via Prisma rather than Better Auth's API (no HTTP
  // context at seed time). The User + Account shape must match exactly what
  // Better Auth's credential provider expects to find at sign-in:
  // `Account.issuer` is the synthetic `local:<providerId>` key
  // (`createLocalAccountIssuer("credential")` in Better Auth's source —
  // ADR-001), and `accountId` equals the user's own id for local accounts.
  //
  // Password comes from the environment so a real credential never lands in
  // git. In production, seed with a random value and force a reset on login.
  const adminEmail = process.env.SEED_ADMIN_EMAIL ?? "admin@mbxpro.com";
  const adminPassword = process.env.SEED_ADMIN_PASSWORD;
  let adminId: string | null = null;

  if (!adminPassword) {
    console.warn("  SKIPPED admin user — set SEED_ADMIN_PASSWORD to create it.");
  } else {
    // ADR-001: Argon2id, default algorithm — matches Module 04's
    // emailAndPassword.password.hash override.
    const passwordHash = await hash(adminPassword, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
    });

    const admin = await db.user.upsert({
      where: { email: adminEmail },
      update: {},
      create: {
        id: randomUUID(),
        email: adminEmail,
        name: "System Administrator",
        firstName: "System",
        lastName: "Administrator",
        emailVerified: true,
        userType: "STAFF",
        status: "ACTIVE",
        locale: "en",
      },
    });

    await db.account.upsert({
      where: { issuer_accountId: { issuer: "local:credential", accountId: admin.id } },
      update: { password: passwordHash },
      create: {
        id: randomUUID(),
        userId: admin.id,
        providerId: "credential",
        accountId: admin.id,
        issuer: "local:credential",
        password: passwordHash,
      },
    });

    const superAdmin = await db.role.findUniqueOrThrow({ where: { key: "super_admin" } });
    await db.userRole.upsert({
      where: { userId_roleId: { userId: admin.id, roleId: superAdmin.id } },
      update: {},
      create: { userId: admin.id, roleId: superAdmin.id },
    });

    await db.employee.upsert({
      where: { workEmail: adminEmail },
      update: {},
      create: {
        userId: admin.id,
        employeeCode: "EMP-0001",
        firstName: "System",
        lastName: "Administrator",
        workEmail: adminEmail,
        employmentType: "FULL_TIME",
        status: "ACTIVE",
        joinedAt: new Date(),
      },
    });

    adminId = admin.id;
    console.log(`  super admin: ${adminEmail}`);
  }

  // Sample article (changes-07 PR 2). Gives the editor v2 screens something
  // real to load — every field the reference design has, including the ones
  // this PR added: featured flag, header image slot, FAQ items, focus
  // keywords, OG/Twitter overrides and the related-posts settings.
  //
  // `create`-only (never `update`), per Module 01's seed rule: an editor's
  // own changes to this row survive a re-seed.
  const SAMPLE_SLUG = "risk-management-protect-your-trading-capital";
  const sampleExists = await db.articleTranslation.findUnique({
    where: { locale_slug: { locale: "en", slug: SAMPLE_SLUG } },
    select: { id: true },
  });
  if (!sampleExists) {
    const analysisCategory = await db.articleCategoryTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: "technical-analysis" } },
      select: { categoryId: true },
    });
    const sampleTags = await db.articleTagTranslation.findMany({
      where: { locale: "en", slug: { in: ["gold", "eur-usd"] } },
      select: { tagId: true },
    });
    if (analysisCategory) {
      await db.article.create({
        data: {
          kind: "ANALYSIS",
          status: "PUBLISHED",
          publishedAt: new Date(),
          isActive: true,
          isFeatured: true,
          showRelated: true,
          relatedCount: 3,
          categoryId: analysisCategory.categoryId,
          authorId: adminId,
          tags: { create: sampleTags.map((t) => ({ tagId: t.tagId })) },
          translations: {
            create: {
              locale: "en",
              title: "Risk Management: How to Protect Your Trading Capital",
              slug: SAMPLE_SLUG,
              excerpt:
                "Risk management is the difference between traders who survive and traders who disappear. Learn the two percent rule, position sizing and stop losses.",
              body: [
                "<h2>The math problem nobody wants to face</h2>",
                "<p>Most beginners do not lose money because their analysis is wrong. They lose because a single position is allowed to be large enough to matter.</p>",
                "<h2>The 2% rule</h2>",
                "<p>Risk no more than two percent of the account on any one trade. On a $10,000 account that is $200 at risk per trade — not a $200 position.</p>",
                "<h3>Position sizing</h3>",
                '<p>Position size equals account risk divided by the stop distance. Read the <a href="/glossary">glossary</a> if any of these terms are new.</p>',
                "<h2>Keep a journal</h2>",
                "<p>After two hundred trades, patterns emerge. Without a written record you are guessing about your own behaviour.</p>",
              ].join(""),
              seoTitle: "Risk Management: Protect Your Trading Capital",
              seoDescription:
                "Learn forex risk management: the two percent rule, position sizing, stop losses and leverage. Protect your capital with proven money-management rules.",
              focusKeywords: "risk management, forex risk management, position sizing",
              ogTitle: "Risk Management: How to Protect Your Trading Capital",
              ogDescription:
                "The two percent rule, position sizing and stop losses — the money-management rules that keep traders in the game.",
              twitterCard: "summary_large_image",
              translationStatus: "TRANSLATED",
              faqItems: {
                create: [
                  {
                    sortOrder: 0,
                    question: "How much should I risk per trade?",
                    answer:
                      "<p>Two percent of account equity is the common ceiling. On a $10,000 account that is $200 of risk — the distance to your stop, not the position size.</p>",
                  },
                  {
                    sortOrder: 1,
                    question: "Does leverage change how much I risk?",
                    answer:
                      "<p>No. Leverage changes the capital required to hold a position. Your risk is still the stop distance multiplied by position size.</p>",
                  },
                ],
              },
            },
          },
        },
      });
      console.log("  sample article: risk-management (published, featured, 2 FAQ items)");
    }
  }

  // The News & Analysis corpus (changes-32). One sample article loaded the
  // editor and left `/news` looking empty — the spotlight only renders above
  // SPOTLIGHT_COUNT visible stories, the per-category bands come from
  // `getCategoryDigests`, and `loadArticleFacets` drops a zero-count category
  // (ADR-081 #3), so a single row exercised none of it.
  //
  // `create`-only, keyed on the translation slug, exactly like the sample
  // above: a re-seed adds what is missing and never touches a row an editor
  // has edited. See `seed-articles.ts` for what the corpus may and may not
  // say — in short, it is illustrative and quotes nobody real.
  const seedCategoryIds = new Map<string, string>();
  for (const category of ARTICLE_CATEGORIES) {
    const row = await db.articleCategoryTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: category.slug } },
      select: { categoryId: true },
    });
    if (row) seedCategoryIds.set(category.slug, row.categoryId);
  }
  const seedTagIds = new Map<string, string>();
  for (const tag of await db.articleTagTranslation.findMany({
    where: { locale: "en" },
    select: { slug: true, tagId: true },
  })) {
    seedTagIds.set(tag.slug, tag.tagId);
  }

  let seededArticles = 0;
  for (const article of SEED_ARTICLES) {
    const categoryId = seedCategoryIds.get(article.categorySlug);
    // A corpus entry naming a category the taxonomy above does not seed is a
    // typo in the corpus, not a reason to create taxonomy behind the admin's
    // back — skip it and let the count say so.
    if (!categoryId) continue;
    const exists = await db.articleTranslation.findUnique({
      where: { locale_slug: { locale: "en", slug: article.slug } },
      select: { id: true },
    });
    if (exists) continue;

    const publishedAt = new Date(Date.now() - article.daysAgo * 24 * 60 * 60 * 1000);
    const tagIds = article.tagSlugs
      .map((slug) => seedTagIds.get(slug))
      .filter((id): id is string => Boolean(id));

    await db.article.create({
      data: {
        kind: article.kind,
        status: "PUBLISHED",
        publishedAt,
        isActive: true,
        isFeatured: article.isFeatured ?? false,
        showRelated: true,
        relatedCount: 3,
        categoryId,
        authorId: adminId,
        tags: { create: tagIds.map((tagId) => ({ tagId })) },
        translations: {
          create: {
            locale: "en",
            title: article.title,
            slug: article.slug,
            excerpt: article.excerpt,
            body: article.body.join(""),
            seoTitle: article.seoTitle,
            seoDescription: article.seoDescription,
            focusKeywords: article.focusKeywords,
            twitterCard: "summary_large_image",
            translationStatus: "TRANSLATED",
            ...(article.faq
              ? {
                  faqItems: {
                    create: article.faq.map((item, index) => ({
                      sortOrder: index,
                      question: item.question,
                      answer: item.answer,
                    })),
                  },
                }
              : {}),
          },
        },
      },
    });
    seededArticles += 1;
  }
  if (seededArticles > 0) console.log(`  article corpus: ${seededArticles} created`);
  // Arabic (ADR-166): all twelve, the featured sample, and the taxonomy.
  console.log(`  arabic articles: ${await seedArabicArticles(db)} created`);

  // Promotions (changes-57): a webinar, an offer and an announcement, so the
  // popup, the home band and the banners have something to show. ACTIVE
  // outside production only — see the file. `pnpm seed:live` attaches their
  // pictures, as it does for the article corpus.
  const seededPromotions = await seedPromotions(db, { adminId });
  if (seededPromotions > 0) console.log(`  promotions: ${seededPromotions} created`);
  console.log(`  arabic promotions: ${await seedArabicPromotions(db, { adminId })} created`);

  // Email campaigns (ADR-171/172): course announcement and custom email
  // drafts, plus a sent and a cancelled one outside production. Nothing is
  // seeded SCHEDULED and no recipient row is written, so nothing can send.
  const seededCampaigns = await seedEmailCampaigns(db, { adminId });
  if (seededCampaigns > 0) console.log(`  email campaigns: ${seededCampaigns} created`);

  // Website builder (Module 16, plan v2.2 PR 2.7). The `home` row is the
  // CMS's owner of "/". Phase 1 (PR 1.1) seeded it as a DRAFT with an empty
  // layout and NO published version, so `[locale]/page.tsx` kept serving
  // the settings-driven homepage until this phase's migration landed.
  // Phase 2 publishes the four STATIC `home.sections` (hero, newsletter,
  // faq, risk_disclaimer — plan §12 PR 2.7); `latest_analysis` and
  // `glossary_spotlight` stay on the settings-driven path until Phase 4's
  // `collection` block migrates them, and `[locale]/page.tsx`'s fallback
  // switch is what makes that split safe: the CMS page renders once
  // published, and today it legitimately has fewer sections than the
  // settings-driven fallback (`check:home-sections` / `home.sections`
  // are retired only in Phase 4, plan §12 PR 4.5, not here).
  //
  // Copy is inlined from the `home`/`footer` catalogs' EN strings at the
  // time of migration, not read live — a CMS page's text is admin-authored
  // content from here on, the same one-time snapshot ADR-031's
  // Consequences section describes for `home.sections`' hero CTA. `en` is
  // the only active locale (the others are seeded `isActive: false`, ADR-007),
  // so no other locale's `PageTranslation` needs this content yet. `@repo/db`
  // cannot depend on `@repo/contracts`/`@repo/core` (architecture.md #8),
  // so the layout is inlined JSON, hand-verified against the real
  // `layoutTreeSchema` and block registry before landing (see this PR's
  // DEVLOG entry), and the publish step below mirrors `publishPage()`'s
  // own writes (`cms/publish.ts`) by hand rather than importing it.
  const defaultLocale =
    (await db.locale.findFirst({ where: { isDefault: true }, select: { code: true } }))?.code ??
    "en";
  const homePage = await db.page.upsert({
    where: { key: "home" },
    update: {},
    create: { key: "home", kind: "STATIC", status: "DRAFT", createdById: adminId ?? "seed" },
  });
  await db.pageTranslation.upsert({
    where: { pageId_locale: { pageId: homePage.id, locale: defaultLocale } },
    update: {},
    create: { pageId: homePage.id, locale: defaultLocale, title: "Home", slug: "", path: "/" },
  });

  let draftVersionId = homePage.draftVersionId;
  if (!draftVersionId) {
    const draft = await db.pageVersion.create({
      data: {
        pageId: homePage.id,
        number: 0,
        revision: 0,
        layout: HOME_PAGE_LAYOUT,
        authorId: adminId ?? "seed",
      },
    });
    draftVersionId = draft.id;
    await db.page.update({ where: { id: homePage.id }, data: { draftVersionId } });
  } else {
    // A dev DB seeded before this PR has Phase 1's empty placeholder draft.
    // Replace it — it was never real admin-authored content — rather than
    // requiring a full `db:reset` for a seed-only change (plan §5.2's
    // "reset over backfill" policy governs schema changes; this is neither).
    const existingDraft = await db.pageVersion.findUnique({
      where: { id: draftVersionId },
      select: { layout: true },
    });
    const isUntouchedPlaceholder =
      JSON.stringify(existingDraft?.layout) === JSON.stringify({ version: 1, nodes: [] });
    if (isUntouchedPlaceholder) {
      await db.pageVersion.update({
        where: { id: draftVersionId },
        data: { layout: HOME_PAGE_LAYOUT },
      });
    }
  }

  const homePageState = await db.page.findUniqueOrThrow({
    where: { id: homePage.id },
    select: { publishedVersionId: true },
  });
  if (!homePageState.publishedVersionId) {
    const published = await db.pageVersion.create({
      data: {
        pageId: homePage.id,
        number: 1,
        revision: 0,
        layout: HOME_PAGE_LAYOUT,
        authorId: adminId ?? "seed",
        note: "Phase 2 migration: hero, newsletter, faq, risk disclaimer",
      },
    });
    await db.page.update({
      where: { id: homePage.id },
      data: { publishedVersionId: published.id, status: "PUBLISHED", publishedAt: new Date() },
    });
  }
  console.log("  cms pages: home (published, PR 2.7 migration)");

  // Reuse models (Module 16, plan v2.2 PR 3.1, ADR-033). Six system
  // StylePresets and five system PAGE LayoutTemplates — enough that a
  // first page needs no preset authoring. `isSystem: true` rows are
  // clone-only (ADR-016/ADR-023 pattern); `create`-only (never `update`)
  // per Module 01's seed rule, so an admin's own edit to a since-cloned
  // row is never overwritten by a re-seed — these system rows are meant
  // to be read-only reference points, not editable, so this only matters
  // if a future migration ever needs to correct one's `config`/`layout`.
  const stylePresets = [
    {
      key: "hero-dark",
      name: "Hero — dark",
      scope: "any",
      config: {
        style: { background: { kind: "token", token: "primary" }, textTone: "on-primary" },
        motion: { entrance: "fade-up" },
      },
    },
    {
      key: "hero-light-image",
      name: "Hero — light, over image",
      scope: "any",
      config: { style: { textTone: "on-image" }, motion: { entrance: "fade-up" } },
    },
    {
      key: "band-primary",
      name: "Band — primary fill",
      scope: "any",
      config: {
        style: {
          background: { kind: "token", token: "primary" },
          textTone: "on-primary",
          padding: "lg",
        },
      },
    },
    {
      key: "card-lift",
      name: "Card — lift on hover",
      scope: "any",
      config: { motion: { hover: "lift" } },
    },
    {
      key: "section-muted",
      name: "Section — muted surface",
      scope: "any",
      config: { style: { background: { kind: "token", token: "surface-1" } } },
    },
    {
      key: "section-plain",
      name: "Section — no background",
      scope: "any",
      config: { style: { background: { kind: "token", token: "none" } } },
    },
  ] as const;

  for (const preset of stylePresets) {
    const existing = await db.stylePreset.findUnique({ where: { key: preset.key } });
    if (!existing) {
      await db.stylePreset.create({
        data: { ...preset, config: preset.config, isSystem: true, createdById: adminId },
      });
    }
  }
  console.log(`  style presets: ${stylePresets.length} system rows`);

  /** A minimal starter tree every "Start from" PAGE template copies into a new draft — heading + one paragraph the admin is expected to replace. */
  function starterPageLayout(heading: string, body: string) {
    return {
      version: 1,
      nodes: [
        {
          type: "section",
          id: "starter-section",
          version: 1,
          hidden: false,
          props: { spacing: "lg" },
          children: [
            {
              type: "container",
              id: "starter-container",
              version: 1,
              hidden: false,
              props: { size: "narrow" },
              children: [
                {
                  type: "heading",
                  id: "starter-heading",
                  version: 1,
                  hidden: false,
                  props: { text: heading, level: "1", align: "start" },
                  children: [],
                },
                {
                  type: "paragraph",
                  id: "starter-body",
                  version: 1,
                  hidden: false,
                  props: { text: body, align: "start", size: "default" },
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    };
  }

  const layoutTemplates = [
    {
      key: "landing-page",
      name: "Landing page",
      kind: "PAGE" as const,
      pageKind: "STATIC" as const,
      layout: starterPageLayout(
        "Your headline goes here",
        "Replace this paragraph with your page's introduction, then add sections below.",
      ),
    },
    {
      key: "tool-page",
      name: "Tool page",
      kind: "PAGE" as const,
      pageKind: "STATIC" as const,
      layout: starterPageLayout(
        "Tool name",
        "Introduce the tool here, then place its widget block below.",
      ),
    },
    {
      key: "legal-page",
      name: "Legal page",
      kind: "PAGE" as const,
      pageKind: "STATIC" as const,
      layout: starterPageLayout(
        "Legal document title",
        "Replace this paragraph with your legal text.",
      ),
    },
    {
      key: "contact-page",
      name: "Contact",
      kind: "PAGE" as const,
      pageKind: "STATIC" as const,
      layout: starterPageLayout(
        "Get in touch",
        "Replace this paragraph with contact details or a form widget.",
      ),
    },
    {
      key: "blank-page",
      name: "Blank page",
      kind: "PAGE" as const,
      pageKind: "STATIC" as const,
      layout: { version: 1, nodes: [] },
    },
  ] as const;

  for (const template of layoutTemplates) {
    const existing = await db.layoutTemplate.findUnique({ where: { key: template.key } });
    if (!existing) {
      await db.layoutTemplate.create({
        data: { ...template, layout: template.layout, isSystem: true, createdById: adminId },
      });
    }
  }
  console.log(`  layout templates: ${layoutTemplates.length} system rows`);

  // ADR-023 (PR 4.3): `standard`/`featured`/`compact` mirror
  // `article-list.tsx`'s three REAL existing variants field-for-field —
  // checked against that component before writing these, not assumed.
  // `horizontal` has no existing implementation anywhere in this repo to
  // port (the plan names it as a fourth system template with no such
  // precedent) — built new, image-left/content-right, a single row.
  const cardTemplates = [
    {
      key: "standard",
      name: "Standard",
      contentType: null,
      variant: "standard" as const,
      config: {
        version: 1,
        fields: ["image", "category", "title", "excerpt", "date"],
        imageAspectRatio: "video" as const,
        excerptLength: 160,
      },
    },
    {
      key: "featured",
      name: "Featured",
      contentType: null,
      variant: "featured" as const,
      config: {
        version: 1,
        fields: ["image", "category", "title", "excerpt", "date"],
        imageAspectRatio: "video" as const,
        excerptLength: 220,
      },
    },
    {
      key: "compact",
      name: "Compact",
      contentType: null,
      variant: "compact" as const,
      config: {
        version: 1,
        fields: ["category", "title", "date"],
        imageAspectRatio: "video" as const,
        excerptLength: 0,
      },
    },
    {
      key: "horizontal",
      name: "Horizontal",
      contentType: null,
      variant: "horizontal" as const,
      config: {
        version: 1,
        fields: ["image", "category", "title", "excerpt", "date"],
        imageAspectRatio: "square" as const,
        excerptLength: 160,
      },
    },
  ] as const;

  for (const template of cardTemplates) {
    const existing = await db.cardTemplate.findUnique({ where: { key: template.key } });
    if (!existing) {
      await db.cardTemplate.create({
        data: { ...template, config: template.config, isSystem: true, createdById: adminId },
      });
    }
  }
  console.log(`  card templates: ${cardTemplates.length} system rows`);

  // Plan v2.2 §12 PR 4.4: `/news` as a real COLLECTION page, seeded
  // published so `news/page.tsx`'s fallback switch has something to
  // render immediately. Scoped down and named, not silently incomplete:
  // no archive-by-month sidebar (no block implements one yet) and no
  // category-filter pills (no curated `options` exist for a hand-written
  // seed to guess at) — an admin adds a `collection-filter` block with
  // real options once real categories exist to filter by. This proves the
  // fallback-switch mechanism and the collection/search/pagination
  // pipeline end to end; it is not a byte-for-byte parity claim with
  // today's hand-built route (which also has an archive sidebar this
  // seed's block set cannot express yet).
  const NEWS_COLLECTION_LAYOUT = {
    version: 1,
    nodes: [
      {
        type: "heading",
        id: "news-heading",
        version: 1,
        hidden: false,
        props: { text: "News & Analysis", level: "1", align: "start" },
        children: [],
      },
      {
        type: "paragraph",
        id: "news-intro",
        version: 1,
        hidden: false,
        props: {
          text: "The latest market-moving headlines and expert breakdowns.",
          align: "start",
          size: "default",
        },
        children: [],
      },
      {
        type: "collection-search",
        id: "news-search",
        version: 1,
        hidden: false,
        props: { bindingId: "main", placeholder: "Search news…" },
        children: [],
      },
      {
        type: "collection",
        id: "news-collection",
        version: 2,
        hidden: false,
        props: {
          contentType: "news",
          bindingId: "main",
          filter: {},
          limit: 12,
          layout: "grid",
          columns: "3",
        },
        children: [],
      },
      {
        type: "collection-pagination",
        id: "news-pagination",
        version: 1,
        hidden: false,
        props: { bindingId: "main", mode: "numbered" },
        children: [],
      },
    ],
  };

  const newsPage = await db.page.upsert({
    where: { key: "news-collection" },
    update: {},
    create: {
      key: "news-collection",
      kind: "COLLECTION",
      contentType: "news",
      status: "DRAFT",
      createdById: adminId ?? "seed",
    },
  });
  await db.pageTranslation.upsert({
    where: { pageId_locale: { pageId: newsPage.id, locale: defaultLocale } },
    update: {},
    create: {
      pageId: newsPage.id,
      locale: defaultLocale,
      title: "News & Analysis",
      slug: "news",
      path: "/news",
    },
  });
  let newsDraftVersionId = newsPage.draftVersionId;
  if (!newsDraftVersionId) {
    const draft = await db.pageVersion.create({
      data: {
        pageId: newsPage.id,
        number: 0,
        revision: 0,
        layout: NEWS_COLLECTION_LAYOUT,
        authorId: adminId ?? "seed",
      },
    });
    newsDraftVersionId = draft.id;
    await db.page.update({
      where: { id: newsPage.id },
      data: { draftVersionId: newsDraftVersionId },
    });
  }
  const newsPageState = await db.page.findUniqueOrThrow({
    where: { id: newsPage.id },
    select: { publishedVersionId: true },
  });
  if (!newsPageState.publishedVersionId) {
    const published = await db.pageVersion.create({
      data: {
        pageId: newsPage.id,
        number: 1,
        revision: 0,
        layout: NEWS_COLLECTION_LAYOUT,
        authorId: adminId ?? "seed",
        note: "Phase 4 PR 4.4: /news as a COLLECTION page",
      },
    });
    await db.page.update({
      where: { id: newsPage.id },
      data: { publishedVersionId: published.id, status: "PUBLISHED", publishedAt: new Date() },
    });
  }
  console.log("  cms pages: news-collection (published, PR 4.4 migration)");

  // ─────────────────────────────────────────────────────────────
  // Market platform + trading tools (Module 13, ADR-086 / ADR-087)
  // ─────────────────────────────────────────────────────────────
  //
  // Create-only on content, like every other seeded row: an admin who renames
  // an instrument or rewrites a tool's intro keeps their words through the next
  // seed run.

  // The provider is seeded MANUAL and DISABLED. A fresh clone must not reach
  // for a network on first boot, and every rate-backed tool degrades to a
  // labelled empty state rather than an error (ADR-087 #11).
  await db.marketProvider.upsert({
    where: { id: "default" },
    update: {},
    create: { id: "default", driver: "MANUAL", isEnabled: false },
  });

  const MAJOR_CURRENCIES: [string, string][] = [
    ["USD", "US Dollar"],
    ["EUR", "Euro"],
    ["GBP", "British Pound"],
    ["JPY", "Japanese Yen"],
    ["CHF", "Swiss Franc"],
    ["AUD", "Australian Dollar"],
    ["CAD", "Canadian Dollar"],
    ["NZD", "New Zealand Dollar"],
  ];

  const PAIRS: [string, string, string][] = [
    ["EUR/USD", "EUR", "USD"],
    ["GBP/USD", "GBP", "USD"],
    ["USD/JPY", "USD", "JPY"],
    ["USD/CHF", "USD", "CHF"],
    ["AUD/USD", "AUD", "USD"],
    ["USD/CAD", "USD", "CAD"],
    ["NZD/USD", "NZD", "USD"],
    ["EUR/GBP", "EUR", "GBP"],
    ["EUR/JPY", "EUR", "JPY"],
    ["GBP/JPY", "GBP", "JPY"],
    ["EUR/CHF", "EUR", "CHF"],
    ["AUD/JPY", "AUD", "JPY"],
    // The rest of the crosses the eight majors make. Every one is two
    // AlphaVantage physical currencies, so FX_DAILY serves them on the same
    // free tier the majors come from — which is the whole test for whether a
    // row belongs in this list (see OTHER_INSTRUMENTS below).
    ["EUR/AUD", "EUR", "AUD"],
    ["EUR/CAD", "EUR", "CAD"],
    ["EUR/NZD", "EUR", "NZD"],
    ["GBP/CHF", "GBP", "CHF"],
    ["GBP/AUD", "GBP", "AUD"],
    ["GBP/CAD", "GBP", "CAD"],
    ["AUD/CAD", "AUD", "CAD"],
    ["AUD/CHF", "AUD", "CHF"],
    ["AUD/NZD", "AUD", "NZD"],
    ["NZD/JPY", "NZD", "JPY"],
    ["CAD/JPY", "CAD", "JPY"],
    ["CHF/JPY", "CHF", "JPY"],
    // The Exotic group on /tools/live-rates and /tools/volatility (ADR-136 §4).
    // Seeded so the volatility board has rows to fill once a provider is
    // configured; with the MANUAL provider they report nothing, as every
    // other instrument does.
    ["USD/TRY", "USD", "TRY"],
    ["USD/ZAR", "USD", "ZAR"],
    ["USD/MXN", "USD", "MXN"],
    ["USD/SGD", "USD", "SGD"],
    ["USD/SEK", "USD", "SEK"],
    ["USD/NOK", "USD", "NOK"],
  ];

  // Everything that is not a currency or a currency pair.
  //
  // **The last column is `isActive`, and the METAL / INDEX / COMMODITY rows
  // are seeded OFF.** Neither shipped driver can ever serve them: `MANUAL`
  // serves nothing, and AlphaVantage's free tier has no physical-currency
  // entry for XAU or XAG, prices gold, silver and WTI one number a day (a bar
  // invented from one price claims a high and a low nobody measured, ADR-087
  // #2), and puts `INDEX_DATA` behind its paid tier. `syncDailyBars` spends no
  // request on them — `supportsKind` filters them out first — but it does name
  // them under "Not available from this provider" on every single run, which
  // is an admin being told to act on a list that nothing they do can shorten.
  //
  // Seeded OFF rather than DELETED, because the rows are not wrong, they are
  // unreachable from HERE: `MARKET_BOARD_GROUPS.commodities` still names
  // XAU/XAG/WTI for the live-rates frame (that board reads TradingView's
  // tickers, so it is unaffected either way), and an instance that buys a
  // provider which serves metals turns three switches back on instead of
  // re-deriving this table. An inactive row reports nothing on the volatility
  // board — which is exactly what an active row with no bars was already
  // doing.
  const OTHER_INSTRUMENTS: [string, string, string, string, string, boolean][] = [
    // symbol, name, kind, base, quote, isActive
    ["XAU/USD", "Gold", "METAL", "XAU", "USD", false],
    ["XAG/USD", "Silver", "METAL", "XAG", "USD", false],
    ["SPX/USD", "S&P 500", "INDEX", "SPX", "USD", false],
    ["NDX/USD", "Nasdaq 100", "INDEX", "NDX", "USD", false],
    ["WTI/USD", "Crude Oil (WTI)", "COMMODITY", "WTI", "USD", false],
    ["DXY/USD", "US Dollar Index", "INDEX", "DXY", "USD", false],
    // Crypto IS served, on `DIGITAL_CURRENCY_DAILY`, with the same four
    // prices a bar needs — so these are the only non-FX rows that can carry
    // history on a free key, and the set is widened to match.
    ["BTC/USD", "Bitcoin", "CRYPTO", "BTC", "USD", true],
    ["ETH/USD", "Ethereum", "CRYPTO", "ETH", "USD", true],
    ["XRP/USD", "XRP", "CRYPTO", "XRP", "USD", true],
    ["LTC/USD", "Litecoin", "CRYPTO", "LTC", "USD", true],
    ["SOL/USD", "Solana", "CRYPTO", "SOL", "USD", true],
    ["ADA/USD", "Cardano", "CRYPTO", "ADA", "USD", true],
  ];

  let instrumentOrder = 0;
  const instrumentIdBySymbol = new Map<string, string>();

  async function seedInstrument(input: {
    symbol: string;
    displayName: string;
    kind: "CURRENCY" | "PAIR" | "CRYPTO" | "METAL" | "INDEX" | "COMMODITY";
    base: string | null;
    quote: string | null;
    decimals: number;
    isActive?: boolean;
  }) {
    const row = await db.marketInstrument.upsert({
      where: { symbol: input.symbol },
      update: {},
      create: {
        symbol: input.symbol,
        displayName: input.displayName,
        kind: input.kind,
        base: input.base,
        quote: input.quote,
        decimals: input.decimals,
        isActive: input.isActive ?? true,
        sortOrder: instrumentOrder++,
      },
    });
    instrumentIdBySymbol.set(input.symbol, row.id);
  }

  for (const [code, name] of MAJOR_CURRENCIES) {
    await seedInstrument({
      symbol: code,
      displayName: name,
      kind: "CURRENCY",
      // A CURRENCY row is quoted against USD, which is what lets
      // getRateSnapshot place it without a second table (ADR-087 #1).
      base: code,
      quote: "USD",
      decimals: code === "JPY" ? 3 : 5,
    });
  }
  for (const [symbol, base, quote] of PAIRS) {
    await seedInstrument({
      symbol,
      displayName: symbol,
      kind: "PAIR",
      base,
      quote,
      decimals: quote === "JPY" ? 3 : 5,
    });
  }
  for (const [symbol, displayName, kind, base, quote, isActive] of OTHER_INSTRUMENTS) {
    await seedInstrument({
      symbol,
      displayName,
      kind: kind as "CRYPTO" | "METAL" | "INDEX" | "COMMODITY",
      base,
      quote,
      decimals: 2,
      isActive,
    });
  }
  const inactiveInstruments = OTHER_INSTRUMENTS.filter(([, , , , , active]) => !active).length;
  console.log(
    `  market instruments: ${MAJOR_CURRENCIES.length + PAIRS.length + OTHER_INSTRUMENTS.length}` +
      ` (${inactiveInstruments} inactive: no shipped driver serves metals, indices or oil)` +
      " (provider: MANUAL, disabled)",
  );

  // ─── The tools (eleven since changes-41, ADR-135) ───────────
  //
  // ADR-086 #1: the SET is code (TOOL_KEYS) and the CONTENT is data. These
  // rows are the starting content — every word below is admin-editable, and
  // none of the behaviour is.
  //
  // ─── Every tool has the same two sections (changes-40) ──────
  //
  // `intro` opens with a DEFINITION under its own `<h2>` — "What is a pip?",
  // "What is margin?" — and `body` opens with "How to use this calculator"
  // under another, with numbered steps. The owner's own pip page is the shape
  // (mbfx.co/tools/pip-calculator: definition, then instructions, then the
  // "why use this" cards `TOOL_HIGHLIGHTS` already seeds), and it is the right
  // one: a reader arriving from a search result needs to know what the word
  // means before the form means anything.
  //
  // They were headless paragraphs before, so a page that ADR-114 put side by
  // side with its calculator read as two unlabelled blocks of prose. The
  // explanations that follow keep their own `<h2>`s, unchanged.

  const id = (symbol: string) => instrumentIdBySymbol.get(symbol) ?? "";
  const currencyIds = MAJOR_CURRENCIES.map(([code]) => id(code)).filter(Boolean);
  const pairIds = PAIRS.map(([symbol]) => id(symbol)).filter(Boolean);

  const TOOL_SEEDS: {
    key: string;
    sortOrder: number;
    title: string;
    tagline: string;
    intro: string;
    body: string;
    /** Every tool seeds three or four; an admin edits or adds the rest. */
    faq?: { question: string; answer: string }[];
    seoFocusKeyword?: string;
    config: unknown;
  }[] = [
    {
      key: "position-size",
      sortOrder: 0,
      title: "Position Size Calculator",
      tagline: "Work out how big a trade can be before it risks more than you meant.",
      intro:
        "<h2>What is position size?</h2>" +
        "<p>Position size is how much of a currency pair a trade buys or sells. It is the one part " +
        "of a trade that is entirely yours to decide: the market decides whether the trade wins, and " +
        "the size decides what it costs you when it loses.</p>" +
        "<p>Sizing from risk means choosing that cost first — a share of your balance you are " +
        "willing to lose — and letting the number of units follow from it, rather than trading a " +
        "round lot and finding out afterwards what the lot was risking.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Select your account currency</li>" +
        "<li>Choose the currency pair you want to trade</li>" +
        "<li>Enter your account balance and the share of it you are willing to risk</li>" +
        "<li>Enter how far away your stop loss sits, in pips</li>" +
        "<li>Read off the position size, and the amount at risk it is built from</li>" +
        "</ol>" +
        "<h2>How the figure is worked out</h2>" +
        "<p>The amount at risk is your balance multiplied by your risk percentage. Divide that by " +
        "the stop-loss distance in pips, and again by the value of one pip, and what is left is the " +
        "position size that makes those two numbers agree.</p>" +
        "<p>When your account currency is not the pair's quote currency, one more step is needed: " +
        "the pip value has to be converted. We show that conversion rather than folding it away, " +
        "because it is the step most spreadsheets get wrong.</p>",
      faq: [
        {
          question: "How much of my account should I risk on one trade?",
          answer:
            "Many traders keep it between 1% and 2% of the balance. The exact figure is yours to " +
            "choose; what matters is choosing it before the trade and keeping it the same " +
            "from one trade to the next.",
        },
        {
          question: "Why does a wider stop loss give me a smaller position?",
          answer:
            "The amount you are willing to lose stays fixed. If the stop sits further away, each " +
            "pip of that distance has to cost less, and the only way to make a pip cost less is " +
            "to trade fewer units.",
        },
        {
          question: "What is the difference between units and lots?",
          answer:
            "They measure the same thing. A standard lot is 100,000 units of the base currency, a " +
            "mini lot 10,000 and a micro lot 1,000, so a result of 25,000 units is a quarter of a " +
            "standard lot.",
        },
      ],
      config: {
        defaultAccountCurrency: "USD",
        defaultPairId: id("EUR/USD"),
        defaultRiskPercent: 1,
        minRiskPercent: 0.1,
        maxRiskPercent: 10,
        pairIds,
        accountCurrencyIds: currencyIds,
      },
    },
    {
      key: "pip-value",
      sortOrder: 1,
      // Title and tagline are the owner's own reference page
      // (mbfx.co/tools/pip-calculator), word for word — the treatment ADR-135
      // already gave margin, profit and risk. The URL stays `/tools/pip-value`:
      // the registry key is the segment (ADR-086 #3) and a title is data.
      title: "Pip Calculator",
      tagline:
        "Calculate the value of a pip for any currency pair and trade size. Essential tool for " +
        "risk management and position sizing.",
      intro:
        "<h2>What is a pip?</h2>" +
        "<p>A pip is the smallest price move a currency pair ordinarily makes. For most pairs that " +
        "is the fourth decimal place, 0.0001. For pairs quoted in Japanese yen it is the second, " +
        "0.01, because the yen is quoted to two decimal places rather than four.</p>" +
        "<p>What a pip is <em>worth</em> is a different question. It depends on how much you are " +
        "trading and what currency your account is held in, which is why the same one-pip move can " +
        "be ten dollars or nine euros. That figure is what turns a stop-loss distance on a chart " +
        "into an amount of money.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Select your account currency</li>" +
        "<li>Choose the currency pair you want to trade</li>" +
        "<li>Enter your trade size in units, and read off the value of one pip</li>" +
        "</ol>" +
        "<h2>How the figure is worked out</h2>" +
        "<p>Multiply the pip size for the pair by your position size in units, and you have the " +
        "value of a pip in the pair's quote currency.</p>" +
        "<p>If your account is held in a different currency, that figure is converted at the stored " +
        "exchange rate, and the page prints the day that rate is from.</p>",
      faq: [
        {
          question: "How much is one pip worth on a standard lot?",
          answer:
            "On a pair quoted in US dollars, such as EUR/USD, one pip on a standard lot of " +
            "100,000 units is worth 10 US dollars. On other pairs it depends on the quote " +
            "currency and on the currency your account is held in.",
        },
        {
          question: "What is the difference between a pip and a pipette?",
          answer:
            "A pipette is a tenth of a pip. Many platforms quote prices to one extra decimal " +
            "place, so EUR/USD moving from 1.10005 to 1.10015 has moved ten pipettes, which is " +
            "one pip.",
        },
        {
          question: "Why does the pip value change from day to day?",
          answer:
            "When your account currency is not the pair's quote currency, the pip value is " +
            "converted at an exchange rate, and that rate moves. On a pair quoted in your own " +
            "account currency, the pip value stays the same.",
        },
      ],
      config: {
        defaultAccountCurrency: "USD",
        defaultPairId: id("EUR/USD"),
        defaultUnits: 100000,
        pairIds,
        accountCurrencyIds: currencyIds,
      },
    },
    // ── changes-41 (ADR-135) ──────────────────────────────────
    //
    // Title, tagline and each "Understanding Margin" / "Trading Tips" /
    // "Risk Management Tips" list are the owner's own reference pages
    // (mbfx.co/tools/*), word for word. The rest is written to match the eight
    // above. Nothing is carried over from those pages' footers: a regulatory
    // number or a compensation scheme is a claim about a brokerage (ADR-047
    // §2), never starting content for a calculator.
    {
      key: "margin",
      sortOrder: 2,
      title: "Margin Calculator",
      tagline:
        "Calculate the required margin for your trades based on instrument, trade size, and " +
        "leverage. Essential for proper risk management and position sizing.",
      intro:
        "<h2>What is margin?</h2>" +
        "<p>Margin is the deposit a position needs while it is open. It is not a fee and it is not " +
        "what the trade can lose: it is your own money, set aside while the position is running and " +
        "released when it closes.</p>" +
        "<p>How much is set aside depends on the leverage you trade at. At 1:100 a 100,000-unit " +
        "position ties up 1,000 units of the base currency; at 1:500 the same position ties up 200. " +
        "What each pip costs you does not change with it.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Select your account currency</li>" +
        "<li>Choose the currency pair and enter your trade size in units</li>" +
        "<li>Enter your account balance and pick your leverage</li>" +
        "<li>Read off the required margin, the free margin left, and your margin level</li>" +
        "</ol>" +
        "<h2>Understanding Margin</h2>" +
        "<ul>" +
        "<li><strong>Required Margin:</strong> The amount needed to open a position</li>" +
        "<li><strong>Free Margin:</strong> Available funds for new positions</li>" +
        "<li><strong>Margin Level:</strong> (Equity / Used Margin) &times; 100</li>" +
        "<li><strong>Margin Call:</strong> Usually occurs at 100% margin level</li>" +
        "</ul>" +
        "<h2>How the figure is worked out</h2>" +
        "<p>A position of 100,000 units is 100,000 of the pair's base currency. At 1:100 leverage " +
        "the deposit is a hundredth of that: 1,000 of the base currency, converted into your " +
        "account currency at the stored rate.</p>" +
        "<p>Before a position is open, your equity is the same as your balance, so that is what the " +
        "margin level here is measured against. Once a trade moves, its profit or loss moves your " +
        "equity, and your margin level with it.</p>" +
        "<p>Leverage changes the deposit, not the risk. A 50-pip move costs the same on a " +
        "100,000-unit position at 1:50 as it does at 1:500.</p>",
      faq: [
        {
          question: "What is the difference between margin and leverage?",
          answer:
            "Leverage is the ratio; margin is the money. At 1:100 leverage, every 100 units of " +
            "position need 1 unit of margin set aside while the trade is open.",
        },
        {
          question: "What is a margin call?",
          answer:
            "A warning that your equity has fallen close to the margin your open positions are " +
            "using. The level it happens at is set by your broker, and a 100% margin level is a " +
            "common one. Below a further level, positions can be closed for you.",
        },
        {
          question: "Why does my account currency change the result?",
          answer:
            "Margin is worked out in the pair's base currency, because that is what a position is " +
            "measured in. If your account is held in another currency, the deposit is converted " +
            "at the stored exchange rate.",
        },
        {
          question: "Does higher leverage mean more risk?",
          answer:
            "It means a smaller deposit, which lets you open a larger position with the same " +
            "balance. The position size, not the leverage, decides what each pip costs you.",
        },
      ],
      seoFocusKeyword: "margin calculator",
      config: {
        defaultAccountCurrency: "USD",
        defaultPairId: id("EUR/USD"),
        defaultUnits: 100000,
        defaultBalance: 10000,
        leverageOptions: [50, 100, 200, 400, 500],
        defaultLeverage: 100,
        pairIds,
        accountCurrencyIds: currencyIds,
      },
    },
    {
      key: "profit-loss",
      sortOrder: 3,
      title: "Profit Calculator",
      tagline:
        "Calculate potential profit and loss for your forex trades before you enter the market. " +
        "Essential tool for trade planning and risk management.",
      intro:
        "<h2>What is profit and loss on a forex trade?</h2>" +
        "<p>A forex trade makes or loses the distance the price moved multiplied by the size of the " +
        "position. The distance is measured in pips; the money is measured first in the pair's quote " +
        "currency and then in yours.</p>" +
        "<p>The same fifty-pip move is a few dollars on a micro lot and a few hundred on a standard " +
        "one, which is why a result in pips and a result in money are two different answers to two " +
        "different questions. A buy profits when the price rises and a sell when it falls.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Select your account currency</li>" +
        "<li>Choose the currency pair you want to trade</li>" +
        "<li>Select trade type (Buy/Sell)</li>" +
        "<li>Enter lot size and open/close prices</li>" +
        "<li>See your profit or loss update as you type</li>" +
        "</ol>" +
        "<h2>Trading Tips</h2>" +
        "<ul>" +
        "<li>Always calculate potential profit/loss before entering trades</li>" +
        "<li>Use proper risk management with stop losses</li>" +
        "<li>Consider the risk-reward ratio for each trade</li>" +
        "<li>Factor in spread costs when calculating profits</li>" +
        "</ul>" +
        "<h2>How the figure is worked out</h2>" +
        "<p>The difference between the close and the open price, multiplied by the position size in " +
        "units, is the result in the pair's quote currency. On a buy, a higher close is a profit; on " +
        "a sell, a lower one is.</p>" +
        "<p>That figure is then converted into your account currency at the stored exchange rate. " +
        "Spreads, commissions and swaps are not included, so a real trade will do slightly worse " +
        "than the figure shown.</p>",
      faq: [
        {
          question: "What is the difference between pips and profit?",
          answer:
            "A pip is a distance in price. Profit is that distance multiplied by the size of your " +
            "position. Fifty pips on a micro lot and fifty pips on a standard lot are the same " +
            "move and very different amounts of money.",
        },
        {
          question: "How are sell trades calculated?",
          answer:
            "A sell profits when the price falls. The calculator reverses the sign for you, so a " +
            "sell opened at 1.1050 and closed at 1.1000 shows a 50-pip profit.",
        },
        {
          question: "Why are yen pairs different?",
          answer:
            "Yen pairs are quoted to two decimal places, so one pip is 0.01 rather than 0.0001. " +
            "The calculator uses the right pip size for the pair you choose.",
        },
        {
          question: "Does the result include spreads and fees?",
          answer:
            "No. It is the price move alone. Your broker's spread, commission and any overnight " +
            "swap all come off it, so treat the figure as the best case for those prices.",
        },
      ],
      seoFocusKeyword: "forex profit calculator",
      config: {
        defaultAccountCurrency: "USD",
        defaultPairId: id("EUR/USD"),
        defaultLots: 1,
        pairIds,
        accountCurrencyIds: currencyIds,
      },
    },
    {
      key: "risk-reward",
      sortOrder: 4,
      title: "Risk Calculator",
      tagline:
        "Calculate your trading risk, position size, and risk-reward ratio. Essential for proper " +
        "risk management and consistent trading results.",
      intro:
        "<h2>What is risk-reward?</h2>" +
        "<p>Risk is the distance from your entry to your stop loss, in money. Reward is the distance " +
        "from your entry to your take profit, in the same money. The ratio between the two is what " +
        "decides whether a strategy can survive being wrong more often than it is right.</p>" +
        "<p>At 1:2 — a target paying twice what the stop costs — winning one trade in three roughly " +
        "breaks even before costs. At 1:1 you have to be right more than half the time for the same " +
        "result.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Select your account currency and the currency pair</li>" +
        "<li>Enter your account balance and the share of it you are willing to risk</li>" +
        "<li>Enter your entry, stop loss and take profit as prices, the way they appear on a chart</li>" +
        "<li>Read off the amount at risk, the position size it allows, and the risk-reward ratio</li>" +
        "</ol>" +
        "<h2>Risk Management Tips</h2>" +
        "<ul>" +
        "<li><strong>2% Rule:</strong> Never risk more than 2% per trade</li>" +
        "<li><strong>Risk:Reward:</strong> Aim for minimum 1:2 ratio</li>" +
        "<li><strong>Position Size:</strong> Adjust based on stop loss distance</li>" +
        "<li><strong>Consistency:</strong> Use same risk % for all trades</li>" +
        "</ul>" +
        "<h2>How the figures are worked out</h2>" +
        "<p>The amount at risk is your balance multiplied by your risk percentage. The " +
        "distance from the entry to the stop loss, in pips, sets how big a position that " +
        "amount can carry.</p>" +
        "<p>The distance from the entry to the take profit, divided by the distance to the stop, is " +
        "the risk-reward ratio. A ratio of 1:2 means the target pays twice what the stop costs.</p>" +
        "<p>A stop below the entry is read as a buy and a stop above it as a sell, so the take " +
        "profit belongs on the other side.</p>",
      faq: [
        {
          question: "What is the 2% rule?",
          answer:
            "A guideline that no single trade should be able to lose more than 2% of the account. " +
            "At that size, a run of ten losing trades in a row still leaves more than 80% of the " +
            "balance.",
        },
        {
          question: "What does a 1:2 risk-reward ratio mean?",
          answer:
            "The take profit is twice as far from the entry as the stop loss. At that ratio, a " +
            "strategy that wins one trade in three roughly breaks even before costs.",
        },
        {
          question: "Why does the calculator say my take profit is on the wrong side?",
          answer:
            "The direction of the trade is read from the stop loss. If the stop is below the " +
            "entry, the trade is a buy and the take profit must be above it. If the stop is above " +
            "the entry, it is a sell and the take profit must be below it.",
        },
        {
          question: "How is this different from the Position Size Calculator?",
          answer:
            "The Position Size Calculator takes a stop-loss distance in pips. This one takes " +
            "prices and adds the take profit, so it can also show the reward and the ratio " +
            "between the two.",
        },
      ],
      seoFocusKeyword: "forex risk calculator",
      config: {
        defaultAccountCurrency: "USD",
        defaultPairId: id("EUR/USD"),
        defaultBalance: 10000,
        defaultRiskPercent: 2,
        minRiskPercent: 0.1,
        maxRiskPercent: 10,
        conservativeMaxPercent: 1,
        moderateMaxPercent: 2,
        minRecommendedRatio: 2,
        pairIds,
        accountCurrencyIds: currencyIds,
      },
    },
    {
      key: "gain-loss",
      sortOrder: 5,
      title: "Gain & Loss Percentage Calculator",
      tagline: "Tell us one of the three figures and we will work out the other two.",
      intro:
        "<h2>What is a gain or loss percentage?</h2>" +
        "<p>A percentage gain or loss is the change in a balance measured against the balance it " +
        "started from. That last part is what makes the two asymmetrical: a loss is measured against " +
        "the larger balance you had, and the gain that would undo it is measured against the smaller " +
        "one you are left with.</p>" +
        "<p>Lose 50% and a 50% gain does not restore the account. You need 100%, because the gain is " +
        "earned on what is left.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Enter the balance you started from</li>" +
        "<li>Enter any ONE of the other three: the amount made or lost, the percentage, or the " +
        "balance you ended with</li>" +
        "<li>Read off the two figures it fills in, and what it takes to get back to level</li>" +
        "</ol>" +
        "<h2>About gains, losses, and getting back to even</h2>" +
        "<p>The asymmetry above is the whole argument for position sizing. A string of small, " +
        "survivable losses is recoverable arithmetic. A large one is not.</p>" +
        "<p>Nothing here needs a market rate, so this calculator answers the same way on a laptop " +
        "with no connection at all.</p>",
      faq: [
        {
          question: "Why doesn't a 50% gain recover a 50% loss?",
          answer:
            "The gain is earned on the smaller balance. 10,000 down 50% is 5,000, and 50% of " +
            "5,000 is only 2,500, which leaves you at 7,500. Getting back to 10,000 takes a 100% " +
            "gain.",
        },
        {
          question: "How is the percentage worked out?",
          answer:
            "The change in the balance is divided by the balance you started from, then " +
            "multiplied by 100. A move from 10,000 to 11,500 is a change of 1,500, which is 15%.",
        },
        {
          question: "Do I need to fill in every field?",
          answer:
            "No. Enter the starting balance and any one of the other figures, and the calculator " +
            "fills in the rest.",
        },
      ],
      config: { defaultStartBalance: 10000, decimals: 2 },
    },
    {
      key: "pivot-points",
      sortOrder: 6,
      title: "Pivot Point Calculator",
      tagline: "Five methods, computed from the last completed period.",
      intro:
        "<h2>What are pivot points?</h2>" +
        "<p>A pivot point is a price worked out from the previous period's high, low and close, and " +
        "used as the axis for the period that follows. The levels above it are read as resistance, " +
        "the levels below it as support.</p>" +
        "<p>They are arithmetic rather than a forecast: the same four numbers always give the same " +
        "levels. That is also why they are watched — a great many traders are looking at exactly the " +
        "same lines.</p>",
      body:
        "<h2>How to use this calculator</h2>" +
        "<ol>" +
        "<li>Choose a symbol and an interval — daily, weekly, monthly or yearly</li>" +
        "<li>The open, high, low and close of the last completed period are filled in for you where " +
        "the platform has them; type your own over the top at any time</li>" +
        "<li>Read the table: every method, side by side, for the same four prices</li>" +
        "</ol>" +
        "<h2>About Pivot Points</h2>" +
        "<p>Five methods are offered, and they disagree with each other on purpose.</p>" +
        "<p><strong>Floor</strong> is the classic: the pivot is the average of the high, the low and " +
        "the close, and the supports and resistances are reflected around it.</p>" +
        "<p><strong>Woodie</strong> weights the opening price double, so the pivot leans toward " +
        "where the period began rather than where it ended.</p>" +
        "<p><strong>Camarilla</strong> is the only method with four levels a side, and its levels " +
        "are measured from the close rather than from the pivot.</p>" +
        "<p><strong>DeMark</strong> gives one level a side, and which formula it uses depends on " +
        "whether the period closed above or below its open.</p>" +
        "<p><strong>Fibonacci</strong> places its levels at 38.2%, 61.8% and 100% of the period's " +
        "range, measured from the pivot.</p>" +
        "<p>Levels are computed from the last COMPLETED period, never from one still trading. A " +
        "level recalculated every hour out of a half-formed bar is not a level anyone can plan " +
        "against.</p>",
      faq: [
        {
          question: "Which pivot point method should I use?",
          answer:
            "There is no single right one. Floor pivots are the most widely watched, which is " +
            "much of their value. The others weight the prices differently, and seeing all five " +
            "side by side shows where they agree.",
        },
        {
          question: "What do the support and resistance levels mean?",
          answer:
            "They are prices where traders watching the same levels may expect the market to " +
            "pause or turn. They are worked out from arithmetic, not from a forecast, and the " +
            "price is free to move straight through them.",
        },
        {
          question: "Which interval should I pick?",
          answer:
            "Match it to how long you hold a trade. Daily pivots suit trades that open and close " +
            "within the day; weekly and monthly pivots suit positions held for longer.",
        },
      ],
      config: {
        intervals: ["1D", "1W", "1M", "1Y"],
        defaultInterval: "1D",
        symbolIds: pairIds,
        defaultSymbolId: id("EUR/USD"),
      },
    },
    {
      key: "market-hours",
      sortOrder: 7,
      title: "Forex Market Hours",
      tagline: "Which sessions are open right now, in your own timezone.",
      intro:
        "<h2>When is the forex market open?</h2>" +
        "<p>The currency market runs around the clock from Sydney's Sunday open to New York's Friday " +
        "close. It has no single exchange and no opening bell: it is four regional sessions handing " +
        "over to one another.</p>" +
        "<p>It is not equally busy throughout. Where two sessions are open at once there are twice " +
        "as many people trading the same pairs, and that is where most of the day's movement " +
        "happens.</p>",
      body:
        "<h2>How to use this page</h2>" +
        "<ol>" +
        "<li>Check the clock at the top — it is your own local time, read from your device</li>" +
        "<li>See which sessions are open now, and how long each has left</li>" +
        "<li>Look at the overlaps to find the busiest windows of your own day</li>" +
        "</ol>" +
        "<h2>About the trading sessions</h2>" +
        "<p>All four session times are shown in the timezone you pick, and they follow daylight " +
        "saving automatically — which is why London's hours shift against Tokyo's twice a year even " +
        "though Tokyo never changes its clocks.</p>" +
        "<p>The busiest window is the London/New York overlap, when the two largest sessions are " +
        "open at once. The quietest is the gap between the New York close and the Tokyo open.</p>" +
        "<p>The market is shut across the weekend. The gap is bounded by two local times, not by a " +
        "UTC midnight, so it opens and closes at a different clock hour depending where you are " +
        "reading this.</p>",
      faq: [
        {
          question: "Is the forex market open 24 hours a day?",
          answer:
            "On weekdays, yes. It opens with Sydney on Sunday evening in New York terms and " +
            "closes with New York on Friday afternoon. Across the weekend it is shut.",
        },
        {
          question: "What is the best time of day to trade?",
          answer:
            "Most activity happens where two sessions overlap, and the London and New York " +
            "overlap is usually the busiest. Busier is not the same as better: more movement " +
            "means more opportunity and more risk alike.",
        },
        {
          question: "Why did the session times shift by an hour?",
          answer:
            "Daylight saving. London, New York and Sydney change their clocks on different " +
            "dates and Tokyo does not change them at all, so the sessions move against each " +
            "other and against your own clock a few times a year.",
        },
      ],
      config: {
        sessions: [
          {
            name: "Sydney",
            city: "Sydney",
            timeZone: "Australia/Sydney",
            open: "07:00",
            close: "16:00",
          },
          { name: "Tokyo", city: "Tokyo", timeZone: "Asia/Tokyo", open: "09:00", close: "18:00" },
          {
            name: "London",
            city: "London",
            timeZone: "Europe/London",
            open: "08:00",
            close: "17:00",
          },
          {
            name: "New York",
            city: "New York",
            timeZone: "America/New_York",
            open: "08:00",
            close: "17:00",
          },
        ],
        mediumVolumeFrom: 2,
        highVolumeFrom: 3,
      },
    },
    {
      key: "currency-converter",
      sortOrder: 8,
      title: "Currency Converter",
      tagline: "Convert between currencies, and see what a markup really costs.",
      intro:
        "<h2>What is the mid-market rate?</h2>" +
        "<p>The mid-market rate is the midpoint between what buyers are offering for a currency and " +
        "what sellers are asking for it. It is the rate quoted in the news, and it is the rate every " +
        "other rate is measured against.</p>" +
        "<p>It is also not a rate anybody will hand you. What a bank, an ATM, a card or an airport " +
        "kiosk gives you is that rate less a markup, and the size of the markup is usually larger " +
        "than people expect.</p>",
      body:
        "<h2>How to use this converter</h2>" +
        "<ol>" +
        "<li>Pick the currency you are converting from and the one you want</li>" +
        "<li>Enter the amount</li>" +
        "<li>Read the mid-market result, then compare it with what each kind of provider would " +
        "typically hand you</li>" +
        "</ol>" +
        "<h2>About the rates you are shown</h2>" +
        "<p>The four comparison options apply a typical markup to the mid-market rate. They are " +
        "estimates, not quotes, and they are not attributed to any named provider — what a " +
        "particular bank or kiosk charges you on a particular day is between you and them. The " +
        "figures exist to show the SHAPE of the cost.</p>" +
        "<p>Rates come from the last completed daily close, and the page says when that was.</p>",
      faq: [
        {
          question: "Why is my bank's rate different from the one shown?",
          answer:
            "The converter shows the mid-market rate. A bank, card or kiosk adds a markup to it, " +
            "sometimes as a visible fee and often built into a worse rate, so the amount you " +
            "receive is lower.",
        },
        {
          question: "How current are the rates?",
          answer:
            "They are taken from the last completed daily close, and the page prints the date. " +
            "They are for reference and planning, not a quote you can deal at.",
        },
        {
          question: "Are the provider comparisons real quotes?",
          answer:
            "No. They apply a typical markup for each kind of provider to show the shape of the " +
            "cost. What a particular provider charges you on a particular day can be higher or " +
            "lower.",
        },
      ],
      config: {
        currencyIds,
        defaultFrom: "USD",
        defaultTo: "EUR",
        defaultAmount: 100,
        decimals: 2,
        rateMarkups: { bank: 3, atm: 4, card: 2.5, kiosk: 7 },
        offeredRateTypes: ["market", "bank", "atm", "card", "kiosk"],
      },
    },
    {
      key: "correlation",
      sortOrder: 9,
      title: "Currency Correlation",
      tagline: "Which pairs move together, and which move apart.",
      intro:
        "<h2>What is currency correlation?</h2>" +
        "<p>Correlation measures how closely two pairs have moved together. At +1 they have moved in " +
        "lockstep, at &minus;1 exactly opposite, and near 0 their day-to-day moves have had nothing " +
        "to do with each other.</p>" +
        "<p>It matters because two positions in strongly correlated pairs are closer to one position " +
        "than to two. An account holding EUR/USD and GBP/USD is largely holding one bet against the " +
        "dollar, at twice the size the position sizing assumed.</p>",
      body:
        "<h2>How to use this grid</h2>" +
        "<ol>" +
        "<li>Pick a window — the number of trading days the figures are measured over</li>" +
        "<li>Read a cell as the relationship between the pair on its row and the pair on its " +
        "column</li>" +
        "<li>Check the pairs you already hold against the one you are about to open</li>" +
        "</ol>" +
        "<h2>What the numbers mean</h2>" +
        "<p>We correlate daily <em>returns</em>, not prices. That distinction matters more than it " +
        "sounds: two pairs that are both drifting upward will look correlated at the price level " +
        "even when their day-to-day moves have nothing to do with each other.</p>" +
        "<p>A cell with too little history shows a dash rather than a number. A coefficient computed " +
        "from a handful of days is not a small measurement, it is a wrong one.</p>" +
        "<p>These figures describe a window that has already closed. They are updated once a day and " +
        "are not a forecast.</p>",
      faq: [
        {
          question: "What counts as a strong correlation?",
          answer:
            "As a rough guide, a figure above +0.7 or below −0.7 is strong, and one between " +
            "−0.3 and +0.3 is weak. The sign tells you the direction: positive pairs have moved " +
            "together, negative ones opposite.",
        },
        {
          question: "Why do the numbers change between windows?",
          answer:
            "Correlations shift over time. A short window shows how two pairs have behaved " +
            "recently; a long one shows the steadier relationship underneath. When the two " +
            "disagree, the relationship is changing.",
        },
        {
          question: "How can correlation help me manage risk?",
          answer:
            "Before opening a trade, check it against what you already hold. A new position in " +
            "a pair strongly correlated with an open one adds to the same bet rather than " +
            "spreading your risk.",
        },
      ],
      config: {
        windows: ["5d", "10d", "30d", "60d", "90d", "180d", "250d"],
        defaultWindow: "30d",
        instrumentIds: pairIds,
      },
    },
    {
      key: "risk-sentiment",
      sortOrder: 10,
      title: "Risk-On / Risk-Off Meter",
      tagline: "Whether the market has been reaching for risk, or away from it.",
      intro:
        "<h2>What is risk-on and risk-off?</h2>" +
        "<p>Risk-on and risk-off describe which way money has been moving. When investors are " +
        "willing to take risk, money moves toward equities, the commodity currencies and the " +
        "higher-yielding emerging markets; when they are not, it moves back toward the dollar, " +
        "the yen and the franc.</p>" +
        "<p>The meter is a single score from 0 to 100 built from how a basket of those markets has " +
        "moved relative to its own recent history. High is risk-on; low is risk-off.</p>",
      body:
        "<h2>How to read this meter</h2>" +
        "<ol>" +
        "<li>Read the score first: above the upper band is risk-on, below the lower one risk-off, " +
        "and the middle is neither</li>" +
        "<li>Look at the components to see which markets are carrying the score</li>" +
        "<li>Check the date it was last worked out — it describes a day that has closed</li>" +
        "</ol>" +
        "<h2>How the score is built</h2>" +
        "<p>Each market in the basket is scored by where its latest move sits within its own recent " +
        "range — its percentile rank. A market that usually moves half a percent and has just moved " +
        "two ranks near the top of its own history, whatever the absolute number.</p>" +
        "<p>Markets that rise when risk is being taken on — the commodity currencies, bitcoin — " +
        "score as they rank. Markets that rise when risk is coming off — the dollar against the " +
        "emerging-market currencies — have their rank flipped before it is counted. The weighted " +
        "average of what is left is the score.</p>" +
        "<p>A market with too little history is left out and counted, never filled in with a zero. A " +
        "zero would be a claim that the market was neutral; leaving it out is the truth, which is " +
        "that we do not know.</p>" +
        "<p>The score is updated once a day. It describes what has already happened, it is not a " +
        "forecast, and it is not a recommendation to do anything.</p>",
      faq: [
        {
          question: "What does a score of 50 mean?",
          answer:
            "That the basket has been neither reaching for risk nor away from it. Its markets " +
            "have moved roughly in line with their own recent history, or the risk-on and " +
            "risk-off moves have cancelled each other out.",
        },
        {
          question: "Why is the dollar against the rand and the peso counted the other way round?",
          answer:
            "Those pairs tend to rise when investors are moving away from risk, because the " +
            "emerging-market currency is the one being sold. A strong day for them is therefore " +
            "read as a risk-off signal, so the rank is flipped before it counts toward the score.",
        },
        {
          question: "Should I trade based on this meter?",
          answer:
            "It is a description of the mood the market has shown, not a signal. Use it as " +
            "context alongside your own analysis and risk management, never as a reason to " +
            "open a trade on its own.",
        },
      ],
      // The basket is built only from instruments a shipped driver can
      // actually fill. It used to lead on SPX, NDX, WTI and XAU, none of
      // which AlphaVantage serves as bars, so four of its seven components
      // could never report and the meter silently ran on the other three.
      //
      // `direction` says which way a market moves when risk comes OFF, and a
      // `risk-off` component has its rank flipped before it counts. That is
      // why the two former havens here are stated as PAIRS rather than as
      // currencies: the yen strengthening on a risk-off day makes USD/JPY
      // FALL, so USD/JPY is not a market that rises when risk comes off. The
      // dollar against an emerging-market currency is.
      config: {
        components: [
          // Rises when risk is being taken on.
          { instrumentId: id("AUD/JPY"), weight: 3, direction: "risk-on" },
          { instrumentId: id("AUD/USD"), weight: 2, direction: "risk-on" },
          { instrumentId: id("NZD/USD"), weight: 2, direction: "risk-on" },
          { instrumentId: id("BTC/USD"), weight: 1, direction: "risk-on" },
          // Rises when risk is coming off.
          { instrumentId: id("USD/ZAR"), weight: 3, direction: "risk-off" },
          { instrumentId: id("USD/MXN"), weight: 2, direction: "risk-off" },
        ].filter((c) => c.instrumentId !== ""),
        lookbackDays: 60,
        riskOffBelow: 35,
        riskOnAbove: 65,
      },
    },
  ];

  for (const tool of TOOL_SEEDS) {
    const row = await db.tool.upsert({
      where: { key: tool.key },
      update: {},
      create: {
        key: tool.key,
        isEnabled: true,
        sortOrder: tool.sortOrder,
        config: tool.config as never,
        relatedCount: 6,
        showRelated: true,
      },
    });
    const highlights = TOOL_HIGHLIGHTS[tool.key] ?? [];
    await db.toolTranslation.upsert({
      where: { toolId_locale: { toolId: row.id, locale: "en" } },
      update: {},
      create: {
        toolId: row.id,
        locale: "en",
        title: tool.title,
        tagline: tool.tagline,
        intro: tool.intro,
        body: tool.body,
        highlights: highlights as never,
        ...(tool.faq ? { faq: tool.faq } : {}),
        ...(tool.seoFocusKeyword ? { seoFocusKeyword: tool.seoFocusKeyword } : {}),
        // The source locale is not a translation OF anything, so it is the
        // only one that is never OUTDATED. TRANSLATED is the settled state.
        translationStatus: "TRANSLATED",
        seoTitle: tool.title,
        seoDescription: tool.tagline,
      },
    });

    // The highlights BACKFILL (ADR-114), bounded the way ADR-108's migration
    // was: an existing row is filled only where the column is still NULL.
    //
    // NULL and `[]` are different facts here and the distinction is the whole
    // guard. NULL is "this row predates the band"; `[]` is "an admin deleted
    // every card", which is a decision, and a seed that overwrote it would
    // put four cards back on a page someone deliberately cleared. The
    // `update: {}` above is why this cannot just be another field up there.
    const stored = await db.toolTranslation.findUnique({
      where: { toolId_locale: { toolId: row.id, locale: "en" } },
      select: { id: true, highlights: true, faq: true },
    });
    if (stored && stored.highlights === null) {
      await db.toolTranslation.update({
        where: { id: stored.id },
        data: { highlights: highlights as never },
      });
    }
    // The FAQ backfill (2026-09-18), bounded the same way: eight tools shipped
    // with no FAQ, so an existing row is filled only while `faq` is still NULL.
    // `[]` is an admin's deliberate "no questions" and is left alone.
    if (stored && stored.faq === null && tool.faq) {
      await db.toolTranslation.update({
        where: { id: stored.id },
        data: { faq: tool.faq },
      });
    }
  }
  console.log(`  tools: ${TOOL_SEEDS.length} (all enabled)`);
  // Arabic (ADR-166): every tool page, highlights and FAQ included.
  console.log(`  arabic tools: ${await seedArabicTools(db)} created`);

  // ─────────────────────────────────────────────────────────────
  // AI platform (Module 18, ADR-097/098/099/100)
  // ─────────────────────────────────────────────────────────────
  //
  // A fresh clone gets a working AI screen, a usage dashboard that renders
  // with zero rows, and every feature visibly off. Nothing here can spend a
  // cent: `ai.enabled` is false, the default provider is ECHO, and the two
  // real providers arrive disabled with no key.

  const echoProvider = await db.aiProvider.upsert({
    where: { id: "echo" },
    update: {},
    create: {
      id: "echo",
      kind: "ECHO",
      label: "Echo (no provider)",
      isEnabled: true,
      isDefault: true,
    },
  });

  const anthropicProvider = await db.aiProvider.upsert({
    where: { id: "anthropic" },
    update: {},
    create: {
      id: "anthropic",
      kind: "ANTHROPIC",
      label: "Anthropic",
      isEnabled: false,
      isDefault: false,
    },
  });

  const openaiProvider = await db.aiProvider.upsert({
    where: { id: "openai" },
    update: {},
    create: {
      id: "openai",
      kind: "OPENAI",
      label: "OpenAI",
      isEnabled: false,
      isDefault: false,
    },
  });

  // Prices are DATA, not constants (ADR-100 #2): these are the published rates
  // on the seed date, and the models screen shows each row's "as of" so a
  // stale number is visible rather than assumed. A price correction is a form
  // edit, never a deploy — which is also the answer to model-id drift (R7).
  //
  // USD per 1M tokens. The three Anthropic rows are what the three tier
  // settings name, and `check:ai-model-tiers` fails the build if a seeded tier
  // names a model this list does not create.
  const AI_MODEL_SEEDS: Array<{
    providerId: string;
    modelId: string;
    label: string;
    input: number;
    output: number;
    cached: number | null;
    maxOutputTokens: number;
    vision: boolean;
    stream: boolean;
    sortOrder: number;
  }> = [
    {
      providerId: anthropicProvider.id,
      modelId: "claude-opus-5",
      label: "Claude Opus 5",
      input: 5,
      output: 25,
      cached: 0.5,
      maxOutputTokens: 64_000,
      vision: true,
      stream: true,
      sortOrder: 10,
    },
    {
      providerId: anthropicProvider.id,
      modelId: "claude-sonnet-5",
      label: "Claude Sonnet 5",
      input: 2,
      output: 10,
      cached: 0.2,
      maxOutputTokens: 64_000,
      vision: true,
      stream: true,
      sortOrder: 20,
    },
    {
      providerId: anthropicProvider.id,
      modelId: "claude-haiku-4-5",
      label: "Claude Haiku 4.5",
      input: 1,
      output: 5,
      cached: 0.1,
      maxOutputTokens: 8_192,
      vision: true,
      stream: true,
      sortOrder: 30,
    },
    // The OpenAI rows exist so the provider screen has something to show and
    // the driver has something to select. Their prices are the published rates
    // on the seed date and carry the same "as of" caption as every other row.
    {
      providerId: openaiProvider.id,
      modelId: "gpt-5.1",
      label: "GPT-5.1",
      input: 1.25,
      output: 10,
      cached: 0.125,
      maxOutputTokens: 32_000,
      vision: true,
      stream: true,
      sortOrder: 10,
    },
    {
      providerId: openaiProvider.id,
      modelId: "gpt-5.1-mini",
      label: "GPT-5.1 mini",
      input: 0.25,
      output: 2,
      cached: 0.025,
      maxOutputTokens: 32_000,
      vision: true,
      stream: true,
      sortOrder: 20,
    },
    // ECHO bills nothing, by construction. It still gets a row so that the
    // model resolver has something to land on before any key exists, and so
    // the pricing path is exercised end to end on a fresh install.
    {
      providerId: echoProvider.id,
      modelId: "echo",
      label: "Echo (placeholder output)",
      input: 0,
      output: 0,
      cached: 0,
      maxOutputTokens: 4_096,
      vision: true,
      stream: true,
      sortOrder: 10,
    },
  ];

  for (const model of AI_MODEL_SEEDS) {
    await db.aiModel.upsert({
      where: {
        providerId_modelId: { providerId: model.providerId, modelId: model.modelId },
      },
      update: {},
      create: {
        providerId: model.providerId,
        modelId: model.modelId,
        label: model.label,
        inputPricePerMTok: model.input,
        outputPricePerMTok: model.output,
        cachedInputPricePerMTok: model.cached,
        maxOutputTokens: model.maxOutputTokens,
        supportsVision: model.vision,
        supportsStream: model.stream,
        isEnabled: true,
        sortOrder: model.sortOrder,
      },
    });
  }

  // One row per AI_FEATURES key, all OFF and all with `modelId: null`, so every
  // feature resolves through its tier until an admin deliberately pins one.
  //
  // The list is literal rather than imported from @repo/contracts: `@repo/db`
  // declares no dependency on it, and adding one for a seed would put a new
  // edge in the graph to save six strings. `contracts/src/ai.test.ts` is what
  // keeps the two in step — it reads this file and fails on a key with no seed
  // row, or a seed row with no key.
  const AI_FEATURE_KEYS_SEED = [
    "writing_assistant",
    "seo_generation",
    "translation",
    "summarization",
    "alt_text",
    "quiz_generation",
    "form_fill",
    "writing_studio",
  ];

  for (const key of AI_FEATURE_KEYS_SEED) {
    await db.aiFeature.upsert({
      where: { key },
      update: {},
      create: { key, isEnabled: false },
    });
  }

  console.log(
    `  ai: ${AI_MODEL_SEEDS.length} models, ${AI_FEATURE_KEYS_SEED.length} features (all off), ECHO default`,
  );

  console.log("Done.");
}

// CLI entrypoint (`prisma db seed` / `pnpm db:seed`) — everything above this
// point is the reusable, injectable seed() function. Path-normalized (not a
// raw string compare) since import.meta.url and argv[1] use different
// separator/prefix conventions on Windows.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { config } = await import("dotenv");
  config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)) });

  const { db } = await import("../src/index.ts");
  seed(db)
    .catch((e: unknown) => {
      console.error("Seed failed:", e);
      process.exit(1);
    })
    .finally(() => db.$disconnect());
}
