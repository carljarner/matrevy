/* =========================================================
   Matematikrevyen – Bandet (band.html)

   The band's folder, replacing a shared Google Drive folder: per revy a
   "Sangoversigt" sheet (one row per song — original/revy title, keys,
   director, singers, arranger, arrangement status —
   grouped under section headings) plus a small instrument/transposition
   table, and a folder of sheet music (pdf/MuseScore) per song.

   Each song row *is* a folder: the Noder tab lists the same rows the
   Oversigt tab does, so creating a folder means adding a song row and a
   folder is renamed by editing the row's titles.

   The Arkiv tab is the long-term library: every song of every revy (plus
   songs created there, kept in the reserved `_arkiv` store and never in a
   revy's sheet), one card per original title, files grouped by source.

   The revy picker beside the title lists Arkiv's years (keyed by their
   `folder`, same key as archive/<folder>/), defaulting to the current
   production. Everything lives in the private BAND_DATA_DIR store via
   authenticated band_* actions (sheet music is often copyrighted, so
   never a public URL or the GitHub mirror); files are streamed with the
   password and handed to the browser as blobs. Fully open at the revyst
   tier, like the Drive folder it replaces.

   Live writes like Fællesspisning: a text cell commits on blur, a status
   pill on click, a reorder on drop — each a row-granular server merge, so
   several band members can edit at once.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helpers (mirror faellesspisning.js's own) ──────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// First-level (inline) button.
function bandBtn(label, extraClass) {
  const btn = el('button', 'btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  btn.type = 'button';
  return btn;
}

// Second-level button, for buttons inside a modal overlay only.
function bandPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

function bandAddPlusBtn(title) {
  const btn = el('button', 'site-icon-btn site-add-plus', '+');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

function bandRemoveBtn(title) {
  const btn = el('button', 'site-icon-btn site-icon-btn-danger', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

function bandIconBtn(icon, title) {
  const btn = el('button', 'site-icon-btn');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(icon);
  return btn;
}

// Arrow-into-tray download glyph, built as SVG nodes (no innerHTML).
function bandDownloadIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// Pencil glyph — same drawing as calendar.js's calPencilIcon.
function bandPencilIcon() {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of ['M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z', 'M9 4l3 3']) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// ── Authenticated API (mirrors faellesspisning.js's faellesApi) ──
function bandResolvePassword() {
  const auth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  if (auth && auth.password) return auth.password;
  let pin = '';
  try { pin = sessionStorage.getItem('matrevy-manus-pin') || ''; } catch (e) { /* ignore */ }
  if (!pin) {
    pin = (prompt('Indtast adgangskoden:') || '').trim();
    if (!pin) return null;
  }
  return pin;
}

function bandMapError(status, detail) {
  if (detail === 'read_only') return 'Kun bosser kan redigere arkivet, ældre revyer og andre instanser.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. En anden har måske lige slettet den. Genindlæs siden.';
  if (status === 409) return 'Nogen andre har lige ændret arket. Genindlæser…';
  if (status === 413 || detail === 'too_large') return `Filen er for stor. Maks. ${BAND_MAX_UPLOAD_MB} MB.`;
  if (detail === 'bad_extension') return 'Kun PDF- og MuseScore-filer (.pdf, .mscz, .mscx) kan uploades.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

let bandPending = 0; // writes in flight (beforeunload / stale banner)

// Returns { ok: true, data } or { ok: false, status, message } —
// message '' = cancelled password prompt (silent no-op).
async function bandApi(action, body) {
  const password = bandResolvePassword();
  if (!password) return { ok: false, status: 0, message: '' };
  const isWrite = !/_read$/.test(action);
  if (isWrite) bandPending++;
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, folder: bandFolder, ...(body || {}) }),
    });
  } catch (e) {
    if (isWrite) bandPending--;
    return { ok: false, status: 0, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  if (isWrite) bandPending--;
  // Require a real {ok:true} JSON body — a PHP fatal or WAF page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, message: bandMapError(res.status, detail) };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// Streams one stored file. Returns { ok: true, blob } or { ok: false, message }.
async function bandFetchFile(row, file) {
  const password = bandResolvePassword();
  if (!password) return { ok: false, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'band_file', password, folder: row._folder || bandFolder, rowId: row.id, fileId: file.id }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || type.includes('json') || type.includes('html')) {
    return { ok: false, message: bandMapError(res.ok ? 500 : res.status, '') };
  }
  const blob = await res.blob();
  return { ok: true, blob: file.ext === 'pdf' ? new Blob([blob], { type: 'application/pdf' }) : blob };
}

// ── Revy picker (Arkiv's years + extra instances) ────────────
const BAND_REVY_KEY = 'matrevy-band-revy';
const BAND_NEW_INSTANCE = '__new'; // the picker's "+ Opret ny" pseudo-option

// Extra band folders beside Arkiv's revys (e.g. "MatGalla 2025"), from
// BAND_DATA_DIR/instances.json: [{folder, name, year}].
let bandInstances = [];
// The folder ordinary revyster may edit (band_active_folder() server-side:
// a boss's choice in Boss-indstillinger, else the current production).
let bandActiveFolder = '';

function bandCurrentProductionFolder() {
  return (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
}

function bandArchiveYears() {
  const override = siteLoadOverride('archive');
  return (override || (typeof ARCHIVE_DATA !== 'undefined' ? ARCHIVE_DATA : [])).filter((y) => y && y.folder);
}

function bandIsInstance(folder) {
  return bandInstances.some((i) => i.folder === folder);
}

// The active folder is open to every revyst; every other revy/instance and
// the Arkiv tab's own store are read-only below boss.
// Mirrors band_folder_writable() in update-data.php.
function bandIsBoss() {
  return typeof siteHasLevel === 'function' && siteHasLevel('boss');
}

function bandCanEdit(folder = bandFolder) {
  if (bandIsBoss()) return true;
  return folder !== '' && folder !== BAND_ARCHIVE_FOLDER && folder === bandActiveFolder;
}

// Newest year first; within a year Arkiv's revy comes before the extra
// instances (so MatRevy 2025 → MatGalla 2025 → MatRevy 2024). The current
// production is always offered, even before Koordinator has added its
// Arkiv entry.
function bandRevyOptions() {
  const options = bandArchiveYears().map((y) => ({ value: y.folder, label: y.name || y.folder, year: y.year || 0, kind: 0 }));
  const current = bandCurrentProductionFolder();
  if (current && !options.some((o) => o.value === current)) {
    const m = /\d{4}/.exec(current);
    options.push({ value: current, label: current.replace(/_/g, ' '), year: m ? Number(m[0]) : 9999, kind: 0 });
  }
  for (const inst of bandInstances) {
    if (!options.some((o) => o.value === inst.folder)) {
      options.push({ value: inst.folder, label: inst.name, year: inst.year || 0, kind: 1 });
    }
  }
  return options.sort((a, b) => (b.year - a.year) || (a.kind - b.kind) || a.label.localeCompare(b.label, 'da'));
}

function bandInitialFolder(options) {
  let stored = '';
  try { stored = localStorage.getItem(BAND_REVY_KEY) || ''; } catch (e) { /* ignore */ }
  if (stored && options.some((o) => o.value === stored)) return stored;
  const current = bandCurrentProductionFolder();
  if (current) return current;
  return options.length ? options[0].value : '';
}

function bandSelectFolder(folder, root) {
  bandFolder = folder;
  try { localStorage.setItem(BAND_REVY_KEY, bandFolder); } catch (e) { /* ignore */ }
  bandRenderPicker(root);
  // Arkiv spans every revy, so it doesn't change; the choice applies once
  // you're back on Oversigt/Noder.
  if (bandActiveTab !== 'arkiv') bandLoad(root);
}

function bandRenderPicker(root) {
  const mount = document.getElementById('band-revy-picker');
  if (!mount) return;
  const options = bandRevyOptions();
  const choices = options.map(({ value, label }) => ({ value, label }));
  // Creating/editing an extra instance is boss-level.
  if (bandIsBoss()) choices.push({ value: BAND_NEW_INSTANCE, label: '+ Opret ny' });
  const picker = siteCreateDropdownField(choices, bandFolder);
  picker.classList.add('site-toolbar-control', 'band-revy-select');
  picker.setAttribute('aria-label', 'Vælg revy');
  picker.addEventListener('change', () => {
    if (picker.value === BAND_NEW_INSTANCE) {
      picker.value = bandFolder;
      bandOpenInstanceModal(null, root);
      return;
    }
    if (picker.value === bandFolder) return;
    bandSelectFolder(picker.value, root);
  });
  const children = [];
  const instance = bandInstances.find((i) => i.folder === bandFolder);
  if (instance && bandIsBoss()) {
    const editBtn = bandBtn('Rediger', 'site-toolbar-control');
    editBtn.title = `Omdøb eller slet "${instance.name}"`;
    editBtn.addEventListener('click', () => bandOpenInstanceModal(instance, root));
    children.push(editBtn);
  }
  children.push(picker);
  mount.replaceChildren(...children);
}

async function bandLoadInstances() {
  const result = await bandApi('band_instances_read', {});
  bandInstances = result.ok ? (result.data.instances || []) : [];
  bandActiveFolder = result.ok ? (result.data.activeFolder || '') : bandCurrentProductionFolder();
}

// Create (instance null) or edit an extra band instance: name + year.
// The folder is fixed at creation, so a rename never orphans its data.
function bandOpenInstanceModal(instance, root) {
  const isNew = !instance;
  const { modal, form, error, actions, close } = siteOpenModalWithClose(isNew ? 'Opret ny' : `Rediger "${instance.name}"`);
  modal.classList.add('band-folder-modal');
  if (isNew) {
    form.appendChild(el('p', 'band-upload-hint', 'Et ekstra bandark ved siden af revyerne'));
  }
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 80;
  nameInput.placeholder = 'MatGalla 2025';
  nameInput.value = isNew ? '' : instance.name;
  form.appendChild(siteEditField('Navn', nameInput));
  const yearInput = document.createElement('input');
  yearInput.type = 'text';
  yearInput.inputMode = 'numeric';
  yearInput.maxLength = 4;
  yearInput.value = String(isNew ? new Date().getFullYear() : instance.year);
  form.appendChild(siteEditField('År (placeres lige under årets revy)', yearInput));

  const saveBtn = bandPillBtn(isNew ? 'Opret' : 'Gem', 'site-btn-success');
  async function submit() {
    const name = nameInput.value.trim().replace(/\s+/g, ' ');
    const yearText = yearInput.value.trim();
    if (!name) { error.textContent = 'Skriv et navn.'; nameInput.focus(); return; }
    if (!/^\d{4}$/.test(yearText)) { error.textContent = 'Skriv et årstal med fire cifre.'; yearInput.focus(); return; }
    const clash = bandRevyOptions().find((o) =>
      o.label.toLocaleLowerCase('da') === name.toLocaleLowerCase('da') && (isNew || o.value !== instance.folder));
    if (clash) { error.textContent = `"${clash.label}" findes allerede.`; nameInput.focus(); return; }
    saveBtn.disabled = true;
    error.textContent = '';
    const body = { name, year: Number(yearText) };
    const result = isNew
      ? await bandApi('band_instance_create', { ...body, avoid: bandArchiveYears().map((y) => y.folder) })
      : await bandApi('band_instance_update', { ...body, folder: instance.folder });
    if (!result.ok) {
      saveBtn.disabled = false;
      error.textContent = result.message || '';
      return;
    }
    bandInstances = result.data.instances || [];
    close();
    if (isNew) {
      bandSelectFolder(result.data.instance.folder, root);
    } else {
      bandRenderPicker(root);
      bandRender(root); // Arkiv tab's source labels may have changed
    }
  }
  saveBtn.addEventListener('click', submit);
  for (const input of [nameInput, yearInput]) {
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  }
  if (!isNew) {
    actions.classList.add('band-instance-actions');
    const deleteBtn = bandPillBtn('Slet', 'site-btn-danger');
    deleteBtn.addEventListener('click', () => {
      close();
      bandConfirm(`Slet "${instance.name}"?`, 'Arket, bandmedlemmerne og alle filer slettes. Dette kan ikke fortrydes.', 'Slet', async () => {
        const result = await bandApi('band_instance_delete', { folder: instance.folder });
        if (!result.ok) { bandShowError(result.message); return false; }
        bandInstances = result.data.instances || [];
        bandActiveFolder = result.data.activeFolder || '';
        bandSelectFolder(bandInitialFolder(bandRevyOptions()), root);
        return true;
      });
    });
    actions.appendChild(deleteBtn);
  }
  actions.appendChild(saveBtn);
  nameInput.focus();
}

// ── State ────────────────────────────────────────────────────
const BAND_MAX_UPLOAD_MB = 15; // mirrors band_max_upload_bytes() in update-data.php
const BAND_ALLOWED_EXTS = ['pdf', 'mscz', 'mscx']; // mirrors band_allowed_exts()

const BAND_TABS = [
  { key: 'oversigt', label: 'Oversigt' },
  { key: 'noder', label: 'Noder' },
  { key: 'leadsheets', label: 'Leadsheets' },
  { key: 'arkiv', label: 'Arkiv' },
];
const BAND_TAB_KEY = 'matrevy-band-tab';
let bandActiveTab = (() => {
  let stored = '';
  try { stored = localStorage.getItem(BAND_TAB_KEY) || ''; } catch (e) { /* ignore */ }
  return BAND_TABS.some((t) => t.key === stored) ? stored : BAND_TABS[0].key;
})();

// `width` = default px; each column can be dragged wider/narrower (stored
// per band folder in columnWidths).
const BAND_COLUMNS = [
  { key: 'originaltitel', label: 'Title', width: 170 },
  { key: 'revytitel', label: 'Revytitel', width: 170 },
  { key: 'originalToneart', label: 'Toneart', width: 88 },
  { key: 'revytoneart', label: 'Revytoneart', width: 92 },
  { key: 'instruktoer', label: 'Instruktør', width: 92 },
  { key: 'sangere', label: 'Sanger(e)', width: 180 },
  { key: 'arrangement', label: 'Arrangement', width: 100 },
  { key: 'arrangementKlar', label: 'Klar', width: 92, status: true },
];
const BAND_HANDLE_COL_WIDTH = 26;
const BAND_ACTIONS_COL_WIDTH = 56;
const BAND_MIN_COL_WIDTH = 48;
const BAND_CUSTOM_COL_WIDTH = 100;
const BAND_CUSTOM_KEY_RE = /^c[0-9a-f]{8,40}$/; // mirrors band_custom_key_valid()
const BAND_LOCKED_COLUMN = 'originaltitel'; // can't be removed: the Arkiv tab is keyed on it

// The columns this band folder shows: the built-ins minus hiddenColumns,
// plus its customColumns — placed before Klar so it stays rightmost.
function bandSheetColumns() {
  const hidden = new Set(bandState.hiddenColumns);
  const cols = BAND_COLUMNS.filter((c) => !hidden.has(c.key));
  const custom = bandState.customColumns.map((c) => ({
    key: c.key, label: c.label, width: BAND_CUSTOM_COL_WIDTH, status: c.type === 'status', custom: true,
  }));
  const klar = cols.findIndex((c) => c.key === 'arrangementKlar');
  cols.splice(klar === -1 ? cols.length : klar, 0, ...custom);
  return cols;
}

// Every value key a song row can carry here (hidden ones included, so a
// draft keeps them and a row with only hidden content still counts).
function bandAllValueKeys() {
  return [...BAND_COLUMNS.map((c) => c.key), ...bandState.customColumns.map((c) => c.key)];
}

// The 3-state status cycle from last year's sheet: blank / "(Tjek!)" / "Tjek!".
const BAND_STATUSES = [
  { value: '', label: '-', cls: 'band-status-none', title: 'Ikke klar' },
  { value: 'delvis', label: '(Tjek!)', cls: 'band-status-delvis', title: 'Delvist' },
  { value: 'klar', label: 'Tjek!', cls: 'band-status-klar', title: 'Klar' },
];

// ── Keys ─────────────────────────────────────────────────────
// Revytoneart is how far the revy moves a song from its lead sheet's key,
// picked from a menu like leadsheets.dk's setlist key menu: "-" (not set,
// the default), then 3 ↑ down to 2.5 ↓ in whole tones with "Original" (not
// moved) in the middle. Stored as shown ("1 ↑", "2.5 ↓", "Original", '' for
// "-"); "-" and "Original" both leave the sheet as written. Practice mode opens the sheet moved by it (leadsheet-page.js);
// the Leadsheets cards show the key that gives. Toneart is plain free text.
// bandReadKey/bandTransposeSemitones are copied into leadsheet-page.js
// (lsReadKey/lsTransposeSemitones): keep in sync.
const BAND_MAJOR_KEYS = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const BAND_MINOR_KEYS = ['Cm', 'C#m', 'Dm', 'Ebm', 'Em', 'Fm', 'F#m', 'Gm', 'G#m', 'Am', 'Bbm', 'Bm'];
const BAND_LETTER_PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };

// { pc, minor } of a lead sheet's key ("Bb", "C#m"), or null.
function bandReadKey(text) {
  const raw = String(text || '').trim().replace(/♯/g, '#').replace(/♭/g, 'b');
  const m = /^([A-Ha-h])([#b]?)\s*(?:-?\s*(dur|moll?|m|min|minor|major|maj))?$/i.exec(raw);
  if (!m) return null;
  const quality = (m[3] || '').toLowerCase();
  let minor = quality.startsWith('m') && quality !== 'maj' && quality !== 'major';
  if (!quality && !m[2] && m[1] === m[1].toLowerCase()) minor = true;
  const pc = (BAND_LETTER_PC[m[1].toUpperCase()] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0) + 12) % 12;
  return { pc, minor };
}

// The menu's label for a shift in semitones (-5..+6): "1.5 ↑", "Original" for 0.
function bandTransposeLabel(semitones) {
  return semitones ? `${Math.abs(semitones) / 2} ${semitones > 0 ? '↑' : '↓'}` : 'Original';
}

// Semitones of a stored Revytoneart ('' and "Original" = 0), or null for an
// old free-text value that isn't a shift.
function bandTransposeSemitones(text) {
  const raw = String(text || '').trim();
  if (raw === '' || raw === '-' || raw.toLowerCase() === 'original') return 0;
  const m = /^(\d+(?:[.,]5)?)\s*([↑↓])$/.exec(raw);
  if (!m) return null;
  const semitones = Math.round(parseFloat(m[1].replace(',', '.')) * 2);
  return m[2] === '↑' ? semitones : -semitones;
}

// The key `semitones` away from a sheet's key, in fixed spellings ('' if unreadable).
function bandTransposeKey(key, semitones) {
  const k = bandReadKey(key);
  if (!k) return '';
  return (k.minor ? BAND_MINOR_KEYS : BAND_MAJOR_KEYS)[(k.pc + semitones + 1200) % 12];
}

// The Revytoneart menu: "-" (not set) at the top, then 3 ↑ down to 2.5 ↓
// with "Original" between 0.5 ↑ and 0.5 ↓. An old free-text value stays
// listed as its own option (under "-") until someone picks another.
function bandRevyKeyField(row, tr) {
  const options = [{ value: '', label: '-' }];
  for (let t = 6; t >= -5; t--) options.push({ value: bandTransposeLabel(t), label: bandTransposeLabel(t) });
  const raw = (row.revytoneart || '').trim();
  const semitones = bandTransposeSemitones(raw);
  let value = raw;
  if (semitones === null) options.splice(1, 0, { value: raw, label: raw });
  else if (raw !== '' && raw !== '-') value = bandTransposeLabel(semitones);
  else value = '';
  const field = siteCreateDropdownField(options, value, '-');
  field.classList.add('band-key-field');
  field.disabled = !bandCanEdit();
  field.addEventListener('change', () => {
    if (field.value === (row.revytoneart || '')) return;
    row.revytoneart = field.value;
    bandCommitRow(row, { revytoneart: field.value }, tr);
  });
  return field;
}

let bandFolder = '';
let bandState = null; // { rows, instruments, columnLabels, columnWidths } once loaded
let bandDragRow = null;
const bandOpenFolders = new Set(); // expanded folder ids in the Noder tab
let bandArchiveCards = null; // Map normalized title → {key, title, sources:[row]} (Arkiv tab)
const bandArkivOpen = new Set(); // expanded Arkiv card keys

// An extra instance (MatGalla, …) has no revy titles, so its songs go by
// their original title; an Arkiv revy prefers the revy title.
function bandSongLabel(row) {
  const revy = (row.revytitel || '').trim();
  const original = (row.originaltitel || '').trim();
  const label = bandIsInstance(row._folder || bandFolder) ? (original || revy) : (revy || original);
  return label || 'Unavngivet sang';
}

function bandRowHasContent(row) {
  if (row.type === 'section') return (row.title || '').trim() !== '';
  return bandAllValueKeys().some((key) => (row[key] || '').trim() !== '');
}

// ── Load + render ────────────────────────────────────────────
async function bandLoad(root) {
  root.replaceChildren(el('p', 'site-muted', 'Indlæser…'));
  if (bandActiveTab === 'arkiv') {
    const archive = await bandApi('band_archive_read', {});
    if (!archive.ok) {
      const card = el('section', 'card');
      card.appendChild(el('p', 'band-error', archive.message || 'Kunne ikke indlæse arkivet.'));
      root.replaceChildren(card);
      return;
    }
    bandArchiveCards = bandBuildArchiveCards(archive.data.songs || []);
    bandRender(root);
    return;
  }
  const result = await bandApi('band_read', {});
  if (!result.ok) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'band-error', result.message || 'Kunne ikke indlæse bandmappen.'));
    root.replaceChildren(card);
    return;
  }
  const labels = result.data.columnLabels;
  const widths = result.data.columnWidths;
  bandState = {
    rows: result.data.rows || [],
    instruments: result.data.instruments || [],
    // An empty PHP map can arrive as [] — always keep a plain object.
    columnLabels: (labels && !Array.isArray(labels)) ? labels : {},
    columnWidths: (widths && !Array.isArray(widths)) ? widths : {},
    customColumns: result.data.customColumns || [],
    hiddenColumns: result.data.hiddenColumns || [],
    // {rowId: key} of the saved lead sheets that have a key set.
    leadsheetKeys: (result.data.leadsheetKeys && !Array.isArray(result.data.leadsheetKeys)) ? result.data.leadsheetKeys : {},
    // {act code: [song row ids]}: the Leadsheets tab's print order.
    printActs: bandNormalizePrintActs(result.data.printActs),
  };
  bandRender(root);
}

