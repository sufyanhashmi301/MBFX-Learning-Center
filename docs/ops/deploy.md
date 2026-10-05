# Deploying to a live Linux server

A runbook for one Node process behind nginx, with MariaDB and Redis on the
same host or nearby. The order of a first install is fixed by ADR-144:
`db:deploy` → `db:seed` → `seed:live` → build → start.

Paths used below (change them, but keep the shape):

| Path                      | What                                                    |
| ------------------------- | ------------------------------------------------------- |
| `/srv/mbx/app`            | the checkout (release directory)                        |
| `/srv/mbx/shared/.env`    | the environment, `chmod 600`, owned by the app user     |
| `/srv/mbx/shared/uploads` | `UPLOADS_DIR` — uploaded media, OUTSIDE the release dir |
| `mbx`                     | the unprivileged system user that runs the app          |

## 1. Prerequisites

- **Node.js 22.x LTS**, 22.13.0 or later (`engines: >=22.13.0`, `.nvmrc` = 22, ADR-145).
- **pnpm via corepack**, at the version pinned in the root `package.json`
  `packageManager` field — never a globally installed pnpm of another version:

  ```bash
  corepack enable
  cd /srv/mbx/app && corepack install   # installs the pinned pnpm
  pnpm --version
  ```

- **MariaDB** (a database and a user with full rights on it — Prisma Migrate
  needs DDL).
- **Redis**. Better Auth keeps its session cache and rate-limit counters there
  (`secondaryStorage` is always configured), so treat `REDIS_URL` as required
  for sign-in. Only the app's own IP rate limiter has an in-process fallback.
- **nginx** (or any TLS-terminating reverse proxy) and a certificate.
- Optional: **ffmpeg** on the host, for video compression (ADR-144 §4).
- Build needs no extra toolchain: `sharp` and Prisma ship prebuilt binaries
  (`allowBuilds` in `pnpm-workspace.yaml`).

## 2. Environment

One file, at the repo root as `.env` — `next.config.ts` and
`packages/db/prisma.config.ts` both load `../../.env` explicitly, so a
`.env` inside `apps/web` is not what they read. Keep the real file in
`shared/` and symlink it into each release:

```bash
ln -sfn /srv/mbx/shared/.env /srv/mbx/app/.env
```

`.env.example` is the template. Names only below — **never commit values**.

**Required**

| Variable                | Notes                                                                  |
| ----------------------- | ---------------------------------------------------------------------- |
| `DATABASE_URL`          | `mysql://user:pass@host:3306/db`                                       |
| `REDIS_URL`             | `redis://127.0.0.1:6379`                                               |
| `BETTER_AUTH_SECRET`    | `openssl rand -base64 32`; changing it signs everyone out              |
| `BETTER_AUTH_URL`       | the public origin, `https://example.com` — also the sitemap/RSS origin |
| `NEXT_PUBLIC_SITE_URL`  | same origin                                                            |
| `NEXT_PUBLIC_ADMIN_URL` | `https://example.com/admin`                                            |
| `UPLOADS_DIR`           | ABSOLUTE path, e.g. `/srv/mbx/shared/uploads` (see §7)                 |
| `NODE_ENV`              | `production` (set by the process manager)                              |

`NEXT_PUBLIC_*` values are inlined **at build time**: set them before
`build`, and rebuild if they change.

