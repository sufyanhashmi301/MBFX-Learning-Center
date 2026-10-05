// @repo/auth — Better Auth config, session helper, JWT for native clients
// (ADR-001). Replaces the Module 03 interim stub; the exported auth()
// call shape is unchanged, so @repo/rbac needs no changes.
import { headers } from "next/headers";
import { hash, verify } from "@node-rs/argon2";
import { betterAuth } from "better-auth";
import type { Auth, BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { admin } from "better-auth/plugins/admin";
import { twoFactor } from "better-auth/plugins/two-factor";
import { emailOTP } from "better-auth/plugins/email-otp";
import { bearer } from "better-auth/plugins/bearer";
import { after } from "next/server";
import { adminSessionTimeoutMs, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@repo/contracts";
import { db } from "@repo/db";
import { sendTemplatedEmail } from "@repo/email";
import { getSetting } from "@repo/settings";
import { siteOrigin } from "@repo/utils";
import {
  emailChangeFromToken,
  passwordChangedBy,
  twoFactorAuditAction,
  writeAccountAudit,
} from "./account-audit.ts";
import { rateLimit } from "./rate-limit.ts";
import { resetPasswordPath } from "./reset-url.ts";
import { redisSecondaryStorage } from "./redis-secondary-storage.ts";
import { notifyEmailVerified } from "./email-verified.ts";
import { staffImpersonation, startImpersonation } from "./impersonation.ts";
import { recaptchaGuard } from "./captcha.ts";
import { configuredSocialProviders } from "./social-providers.ts";
import {
  DISABLED_EMAIL_OTP_PATHS,
  VERIFY_CODE_MINUTES,
  isRefusedOtpRequest,
  verificationKind,
} from "./email-code.ts";

// Public-write throttling (changes-11 PR 5.2/5.5). Re-exported here so a
// route handler imports one package for "who is this" and "how often".
export { rateLimit, type RateLimitResult } from "./rate-limit.ts";
// ADR-124: the app subscribes core services to verification without auth
// importing core.
export { onEmailVerified, type EmailVerifiedListener } from "./email-verified.ts";
export { canBeImpersonated, IMPERSONATION_SESSION_SECONDS } from "./impersonation.ts";
// ADR-157: enforced staff two-factor — the admin layout and requirePermission.
export { isStaffTwoFactorPending, staffTwoFactorPending } from "./two-factor.ts";
// ADR-156: reCAPTCHA. The guard below covers sign-in and sign-up; the support
// form checks its own token; the settings tab reads and saves the config here.
export {
  getCaptchaClient,
  loadCaptchaSettings,
  saveCaptchaSettings,
  verifyCaptchaToken,
  type CaptchaSaveRefusal,
  type CaptchaSaveResult,
  type CaptchaSettingsView,
} from "./captcha.ts";

// @node-rs/argon2 exports Algorithm as an ambient const enum, which
// verbatimModuleSyntax forbids referencing directly (can't verify the
// inlining is safe across the module boundary). 2 === Algorithm.Argon2id —
// already the library default; named as a constant so the choice stays
// explicit and survives a library default change.
const ARGON2ID = 2;

// ─────────────────────────────────────────────────────────────
// Lockout — security.md #13: exponential backoff, never a hard lock.
// Verified against a live spike (ADR-001-style, not guessed): a failed
// /sign-in/email attempt surfaces in hooks.after as
// `returned.body.code === "INVALID_EMAIL_OR_PASSWORD"`; a successful one has
// `returned.user` instead. Enforcement is a second hook
// (databaseHooks.session.create.before) because a *correct* password on a
// still-locked account reaches session creation — the failure path never
// gets there at all.
// ─────────────────────────────────────────────────────────────

const LOCKOUT_THRESHOLD = 5; // failed attempts before lockout starts
const LOCKOUT_BASE_SECONDS = 30;
const LOCKOUT_MAX_SECONDS = 15 * 60; // never a hard lock — always expires

function computeLockoutSeconds(failedLoginCount: number): number {
  const overflow = failedLoginCount - LOCKOUT_THRESHOLD;
  return Math.min(LOCKOUT_BASE_SECONDS * 2 ** overflow, LOCKOUT_MAX_SECONDS);
}

// ─────────────────────────────────────────────────────────────
// Email (ADR-078, ADR-079). Delivery, templates and the log belong to
// @repo/email; what stays here are the two rules that are about auth:
//
//   1. **The reset link is routed by the USER's type, never by the screen
//      that asked** (ADR-079 #2). A learner who types their address into the
//      staff screen still gets a public link, and the public surface goes on
//      advertising no administrator entry point (ADR-052).
//   2. **A per-account limit sits in front of the send.** Better Auth's own
//      limiter is per IP, and a mail-bomb aimed at one address can come from
//      many (security.md #13).
// ─────────────────────────────────────────────────────────────

const RESET_TOKEN_MINUTES = 30;
const RESET_SENDS_PER_HOUR = 3;

// The origin comes from `@repo/utils` (code-style.md #27), not from a copy of
// the precedence kept here. The copy ended in `""`, and an empty origin makes
// `resetPasswordPath` return a RELATIVE url — a reset link that resolves
// against nothing in an inbox. `siteOrigin()` also reads the runtime
// `SITE_URL`, which is the only one of the three a container can set without
// a rebuild.
function adminOrigin(): string {
  // `ADMIN_URL` for the same reason `SITE_URL` leads in `siteOrigin()`: the
  // `NEXT_PUBLIC_` one is frozen into the bundle at build time, and a stale
  // one here wins over a correct site origin, so it is the value that decides
  // where a STAFF reset link points.
  return process.env.ADMIN_URL ?? process.env.NEXT_PUBLIC_ADMIN_URL ?? siteOrigin();
}

interface MailUser {
  id: string;
  email: string;
  name?: string | null;
  locale?: string | null;
  userType?: string | null;
}

/** The origins resolved at call time, so a test can set the env and see it. */
export function resetPasswordUrl(user: Pick<MailUser, "userType" | "locale">, token: string) {
  return resetPasswordPath(user, token, { site: siteOrigin(), admin: adminOrigin() });
}

/**
 * "Your password was changed" — sent for all three ways it can happen: a
 * self-service reset, an admin-initiated one (@repo/core), and a signed-in
 * change. A password moving without its owner hearing about it is the signal
 * worth having (ADR-079 #6).
 */
export async function sendPasswordChangedNotice(user: MailUser): Promise<void> {
  await sendTemplatedEmail({
    key: "auth.password_changed",
    to: user.email,
    locale: user.locale ?? undefined,
    recipientName: user.name ?? undefined,
    variables: { "changed.at": new Date().toISOString() },
  });
}

/**
 * "Your email address was changed" — to the PREVIOUS address, once a change
 * has landed (ADR-155 #2). It names the new address, so an owner whose account
 * was taken over learns where it went.
 */
async function sendEmailChangedNotice(
  user: MailUser,
  change: { from: string; to: string },
): Promise<void> {
  await sendTemplatedEmail({
    key: "auth.email_changed",
    to: change.from,
    locale: user.locale ?? undefined,
    recipientName: user.name ?? undefined,
    variables: { "changed.at": new Date().toISOString(), "email.new": change.to },
  });
}

/** Verification codes mailed per address per hour — the per-account half (security.md #13). */
const VERIFY_CODE_SENDS_PER_HOUR = 5;

/**
 * Mails a sign-up verification code (changes-61, ADR-184). The email-otp
 * plugin generates and stores the code (hashed); this only addresses it. An
 * address with no account gets nothing, and the caller cannot tell — the
 * plugin answers the same either way.
 */
async function sendVerificationCodeEmail(email: string, otp: string): Promise<void> {
  const limit = await rateLimit(
    `email:verify-code:${email.toLowerCase()}`,
    VERIFY_CODE_SENDS_PER_HOUR,
    60 * 60,
  );
  if (!limit.ok) return;
  const user = await db.user.findUnique({
    where: { email },
    select: { name: true, locale: true },
  });
  if (!user) return;
  await sendTemplatedEmail({
    key: "auth.verify_code",
    to: email,
    locale: user.locale ?? undefined,
    recipientName: user.name,
    variables: { "verify.code": otp, "expires.minutes": String(VERIFY_CODE_MINUTES) },
  });
}

/** The registration email (changes-61) — sent once, when sign-up creates the account. */
async function sendWelcomeEmail(user: MailUser): Promise<void> {
  await sendTemplatedEmail({
    key: "auth.welcome",
    to: user.email,
    locale: user.locale ?? undefined,
    recipientName: user.name ?? undefined,
    variables: {},
  });
}

/** Change-email requests per account per hour (ADR-155 #3). */
const CHANGE_EMAIL_LIMIT = 5;
const CHANGE_EMAIL_WINDOW_SECONDS = 3600;

const adapter = prismaAdapter(db, { provider: "mysql" });

const authOptions: BetterAuthOptions = {
  database: adapter,
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: process.env.BETTER_AUTH_URL,
  secondaryStorage: redisSecondaryStorage,

  session: {
    // security.md #11: sessions must be database-backed and revocable.
    // Without this, configuring secondaryStorage moves sessions to Redis
    // ONLY — ADR-001 finding #1.
    storeSessionInDatabase: true,
    // The site-wide default, and a LEARNER's whole story. A staff session is
    // shortened from here by `slideStaffExpiry` below — ADR-105 delivered
    // ADR-006 consequence #4's "shorter lifetime for staff" as an admin-owned
    // idle timeout rather than a second constant.
    expiresIn: 60 * 60 * 24 * 7, // 7 days
    cookieCache: {
      // Lets proxy.ts (ADR-006: gate, not boundary) read userType via
      // getCookieCache — a signed cookie, no DB round-trip — for the fast
      // optimistic STAFF check before any /admin/* route or layout runs.
      enabled: true,
      maxAge: 5 * 60,
    },
  },

  emailAndPassword: {
    enabled: true,
    // Verification is required to comment/access premium, not to read
    // (plan.md) — so sign-in itself is never blocked on it; gating happens
    // at the application layer (FeatureVisibility / permission checks),
    // not here.
    requireEmailVerification: false,
    // From @repo/contracts so the public sign-up screen (ADR-052) can state
    // and enforce the same minimum without importing this package.
    minPasswordLength: MIN_PASSWORD_LENGTH,
    maxPasswordLength: MAX_PASSWORD_LENGTH,
    resetPasswordTokenExpiresIn: RESET_TOKEN_MINUTES * 60, // per plan.md
    // A reset signs every session out: whoever knew the old password stops
    // being signed in (ADR-079 #6).
    revokeSessionsOnPasswordReset: true,
    password: {
      // Argon2id via @node-rs/argon2 overrides Better Auth's scrypt default.
      hash: (password) => hash(password, { algorithm: ARGON2ID }),
      verify: ({ hash: storedHash, password }) =>
        verify(storedHash, password, { algorithm: ARGON2ID }),
    },
    // `token`, not `url`: Better Auth's own URL points at its callback, and
    // the link has to land on OUR screen — which one depends on the user
    // (ADR-079 #2).
    sendResetPassword: async ({ user, token }) => {
      const mailUser = user as unknown as MailUser;
      const limit = await rateLimit(`email:reset:${user.id}`, RESET_SENDS_PER_HOUR, 60 * 60);
      // Over the limit, nothing is sent AND the response is unchanged: the
      // caller cannot tell a throttled address from an unknown one.
      if (!limit.ok) return;
      await sendTemplatedEmail({
        key: "auth.password_reset",
        to: user.email,
        locale: mailUser.locale ?? undefined,
        recipientName: user.name,
        variables: {
          "reset.url": resetPasswordUrl(mailUser, token),
          "expires.minutes": String(RESET_TOKEN_MINUTES),
        },
      });
    },
    // A completed reset clears the lockout — a reset is how a locked-out user
    // recovers, so leaving it in place would be a trap — audits itself, and
    // tells the owner (ADR-079 #6).
    onPasswordReset: async ({ user }) => {
      await db.user.update({
        where: { id: user.id },
        data: { failedLoginCount: 0, lockedUntil: null },
      });
      await db.auditLog.create({
        data: {
          userId: user.id,
          action: "auth.passwordReset.self",
          entityType: "User",
          entityId: user.id,
        },
      });
      await sendPasswordChangedNotice(user as unknown as MailUser);
    },
  },

  emailVerification: {
    sendOnSignUp: true,
    // ADR-184: TWO senders behind this one hook. A sign-up (or a resend for
    // the address the account already has) gets a six-digit CODE through the
    // email-otp plugin. A change of address arrives here with the NEW address
    // in `user.email` while the row still holds the old one; there is no
    // account at the new address for a code to verify, so it keeps ADR-155's
    // link — Better Auth's own callback, which flips `emailVerified` and
    // redirects to the screen's `callbackURL`.
    sendVerificationEmail: async ({ user, url }) => {
      const mailUser = user as unknown as MailUser;
      const stored = await db.user.findUnique({
        where: { id: user.id },
        select: { email: true },
      });
      if (verificationKind(stored?.email ?? null, user.email) === "code") {
        // Through the plugin's own endpoint, so the code is generated and
        // stored by the one thing that checks it; it calls back into
        // `sendVerificationCodeEmail`. `Auth`'s portable type does not carry
        // plugin endpoints, hence the cast.
        const api = authInstance.api as unknown as {
          sendVerificationOTP: (input: {
            body: { email: string; type: "email-verification" };
          }) => Promise<unknown>;
        };
        await api.sendVerificationOTP({ body: { email: user.email, type: "email-verification" } });
        return;
      }
      await sendTemplatedEmail({
        key: "auth.verify_email",
        to: user.email,
        locale: mailUser.locale ?? undefined,
        recipientName: user.name,
        variables: { "verify.url": url },
      });
    },
    afterEmailVerification: async (user) => {
      await db.user.update({ where: { id: user.id }, data: { status: "ACTIVE" } });
      // ADR-124: a newsletter opt-in ticked at sign-up waits on this proof.
      await notifyEmailVerified({ id: user.id, email: user.email });
    },
  },

  socialProviders: configuredSocialProviders(process.env),

  rateLimit: {
    enabled: true,
    storage: "secondary-storage",
    // Per IP. The per-ACCOUNT half lives in sendResetPassword, because these
    // two stop different attacks (security.md #13, ADR-079 #5).
    customRules: {
      "/request-password-reset": { window: 600, max: 3 },
      "/send-verification-email": { window: 600, max: 3 },
      // ADR-184: the plugin's defaults are 3 a minute; a code is a mail.
      "/email-otp/send-verification-otp": { window: 600, max: 3 },
      "/email-otp/verify-email": { window: 600, max: 10 },
      "/reset-password": { window: 600, max: 10 },
      // changes-49. Both were on Better Auth's built-in 3-per-10-seconds,
      // which is a burst limit, not a brute-force one: it allows 1,080
      // password guesses an hour from one address. The lockout below
      // (per ACCOUNT, exponential) stops a guess campaign against one
      // person; this stops one address walking many accounts. Sign-up is the
      // email-spam half — every sign-up sends a verification mail.
      "/sign-in/email": { window: 300, max: 10 },
      "/sign-up/email": { window: 3600, max: 5 },
      // ADR-155 #3: every request mails an address the requester chose. The
      // per-ACCOUNT half is in `hooks.before`.
      "/change-email": { window: 3600, max: 5 },
    },
  },

  advanced: {
    // Which header names the client (changes-49). The default is
    // `x-forwarded-for`, and nginx APPENDS to whatever the client sent there
    // (`$proxy_add_x_forwarded_for`), so any request carrying its own header
    // arrived as a two-entry list, which Better Auth refuses to trust — and
    // every such request then shared ONE rate-limit bucket per path. That is
    // a denial of service against sign-in, not a per-IP limit. `x-real-ip`
    // is `$remote_addr`, set by nginx and overwritten rather than appended
    // (docs/ops/deploy.md), so it is the one header a client cannot choose.
    // `x-forwarded-for` stays as the fallback for a host without it.
    ipAddress: {
      ipAddressHeaders: ["x-real-ip", "x-forwarded-for"],
    },
    // Sending happens AFTER the response (ADR-078 #11). It also closes the
    // timing side channel in anti-enumeration: a known address and an unknown
    // one now take the same time to answer, because neither waits for a
    // mail server (ADR-079 #4).
    backgroundTasks: {
      handler: (promise) => {
        try {
          after(() => promise);
        } catch {
          // No request scope — an integration test, or a script. Let it run
          // and swallow the rejection rather than crash the process on an
          // unhandled one; the delivery row records what happened either way.
          void promise.catch(() => {});
        }
      },
    },
  },

  user: {
    // ADR-155 #1: the link goes to the NEW address and nothing changes until
    // it is opened. Neither `sendChangeEmailConfirmation` nor
    // `updateEmailWithoutVerification` is set, so that is the only flow, for a
    // verified address and an unverified one alike.
    changeEmail: { enabled: true },
    additionalFields: {
      userType: { type: "string", defaultValue: "LEARNER", input: false },
      status: { type: "string", defaultValue: "PENDING_VERIFICATION", input: false },
      locale: { type: "string", defaultValue: "en" },
      timezone: { type: "string", defaultValue: "UTC" },
      themeMode: { type: "string", defaultValue: "SYSTEM" },
      firstName: { type: "string", required: false },
      lastName: { type: "string", required: false },
      phone: { type: "string", required: false },
      lastLoginAt: { type: "date", required: false, input: false },
      lastLoginIp: { type: "string", required: false, input: false },
      failedLoginCount: { type: "number", defaultValue: 0, input: false },
      lockedUntil: { type: "date", required: false, input: false },
      deletedAt: { type: "date", required: false, input: false },
    },
  },

  databaseHooks: {
    // ADR-123 #5: the two-factor flag is written in exactly one place per
    // direction, so the write IS the event worth auditing. The endpoint path
    // tells an enable from a disable; see `twoFactorAuditAction`.
    user: {
      // changes-61: the registration email, for a self-service sign-up only —
      // an account staff create, or a seed, is not a registration.
      create: {
        after: async (user, context) => {
          if (context?.path !== "/sign-up/email") return;
          await sendWelcomeEmail(user as unknown as MailUser);
        },
      },
      update: {
        after: async (user, context) => {
          const action = twoFactorAuditAction(
            context?.path,
            (user as { twoFactorEnabled?: boolean | null }).twoFactorEnabled,
          );
          if (action) await writeAccountAudit(user.id, action);

          // ADR-155 #2: an address change has just landed.
          const change = emailChangeFromToken(context?.path, context?.query);
          if (change && user.email === change.to) {
            await writeAccountAudit(user.id, "users.emailChange", {
              before: { email: change.from },
              after: { email: change.to },
            });
            await sendEmailChangedNotice(user as unknown as MailUser, change);
          }
        },
      },
    },
    session: {
      create: {
        before: async (session) => {
          const user = await db.user.findUnique({
            where: { id: session.userId },
            select: { lockedUntil: true },
          });
          if (user?.lockedUntil && user.lockedUntil > new Date()) return false;
          return;
        },
      },
      update: {
        // changes-38: the ADR-105 idle timeout was being UNDONE here. Better
        // Auth's own get-session refresh fires whenever
        // `expiresAt - expiresIn + updateAge <= now`, which a shortened staff
        // session satisfies on every call, and writes `now + 7 days` to
        // Redis and the row. The public site calls get-session on every page
        // (ADR-094), so one visit to the site re-armed a week-long session.
        // Clamp the refresh for STAFF to the configured timeout instead.
        //
        // changes-49: the same clamp for a LEARNER session under its own
        // setting. `userType` still decides which setting applies.
        before: async (data, context) => {
          if (!(data.expiresAt instanceof Date)) return;
          const current = (context?.context as { session?: { user?: { userType?: unknown } } })
            ?.session;
          const key = sessionTimeoutSettingKey(current?.user?.userType);
          if (!key) return;
          const setting = await getSetting(key);
          const expiresAt = clampStaffRefresh(
            data.expiresAt,
            setting === null ? null : adminSessionTimeoutMs(setting),
            Date.now(),
          );
          return expiresAt ? { data: { ...data, expiresAt } } : undefined;
        },
      },
    },
  },

  hooks: {
    // ADR-155 #3: changing the address is a LEARNER's self-service (staff edit
    // themselves at /keystone/profile), and it is limited per account as well
    // as per IP. No session is left to the endpoint's own middleware (401).
    before: createAuthMiddleware(async (ctx) => {
      // ADR-184: the email-otp plugin is here for ONE job, verifying an
      // address. Its send endpoint also takes `sign-in` / `forget-password`
      // types, which would mail a code nothing can use — a mail-bomb with a
      // friendly face — so anything but `email-verification` is refused.
      if (isRefusedOtpRequest(ctx.path, ctx.body)) throw new APIError("BAD_REQUEST");
      if (ctx.path !== "/change-email") return;
      const session = await getSessionFromCtx(ctx);
      if (!session) return;
      if ((session.user as { userType?: string }).userType !== "LEARNER") {
        throw new APIError("FORBIDDEN");
      }
      const limited = await rateLimit(
        `account:change-email:${session.user.id}`,
        CHANGE_EMAIL_LIMIT,
        CHANGE_EMAIL_WINDOW_SECONDS,
      );
      if (!limited.ok) throw new APIError("TOO_MANY_REQUESTS");
    }),
    after: createAuthMiddleware(async (ctx) => {
      // ADR-123 #5: a learner's password change from the profile page. The
      // same audit row and owner notice the staff action writes for itself
      // (ADR-079 #6) — HTTP calls only, so the staff path is not doubled.
      const changedBy = passwordChangedBy({
        path: ctx.path,
        request: ctx.request,
        returned: ctx.context.returned,
      });
      if (changedBy) {
        await writeAccountAudit(changedBy, "users.passwordChange");
        const user = (ctx.context.returned as { user?: MailUser }).user;
        if (user) await sendPasswordChangedNotice(user);
      }

      if (ctx.path === "/sign-in/email") {
        const email = (ctx.body as { email?: string } | undefined)?.email;
        if (!email) return;
        const returned = ctx.context.returned as
          { body?: { code?: string }; user?: { id: string } } | undefined;

        if (returned?.body?.code === "INVALID_EMAIL_OR_PASSWORD") {
          const user = await db.user.findUnique({
            where: { email },
            select: { id: true, failedLoginCount: true },
          });
          if (!user) return;
          const failedLoginCount = user.failedLoginCount + 1;
          const lockedUntil =
            failedLoginCount >= LOCKOUT_THRESHOLD
              ? new Date(Date.now() + computeLockoutSeconds(failedLoginCount) * 1000)
              : null;
          await db.user.update({ where: { id: user.id }, data: { failedLoginCount, lockedUntil } });
        } else if (returned?.user) {
          await db.user.update({
            where: { id: returned.user.id },
            data: { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() },
          });
        }
      }
    }),
  },

  plugins: [
    admin(),
    twoFactor(),
    bearer(),
    staffImpersonation(),
    recaptchaGuard(),
    // ADR-184: verification codes. NOT `overrideDefaultEmailVerification` —
    // that would route a change of address through a code too, and the new
    // address has no account to verify (see `sendVerificationEmail`).
    // `disableSignUp`: a code never creates an account; sign-up stays the
    // password form with its captcha and limits. Stored hashed, like every
    // other token we keep.
    emailOTP({
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "email-verification") return;
        await sendVerificationCodeEmail(email, otp);
      },
      expiresIn: VERIFY_CODE_MINUTES * 60,
      allowedAttempts: 5,
      disableSignUp: true,
      storeOTP: "hashed",
    }),
  ],

  // ADR-142 §3: impersonation goes through `staffImpersonation` alone. The
  // admin plugin's own pair authorises against a `user.role` string this
  // project never writes, and its stop endpoint writes no audit row — so both
  // are switched off rather than left as a second, unaudited door.
  //
  // ADR-184: the email-otp plugin's other doors — sign-in by code, password
  // reset by code, change-email by code, and a bare code check — would each be
  // a second, unaudited way past the password form, its lockout and its
  // captcha. Only `send-verification-otp` and `verify-email` stay open.
  disabledPaths: [
    "/admin/impersonate-user",
    "/admin/stop-impersonating",
    ...DISABLED_EMAIL_OTP_PATHS,
  ],
};

