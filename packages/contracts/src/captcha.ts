// Google reCAPTCHA v3 or v2 checkbox (ADR-156, ADR-158). The names both halves have to agree on — the
// browser that asks Google for a token and the server that checks it — and
// the shape of the Settings → General → reCAPTCHA save.
//
// The keys are DATA, not env: an admin enters them in that tab. The site key
// is public by design (Google puts it in the page). The secret key is sealed
// under CAPTCHA_SECRET_KEY and read by `@repo/auth` alone (security.md #10).
import { z } from "zod";

/** The scores the settings tab offers. Google suggests 0.5. */
export const CAPTCHA_MIN_SCORES = [0.3, 0.5, 0.7, 0.9] as const;

export const DEFAULT_CAPTCHA_MIN_SCORE = 0.5;

/**
 * Which reCAPTCHA runs (ADR-158). `SCORE` is v3: invisible, Google's badge,
 * a score and an action. `CHECKBOX` is v2: "I'm not a robot" inside the form,
 * no score and no action. Each needs its own kind of key from Google.
 */
export const CAPTCHA_MODES = ["SCORE", "CHECKBOX"] as const;

export type CaptchaMode = (typeof CAPTCHA_MODES)[number];

/**
 * What a guarded page hands its form: the public site key and the type, or
 * `null` while the check is off. Nothing secret.
 */
export interface CaptchaClientConfig {
  siteKey: string;
  mode: CaptchaMode;
}

/**
 * Settings → General → reCAPTCHA. `secretKey` blank means "keep the saved
 * one", the SMTP password's rule (ADR-078). `checkToken` is a token the
 * browser minted with THIS site key for the `check` action. Switching the
 * feature on needs one that passes, because keys that do not work would
 * refuse every sign-in, the admin's own included.
 */
export const captchaSettingsSaveSchema = z
  .object({
    enabled: z.boolean(),
    mode: z.enum(CAPTCHA_MODES),
    siteKey: z.string().trim().max(100),
    secretKey: z.string().trim().max(100).optional(),
    minScore: z.literal([...CAPTCHA_MIN_SCORES]),
    checkToken: z.string().max(4000).optional(),
  })
  .superRefine((value, ctx) => {
    // On needs a site key. Whether a SECRET is saved is the server's to know,
    // so that half is checked in the service, not here.
    if (value.enabled && value.siteKey === "") {
      ctx.addIssue({
        code: "too_small",
        origin: "string",
        minimum: 1,
        inclusive: true,
        path: ["siteKey"],
        input: value.siteKey,
      });
    }
  });

export type CaptchaSettingsSaveInput = z.infer<typeof captchaSettingsSaveSchema>;
