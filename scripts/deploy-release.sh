#!/usr/bin/env bash
# Deploy a live install into a FRESH release directory, then switch to it.
# Runs ON THE SERVER, as the app user, through the live symlink:
#
#   bash ~/htdocs/learn.mbxpro.com/scripts/deploy-release.sh             # deploy origin/main
#   BRANCH=release bash ~/htdocs/learn.mbxpro.com/scripts/deploy-release.sh
#   bash ~/htdocs/learn.mbxpro.com/scripts/deploy-release.sh --rollback  # back to the previous release
#
# Why not scripts/deploy.sh: that one builds inside the directory the running
# server reads from, so for the minutes `next build` takes, the live process
# can be asked for chunks the build has deleted or not written yet. Next
# answers those with its prerendered not-found page and ITS cache headers, and
# Cloudflare pins the 404 (2026-09-23 and 2026-10-02). Here the live
# directory is never written to: the build happens in releases/<stamp>-<sha>,
# and only a finished build is swapped in, by one atomic rename of the
# symlink (docs/ops/deploy.md §11).
#
# Layout (CloudPanel site, as on the live host):
#
#   ~/htdocs/<site>        symlink → ~/releases/<current>   (pm2's cwd goes through it)
#   ~/releases/<stamp>-<sha>/   one checkout + node_modules + .next per deploy
#   ~/shared/.env          the environment, symlinked into every release
#   ~/shared/uploads       UPLOADS_DIR — must be absolute and outside releases
#   ~/shared/repo.git      bare cache of origin, so a release clones locally
#
# Order: fetch → clone → install → generate → migrate deploy → seed → build →
# switch → reload → health check (rolls back on failure) → pm2 save → purge →
# prune. Migrations apply while the OLD release is still serving, so they must
# stay backward compatible with it — the same rule §11 already states. It never
# runs `db:migrate` or `db:reset`.
set -euo pipefail

log() { printf '\n==> %s\n' "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }

# The live symlink is the path this script was invoked through: `pwd -L` keeps
# the symlink instead of resolving it to the release it currently points at.
LIVE_LINK="${LIVE_LINK:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd -L)}"
RELEASES_DIR="${RELEASES_DIR:-$HOME/releases}"
SHARED_DIR="${SHARED_DIR:-$HOME/shared}"
BRANCH="${BRANCH:-main}"
SERVICE="${SERVICE:-mbx}"
KEEP="${KEEP:-3}"
# This install serves on 3003; the host's :3000 is a different app (§5).
PORT="${PORT:-3003}"
export PORT

[ -L "$LIVE_LINK" ] || die "$LIVE_LINK is not a symlink. Run this through the live symlink (e.g. ~/htdocs/<site>/scripts/deploy-release.sh), or set LIVE_LINK."
[ -f "$SHARED_DIR/.env" ] || die "No $SHARED_DIR/.env — every release symlinks its .env from there."

# A non-interactive SSH session does not load nvm, so pnpm is not on PATH.
if ! command -v pnpm >/dev/null 2>&1; then
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
fi
command -v pnpm >/dev/null 2>&1 || die "pnpm not found (nvm not loaded?)."

env_value() {
  sed -n "s/^[[:space:]]*$1=//p" "$SHARED_DIR/.env" | head -n 1 | tr -d "'" | tr -d '"'
}

# Only one deploy at a time: two would race on the symlink and on migrations.
mkdir -p "$RELEASES_DIR"
exec 9>"$RELEASES_DIR/.deploy.lock"
flock -n 9 || die "Another deploy is running (lock: $RELEASES_DIR/.deploy.lock)."

CURRENT="$(readlink -f "$LIVE_LINK")"

# Points the live symlink at $1 atomically: a new link beside it, then rename()
# over the old one. `ln -sfn` alone is unlink + create, a moment with no link.
switch_to() {
  ln -sfn "$1" "$LIVE_LINK.next"
  mv -Tf "$LIVE_LINK.next" "$LIVE_LINK"
}

# The id must match the release's build, or pages rendered at request time
# link assets under a different `?dpl=` than the prerendered ones (2026-10-02).
reload_app() {
  NEXT_DEPLOYMENT_ID="$1"
  export NEXT_DEPLOYMENT_ID
  if [ -n "${RESTART_CMD:-}" ]; then
    eval "$RESTART_CMD"
  elif command -v pm2 >/dev/null 2>&1 && pm2 describe "$SERVICE" >/dev/null 2>&1; then
    pm2 reload "$SERVICE" --update-env
  elif systemctl cat "$SERVICE.service" >/dev/null 2>&1; then
    sudo systemctl restart "$SERVICE"
  else
    die "No pm2 process or systemd unit named '$SERVICE'. Start the app yourself, or set RESTART_CMD."
  fi
}

# Healthy = the homepage answers AND the stylesheet it links answers 200 under
# the expected deployment id. The stylesheet is the asset whose loss renders
# the whole site unstyled, so it is the one worth checking by name.
# `localhost`, never 127.0.0.1: here it resolves to ::1 (§5).
check_health() {
  local want_dpl="$1" status html css css_status
  for _ in $(seq 1 15); do
    status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$PORT/" || true)"
    case "$status" in 2??|3??) break ;; esac
    sleep 2
  done
  case "$status" in 2??|3??) ;; *) echo "Homepage answered ${status:-nothing}." >&2; return 1 ;; esac

  html="$(curl -sL --max-time 20 "http://localhost:$PORT/" || true)"
  css="$(printf '%s' "$html" | grep -o '/_next/static/[^"\\]*\.css[^"\\]*' | head -n 1 || true)"
  [ -n "$css" ] || { echo "Homepage links no stylesheet." >&2; return 1; }
  case "$css" in
    *"dpl=$want_dpl"*) ;;
    *) echo "Stylesheet $css is not under dpl=$want_dpl — the process has a stale NEXT_DEPLOYMENT_ID." >&2; return 1 ;;
  esac
  css_status="$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "http://localhost:$PORT$css" || true)"
  [ "$css_status" = 200 ] || { echo "Stylesheet $css answered $css_status." >&2; return 1; }
  echo "OK — homepage $status, $css 200"
}