/**
 * The Better Auth instance — mount this in the route handler
 * (app/api/auth/[...all]/route.ts) and nowhere else. Everything that needs
 * "the current session" imports `auth` (the function below) instead; that's
 * the call shape @repo/rbac already depends on.
 *
 * Explicitly typed with the library's own portable `Auth`/`BetterAuthOptions`
 * names (not inferred) — betterAuth()'s inferred return type embeds an
 * internal Zod symbol TypeScript can't name across this module boundary
 * (verbatimModuleSyntax/isolatedModules), so a bare
 * `export const authInstance = betterAuth(...)` fails to typecheck.
 */
export const authInstance: Auth = betterAuth(authOptions);

/**
 * Enter a learner's session as staff (ADR-142 §3). The caller — the admin
 * server action — has already run `requirePermission("users.impersonate")`
 * and written the start audit row; this swaps the cookies. `Auth`'s portable
 * type does not carry plugin endpoints, hence the `api` hand-off.
 */
export function impersonateLearner(userId: string): Promise<{ ok: boolean }> {
  return startImpersonation(authInstance.api, userId);
}

// ─────────────────────────────────────────────────────────────
// Session helper — the exact call shape @repo/rbac already depends on:
// `const { auth } = await import("@repo/auth"); const session = await auth();`
// (Module 03's interim stub, plan.md's Module 04 implementation prompt).
// ─────────────────────────────────────────────────────────────

