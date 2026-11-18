#!/usr/bin/env bash
# Copies the Lead Sheets editor (github.com/carljarner/leadsheets) into
# vendor/leadsheets/, unchanged. The band page's Leadsheets tab runs it
# (leadsheet.html). Never edit vendor/leadsheets/ by hand: change the editor
# in the Lead Sheets repo and run this again.
#
#   scripts/sync-leadsheets.sh                 # from ../Lead Sheets
#   LEADSHEETS_DIR=~/src/leadsheets scripts/sync-leadsheets.sh
set -euo pipefail

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
src="${LEADSHEETS_DIR:-$repo_root/../Lead Sheets}"
dest="$repo_root/vendor/leadsheets"

for f in static/leadsheet-editor.js static/style.css static/fonts/MuseJazz.otf \
         static/fonts/MuseJazzText.otf static/fonts/MuseJazz-OFL.txt \
         templates/_leadsheet_editor_body.html; do
  [ -f "$src/$f" ] || { echo "Missing $src/$f (set LEADSHEETS_DIR)" >&2; exit 1; }
done

rm -rf "$dest"
mkdir -p "$dest/fonts"
cp "$src/static/leadsheet-editor.js" "$src/static/style.css" "$dest/"
cp "$src/static/fonts/MuseJazz.otf" "$src/static/fonts/MuseJazzText.otf" \
   "$src/static/fonts/MuseJazz-OFL.txt" "$dest/fonts/"
cp "$src/templates/_leadsheet_editor_body.html" "$dest/editor-body.html"

commit="$(git -C "$src" rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [ -n "$(git -C "$src" status --porcelain -- static templates 2>/dev/null)" ]; then
  commit="$commit (with uncommitted changes)"
fi
{
  echo "Copied from the Lead Sheets repo by scripts/sync-leadsheets.sh. Do not edit."
  echo "Source commit: $commit"
} > "$dest/VERSION"
echo "Synced Lead Sheets editor ($commit) into vendor/leadsheets/"