function bandRender(root) {
  root.replaceChildren();
  if (bandActiveTab === 'arkiv') {
    if (!bandArchiveCards) return;
    bandRenderTabs(root);
    bandRenderArkiv(root);
    return;
  }
  if (!bandState) return;
  bandRenderTabs(root);
  if (bandActiveTab === 'noder') bandRenderNoder(root);
  else if (bandActiveTab === 'leadsheets') bandRenderLeadsheets(root);
  else bandRenderOversigt(root);
}

// The shared tab bar (.site-tabs, style.css).
function bandRenderTabs(root) {
  const tabs = el('div', 'site-tabs');
  for (const tab of BAND_TABS) {
    const btn = el('button', 'site-tab' + (tab.key === bandActiveTab ? ' active' : ''), tab.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (tab.key === bandActiveTab) return;
      bandActiveTab = tab.key;
      try { localStorage.setItem(BAND_TAB_KEY, bandActiveTab); } catch (e) { /* ignore */ }
      // Re-read so each tab shows what others saved meanwhile.
      bandLoad(root);
    });
    tabs.appendChild(btn);
  }
  root.appendChild(tabs);
}

function bandShowError(message) {
  if (!message) return;
  siteShowToast(message);
}

// A 409/404 means the page is out of date — reload rather than keep
// editing a stale copy.
function bandHandleFailure(result) {
  bandShowError(result.message);
  if (result.status === 409 || result.status === 404) {
    const root = document.getElementById('band-root');
    if (root) bandLoad(root);
  }
}

// ── Oversigt: the sheet ──────────────────────────────────────
function bandRenderOversigt(root) {
  const card = el('section', 'card');
  card.appendChild(el('h2', 'band-card-title', 'Sangoversigt'));
  const editable = bandCanEdit();
  if (!editable) {
    card.appendChild(el('p', 'site-muted band-readonly-note',
      'Kun til visning. Gamle setlister kan kun redigeres af bosser.'));
  }

  const wrap = el('div', 'band-table-wrap');
  const sheet = bandBuildSheetTable(root);
  wrap.appendChild(sheet);
  card.appendChild(wrap);
  // The header row follows the page down a long sheet.
  siteStickyHead(sheet.tHead);

  // New songs come from each section's own "+"; this one adds a section.
  if (editable) {
    const addSection = bandAddPlusBtn('Tilføj sektion');
    addSection.classList.add('band-add-section');
    addSection.addEventListener('click', () => bandAddDraftRow(card, 'section', null));
    card.appendChild(addSection);
  }

  root.appendChild(card);
  // Bandmedlemmer, with the boss-only settings beside it.
  const bottom = el('div', 'band-bottom-row');
  bottom.appendChild(bandBuildInstrumentsCard());
  if (bandIsBoss()) bottom.appendChild(bandBuildBossSettingsCard());
  root.appendChild(bottom);
}

// ── Boss-indstillinger ───────────────────────────────────────
// Which revy/instance ordinary revyster can edit; the rest are view-only.
// The shared Boss Box (.site-boss-box): last on the page, a collapsible
// bare h2, open on every load.
let bandBossBoxOpen = true;

