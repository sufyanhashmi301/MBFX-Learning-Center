// The email shell, and the reason it exists: an email client drops class CSS,
// so every rule the editor expressed as a class has to become a `style`
// attribute before the message leaves (ADR-078 #7).
//
// Colours are the ACTIVE theme's values, loaded through
// `loadActiveThemeTokens` — a re-brand reaches email without anyone editing a
// template, and there is no hex literal in this package (code-style #1).
import {
  contrastRatio,
  deriveInteractive,
  deriveTonalInk,
  type BrandColors,
  type SurfacePalette,
} from "@repo/theme";
import { sanitizeEmailHtmlWith } from "./sanitize.ts";

export interface EmailPalette {
  brand: BrandColors;
  surface: SurfacePalette;
  /**
   * The surfaces the brand BANDS derive their inks from. The light set in
   * every scheme, so header and footer read identically in a light and a dark
   * preview and only the card between them changes. Absent ⇒ `surface`.
   */
  band?: SurfacePalette | undefined;
  /** A real family list — an email client cannot fetch a web font. */
  fontFamily: string;
}

/** A labelled link in the footer band ("Contact support"). */
export interface EmailShellLink {
  url: string;
  label: string;
}

/** A "Label: value" pair in the footer band ("Email: info@…"). */
export interface EmailShellContact {
  label: string;
  value: string;
  url: string;
}

export interface EmailShellInput {
  bodyHtml: string;
  palette: EmailPalette;
  preheader?: string | undefined;
  logoUrl?: string | undefined;
  siteName: string;
  /** The site's home page in the reader's language; the footer's name links to it. */
  homeUrl?: string | undefined;
  /** Printed under the site name in the footer band (ADR-179). */
  tagline?: string | undefined;
  /** Log in · Contact support · Privacy policy — whichever resolve. */
  links?: readonly EmailShellLink[] | undefined;
  /** Email · Website. */
  contacts?: readonly EmailShellContact[] | undefined;
  /** Copyright and "sent to", already in the reader's language. */
  legalLines?: readonly string[] | undefined;
  footerText?: string | undefined;
  postalAddress?: string | undefined;
  /** URL and label together: a package may not invent the word for it. */
  unsubscribe?: { url: string; label: string } | undefined;
  /**
   * The sentence the unsubscribe link sits in, with `{link}` where the link
   * goes ("If you no longer wish to receive these emails, {link}."). Absent ⇒
   * the link stands alone.
   */
  unsubscribeLine?: string | undefined;
}

/**
 * The tones a badge may take (changes-61): the editor's own tone names, each
 * resolved to a brand colour. `muted` is a surface, not a hue.
 */
export const EMAIL_BADGE_TONES = [
  "primary",
  "success",
  "warning",
  "info",
  "danger",
  "muted",
] as const;

/** Whichever of the two surface texts reads better on `ground`. */
function inkOn(ground: string, surface: SurfacePalette): string {
  return contrastRatio(surface.background, ground) >= contrastRatio(surface.textPrimary, ground)
    ? surface.background
    : surface.textPrimary;
}

function toneColour(tone: string, palette: EmailPalette): string | null {
  const { brand, surface } = palette;
  switch (tone) {
    case "primary":
      return brand.primary;
    case "success":
      return brand.success;
    case "warning":
      return brand.warning;
    case "info":
      return brand.info;
    case "danger":
      return brand.error;
    case "muted":
      return surface.surfaceMuted;
    default:
      return null;
  }
}

/**
 * The email BLOCK vocabulary (changes-61, ADR-184): a button, a panel, a
 * verification code, an eyebrow, a headline and a badge. Like every other
 * `ed-*` class these carry no colour of their own — each resolves against the
 * active theme here, so a re-brand restyles every template at once — and the
 * ink on a filled ground is whichever surface text reads on it, the rule the
 * brand bands already follow.
 */
