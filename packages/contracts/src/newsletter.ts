// Newsletter contracts (Module 17, ADR-080, changes-21 F7).
//
// Signup is the ONE anonymous public mutation in this repo (ADR-080 #3).
// There is no subject, so `requirePermission()` cannot apply — security.md #1
// assumes one — and its place is taken by a stack that must be present in
// full: the `newsletter` flag, THIS schema, a honeypot field, a per-IP limit
// and a per-email limit. That makes this file load-bearing in a way the other
// contract modules are not: it is the only validation between an unknown
// caller and a write.
//
// No words live here (code-style #2). The admin's filter labels and every
// message a visitor reads come from the catalog.
import { z } from "zod";
import { NEWSLETTER_HONEYPOT_FIELD } from "./newsletter-honeypot.ts";

/**
 * Where the public FORM is drawn. A closed set rather than free text because
 * the four values ARE the four placement settings (ADR-080 #5) — a fifth
 * placement is a code change that lands here, its setting key and its render
 * site together. The anonymous form may only ever claim one of these.
 */
export const NEWSLETTER_PLACEMENTS = ["footer", "home", "news", "analysis"] as const;
export type NewsletterPlacement = (typeof NEWSLETTER_PLACEMENTS)[number];

/**
 * Where an address came from: a placement, the sign-up checkbox, or an
 * administrator (ADR-124). Wider than the placements on purpose — `signup`
 * and `admin` have no setting and no form, so nothing that takes a placement
 * may accept them, while the admin screen filters on all six.
 */
export const NEWSLETTER_SOURCES = [...NEWSLETTER_PLACEMENTS, "signup", "admin"] as const;
export type NewsletterSource = (typeof NEWSLETTER_SOURCES)[number];

export const SUBSCRIBER_STATUSES = ["PENDING", "ACTIVE", "UNSUBSCRIBED"] as const;
export type SubscriberStatusValue = (typeof SUBSCRIBER_STATUSES)[number];

/**
 * What the public form submits.
 *
 * `email` is lower-cased HERE rather than in the service, so the unique
 * constraint and the per-email rate-limit bucket see the same string — an
 * address normalised in only one of those two places gives a caller two
 * budgets for one mailbox.
 */
export const newsletterSubscribeSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  locale: z.string().min(2).max(10),
  source: z.enum(NEWSLETTER_PLACEMENTS),
  /** Absent or empty for a human. Any value refuses the write. */
  [NEWSLETTER_HONEYPOT_FIELD]: z.string().max(255).optional(),
});

export type NewsletterSubscribeInput = z.infer<typeof newsletterSubscribeSchema>;

/**
 * A confirm or unsubscribe token as it arrives from a URL.
 *
 * 64 hex characters: `randomBytes(32).toString("hex")`. Bounded and
 * character-classed so a token is rejected before it reaches a `findUnique`,
 * which keeps an oversized query string out of the database entirely.
 */
export const newsletterTokenSchema = z.string().regex(/^[0-9a-f]{64}$/);

export const newsletterConfirmSchema = z.object({ token: newsletterTokenSchema });
export const newsletterUnsubscribeSchema = z.object({ token: newsletterTokenSchema });

/**
 * The admin list's filters. `limit` clamps here, the ADR-067 shape shared with
 * the media library and the delivery log: there is no way to ask this for the
 * whole table, and every row is an email address.
 */
export const subscriberFilterSchema = z.object({
  status: z.enum(SUBSCRIBER_STATUSES).optional(),
  source: z.enum(NEWSLETTER_SOURCES).optional(),
  /** Matches the address. */
  q: z.string().trim().max(255).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type SubscriberFilter = z.infer<typeof subscriberFilterSchema>;

/**
 * The CSV export's filters — the list's, without paging. A cursor would make
 * an export of "everything that matches" depend on where a reader had
 * scrolled to.
 */
export const subscriberExportSchema = subscriberFilterSchema.omit({
  cursor: true,
  limit: true,
});

export type SubscriberExportFilter = z.infer<typeof subscriberExportSchema>;

/** A row action on the admin screen. */
export const subscriberIdSchema = z.object({ id: z.string().min(1).max(64) });

/**
 * The sign-up checkbox's opt-in (ADR-124). No address and no user id: the
 * only address this can subscribe is the one on the SESSION, so there is
 * nothing here a caller could point at somebody else's mailbox.
 */
export const newsletterAccountOptInSchema = z.object({
  locale: z.string().min(2).max(10),
});

export type NewsletterAccountOptInInput = z.infer<typeof newsletterAccountOptInSchema>;

/**
 * "Add subscriber" on the admin screen (ADR-124). The address is lower-cased
 * here for the reason `newsletterSubscribeSchema` gives: the unique
 * constraint must see the string the admin typed the way the form would have
 * sent it. The locale decides which language the confirmation email is in.
 */
export const adminAddSubscriberSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email().max(255)),
  locale: z.string().min(2).max(10),
});

export type AdminAddSubscriberInput = z.infer<typeof adminAddSubscriberSchema>;