function bandBuildBossSettingsCard() {
  const card = el('section', 'card site-boss-box band-boss-card');
  const body = el('div', 'site-collapse-body');
  const { heading } = siteCollapseHeading('h2', 'Boss Box', {
    open: bandBossBoxOpen,
    body,
    onToggle: (open) => { bandBossBoxOpen = open; },
  });
  card.append(heading, body);
  body.appendChild(el('p', 'site-boss-hint',
    'Revyster kan kun redigere den aktive mappe'));
  const options = bandRevyOptions();
  if (bandActiveFolder && !options.some((o) => o.value === bandActiveFolder)) {
    options.unshift({ value: bandActiveFolder, label: bandActiveFolder });
  }
  const picker = siteCreateDropdownField(options.map(({ value, label }) => ({ value, label })), bandActiveFolder, 'Ingen valgt');
  picker.classList.add('site-toolbar-control', 'band-boss-select');
  picker.setAttribute('aria-label', 'Aktiv mappe');
  picker.addEventListener('change', async () => {
    const previous = bandActiveFolder;
    if (picker.value === previous) return;
    const result = await bandApi('band_set_active_folder', { folder: picker.value });
    if (!result.ok) {
      picker.value = previous;
      bandShowError(result.message);
      return;
    }
    bandActiveFolder = result.data.activeFolder || '';
    const chosen = options.find((o) => o.value === bandActiveFolder);
    siteShowToast(`Aktiv mappe: ${chosen ? chosen.label : bandActiveFolder}`);
  });
  // Label and menu on one line.
  const field = el('div', 'band-boss-field');
  const label = el('label', 'band-boss-label', 'Aktiv mappe');
  field.appendChild(label);
  field.appendChild(picker);
  body.appendChild(field);
  body.appendChild(el('p', 'site-muted band-boss-note',
    'MatRevy mapperne oprettes automatisk og følger Arkivet. For at oprette en mappe til Galla eller andre arrangementer bruges "+ Opret ny", som findes i menuen i øverste højre hjørne af siden. Mapper, der oprettes på den måde, kan (i modsætning til revy-mapperne) redigeres og slettes løbende.'));
  return card;
}

// The drag handle and the first column stay put while the sheet scrolls
// sideways (.site-sheet-sticky, style.css).
function bandStickyCell(cell, left) {
  cell.classList.add('site-sheet-sticky');
  cell.style.left = `${left}px`;
  return cell;
}

// Fixed table layout driven by a <colgroup>, so a dragged width is exact
// and the other columns don't shift to absorb it.
function bandBuildSheetTable(root) {
  const table = el('table', 'band-table band-sheet-table site-sheet site-sheet-lines');
  const colgroup = el('colgroup');
  const cols = {};
  const addCol = (key, width) => {
    const c = el('col');
    c.style.width = `${width}px`;
    colgroup.appendChild(c);
    if (key) cols[key] = c;
  };
  const columns = bandSheetColumns();
  addCol(null, BAND_HANDLE_COL_WIDTH);
  for (const col of columns) addCol(col.key, bandColumnWidth(col));
  addCol(null, BAND_ACTIONS_COL_WIDTH);
  table.appendChild(colgroup);
  bandUpdateSheetWidth(table);

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(bandStickyCell(el('th', 'band-col-handle site-sheet-noline'), 0));
  for (const col of columns) {
    const th = el('th', col.status ? 'band-col-status band-col-resizable' : 'band-col-resizable');
    if (col === columns[0]) bandStickyCell(th, BAND_HANDLE_COL_WIDTH);
    // Clearing the title and pressing Backspace/Delete once more asks to
    // remove the column (Title excepted).
    const onDeleteEmpty = col.key === BAND_LOCKED_COLUMN ? null : () => bandRemoveColumn(col);
    th.appendChild(bandColumnTitleInput(col.key, col.label, onDeleteEmpty));
    if (bandCanEdit()) th.appendChild(bandColumnResizer(col, cols[col.key], table));
    headRow.appendChild(th);
  }
  const addTh = el('th', 'band-col-actions site-sheet-noline');
  if (bandCanEdit()) {
    const addColBtn = bandAddPlusBtn('Tilføj kolonne');
    addColBtn.addEventListener('click', bandOpenAddColumnModal);
    addTh.appendChild(addColBtn);
  }
  headRow.appendChild(addTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of bandState.rows) {
    tbody.appendChild(row.type === 'section' ? bandRenderSectionRow(row) : bandRenderSongRow(row));
  }
  tbody.appendChild(bandBuildDropTail());
  table.appendChild(tbody);
  return table;
}

// ── Resizable columns ────────────────────────────────────────
function bandColumnWidth(col) {
  const px = bandState.columnWidths[col.key];
  return Number.isInteger(px) ? px : col.width;
}

function bandUpdateSheetWidth(table) {
  const total = BAND_HANDLE_COL_WIDTH + BAND_ACTIONS_COL_WIDTH
    + bandSheetColumns().reduce((sum, col) => sum + bandColumnWidth(col), 0);
  // Never narrower than the card, so the margins either side always match;
  // wider columns overflow into the .band-table-wrap scroll.
  table.style.width = `max(100%, ${total}px)`;
}

// A grip on the header's right edge: drag to resize (pointer events, so
// touch works too), double-click to go back to the default width.
function bandColumnResizer(col, colEl, table) {
  const grip = el('div', 'band-col-resizer');
  grip.title = 'Træk for at ændre bredden (dobbeltklik for standard)';
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    const startX = e.clientX;
    const startWidth = bandColumnWidth(col);
    const onMove = (ev) => {
      bandState.columnWidths[col.key] = Math.max(BAND_MIN_COL_WIDTH, Math.round(startWidth + ev.clientX - startX));
      colEl.style.width = `${bandState.columnWidths[col.key]}px`;
      bandUpdateSheetWidth(table);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      grip.classList.remove('active');
      if (bandColumnWidth(col) !== startWidth) bandSaveColumnWidths();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
  grip.addEventListener('dblclick', () => {
    if (!(col.key in bandState.columnWidths)) return;
    delete bandState.columnWidths[col.key];
    colEl.style.width = `${col.width}px`;
    bandUpdateSheetWidth(table);
    bandSaveColumnWidths();
  });
  return grip;
}

let bandColumnWidthsInFlight = null;
async function bandSaveColumnWidths() {
  if (bandColumnWidthsInFlight) await bandColumnWidthsInFlight;
  const promise = bandApi('band_save_column_widths', { columnWidths: { ...bandState.columnWidths } });
  bandColumnWidthsInFlight = promise;
  const result = await promise;
  bandColumnWidthsInFlight = null;
  if (!result.ok) bandHandleFailure(result);
}

// ── Adding/removing columns ──────────────────────────────────
// Removing a built-in column only hides it (values kept, it can be added
// back); removing a custom column deletes it with its values.
async function bandSaveColumns(customColumns, hiddenColumns) {
  const result = await bandApi('band_save_columns', { customColumns, hiddenColumns });
  if (!result.ok) { bandShowError(result.message); return false; }
  bandState.customColumns = result.data.customColumns || [];
  bandState.hiddenColumns = result.data.hiddenColumns || [];
  // A deleted custom column's title/width went with it server-side.
  const live = new Set(bandAllValueKeys());
  for (const map of [bandState.columnLabels, bandState.columnWidths]) {
    for (const key of Object.keys(map)) if (BAND_CUSTOM_KEY_RE.test(key) && !live.has(key)) delete map[key];
  }
  bandRender(document.getElementById('band-root'));
  return true;
}

function bandRemoveColumn(col) {
  const label = bandColumnLabel(col.key, col.label);
  const description = col.custom
    ? 'Kolonnen og alt dens indhold slettes. Dette kan ikke fortrydes.'
    : 'Kolonnen skjules. Indholdet gemmes og kommer tilbage, hvis du tilføjer kolonnen igen.';
  bandConfirm(`Fjern kolonnen "${label}"?`, description, 'Fjern', () => {
    if (col.custom) {
      return bandSaveColumns(bandState.customColumns.filter((c) => c.key !== col.key), bandState.hiddenColumns);
    }
    return bandSaveColumns(bandState.customColumns, [...bandState.hiddenColumns, col.key]);
  });
}

function bandOpenAddColumnModal() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj kolonne');
  modal.classList.add('band-folder-modal');
  const hidden = BAND_COLUMNS.filter((c) => bandState.hiddenColumns.includes(c.key));

  let pick = null;
  if (hidden.length) {
    pick = siteCreateDropdownField([
      { value: '', label: 'Ny kolonne' },
      ...hidden.map((c) => ({ value: c.key, label: `${bandColumnLabel(c.key, c.label)} (tidligere fjernet)` })),
    ], '');
    form.appendChild(siteEditField('Kolonne', pick));
  }
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 100;
  nameInput.placeholder = 'Fx Kommentar';
  const nameField = siteEditField('Navn', nameInput);
  const typePick = siteCreateDropdownField([
    { value: 'text', label: 'Tekst' },
    { value: 'status', label: 'Status (- / (Tjek!) / Tjek!)' },
  ], 'text');
  const typeField = siteEditField('Type', typePick);
  form.appendChild(nameField);
  form.appendChild(typeField);
  if (pick) {
    pick.addEventListener('change', () => {
      nameField.hidden = typeField.hidden = pick.value !== '';
    });
  }

  const addBtn = bandPillBtn('Tilføj', 'site-btn-success');
  async function submit() {
    let ok;
    if (pick && pick.value) {
      addBtn.disabled = true;
      ok = await bandSaveColumns(bandState.customColumns, bandState.hiddenColumns.filter((k) => k !== pick.value));
    } else {
      const label = nameInput.value.trim();
      if (!label) { error.textContent = 'Skriv et navn.'; nameInput.focus(); return; }
      addBtn.disabled = true;
      ok = await bandSaveColumns([...bandState.customColumns, { label, type: typePick.value }], bandState.hiddenColumns);
    }
    if (ok) close();
    else addBtn.disabled = false;
  }
  addBtn.addEventListener('click', submit);
  nameInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  actions.appendChild(addBtn);
  nameInput.focus();
}

// ── Renamable column titles ──────────────────────────────────
// Stored per revy as columnLabels {key: title}; only renamed columns are
// saved, so clearing a title brings the default back.
function bandColumnLabel(key, fallback) {
  const label = bandState.columnLabels[key];
  return (typeof label === 'string' && label.trim()) ? label : fallback;
}

// Editable text rather than an <input>, so a long title wraps instead of
// being cut off. Read back through textContent only.
// `onDeleteEmpty` (optional): called when Backspace/Delete is pressed on an
// already-empty title — the sheet uses it to offer removing the column.
function bandColumnTitleInput(key, fallback, onDeleteEmpty) {
  if (!bandCanEdit()) return el('div', 'band-head-input band-head-readonly', bandColumnLabel(key, fallback));
  const title = el('div', 'band-head-input', bandColumnLabel(key, fallback));
  try { title.contentEditable = 'plaintext-only'; } catch (e) { title.contentEditable = 'true'; }
  if (title.contentEditable !== 'plaintext-only') title.contentEditable = 'true';
  title.spellcheck = false;
  title.setAttribute('role', 'textbox');
  title.setAttribute('aria-label', `Kolonnetitel: ${fallback}`);
  title.title = 'Klik for at omdøbe kolonnen';
  title.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); return; }
    if ((e.key === 'Backspace' || e.key === 'Delete') && onDeleteEmpty && !(title.textContent || '').trim()) {
      e.preventDefault();
      // Put the current title back and leave the field first, so Annuller
      // leaves it as it was (and a further keypress can't stack modals).
      title.textContent = bandColumnLabel(key, fallback);
      title.blur();
      onDeleteEmpty();
    }
  });
  title.addEventListener('blur', () => {
    const value = (title.textContent || '').replace(/\s+/g, ' ').trim();
    const next = value && value !== fallback ? value : '';
    const changed = (bandState.columnLabels[key] || '') !== next;
    if (next) bandState.columnLabels[key] = next;
    else delete bandState.columnLabels[key];
    title.textContent = bandColumnLabel(key, fallback);
    if (changed) bandSaveColumnLabels();
  });
  return title;
}

let bandColumnLabelsInFlight = null;
async function bandSaveColumnLabels() {
  if (bandColumnLabelsInFlight) await bandColumnLabelsInFlight;
  const promise = bandApi('band_save_column_labels', { columnLabels: { ...bandState.columnLabels } });
  bandColumnLabelsInFlight = promise;
  const result = await promise;
  bandColumnLabelsInFlight = null;
  if (!result.ok) bandHandleFailure(result);
}

// Trailing drop zone — a per-row drop target can only insert *before* a row.
function bandBuildDropTail() {
  const tr = el('tr', 'band-drop-tail-row');
  const td = el('td');
  td.colSpan = bandSheetColumns().length + 2;
  tr.appendChild(td);
  bandWireDropHighlight(tr, () => bandMoveRow(bandDragRow, null));
  return tr;
}

// Only the handle starts a drag — a draggable row would swallow text
// selection inside its inputs.
function bandWireRowDrag(tr, handle, row) {
  handle.addEventListener('mousedown', () => { tr.draggable = row.id !== null; });
  handle.addEventListener('touchstart', () => { tr.draggable = row.id !== null; }, { passive: true });
  tr.addEventListener('dragstart', (e) => {
    bandDragRow = row;
    e.dataTransfer.effectAllowed = 'move';
    const ghost = bandGetDragImageEl();
    ghost.textContent = row.type === 'section' ? ((row.title || '').trim() || 'Sektion') : bandSongLabel(row);
    e.dataTransfer.setDragImage(ghost, 12, 16);
  });
  tr.addEventListener('dragend', () => {
    tr.draggable = false;
    bandDragRow = null;
  });
  // A draft row isn't in bandState.rows yet, so it can't be a drop anchor.
  bandWireDropHighlight(tr, () => { if (row.id !== null) bandMoveRow(bandDragRow, row); });
}