function blockStyle(className: string, palette: EmailPalette): string | null {
  const { brand, surface } = palette;
  switch (className) {
    // A link drawn as a button. Padding on an inline-block `<a>` is the
    // widely supported form; Outlook's Word engine drops the padding and
    // keeps a coloured, bold link, which still reads as the action.
    case "ed-btn":
      return `display:inline-block;background-color:${brand.primary};color:${inkOn(brand.primary, surface)};padding:12px 28px;border-radius:8px;font-size:16px;line-height:20px;font-weight:700;text-decoration:none`;
    case "ed-btn-secondary":
      return `display:inline-block;background-color:${brand.secondary};color:${inkOn(brand.secondary, surface)};padding:12px 28px;border-radius:8px;font-size:16px;line-height:20px;font-weight:700;text-decoration:none`;
    // A tinted box: a code, an offer, the facts of a change.
    case "ed-panel":
      return `background-color:${surface.surfaceMuted};border:1px solid ${surface.borderLight};border-radius:8px;padding:20px 24px`;
    case "ed-code":
      return `font-family:Consolas,'Courier New',monospace;font-size:32px;line-height:40px;letter-spacing:8px;font-weight:700;color:${surface.textPrimary};margin:8px 0`;
    case "ed-eyebrow":
      return `font-size:12px;line-height:16px;letter-spacing:1.5px;text-transform:uppercase;font-weight:700;color:${deriveTonalInk(brand.primary, surface.background)}`;
    case "ed-title":
      return `font-size:26px;line-height:32px;font-weight:800;color:${surface.textPrimary};margin:4px 0 16px`;
    default:
      break;
  }
  if (className.startsWith("ed-badge-")) {
    const ground = toneColour(className.slice("ed-badge-".length), palette);
    if (!ground) return null;
    return `display:inline-block;background-color:${ground};color:${inkOn(ground, surface)};padding:4px 12px;border-radius:999px;font-size:13px;line-height:18px;font-weight:700`;
  }
  return null;
}

/** The `ed-*` vocabulary, as inline styles. */
export function editorialStyle(className: string, palette: EmailPalette): string | null {
  const block = blockStyle(className, palette);
  if (block) return block;
  const { brand, surface } = palette;
  switch (className) {
    case "ed-tx-primary":
      return `color:${brand.primary}`;
    case "ed-tx-success":
      return `color:${brand.success}`;
    case "ed-tx-warning":
      return `color:${brand.warning}`;
    case "ed-tx-info":
      return `color:${brand.info}`;
    case "ed-tx-danger":
      return `color:${brand.error}`;
    case "ed-tx-muted":
      return `color:${surface.textMuted}`;
    // A highlight needs padding, or the colour stops at the glyphs.
    case "ed-hl-primary":
      return `background-color:${brand.primary};color:${surface.background};padding:0 4px`;
    case "ed-hl-success":
      return `background-color:${brand.success};color:${surface.background};padding:0 4px`;
    case "ed-hl-warning":
      return `background-color:${brand.warning};color:${surface.background};padding:0 4px`;
    case "ed-hl-info":
      return `background-color:${brand.info};color:${surface.background};padding:0 4px`;
    case "ed-hl-danger":
      return `background-color:${brand.error};color:${surface.background};padding:0 4px`;
    case "ed-hl-muted":
      return `background-color:${surface.surfaceMuted};color:${surface.textPrimary};padding:0 4px`;
    // `ed-ff-sans` is the pre-2026-09-18 name of `ed-ff-body`; stored bodies
    // still carry it, so both map to the message's family.
    case "ed-ff-sans":
    case "ed-ff-body":
      return `font-family:${palette.fontFamily}`;
    // The site's display face is a web font no mail client can fetch, so it
    // falls back to the message's own family rather than to Times.
    case "ed-ff-display":
      return `font-family:${palette.fontFamily}`;
    case "ed-ff-serif":
      return "font-family:Georgia,'Times New Roman',serif";
    case "ed-ff-mono":
      return "font-family:Consolas,'Courier New',monospace";
    case "ed-fs-sm":
      return "font-size:14px";
    case "ed-fs-base":
      return "font-size:16px";
    case "ed-fs-lg":
      return "font-size:18px";
    case "ed-fs-xl":
      return "font-size:20px";
    case "ed-fs-2xl":
      return "font-size:24px";
    case "ed-align-start":
      return "text-align:left";
    case "ed-align-center":
      return "text-align:center";
    case "ed-align-end":
      return "text-align:right";
    case "ed-align-justify":
      return "text-align:justify";
    default:
      // `ed-embed` included: a video figure has no meaning in email, and it
      // keeps its markup rather than gaining a style that implies one.
      return null;
  }
}

/**
 * The colour a link is drawn in: the brand primary, darkened until it clears
 * 4.5:1 on the message's ground — exactly the site's `--primary-interactive`
 * (ADR-073). changes-46 #4: with no style of its own an `<a>` fell back to the
 * mail client's default BLUE, a colour the brand does not contain.
 */
