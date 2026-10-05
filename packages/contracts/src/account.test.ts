// The learner profile page's inputs and its resume rule (ADR-123).
import { describe, expect, it } from "vitest";

import {
  ACCOUNT_PATH,
  AVATAR_MAX_BYTES,
  articleReadSchema,
  changeEmailFormSchema,
  changePasswordFormSchema,
  latestBirthDate,
  learnerAddressSchema,
  learnerProfileSchema,
  pickResumeLesson,
  profileCompleteness,
  twoFactorCodeSchema,
  twoFactorPasswordSchema,
} from "./index.ts";
import { updateOwnProfileSchema } from "./admin.ts";

describe("articleReadSchema", () => {
  it("accepts an article id", () => {
    expect(articleReadSchema.parse({ articleId: " ck123 " })).toEqual({ articleId: "ck123" });
  });

  it("rejects an empty or oversized id", () => {
    expect(articleReadSchema.safeParse({ articleId: "" }).success).toBe(false);
    expect(articleReadSchema.safeParse({ articleId: "x".repeat(192) }).success).toBe(false);
  });

  // The mass-assignment defence (security.md #6): the reader is the session,
  // so a body that names one is not honoured — the field is simply dropped.
  it("has nowhere to put a user id", () => {
    const parsed = articleReadSchema.parse({ articleId: "a1", userId: "someone-else" });
    expect(parsed).toEqual({ articleId: "a1" });
  });
});

describe("learnerProfileSchema", () => {
  // ADR-155 #5: it EXTENDS the staff schema, so every rule about a name is shared.
  it("shares every staff profile field and adds only the birthday", () => {
    const staffKeys = Object.keys(updateOwnProfileSchema.shape);
    expect(Object.keys(learnerProfileSchema.shape)).toEqual([...staffKeys, "birthDate"]);
    for (const key of staffKeys) {
      expect(learnerProfileSchema.shape[key as keyof typeof learnerProfileSchema.shape]).toBe(
        updateOwnProfileSchema.shape[key as keyof typeof updateOwnProfileSchema.shape],
      );
    }
  });

  it("takes a birthday as a calendar date, and blank as none", () => {
    expect(learnerProfileSchema.parse({ name: "Sam", birthDate: "1990-04-12" }).birthDate).toBe(
      "1990-04-12",
    );
    expect(learnerProfileSchema.parse({ name: "Sam", birthDate: "" }).birthDate).toBeNull();
    expect(learnerProfileSchema.parse({ name: "Sam", birthDate: null }).birthDate).toBeNull();
    expect(learnerProfileSchema.parse({ name: "Sam" }).birthDate).toBeUndefined();
  });

  it("refuses an impossible, ancient or future birthday", () => {
    for (const birthDate of ["2001-02-30", "1899-12-31", "3000-01-01", "12/04/1990", "1990-4-1"]) {
      expect(learnerProfileSchema.safeParse({ name: "Sam", birthDate }).success).toBe(false);
    }
  });

  it("allows today at the far east of the date line", () => {
    const now = new Date("2026-09-22T12:00:00Z");
    expect(latestBirthDate(now)).toBe("2026-09-23");
  });

  it("requires a name and trims it", () => {
    expect(learnerProfileSchema.parse({ name: "  Sam  " }).name).toBe("Sam");
    expect(learnerProfileSchema.safeParse({ name: "   " }).success).toBe(false);
  });
});