release_sha() { git -C "$1" rev-parse --short HEAD; }

# The NEXT_DEPLOYMENT_ID a release was BUILT with, which is not always its
# HEAD: a directory updated by `git pull` without a rebuild (the original
# in-place install) serves an older build. Recorded at build time; for a
# release that predates the record, read back from a compiled stylesheet,
# whose font URLs carry the build's `?dpl=`.
release_id() {
  if [ -s "$1/.deployment-id" ]; then
    cat "$1/.deployment-id"
    return
  fi
  local found
  found="$(grep -ho 'dpl=[0-9A-Za-z_-]*' "$1"/apps/web/.next/static/chunks/*.css 2>/dev/null | head -n 1 | cut -d= -f2 || true)"
  if [ -n "$found" ]; then echo "$found"; else release_sha "$1"; fi
}

# --rollback: point the link back at the newest release older than the current
# one and reload. No build, no migration — the database stays where it is.
if [ "${1:-}" = "--rollback" ]; then
  PREVIOUS=""
  while IFS= read -r dir; do
    [ "$dir" = "$CURRENT" ] && continue
    [ -d "$dir/apps/web/.next" ] || continue
    PREVIOUS="$dir"; break
  done < <(ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's#/$##')
  [ -n "$PREVIOUS" ] || die "No earlier built release in $RELEASES_DIR to roll back to."
  log "Rolling back $(basename "$CURRENT") → $(basename "$PREVIOUS")"
  switch_to "$PREVIOUS"
  SHA="$(release_id "$PREVIOUS")"
  reload_app "$SHA"
  check_health "$SHA" || die "Rolled back, but the app is not healthy. pm2 logs $SERVICE --lines 50"
  command -v pm2 >/dev/null 2>&1 && pm2 save >/dev/null
  log "Live: $(basename "$PREVIOUS")"
  exit 0
fi

# db:seed RESETS the admin's password to SEED_ADMIN_PASSWORD when it is set,
# so a forgotten line would silently undo the password change the admin made
# after first sign-in. Refuse rather than warn.
if grep -Eq '^[[:space:]]*SEED_ADMIN_PASSWORD=["'"'"']?[^"'"'"'[:space:]]' "$SHARED_DIR/.env"; then
  die "SEED_ADMIN_PASSWORD is set in $SHARED_DIR/.env — a seed would reset the admin password. Remove that line and run again."
fi

