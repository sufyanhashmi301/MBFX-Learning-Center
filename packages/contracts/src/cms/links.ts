// LinkTarget (ADR-031 §1) — every authored link in a block, a MenuItem, a
// CardTemplate or a StylePreset is one of these, resolved at render by the
// one resolver `@repo/core/src/cms/links.ts` shares with `buildNavigation`.
// Internal links are never free text: an internal-looking path typed as a
// `URL` is refused here, at the schema, not caught later by a linter.
import { z } from "zod";
import { isRouteKey } from "../routes.ts";

const ABSOLUTE_URL_PATTERN = /^(https?:)\/\//i;
const SPECIAL_SCHEME_PATTERN = /^(mailto|tel):/i;

/**
 * Absolute `http(s)://…`, `mailto:`/`tel:`, or protocol-relative `//…` — a
 * root-relative path (`/about`) is rejected: that is an internal link, and
 * internal links use `PAGE`/`ROUTE`/etc., never `URL` (ADR-031 §1).
 */
const externalUrlSchema = z
  .string()
  .trim()
  .min(1)
  .max(2000)
  .refine(
    (v) => ABSOLUTE_URL_PATTERN.test(v) || SPECIAL_SCHEME_PATTERN.test(v) || v.startsWith("//"),
    {
      message:
        "A URL link must be absolute (https://…) or mailto:/tel: — link to the page instead.",
    },
  );

const urlTargetSchema = z.object({
  type: z.literal("URL"),
  url: externalUrlSchema,
  newTab: z.boolean().optional(),
  rel: z.enum(["nofollow", "sponsored"]).optional(),
});

const routeTargetSchema = z.object({
  type: z.literal("ROUTE"),
  routeKey: z.string().trim().min(1).refine(isRouteKey, {
    message: "routeKey must exist in the ROUTE_PATHS registry",
  }),
});

const pageTargetSchema = z.object({
  type: z.literal("PAGE"),
  pageId: z.string().trim().min(1),
  anchor: z.string().trim().max(150).optional(),
});

/** Entity targets resolved through their owning content-type provider (ADR-022), so the provider's own visibility rule applies at resolve time. */
const entityTargetSchema = z.object({
  type: z.enum(["ARTICLE", "ARTICLE_CATEGORY", "ARTICLE_TAG", "COURSE", "GLOSSARY_TERM"]),
  targetId: z.string().trim().min(1),
});

const mediaTargetSchema = z.object({
  type: z.literal("MEDIA"),
  assetId: z.string().trim().min(1),
});

const anchorTargetSchema = z.object({
  type: z.literal("ANCHOR"),
  anchor: z.string().trim().min(1).max(150),
});

const noneTargetSchema = z.object({
  type: z.literal("NONE"),
});

export const linkTargetSchema = z.discriminatedUnion("type", [
  urlTargetSchema,
  routeTargetSchema,
  pageTargetSchema,
  entityTargetSchema,
  mediaTargetSchema,
  anchorTargetSchema,
  noneTargetSchema,
]);
export type LinkTarget = z.infer<typeof linkTargetSchema>;

/** What a resolved link renders as (ADR-031 §2/§4) — never a raw string, so a caller can always distinguish a real absence of a link versus a target that failed to resolve. */
export const linkStateSchema = z.enum(["ok", "missing", "unpublished", "forbidden"]);
export type LinkState = z.infer<typeof linkStateSchema>;

export interface ResolvedLink {
  href: string | null;
  label?: string;
  state: LinkState;
  download?: boolean;
}
