// The names the browser and the server must agree on for reCAPTCHA (ADR-156),
// split from captcha.ts (changes-62 #2). ZOD-FREE ON PURPOSE: the credential
// helper the public layout loads reads these, and captcha.ts builds its save
// schema at load time, which put all of Zod (~370 KB) on every public page.

/** The header the auth guard reads the token from on a credential POST. */
export const CAPTCHA_HEADER = "x-captcha-response";

/** The hidden form field a non-auth form (the support form) carries the token in. */
export const CAPTCHA_FIELD = "captchaToken";

/**
 * reCAPTCHA v3 `action` names. The server REFUSES a token whose action is not
 * the one it expects, so a token minted on one form cannot be replayed at
 * another. `check` is the settings tab's own proof that the keys work, and
 * nothing else accepts it.
 */
export const CAPTCHA_ACTIONS = {
  auth: "auth",
  support: "support",
  check: "check",
} as const;

export type CaptchaAction = (typeof CAPTCHA_ACTIONS)[keyof typeof CAPTCHA_ACTIONS];
