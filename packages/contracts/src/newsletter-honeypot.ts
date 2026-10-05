// Split from newsletter.ts (changes-62 #2). ZOD-FREE ON PURPOSE: the signup
// form is on every public page (the footer), and newsletter.ts builds schemas
// at load time, which drags all of Zod into the bundle.

/**
 * The honeypot field's name. A real visitor never sees it, so a filled value
 * is a bot; the name is deliberately plausible ("website" is what a
 * comment-spam bot expects to find) rather than `honeypot`.
 *
 * Exported so the form and the action cannot disagree about which field to
 * check — the failure mode of a hard-coded string on both sides is a honeypot
 * that silently stops working.
 */
export const NEWSLETTER_HONEYPOT_FIELD = "website";
