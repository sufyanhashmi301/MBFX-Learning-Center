// The support form's schema — the only validation between an unknown caller
// and a message sent from our own domain (ADR-113).
//
// It is the third thing in the action's five-part stand-in for
// `requirePermission()`, and the one that bounds every value that later
// becomes an email template variable. Each test below corresponds to one
// property the sender downstream is entitled to assume.
import { describe, expect, it } from "vitest";

import { NEWSLETTER_HONEYPOT_FIELD } from "./index.ts";
import { SUPPORT_HONEYPOT_FIELD, SUPPORT_MESSAGE_MAX, supportRequestSchema } from "./support.ts";

const VALID = {
  name: "Alex Morgan",
  email: "Alex@Example.TEST",
  subject: "I cannot sign in",
  message: "The reset link says it has expired.",
  locale: "en",
};

describe("supportRequestSchema", () => {
  it("accepts a well-formed submission", () => {
    const parsed = supportRequestSchema.parse(VALID);
    expect(parsed.name).toBe("Alex Morgan");
    expect(parsed.subject).toBe("I cannot sign in");
    expect(parsed.locale).toBe("en");
  });

  // The property the per-email rate-limit bucket depends on. Normalised in
  // only one of the two places, an address buys a caller two budgets for one
  // mailbox — the reason `newsletterSubscribeSchema` lower-cases here too.
  it("lower-cases the address, so the limit bucket and the send agree", () => {
    expect(supportRequestSchema.parse(VALID).email).toBe("alex@example.test");
  });

  it("trims every text field before it can become a template variable", () => {
    const parsed = supportRequestSchema.parse({
      ...VALID,
      name: "  Alex Morgan  ",
      subject: "  Help  ",
      message: "  Something went wrong.  ",
    });
    expect(parsed.name).toBe("Alex Morgan");
    expect(parsed.subject).toBe("Help");
    expect(parsed.message).toBe("Something went wrong.");
  });

  it("refuses a field that is only whitespace", () => {
    for (const field of ["name", "subject", "message"] as const) {
      expect(supportRequestSchema.safeParse({ ...VALID, [field]: "   " }).success).toBe(false);
    }
  });

  it("refuses a malformed address", () => {
    expect(supportRequestSchema.safeParse({ ...VALID, email: "not-an-address" }).success).toBe(
      false,
    );
  });

  // Header injection: one newline in a value that reaches a Subject line and
  // the rest of it becomes a Bcc. `name` and `subject` are the two a template
  // author is most likely to put there, so both refuse CR and LF outright.
  it("refuses CR or LF in the two fields a subject line is built from", () => {
    for (const field of ["name", "subject"] as const) {
      expect(
        supportRequestSchema.safeParse({ ...VALID, [field]: "Help\r\nBcc: someone@evil.test" })
          .success,
      ).toBe(false);
    }
  });

  // The body is the one field where a newline is meaningful — the reference's
  // own placeholder asks for detail — so it must NOT inherit the rule above.
  it("allows newlines in the message body", () => {
    const parsed = supportRequestSchema.parse({ ...VALID, message: "One line.\nAnother line." });
    expect(parsed.message).toBe("One line.\nAnother line.");
  });

  it("bounds every field, so nothing unbounded reaches the renderer", () => {
    expect(supportRequestSchema.safeParse({ ...VALID, name: "a".repeat(121) }).success).toBe(false);
    expect(supportRequestSchema.safeParse({ ...VALID, subject: "a".repeat(201) }).success).toBe(
      false,
    );
    expect(
      supportRequestSchema.safeParse({ ...VALID, message: "a".repeat(SUPPORT_MESSAGE_MAX + 1) })
        .success,
    ).toBe(false);
    expect(
      supportRequestSchema.safeParse({ ...VALID, message: "a".repeat(SUPPORT_MESSAGE_MAX) })
        .success,
    ).toBe(true);
  });

  // The honeypot is OPTIONAL here and refused in the action. A schema that
  // rejected a filled value would answer differently from one left alone,
  // which is how a bot learns the field is a trap.
  it("treats the honeypot as an optional field rather than a refusal", () => {
    expect(supportRequestSchema.safeParse(VALID).success).toBe(true);
    expect(
      supportRequestSchema.safeParse({ ...VALID, [SUPPORT_HONEYPOT_FIELD]: "https://spam.test" })
        .success,
    ).toBe(true);
  });

  // Not shared with NEWSLETTER_HONEYPOT_FIELD on purpose (ADR-113 §4): a bot
  // that learns to skip the footer form's field should not thereby pass this
  // one. The test states the intent so a later "tidy-up" cannot merge them
  // without reading it.
  it("uses its own honeypot field name", () => {
    expect(SUPPORT_HONEYPOT_FIELD).not.toBe(NEWSLETTER_HONEYPOT_FIELD);
  });

  // Regression (2026-09-24): "company" was autofilled by Chrome/Edge despite
  // autocomplete="off", so real visitors hit the honeypot and their message was
  // dropped while the form said "sent".
  it("names the honeypot nothing a browser autofills", () => {
    expect(SUPPORT_HONEYPOT_FIELD).not.toMatch(
      /company|organi[sz]ation|website|url|phone|tel|fax|address|name|email|city|zip|postal/i,
    );
  });
});