function bandGetDragImageEl() {
  let ghost = document.getElementById('band-drag-image');
  if (!ghost) {
    ghost = el('div', 'band-drag-image');
    ghost.id = 'band-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// Duplicated from koordinator.js's koordWireDropHighlight. `isActive` says
// whether the current drag belongs to this list (default: the sheet's rows).
function bandWireDropHighlight(rowEl, onDrop, isActive = () => !!bandDragRow) {
  let depth = 0;
  rowEl.addEventListener('dragenter', (e) => {
    if (!isActive()) return;
    e.preventDefault();
    depth++;
    rowEl.classList.add('band-drop-target');
  });
  rowEl.addEventListener('dragover', (e) => { if (isActive()) e.preventDefault(); });
  rowEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) rowEl.classList.remove('band-drop-target');
  });
  rowEl.addEventListener('drop', (e) => {
    if (!isActive()) return;
    e.preventDefault();
    depth = 0;
    rowEl.classList.remove('band-drop-target');
    onDrop();
  });
}

// Moves `item` to just before `target` (null = the end), optimistically,
// then sends the full id order.
async function bandMoveRow(item, target) {
  if (!item || item === target || item.id === null) return;
  const rows = bandState.rows;
  const previous = rows.slice();
  const from = rows.indexOf(item);
  if (from === -1) return;
  rows.splice(from, 1);
  const to = target ? rows.indexOf(target) : rows.length;
  rows.splice(to === -1 ? rows.length : to, 0, item);
  if (rows.every((r, i) => r === previous[i])) return;
  const root = document.getElementById('band-root');
  bandRender(root);
  const result = await bandApi('band_reorder', { order: rows.map((r) => r.id) });
  if (!result.ok) {
    bandState.rows = previous;
    bandRender(root);
    bandHandleFailure(result);
  }
}

function bandRenderHandleCell(tr, row) {
  const td = bandStickyCell(el('td', 'band-col-handle site-sheet-noline'), 0);
  if (!bandCanEdit()) { tr.appendChild(td); return; }
  const handle = el('span', 'boss-manage-drag-handle band-drag-handle', '⠿');
  handle.title = 'Træk for at flytte';
  td.appendChild(handle);
  tr.appendChild(td);
  bandWireRowDrag(tr, handle, row);
}

function bandCreateTextInput(row, key, tr, className) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'site-inline-field band-field' + (className ? ' ' + className : '');
  input.value = row[key] || '';
  input.readOnly = !bandCanEdit();
  input.addEventListener('blur', () => {
    if ((row[key] || '') === input.value && row.id !== null) return;
    row[key] = input.value;
    bandCommitRow(row, { [key]: input.value }, tr);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  return input;
}

function bandRenderSongRow(row) {
  const tr = el('tr', 'band-song-row');
  bandRenderHandleCell(tr, row);
  const columns = bandSheetColumns();
  for (const col of columns) {
    if (col.status) {
      const td = el('td', 'band-col-status');
      td.appendChild(bandStatusPill(row, col.key, tr));
      tr.appendChild(td);
      continue;
    }
    const td = el('td');
    if (col === columns[0]) bandStickyCell(td, BAND_HANDLE_COL_WIDTH);
    if (col.key === 'revytoneart') {
      td.appendChild(bandRevyKeyField(row, tr));
    } else {
      td.appendChild(bandCreateTextInput(row, col.key, tr));
    }
    tr.appendChild(td);
  }
  const actions = el('td', 'band-col-actions site-sheet-noline');
  if (bandCanEdit()) {
    const removeBtn = bandRemoveBtn('Slet sang');
    removeBtn.addEventListener('click', () => bandDeleteRow(row, tr));
    actions.appendChild(removeBtn);
  }
  tr.appendChild(actions);
  return tr;
}

function bandRenderSectionRow(row) {
  const tr = el('tr', 'band-section-row site-sheet-section');
  bandRenderHandleCell(tr, row);
  const td = el('td', 'band-section-cell');
  td.colSpan = bandSheetColumns().length;
  const input = bandCreateTextInput(row, 'title', tr, 'band-section-input');
  input.placeholder = 'Sektionsnavn';
  td.appendChild(input);
  tr.appendChild(td);
  const actions = el('td', 'band-col-actions site-sheet-noline');
  if (bandCanEdit()) {
    const addBtn = bandAddPlusBtn('Tilføj sang i denne sektion');
    addBtn.addEventListener('click', () => {
      const card = tr.closest('.card');
      bandAddDraftRow(card, 'song', row);
    });
    const removeBtn = bandRemoveBtn('Slet sektion');
    removeBtn.addEventListener('click', () => bandDeleteRow(row, tr));
    actions.appendChild(addBtn);
    actions.appendChild(removeBtn);
  }
  tr.appendChild(actions);
  return tr;
}

function bandStatusMeta(value) {
  return BAND_STATUSES.find((s) => s.value === value) || BAND_STATUSES[0];
}

function bandStatusPill(row, key, tr) {
  const btn = el('button', 'band-status');
  btn.type = 'button';
  function paint() {
    const meta = bandStatusMeta(row[key] || '');
    btn.className = 'band-status ' + meta.cls;
    btn.textContent = meta.label;
    btn.title = bandCanEdit() ? `${meta.title} (klik for at skifte)` : meta.title;
  }
  paint();
  btn.disabled = !bandCanEdit();
  btn.addEventListener('click', () => {
    const idx = BAND_STATUSES.findIndex((s) => s.value === (row[key] || ''));
    row[key] = BAND_STATUSES[(idx + 1) % BAND_STATUSES.length].value;
    paint();
    bandCommitRow(row, { [key]: row[key] }, tr);
  });
  return btn;
}

// The last row belonging to `section` (the section itself if it's empty)
// — a new song goes right after it.
function bandLastRowOfSection(section) {
  const rows = bandState.rows;
  let idx = rows.indexOf(section);
  if (idx === -1) return null;
  while (idx + 1 < rows.length && rows[idx + 1].type !== 'section') idx++;
  return rows[idx];
}

// Adds an unsaved row to the table; it's created server-side on the first
// blur that leaves it non-empty (an abandoned "+" leaves nothing behind).
// `section` (optional) = insert at the end of that section.
function bandAddDraftRow(card, type, section) {
  const row = type === 'section'
    ? { id: null, type: 'section', title: '' }
    : { id: null, type: 'song', files: [] };
  if (type === 'song') bandAllValueKeys().forEach((key) => { row[key] = ''; });
  const after = section ? bandLastRowOfSection(section) : null;
  row._afterId = after ? after.id : null;

  const tr = type === 'section' ? bandRenderSectionRow(row) : bandRenderSongRow(row);
  tr.classList.add('band-draft-row');
  const tbody = card.querySelector('.band-table tbody');
  let anchor = tbody.querySelector('.band-drop-tail-row');
  if (after) {
    const afterIdx = bandState.rows.indexOf(after);
    const domRows = Array.from(tbody.querySelectorAll('tr.band-song-row, tr.band-section-row'))
      .filter((r) => !r.classList.contains('band-draft-row'));
    anchor = domRows[afterIdx + 1] || anchor;
  }
  tbody.insertBefore(tr, anchor);
  const first = tr.querySelector('input');
  if (first) first.focus();
}

// Commits `fields` of one row. A draft row is created with all its current
// fields; commits on the same row are serialized via row._inFlight so two
// quick blurs on a draft can't create it twice.
async function bandCommitRow(row, fields, tr) {
  if (row.id === null && !bandRowHasContent(row)) return;
  if (row._inFlight) await row._inFlight;
  const isNew = row.id === null;
  let body;
  if (isNew) {
    const payload = { type: row.type };
    if (row.type === 'section') payload.title = row.title || '';
    else bandAllValueKeys().forEach((key) => { payload[key] = row[key] || ''; });
    body = { row: payload };
    if (row._afterId) body.afterId = row._afterId;
  } else {
    body = { row: { id: row.id, type: row.type, ...fields } };
  }
  const promise = bandApi('band_upsert_row', body);
  row._inFlight = promise;
  const result = await promise;
  row._inFlight = null;
  if (!result.ok) {
    bandHandleFailure(result);
    return;
  }
  if (isNew) {
    row.id = result.data.row.id;
    if (tr) tr.classList.remove('band-draft-row');
    const after = row._afterId ? bandState.rows.find((r) => r.id === row._afterId) : null;
    const idx = after ? bandState.rows.indexOf(after) + 1 : bandState.rows.length;
    bandState.rows.splice(idx, 0, row);
    delete row._afterId;
  }
}

function bandDeleteRow(row, tr) {
  if (row.id === null) {
    tr.remove();
    return;
  }
  const fileCount = (row.files || []).length;
  const isSection = row.type === 'section';
  const name = isSection ? ((row.title || '').trim() || 'denne sektion') : bandSongLabel(row);
  let description = 'Dette kan ikke fortrydes.';
  if (isSection) description = 'Kun overskriften slettes. Sangene under den bliver liggende.';
  else if (fileCount) description = `Mappen med ${fileCount} fil${fileCount === 1 ? '' : 'er'} slettes også. Dette kan ikke fortrydes.`;
  bandConfirm(`Slet "${name}"?`, description, 'Slet', async () => {
    const result = await bandApi('band_delete_row', { rowId: row.id });
    if (!result.ok) { bandShowError(result.message); return false; }
    bandState.rows = bandState.rows.filter((r) => r !== row);
    bandOpenFolders.delete(row.id);
    bandRender(document.getElementById('band-root'));
    return true;
  });
}

// Styled "Er du sikker?" overlay. onConfirm returns false to keep the modal
// open (e.g. on a failed request).
function bandConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('site-confirm-modal');
  if (description) form.appendChild(el('p', 'site-confirm-sub', description));
  const cancelBtn = bandPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = bandPillBtn(confirmLabel, 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const ok = await onConfirm();
    if (ok === false) { confirmBtn.disabled = false; return; }
    close();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Oversigt: instruments ────────────────────────────────────
function bandBuildInstrumentsCard() {
  const editable = bandCanEdit();
  const card = el('section', 'card band-instruments-card');
  card.appendChild(el('h2', null, 'Bandmedlemmer'));

  const table = el('table', 'band-table band-instruments-table site-sheet site-sheet-lines');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'band-col-handle site-sheet-noline'));
  for (const [key, fallback] of [['instrumentNavn', 'Navn'], ['instrumentName', 'Instrument(er)'], ['instrumentStemme', 'Stemmer']]) {
    const th = el('th', 'band-col-mid');
    th.appendChild(bandColumnTitleInput(key, fallback));
    headRow.appendChild(th);
  }
  headRow.appendChild(el('th', 'band-col-actions site-sheet-noline'));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);

  function addRow(item) {
    const tr = el('tr');
    const handleTd = el('td', 'band-col-handle site-sheet-noline');
    tr.appendChild(handleTd);
    if (editable) {
      const handle = el('span', 'boss-manage-drag-handle band-drag-handle', '⠿');
      handle.title = 'Træk for at flytte';
      handleTd.appendChild(handle);
      bandWireMemberDrag(tr, handle, item);
    }
    for (const key of ['navn', 'name', 'stemme']) {
      const td = el('td', 'band-col-mid');
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'site-inline-field band-field';
      input.value = item[key] || '';
      input.readOnly = !editable;
      input.addEventListener('blur', () => {
        if ((item[key] || '') === input.value) return;
        item[key] = input.value;
        bandSaveInstruments();
      });
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') input.blur(); });
      td.appendChild(input);
      tr.appendChild(td);
    }
    const actions = el('td', 'band-col-actions site-sheet-noline');
    if (editable) {
      const removeBtn = bandRemoveBtn('Fjern bandmedlem');
      removeBtn.addEventListener('click', () => {
        bandState.instruments = bandState.instruments.filter((i) => i !== item);
        tr.remove();
        if (item.id || bandMemberHasContent(item)) bandSaveInstruments();
      });
      actions.appendChild(removeBtn);
    }
    tr.appendChild(actions);
    tbody.insertBefore(tr, tail);
    return tr;
  }

  // Trailing drop zone, so a member can be moved to the end.
  const tail = el('tr', 'band-drop-tail-row');
  const tailTd = el('td');
  tailTd.colSpan = 5;
  tail.appendChild(tailTd);
  bandWireDropHighlight(tail, () => bandMoveMember(bandDragMember, null), () => !!bandDragMember);
  tbody.appendChild(tail);

  bandState.instruments.forEach(addRow);
  card.appendChild(table);
  if (!editable) return card;

  const addBtn = bandAddPlusBtn('Tilføj bandmedlem');
  addBtn.classList.add('band-instruments-add');
  addBtn.addEventListener('click', () => {
    const item = { id: null, navn: '', name: '', stemme: '' };
    bandState.instruments.push(item);
    const tr = addRow(item);
    tr.querySelector('input').focus();
  });
  card.appendChild(addBtn);
  return card;
}

// Same handle-only recipe as the sheet's rows (bandWireRowDrag).
let bandDragMember = null;
function bandWireMemberDrag(tr, handle, item) {
  handle.addEventListener('mousedown', () => { tr.draggable = true; });
  handle.addEventListener('touchstart', () => { tr.draggable = true; }, { passive: true });
  tr.addEventListener('dragstart', (e) => {
    bandDragMember = item;
    e.dataTransfer.effectAllowed = 'move';
    const ghost = bandGetDragImageEl();
    ghost.textContent = (item.navn || '').trim() || (item.name || '').trim() || 'Bandmedlem';
    e.dataTransfer.setDragImage(ghost, 12, 16);
  });
  tr.addEventListener('dragend', () => {
    tr.draggable = false;
    bandDragMember = null;
  });
  bandWireDropHighlight(tr, () => bandMoveMember(bandDragMember, item), () => !!bandDragMember);
}

