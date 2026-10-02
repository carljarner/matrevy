#!/bin/bash
# Regenerates the embedded js/*-data.js files, calendar.ics and the manuscript
# PDFs whenever update-data.php drops a flag file in SITE (see github_api()).
# Replaces the embed-scenes.yml and generate-pdfs.yml GitHub Actions.
#
# /app/{data,archive,js,calendar.ics} are symlinks into SITE (Dockerfile.worker),
# so both scripts run unchanged against the live data.
set -u
SITE=/data/site
mkdir -p "$SITE/generated/js"
cd /app

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }

log "worker started"
node scripts/embed-scenes.js >/dev/null || log "embed-scenes failed at startup"

while true; do
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
  fi
  sleep 2
done