# Uploads written inside a release would vanish with its directory.
UPLOADS_DIR_VALUE="$(env_value UPLOADS_DIR)"
case "$UPLOADS_DIR_VALUE" in
  /*) case "$UPLOADS_DIR_VALUE" in "$RELEASES_DIR"/*) die "UPLOADS_DIR is inside $RELEASES_DIR." ;; esac ;;
  *) die "UPLOADS_DIR in $SHARED_DIR/.env must be an absolute path outside the releases (§7)." ;;
esac

# The live release may still carry its own .env from before this layout; a
# release built from shared/.env must not quietly run with different values.
if [ -f "$CURRENT/.env" ] && [ ! -L "$CURRENT/.env" ] && ! cmp -s "$CURRENT/.env" "$SHARED_DIR/.env"; then
  die "$CURRENT/.env differs from $SHARED_DIR/.env. Make $SHARED_DIR/.env the one you want, then run again."
fi

# A local bare cache of origin: each release clones from it with --shared, so
# a deploy downloads only the new commits and a release's .git is tiny.
REPO="$SHARED_DIR/repo.git"
if [ ! -d "$REPO" ]; then
  log "Creating the repository cache $REPO"
  ORIGIN_URL="$(git -C "$CURRENT" remote get-url origin)"
  git clone --bare "$CURRENT" "$REPO"
  git -C "$REPO" remote set-url origin "$ORIGIN_URL"
fi

log "Fetching origin/$BRANCH"
git -C "$REPO" fetch --prune origin "+refs/heads/*:refs/heads/*"
SHA="$(git -C "$REPO" rev-parse --short "refs/heads/$BRANCH")"
CURRENT_SHA="$(release_sha "$CURRENT" 2>/dev/null || echo none)"
CURRENT_ID="$(release_id "$CURRENT")"
echo "Live: $(basename "$CURRENT") (built as $CURRENT_ID) → deploying $SHA"
git -C "$REPO" --no-pager log --oneline "$CURRENT_SHA..$SHA" 2>/dev/null || true

RELEASE="$RELEASES_DIR/$(date -u +%Y%m%d%H%M%S)-$SHA"
log "Creating $RELEASE"
git clone --quiet --shared --no-checkout "$REPO" "$RELEASE"
git -C "$RELEASE" checkout --quiet --detach "$SHA"
ln -s "$SHARED_DIR/.env" "$RELEASE/.env"

# From here until the switch, a failure leaves the live site untouched; the
# half-built directory stays for inspection and is pruned by a later deploy.
trap 'echo "Deploy FAILED before the switch — the live site is unchanged. Partial release: $RELEASE" >&2' ERR

cd "$RELEASE"

log "Installing dependencies"
pnpm install --frozen-lockfile

log "Generating the Prisma client"
pnpm db:generate

# A snapshot of the live database before anything writes to it — the one
# thing --rollback cannot undo is a migration or a seed. The deploy stops if
# the dump fails. Credentials come from DATABASE_URL (decoded by node, since a
# password may be percent-encoded) and reach the dump through MYSQL_PWD, never
# argv, where `ps` would show them.
BACKUP_DIR="${BACKUP_DIR:-$HOME/backups/deploys}"
KEEP_DUMPS="${KEEP_DUMPS:-10}"
log "Backing up the database to $BACKUP_DIR"
mkdir -p "$BACKUP_DIR"
chmod 700 "$BACKUP_DIR"
DUMP="$BACKUP_DIR/$(basename "$RELEASE").sql.gz"
DB_PARTS="$(DATABASE_URL="$(env_value DATABASE_URL)" node -e '
  const u = new URL(process.env.DATABASE_URL);
  console.log([u.hostname, u.port || "3306", decodeURIComponent(u.username),
    decodeURIComponent(u.password), u.pathname.slice(1)].join("\n"));
')"
{ read -r DB_HOST; read -r DB_PORT; read -r DB_USER; read -r DB_PASS; read -r DB_NAME; } <<< "$DB_PARTS"
DUMP_BIN="$(command -v mariadb-dump || command -v mysqldump)" || die "Neither mariadb-dump nor mysqldump is installed."
( umask 077
  MYSQL_PWD="$DB_PASS" "$DUMP_BIN" --single-transaction --quick --routines --triggers \
    -h "$DB_HOST" -P "$DB_PORT" -u "$DB_USER" "$DB_NAME" | gzip > "$DUMP" )
gzip -t "$DUMP" && [ "$(stat -c %s "$DUMP")" -gt 1024 ] || die "The database dump $DUMP is empty or corrupt."
echo "Saved $DUMP ($(du -h "$DUMP" | cut -f1))"
ls -1t "$BACKUP_DIR"/*.sql.gz 2>/dev/null | tail -n +"$((KEEP_DUMPS + 1))" | xargs -r rm -f --

log "Applying committed migrations (the old release is still serving)"
pnpm db:deploy

log "Seeding (idempotent upserts)"
pnpm db:seed

log "Building"
# Every static asset URL gets `?dpl=<sha>` (Next reads NEXT_DEPLOYMENT_ID from
# the environment — do NOT also set `deploymentId` in next.config.ts). New URLs
# per deploy mean an edge entry poisoned by an earlier deploy is never asked
# for again.
NEXT_DEPLOYMENT_ID="$SHA"
export NEXT_DEPLOYMENT_ID
pnpm --filter web build
echo "$SHA" > "$RELEASE/.deployment-id"

# The optimised-image cache outlives a release (changes-62 #1). Kept inside
# each release, every deploy started cold, and the first visitors after it
# had sharp re-encode every picture on the site at once, the native memory
# spike that pushed the process past pm2's limit. An upload's URL never
# changes its bytes, so sharing it is safe; a replaced file under /public
# keeps its old variant until Next's own TTL lapses (`minimumCacheTTL`).
log "Linking the shared image cache"
mkdir -p "$SHARED_DIR/next-image-cache" "$RELEASE/apps/web/.next/cache"
rm -rf "$RELEASE/apps/web/.next/cache/images"
ln -s "$SHARED_DIR/next-image-cache" "$RELEASE/apps/web/.next/cache/images"

trap - ERR

log "Switching $LIVE_LINK → $(basename "$RELEASE")"
switch_to "$RELEASE"
reload_app "$SHA"

log "Checking http://localhost:$PORT/"
if ! check_health "$SHA"; then
  echo "The new release is NOT healthy — rolling back to $(basename "$CURRENT")." >&2
  switch_to "$CURRENT"
  reload_app "$CURRENT_ID"
  check_health "$CURRENT_ID" || echo "The previous release is not healthy either. pm2 logs $SERVICE --lines 50" >&2
  die "Deploy of $SHA rolled back. Its directory is kept: $RELEASE"
fi

# Without this, a reboot's `pm2 resurrect` brings back the environment saved
# at the last `pm2 save` — including an older NEXT_DEPLOYMENT_ID.
command -v pm2 >/dev/null 2>&1 && pm2 describe "$SERVICE" >/dev/null 2>&1 && pm2 save >/dev/null

# Optional, never fatal. With per-deploy asset URLs and no build window this
# is belt and braces; it also refreshes cached HTML.
CF_API_TOKEN="${CF_API_TOKEN:-$(env_value CF_API_TOKEN)}"
CF_ZONE_ID="${CF_ZONE_ID:-$(env_value CF_ZONE_ID)}"
if [ -n "$CF_API_TOKEN" ] && [ -n "$CF_ZONE_ID" ]; then
  log "Purging the Cloudflare cache"
  PURGE="$(curl -sS --max-time 30 -X POST \
    "https://api.cloudflare.com/client/v4/zones/$CF_ZONE_ID/purge_cache" \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data '{"purge_everything":true}' 2>&1)" || PURGE="request failed: $PURGE"
  case "$PURGE" in
    *'"success":true'*|*'"success": true'*) echo "Purged." ;;
    *) echo "Cloudflare purge FAILED (the deploy itself succeeded): $PURGE" >&2 ;;
  esac
else
  log "Skipping the Cloudflare purge (CF_API_TOKEN and CF_ZONE_ID are unset)"
fi

# Keep the newest $KEEP releases; never the live one or the one just replaced
# (that is what --rollback goes back to).
log "Pruning releases (keeping $KEEP)"
ls -1dt "$RELEASES_DIR"/*/ 2>/dev/null | sed 's#/$##' | tail -n +"$((KEEP + 1))" | while IFS= read -r old; do
  [ "$old" = "$RELEASE" ] || [ "$old" = "$CURRENT" ] && continue
  echo "Removing $(basename "$old")"
  rm -rf -- "$old"
done

log "Deployed $SHA on $BRANCH — live: $(basename "$RELEASE")"
