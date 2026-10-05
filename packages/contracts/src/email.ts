// Email contracts (Module 17, ADR-078).
//
// Three rules live here rather than beside the service, so the admin form,
// the server action and the sender fail identically:
//
//   1. The template SET is code; only its CONTENT is data (ADR-078 #5). An
//      admin edits subject, body, sender and on/off — never the key, because
//      code decides when an email is sent.
//   2. A body may only use variables its template declares, and must use the
//      ones it requires. A reset mail without its link is a dead end, and it
//      fails on SAVE rather than on send.
//   3. A URL-typed variable is checked before substitution, so a value can
//      never smuggle `javascript:` into an href.
//
// No words live here. Variable descriptions and every message the admin reads
// come from the catalog (code-style #2); this file carries names, shapes and
// fixture values only.
import { z } from "zod";

const localeSchema = z.string().min(2).max(10);

export const EMAIL_AUDIENCES = ["public", "staff", "any"] as const;
export type EmailAudience = (typeof EMAIL_AUDIENCES)[number];

export const EMAIL_BODY_MODES = ["RICH", "HTML"] as const;
export type EmailBodyMode = (typeof EMAIL_BODY_MODES)[number];

export const EMAIL_DRIVERS = ["SMTP", "SENDGRID", "LOG"] as const;
export const SMTP_SECURITIES = ["NONE", "STARTTLS", "TLS"] as const;

/** Available to every template, whatever its key. */
export const GLOBAL_EMAIL_VARIABLES = [
  "site.name",
  "site.url",
  "logo.url",
  "year",
  "recipient.name",
  "recipient.email",
] as const;

/**
 * Variables whose value must parse as an http(s) URL before it is substituted.
 * The sanitiser cannot help here: `{{reset.url}}` is a harmless relative href
 * until the moment it becomes a value.
 */
export const URL_EMAIL_VARIABLES = [
  "site.url",
  "logo.url",
  "reset.url",
  "verify.url",
  "confirm.url",
  "unsubscribe.url",
  // ADR-171: the announcement's destination and its cover. A cover is an
  // `<img src>`, which the sanitiser saw as a relative path exactly as it saw
  // an href, so it is validated here like one.
  "course.url",
  "course.coverUrl",
] as const;

export interface EmailTemplateDefinition {
  /** Which catalogue the copy belongs to (ADR-043): staff mail is English. */
  audience: EmailAudience;
  /** Switching it off breaks a flow people depend on; the UI confirms first. */
  critical: boolean;
  /** Beyond GLOBAL_EMAIL_VARIABLES. */
  variables: readonly string[];
  /** Must appear in the subject or body, or the save is refused. */
  required: readonly string[];
  /** Fixture values for preview and test sends — data, not interface copy. */
  sample: Readonly<Record<string, string>>;
}

const SAMPLE_BASE = {
  "site.name": "MBX Learning Center",
  "site.url": "https://example.com",
  "logo.url": "https://example.com/logo.png",
  year: "2026",
  "recipient.name": "Alex Morgan",
  "recipient.email": "alex@example.com",
} as const;

/**
 * Every email this product can send. Adding one means an entry here, a seed
 * row, a sample and a test — `email-registry.test.ts` names any half you
 * forget.
 */
