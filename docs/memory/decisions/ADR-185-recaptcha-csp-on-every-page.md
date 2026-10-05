# ADR-185 — reCAPTCHA's origins are in the CSP on every page

- **Status:** Accepted
- **Date:** 2026-10-05
- **Module:** 14 (hardening), 04 (auth)
- **Supersedes:** ADR-156 #9 (the CSP names Google only on the pages that
  can load it). Everything else in ADR-156 stands.

## Context

ADR-156 #9 allowed Google's reCAPTCHA origins on exactly five paths:
`/keystone`, `/keystone/settings/general`, and the public `sign-in`,
`sign-up` and `support` pages. The proxy chose the policy from the
requested path.

A document keeps the Content-Security-Policy it was **first** served with
for the whole client-side session. A soft navigation fetches an RSC
payload, not a new document, so it never brings a new header. A reader who
lands on `/` and clicks "Sign in" runs the sign-in form under the home
page's policy, which named no Google origin. The production CSP log showed
the result on every such path (changes-62 #5). The form still worked only
because Google's loader degraded quietly, and a stricter browser or a
change on Google's side would have turned that into a sign-in nobody can
complete.

A per-page policy cannot be fixed by listing more pages. Any page that can
link to a form would need the allowance, and on this site that is every
page.

## Decision

1. **Every response carries the reCAPTCHA origins**, on both surfaces:
   - `script-src`: `www.google.com/recaptcha/`, `www.gstatic.com/recaptcha/`
   - `frame-src`: `www.google.com/recaptcha/`, `recaptcha.google.com/recaptcha/`
   - `connect-src`: `www.google.com/recaptcha/`

   On `/keystone` the script-src entries remain inert under
   `'strict-dynamic'`, exactly as ADR-156 #9 said.

2. **The allowance is path-scoped to `/recaptcha/`**, never the bare host.
   Nothing else on `www.google.com` or `gstatic.com` becomes loadable.
   `proxy.test.ts` asserts both halves.
3. **Whether the check is on stays a database setting** (ADR-156). An
   allowed origin loads nothing by itself: the script is only inserted
   where a guarded form mounts.

## Consequences

- The `RECAPTCHA_ADMIN_PATHS` / `RECAPTCHA_PUBLIC_PAGES` sets are gone, and
  so is the `recaptcha` parameter threaded through the CSP builders.
- The policy is slightly wider on pages without a form. The added surface
  is two Google paths that serve only reCAPTCHA. A script injection would
  first have to get past `'self'` and the same-origin `script-src`, and if
  it did, these paths would give it nothing it could not already do.
- Related, no decision needed: the `eval` violations in the same log were
  Zod v4 probing for `new Function` support while schemas load. The probe
  is caught and Zod falls back, so nothing broke. `instrumentation-client.ts`
  sets `jitless` before any schema is built, and the policy still has no
  `'unsafe-eval'`.
