'use strict';

// Leadsheet page (/leadsheet?revy=<folder>&song=<rowId>), opened from the
// band page's Leadsheets tab. Runs the Lead Sheets editor copied unchanged
// into vendor/leadsheets/ (scripts/sync-leadsheets.sh), with matrevy.dk as
// its storage: the sheet is read and saved through update-data.php
// (band_leadsheet_read / band_leadsheet_save), one per song row. The
// editor's own UI stays English; everything this file shows is Danish.
//
// No site.js here (its header and gate need css/style.css, which would
// clash with the editor's global stylesheet), so the stored login is read
// directly: a copy of the part of getSiteAuth() this page needs.

// ── Globals the editor reads when its script loads ───────────
// (Top-level lets are shared with later classic scripts.)
let initialSheet = null;
let leadsheetId = '';

const LS_API_ENDPOINT = '/update-data.php'; // = SITE_API_ENDPOINT (site.js)
const LS_AUTH_KEY = 'matrevy-auth';         // = SITE_AUTH_KEY (site.js)
const LS_VENDOR = 'vendor/leadsheets/';

// ── Auth ─────────────────────────────────────────────────────
function lsPassword() {
  try {
    const auth = JSON.parse(localStorage.getItem(LS_AUTH_KEY) || 'null');
    if (auth && typeof auth.password === 'string' && auth.password) return auth.password;
  } catch (e) { /* ignore */ }
  try { return sessionStorage.getItem('matrevy-manus-pin') || ''; } catch (e) { return ''; }
}