// Moves `item` to just before `target` (null = the end) and saves the list.
function bandMoveMember(item, target) {
  const list = bandState.instruments;
  if (!item || item === target) return;
  const from = list.indexOf(item);
  if (from === -1) return;
  const previous = list.slice();
  list.splice(from, 1);
  const to = target ? list.indexOf(target) : list.length;
  list.splice(to === -1 ? list.length : to, 0, item);
  if (list.every((m, i) => m === previous[i])) return;
  const card = document.querySelector('.band-instruments-card');
  if (card) card.replaceWith(bandBuildInstrumentsCard());
  bandSaveInstruments();
}

function bandMemberHasContent(item) {
  return ['navn', 'name', 'stemme'].some((key) => (item[key] || '').trim() !== '');
}

// Full replace of the list; blank new rows are left out until filled in.
let bandInstrumentsInFlight = null;
async function bandSaveInstruments() {
  if (bandInstrumentsInFlight) await bandInstrumentsInFlight;
  const sent = bandState.instruments.filter((i) => i.id || bandMemberHasContent(i));
  const promise = bandApi('band_save_instruments', {
    instruments: sent.map((i) => ({ id: i.id || null, navn: i.navn || '', name: i.name || '', stemme: i.stemme || '' })),
  });
  bandInstrumentsInFlight = promise;
  const result = await promise;
  bandInstrumentsInFlight = null;
  if (!result.ok) { bandHandleFailure(result); return; }
  // Same order as sent — pick up the ids assigned to new rows.
  (result.data.instruments || []).forEach((saved, i) => { if (sent[i]) sent[i].id = saved.id; });
}

// ── Noder: one folder per song ───────────────────────────────
function bandRenderNoder(root) {
  const card = el('section', 'card');
  const head = el('div', 'card-head band-card-head');
  head.appendChild(el('h2', null, 'Noder'));
  const editable = bandCanEdit();
  if (editable) {
    const newFolderBtn = bandBtn('+ Ny mappe');
    newFolderBtn.addEventListener('click', () => bandOpenNewFolderModal(null));
    head.appendChild(newFolderBtn);
  }
  card.appendChild(head);
  card.appendChild(el('p', 'site-muted band-noder-hint',
    'Hver sang i Oversigt har sin egen mappe.'));

  // Each section's folders sit in their own 3-column grid.
  const list = el('div', 'band-folder-list');
  let hasSongs = false;
  let grid = null;
  for (const row of bandState.rows) {
    if (row.type === 'section') {
      const sectionHead = el('div', 'band-folder-section');
      sectionHead.appendChild(el('h3', 'band-folder-section-title', (row.title || '').trim() || 'Sektion'));
      if (editable) {
        const addBtn = bandAddPlusBtn('Ny mappe i denne sektion');
        addBtn.addEventListener('click', () => bandOpenNewFolderModal(row));
        sectionHead.appendChild(addBtn);
      }
      list.appendChild(sectionHead);
      grid = null;
      continue;
    }
    hasSongs = true;
    if (!grid) {
      grid = el('div', 'band-folder-grid');
      list.appendChild(grid);
    }
    grid.appendChild(bandBuildFolder(row));
  }
  // Alphabetical by the folder's title within each section (Danish
  // collation); the sheet's own order is left alone.
  for (const g of list.querySelectorAll('.band-folder-grid')) {
    const sorted = Array.from(g.children).sort((a, b) =>
      a.dataset.label.localeCompare(b.dataset.label, 'da', { sensitivity: 'base', numeric: true }));
    g.replaceChildren(...sorted);
  }
  if (!hasSongs) list.appendChild(el('p', 'site-muted', 'Ingen mapper endnu.'));
  card.appendChild(list);
  root.appendChild(card);
}

function bandBuildFolder(row) {
  const folder = el('div', 'band-folder');
  folder.dataset.rowId = row.id;
  folder.dataset.label = bandSongLabel(row);
  const isOpen = bandOpenFolders.has(row.id);
  if (isOpen) folder.classList.add('open');

  const headBtn = el('button', 'site-collapse band-folder-head');
  headBtn.type = 'button';
  headBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  headBtn.appendChild(el('span', 'site-chevron', '▾'));
  // Revy title, with the original song's title smaller underneath (an
  // extra instance shows only the title, see bandSongLabel).
  const titles = el('span', 'band-folder-titles');
  titles.appendChild(el('span', 'band-folder-name', bandSongLabel(row)));
  // Shown whenever both titles are set, even when they're identical (a song
  // kept under its own name) — only skipped when the name above already fell
  // back to the original title.
  const original = (row.originaltitel || '').trim();
  if (original && (row.revytitel || '').trim() && !bandIsInstance(bandFolder)) {
    titles.appendChild(el('span', 'band-folder-sub', original));
  }
  headBtn.appendChild(titles);
  const count = (row.files || []).length;
  headBtn.appendChild(el('span', 'band-folder-count', count === 1 ? '1 fil' : `${count} filer`));
  headBtn.addEventListener('click', () => {
    if (bandOpenFolders.has(row.id)) bandOpenFolders.delete(row.id);
    else bandOpenFolders.add(row.id);
    folder.replaceWith(bandBuildFolder(row));
  });
  folder.appendChild(headBtn);
  const editable = bandCanEdit();

  // Drag files from the desktop onto a folder (open or closed) to upload.
  if (editable) folder.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    folder.classList.add('band-folder-dragover');
  });
  folder.addEventListener('dragleave', (e) => {
    if (!folder.contains(e.relatedTarget)) folder.classList.remove('band-folder-dragover');
  });
  folder.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    folder.classList.remove('band-folder-dragover');
    bandOpenFolders.add(row.id);
    bandOpenUploadModal(row, Array.from(e.dataTransfer.files));
  });

  if (!isOpen) return folder;

  const body = el('div', 'band-folder-body');
  const files = row.files || [];
  if (!files.length) body.appendChild(el('p', 'site-muted', 'Ingen filer endnu.'));
  for (const file of bandSortedFiles(files)) body.appendChild(bandBuildFileRow(row, file));
  if (!editable) {
    folder.appendChild(body);
    return folder;
  }

  const uploadBar = el('div', 'band-upload-bar');
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = BAND_ALLOWED_EXTS.map((x) => '.' + x).join(',');
  input.hidden = true;
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    input.value = '';
    if (picked.length) bandOpenUploadModal(row, picked);
  });
  const uploadBtn = bandBtn('Upload filer');
  uploadBtn.addEventListener('click', () => input.click());
  uploadBar.appendChild(uploadBtn);
  uploadBar.appendChild(input);
  if (row._uploadStatus) uploadBar.appendChild(el('span', 'site-muted', row._uploadStatus));
  body.appendChild(uploadBar);

  folder.appendChild(body);
  return folder;
}

// Badge text: PDF, or MSC for MuseScore files (.mscz/.mscx).
function bandFileKind(ext) {
  return ext === 'pdf' ? 'PDF' : 'MSC';
}

// PDFs first, MuseScore files at the bottom; upload order within each.
function bandSortedFiles(files) {
  return files.filter((f) => f.ext === 'pdf').concat(files.filter((f) => f.ext !== 'pdf'));
}

// A file is shown by the name given at upload (e.g. "Trompet"); the type
// badge already says PDF/XML, so the extension is left off.
function bandFileDisplayName(file) {
  return (file.name || '').replace(/\.(pdf|mscz|mscx)$/i, '') || file.name;
}

function bandBuildFileRow(row, file) {
  const line = el('div', 'band-file');
  line.appendChild(el('span', 'band-file-kind band-file-kind-' + (file.ext === 'pdf' ? 'pdf' : 'mscz'), bandFileKind(file.ext)));
  const info = el('div', 'band-file-info');
  if (file.ext === 'pdf') {
    const nameBtn = el('button', 'band-file-name band-file-open', bandFileDisplayName(file));
    nameBtn.type = 'button';
    nameBtn.title = 'Åbn PDF';
    nameBtn.addEventListener('click', () => bandOpenFile(row, file));
    info.appendChild(nameBtn);
  } else {
    info.appendChild(el('span', 'band-file-name', bandFileDisplayName(file)));
  }
  line.appendChild(info);

  const actions = el('div', 'band-file-actions');
  const downloadBtn = bandIconBtn(bandDownloadIcon(), 'Download');
  downloadBtn.addEventListener('click', () => bandDownloadFile(row, file, downloadBtn));
  actions.appendChild(downloadBtn);
  // On the Arkiv tab (row._arkivKey) every file follows the archive's rights.
  if (!bandCanEdit(row._arkivKey ? BAND_ARCHIVE_FOLDER : (row._folder || bandFolder))) {
    line.appendChild(actions);
    return line;
  }
  const editBtn = bandIconBtn(bandPencilIcon(), 'Omdøb');
  editBtn.addEventListener('click', () => bandOpenRenameFileModal(row, file));
  actions.appendChild(editBtn);
  const removeBtn = bandRemoveBtn('Slet fil');
  removeBtn.addEventListener('click', () => {
    bandConfirm(`Slet "${bandFileDisplayName(file)}"?`, 'Dette kan ikke fortrydes.', 'Slet', async () => {
      const result = await bandApi('band_delete_file', { folder: row._folder || bandFolder, rowId: row.id, fileId: file.id });
      if (!result.ok) { bandShowError(result.message); return false; }
      row.files = (row.files || []).filter((f) => f.id !== file.id);
      bandRefreshRow(row);
      return true;
    });
  });
  actions.appendChild(removeBtn);
  line.appendChild(actions);
  return line;
}

// Only the shown/download name changes; the extension is kept server-side.
function bandOpenRenameFileModal(row, file) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Omdøb fil');
  modal.classList.add('band-folder-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 120;
  input.value = bandFileDisplayName(file);
  form.appendChild(siteEditField('Navn', input));

  const cancelBtn = bandPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const saveBtn = bandPillBtn('Gem', 'site-btn-success');
  async function submit() {
    const name = input.value.trim();
    if (!name) { error.textContent = 'Giv filen et navn.'; input.focus(); return; }
    if (name === bandFileDisplayName(file)) { close(); return; }
    saveBtn.disabled = true;
    error.textContent = '';
    const result = await bandApi('band_rename_file', { folder: row._folder || bandFolder, rowId: row.id, fileId: file.id, name });
    saveBtn.disabled = false;
    if (!result.ok) { if (result.message) error.textContent = result.message; return; }
    row.files = result.data.row.files || [];
    bandRefreshRow(row);
    close();
  }
  saveBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  input.focus();
  input.select();
}

// Re-renders whatever shows `row`: its Arkiv card, or its Noder folder.
function bandRefreshRow(row) {
  if (row._arkivKey) bandRerenderArkivCard(row._arkivKey);
  else bandRerenderFolder(row);
}

function bandRerenderFolder(row) {
  const list = document.querySelector('.band-folder-list');
  if (!list) return;
  // Ids are server-generated hex, safe inside the selector.
  const folder = list.querySelector(`.band-folder[data-row-id="${row.id}"]`);
  if (folder) folder.replaceWith(bandBuildFolder(row));
}

// The window is opened synchronously (inside the click) so popup blockers
// allow it, then pointed at the blob once it has arrived (location.replace
// keeps the tab at one history entry). On iOS the file opens in this tab
// instead, so Back returns here (see siteIsIos).
async function bandOpenFile(row, file) {
  const sameTab = siteIsIos();
  const win = sameTab ? null : window.open('', '_blank');
  const result = await bandFetchFile(row, file);
  if (!result.ok) {
    if (win) win.close();
    bandShowError(result.message);
    return;
  }
  const url = URL.createObjectURL(result.blob);
  if (sameTab) { window.location.href = url; return; }
  if (win) win.location.replace(url);
  else bandSaveBlob(result.blob, file.name);
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

async function bandDownloadFile(row, file, btn) {
  btn.disabled = true;
  const result = await bandFetchFile(row, file);
  btn.disabled = false;
  if (!result.ok) { bandShowError(result.message); return; }
  bandSaveBlob(result.blob, file.name);
}

function bandSaveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10 * 1000);
}

function bandReadAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function bandFileExt(name) {
  return name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
}