export interface Session {
  // The user object carries every additionalField at runtime (Better
  // Auth's own behavior); typed here beyond `id` because the admin layout's
  // STAFF re-check (ADR-006) needs userType, and every other consumer only
  // reads `.user.id` — a strictly additive extension of @repo/rbac's
  // original call shape, not a breaking one.
  user: { id: string; userType: "LEARNER" | "STAFF" };
  // ADR-105: the idle timeout is this row's own expiry, so `auth()` needs to
  // see it. Better Auth has always returned both fields; typing them is
  // additive and no consumer's call shape changes.
  // `token` since changes-38: the expiry is written through Better Auth's
  // internal adapter, which keys the Redis copy by token.
  session: { id: string; token: string; expiresAt: Date };
}

/**
 * How stale the stored expiry may get before `auth()` writes a new one
 * (ADR-105 #4). Continuous admin use therefore costs at most one indexed
 * single-row UPDATE a minute instead of one per request; the price is a
 * minute of accuracy on a control whose shortest setting is two.
 */
const EXPIRY_SLIDE_THRESHOLD_MS = 60_000;

/**
 * The slide threshold for a given timeout: a minute, or a quarter of the
 * timeout when that is shorter (ADR-128 #4). A flat minute on the two-minute
 * setting let a continuously active staff member's stored expiry fall to
 * sixty seconds ahead, which is inside the admin's warning window — the
 * dialog would ask "still there?" of someone who was typing.
 */
