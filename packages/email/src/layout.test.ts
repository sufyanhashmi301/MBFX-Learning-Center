// Class CSS does not survive an email client, so every `ed-*` rule has to
// arrive as an inline style. What breaks here breaks silently: the message
// still renders, just unstyled and off-brand.
import { describe, expect, it } from "vitest";
import { EDITORIAL_CLASSES } from "@repo/contracts";
import {
  DEFAULT_BRAND,
  DEFAULT_DARK_SURFACE,
  DEFAULT_LIGHT_SURFACE,
  contrastRatio,
  deriveTonalInk,
} from "@repo/theme";
import {
  emailBandInks,
  absoluteUrl,
  editorialStyle,
  emailLinkColor,
  inlineEditorialStyles,
  pickEmailLogo,
  renderEmailShell,
} from "./layout.ts";
import type { EmailPalette } from "./layout.ts";

const palette: EmailPalette = {
  brand: DEFAULT_BRAND,
  surface: DEFAULT_LIGHT_SURFACE,
  fontFamily: "Inter, Arial, sans-serif",
};

describe("editorialStyle", () => {
  it("covers every class the editor can emit, except the video figure", () => {
    // `ed-embed` is deliberately unmapped: a video has no meaning in email,
    // so it keeps its markup rather than gaining a style that implies one.
    const unmapped = EDITORIAL_CLASSES.filter((name) => editorialStyle(name, palette) === null);
    expect(unmapped).toEqual(["ed-embed"]);
  });

  it("takes its colours from the palette, not from a literal", () => {
    expect(editorialStyle("ed-tx-primary", palette)).toBe(`color:${DEFAULT_BRAND.primary}`);
    expect(editorialStyle("ed-tx-muted", palette)).toBe(`color:${DEFAULT_LIGHT_SURFACE.textMuted}`);
  });

  it("gives a highlight padding, or the colour stops at the glyphs", () => {
    expect(editorialStyle("ed-hl-warning", palette)).toContain("padding:");
  });

  it("ignores a class it does not know", () => {
    expect(editorialStyle("ed-not-a-thing", palette)).toBeNull();
  });
});

describe("inlineEditorialStyles", () => {
  it("folds a class into a style attribute", () => {
    const output = inlineEditorialStyles(`<p class="ed-tx-primary">hi</p>`, palette);
    expect(output).toContain(`style="color:${DEFAULT_BRAND.primary}"`);
  });

  it("folds several classes at once", () => {
    const output = inlineEditorialStyles(`<p class="ed-align-center ed-fs-lg">hi</p>`, palette);
    expect(output).toContain("text-align:center");
    expect(output).toContain("font-size:18px");
  });

  it("lets the author's own inline style win", () => {
    const output = inlineEditorialStyles(
      `<p class="ed-fs-lg" style="font-size:11px">hi</p>`,
      palette,
    );
    // Both are present, the author's last — the later declaration wins in CSS.
    expect(output.indexOf("font-size:18px")).toBeLessThan(output.indexOf("font-size:11px"));
  });

  it("leaves an element with no editorial class untouched", () => {
    expect(inlineEditorialStyles(`<p>hi</p>`, palette)).toBe("<p>hi</p>");
  });

  it("draws a link in the brand's link ink, never the client's default blue", () => {
    const output = inlineEditorialStyles(`<p><a href="https://x.test">go</a></p>`, palette);
    expect(output).toContain(`color:${emailLinkColor(palette)}`);
    expect(emailLinkColor(palette)).toBe(
      deriveTonalInk(DEFAULT_BRAND.primary, DEFAULT_LIGHT_SURFACE.background),
    );
  });

  it("lets a tone class on a link override the link ink", () => {
    const output = inlineEditorialStyles(
      `<a class="ed-tx-danger" href="https://x.test">go</a>`,
      palette,
    );
    expect(output.indexOf(emailLinkColor(palette))).toBeLessThan(
      output.indexOf(DEFAULT_BRAND.error),
    );
  });

  it("still sanitises on the way through", () => {
    const output = inlineEditorialStyles(
      `<p class="ed-tx-info">hi</p><script>x()</script>`,
      palette,
    );
    expect(output).not.toContain("<script");
  });
});