// Picked or dropped files: drop (with a toast) anything of the wrong type
// or too large, then ask what each remaining file is — the sheet's name
// (Trompet, Sax, …) becomes the file's name on the page.
function bandOpenUploadModal(row, files) {
  if (row._uploading) { siteShowToast('Vent til den igangværende upload er færdig.'); return; }
  const valid = files.filter((file) => {
    if (!BAND_ALLOWED_EXTS.includes(bandFileExt(file.name))) {
      siteShowToast(`"${file.name}" blev sprunget over (kun .pdf, .mscz og .mscx).`);
      return false;
    }
    if (file.size > BAND_MAX_UPLOAD_MB * 1024 * 1024) {
      siteShowToast(`"${file.name}" er for stor (maks. ${BAND_MAX_UPLOAD_MB} MB).`);
      return false;
    }
    return true;
  });
  if (!valid.length) return;

  const { modal, form, error, actions, close } = siteOpenModalWithClose(
    valid.length === 1 ? 'Upload fil' : `Upload ${valid.length} filer`
  );
  modal.classList.add('band-upload-modal');
  form.appendChild(el('p', 'band-upload-hint', `Til "${bandSongLabel(row)}". Skriv hvilken stemme hver fil er.`));

  const entries = valid.map((file) => {
    const ext = bandFileExt(file.name);
    const item = el('div', 'edit-field band-upload-item'); // .edit-field = site input styling
    const head = el('div', 'band-upload-item-head');
    head.appendChild(el('span', 'band-file-kind band-file-kind-' + (ext === 'pdf' ? 'pdf' : 'mscz'), bandFileKind(ext)));
    head.appendChild(el('span', 'band-upload-filename', file.name));
    item.appendChild(head);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 120;
    input.placeholder = 'Navn, fx Trompet';
    input.setAttribute('aria-label', `Navn til ${file.name}`);
    item.appendChild(input);
    form.appendChild(item);
    return { file, ext, input };
  });

  const cancelBtn = bandPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const uploadBtn = bandPillBtn('Upload', 'site-btn-success');
  function submit() {
    const missing = entries.find((entry) => !entry.input.value.trim());
    if (missing) {
      error.textContent = 'Giv hver fil et navn.';
      missing.input.focus();
      return;
    }
    close();
    bandUploadFiles(row, entries.map(({ file, ext, input }) => ({
      file,
      name: `${input.value.trim().replace(/[\\/]/g, '-')}.${ext}`,
    })));
  }
  uploadBtn.addEventListener('click', submit);
  entries.forEach(({ input }, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i + 1 < entries.length) entries[i + 1].input.focus();
      else submit();
    });
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(uploadBtn);
  entries[0].input.focus();
}

// Uploads one at a time (each is a large JSON body); a failed file is
// reported and skipped, the rest still go. `items` = [{file, name}], name
// being the one given in bandOpenUploadModal.
async function bandUploadFiles(row, items) {
  if (row._uploading) { siteShowToast('Vent til den igangværende upload er færdig.'); return; }
  // An Arkiv card without an archive-store row yet creates it first.
  if (row.id === null && row._ensureCreated && !(await row._ensureCreated())) return;
  row._uploading = true;
  let done = 0;
  for (const { file, name } of items) {
    row._uploadStatus = items.length > 1 ? `Uploader ${done + 1} af ${items.length}…` : 'Uploader…';
    bandRefreshRow(row);
    let contentBase64;
    try {
      contentBase64 = await bandReadAsBase64(file);
    } catch (e) {
      siteShowToast(`Kunne ikke læse "${file.name}".`);
      continue;
    }
    const result = await bandApi('band_upload_file', { folder: row._folder || bandFolder, rowId: row.id, name, contentBase64 });
    if (!result.ok) {
      if (result.message) siteShowToast(`"${file.name}": ${result.message}`);
      if (result.status === 404) break;
      continue;
    }
    row.files = result.data.row.files || [];
    done++;
  }
  row._uploading = false;
  row._uploadStatus = '';
  bandRefreshRow(row);
  if (done) siteShowToast(done === 1 ? 'Filen er uploadet.' : `${done} filer er uploadet.`);
}

// "+ Ny mappe" = a new song row (revy title only); its other columns are
// filled in from Oversigt. `section` (optional) = put it at the end of
// that section, else at the very end.
function bandOpenNewFolderModal(section) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Ny mappe');
  modal.classList.add('band-folder-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Revytitel';
  form.appendChild(siteEditField('Sangens revytitel', input));

  const sections = bandState.rows.filter((r) => r.type === 'section' && r.id);
  let sectionField = null;
  if (sections.length) {
    sectionField = siteCreateDropdownField(
      sections.map((s) => ({ value: s.id, label: (s.title || '').trim() || 'Sektion' })),
      section ? section.id : sections[0].id
    );
    form.appendChild(siteEditField('Sektion', sectionField));
  }

  const createBtn = bandPillBtn('Opret', 'site-btn-success');
  async function submit() {
    const title = input.value.trim();
    if (!title) { error.textContent = 'Skriv en titel.'; return; }
    createBtn.disabled = true;
    error.textContent = '';
    const target = sectionField ? sections.find((s) => s.id === sectionField.value) : null;
    const after = target ? bandLastRowOfSection(target) : null;
    const body = { row: { type: 'song', revytitel: title } };
    if (after) body.afterId = after.id;
    const result = await bandApi('band_upsert_row', body);
    if (!result.ok) {
      createBtn.disabled = false;
      error.textContent = result.message || '';
      return;
    }
    const row = result.data.row;
    const idx = after ? bandState.rows.indexOf(after) + 1 : bandState.rows.length;
    bandState.rows.splice(idx, 0, row);
    bandOpenFolders.add(row.id);
    close();
    bandRender(document.getElementById('band-root'));
  }
  createBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  actions.appendChild(createBtn);
  input.focus();
}

// ── Arkiv: every revy's songs + the _arkiv store ─────────────
// ── Leadsheets: one lead sheet per song ──────────────────────
// Every song row has a lead sheet (an empty one until someone saves it):
// a card per song like Noder's folders, in Oversigt's order, with the revy
// key where Noder has its file count and the sheet's own key under it. A
// card opens leadsheet.html, which runs the vendored Lead Sheets editor
// (vendor/leadsheets/) in Practice mode, in the revy key; Edit is there
// when the folder is writable.
function bandLeadsheetHref(row) {
  const params = new URLSearchParams({ revy: bandFolder, song: row.id });
  return `leadsheet?${params}`;
}

// A song's Revytoneart as the Leadsheets cards show it: the revy key with
// its shift ("Eb (0.5 ↑)"), or just the shift while the sheet has no key;
// "Original" / "-" as picked; an old free-text value as typed.
function bandRevyKeyText(row) {
  const sheetKey = bandState.leadsheetKeys[row.id] || '';
  const raw = (row.revytoneart || '').trim();
  const semitones = bandTransposeSemitones(raw);
  if (semitones === null) return raw;
  if (semitones !== 0) {
    const revyKey = sheetKey ? bandTransposeKey(sheetKey, semitones) : '';
    return revyKey ? `${revyKey} (${bandTransposeLabel(semitones)})` : bandTransposeLabel(semitones);
  }
  return raw.toLowerCase() === 'original' ? 'Original' : '-';
}

function bandBuildLeadsheetCard(row) {
  const card = el('a', 'band-folder band-ls-card');
  card.href = bandLeadsheetHref(row);
  const titles = el('span', 'band-folder-titles');
  titles.appendChild(el('span', 'band-folder-name', bandSongLabel(row)));
  const original = (row.originaltitel || '').trim();
  if (original && (row.revytitel || '').trim() && !bandIsInstance(bandFolder)) {
    titles.appendChild(el('span', 'band-folder-sub', original));
  }
  card.appendChild(titles);
  // Revytoneart on top, the sheet's own key (set in the editor) under it.
  const keys = el('span', 'band-ls-keys');
  const sheetKey = bandState.leadsheetKeys[row.id] || '';
  const top = el('span', 'band-ls-key', bandRevyKeyText(row));
  top.title = 'Revytoneart';
  keys.appendChild(top);
  if (sheetKey) {
    const sub = el('span', 'band-ls-key-original', bandTransposeKey(sheetKey, 0) || sheetKey);
    sub.title = 'Leadsheetets toneart';
    keys.appendChild(sub);
  }
  card.appendChild(keys);
  return card;
}

function bandRenderLeadsheets(root) {
  const card = el('section', 'card');
  card.appendChild(el('h2', 'band-card-title', 'Leadsheets'));
  card.appendChild(el('p', 'site-muted band-noder-hint', 'Hver sang i Oversigt har sit eget leadsheet.'));
  // Each section's cards sit in their own 3-column grid, as in Noder.
  const list = el('div', 'band-folder-list');
  let hasSongs = false;
  let grid = null;
  for (const row of bandState.rows) {
    if (row.type === 'section') {
      const sectionHead = el('div', 'band-folder-section');
      sectionHead.appendChild(el('h3', 'band-folder-section-title', (row.title || '').trim() || 'Sektion'));
      list.appendChild(sectionHead);
      grid = null;
      continue;
    }
    hasSongs = true;
    if (!grid) {
      grid = el('div', 'band-folder-grid');
      list.appendChild(grid);
    }
    grid.appendChild(bandBuildLeadsheetCard(row));
  }
  if (!hasSongs) list.appendChild(el('p', 'site-muted', 'Ingen sange endnu. Tilføj dem i Oversigt.'));
  card.appendChild(list);
  root.appendChild(card);
  root.appendChild(bandBuildPrintCard());
}

// ── Leadsheets → Samlet PDF: the revy's sheets in one PDF ────
// Laid out like Manus's Aktfordeling: an act column per act (Manus's fixed
// Akt 1/2/3/Ekstranumre) with "Ikke placeret" below, where every song starts.
// Songs are dragged into the acts in playing order (stored per band folder
// as printActs, live like the sheet: last save wins). Udskriv builds one PDF
// in the browser: a front page with the revy's Arkiv cover photo (laid out
// like Program.pdf's front cover), then every placed song's lead sheet in
// order, moved by its Revytoneart. The sheets are drawn by the vendored
// editor in bundle mode in a hidden iframe (leadsheet?bundle=1), the cover
// added with pdf-lib (js/vendor/pdf-lib.min.js, as Manus's Custom print).
// Nothing is stored: the PDF opens in a new tab.
const BAND_PRINT_ACTS = [ // mirrors band_print_act_codes() and manusBuildActSkeleton()
  { code: '1', label: 'Akt 1' },
  { code: '2', label: 'Akt 2' },
  { code: '3', label: 'Akt 3' },
  { code: 'E', label: 'Ekstranumre' },
];
const BAND_PRINT_POOL = 'pool';
const BAND_PRINT_EVEN_START = ['2', '3']; // acts whose first sheet goes on an even page
const BAND_PLACEHOLDER_COVER = 'archive/_assets/placeholder-cover.jpg'; // = generate-pdfs.js's
let bandPrintDragId = null;
let bandPrintCardEl = null;

function bandNormalizePrintActs(raw) {
  const out = {};
  for (const act of BAND_PRINT_ACTS) {
    const ids = raw && !Array.isArray(raw) && Array.isArray(raw[act.code]) ? raw[act.code] : [];
    out[act.code] = ids.filter((id) => typeof id === 'string');
  }
  return out;
}

function bandSongRows() {
  return bandState.rows.filter((r) => r.type === 'song' && r.id !== null);
}

// Rows per act in print order, plus the unplaced ones (Oversigt's order).
function bandPrintLanes() {
  const byId = new Map(bandSongRows().map((r) => [r.id, r]));
  const placed = new Set();
  const lanes = {};
  for (const act of BAND_PRINT_ACTS) {
    lanes[act.code] = bandState.printActs[act.code]
      .filter((id) => byId.has(id) && !placed.has(id) && placed.add(id))
      .map((id) => byId.get(id));
  }
  lanes[BAND_PRINT_POOL] = bandSongRows().filter((r) => !placed.has(r.id));
  return lanes;
}

function bandBuildPrintCard() {
  const card = el('section', 'card band-print-card');
  bandPrintCardEl = card;
  const head = el('div', 'band-print-head');
  head.appendChild(el('h2', 'band-card-title', 'Samlet PDF'));
  const printBtn = bandBtn('Udskriv', 'band-print-btn');
  printBtn.addEventListener('click', () => bandPrintLeadsheets(printBtn));
  head.appendChild(printBtn);
  card.appendChild(head);
  card.appendChild(el('p', 'site-muted band-noder-hint', bandCanEdit()
    ? 'Træk sangene ind i akterne i den rækkefølge, de skal med. Udskriv laver én PDF med årets forsidebillede og de placerede sange i revytonearten.'
    : 'Udskriv laver én PDF med årets forsidebillede og de placerede sange i revytonearten.'));

  const editable = bandCanEdit();
  const lanes = bandPrintLanes();
  const kanban = el('div', 'band-print-kanban');
  for (const act of BAND_PRINT_ACTS) {
    const col = el('div', 'band-print-col');
    const header = el('div', 'band-print-col-header');
    header.appendChild(el('span', 'band-print-col-label', act.label));
    const n = lanes[act.code].length;
    header.appendChild(el('span', 'band-print-col-count', n === 1 ? '1 sang' : `${n} sange`));
    col.appendChild(header);
    const list = el('div', 'band-print-col-list');
    for (const row of lanes[act.code]) list.appendChild(bandBuildPrintRow(row, act.code, editable));
    if (editable) {
      const tail = el('div', 'band-print-drop-tail');
      bandPrintWireDrop(tail, () => bandPrintMove(bandPrintDragId, act.code, null), true);
      list.appendChild(tail);
      bandPrintWireDrop(col, () => bandPrintMove(bandPrintDragId, act.code, null), false);
    }
    col.appendChild(list);
    kanban.appendChild(col);
  }
  card.appendChild(kanban);

  const pool = el('div', 'band-print-pool');
  const poolHeader = el('div', 'band-print-col-header');
  poolHeader.appendChild(el('span', 'band-print-col-label', 'Ikke placeret'));
  const poolCount = lanes[BAND_PRINT_POOL].length;
  poolHeader.appendChild(el('span', 'band-print-col-count', poolCount === 1 ? '1 sang' : `${poolCount} sange`));
  pool.appendChild(poolHeader);
  const poolGrid = el('div', 'band-print-pool-grid');
  if (!lanes[BAND_PRINT_POOL].length) {
    poolGrid.appendChild(el('p', 'site-muted band-print-empty', bandSongRows().length ? 'Alle sange er placeret.' : 'Ingen sange endnu.'));
  }
  for (const row of lanes[BAND_PRINT_POOL]) poolGrid.appendChild(bandBuildPrintRow(row, BAND_PRINT_POOL, editable));
  pool.appendChild(poolGrid);
  if (editable) bandPrintWireDrop(pool, () => bandPrintMove(bandPrintDragId, BAND_PRINT_POOL, null), false);
  card.appendChild(pool);
  return card;
}