export const EMAIL_TEMPLATES = {
  // changes-61: the welcome a new learner receives when their account is
  // created. Globals only — the button goes to `{{site.url}}` — so nothing a
  // caller passes can be wrong. Not `critical`: switching it off loses a
  // greeting, not a flow.
  "auth.welcome": {
    audience: "public",
    critical: false,
    variables: [],
    required: [],
    sample: { ...SAMPLE_BASE },
  },
  // changes-61, ADR-184: sign-up verification by a six-digit CODE. The link
  // (`auth.verify_email`) stays for confirming a NEW address after a change,
  // where there is no account at that address yet for a code to verify.
  "auth.verify_code": {
    audience: "public",
    critical: true,
    variables: ["verify.code", "expires.minutes"],
    required: ["verify.code"],
    sample: { ...SAMPLE_BASE, "verify.code": "482913", "expires.minutes": "10" },
  },
  "auth.password_reset": {
    audience: "any",
    critical: true,
    variables: ["reset.url", "expires.minutes"],
    required: ["reset.url"],
    sample: {
      ...SAMPLE_BASE,
      "reset.url": "https://example.com/reset-password?token=sample",
      "expires.minutes": "30",
    },
  },
  "auth.verify_email": {
    audience: "public",
    critical: true,
    variables: ["verify.url"],
    required: ["verify.url"],
    sample: {
      ...SAMPLE_BASE,
      "verify.url": "https://example.com/api/auth/verify-email?token=sample",
    },
  },
  "auth.password_changed": {
    audience: "any",
    critical: false,
    variables: ["changed.at"],
    required: [],
    sample: { ...SAMPLE_BASE, "changed.at": "12 September 2026, 14:05 UTC" },
  },
  // ADR-155 #2: sent to the PREVIOUS address once a change has landed, and it
  // names the new one, so an owner whose account was taken sees where it went.
  "auth.email_changed": {
    audience: "any",
    critical: false,
    variables: ["changed.at", "email.new"],
    required: [],
    sample: {
      ...SAMPLE_BASE,
      "changed.at": "22 September 2026, 14:05 UTC",
      "email.new": "new-address@example.com",
    },
  },
  "newsletter.confirm": {
    audience: "public",
    critical: true,
    variables: ["confirm.url"],
    required: ["confirm.url"],
    sample: {
      ...SAMPLE_BASE,
      "confirm.url": "https://example.com/newsletter/confirm?token=sample",
    },
  },
  "newsletter.welcome": {
    audience: "public",
    critical: false,
    variables: ["unsubscribe.url"],
    required: ["unsubscribe.url"],
    sample: {
      ...SAMPLE_BASE,
      "unsubscribe.url": "https://example.com/newsletter/unsubscribe?token=sample",
    },
  },
  // The one template whose recipient is US (ADR-113). `audience: "staff"`
  // rather than "public" for exactly that reason — it is read by whoever
  // watches the support inbox, so ADR-043 #2 applies and English is enough.
  //
  // `{{recipient.*}}` is the support inbox, not the visitor: the globals are
  // filled from the `to` address. The visitor's own name and address arrive
  // as `contact.*`, which is also what makes them safe — every variable is
  // escaped at substitution time (`render.ts`), so a message containing
  // markup reaches the inbox as text.
  //
  // `contact.locale` is the locale the VISITOR was reading, printed in the
  // body rather than used to pick a translation: the template renders in
  // English because a staff member reads it (ADR-043 #2), and the code is
  // there so support knows which language to reply in.
  //
  // Only `contact.message` is required. A support mail that lost the words is
  // useless; one that lost the subject line is merely untidy, and refusing to
  // SAVE a template over that would be the wrong trade.
  "support.request": {
    audience: "staff",
    critical: false,
    variables: [
      "contact.name",
      "contact.email",
      "contact.subject",
      "contact.message",
      "contact.locale",
    ],
    required: ["contact.message"],
    sample: {
      ...SAMPLE_BASE,
      "recipient.name": "Support",
      "recipient.email": "support@example.com",
      "contact.name": "Alex Morgan",
      "contact.email": "alex@example.com",
      "contact.subject": "I cannot sign in",
      "contact.message":
        "The reset link in your email says it has expired, but I only asked for it a minute ago.",
      "contact.locale": "en",
    },
  },
  // ADR-171 #8 — a new course, announced to a chosen audience. Public, so it
  // is translated per active locale (ADR-043). Not `critical`: switching it
  // off stops announcements, which is a choice, not a broken flow.
  //
  // Every variable ALWAYS has a value, because the template language has no
  // conditionals (ADR-078 #6): a coverless course gets its track's raster
  // panel, and an absent note is the empty string.
  "announcement.course": {
    audience: "public",
    critical: false,
    variables: [
      "course.title",
      "course.summary",
      "course.level",
      "course.lessonCount",
      "course.url",
      "course.coverUrl",
      "campaign.message",
      "unsubscribe.url",
    ],
    required: ["course.url", "unsubscribe.url"],
    sample: {
      ...SAMPLE_BASE,
      "course.title": "Forex Basics",
      "course.summary":
        "How a currency pair is quoted, what moves it, and how to read a price chart.",
      "course.level": "Beginner",
      "course.lessonCount": "12",
      "course.url": "https://example.com/learn/forex/forex-basics",
      "course.coverUrl": "https://example.com/email/track-forex.png",
      "campaign.message": "Our most requested course is here.",
      "unsubscribe.url": "https://example.com/email/unsubscribe?t=sample",
    },
  },
} as const satisfies Record<string, EmailTemplateDefinition>;