export function staffSlideThresholdMs(timeoutMs: number): number {
  return Math.min(EXPIRY_SLIDE_THRESHOLD_MS, Math.floor(timeoutMs / 4));
}

/**
 * The whole decision, with no clock and no database in it: given a session's
 * stored expiry, the configured timeout and the current time, the expiry to
 * WRITE — or `null` for "leave it alone".
 *
 * Pure and exported so it is unit-tested where it lives (testing.md's
 * judgement calls) rather than through a session round trip.
 *
 * Three cases, in the order they matter:
 *  - no timeout configured → nothing to do, including for a session that was
 *    shortened while the setting was on. Turning the timeout off must not
 *    retro-extend a session, only stop shortening new ones.
 *  - stored expiry is FURTHER out than the target → shorten it now. This is
 *    the 7-day default on a staff member's first authenticated call, and it is
 *    also what a lowered setting does to an existing session.
 *  - stored expiry has decayed → slide it forward, but only once the gap is
 *    worth a write (ADR-105 #4).
 */
export function nextStaffExpiry(
  expiresAt: Date,
  timeoutMs: number | null,
  now: number,
): Date | null {
  if (timeoutMs === null) return null;
  const target = now + timeoutMs;
  const current = expiresAt.getTime();
  if (current <= target && target - current < staffSlideThresholdMs(timeoutMs)) return null;
  return new Date(target);
}