function bandBuildPrintRow(row, lane, editable) {
  const item = el('div', 'band-print-row');
  if (editable) {
    item.draggable = true;
    item.appendChild(el('span', 'band-drag-handle band-print-handle', '⠿'));
    item.addEventListener('dragstart', (e) => {
      bandPrintDragId = row.id;
      e.dataTransfer.effectAllowed = 'move';
      const ghost = bandGetDragImageEl();
      ghost.textContent = bandSongLabel(row);
      e.dataTransfer.setDragImage(ghost, 12, 16);
    });
    item.addEventListener('dragend', () => { bandPrintDragId = null; });
    // Dropping on a song inserts before it (the column's own drop = at the end).
    bandPrintWireDrop(item, () => bandPrintMove(bandPrintDragId, lane, row.id), true);
  }
  item.appendChild(el('span', 'band-print-row-title', bandSongLabel(row)));
  item.appendChild(el('span', 'band-print-row-key', bandRevyKeyText(row)));
  if (editable && lane !== BAND_PRINT_POOL) {
    const removeBtn = el('button', 'site-icon-btn site-icon-btn-danger site-icon-btn-sm band-print-row-remove', '✕');
    removeBtn.type = 'button';
    removeBtn.title = 'Flyt tilbage til "Ikke placeret"';
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => bandPrintMove(row.id, BAND_PRINT_POOL, null));
    item.appendChild(removeBtn);
  }
  return item;
}

// Copy of manus.js's wireDropHighlight, for this card's drags only. `stop`
// keeps a song's own highlight from also lighting up its column.
function bandPrintWireDrop(target, onDrop, stop) {
  let depth = 0;
  target.addEventListener('dragenter', (e) => {
    if (!bandPrintDragId) return;
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth++;
    target.classList.add('band-drop-target');
  });
  target.addEventListener('dragover', (e) => {
    if (!bandPrintDragId) return;
    e.preventDefault();
    if (stop) e.stopPropagation();
  });
  target.addEventListener('dragleave', (e) => {
    if (stop) e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) target.classList.remove('band-drop-target');
  });
  target.addEventListener('drop', (e) => {
    if (!bandPrintDragId) return;
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth = 0;
    target.classList.remove('band-drop-target');
    onDrop();
  });
}

// Moves a song into `lane` before `beforeId` (null = at the end), redraws
// the card and saves the whole order.
function bandPrintMove(id, lane, beforeId) {
  if (!id || id === beforeId) return;
  for (const act of BAND_PRINT_ACTS) {
    bandState.printActs[act.code] = bandState.printActs[act.code].filter((x) => x !== id);
  }
  if (lane !== BAND_PRINT_POOL) {
    const list = bandState.printActs[lane];
    const at = beforeId ? list.indexOf(beforeId) : -1;
    if (at === -1) list.push(id);
    else list.splice(at, 0, id);
  }
  bandPrintDragId = null;
  if (bandPrintCardEl) bandPrintCardEl.replaceWith(bandBuildPrintCard());
  bandSavePrintActs();
}

let bandPrintActsInFlight = null;
async function bandSavePrintActs() {
  if (bandPrintActsInFlight) await bandPrintActsInFlight;
  const promise = bandApi('band_save_print_acts', { printActs: bandState.printActs });
  bandPrintActsInFlight = promise;
  const result = await promise;
  bandPrintActsInFlight = null;
  if (!result.ok) bandHandleFailure(result);
}

// ── Samlet PDF: building it ──────────────────────────────────
// The editor's own key spelling for a transposed sheet (its semitonePrefersFlats).
function bandKeyPrefersFlats(pc, minor) {
  const major = minor ? (pc + 3) % 12 : pc;
  return [1, 3, 5, 8, 10].includes(major) || (minor && major === 6);
}

// A song without a saved sheet prints as the empty sheet the editor would
// open (leadsheet-page.js's lsDefaultSheet).
function bandDefaultSheet(row) {
  const revy = (row.revytitel || '').trim();
  const original = (row.originaltitel || '').trim();
  const useRevy = !bandIsInstance(bandFolder) && revy !== '';
  return {
    id: row.id,
    title: (useRevy ? revy : original) || 'Unavngivet sang',
    artist: useRevy ? original : '',
    key: '',
    elements: [],
  };
}

// The hidden iframe running the editor in bundle mode; resolves to its
// buildLeadSheetBundle once the editor script has loaded. Off screen but
// laid out (not display:none / visibility:hidden, which the editor would
// copy into the drawn sheets), and wide enough for the desktop layout.
let bandBundlePromise = null;
function bandLoadBundleBuilder() {
  if (bandBundlePromise) return bandBundlePromise;
  bandBundlePromise = new Promise((resolve, reject) => {
    const frame = document.createElement('iframe');
    frame.className = 'band-bundle-frame';
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.src = 'leadsheet?bundle=1';
    const started = Date.now();
    const poll = () => {
      let build = null;
      try { build = frame.contentWindow && frame.contentWindow.buildLeadSheetBundle; } catch (e) { build = null; }
      if (typeof build === 'function') { resolve(build); return; }
      if (Date.now() - started > 20000) {
        frame.remove();
        bandBundlePromise = null;
        reject(new Error('bundle'));
        return;
      }
      setTimeout(poll, 100);
    };
    frame.addEventListener('load', poll);
    document.body.appendChild(frame);
  });
  return bandBundlePromise;
}

let bandPdfLibPromise = null;
function bandLoadPdfLib() { // copy of manus.js's manusLoadPdfLib
  if (window.PDFLib) return Promise.resolve(window.PDFLib);
  if (!bandPdfLibPromise) {
    bandPdfLibPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'js/vendor/pdf-lib.min.js';
      script.onload = () => (window.PDFLib ? resolve(window.PDFLib) : reject(new Error('pdf-lib')));
      script.onerror = () => { bandPdfLibPromise = null; reject(new Error('pdf-lib')); };
      document.head.appendChild(script);
    });
  }
  return bandPdfLibPromise;
}

// The front page: "Band Mappe" at the top, then the revy's Arkiv cover
// photo (placeholder if it has none or it can't be loaded) laid out like
// Program.pdf's front cover: 2 cm side margins, full text width, centred in
// the space under the title. The title is pdf-lib's built-in Times (no
// Computer Modern without embedding a font).
const BAND_COVER_TITLE = 'Band Mappe';
async function bandAddCoverPage(PDFLib, out) {
  const page = out.addPage([595.28, 841.89]);
  const cm = 72 / 2.54;
  const font = await out.embedFont(PDFLib.StandardFonts.TimesRoman);
  const size = 40;
  const titleY = page.getHeight() - 4 * cm;
  page.drawText(BAND_COVER_TITLE, {
    x: (page.getWidth() - font.widthOfTextAtSize(BAND_COVER_TITLE, size)) / 2,
    y: titleY,
    size,
    font,
  });
  const entry = bandArchiveYears().find((y) => y.folder === bandFolder);
  const paths = [entry && entry.coverImage, BAND_PLACEHOLDER_COVER].filter(Boolean);
  for (const path of paths) {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) continue;
      const bytes = new Uint8Array(await res.arrayBuffer());
      const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
      const image = isPng ? await out.embedPng(bytes) : await out.embedJpg(bytes);
      const top = titleY - 1.5 * cm; // the image area: under the title, above a 2 cm bottom margin
      const bottom = 2 * cm;
      const scale = Math.min((page.getWidth() - 4 * cm) / image.width, (top - bottom) / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      page.drawImage(image, { x: (page.getWidth() - w) / 2, y: bottom + (top - bottom - h) / 2, width: w, height: h });
      return;
    } catch (e) { /* try the next */ }
  }
  // No image at all: the title alone.
}

// Copy of manus.js's manusOpenPdfProgress (band-prefixed classes, band.css).
function bandOpenPdfProgress(onCancel) {
  const overlay = el('div', 'band-progress-overlay');
  const box = el('div', 'band-progress');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  const label = el('p', 'band-progress-label');
  box.appendChild(label);
  const bar = el('div', 'band-progress-bar');
  const fill = el('div', 'band-progress-fill');
  bar.appendChild(fill);
  box.appendChild(bar);
  const detail = el('p', 'band-progress-detail');
  box.appendChild(detail);
  const actions = el('div', 'login-actions');
  const cancelBtn = bandPillBtn('Annuller', 'site-btn-warm');
  cancelBtn.addEventListener('click', onCancel);
  actions.appendChild(cancelBtn);
  box.appendChild(actions);
  overlay.appendChild(box);
  document.body.appendChild(overlay);
  return {
    set(text, done, total, unit) {
      label.textContent = text;
      fill.style.width = total ? `${Math.min(100, (done / total) * 100)}%` : '100%';
      detail.textContent = total ? `${done} af ${total} ${unit}` : '';
    },
    ready(pageCount, onOpen, onClose) {
      label.textContent = 'PDF’en er klar';
      fill.style.width = '100%';
      detail.textContent = pageCount ? `${pageCount} sider` : '';
      actions.textContent = '';
      const closeBtn = bandPillBtn('Luk', 'site-btn-warm');
      closeBtn.addEventListener('click', onClose);
      const openBtn = bandPillBtn('Åbn PDF', 'site-btn-success');
      openBtn.addEventListener('click', onOpen);
      actions.appendChild(closeBtn);
      actions.appendChild(openBtn);
      openBtn.focus();
    },
    close() { overlay.remove(); },
  };
}

// Copy of manus.js's manusOpenPdfBlob: a new tab (iOS: this tab); if the
// browser blocks it, the progress box offers "Åbn PDF" (a fresh click).
function bandOpenPdfBlob(bytes, pageCount, progress, finish) {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
  if (siteIsIos()) { window.location.href = url; return; }
  const win = window.open(url, '_blank');
  if (win) {
    finish();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
    return;
  }
  progress.ready(pageCount, () => {
    window.open(url, '_blank');
    finish();
    setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
  }, () => {
    finish();
    URL.revokeObjectURL(url);
  });
}

async function bandPrintLeadsheets(btn) {
  const lanes = bandPrintLanes();
  const rows = BAND_PRINT_ACTS.flatMap((act) => lanes[act.code]);
  // Which act each sheet belongs to, for the blank pages before Akt 2/3.
  const actOf = BAND_PRINT_ACTS.flatMap((act) => lanes[act.code].map(() => act.code));
  if (!rows.length) {
    siteShowToast('Placer mindst én sang i en akt først.');
    return;
  }
  let cancelled = false;
  const progress = bandOpenPdfProgress(() => { cancelled = true; finish(); });
  btn.disabled = true;
  function finish() { progress.close(); btn.disabled = false; }
  const nextFrame = () => new Promise((resolve) => setTimeout(resolve, 0));
  try {
    // The sheets themselves, in print order, each moved by its Revytoneart.
    // One count for the whole job: fetching the sheets takes moments, so it
    // shows "0 af N sider" and only the drawing counts up.
    progress.set('Henter leadsheets…', 0, rows.length, 'sider');
    const builderPromise = bandLoadBundleBuilder();
    // All at once (each is a round trip to the server), in print order.
    const results = await Promise.all(rows.map((row) => bandApi('band_leadsheet_read', { rowId: row.id })));
    if (cancelled) return;
    const pages = [];
    for (const [i, row] of rows.entries()) {
      const result = results[i];
      if (!result.ok) throw new Error(result.message || `Kunne ikke hente leadsheetet til "${bandSongLabel(row)}".`);
      const sheet = result.data.sheet || bandDefaultSheet(row);
      const key = bandReadKey(sheet.key);
      const shift = bandTransposeSemitones(result.data.row && result.data.row.revytoneart);
      const semitones = key && shift ? shift : 0;
      const flats = key ? bandKeyPrefersFlats((key.pc + semitones + 1200) % 12, key.minor) : false;
      pages.push({ sheet, semitones, flats });
    }

    const build = await builderPromise;
    if (cancelled) return;
    progress.set('Tegner leadsheets…', 0, pages.length, 'sider');
    const bundle = await build({ pages, sets: [], filename: 'Leadsheets.pdf' }, (i, n) => {
      if (!cancelled) progress.set('Tegner leadsheets…', i - 1, n, 'sider');
    });
    if (cancelled) return;

    progress.set('Samler PDF…', pages.length, pages.length, 'sider');
    await nextFrame();
    const PDFLib = await bandLoadPdfLib();
    // The bundle comes from the iframe's realm, whose ArrayBuffer fails
    // pdf-lib's instanceof checks: wrap it in this page's own Uint8Array.
    const src = await PDFLib.PDFDocument.load(new Uint8Array(await bundle.arrayBuffer()));
    const out = await PDFLib.PDFDocument.create();
    out.setTitle('Leadsheets');
    await bandAddCoverPage(PDFLib, out);
    // One page per sheet (the bundle draws each on a single page). Akt 2 and
    // Akt 3 start on an even page number (the cover is page 1): a blank page
    // goes in first when the act's first song would land on an odd one.
    const copied = await out.copyPages(src, src.getPageIndices());
    copied.forEach((page, i) => {
      const startsAct = i > 0 && actOf[i] !== actOf[i - 1];
      if (startsAct && BAND_PRINT_EVEN_START.includes(actOf[i]) && (out.getPageCount() + 1) % 2 === 1) {
        out.addPage([595.28, 841.89]);
      }
      out.addPage(page);
    });
    const bytes = await out.save();
    if (cancelled) return;
    bandOpenPdfBlob(bytes, out.getPageCount(), progress, finish);
  } catch (e) {
    if (cancelled) return;
    finish();
    const message = e && e.message;
    siteShowToast(message === 'pdf-lib' ? 'Kunne ikke indlæse PDF-værktøjet.'
      : message === 'bundle' ? 'Kunne ikke starte leadsheet-editoren. Prøv igen.'
        : message || 'Kunne ikke lave PDF’en.');
  }
}