export function emailLinkColor(palette: EmailPalette): string {
  return deriveTonalInk(palette.brand.primary, palette.surface.background);
}

/**
 * Fold every `ed-*` class into the element's `style`, and give every link the
 * brand's link ink. Runs the sanitiser again on the way through (defence in
 * depth — ADR-078 #7).
 */
export function inlineEditorialStyles(html: string, palette: EmailPalette): string {
  const linkStyle = `color:${emailLinkColor(palette)};text-decoration:underline`;
  // The editor draws every table full width (`[&_table]:w-full`) and stores
  // none, so a panel built from a one-cell table would otherwise shrink to
  // its words in an inbox. `separate` so a cell's rounded corners survive.
  const tableStyle = "width:100%;border-collapse:separate;border-spacing:0;margin:16px 0";
  // An image keeps its stored size where there is room and shrinks, in
  // proportion, where there is not — a 600px picture on a 360px phone.
  const imageStyle = "max-width:100%;height:auto";
  return sanitizeEmailHtmlWith(html, "RICH", {
    "*": (tagName, attribs) => {
      const classes = attribs.class?.split(/\s+/).filter(Boolean) ?? [];
      // A link's colour comes FIRST, so a tone class or the author's own
      // style — both more specific intents — still wins.
      const base =
        tagName === "a"
          ? [linkStyle]
          : tagName === "table"
            ? [tableStyle]
            : tagName === "img"
              ? [imageStyle]
              : [];
      if (classes.length === 0 && base.length === 0) return { tagName, attribs };
      const styles = [
        ...base,
        ...classes
          .map((className) => editorialStyle(className, palette))
          .filter((style): style is string => style !== null),
      ];
      if (styles.length === 0) return { tagName, attribs };
      // An author's own inline style wins: it is the more specific intent,
      // and the class map is the default the editor applied.
      const existing = attribs.style ? [attribs.style.replace(/;\s*$/, "")] : [];
      return { tagName, attribs: { ...attribs, style: [...styles, ...existing].join(";") } };
    },
  });
}

/**
 * A site-relative URL made absolute against the site's origin.
 *
 * changes-46 #4: `email.logo` is stored as the upload path (`/uploads/…`),
 * which is what every picker writes. A relative `src` means nothing in an
 * inbox — there is no page for it to be relative TO — so the logo silently
 * vanished from every sent message and from the preview. Absolute URLs pass
 * through; a protocol-relative one (`//host`) is refused rather than
 * guessed at, and so is anything that is not a path.
 */