export type EmailTemplateKey = keyof typeof EMAIL_TEMPLATES;

export const EMAIL_TEMPLATE_KEYS = Object.keys(EMAIL_TEMPLATES) as EmailTemplateKey[];

export function isEmailTemplateKey(value: string): value is EmailTemplateKey {
  return Object.prototype.hasOwnProperty.call(EMAIL_TEMPLATES, value);
}

/** Everything a template may use: its own variables plus the global set. */
export function emailTemplateVariables(key: EmailTemplateKey): string[] {
  return [...GLOBAL_EMAIL_VARIABLES, ...EMAIL_TEMPLATES[key].variables];
}

const EVERY_EMAIL_VARIABLE: ReadonlySet<string> = new Set<string>([
  ...GLOBAL_EMAIL_VARIABLES,
  ...Object.values(EMAIL_TEMPLATES).flatMap((definition) => definition.variables),
]);

/**
 * Whether a word is one of the email placeholders. The editor asks before it
 * auto-links: `recipient.name` and `contact.email` end in real top-level
 * domains, and a link wrapped round a placeholder stops it being one.
 */
export function isEmailVariableName(text: string): boolean {
  return EVERY_EMAIL_VARIABLE.has(text.trim());
}

export function isUrlEmailVariable(name: string): boolean {
  return (URL_EMAIL_VARIABLES as readonly string[]).includes(name);
}

// `{{ name }}`: letters, then word characters and dots. Deliberately no
// spaces, pipes or arguments — a template language with logic is a template
// language someone can put behaviour in (ADR-078 #6).
const VARIABLE_PATTERN = /\{\{\s*([A-Za-z][\w.]*)\s*\}\}/g;

// `{{` … `}}` with only text and tags between them. The two alternatives
// start on disjoint characters, so the lazy scan cannot backtrack badly.
const MARKED_UP_VARIABLE = /\{\{((?:[^{}<]|<[^>]*>)*?)\}\}/g;
const VARIABLE_NAME = /^\s*[A-Za-z][\w.]*\s*$/;

/**
 * Pull markup back out of a `{{variable}}` the editor split apart.
 *
 * The rich-text editor auto-links `recipient.name` (`.name` and `.email` are
 * real top-level domains) and a bold toggled mid-tag splits it across marks,
 * so a stored body read `{{</strong><a href="http://recipient.name"><strong>
 * recipient.name</strong></a><strong>}}` — which neither the save-time check
 * nor the render's substitution recognised, and the reader got the braces.
 *
 * The variable's text moves to the front and every tag is kept in its order
 * after it, so the element tree is unchanged (an element that held only the
 * name is left empty). The one exception is a link opened inside the braces:
 * it is the auto-link, and it is dropped with a matching close. Anything that
 * is not a bare name between the braces is left exactly as written.
 */
