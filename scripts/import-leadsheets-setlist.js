#!/usr/bin/env node
'use strict';

// ── Import a leadsheets.dk setlist into the band page (one-time migration) ──
//
// Copies the lead sheets of one of leadsheets.dk's admin setlists (by
// default "MatRevy '26") into matematikrevy.dk's band folder: each sheet
// becomes the lead sheet of the matching song row in Oversigt, the
// setlist's key becomes that song's Revytoneart (the shift from the sheet's
// own key), and the setlist's sets (split at its pauses) fill Samlet PDF's
// acts: set 1 → Akt 1, set 2 → Akt 2, set 3 → Akt 3, anything after →
// Ekstranumre.
//
// It reads leadsheets.dk's data from a local copy, and writes to
// matematikrevy.dk only through update-data.php (boss password), the same
// actions the page uses, so run it after the band/Leadsheets code is
// deployed. Without --apply it only prints what it would do.
//
//   rsync -a web-1:/srv/leadsheets/data/ /tmp/leadsheets-live/
//   MATREVY_PASSWORD=<boss password> node scripts/import-leadsheets-setlist.js \
//     --data /tmp/leadsheets-live [--setlist "MatRevy '26"] [--site https://matematikrevy.dk]
//     [--folder <band folder>] [--map map.json] [--apply] [--force]
//
//   --data     leadsheets.dk's DATA_DIR (setlists in users/admin/setlists/)
//   --setlist  the setlist's name (default "MatRevy '26")
//   --site     where update-data.php lives (default https://matematikrevy.dk)
//   --folder   the band folder (default: the band page's active folder)
//   --map      JSON {"<sheet title>": "<row id, original title or revy title>"}
//              for setlist songs whose title matches no song (or several)
//   --apply    actually write (default: a dry run)
//   --force    also overwrite songs that already have a lead sheet saved
//
// Imported sheets are named like a new sheet on the band page (title =
// revytitel, artist = original title; an extra instance or a song without a
// revytitel: original title alone); a version's name and its link to the
// original are dropped. Chords and everything else are kept as they are.

const fs = require('fs');
const path = require('path');

// ── Arguments ─────────────────────────────────────────────────
function parseArgs(argv) {
  const args = { setlist: "MatRevy '26", site: 'https://matematikrevy.dk', apply: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply') args.apply = true;
    else if (a === '--force') args.force = true;
    else if (['--data', '--setlist', '--site', '--folder', '--map'].includes(a)) args[a.slice(2)] = argv[++i];
    else throw new Error(`Unknown argument: ${a}`);
  }
  if (!args.data) throw new Error('--data <leadsheets.dk data dir> is required');
  return args;
}

// ── Keys (copies of js/band.js's bandReadKey / bandTransposeLabel) ──
const LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };

function readKey(text) {
  const raw = String(text || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-Ha-h])([#b]?)\s*(?:-?\s*(dur|moll?|m|min|minor|major|maj))?$/i.exec(raw);
  if (!m) return null;
  const quality = (m[3] || '').toLowerCase();
  let minor = quality.startsWith('m') && quality !== 'maj' && quality !== 'major';
  if (!quality && !m[2] && m[1] === m[1].toLowerCase()) minor = true;
  const pc = (LETTER_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { pc, minor };
}

function transposeLabel(semitones) {
  return semitones ? `${Math.abs(semitones) / 2} ${semitones > 0 ? '↑' : '↓'}` : 'Original';
}

// The setlist's key as a shift from the sheet's key, the shorter way round
// (-5..+6, like leadsheets.dk's semitonesTo); null when either is unreadable.
function shiftBetween(sheetKey, playKey) {
  const from = readKey(sheetKey);
  const to = readKey(playKey);
  if (!from || !to) return null;
  const diff = (to.pc - from.pc + 12) % 12;
  return diff > 6 ? diff - 12 : diff;
}

// ── Titles ────────────────────────────────────────────────────
function norm(text) {
  return String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9æøå]+/g, '');
}

