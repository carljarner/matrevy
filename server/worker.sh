#!/bin/bash
# Regenerates the embedded js/*-data.js files, calendar.ics and the manuscript
# PDFs whenever update-data.php drops a flag file in SITE (see github_api()).
# Replaces the embed-scenes.yml and generate-pdfs.yml GitHub Actions.
#
# Also mirrors SITE/archive to the GitHub repo's archive/ folder, so old and
# current productions stay browsable there (Arkiv's GitHub links, the Manus
# Guide, Program QR codes). One-way: the server is the source of truth. The
# current production shows only submitted/ until the manus is published
# (see archive_sync).
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

# Replaces the name in every \role{<code>}[<name>] of every .tex under $1
# with "navn" (scripts/generate-pdfs.js's REDACTED_ROLE_NAME), so a
# restricted view of the GitHub mirror never shows who plays what.
redact_tex() {
  find "$1" -type f -name '*.tex' -print0 | xargs -0 -r node -e '
    const fs = require("fs");
    for (const file of process.argv.slice(1)) {
      const text = fs.readFileSync(file, "utf8");
      const next = text.replace(/(\\role\{[^}]*\})\[[^\]]*\]/g, "$1[navn]");
      if (next !== text) fs.writeFileSync(file, next);
    }
  '
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

  # The current production is mirrored in one of three views, from Manus's
  # two toggles (update-data.php makes a config write sync right away):
  # - hidden (manus off): every scene in submitted/ (selected ones copied
  #   back from sketches/ and songs/ as their current server version) and
  #   none of the generated PDFs (top-level *.pdf, manuskripter/).
  # - redacted (manus on, roles off, config.rolesVisibleToRevyst): the full
  #   folder, but sketches/, songs/ and manus.pdf come from the anonym/
  #   copies scripts/generate-pdfs.js builds (names read "navn"), and
  #   manuskripter/ and Rolleoversigt.pdf are left out.
  # - full (both on): a plain mirror.
  # Both restricted views are rebuilt from scratch and every .tex in them
  # goes through redact_tex, so nothing an earlier sync pushed lingers.
  # anonym/ itself is never mirrored.
  local view_mode hidden_folder
  view_mode=$(node -e '
    try {
      const c = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
      const f = typeof c.currentProductionFolder === "string" ? c.currentProductionFolder : "";
      if (!/^[A-Za-z0-9_-]+$/.test(f)) process.exit(0);
      if (!c.pdfLinksVisibleToRevyst) process.stdout.write("hidden " + f);
      else if (!c.rolesVisibleToRevyst) process.stdout.write("redacted " + f);
    } catch (e) {}
  ' "$SITE/data/config.json")
  hidden_folder=${view_mode#* }
  view_mode=${view_mode%% *}

  local attempt message
  for attempt in 1 2; do
    git -C "$repo" fetch -q origin main || return 1
    git -C "$repo" reset -q --hard origin/main || return 1
    # README.md is repo-managed (excluded files are never deleted); *.tmp-*
    # are update-data.php's in-flight atomic writes.
    if [ -z "$view_mode" ]; then
      rsync -a --delete --exclude '/README.md' --exclude '*.tmp-*' --exclude '.DS_Store' \
        --exclude '/*/anonym/' "$SITE/archive/" "$repo/archive/" || return 1
      message='Arkiv: synkroniseret fra matematikrevy.dk [skip ci]'
    else
      # Every other year as usual; an excluded folder is left alone by --delete.
      rsync -a --delete --exclude '/README.md' --exclude '*.tmp-*' --exclude '.DS_Store' \
        --exclude '/*/anonym/' --exclude "/$hidden_folder/" "$SITE/archive/" "$repo/archive/" || return 1
      local view="$repo/archive/$hidden_folder" src="$SITE/archive/$hidden_folder" dir
      rm -rf "$view"
      if [ -d "$src" ] && [ "$view_mode" = hidden ]; then
        rsync -a --exclude '*.tmp-*' --exclude '.DS_Store' \
          --exclude '/sketches/' --exclude '/songs/' --exclude '/manuskripter/' --exclude '/anonym/' --exclude '/*.pdf' \
          "$src/" "$view/" || return 1
        for dir in sketches songs; do
          [ -d "$src/$dir" ] || continue
          mkdir -p "$view/submitted" || return 1
          rsync -a --exclude '*.tmp-*' --exclude '.DS_Store' "$src/$dir/" "$view/submitted/" || return 1
        done
        message='Arkiv: synkroniseret fra matematikrevy.dk (manus skjult) [skip ci]'
      elif [ -d "$src" ]; then
        rsync -a --exclude '*.tmp-*' --exclude '.DS_Store' \
          --exclude '/sketches/' --exclude '/songs/' --exclude '/manuskripter/' --exclude '/anonym/' \
          --exclude '/manus.pdf' --exclude '/Rolleoversigt.pdf' \
          "$src/" "$view/" || return 1
        for dir in sketches songs; do
          [ -d "$src/anonym/$dir" ] || continue
          mkdir -p "$view/$dir" || return 1
          rsync -a --exclude '*.tmp-*' --exclude '.DS_Store' "$src/anonym/$dir/" "$view/$dir/" || return 1
        done
        [ -f "$src/anonym/manus.pdf" ] && { cp "$src/anonym/manus.pdf" "$view/manus.pdf" || return 1; }
        message='Arkiv: synkroniseret fra matematikrevy.dk (roller skjult) [skip ci]'
      else
        message='Arkiv: synkroniseret fra matematikrevy.dk [skip ci]'
      fi
      [ -d "$view" ] && { redact_tex "$view" || return 1; }
    fi
    git -C "$repo" add -A archive || return 1
    if git -C "$repo" diff --cached --quiet; then
      log "archive sync: no changes"
      return 0
    fi
    git -C "$repo" commit -q -m "$message" || return 1
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