// ── API (same success rule as every *Api helper: JSON with ok === true) ──
function lsMapError(status, detail) {
  if (detail === 'read_only') return 'Kun bosser kan redigere ældre revyer og andre instanser.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Sangen findes ikke (længere) i Oversigt.';
  if (status === 413 || detail === 'too_large') return 'Leadsheetet er for stort til at blive gemt.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

async function lsApi(action, body) {
  const password = lsPassword();
  if (!password) return { ok: false, status: 401, message: 'Log ind for at se leadsheets.' };
  let res;
  try {
    res = await fetch(LS_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...body }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, message: lsMapError(res.status, detail) };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── Keys ─────────────────────────────────────────────────────
// Copies of band.js's bandReadKey()/bandTransposeSemitones(): keep in sync.
// Revytoneart is a shift picked from a menu, stored as shown ("1 ↑",
// "2.5 ↓", "Original" or '' = none); Practice opens the sheet's own key
// moved by it.
const LS_MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const LS_MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const LS_LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };

function lsReadKey(text) {
  const raw = String(text || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-Ha-h])([#b]?)\s*(?:-?\s*(dur|moll?|m|min|minor|major|maj))?$/i.exec(raw);
  if (!m) return null;
  const quality = (m[3] || '').toLowerCase();
  let minor = quality.startsWith('m') && quality !== 'maj' && quality !== 'major';
  if (!quality && !m[2] && m[1] === m[1].toLowerCase()) minor = true;
  const pc = (LS_LETTER_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { pc, minor };
}

// Semitones of a stored Revytoneart ('' and "Original" = 0), or null if it isn't a shift.
function lsTransposeSemitones(text) {
  const raw = String(text || '').trim();
  if (raw === '' || raw === '-' || raw.toLowerCase() === 'original') return 0;
  const m = /^(\d+(?:[.,]5)?)\s*([↑↓])$/.exec(raw);
  if (!m) return null;
  const semitones = Math.round(parseFloat(m[1].replace(',', '.')) * 2);
  return m[2] === '↑' ? semitones : -semitones;
}

// The key `semitones` away from a sheet's key ('' if the sheet has none).
function lsTransposeKey(key, semitones) {
  const k = lsReadKey(key);
  if (!k) return '';
  return (k.minor ? LS_MINOR_KEYS : LS_MAJOR_KEYS)[(k.pc + semitones + 1200) % 12];
}

// ── Page ─────────────────────────────────────────────────────
function lsShowStatus(text, linkToBand) {
  const status = document.getElementById('ls-page-status');
  status.textContent = text;
  if (linkToBand) {
    status.appendChild(document.createTextNode(' '));
    const a = document.createElement('a');
    a.href = 'band';
    a.textContent = 'Gå til Bandet';
    status.appendChild(a);
  }
  status.hidden = false;
}

// The new sheet for a song nobody has saved one for yet: title = revy
// title, artist line = the original song (an extra instance, or a row
// without a revy title, uses the original title alone).
function lsDefaultSheet(rowId, row, isInstance) {
  const revy = (row.revytitel || '').trim();
  const original = (row.originaltitel || '').trim();
  const useRevy = !isInstance && revy !== '';
  return {
    id: rowId,
    title: (useRevy ? revy : original) || 'Unavngivet sang',
    artist: useRevy ? original : '',
    key: '', // set in the editor
    elements: [],
  };
}

// The vendored markup is our own file, but it's still built through a
// detached DOMParser document and imported node by node (no innerHTML).
// Its Jinja {# … #} comments are stripped first.
async function lsInsertEditorMarkup(root) {
  const res = await fetch(LS_VENDOR + 'editor-body.html');
  if (!res.ok) throw new Error('markup');
  const html = (await res.text()).replace(/\{#[\s\S]*?#\}/g, '');
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const node of Array.from(doc.body.childNodes)) root.appendChild(document.importNode(node, true));
}

function lsLoadEditorScript() {
  const script = document.createElement('script');
  script.src = LS_VENDOR + 'leadsheet-editor.js';
  document.body.appendChild(script);
}

// /leadsheet?bundle=1: the editor in bundle mode, loaded by the band page's
// "Samlet PDF" (bandPrintLeadsheets) into a hidden iframe. It exposes
// window.buildLeadSheetBundle(plan, onProgress), which draws every sheet of
// the plan (each moved by its own semitones) into one PDF. No sheet of its
// own and no login: the band page fetches the sheets and hands them over.
async function lsInitBundle() {
  window.LEADSHEET_BUNDLE_PAGE = true;
  initialSheet = { title: '', artist: '', key: '', elements: [] };
  leadsheetId = '';
  window.LEADSHEET_CONFIG = {
    storage: 'host', canEdit: false, canCopy: false, canMove: false, canDelete: false,
    fontBase: LS_VENDOR + 'fonts/', save: async () => ({ ok: false }),
  };
  await lsInsertEditorMarkup(document.getElementById('ls-editor-root'));
  document.getElementById('ls-page-status').hidden = true;
  lsLoadEditorScript();
}

async function lsInit() {
  const params = new URLSearchParams(location.search);
  if (params.get('bundle') === '1') {
    lsInitBundle();
    return;
  }
  const folder = params.get('revy') || '';
  const rowId = params.get('song') || '';
  if (!folder || !rowId) {
    lsShowStatus('Der mangler en sang i adressen.', true);
    return;
  }
  if (!lsPassword()) {
    lsShowStatus('Log ind på siden for at se leadsheets.', true);
    return;
  }
  const result = await lsApi('band_leadsheet_read', { folder, rowId });
  if (!result.ok) {
    lsShowStatus(result.message, true);
    return;
  }
  const { sheet, row, isInstance, writable } = result.data;
  initialSheet = sheet || lsDefaultSheet(rowId, row || {}, !!isInstance);
  initialSheet.id = rowId;
  leadsheetId = rowId;

  // Practice opens moved by the song's Revytoneart (as ?key=, which the
  // editor reads); the stored chords stay in the sheet's own key. A sheet
  // without a key can't be moved.
  const semitones = lsTransposeSemitones(row && row.revytoneart);
  const revyKey = semitones ? lsTransposeKey(initialSheet.key, semitones) : '';
  if (revyKey && !params.has('key')) {
    params.set('key', revyKey);
    history.replaceState(null, '', `${location.pathname}?${params}${location.hash}`);
  }

  const nameTab = () => {
    const title = (document.getElementById('sheet-title') || {}).value || initialSheet.title || 'Leadsheet';
    document.title = `${title.trim() || 'Leadsheet'} · Matematikrevyen`;
  };

  window.LEADSHEET_CONFIG = {
    storage: 'host',
    canEdit: !!writable,
    canCopy: false,
    canMove: false,
    canDelete: false,
    fontBase: LS_VENDOR + 'fonts/',
    save: async (model) => {
      const saved = await lsApi('band_leadsheet_save', { folder, rowId, sheet: model });
      return saved.ok ? { ok: true } : { ok: false, message: saved.message };
    },
  };

  try {
    await lsInsertEditorMarkup(document.getElementById('ls-editor-root'));
  } catch (e) {
    lsShowStatus('Kunne ikke indlæse leadsheet-editoren. Prøv igen senere.', true);
    return;
  }
  document.getElementById('ls-page-status').hidden = true;
  nameTab();
  const titleField = document.getElementById('sheet-title');
  if (titleField) titleField.addEventListener('input', nameTab);
  window.addEventListener('beforeprint', nameTab);
  lsLoadEditorScript();
}

lsInit();
