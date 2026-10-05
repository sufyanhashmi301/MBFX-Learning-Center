// Email HTML is sanitised on SAVE and again on RENDER (ADR-078 #7,
// security.md #8). Two passes, because the two inputs are different: what an
// admin typed, and what variable substitution is about to be poured into.
//
// The allowlist is deliberately WIDER than `sanitizeRichText`'s — email is
// 1998 HTML, and a table layout with inline styles is the only thing that
// renders the same in Outlook and Gmail. It is wider in exactly two ways:
// presentational table attributes, and a `style` attribute with a property
// allowlist. It is not wider in any way that executes: no script, no iframe,
// no form, no object, and every `on*` handler is dropped by not being listed.
import sanitize from "sanitize-html";
import { repairTemplateTags, type EmailBodyMode } from "@repo/contracts";

/** Properties an inline `style` may carry. Layout and paint only. */
const STYLE_PROPERTIES = [
  "background",
  "background-color",
  "border",
  "border-bottom",
  "border-collapse",
  "border-color",
  "border-left",
  "border-radius",
  "border-right",
  "border-spacing",
  "border-style",
  "border-top",
  "border-width",
  "color",
  "direction",
  "display",
  "font",
  "font-family",
  "font-size",
  "font-style",
  "font-weight",
  "height",
  "letter-spacing",
  "line-height",
  "margin",
  "margin-bottom",
  "margin-left",
  "margin-right",
  "margin-top",
  "max-width",
  "min-width",
  "padding",
  "padding-bottom",
  "padding-left",
  "padding-right",
  "padding-top",
  "text-align",
  "text-decoration",
  "text-transform",
  "vertical-align",
  "white-space",
  "width",
  "word-break",
];

const BASE_TAGS = [
  "a",
  "b",
  "blockquote",
  "br",
  "center",
  "code",
  "div",
  "em",
  "figcaption",
  "figure",
  "h1",
  "h2",
  "h3",
  "h4",
  "hr",
  "i",
  "img",
  "li",
  "mark",
  "ol",
  "p",
  "pre",
  "small",
  "span",
  "strong",
  "s",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "u",
  "ul",
];

/** A full document is only meaningful in HTML mode. */
const DOCUMENT_TAGS = ["html", "head", "body", "title", "style"];

const STYLE_ALLOWLIST = Object.fromEntries(
  STYLE_PROPERTIES.map((property) => [property, [/.*/]]),
) as Record<string, RegExp[]>;

function options(mode: EmailBodyMode): sanitize.IOptions {
  const isDocument = mode === "HTML";
  return {
    allowedTags: isDocument ? [...BASE_TAGS, ...DOCUMENT_TAGS] : BASE_TAGS,
    allowedAttributes: {
      "*": ["style", "class", "align", "valign", "width", "height", "bgcolor", "dir", "lang"],
      a: ["href", "title", "target", "rel", "style", "class"],
      img: ["src", "alt", "title", "width", "height", "style", "class", "border"],
      table: ["border", "cellpadding", "cellspacing", "role", "style", "class", "width", "bgcolor"],
      td: ["colspan", "rowspan", "style", "class", "align", "valign", "width", "bgcolor"],
      th: ["colspan", "rowspan", "style", "class", "align", "valign", "width", "bgcolor"],
    },
    allowedStyles: { "*": STYLE_ALLOWLIST },
    // `{{reset.url}}` has no scheme, so it survives as a relative href and
    // becomes a real URL at substitution — which is validated there.
    allowedSchemes: ["http", "https", "mailto"],
    allowedSchemesAppliedToAttributes: ["href", "src"],
    // `style` keeps its CSS in HTML mode; script content never does. Media
    // queries are how a hand-built email stays readable on a phone, and the
    // only place this HTML is rendered inside our origin is the preview
    // route, which serves it under `Content-Security-Policy: sandbox` in a
    // `sandbox=""` iframe (ADR-078 #8).
    nonTextTags: isDocument ? ["script", "textarea", "option", "noscript"] : undefined,
    allowVulnerableTags: isDocument,
    // Anything not listed is dropped, contents kept — so an unknown wrapper
    // loses its tag rather than its text.
    disallowedTagsMode: "discard",
  };
}

export function sanitizeEmailHtml(html: string, mode: EmailBodyMode): string {
  // Repaired BEFORE sanitising, so what is stored is a clean `{{name}}` and
  // the auto-link the editor wrapped it in never reaches the database.
  return sanitize(repairTemplateTags(html), options(mode));
}

/**
 * The same allowlist, plus a transform. Used at render time to fold the
 * editor's `ed-*` classes into inline styles — a second sanitising pass that
 * happens to also rewrite attributes.
 */
export function sanitizeEmailHtmlWith(
  html: string,
  mode: EmailBodyMode,
  transformTags: sanitize.IOptions["transformTags"],
): string {
  return sanitize(html, { ...options(mode), transformTags });
}
