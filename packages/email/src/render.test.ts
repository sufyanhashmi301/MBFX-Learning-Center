// ADR-078 #6/#7. The order — sanitise, assemble, then substitute with every
// value escaped — is the security property, and none of it is visible in a
// type signature.
import { describe, expect, it } from "vitest";
import { DEFAULT_BRAND, DEFAULT_LIGHT_SURFACE } from "@repo/theme";
import { EmailRenderError, htmlToText, missingVariables, renderEmail } from "./render.ts";
import type { EmailPalette } from "./layout.ts";

const palette: EmailPalette = {
  brand: DEFAULT_BRAND,
  surface: DEFAULT_LIGHT_SURFACE,
  fontFamily: "Inter, Arial, sans-serif",
};

const BASE_VARIABLES = {
  "site.name": "MBX Learning Center",
  "site.url": "https://example.com",
  "logo.url": "https://example.com/logo.png",
  year: "2026",
  "recipient.name": "Alex Morgan",
  "recipient.email": "alex@example.com",
  "reset.url": "https://example.com/reset-password?token=abc",
  "expires.minutes": "30",
};

function render(overrides: Partial<Parameters<typeof renderEmail>[0]> = {}) {
  return renderEmail({
    key: "auth.password_reset",
    mode: "RICH",
    subject: "Reset your password, {{recipient.name}}",
    bodyHtml: `<p>Hello {{recipient.name}}</p><p><a href="{{reset.url}}">Reset</a></p>`,
    variables: BASE_VARIABLES,
    palette,
    shell: { siteName: "MBX Learning Center" },
    ...overrides,
  });
}

describe("renderEmail", () => {
  it("fills a placeholder the editor auto-linked and split with bold", () => {
    // The production campaign body that reached an inbox as "{{recipient.name}}".
    const email = render({
      bodyHtml:
        '<p>Hi <strong>{{</strong><a target="_blank" rel="noopener noreferrer nofollow" href="http://recipient.name"><strong>recipient.name</strong></a><strong>}}</strong>,</p><p><a href="{{reset.url}}">Reset</a></p>',
    });
    expect(email.html).toContain("Alex Morgan");
    expect(email.html).not.toContain("{{");
    expect(email.html).not.toContain("http://recipient.name");
  });

  it("substitutes into the subject and the body", () => {
    const email = render();
    expect(email.subject).toBe("Reset your password, Alex Morgan");
    expect(email.html).toContain("Hello Alex Morgan");
    expect(email.html).toContain("https://example.com/reset-password?token=abc");
  });

  it("escapes every value, so a name cannot become markup", () => {
    const email = render({
      variables: { ...BASE_VARIABLES, "recipient.name": `<script>alert(1)</script>` },
    });
    expect(email.html).not.toContain("<script>");
    expect(email.html).toContain("&lt;script&gt;");
  });

  it("refuses a non-http(s) URL value", () => {
    // The sanitiser could not have caught this: it saw a relative href.
    expect(() =>
      render({ variables: { ...BASE_VARIABLES, "reset.url": "javascript:alert(1)" } }),
    ).toThrow(EmailRenderError);
    expect(() => render({ variables: { ...BASE_VARIABLES, "reset.url": "not a url" } })).toThrow(
      EmailRenderError,
    );
  });

  it("refuses a variable the caller never provided", () => {
    const { "expires.minutes": _dropped, ...without } = BASE_VARIABLES;
    expect(() =>
      render({ bodyHtml: `<p>{{reset.url}} in {{expires.minutes}}</p>`, variables: without }),
    ).toThrow(EmailRenderError);
  });

  it("refuses when a required variable is missing entirely", () => {
    const { "reset.url": _dropped, ...without } = BASE_VARIABLES;
    expect(() => render({ bodyHtml: "<p>no link here</p>", variables: without })).toThrow(
      /requires/,
    );
  });

  it("keeps the subject on one line, whatever the value contains", () => {
    const email = render({
      variables: { ...BASE_VARIABLES, "recipient.name": "Alex\r\nBcc: evil@example.com" },
    });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.subject).toContain("Bcc: evil@example.com");
  });

  it("strips markup a body tried to smuggle in, before substitution", () => {
    const email = render({ bodyHtml: `<p onclick="alert(1)">hi</p><script>alert(1)</script>` });
    expect(email.html).not.toContain("<script");
    expect(email.html).not.toContain("onclick");
  });

  it("wraps RICH mode in the shell and leaves HTML mode alone", () => {
    const rich = render();
    expect(rich.html).toContain("<table");
    expect(rich.html).toContain("MBX Learning Center");

    const raw = render({
      mode: "HTML",
      bodyHtml: `<html><body><p>Hand built {{reset.url}}</p></body></html>`,
    });
    // One document, not ours wrapped around theirs.
    expect(raw.html.match(/<body/g) ?? []).toHaveLength(1);
    expect(raw.html).not.toContain('role="presentation"');
  });

  it("produces a plain-text alternative with its links spelled out", () => {
    const email = render();
    expect(email.text).toContain("Hello Alex Morgan");
    expect(email.text).toContain("(https://example.com/reset-password?token=abc)");
    expect(email.text).not.toContain("<p>");
  });

  it("hides the preheader in the markup rather than showing it twice", () => {
    const email = render({ preheader: "Reset your password" });
    expect(email.html).toContain("display:none");
    expect(email.html).toContain("Reset your password");
  });
});

describe("htmlToText", () => {
  it("drops head and style content", () => {
    expect(htmlToText(`<head><title>x</title></head><style>.a{color:red}</style><p>kept</p>`)).toBe(
      "kept",
    );
  });

  it("decodes the entities it produced", () => {
    expect(htmlToText(`<p>a &amp; b &lt;c&gt;</p>`)).toBe("a & b <c>");
  });
});

describe("missingVariables", () => {
  it("names what a body still needs", () => {
    expect(missingVariables(`<p>{{a}} {{b}}</p>`, { a: "1" })).toEqual(["b"]);
  });
});