/**
 * Better Auth's own session refresh, for a STAFF session: the expiry it may
 * write, or `null` to let the refresh through untouched (changes-38).
 *
 * With no timeout the refresh is the site-wide slide and is left alone. With
 * one, a refresh is still activity — the reader just loaded a page — so the
 * session slides to `now + timeout`, never further. Pure, like
 * `nextStaffExpiry`, so the rule is tested without a session round trip.
 */
export function clampStaffRefresh(
  requested: Date,
  timeoutMs: number | null,
  now: number,
): Date | null {
  if (timeoutMs === null) return null;
  const ceiling = now + timeoutMs;
  return requested.getTime() > ceiling ? new Date(ceiling) : null;
}

/**
 * Which idle-timeout setting governs a session, by the user's `userType`
 * (changes-49): the ADR-105 staff one, or its learner twin. `null` for a
 * session whose user type is neither, which is left alone.
 */
export function sessionTimeoutSettingKey(
  userType: unknown,
): "security.adminSessionTimeout" | "security.learnerSessionTimeout" | null {
  if (userType === "STAFF") return "security.adminSessionTimeout";
  if (userType === "LEARNER") return "security.learnerSessionTimeout";
  return null;
}

/**
 * Slide a session's expiry to `now + timeout`, so an idle one simply
 * EXPIRES rather than being flagged as idle somewhere a call site has to
 * remember to look (ADR-105 #1).
 *
 * A learner returns untouched: `userType` is what decides, not a role or a
 * permission, so the timeout cannot be turned off by a grant (security.md #3,
 * two locks).
 *
 * Failures are swallowed on purpose. This runs on the session path of every
 * authenticated request, and the worst case of a missed write is that the
 * session keeps the expiry it already had — refusing to authenticate because
 * a bookkeeping UPDATE lost a race would turn a hardening feature into an
 * outage.
 */
