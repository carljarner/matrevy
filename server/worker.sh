#!/bin/bash
# Regenerates the embedded js/*-data.js files, calendar.ics and the manuscript
# PDFs whenever update-data.php drops a flag file in SITE (see github_api()).
# Replaces the embed-scenes.yml and generate-pdfs.yml GitHub Actions.
#
# Also mirrors SITE/archive to the GitHub repo's archive/ folder, so old and
# current productions stay browsable there (Arkiv's GitHub links, the Manus
# Guide, Program QR codes). One-way: the server is the source of truth.
#
# /app/{data,archive,js,calendar.ics} are symlinks into SITE (Dockerfile.worker),
# so both scripts run unchanged against the live data.
set -u
SITE=/data/site
mkdir -p "$SITE/generated/js"
cd /app

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

# ── Archive mirror to GitHub ─────────────────────────────────
# Runs once writes under archive/ have been quiet for ARCHIVE_SYNC_QUIET_SECONDS,
# so a burst of uploads or a PDF build becomes one commit. Needs a deploy key
# with write access (base64 of the private key, one line) in
# ARCHIVE_SYNC_DEPLOY_KEY; without it the mirror is off.
ARCHIVE_FLAG="$SITE/.archive-sync-requested"
ARCHIVE_GIT=/data/archive-git
ARCHIVE_REMOTE=${ARCHIVE_SYNC_REMOTE:-git@github.com:carljarner/matrevy.git}
ARCHIVE_QUIET=${ARCHIVE_SYNC_QUIET_SECONDS:-300}
archive_sync_pid=

archive_sync_enabled() { [ -n "${ARCHIVE_SYNC_DEPLOY_KEY:-}" ]; }

archive_sync_setup_ssh() {
  mkdir -p "$HOME/.ssh" && chmod 700 "$HOME/.ssh"
  if ! printf '%s' "$ARCHIVE_SYNC_DEPLOY_KEY" | base64 -d > "$HOME/.ssh/archive_key" 2>/dev/null; then
    log "archive sync: ARCHIVE_SYNC_DEPLOY_KEY is not valid base64, mirror disabled"
    return 1
  fi
  chmod 600 "$HOME/.ssh/archive_key"
  export GIT_SSH_COMMAND="ssh -i $HOME/.ssh/archive_key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=$HOME/.ssh/known_hosts"
}

archive_sync() {
  local repo=$ARCHIVE_GIT
  if [ ! -d "$repo/.git" ]; then
    rm -rf "$repo"
    git clone -q --filter=blob:none --sparse --branch main "$ARCHIVE_REMOTE" "$repo" || return 1
    git -C "$repo" sparse-checkout set archive || return 1
  fi
  git -C "$repo" config user.name 'MatRevy arkiv'
  git -C "$repo" config user.email 'noreply@matematikrevy.dk'

  local attempt
  for attempt in 1 2; do
    git -C "$repo" fetch -q origin main || return 1
    git -C "$repo" reset -q --hard origin/main || return 1
    # README.md is repo-managed (excluded files are never deleted); *.tmp-*
    # are update-data.php's in-flight atomic writes.
    rsync -a --delete --exclude '/README.md' --exclude '*.tmp-*' --exclude '.DS_Store' \
      "$SITE/archive/" "$repo/archive/" || return 1
    git -C "$repo" add -A archive || return 1
    if git -C "$repo" diff --cached --quiet; then
      log "archive sync: no changes"
      return 0
    fi
    git -C "$repo" commit -q -m 'Arkiv: synkroniseret fra matematikrevy.dk [skip ci]' || return 1
    if git -C "$repo" push -q origin HEAD:main; then
      log "archive sync: pushed $(git -C "$repo" rev-parse --short HEAD)"
      return 0
    fi
    log "archive sync: push rejected (attempt $attempt)"
  done
  return 1
}

# Runs archive_sync in the background so a slow push never delays an embed;
# on failure the flag is re-touched so the next quiet period retries.
archive_sync_start() {
  ( archive_sync || { log "archive sync failed, will retry"; touch "$ARCHIVE_FLAG"; } ) &
  archive_sync_pid=$!
}

archive_sync_running() { [ -n "$archive_sync_pid" ] && kill -0 "$archive_sync_pid" 2>/dev/null; }

archive_sync_due() {
  [ -e "$ARCHIVE_FLAG" ] || return 1
  archive_sync_running && return 1
  local age=$(( $(date +%s) - $(stat -c %Y "$ARCHIVE_FLAG" 2>/dev/null || date +%s) ))
  [ "$age" -ge "$ARCHIVE_QUIET" ]
}

log "worker started"
node scripts/embed-scenes.js >/dev/null || log "embed-scenes failed at startup"

if ! archive_sync_enabled; then
  log "archive sync: off (no ARCHIVE_SYNC_DEPLOY_KEY)"
elif archive_sync_setup_ssh; then
  # Catch up on anything written while the worker was down.
  archive_sync_start
else
  unset ARCHIVE_SYNC_DEPLOY_KEY
fi

while true; do
  # Heartbeat for the container healthcheck (docker-compose.yml): stale only
  # if the loop itself hangs, e.g. a stuck PDF build.
  touch /tmp/worker-heartbeat
  # The flag is removed before each run, so a save that lands mid-run
  # triggers one more run instead of being lost.
  if [ -e "$SITE/.embed-requested" ]; then
    rm -f "$SITE/.embed-requested"
    if node scripts/embed-scenes.js >/dev/null; then
      log "embed-scenes done"
    else
      log "embed-scenes failed"
    fi
  fi
  if [ -e "$SITE/.regen-pdfs-requested" ]; then
    rm -f "$SITE/.regen-pdfs-requested"
    log "generating PDFs"
    if node scripts/generate-pdfs.js; then
      log "generate-pdfs done"
    else
      log "generate-pdfs failed"
    fi
    # generate-pdfs.js writes straight to disk, not through update-data.php.
    touch "$ARCHIVE_FLAG"
  fi
  if archive_sync_enabled && archive_sync_due; then
    rm -f "$ARCHIVE_FLAG"
    archive_sync_start
  fi
  sleep 2
done