**Sealing keys** (security.md #10) — 32 bytes, base64, generate each with
`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
Each seals one provider credential stored in the database. **Losing or
changing one makes the stored credential unreadable** — back them up with the
same care as the database.

| Variable               | Seals                                                               |
| ---------------------- | ------------------------------------------------------------------- |
| `EMAIL_SECRET_KEY`     | the SMTP password (`EmailTransport`)                                |
| `MARKET_SECRET_KEY`    | the market data API key (`MarketProvider`)                          |
| `AI_SECRET_KEY`        | the AI provider API key (`AiProvider`)                              |
| `CAPTCHA_SECRET_KEY`   | Google's reCAPTCHA secret key (`CaptchaConfig`, ADR-156)            |
| `TRANSLATE_SECRET_KEY` | the Google Cloud Translation API key (`TranslateProvider`, ADR-160) |

**Scheduled jobs**

| Variable      | Notes                                                                                          |
| ------------- | ---------------------------------------------------------------------------------------------- |
| `CRON_SECRET` | bearer token for `/api/cron/*`; unset ⇒ every cron route answers 503. See [cron.md](./cron.md) |

**Optional**

| Variable                                                       | Notes                                                                                                                                    |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `FFMPEG_PATH`                                                  | e.g. `/usr/bin/ffmpeg`. Set ⇒ uploaded video is re-encoded to H.264/AAC MP4 and kept only if smaller. Unset ⇒ stored as uploaded         |
| `HOME_CONTENT_MODE`                                            | `real` hides the homepage's placeholder figures/quotes/partners (ADR-103). Default `demo`                                                |
| `GOOGLE_CLIENT_ID` / `_SECRET`, `GITHUB_CLIENT_ID` / `_SECRET` | OAuth; there is no OAuth UI yet, leave empty                                                                                             |
| `CAPTCHA_DISABLED`                                             | any value but `0`/`false` switches reCAPTCHA off whatever Settings → General → reCAPTCHA says (ADR-156). Break-glass for a Google outage |
| `PORT`                                                         | `next start` port. **This install serves on 3003** — the host's :3000 is a different app. Next's own default is 3000, so always pass it  |

**Seed-time only** — present while seeding, then **removed from the file**:
`SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`, and the `SEED_*` provider variables
in §4.

## 3. Install and migrate

```bash
cd /srv/mbx/app
pnpm install --frozen-lockfile     # dev deps included: the seeds run through tsx
pnpm db:generate                   # Prisma client
pnpm db:deploy                     # prisma migrate deploy
```

**Never `pnpm db:migrate` (migrate dev) or `pnpm db:reset` on a live
database.** `migrate deploy` only applies committed migrations; the other two
can create migrations or drop data.

## 4. Seed

```bash
pnpm db:seed      # permissions, roles, settings, flags, menus, the admin user
pnpm seed:live    # the demo corpus, theme/brand/settings, provider keys
```

**`pnpm db:seed`** is idempotent — every write is an upsert on a stable
business key, and it is written to repair drift without clobbering admin
edits — setting values, system role names and grants, and social links are
never overwritten (ADR-183), because every deploy re-runs it. It creates the super-admin only when `SEED_ADMIN_PASSWORD` is set
(otherwise it logs `SKIPPED admin user`). **Caveat:** with
`SEED_ADMIN_PASSWORD` set, a re-run RESETS that admin's password to it.

**`pnpm seed:live`** (ADR-144 §1) runs after it and:

- creates the starting corpus — two courses per school on top of the demo
  course `db:seed` writes (so three each), two quizzes and six video topics —
  and attaches the committed images (`packages/core/seed-live/media/`) to every
  seeded course, lesson, quiz, video topic, glossary topic, article and
  promotion that has none. Each file is stored through `storeMedia()` into `UPLOADS_DIR`; run it
  with the **same `UPLOADS_DIR`** the app uses (blank means
  `apps/web/storage/uploads`, which is what `next start` uses when blank);
- applies `packages/core/seed-live/defaults.json` — theme, brand assets,
  non-secret settings and flags — **once per database**, so an admin's later
  change survives a re-run. The `ai.*` settings are held back until an AI
  provider has a key, so AI never switches on over the placeholder ECHO driver.
  Glossary terms and the tool FAQs come from `db:seed`;
- for each provider whose variables are set, seals the key under the matching
  sealing key and stores it:

  | Provider | Variables                                                                                                                                                | Needs               |
  | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------- |
  | Market   | `SEED_MARKET_PROVIDER_KIND`, `SEED_MARKET_PROVIDER_API_KEY`                                                                                              | `MARKET_SECRET_KEY` |
  | AI       | `SEED_AI_PROVIDER_KIND`, `SEED_AI_PROVIDER_API_KEY`, `SEED_AI_PROVIDER_BASE_URL`, `SEED_AI_MODEL_LIGHT`, `SEED_AI_MODEL_STANDARD`, `SEED_AI_MODEL_HEAVY` | `AI_SECRET_KEY`     |
  | SMTP     | `SEED_SMTP_HOST`, `SEED_SMTP_PORT`, `SEED_SMTP_SECURITY`, `SEED_SMTP_USER`, `SEED_SMTP_PASSWORD`, `SEED_SMTP_FROM`                                       | `EMAIL_SECRET_KEY`  |

  Unset ⇒ that provider is skipped with a log line, never an error. A provider
  that already holds a key is left alone. Kind and model tiers default to what
  `defaults.json` recorded, so with the same AI vendor only the key is needed.

It is idempotent: a row it already created is left alone, so an admin's edit
survives a second run. **Afterwards delete every `SEED_*` line from
`/srv/mbx/shared/.env`.** The run ends with a summary line (courses per school,
quizzes, video topics, glossary terms) and warns if any tool is missing its FAQ.

`pnpm seed:export-defaults` is the other half: run it on a **dev machine**
against an install whose look you want to ship, commit the JSON it writes, and
deploy. It never runs on the server, and it refuses keys a sealed column owns.

## 5. Build and start

```bash
pnpm --filter web build     # next build → apps/web/.next
PORT=3003 pnpm --filter web start   # next start, listens on $PORT
```

`start` runs with `apps/web` as its working directory. Bind it to loopback
only and let nginx face the internet (`PORT=3003`, and `-H localhost` if you
call `next start` directly).

**`-H localhost`, never `-H 127.0.0.1`.** Found on the first live deploy: the
proxy's next-intl rewrite (`/` → `/en`) is built on a `localhost` origin, and
with the server bound to `127.0.0.1` Next treats that as an EXTERNAL rewrite
and fetches it over HTTP. The fetched `/en` then gets next-intl's
strip-the-default-prefix redirect back to `/`, so every public page answers
`307 → itself` forever while `/admin` (which never reaches next-intl) works.
Check after any change to the start command:
`curl -s -o /dev/null -w '%{http_code}
' http://localhost:3003/` must be 200.

`localhost` may resolve to IPv6 only (`::1`) — it did on the first live host,
so `curl http://127.0.0.1:3003/` answered `000` while `localhost` answered 200. nginx must then proxy to `http://[::1]:3003` (on CloudPanel: edit the
site's Vhost, `proxy_pass http://[::1]:{{app_port}};`). Check which one the
server bound: `ss -ltn | grep :3003`.

### pm2

```js
// /srv/mbx/ecosystem.config.cjs
module.exports = {
  apps: [
    {
      name: "mbx",
      cwd: "/srv/mbx/app/apps/web",
      script: "node_modules/next/dist/bin/next",
      args: "start -H localhost -p 3003",
      exec_mode: "fork", // pm2 defaults to cluster when `instances` is set
      // V8's own ceiling. Without it V8 sizes the heap from the host's RAM
      // (~2 GB on the live 8 GB box), sees no pressure below that, and lets
      // garbage pile up until pm2 kills the process at 1.5 GB (changes-62 #1).
      // The retained heap after a full crawl is ~280 MB, peaking ~420 MB
      // under six concurrent readers, so 768 MB forces collection long before
      // the restart line without starving a real peak.
      node_args: "--max-old-space-size=768",
      env: {
        NODE_ENV: "production",
        PORT: "3003",
        // glibc gives every thread its own malloc arena; sharp's image
        // workers then hold RSS the process never returns. Two is the
        // standard cap for a Node server that resizes images.
        MALLOC_ARENA_MAX: "2",
      },
      instances: 1, // one process; see "One process, not a cluster" below
      max_memory_restart: "1500M", // the safety net, not the mechanism
    },
  ],
};
```

`pm2 reload` does not re-read `node_args` or `env` from this file. After
changing either: `pm2 delete mbx && pm2 start ecosystem.config.cjs && pm2 save`.

**Why memory climbs page by page, then stops** (measured 2026-10-05, a full
sitemap crawl against a production build, three passes, then six at once):
Next keeps two in-memory caches, the `"use cache"` entries and the rendered
pages, each capped at 50 MB of serialized bytes. A cold process grows as it
renders pages it has not seen, then levels off at ~850 MB RSS once both are
full; the heap retained after a forced GC stays at ~280 MB from the second
pass on. That is not a leak. The restarts came from what sits on top of it:
concurrent renders, image optimisation (sharp is native memory, invisible to
V8), and V8 collecting late because nothing told it to collect sooner.

**One process, not a cluster.** Two instances would survive one restart, but
Next's `"use cache"` entries and their tags live in each process's memory. An
admin's save calls `revalidateTag` in the process that handled it, and the
other one serves the old page until its entries expire (Next's self-hosting
guide, "Multi-Instance Cache Coordination"). Running two needs a shared cache
handler that coordinates tags through Redis first.

```bash
pm2 start /srv/mbx/ecosystem.config.cjs && pm2 save && pm2 startup
```

### systemd

```ini
# /etc/systemd/system/mbx.service
[Unit]
Description=MBX Learning Center
After=network.target mariadb.service redis-server.service

[Service]
User=mbx
WorkingDirectory=/srv/mbx/app/apps/web
Environment=NODE_ENV=production PORT=3003
ExecStart=/usr/bin/node node_modules/next/dist/bin/next start -H localhost -p 3003
Restart=always
RestartSec=5
# The app reads /srv/mbx/app/.env itself (next.config.ts); no EnvironmentFile needed.

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now mbx
journalctl -u mbx -f
```

## 6. nginx

```nginx
server {
  listen 443 ssl http2;
  server_name example.com;

  ssl_certificate     /etc/letsencrypt/live/example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/example.com/privkey.pem;

  # Video uploads: the seeded cap is 100 MiB (media.maxBytes.video). Keep this
  # above whatever Settings → Media says, or nginx answers 413 first.
  client_max_body_size 110m;

  # Serve hashed build assets from disk, never through the app. Next does not
  # answer a missing /_next/static/* file with a bare 404: the request falls
  # through to the app router and renders the prerendered not-found page,
  # which replies with THAT page's cache headers (`s-maxage=300` plus a year
  # of `stale-while-revalidate`). One request landing in the build window —
  # `next build` rewrites .next/static in place while the old process still
  # serves traffic — therefore teaches the CDN that a chunk does not exist,
  # and the edge keeps serving that 404 long after the file is back. It took
  # the site down twice on 2026-09-23, both times on the stylesheet holding
  # Tailwind. nginx answers a missing file with its own bare 404, which
  # carries no cache headers for an edge to pin, so this closes the class
  # rather than the instance. The hit also never reaches Node.
  location /_next/static/ {
    alias /srv/mbx/app/apps/web/.next/static/;
    access_log off;
    expires 1y;
    add_header Cache-Control "public, max-age=31536000, immutable";
  }

  location / {
    proxy_pass http://127.0.0.1:3003;
    proxy_http_version 1.1;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header Upgrade           $http_upgrade;
    proxy_set_header Connection        "upgrade";
    proxy_read_timeout  300s;   # video compression and market-sync can be slow
    proxy_send_timeout  300s;
    proxy_request_buffering off; # stream large uploads through
  }
}

server {
  listen 80;
  server_name example.com;
  return 301 https://$host$request_uri;
}
```

Other media caps (seeded, editable in Settings → Media): image 5 MiB, audio
and document 20 MiB.

**Security headers are the app's (ADR-146).** The proxy sets
`Content-Security-Policy`, `Strict-Transport-Security` (production),
`X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` and
`Permissions-Policy` on every response. Do not add them again in nginx: a
vhost that also has `add_header X-Frame-Options …` / `Referrer-Policy …`
lines (CloudPanel's default template does) sends each header twice, and two
`Referrer-Policy` values conflict. Remove those `add_header` lines from the
site's vhost. Keep `X-Real-IP $remote_addr` as above — Better Auth's per-IP
rate limit reads it first.

**The staff sign-in is `/keystone`** (ADR-146). `/admin/sign-in` answers
404, and so does any `/admin/*` address without a staff session. Bookmark
`https://example.com/keystone`.

## 7. Uploads

- `UPLOADS_DIR` must be an **absolute path outside the release directory**.
  Left blank, the local driver writes to `<cwd>/storage/uploads` — for
  `next start` that is `apps/web/storage/uploads`, inside the checkout, and
  it is lost on the next fresh clone. `seed:live` runs from `packages/core`;
  with a blank value it pins itself to `apps/web/storage/uploads` so its images
  land where `next start` reads, but set it explicitly in production.
- Owned by the app user: `install -d -o mbx -g mbx -m 750 /srv/mbx/shared/uploads`.
- Keys are `<category>/<random>.<ext>` (ADR-144 §3) — back up the whole tree.
- Files are served only through the `/uploads/...` route handler, never by
  nginx directly: do not add an nginx `location /uploads` alias.

## 8. Scheduled jobs

Set `CRON_SECRET`, restart, then schedule the four routes as described in
**[cron.md](./cron.md)** — `market-sync` and `publish-due` every 15 minutes,
`translate` every 5 minutes (it fills in a newly switched-on language), and
`housekeeping` daily (housekeeping is the one that matters for privacy).

## 9. Backups

```bash
# Database — consistent dump without locking InnoDB tables
mysqldump --single-transaction --routines --triggers \
  -u backup -p mbfx_learning_center | gzip > /backup/db-$(date +%F).sql.gz

# Uploads
rsync -a --delete /srv/mbx/shared/uploads/ backup-host:/backup/mbx-uploads/
```

Back up `/srv/mbx/shared/.env` separately and securely: without the three
sealing keys a restored database's provider credentials cannot be opened
(they must then be re-entered in the admin).

## 10. First sign-in

1. Seed with `SEED_ADMIN_EMAIL` and a strong one-off `SEED_ADMIN_PASSWORD`.
2. Sign in at `https://example.com/keystone`.
3. Change the password at `/admin/profile`, then **remove `SEED_ADMIN_PASSWORD`** from
   the env file — a later `db:seed` with it still set resets the password.
4. Check `/admin/settings` (site identity, email), `/admin/market/provider`
   and `/admin/settings/ai` show the providers `seed:live` configured.

## 11. Updating a live install

```bash
cd /srv/mbx/app
git pull --ff-only
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:deploy
pnpm db:seed        # safe to re-run (upserts); make sure SEED_ADMIN_PASSWORD is NOT set
pnpm --filter web build
systemctl restart mbx          # or: pm2 reload mbx
```

`seed:live` does not need re-running on an update; running it again only adds
what is missing.

**Zero downtime.** `next build` writes into `apps/web/.next` under a running
server, and the old process can serve broken asset URLs until it restarts. For
no gap, deploy each release to its own directory
(`/srv/mbx/releases/<sha>`, `.env` symlinked in), build there, then switch a
`/srv/mbx/app` symlink and restart — or build with `NEXT_DIST_DIR` set to a
fresh directory. Migrations must stay backward compatible with the release
still running while they apply. Keep one instance: `revalidateTag` and the
in-process rate-limit fallback are per-process.

**`scripts/deploy-release.sh` does exactly that, and is the one to use on the
live host** (2026-10-02). The step-by-step for learn.mbxpro.com — deploy,
rollback, and the rules that keep live data safe — is `updating-live.md`. It never writes to the directory the running server
reads from:

```
~/htdocs/<site>           symlink → ~/releases/<current>   (pm2's cwd goes through it)
~/releases/<stamp>-<sha>/ one checkout + node_modules + .next per deploy
~/shared/.env             the environment, symlinked into every release
~/shared/uploads          UPLOADS_DIR (absolute, outside the releases)
~/shared/repo.git         bare cache of origin, created on the first run
```

```bash
bash ~/htdocs/learn.mbxpro.com/scripts/deploy-release.sh             # deploy origin/main
bash ~/htdocs/learn.mbxpro.com/scripts/deploy-release.sh --rollback  # previous release, no rebuild
```

It clones the branch into a new release, symlinks `.env`, then install →
generate → database dump (`~/backups/deploys`, newest ten kept) → migrate
deploy → seed → build there while the old release keeps
serving. Only a finished build is swapped in, by an atomic rename of the
symlink, followed by `pm2 reload --update-env` with that release's
`NEXT_DEPLOYMENT_ID`. It then checks that the homepage answers and that the
stylesheet it links answers 200 under the new `?dpl=`; if either fails it
switches back and reloads the previous release by itself. On success it runs
`pm2 save` (or a reboot's `pm2 resurrect` restores an older deployment id),
purges Cloudflare when `CF_API_TOKEN`/`CF_ZONE_ID` are set, and keeps the
newest three releases (`KEEP=`). A failure before the switch leaves the live
site untouched. It refuses to start without `~/shared/.env`, with
`SEED_ADMIN_PASSWORD` set, with a relative `UPLOADS_DIR`, or when the live
release's own `.env` differs from the shared one. The pm2 reload of a single
fork-mode process is still a restart of a few seconds (nginx answers 502,
which Cloudflare does not cache); what disappears is the build window.

Two things it cannot fix: a migration still applies while the old release is
serving (keep them backward compatible), and the `location /_next/static/`
block in §6 is still worth adding — it must point at the symlink
(`~/htdocs/<site>/apps/web/.next/static/`), never at a release directory.

`scripts/deploy.sh` (in place, below) is kept for installs without the
release layout.

`scripts/deploy.sh` is that whole sequence in one command
(`bash /srv/mbx/app/scripts/deploy.sh`), so the order cannot drift between
whoever deploys. It refuses to run against a dirty checkout or an `.env` that
still has `SEED_ADMIN_PASSWORD` in it, and it never runs `db:migrate` or
`db:reset`.

**A CDN in front turns that gap into an outage.** Next does not answer a
missing `/_next/static/*` file with a bare 404 — the request falls through to
the app router and renders the prerendered not-found page, which replies with
_that page's_ cache headers (`s-maxage=300` plus a year of
`stale-while-revalidate`). So a single request landing in the build window
teaches the edge that a hashed chunk does not exist, and it keeps serving that
404 long after the file is back. On 2026-09-23 the chunk was the one holding
Tailwind, and every page on the site rendered unstyled while the origin was
serving the file correctly the whole time. Diagnose it by asking the origin
past the cache — if `?cb=1` on the same URL returns 200 and the clean URL
returns `404` with `cf-cache-status: HIT`, this is what happened.

Set `CF_API_TOKEN` and `CF_ZONE_ID` in `.env` and `scripts/deploy.sh` purges
the zone after the restart, which closes it. The token needs one permission,
Zone · Cache Purge · Purge. To purge by hand:

```bash
curl -sS -X POST "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" \
  --data '{"purge_everything":true}'
```

A purge does not reach browsers that already cached the 404 — Cloudflare hands
it to them with a four-hour `max-age`, so a visitor from the broken window
stays broken until that expires or they hard-reload. The durable fix is the
release-directory swap above: with no window, nothing 404s and nothing is
worth purging. Before that lands, the nginx `location /_next/static/` block
in §6 is what actually closes it; a Cloudflare cache rule on
`/_next/static/*` setting the 404 edge TTL to no-store is the same idea one
hop further out.

**The fix that needs no CDN credentials is the nginx `location
/_next/static/` block in §6**, which serves hashed assets from disk so a
missing one returns nginx's bare 404 — no cache headers, nothing for an edge
to pin. Add it and the class is closed regardless of who can log in to
Cloudflare.

**`NEXT_DEPLOYMENT_ID` is a second layer, and it does not cover stylesheets.**
`scripts/deploy.sh` exports `NEXT_DEPLOYMENT_ID="$(git rev-parse --short
HEAD)"` before the build, which is Next's own cache-busting hook: static
asset URLs gain `?dpl=<sha>`, so a deploy asks for those assets under URLs
the edge has never seen. **Measured on 16.3.3, the `<link>` tags for CSS come
out with no suffix** even with `deploymentId` present in
`.next/required-server-files.json` — JS reads `config.deploymentId` while CSS
reads `config.clientAssetToken` (`next/dist/build/index.js`), and only the
first survived to the served HTML here. Since the stylesheet is the asset
whose loss takes the whole site down, do not rely on this alone; it is worth
keeping for JS and for skew protection, not as the answer. Check it rather
than assume it:

```bash
curl -s https://example.com/ | grep -o '/_next/static/[^"]*\.css[^"]*'
```

Set it only in the environment — `deploymentId` in `next.config.ts` as well
makes the build refuse on the mismatch. Two consequences worth knowing: the id
is part of the `"use cache"` key, so every deploy starts those caches cold
(a fresh build does that anyway), and the running process does not have the
variable unless you pass it at restart (`pm2 reload mbx --update-env` with it
exported). **A STALE value is worse than none** (2026-10-02): pages rendered at
request time link their CSS and JS under the RUNTIME id, so a process still
carrying an older deploy's id serves `?dpl=<old>` asset URLs beside the build's
`?dpl=<new>` ones, the edge caches a 404 for one of them, and the skew check
fails. `scripts/deploy.sh` reloads with `--update-env` for this reason.

**Early Hints replays a previous build's stylesheets (2026-10-05, changes-64).**
Cloudflare's Early Hints (Speed → Optimization) caches a page's `Link:
rel=preload` response header per URL and answers later requests with a `103`
naming those files before the page arrives. The cached header outlives a
deploy, so browsers preloaded the old build's CSS ("preloaded but not used"
on every admin page) and, for files no release still holds, got a 404. The app
no longer sends the header (`reactMaxHeadersLength: 0` in `next.config.ts`),
so there is nothing new to cache. Hints cached before that deploy can linger
for a while; switching Early Hints off in the dashboard clears them at once and
costs nothing here, since the stylesheets head the HTML anyway. Check it:

```bash
curl -s --http2 -D - -o /dev/null https://example.com/some-page | grep -iE '^(HTTP|link)'
```

Run it twice. A `HTTP/2 103` line on the second run means Cloudflare is still
replaying hints.