async function slideStaffExpiry(session: Session): Promise<Date | null> {
  // STAFF read the ADR-105 setting, LEARNERs its twin (changes-49). Still
  // decided by `userType`, never by a role.
  const key = sessionTimeoutSettingKey(session.user.userType);
  if (!key) return null;

  const setting = await getSetting(key);
  // A missing row is a database seeded before ADR-105: no timeout, which is
  // also what the row seeds to.
  const next = nextStaffExpiry(
    session.session.expiresAt,
    setting === null ? null : adminSessionTimeoutMs(setting),
    Date.now(),
  );
  if (!next) return null;

  try {
    // Through Better Auth's adapter, never `db.session.update` (changes-38).
    // With `secondaryStorage` configured, `findSession` reads REDIS first and
    // only falls back to the row, so a row-only write shortened a copy nobody
    // consulted: verified live, the row said +2 minutes while Redis and
    // get-session still said +7 days. `updateSession` writes both and resets
    // the Redis TTL to match.
    const ctx = await authInstance.$context;
    await ctx.internalAdapter.updateSession(session.session.token, { expiresAt: next });
    return next;
  } catch {
    // See the note above: a lost bookkeeping write is not a reason to refuse.
    return null;
  }
}

/**
 * Admin-initiated password replacement (changes-01 / Module 10, guarded at
 * the call site by `users.password.reset`). Uses Better Auth's own context
 * so the hash goes through the SAME Argon2id path sign-in verifies against
 * — NOT the admin plugin's api.setUserPassword, which would demand Better
 * Auth's own `user.role === "admin"` (a field this repo's RBAC deliberately
 * doesn't use). Session revocation and auditing stay with the caller
 * (@repo/core) — this only replaces the credential.
 */