// ── leadsheets.dk data ────────────────────────────────────────
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function loadSetlist(dataDir, name) {
  const dir = path.join(dataDir, 'users', 'admin', 'setlists');
  if (!fs.existsSync(dir)) throw new Error(`No setlists in ${dir}`);
  const all = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
  const hits = all.filter((s) => norm(s.name) === norm(name));
  if (hits.length !== 1) {
    const names = all.map((s) => `  "${s.name}"`).join('\n');
    throw new Error(`${hits.length ? 'Several' : 'No'} setlists named "${name}". Setlists found:\n${names}`);
  }
  return hits[0];
}

function loadSheet(dataDir, row) {
  const file = row.source === 'local'
    ? path.join(dataDir, 'users', 'admin', 'sheets', `${row.id}.json`)
    : path.join(dataDir, 'leadsheets', `${row.id}.json`);
  if (!fs.existsSync(file)) throw new Error(`Setlist song ${row.id} has no sheet at ${file}`);
  return readJson(file);
}

// ── matematikrevy.dk API (same {ok:true} rule as the page's *Api helpers) ──
async function api(site, password, action, body) {
  let res;
  try {
    res = await fetch(`${site.replace(/\/$/, '')}/update-data.php`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...body }),
    });
  } catch (e) {
    throw new Error(`${action}: could not reach ${site} (${e.message})`);
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok || !data || data.ok !== true) {
    throw new Error(`${action} failed: HTTP ${res.status}${data && data.error ? ` (${data.error})` : ''}`);
  }
  return data;
}