export function absoluteUrl(url: string, origin: string): string | undefined {
  const value = url.trim();
  if (value === "") return undefined;
  if (/^https?:\/\//i.test(value)) return value;
  if (!value.startsWith("/") || value.startsWith("//") || origin === "") return undefined;
  return `${origin.replace(/\/+$/, "")}${value}`;
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Text the shell prints from DATA, made inert to the substitution pass that
 * runs after it (ADR-179 #6): `{{` in an address or a setting would otherwise
 * be read as a variable.
 */
function escapeShellText(value: string): string {
  return escapeText(value).replace(/\{/g, "&#123;").replace(/\}/g, "&#125;");
}

/** The inks a brand band needs, all derived against the band (ADR-179 #1). */
export interface EmailBandInks {
  band: string;
  rule: string;
  text: string;
  muted: string;
  link: string;
}

export function emailBandInks(palette: EmailPalette): EmailBandInks {
  const { brand } = palette;
  const surface = palette.band ?? palette.surface;
  const band = brand.secondary;
  // Whichever of the two surface texts reads on the band — light on the
  // seeded near-black, dark on a theme whose secondary is pale.
  const text =
    contrastRatio(surface.background, band) >= contrastRatio(surface.textPrimary, band)
      ? surface.background
      : surface.textPrimary;
  return {
    band,
    rule: brand.primary,
    text,
    muted: deriveInteractive(surface.textMuted, band),
    link: deriveTonalInk(brand.primary, band),
  };
}

/**
 * Which of the Branding logos the header band carries. The band is the
 * site's own `--secondary` treatment, so it takes the logo the site's footer
 * puts on that same ground: `logo_dark` (the mark drawn for a dark ground)
 * when the band reads dark, `logo_light` when a theme's secondary is pale.
 * The other one is the fallback, because a logo that reads poorly is still
 * closer to the brand than the site name in plain text.
 */
export function pickEmailLogo(
  palette: EmailPalette,
  logos: { light?: string | null | undefined; dark?: string | null | undefined },
): string {
  const surface = palette.band ?? palette.surface;
  const bandIsDark = emailBandInks(palette).text === surface.background;
  const [first, second] = bandIsDark ? [logos.dark, logos.light] : [logos.light, logos.dark];
  return first || second || "";
}

/**
 * The phone layout, as the one `<style>` block the shell carries. The inline
 * styles are the DESKTOP layout and what a client that drops `<style>` gets —
 * which is still a message that fits, because nothing in it is wider than its
 * container. This block only reclaims space on a narrow screen: 32px of side
 * padding at every level leaves a 320px phone barely 230px of text.
 * `!important` because an inline style otherwise wins. Class names are the
 * shell's own (`em-*`) plus the editor's block classes, which the sanitiser
 * keeps on the element alongside the style they were folded into.
 */
function mobileStyles(): string {
  return `<style>
@media only screen and (max-width:620px){
.em-outer{padding:12px 6px!important}
.em-head{padding:24px 16px!important}
.em-body{padding:24px 18px!important}
.em-foot{padding:24px 16px 20px!important}
.ed-panel{padding:16px!important}
.ed-title{font-size:22px!important;line-height:28px!important}
.ed-code{font-size:28px!important;letter-spacing:6px!important}
.ed-btn,.ed-btn-secondary{padding:12px 20px!important}
}
</style>`;
}

/**
 * A table up to 600px wide on a muted ground — the shape every mail client
 * agrees on. Deliberately not a flex or grid layout: Outlook renders neither.
 * Fluid (`width:100%;max-width:600px`) so a phone narrows it, with a fixed
 * 600px ghost table for Outlook, which ignores `max-width`.
 *
 * Header and footer are BRAND BANDS (ADR-179): `brand.secondary` with a
 * `brand.primary` rule on the edge that meets the card. The card itself is
 * `background` on a `surfaceMuted` page, so the message keeps its own edges.
 * Every line in the footer is optional and disappears with its value.
 */
export function renderEmailShell(input: EmailShellInput): string {
  const { palette, siteName } = input;
  const { surface } = palette;
  const inks = emailBandInks(palette);

  const preheader = input.preheader
    ? `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeText(input.preheader)}</div>`
    : "";

  const logo = input.logoUrl
    ? `<img src="${escapeAttribute(input.logoUrl)}" alt="${escapeAttribute(siteName)}" height="44" style="height:44px;max-width:220px;display:inline-block" />`
    : `<span style="font-size:22px;font-weight:700;letter-spacing:0.5px;color:${inks.text}">${escapeShellText(siteName)}</span>`;

  // The footer's type scale, one step per job, taken from the owner's
  // reference footer (changes-60): the name is a heading, links and contacts
  // are what a reader acts on, and the legal small print is the floor.
  const footerType = {
    name: "font-size:16px;line-height:22px",
    tagline: "font-size:13px;line-height:18px",
    links: "font-size:14px;line-height:22px",
    contacts: "font-size:13px;line-height:20px",
    legal: "font-size:11px;line-height:18px",
  };

  // The spaces around the bar are the row's ONLY break opportunities: every
  // item is `nowrap`, so without them the whole row is one unbreakable line
  // (~300px) and a phone scrolls sideways under it.
  const separator = ` <span style="color:${inks.muted};padding:0 6px;opacity:0.6">|</span> `;
  // Every footer line states its own centring: the cell's `align` reaches
  // inline content in most clients, but Outlook's Word engine applies a
  // paragraph's own alignment and defaults it to the start edge.
  const paragraph = (html: string, style: string) =>
    `<p style="margin:0 0 4px;text-align:center;${style}">${html}</p>`;

  const links = (input.links ?? [])
    .map(
      (link) =>
        `<a href="${escapeAttribute(link.url)}" style="color:${inks.link};font-weight:600;text-decoration:none;white-space:nowrap">${escapeShellText(link.label)}</a>`,
    )
    .join(separator);

  const contacts = (input.contacts ?? [])
    .map(
      (contact) =>
        `<span style="color:${inks.muted}">${escapeShellText(contact.label)}:</span> <a href="${escapeAttribute(contact.url)}" style="color:${inks.text};text-decoration:none;white-space:nowrap">${escapeShellText(contact.value)}</a>`,
    )
    .join(separator);

  const small = `${footerType.legal};color:${inks.muted}`;
  const unsubscribeLink = input.unsubscribe
    ? `<a href="${escapeAttribute(input.unsubscribe.url)}" style="color:${inks.text};text-decoration:underline">${escapeShellText(input.unsubscribe.label)}</a>`
    : "";
  // The sentence is split around `{link}` and each half escaped on its own,
  // so the anchor is the only markup in the line.
  const unsubscribe =
    unsubscribeLink && input.unsubscribeLine?.includes("{link}")
      ? input.unsubscribeLine
          .split("{link}")
          .map((part) => escapeShellText(part))
          .join(unsubscribeLink)
      : unsubscribeLink;
  // Two lines, not one per item: who sent it (copyright, recipient, reason),
  // then where from and how to stop it. Four separate paragraphs each wrapped
  // on a phone and turned the band into a column of fragments.
  const legal = [
    [
      ...(input.legalLines ?? []).map((line) => escapeShellText(line)),
      ...(input.footerText ? [escapeShellText(input.footerText)] : []),
    ],
    [
      ...(input.postalAddress ? [escapeShellText(input.postalAddress)] : []),
      ...(unsubscribe ? [unsubscribe] : []),
    ],
  ]
    .filter((group) => group.length > 0)
    .map((group) => group.join(" "));

  const footerTop = [
    paragraph(
      // The colour is repeated on the anchor: a mail client paints a bare link
      // its own blue, which on the band is neither the brand nor readable.
      input.homeUrl
        ? `<a href="${escapeAttribute(input.homeUrl)}" style="color:${inks.text};text-decoration:none">${escapeShellText(siteName)}</a>`
        : escapeShellText(siteName),
      `${footerType.name};font-weight:700;color:${inks.text}`,
    ),
    input.tagline
      ? paragraph(escapeShellText(input.tagline), `${footerType.tagline};color:${inks.muted}`)
      : "",
    links ? `<p style="margin:12px 0 4px;text-align:center;${footerType.links}">${links}</p>` : "",
    contacts ? paragraph(contacts, footerType.contacts) : "",
  ].join("");

  const footerBottom = legal
    .map(
      (line, index) =>
        // The LAST line carries no bottom margin, or the band looks taller than
        // its padding says.
        `<p style="margin:${index === legal.length - 1 ? "0" : "0 0 4px"};text-align:center;${small}">${line}</p>`,
    )
    .join("");

  const divider =
    footerTop && footerBottom
      ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr><td style="padding:12px 0 14px" align="center"><div style="width:70%;max-width:300px;margin:0 auto;height:1px;line-height:1px;font-size:0;background-color:${inks.muted};opacity:0.4">&nbsp;</div></td></tr></table>`
      : "";

  // A long unbroken string — a reset URL, an email address — may break
  // anywhere rather than widen the message past a phone's screen. Both
  // spellings: `overflow-wrap:anywhere` is the standard, `word-break` is what
  // older WebKit and Outlook.com honour.
  const wrap = "word-break:break-word;overflow-wrap:anywhere";

  return `<!doctype html>
<html>
<head><meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /><meta name="x-apple-disable-message-reformatting" />
${mobileStyles()}
</head>
<body style="margin:0;padding:0;background-color:${surface.surfaceMuted};font-family:${palette.fontFamily};color:${surface.textPrimary};-webkit-text-size-adjust:100%;text-size-adjust:100%">
${preheader}
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="em-outer" style="width:100%;background-color:${surface.surfaceMuted};padding:24px 12px">
  <tr>
    <td align="center">
      <!--[if mso]><table role="presentation" width="600" align="center" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background-color:${surface.background};border-radius:12px;overflow:hidden">
        <tr>
          <td class="em-head" style="padding:32px;background-color:${inks.band};border-bottom:2px solid ${inks.rule};border-radius:12px 12px 0 0" align="center">${logo}</td>
        </tr>
        <tr>
          <td class="em-body" style="padding:28px 32px;font-size:16px;line-height:24px;color:${surface.textPrimary};background-color:${surface.background};${wrap}">${input.bodyHtml}</td>
        </tr>
        <tr>
          <td class="em-foot" style="padding:28px 48px 24px;text-align:center;background-color:${inks.band};border-top:2px solid ${inks.rule};border-radius:0 0 12px 12px;${wrap}" align="center">${footerTop}${divider}${footerBottom}</td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}