export function repairTemplateTags(html: string): string {
  if (!html.includes("{{")) return html;
  return html.replace(MARKED_UP_VARIABLE, (match, inner: string) => {
    if (!inner.includes("<")) return match;
    const tags = inner.match(/<[^>]*>/g) ?? [];
    const text = inner.replace(/<[^>]*>/g, "");
    if (!VARIABLE_NAME.test(text)) return match;
    let openLinks = 0;
    const kept = tags.filter((tag) => {
      if (/^<a\b/i.test(tag)) {
        openLinks += 1;
        return false;
      }
      if (/^<\/a\s*>$/i.test(tag) && openLinks > 0) {
        openLinks -= 1;
        return false;
      }
      return true;
    });
    return `{{${text.trim()}}}${kept.join("")}`;
  });
}

/** Every variable a string references, in first-seen order, without repeats. */
export function findTemplateVariables(text: string): string[] {
  const found = new Set<string>();
  for (const match of repairTemplateTags(text).matchAll(VARIABLE_PATTERN)) {
    const name = match[1];
    if (name) found.add(name);
  }
  return [...found];
}

export const emailTemplateSaveSchema = z
  .object({
    key: z.string().refine(isEmailTemplateKey),
    locale: localeSchema,
    // CR/LF in a header is the classic injection: one newline and the rest of
    // the subject becomes a Bcc.
    subject: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .refine((value) => !/[\r\n]/.test(value)),
    preheader: z
      .string()
      .trim()
      .max(200)
      .refine((value) => !/[\r\n]/.test(value))
      .optional(),
    mode: z.enum(EMAIL_BODY_MODES),
    bodyHtml: z.string().trim().min(1).max(200_000),
    fromName: z.string().trim().max(120).optional(),
    fromEmail: z.email().max(255).optional().or(z.literal("")),
    replyTo: z.email().max(255).optional().or(z.literal("")),
  })
  .superRefine((value, ctx) => {
    if (!isEmailTemplateKey(value.key)) return;
    const allowed = new Set(emailTemplateVariables(value.key));
    const used = findTemplateVariables(`${value.subject} ${value.bodyHtml}`);

    for (const name of used) {
      if (!allowed.has(name)) {
        // A typo'd variable renders as literal braces in someone's inbox.
        ctx.addIssue({ code: "custom", path: ["bodyHtml"], params: { variable: name } });
      }
    }

    for (const name of EMAIL_TEMPLATES[value.key].required) {
      if (!used.includes(name)) {
        ctx.addIssue({ code: "custom", path: ["bodyHtml"], params: { missing: name } });
      }
    }
  });

export type EmailTemplateSaveInput = z.infer<typeof emailTemplateSaveSchema>;

export const emailTransportSaveSchema = z
  .object({
    driver: z.enum(EMAIL_DRIVERS),
    host: z.string().trim().max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    security: z.enum(SMTP_SECURITIES),
    username: z.string().trim().max(255).optional(),
    // Empty means KEEP the stored password: the field is write-only, so the
    // form cannot round-trip the current value back to us (ADR-078 #3).
    password: z.string().max(255).optional(),
    // ADR-152: read by the SENDGRID driver only; stored as given either way.
    sandboxMode: z.boolean().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.driver !== "SMTP") return;
    if (!value.host) ctx.addIssue({ code: "custom", path: ["host"] });
    if (!value.port) ctx.addIssue({ code: "custom", path: ["port"] });
  });

export type EmailTransportSaveInput = z.infer<typeof emailTransportSaveSchema>;

