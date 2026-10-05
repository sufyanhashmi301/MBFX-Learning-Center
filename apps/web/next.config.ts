import { fileURLToPath } from "node:url";
import { config } from "dotenv";
import type { NextConfig } from "next";
import createNextIntlPlugin from "next-intl/plugin";

// Next.js only auto-loads .env from this app's OWN directory
// (apps/web/.env), not the monorepo root — but every package in this repo
// (packages/db's prisma.config.ts, vitest setups, etc.) reads the ONE root
// .env by convention. Loaded explicitly here, and early (next.config.ts
// runs before most of the rest of Next's startup), so BETTER_AUTH_SECRET
// and friends are actually present — confirmed the hard way: a build
// without this silently ran with Better Auth's insecure default secret.
config({ path: fileURLToPath(new URL("../../.env", import.meta.url)) });

const ADMIN_CACHE_CONTROL = "private, no-cache, no-store, max-age=0, must-revalidate, no-transform";

// Next 16 auto-optimizes lucide-react and other known packages, and
// Turbopack is the default bundler — no optimizePackageImports or
// webpack-specific config needed (see docs/memory/decisions).
const nextConfig: NextConfig = {
  // No `X-Powered-By: Next.js` (changes-49): it tells a scanner which
  // framework — and so which advisories — to try, and tells a reader nothing.
  poweredByHeader: false,
  // No `Link: rel=preload` response headers from React (changes-64). By
  // default React lists a page's stylesheets, fonts and priority image in a
  // `Link` header, and Cloudflare's Early Hints caches that header per URL
  // and replays it as a `103` on every later request. The cached hints
  // outlive a deploy, so browsers preloaded the previous build's
  // stylesheets: "preloaded but not used" on every admin page, and a 404 for
  // a file only an October 1 build had. The home hint named yesterday's first
  // hero slide. The same resources are already at the top of the HTML head,
  // which streams at once, so the headers saved almost nothing. 0 leaves
  // React no room to write any.
  reactMaxHeadersLength: 0,
  // The admin's own Cache-Control, plus `no-transform` (changes-63 #8).
  //
  // Cloudflare's Email Address Obfuscation rewrites every address in the HTML
  // into markup React did not render. React then hits a text mismatch while
  // hydrating (minified error #418) and re-renders the page in the browser.
  // The admin layout's `<EmailOff>` markers only bracket the SHELL: every
  // route with a `loading.tsx` streams its body as a segment appended AFTER
  // the closing marker, so the address on /keystone/profile, the users table
  // and every record page was still rewritten. Cloudflare skips obfuscation
  // (and every other HTML rewrite) for `no-transform`, which covers every
  // segment wherever it lands.
  //
  // Next writes its own Cache-Control only when none is set yet
  // (`sendRenderResult`), so this value replaces it whole. It is the value
  // Next sends for a dynamic page, and the admin is always dynamic (ADR-006).
  // A route handler that sets its own still wins. The cost: Cloudflare no
  // longer re-encodes these responses as brotli, so admin HTML arrives with
  // Next's gzip.
  async headers() {
    return [
      {
        source: "/keystone/:path*",
        headers: [{ key: "Cache-Control", value: ADMIN_CACHE_CONTROL }],
      },
    ];
  },
  // Normally `.next`. The E2E harness sets it to something else so its own
  // server can run while `pnpm dev` is up: Next 16 takes a dev lock at
  // `<distDir>/lock` and REFUSES to start a second dev server sharing it
  // ("Another next dev server is already running"), which would otherwise
  // make `pnpm e2e` and `pnpm dev` mutually exclusive. It also keeps the two
  // build caches apart, which they should be — the E2E server runs against a
  // different database and a different origin.
  ...(process.env.NEXT_DIST_DIR ? { distDir: process.env.NEXT_DIST_DIR } : {}),
  transpilePackages: [
    "@repo/ui",
    "@repo/theme",
    "@repo/i18n",
    "@repo/settings",
    "@repo/rbac",
    "@repo/auth",
    "@repo/db",
    "@repo/core",
    "@repo/utils",
  ],
  images: {
    // YouTube thumbnails for the video facade (ADR-015 #9) go through the
    // optimizer; admin-entered cover URLs render `unoptimized` instead of
    // allowlisting arbitrary hosts here.
    remotePatterns: [{ protocol: "https", hostname: "i.ytimg.com" }],
    // ADR-130: one display quality, medium compression. Next's default of 75
    // re-compressed uploads already stored at 85 and softened them visibly.
    // With one entry every <Image> resolves to it, so no call site passes
    // `quality`.
    qualities: [85],
  },
  // ADR-004: required for "use cache"/cacheTag/cacheLife (packages/theme,
  // packages/rbac) to do anything at all — without this flag they're a
  // build-time no-op, not an error, so it's easy to silently ship uncached.
  cacheComponents: true,
  experimental: {
    // ADR-017: image uploads arrive as Server Action FormData. Next's default
    // cap is 1 MB; MAX_UPLOAD_BYTES (@repo/core media) is 5 MB, plus the
    // multipart overhead the installed docs say to leave room for.
    serverActions: { bodySizeLimit: "6mb" },
    // changes-46 (ADR-144 §4): `/keystone/:path*` runs through proxy.ts (the
    // STAFF gate), and Next buffers a proxied request body only up to this
    // limit — 10 MB by default — then hands the route handler a TRUNCATED
    // body without failing. Every video over 10 MB therefore reached
    // `/keystone/api/uploads/media` as "Failed to parse body as FormData", while
    // Settings → Media advertised a 100 MB video cap. Sized to that default
    // cap plus multipart overhead; an admin who raises `media.maxBytes.video`
    // past ~100 MB must raise this with it.
    proxyClientMaxBodySize: "110mb",
    // ADR-006 (multiple root layouts) + Module 06's root layout living at a
    // dynamic [locale] segment are exactly the two cases Next's own
    // internationalization/not-found docs name as unable to compose a
    // consistent app/not-found.tsx from layouts alone — app/global-not-
    // found.tsx (self-contained, its own <html>) is the documented fix.
    globalNotFound: true,
  },
};

// Points at @repo/i18n's request config (packages/i18n/src/request.ts).
// Must be a relative path, not absolute — Turbopack's next-intl support
// rejects an absolute path here even though it resolves correctly.
const withNextIntl = createNextIntlPlugin("../../packages/i18n/src/request.ts");

export default withNextIntl(nextConfig);