export async function setUserPassword(userId: string, newPassword: string): Promise<void> {
  const ctx = await authInstance.$context;
  const hashed = await ctx.password.hash(newPassword);
  await ctx.internalAdapter.updatePassword(userId, hashed);
}

/**
 * End every session a user holds, in BOTH stores. `@repo/core`'s revocations
 * (password reset, deactivation, offboarding, two-factor reset, "sign out
 * everywhere") delete the MySQL rows, but with `secondaryStorage` configured
 * `findSession` reads REDIS first — so the row-only delete left each session
 * alive for its whole lifetime, and the next `auth()` that tried to refresh or
 * slide it hit a missing row and threw "Failed to get session" (the error an
 * admin resetting their OWN password saw on the very next render). Same lesson
 * as `slideStaffExpiry`'s changes-38 note: session writes go through the
 * adapter. `deleteUserSessions` purges the Redis copies and the
 * `active-sessions-*` list even when the rows are already gone.
 */
export async function revokeAllSessions(userId: string): Promise<void> {
  const ctx = await authInstance.$context;
  await ctx.internalAdapter.deleteUserSessions(userId);
}

/**
 * Push a user row that was written OUTSIDE Better Auth into its session copies
 * (ADR-125 §3).
 *
 * `updateOwnProfile` and `setOwnAvatar` write through `@repo/db`, and Better
 * Auth serves `session.user` from its Redis copy for the session's whole
 * lifetime — so without this a new name or picture is invisible to every
 * `get-session` for up to a week. `internalAdapter.updateUser` re-reads the row
 * and rewrites every live copy through the library's own
 * `refreshUserSessions`, so no Redis key format is spelled out here. The
 * user-update hook stays silent: `twoFactorAuditAction` keys on an endpoint
 * path and this call has none.
 *
 * The signed cookie cache is the browser's to refresh — the public session
 * provider re-reads with `disableCookieCache` after a change.
 */