describe("changePasswordFormSchema", () => {
  const valid = {
    currentPassword: "old-pass",
    newPassword: "new-password",
    confirmPassword: "new-password",
  };

  it("accepts a matching confirmation", () => {
    expect(changePasswordFormSchema.safeParse(valid).success).toBe(true);
  });

  it("puts a mismatch on the confirmation field", () => {
    const result = changePasswordFormSchema.safeParse({ ...valid, confirmPassword: "different" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["confirmPassword"]);
  });

  it("enforces the server's minimum on the new password", () => {
    const result = changePasswordFormSchema.safeParse({
      ...valid,
      newPassword: "short",
      confirmPassword: "short",
    });
    expect(result.success).toBe(false);
  });
});

describe("twoFactorCodeSchema", () => {
  it("accepts six digits, with the space authenticator apps display", () => {
    expect(twoFactorCodeSchema.parse({ code: "123 456" })).toEqual({ code: "123456" });
    expect(twoFactorCodeSchema.parse({ code: "000111" })).toEqual({ code: "000111" });
  });

  it("rejects anything that is not six digits", () => {
    for (const code of ["12345", "1234567", "12a456", ""]) {
      expect(twoFactorCodeSchema.safeParse({ code }).success, code).toBe(false);
    }
  });
});

describe("twoFactorPasswordSchema", () => {
  it("requires a password", () => {
    expect(twoFactorPasswordSchema.safeParse({ password: "" }).success).toBe(false);
    expect(twoFactorPasswordSchema.safeParse({ password: "secret" }).success).toBe(true);
  });
});

describe("constants", () => {
  it("keeps the avatar budget under the library's 5 MB image default", () => {
    expect(AVATAR_MAX_BYTES).toBeLessThan(5 * 1024 * 1024);
  });

  it("names the page without a locale", () => {
    expect(ACCOUNT_PATH).toBe("/account");
  });
});

describe("pickResumeLesson", () => {
  const lessons = [{ id: "l1" }, { id: "l2" }, { id: "l3" }, { id: "l4" }];

  it("opens the first lesson of an untouched course", () => {
    expect(pickResumeLesson(lessons, new Set(), null)).toEqual({ id: "l1" });
  });

  it("returns to the lesson they left in the middle of", () => {
    expect(pickResumeLesson(lessons, new Set(["l1"]), "l3")).toEqual({ id: "l3" });
  });

  it("sends a learner back to a lesson they skipped, not to the next page", () => {
    expect(pickResumeLesson(lessons, new Set(["l1", "l3", "l4"]), "l4")).toEqual({ id: "l2" });
  });

  it("ignores a last lesson that is no longer reachable", () => {
    expect(pickResumeLesson(lessons, new Set(["l1"]), "gone")).toEqual({ id: "l2" });
  });

  it("is null when every lesson is complete, or there are none", () => {
    expect(pickResumeLesson(lessons, new Set(["l1", "l2", "l3", "l4"]), "l4")).toBeNull();
    expect(pickResumeLesson([], new Set(), null)).toBeNull();
  });
});

describe("learnerAddressSchema", () => {
  it("trims each line and turns a blank one into null", () => {
    expect(
      learnerAddressSchema.parse({
        addressLine1: "  1 High St ",
        addressLine2: "",
        city: "Leeds",
        region: null,
        postalCode: " LS1 1AA ",
        country: "GB",
      }),
    ).toEqual({
      addressLine1: "1 High St",
      addressLine2: null,
      city: "Leeds",
      region: null,
      postalCode: "LS1 1AA",
      country: "GB",
    });
  });

  it("accepts an empty country and refuses one that is not an ISO code", () => {
    expect(learnerAddressSchema.parse({ country: "" }).country).toBeNull();
    expect(learnerAddressSchema.safeParse({ country: "gb" }).success).toBe(false);
    expect(learnerAddressSchema.safeParse({ country: "XX" }).success).toBe(false);
  });

  it("refuses an over-long line", () => {
    expect(learnerAddressSchema.safeParse({ postalCode: "x".repeat(21) }).success).toBe(false);
  });

  it("has nowhere to put a user id", () => {
    expect(learnerAddressSchema.parse({ city: "Leeds", userId: "someone-else" })).toEqual({
      city: "Leeds",
    });
  });
});

describe("changeEmailFormSchema", () => {
  it("lower-cases and trims the new address", () => {
    expect(changeEmailFormSchema.parse({ newEmail: "  Sam@Example.COM " })).toEqual({
      newEmail: "sam@example.com",
    });
  });

  it("refuses something that is not an address", () => {
    expect(changeEmailFormSchema.safeParse({ newEmail: "sam" }).success).toBe(false);
  });
});

describe("profileCompleteness", () => {
  const empty = {
    image: null,
    firstName: null,
    lastName: null,
    phone: null,
    birthDate: null,
    emailVerified: false,
    address: {
      addressLine1: null,
      addressLine2: null,
      city: null,
      region: null,
      postalCode: null,
      country: null,
    },
  };

  it("is zero for a bare account and lists everything missing, in order", () => {
    expect(profileCompleteness(empty)).toEqual({
      percent: 0,
      missing: ["picture", "fullName", "phone", "birthDate", "address", "emailVerified"],
    });
  });

  it("needs both halves of a name and a postable address", () => {
    const partial = profileCompleteness({
      ...empty,
      firstName: "Sam",
      address: { ...empty.address, addressLine1: "1 High St", city: "Leeds" },
    });
    expect(partial.missing).toContain("fullName");
    expect(partial.missing).toContain("address");
  });

  it("is 100 when everything is filled in", () => {
    expect(
      profileCompleteness({
        image: "/a.png",
        firstName: "Sam",
        lastName: "Lee",
        phone: "+44",
        birthDate: "1990-04-12",
        emailVerified: true,
        address: { ...empty.address, addressLine1: "1 High St", city: "Leeds", country: "GB" },
      }),
    ).toEqual({ percent: 100, missing: [] });
  });
});