/**
 * What a pasted SendGrid key becomes before it is sealed.
 *
 * SendGrid issues a key with no whitespace in it, and a paste picks up what
 * surrounds it: the word `Bearer` copied out of a curl example, a line break
 * from a wrapped column, a trailing tab. SendGrid answers a request whose
 * Bearer token holds a space with **`400 authorization required`** — the same
 * status and wording it uses for no token at all — which names neither the
 * field nor the character, and reads as "my key is rejected" rather than "my
 * key has a space in it". An invalid-but-clean key says `401 unauthorized`,
 * which is the honest answer we want a wrong key to get.
 *
 * So the artifacts are removed rather than refused: there is one thing a
 * person means by pasting `Bearer SG.xyz` into a field labelled "SendGrid API
 * key". What survives normalisation is either the key or plainly the wrong
 * key, and the wrong key now gets told so.
 */
export function normalizeSendgridApiKey(raw: string): string {
  // Order matters: strip the prefix first, or removing whitespace would weld
  // it onto the key as `BearerSG.xyz`.
  return raw.replace(/^\s*bearer\s+/i, "").replace(/\s+/gu, "");
}

export const emailTestSendSchema = z.object({
  key: z.string().refine(isEmailTemplateKey),
  locale: localeSchema,
  to: z.email().max(255),
});

export type EmailTestSendInput = z.infer<typeof emailTestSendSchema>;

/**
 * Substitute every `{{variable}}`, using the SAME pattern
 * `findTemplateVariables` reads with — so what a save validates and what a
 * render replaces can never drift apart.
 */
export function replaceTemplateVariables(text: string, resolve: (name: string) => string): string {
  return repairTemplateTags(text).replace(VARIABLE_PATTERN, (_match, name: string) =>
    resolve(name),
  );
}

export const EMAIL_DELIVERY_STATUSES = ["SENT", "FAILED", "SUPPRESSED"] as const;
export type EmailDeliveryStatus = (typeof EMAIL_DELIVERY_STATUSES)[number];

export const emailTemplateActiveSchema = z.object({
  key: z.string().refine(isEmailTemplateKey),
  isActive: z.boolean(),
});

export const emailTemplateResetSchema = z.object({
  key: z.string().refine(isEmailTemplateKey),
  locale: localeSchema,
});

/**
 * The delivery log's filters. `limit` clamps here rather than in the service,
 * the ADR-067 shape: there is no way to ask this for the whole table, and the
 * rows are PII the retention sweep is already counting down on.
 */
export const emailDeliveryFilterSchema = z.object({
  status: z.enum(EMAIL_DELIVERY_STATUSES).optional(),
  templateKey: z.string().refine(isEmailTemplateKey).optional(),
  /** Matches the recipient address. */
  q: z.string().trim().max(255).optional(),
  isTest: z.boolean().optional(),
  /** One announcement's sends (ADR-171): the detail page links here with it. */
  campaignId: z.string().min(1).max(191).optional(),
  cursor: z.string().max(256).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type EmailDeliveryFilter = z.infer<typeof emailDeliveryFilterSchema>;

/**
 * What the isolated preview route accepts (ADR-078 #8). A DRAFT body, so the
 * editor can render what is on screen rather than what was last saved — which
 * is also why this is a POST with no side effect, and why it is parsed with the
 * same variable rules the save uses.
 */
/** The palette a PREVIEW renders in (ADR-179 #5); a send is always light. */
export const EMAIL_PREVIEW_SCHEMES = ["light", "dark"] as const;
export const emailPreviewSchemeSchema = z.enum(EMAIL_PREVIEW_SCHEMES);
export type EmailPreviewScheme = z.infer<typeof emailPreviewSchemeSchema>;

export const emailPreviewSchema = z.object({
  key: z.string().refine(isEmailTemplateKey),
  scheme: emailPreviewSchemeSchema.optional(),
  locale: localeSchema,
  subject: z.string().max(200).optional(),
  preheader: z.string().max(200).optional(),
  mode: z.enum(EMAIL_BODY_MODES).optional(),
  bodyHtml: z.string().max(200_000).optional(),
});

export type EmailPreviewInput = z.infer<typeof emailPreviewSchema>;