describe("renderEmailShell", () => {
  const base = { bodyHtml: "<p>hi</p>", palette, siteName: "MBX Learning Center" };

  it("is a table layout, because Outlook renders neither flex nor grid", () => {
    const html = renderEmailShell(base);
    expect(html).toContain("<table");
    expect(html).not.toContain("display:flex");
    expect(html).not.toContain("display:grid");
    expect(html).toContain("width:600px");
  });

  it("shows the logo when there is one, and the name when there is not", () => {
    expect(renderEmailShell({ ...base, logoUrl: "https://example.com/logo.png" })).toContain(
      '<img src="https://example.com/logo.png"',
    );
    expect(renderEmailShell(base)).toContain("MBX Learning Center");
  });

  it("escapes what it is given", () => {
    const html = renderEmailShell({ ...base, siteName: `<script>alert(1)</script>` });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("renders an unsubscribe line only when given one, with its own label", () => {
    expect(renderEmailShell(base)).not.toContain("unsubscribe");
    const html = renderEmailShell({
      ...base,
      unsubscribe: { url: "https://example.com/u?token=x", label: "Unsubscribe" },
    });
    expect(html).toContain("https://example.com/u?token=x");
    expect(html).toContain("Unsubscribe");
  });

  it("sets the unsubscribe link inside its sentence, escaping only the words", () => {
    const html = renderEmailShell({
      ...base,
      unsubscribe: { url: "https://example.com/u?token=x", label: "click to unsubscribe" },
      unsubscribeLine: "If you no longer wish to receive <these> emails, {link}.",
    });
    expect(html).toMatch(
      /If you no longer wish to receive &lt;these&gt; emails, <a href="https:\/\/example\.com\/u\?token=x"[^>]*>click to unsubscribe<\/a>\./,
    );
  });

  it("draws the bands in the same inks whatever the card's scheme", () => {
    const dark: EmailPalette = {
      ...palette,
      surface: DEFAULT_DARK_SURFACE,
      band: DEFAULT_LIGHT_SURFACE,
    };
    expect(emailBandInks(dark)).toEqual(emailBandInks(palette));
  });

  it("takes its ground and ink from the palette", () => {
    const html = renderEmailShell(base);
    expect(html).toContain(DEFAULT_LIGHT_SURFACE.background);
    expect(html).toContain(DEFAULT_LIGHT_SURFACE.textPrimary);
  });

  it("draws header and footer as brand bands with a primary rule (ADR-179 #1)", () => {
    // Sentinels rather than colours: the shell interpolates whatever the token
    // holds, so this asserts WHICH token each part reads — which is the rule —
    // and keeps code-style #1's no-hex-literal rule intact in a test.
    const html = renderEmailShell(base);
    const inks = emailBandInks(palette);
    const header = html.slice(html.indexOf('<td class="em-head"'));
    expect(header).toContain(`background-color:${palette.brand.secondary}`);
    expect(header).toContain(`border-bottom:2px solid ${palette.brand.primary}`);
    const footer = html.slice(html.lastIndexOf('<td class="em-foot"'));
    expect(footer).toContain(`background-color:${inks.band}`);
    // The page keeps its own ground, so the message still has edges.
    expect(html).toContain(`background-color:${DEFAULT_LIGHT_SURFACE.surfaceMuted}`);
  });

  it("derives every band ink to read on the band", () => {
    const inks = emailBandInks(palette);
    expect(contrastRatio(inks.text, inks.band)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(inks.muted, inks.band)).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio(inks.link, inks.band)).toBeGreaterThanOrEqual(4.5);
  });

  it("prints only the footer lines it was given", () => {
    const bare = renderEmailShell(base);
    expect(bare).not.toContain("mailto:");
    expect(bare).not.toContain("Contact support");

    const html = renderEmailShell({
      ...base,
      tagline: "Learn to trade the markets",
      links: [{ url: "https://site.test/support", label: "Contact support" }],
      contacts: [{ label: "Email", value: "hello@site.test", url: "mailto:hello@site.test" }],
      legalLines: ["© 2026 MBX. All rights reserved."],
    });
    expect(html).toContain("Learn to trade the markets");
    expect(html).toContain('href="https://site.test/support"');
    expect(html).toContain("mailto:hello@site.test");
    expect(html).toContain("© 2026 MBX. All rights reserved.");
  });

  it("links the footer's site name to the home page when it has one", () => {
    const linked = renderEmailShell({ ...base, homeUrl: "https://site.test/ar" });
    const footer = linked.slice(linked.lastIndexOf('<td class="em-foot"'));
    expect(footer).toMatch(/<a href="https:\/\/site\.test\/ar" style="color:[^"]+">[^<]+<\/a>/);

    const plain = renderEmailShell(base);
    const plainFooter = plain.slice(plain.lastIndexOf('<td class="em-foot"'));
    expect(plainFooter).not.toContain("<a ");
  });

  it("makes data in the shell inert to variable substitution (ADR-179 #6)", () => {
    const html = renderEmailShell({ ...base, legalLines: ["sent to a{{reset.url}}@x.test"] });
    expect(html).not.toContain("{{reset.url}}");
    expect(html).toContain("&#123;&#123;reset.url&#125;&#125;");
  });

  it("leaves no trailing margin under the last footer line", () => {
    const html = renderEmailShell({
      ...base,
      legalLines: ["© 2026 MBX."],
      footerText: "Because you have an account.",
      postalAddress: "1 Example Street",
    });
    const lines = [
      ...html.matchAll(/<p style="margin:([^;]+);text-align:center;font-size:11px/g),
    ].map((m) => m[1]);
    expect(lines).toEqual(["0 0 4px", "0"]);
  });

  it("sets the footer at the reference sizes, centred, and steps the sizes down by job", () => {
    const html = renderEmailShell({
      ...base,
      tagline: "Learn to trade the markets",
      links: [{ url: "https://site.test/support", label: "Contact support" }],
      contacts: [{ label: "Email", value: "hello@site.test", url: "mailto:hello@site.test" }],
      legalLines: ["© 2026 MBX."],
    });
    const footer = html.slice(html.lastIndexOf('<td class="em-foot"'));
    const sizes = [...footer.matchAll(/font-size:(\d+)px/g)]
      .map((m) => Number(m[1]))
      .filter((size) => size > 0);
    expect(Math.min(...sizes)).toBe(11);
    // name > links > tagline/contacts > legal, in document order.
    expect(sizes).toEqual([16, 13, 14, 13, 11]);
    expect(footer.match(/<p style="[^"]*"/g)?.every((p) => p.includes("text-align:center"))).toBe(
      true,
    );
  });

  it("sets the legal band on two lines: sender, then address and unsubscribe", () => {
    const html = renderEmailShell({
      ...base,
      legalLines: ["© 2026 MBX."],
      footerText: "Because you have an account.",
      postalAddress: "1 Example Street",
      unsubscribe: { url: "https://site.test/u", label: "Unsubscribe" },
    });
    const lines = [...html.matchAll(/font-size:11px;[^"]*">(.*?)<\/p>/g)].map((m) => m[1]);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("© 2026 MBX. Because you have an account.");
    expect(lines[1]).toContain("1 Example Street");
    expect(lines[1]).toContain('href="https://site.test/u"');
  });
});

describe("pickEmailLogo", () => {
  const logos = { light: "/brand/logo-light.png", dark: "/brand/logo-dark.png" };

  it("puts the dark-ground Branding logo on the seeded near-black band", () => {
    expect(pickEmailLogo(palette, logos)).toBe(logos.dark);
  });

  it("puts the light-ground logo on a band a theme made pale", () => {
    const pale = {
      ...palette,
      brand: { ...DEFAULT_BRAND, secondary: DEFAULT_LIGHT_SURFACE.background },
    };
    expect(pickEmailLogo(pale, logos)).toBe(logos.light);
  });

  it("falls back to whichever logo exists, and to nothing", () => {
    expect(pickEmailLogo(palette, { light: logos.light })).toBe(logos.light);
    expect(pickEmailLogo(palette, {})).toBe("");
  });
});

describe("absoluteUrl", () => {
  it("makes an upload path absolute against the site origin", () => {
    expect(absoluteUrl("/uploads/logo.png", "http://localhost:3000/")).toBe(
      "http://localhost:3000/uploads/logo.png",
    );
  });

  it("passes an absolute http(s) URL through", () => {
    expect(absoluteUrl("https://cdn.example.com/l.png", "https://site.test")).toBe(
      "https://cdn.example.com/l.png",
    );
  });

  it("refuses what it cannot resolve safely", () => {
    expect(absoluteUrl("", "https://site.test")).toBeUndefined();
    expect(absoluteUrl("//evil.example/l.png", "https://site.test")).toBeUndefined();
    expect(absoluteUrl("javascript:alert(1)", "https://site.test")).toBeUndefined();
    expect(absoluteUrl("/uploads/l.png", "")).toBeUndefined();
  });
});

describe("the email block vocabulary (changes-61, ADR-184)", () => {
  const style = (name: string) => editorialStyle(name, palette) ?? "";
  const ink = (css: string) => /(?:^|;)color:([^;]+)/.exec(css)?.[1] ?? "";
  const ground = (css: string) => /background-color:([^;]+)/.exec(css)?.[1] ?? "";

  it("draws a button on the brand primary with an ink that reads on it", () => {
    const css = style("ed-btn");
    expect(ground(css)).toBe(DEFAULT_BRAND.primary);
    expect(css).toContain("text-decoration:none");
    expect(contrastRatio(ink(css), DEFAULT_BRAND.primary)).toBeGreaterThanOrEqual(4.5);
  });

  it("lets a button's own style beat the default link colour", () => {
    const html = inlineEditorialStyles(
      '<p><a class="ed-btn" href="https://x.test">Go</a></p>',
      palette,
    );
    const css = /style="([^"]*)"/.exec(html)?.[1] ?? "";
    // The link colour comes first, so the button's later declaration wins.
    expect(css.lastIndexOf("color:")).toBeGreaterThan(css.indexOf("background-color:"));
    expect(css.endsWith("text-decoration:none")).toBe(true);
  });

  it.each(["primary", "success", "warning", "info", "danger", "muted"])(
    "gives a %s badge a readable ink on its own ground",
    (tone) => {
      const css = style(`ed-badge-${tone}`);
      expect(ground(css)).not.toBe("");
      expect(contrastRatio(ink(css), ground(css))).toBeGreaterThanOrEqual(3);
    },
  );

  it("ignores a badge tone it does not know", () => {
    expect(editorialStyle("ed-badge-neon", palette)).toBeNull();
  });

  it("styles the panel, the code, the eyebrow and the headline from the theme", () => {
    expect(style("ed-panel")).toContain(DEFAULT_LIGHT_SURFACE.surfaceMuted);
    expect(style("ed-code")).toContain("letter-spacing");
    expect(style("ed-eyebrow")).toContain("text-transform:uppercase");
    expect(style("ed-title")).toContain("font-weight:800");
  });

  it("draws every table full width, so a one-cell panel does not shrink to its words", () => {
    const html = inlineEditorialStyles(
      '<table><tbody><tr><td class="ed-panel"><p>Offer</p></td></tr></tbody></table>',
      palette,
    );
    expect(html).toMatch(/<table style="width:100%/);
    expect(html).toMatch(/<td class="ed-panel" style="background-color:/);
  });
});

// A phone must never scroll sideways under a message. A real browser found
// three things forcing a ~420px minimum width on every template; each is
// pinned here so it cannot come back.
describe("renderEmailShell on a phone", () => {
  const base = { bodyHtml: "<p>hi</p>", palette, siteName: "MBX Learning Center" };

  it("leaves a break opportunity between footer links, which are each nowrap", () => {
    const html = renderEmailShell({
      ...base,
      links: [
        { url: "https://site.test/a", label: "Log in" },
        { url: "https://site.test/b", label: "Contact support" },
      ],
    });
    expect(html).toMatch(/<\/a> <span[^>]*>\|<\/span> <a /);
  });

  it("lets a long URL or address in the body break rather than widen the card", () => {
    const html = renderEmailShell(base);
    expect(html).toMatch(/class="em-body" style="[^"]*overflow-wrap:anywhere/);
    expect(html).toMatch(/class="em-foot" style="[^"]*overflow-wrap:anywhere/);
  });

  it("never gives the footer divider a fixed pixel width", () => {
    const html = renderEmailShell({ ...base, tagline: "Tag", legalLines: ["© 2026"] });
    expect(html).toContain("width:70%;max-width:300px");
    expect(html).not.toMatch(/[^-]width:300px/);
  });

  it("tightens padding under a phone-width media query", () => {
    const html = renderEmailShell(base);
    expect(html).toContain("@media only screen and (max-width:620px)");
    expect(html).toMatch(/\.em-body\{padding:[^}]*!important\}/);
  });

  it("shrinks an author's image to the card instead of overflowing it", () => {
    const output = inlineEditorialStyles(
      '<p><img src="https://site.test/a.png" width="900" height="300" alt="a"></p>',
      palette,
    );
    expect(output).toMatch(/<img[^>]*style="max-width:100%;height:auto"/);
  });
});