// ── Main ──────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  const password = process.env.MATREVY_PASSWORD || '';
  if (!password) throw new Error('Set MATREVY_PASSWORD to the boss password.');

  // The setlist, split into sets at its pauses.
  const setlist = loadSetlist(args.data, args.setlist);
  const songs = [];
  let set = 0;
  for (const row of setlist.rows || []) {
    if (row.type === 'break') {
      if (songs.length && songs[songs.length - 1].set === set) set++;
      continue;
    }
    if (row.type !== 'song') continue;
    songs.push({ set, playKey: row.key || '', sheet: loadSheet(args.data, row) });
  }
  console.log(`Setlist "${setlist.name}": ${songs.length} songs in ${set + 1} set(s).`);

  // The band folder.
  const folder = args.folder || (await api(args.site, password, 'band_instances_read', {})).activeFolder;
  if (!folder) throw new Error('No active band folder; pass --folder.');
  const band = await api(args.site, password, 'band_read', { folder });
  const instances = (await api(args.site, password, 'band_instances_read', {})).instances || [];
  const isInstance = instances.some((i) => i.folder === folder);
  const rows = (band.rows || []).filter((r) => r.type === 'song');
  const saved = band.leadsheetKeys || {};
  console.log(`Band folder "${folder}": ${rows.length} songs.\n`);

  // Matching: --map first, then the sheet's title (or its original's) against
  // the row's original and revy titles.
  const map = args.map ? readJson(args.map) : {};
  const findRows = (text) => rows.filter((r) => r.id === text
    || (norm(text) && (norm(r.originaltitel) === norm(text) || norm(r.revytitel) === norm(text))));
  const used = new Map();
  const matched = [];
  const unmatched = [];
  for (const song of songs) {
    const title = song.sheet.title || '';
    const mapped = map[title];
    let hits = mapped ? findRows(mapped) : findRows(title);
    if (!hits.length && !mapped && song.sheet.based_on && song.sheet.based_on.title) hits = findRows(song.sheet.based_on.title);
    if (hits.length !== 1) {
      unmatched.push({ song, reason: hits.length ? `${hits.length} songs match` : 'no song matches' });
      continue;
    }
    const row = hits[0];
    if (used.has(row.id)) throw new Error(`"${title}" and "${used.get(row.id)}" both match the song "${row.originaltitel}". Use --map.`);
    used.set(row.id, title);
    matched.push({ song, row });
  }

  // What to write per match.
  const act = (s) => ['1', '2', '3'][s] || 'E';
  const plans = matched.map(({ song, row }) => {
    const revy = (row.revytitel || '').trim();
    const original = (row.originaltitel || '').trim();
    const useRevy = !isInstance && revy !== '';
    const sheet = { ...song.sheet };
    for (const key of ['id', 'based_on', 'version_name', 'created_at', 'updated_at']) delete sheet[key];
    sheet.title = (useRevy ? revy : original) || sheet.title || 'Unavngivet sang';
    sheet.artist = useRevy ? original : '';
    if (!Array.isArray(sheet.elements)) sheet.elements = [];
    const shift = shiftBetween(song.sheet.key, song.playKey);
    const revytoneart = shift === null ? (row.revytoneart || '') : transposeLabel(shift);
    return { song, row, sheet, revytoneart, act: act(song.set), hasSheet: !!saved[row.id] };
  });

  // The print order: imported songs by set, in setlist order; every other
  // song keeps where it was.
  const importedIds = new Set(plans.map((p) => p.row.id));
  const printActs = {};
  for (const code of ['1', '2', '3', 'E']) {
    const kept = ((band.printActs || {})[code] || []).filter((id) => !importedIds.has(id));
    printActs[code] = [...plans.filter((p) => p.act === code).map((p) => p.row.id), ...kept];
  }

  // Report.
  console.log('#   Act  Setlist sheet                      → Band song                          Key            Revytoneart          Sheet');
  plans.forEach((p, i) => {
    const keyText = `${p.song.sheet.key || '?'} → ${p.song.playKey || '?'}`;
    const old = (p.row.revytoneart || '').trim() || '-';
    const toneText = old === p.revytoneart ? p.revytoneart : `${old} → ${p.revytoneart || '-'}`;
    const sheetText = p.hasSheet ? (args.force ? 'overwrite' : 'keep (has one)') : 'new';
    console.log(`${String(i + 1).padEnd(3)} ${p.act.padEnd(4)} ${String(p.song.sheet.title || '').slice(0, 34).padEnd(34)} → ${(p.sheet.title + (p.sheet.artist ? ` (${p.sheet.artist})` : '')).slice(0, 34).padEnd(34)} ${keyText.padEnd(14)} ${toneText.padEnd(20)} ${sheetText}`);
  });
  if (unmatched.length) {
    console.log('\nNot matched (add them to --map):');
    for (const u of unmatched) console.log(`  "${u.song.sheet.title}" (${u.reason})`);
  }
  const notInSetlist = rows.filter((r) => !importedIds.has(r.id));
  if (notInSetlist.length) {
    console.log('\nBand songs not in the setlist (left as they are):');
    for (const r of notInSetlist) console.log(`  ${r.revytitel || r.originaltitel || r.id}`);
  }

  if (!args.apply) {
    console.log('\nDry run: nothing written. Run again with --apply to import.');
    return;
  }

  // Write.
  let sheetsWritten = 0;
  let keysWritten = 0;
  for (const p of plans) {
    if (!p.hasSheet || args.force) {
      await api(args.site, password, 'band_leadsheet_save', { folder, rowId: p.row.id, sheet: p.sheet });
      sheetsWritten++;
    }
    if ((p.row.revytoneart || '') !== p.revytoneart) {
      await api(args.site, password, 'band_upsert_row', { folder, row: { id: p.row.id, type: 'song', revytoneart: p.revytoneart } });
      keysWritten++;
    }
  }
  await api(args.site, password, 'band_save_print_acts', { folder, printActs });
  console.log(`\nImported: ${sheetsWritten} sheet(s), ${keysWritten} Revytoneart(s), acts saved.`);
}

main().catch((e) => {
  console.error(`Error: ${e.message}`);
  process.exit(1);
});