const BAND_ARCHIVE_FOLDER = '_arkiv'; // mirrors band_archive_folder() in update-data.php

function bandArchiveKey(title) {
  return title.trim().replace(/\s+/g, ' ').toLocaleLowerCase('da');
}

// Each server entry becomes a row-shaped object (so bandBuildFileRow/
// bandOpenUploadModal work on it unchanged) tagged with its source folder
// and card key; equal titles merge into one card.
function bandBuildArchiveCards(songs) {
  const cards = new Map();
  for (const song of songs) {
    const key = bandArchiveKey(song.title);
    if (!key) continue;
    let card = cards.get(key);
    if (!card) {
      card = { key, title: song.title.trim(), sources: [] };
      cards.set(key, card);
    }
    card.sources.push(bandArchiveSourceRow(card, song.folder, song.rowId, song.files));
  }
  return cards;
}

function bandArchiveSourceRow(card, folder, rowId, files) {
  return { id: rowId, type: 'song', originaltitel: card.title, files: files || [], _folder: folder, _arkivKey: card.key };
}

function bandArchiveFolderLabel(folder) {
  if (folder === BAND_ARCHIVE_FOLDER) return 'Arkiv';
  const opt = bandRevyOptions().find((o) => o.value === folder);
  return opt ? opt.label : folder.replace(/_/g, ' ');
}

// Arkiv store first (that's where uploads land), then revys newest first.
function bandArchiveSourceRank(folder) {
  if (folder === BAND_ARCHIVE_FOLDER) return -1;
  const idx = bandRevyOptions().findIndex((o) => o.value === folder);
  return idx === -1 ? 9999 : idx;
}

// Search box text; kept across re-renders (upload, new song, tab switch).
let bandArkivQuery = '';

function bandArkivMatches(card) {
  const q = bandArchiveKey(bandArkivQuery);
  return !q || card.key.includes(q);
}

// Filters the cards in place (hidden, not rebuilt), so typing never loses
// focus.
function bandApplyArkivFilter() {
  let shown = 0;
  for (const node of document.querySelectorAll('.band-arkiv-grid .band-folder')) {
    const card = bandArchiveCards.get(node.dataset.key);
    node.hidden = !card || !bandArkivMatches(card);
    if (!node.hidden) shown++;
  }
  const empty = document.querySelector('.band-arkiv-empty');
  if (empty) empty.hidden = shown > 0 || !bandArchiveCards.size;
}

function bandRenderArkiv(root) {
  const card = el('section', 'card');
  const head = el('div', 'card-head band-card-head band-arkiv-head');
  head.appendChild(el('h2', null, 'Arkiv'));
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'band-arkiv-search';
  search.placeholder = 'Søg efter sang…';
  search.setAttribute('aria-label', 'Søg i arkivet');
  search.value = bandArkivQuery;
  search.addEventListener('input', () => {
    bandArkivQuery = search.value;
    bandApplyArkivFilter();
  });
  head.appendChild(search);
  if (bandCanEdit(BAND_ARCHIVE_FOLDER)) {
    const newSongBtn = bandBtn('+ Ny sang');
    newSongBtn.addEventListener('click', bandOpenNewArchiveSongModal);
    head.appendChild(newSongBtn);
  } else {
    head.appendChild(el('span')); // keeps the search box centered
  }
  card.appendChild(head);
  card.appendChild(el('p', 'site-muted band-noder-hint', bandCanEdit(BAND_ARCHIVE_FOLDER)
    ? 'Alle sange fra alle revyer, efter originaltitel. Filer uploadet her gemmes kun i arkivet.'
    : 'Alle sange fra alle revyer, efter originaltitel. Kun bosser kan redigere arkivet.'));

  const cards = Array.from(bandArchiveCards.values())
    .sort((a, b) => a.title.localeCompare(b.title, 'da', { sensitivity: 'base', numeric: true }));
  if (!cards.length) {
    card.appendChild(el('p', 'site-muted', 'Ingen sange endnu.'));
  } else {
    const grid = el('div', 'band-folder-grid band-arkiv-grid');
    for (const c of cards) grid.appendChild(bandBuildArkivCard(c));
    card.appendChild(grid);
    const empty = el('p', 'site-muted band-arkiv-empty', 'Ingen sange matcher søgningen.');
    empty.hidden = cards.some(bandArkivMatches);
    card.appendChild(empty);
  }
  root.appendChild(card);
}

function bandRerenderArkivCard(key) {
  const card = bandArchiveCards && bandArchiveCards.get(key);
  const node = document.querySelector(`.band-arkiv-grid .band-folder[data-key="${CSS.escape(key)}"]`);
  if (card && node) node.replaceWith(bandBuildArkivCard(card));
}

// The card's archive-store row, or an unsaved placeholder that creates it
// on first upload (so cancelling the upload modal leaves nothing behind).
function bandArchiveUploadRow(card) {
  const existing = card.sources.find((r) => r._folder === BAND_ARCHIVE_FOLDER);
  if (existing) return existing;
  const row = bandArchiveSourceRow(card, BAND_ARCHIVE_FOLDER, null, []);
  row._ensureCreated = async () => {
    const result = await bandApi('band_upsert_row', {
      folder: BAND_ARCHIVE_FOLDER,
      row: { type: 'song', originaltitel: card.title },
    });
    if (!result.ok) { bandShowError(result.message); return false; }
    row.id = result.data.row.id;
    delete row._ensureCreated;
    card.sources.push(row);
    return true;
  };
  return row;
}

function bandBuildArkivCard(card) {
  const node = el('div', 'band-folder');
  node.dataset.key = card.key;
  node.hidden = !bandArkivMatches(card);
  const isOpen = bandArkivOpen.has(card.key);
  if (isOpen) node.classList.add('open');

  const headBtn = el('button', 'site-collapse band-folder-head');
  headBtn.type = 'button';
  headBtn.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  headBtn.appendChild(el('span', 'site-chevron', '▾'));
  const titles = el('span', 'band-folder-titles');
  titles.appendChild(el('span', 'band-folder-name', card.title));
  headBtn.appendChild(titles);
  const count = card.sources.reduce((n, r) => n + (r.files || []).length, 0);
  headBtn.appendChild(el('span', 'band-folder-count', count === 1 ? '1 fil' : `${count} filer`));
  headBtn.addEventListener('click', () => {
    if (bandArkivOpen.has(card.key)) bandArkivOpen.delete(card.key);
    else bandArkivOpen.add(card.key);
    bandRerenderArkivCard(card.key);
  });
  node.appendChild(headBtn);
  const editable = bandCanEdit(BAND_ARCHIVE_FOLDER);

  if (editable) node.addEventListener('dragover', (e) => {
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types || []).includes('Files')) return;
    e.preventDefault();
    node.classList.add('band-folder-dragover');
  });
  node.addEventListener('dragleave', (e) => {
    if (!node.contains(e.relatedTarget)) node.classList.remove('band-folder-dragover');
  });
  node.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    node.classList.remove('band-folder-dragover');
    bandArkivOpen.add(card.key);
    bandOpenUploadModal(bandArchiveUploadRow(card), Array.from(e.dataTransfer.files));
  });

  if (!isOpen) return node;

  // Every source is listed, even without files, so the card shows which
  // revys the song was part of.
  const body = el('div', 'band-folder-body');
  const sources = card.sources.slice()
    .sort((a, b) => bandArchiveSourceRank(a._folder) - bandArchiveSourceRank(b._folder));
  for (const row of sources) {
    const isArchive = row._folder === BAND_ARCHIVE_FOLDER;
    const groupHead = el('div', 'band-arkiv-source');
    groupHead.appendChild(el('span', 'band-arkiv-source-name', bandArchiveFolderLabel(row._folder)));
    if (isArchive && editable) {
      const removeBtn = bandRemoveBtn('Slet sangen fra arkivet');
      removeBtn.addEventListener('click', () => bandDeleteArchiveSong(card, row));
      groupHead.appendChild(removeBtn);
    }
    body.appendChild(groupHead);
    if (!(row.files || []).length) body.appendChild(el('p', 'site-muted band-arkiv-source-empty', 'Ingen filer.'));
    for (const file of bandSortedFiles(row.files || [])) body.appendChild(bandBuildFileRow(row, file));
  }
  if (!editable) {
    node.appendChild(body);
    return node;
  }

  const uploadBar = el('div', 'band-upload-bar');
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = BAND_ALLOWED_EXTS.map((x) => '.' + x).join(',');
  input.hidden = true;
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    input.value = '';
    if (picked.length) bandOpenUploadModal(bandArchiveUploadRow(card), picked);
  });
  const uploadBtn = bandBtn('Upload filer');
  uploadBtn.addEventListener('click', () => input.click());
  uploadBar.appendChild(uploadBtn);
  uploadBar.appendChild(input);
  const busy = card.sources.find((r) => r._uploadStatus);
  if (busy) uploadBar.appendChild(el('span', 'site-muted', busy._uploadStatus));
  body.appendChild(uploadBar);

  node.appendChild(body);
  return node;
}

// Only the archive-store part of a card can be deleted here; a revy's own
// song is removed from that revy's Oversigt.
function bandDeleteArchiveSong(card, row) {
  const fileCount = (row.files || []).length;
  const description = fileCount
    ? `Arkivets ${fileCount} fil${fileCount === 1 ? '' : 'er'} til sangen slettes. Revyernes egne filer bliver liggende.`
    : 'Revyernes egne filer bliver liggende.';
  bandConfirm(`Slet "${card.title}" fra arkivet?`, description, 'Slet', async () => {
    const result = await bandApi('band_delete_row', { folder: BAND_ARCHIVE_FOLDER, rowId: row.id });
    if (!result.ok) { bandShowError(result.message); return false; }
    card.sources = card.sources.filter((r) => r !== row);
    if (!card.sources.length) {
      bandArchiveCards.delete(card.key);
      bandArkivOpen.delete(card.key);
    }
    bandRender(document.getElementById('band-root'));
    return true;
  });
}

// "+ Ny sang": a song that lives only in the archive store. A title that
// already has a card just opens that card (the archive row is created on
// its first upload).
function bandOpenNewArchiveSongModal() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Ny sang i arkivet');
  modal.classList.add('band-folder-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 200;
  input.placeholder = 'Originaltitel';
  form.appendChild(siteEditField('Sangens originaltitel', input));

  const createBtn = bandPillBtn('Opret', 'site-btn-success');
  async function submit() {
    const title = input.value.trim().replace(/\s+/g, ' ');
    if (!title) { error.textContent = 'Skriv en titel.'; return; }
    const key = bandArchiveKey(title);
    const existing = bandArchiveCards.get(key);
    if (existing) {
      bandArkivOpen.add(key);
      close();
      bandRender(document.getElementById('band-root'));
      siteShowToast(`"${existing.title}" findes allerede i arkivet.`);
      return;
    }
    createBtn.disabled = true;
    error.textContent = '';
    const result = await bandApi('band_upsert_row', {
      folder: BAND_ARCHIVE_FOLDER,
      row: { type: 'song', originaltitel: title },
    });
    if (!result.ok) {
      createBtn.disabled = false;
      error.textContent = result.message || '';
      return;
    }
    const card = { key, title, sources: [] };
    card.sources.push(bandArchiveSourceRow(card, BAND_ARCHIVE_FOLDER, result.data.row.id, []));
    bandArchiveCards.set(key, card);
    bandArkivOpen.add(key);
    close();
    bandRender(document.getElementById('band-root'));
  }
  createBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  actions.appendChild(createBtn);
  input.focus();
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('band-root');
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'site-muted', 'Bandet kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  window.addEventListener('beforeunload', (e) => {
    if (bandPending > 0) { e.preventDefault(); e.returnValue = ''; }
  });
  if (typeof siteRegisterUnsavedCheck === 'function') siteRegisterUnsavedCheck(() => bandPending > 0);
  bandInit(root);
});

async function bandInit(root) {
  root.replaceChildren(el('p', 'site-muted', 'Indlæser…'));
  await bandLoadInstances(); // failure just means no extra instances in the picker
  bandFolder = bandInitialFolder(bandRevyOptions());
  bandRenderPicker(root);
  if (!bandFolder) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'site-muted', 'Der er ingen revyer endnu. Opret en med "+ Opret ny" i menuen.'));
    root.replaceChildren(card);
    return;
  }
  bandLoad(root);
}
