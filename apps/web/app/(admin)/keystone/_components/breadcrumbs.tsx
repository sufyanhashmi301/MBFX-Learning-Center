"use client";

// Path-derived admin breadcrumbs on `@repo/ui`'s Breadcrumb (changes-20
// Phase 5): the chevron separator, RTL mirroring and `aria-current` are the
// component's, so this file only decides LABELS.
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Fragment } from "react";
import { useTranslations } from "next-intl";
import { humanizeKey } from "@repo/utils";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@repo/ui/components/breadcrumb";

/** Catalog keys for the static admin segments; dynamic ids fall through. */
const SEGMENT_KEYS: Record<string, string> = {
  dashboard: "dashboard",
  users: "users",
  roles: "roles",
  employees: "employees",
  newsletter: "newsletter",
  glossary: "glossary",
  settings: "settings",
  features: "features",
  navigation: "navigation",
  social: "social",
  theme: "theme",
  profile: "profile",
  articles: "articles",
  categories: "articleCategories",
  tags: "articleTags",
  media: "websiteMedia",
  homepage: "homepage",
  learn: "navLearning",
  lessons: "learnLessons",
  quizzes: "learnQuizzes",
  progress: "learnProgress",
  videos: "learnVideos",
  "design-system": "designSystem.title",
};

/** Keys whose meaning depends on the parent segment. */
const NESTED_SEGMENT_KEYS: Record<string, Record<string, string>> = {
  learn: { courses: "learnCourses" },
  glossary: { topics: "glossaryTopics" },
  videos: { categories: "videoCategories" },
};

/**
 * Segments that group routes but have no page of their own. They render as
 * plain text: a crumb that links to them is a link to a 404. `/keystone/learn`
 * has no index (its sections are the sidebar's Learning group).
 */
const GROUP_SEGMENTS = new Set(["learn"]);

/**
 * The portal's root segment (ADR-151). It is never a crumb (changes-65): it
 * is the staff sign-in, not a place a staff member navigates back to, and
 * every page under it already sits in the portal. The trail starts at the
 * section, and its links still carry the full `/keystone/…` path.
 */
const ROOT_SEGMENT = "keystone";

/** A cuid/uuid-shaped segment: an id, not a word — never humanised. */
const ID_SEGMENT = /^[a-z0-9]{20,}$|^[0-9a-f-]{32,}$/i;

/** A dynamic id (a cuid) reads "Details": the record's real name is the
 * page's own h1, and a record id is exactly the raw identifier ADR-044 #5
 * keeps off the screen (it used to render as a truncated id). Any other
 * unmapped segment is a word, so it reads through humanizeKey. */
export function AdminBreadcrumbs() {
  const pathname = usePathname();
  const t = useTranslations("admin");
  const all = pathname.split("/").filter(Boolean);
  const base = all[0] === ROOT_SEGMENT ? 1 : 0;
  const segments = all.slice(base);

  const labelFor = (segment: string, parent: string | undefined) => {
    const key = (parent && NESTED_SEGMENT_KEYS[parent]?.[segment]) ?? SEGMENT_KEYS[segment];
    if (key && t.has(key)) return t(key);
    if (ID_SEGMENT.test(segment)) return t("breadcrumbDetail");
    return humanizeKey(decodeURIComponent(segment));
  };

  return (
    <Breadcrumb aria-label={t("breadcrumbLabel")}>
      <BreadcrumbList className="flex-nowrap overflow-x-auto whitespace-nowrap">
        {segments.map((segment, index) => {
          const href = `/${all.slice(0, base + index + 1).join("/")}`;
          const label = labelFor(segment, segments[index - 1]);
          return (
            <Fragment key={href}>
              {index > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem>
                {index === segments.length - 1 ? (
                  <BreadcrumbPage>{label}</BreadcrumbPage>
                ) : GROUP_SEGMENTS.has(segment) ? (
                  <span>{label}</span>
                ) : (
                  <BreadcrumbLink render={<Link href={href} />}>{label}</BreadcrumbLink>
                )}
              </BreadcrumbItem>
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