export async function refreshSessionUser(userId: string): Promise<void> {
  const ctx = await authInstance.$context;
  await ctx.internalAdapter.updateUser(userId, { updatedAt: new Date() });
}

/**
 * Self-service password change for the signed-in user — Better Auth's own
 * endpoint logic (current-password verification included), invoked
 * server-side with the request's headers. Revokes other sessions so a
 * stolen session dies with the old password.
 * Throws Better Auth's APIError on a wrong current password.
 */
export async function changeOwnPassword(input: {
  currentPassword: string;
  newPassword: string;
}): Promise<void> {
  const result = await authInstance.api.changePassword({
    headers: await headers(),
    body: {
      currentPassword: input.currentPassword,
      newPassword: input.newPassword,
      revokeOtherSessions: true,
    },
  });
  // The same notice a reset sends (ADR-079 #6). `changePassword` throws on a
  // wrong current password, so reaching this line means it happened.
  if (result.user) await sendPasswordChangedNotice(result.user as unknown as MailUser);
}

export async function auth(): Promise<Session | null> {
  // disableCookieCache is load-bearing, not an optimization toggle — found
  // the hard way, not from docs: with session.cookieCache enabled (needed
  // for proxy.ts's fast gate), getSession serves the signed cookie's
  // snapshot by default, server-side calls included. A user demoted from
  // STAFF, or a revoked session, would still pass every check that reads
  // this without the flag for up to cookieCache.maxAge — silently
  // defeating ADR-006's "the layout re-verifies against the database, the
  // proxy is only a gate" guarantee. Better Auth's own source documents
  // disableCookieCache for exactly this: "a revoked-but-cached session
  // cannot authorize a sensitive action." Every consumer of `auth()`
  // (this module's own session.create.before/hooks.after, @repo/rbac's
  // requirePermission, the admin layout) is a sensitive check by
  // definition, so this is not optional here — only proxy.ts's
  // getCookieCache (a deliberately fast, non-authoritative gate) is meant
  // to read the cache.
  const result = await authInstance.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true },
  });
  const session = result as Session | null;
  // ADR-105. AFTER the read, so an already-expired session has been refused
  // by Better Auth's own validation before anything here can extend it — the
  // timeout must not be able to resurrect a session it was meant to end.
  if (session) {
    // Report the expiry that is now TRUE, not the one read before the slide:
    // the admin's idle watcher schedules its warning from this (ADR-128).
    const slid = await slideStaffExpiry(session);
    if (slid) session.session.expiresAt = slid;
  }
  return session;
}

/**
 * The current session WITHOUT counting the call as activity (ADR-128 #2):
 * no ADR-105 slide, and `disableRefresh` so Better Auth's own refresh does not
 * slide it either. Database-backed like `auth()` — the cookie cache would
 * answer for a session that has already expired.
 *
 * For the admin's idle watcher only, which must be able to ask "is this
 * session still alive, and for how long?" of an idle tab without the question
 * itself keeping it alive. Not an authorization check: a caller that is about
 * to DO something calls `auth()`.
 */
export async function peekSession(): Promise<Session | null> {
  const result = await authInstance.api.getSession({
    headers: await headers(),
    query: { disableCookieCache: true, disableRefresh: true },
  });
  return result as Session | null;
}
