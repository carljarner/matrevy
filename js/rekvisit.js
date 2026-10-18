/* =========================================================
   Matematikrevyen – Rekvisitten (rekvisitten.html)

   The prop crew's five sheets for one revy, as tabs: Rekvisitter (what
   each scene needs), Hvem, hvornår? (who is away which day), Indkøbsliste,
   Brændimprenering and Regnskab. Styled like Kostumetinder/Bandet's sheet:
   cells commit on blur, rows reorder by their handle, columns can be
   renamed, resized, removed and added, pills cycle on click.

   Brændimprenering has no rows of its own: it lists Rekvisitter's rows
   and edits their braend/braendNote fields, so the two can't drift.
   Hvem, hvornår?'s day columns are Kalender's øvedage/forestillinger in
   July–December of the revy's year plus days added here; a cell is free
   text, and "x" means "not here".

   One document per revy (rekvisit_* actions, private REKVISIT_DATA_DIR).
   A revy picker shows every Arkiv year; below boss only the current
   production is editable (mirrors the server's dispatch check), older
   years are read-only.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helpers (mirror kostume.js's own) ──────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Second-level button, for buttons inside a modal overlay only.
function rekvisitPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

function rekvisitAddPlusBtn(title) {
  const btn = el('button', 'boss-manage-add-plus', '+');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

function rekvisitRemoveBtn(title) {
  const btn = el('button', 'rekvisit-remove-btn', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

// ── Authenticated API (mirrors kostume.js's kostumeApi) ──────
function rekvisitResolvePassword() {
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

function rekvisitMapError(status, detail) {
  if (detail === 'read_only') return 'Tidligere år kan kun redigeres af bosser.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. En anden har måske lige slettet den. Genindlæs siden.';
  if (status === 409) return 'Nogen andre har lige ændret arket. Genindlæser…';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

let rekvisitPending = 0; // writes in flight (beforeunload / stale banner)

// Returns { ok: true, data } or { ok: false, status, detail, message } —
// message '' = cancelled password prompt (silent no-op). Every call is
// about the selected revy (`folder`).
async function rekvisitApi(action, body, folder = rekvisitFolder) {
  const password = rekvisitResolvePassword();
  if (!password) return { ok: false, status: 0, detail: '', message: '' };
  const isWrite = action !== 'rekvisit_read';
  if (isWrite) rekvisitPending++;
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, folder, ...(body || {}) }),
    });
  } catch (e) {
    if (isWrite) rekvisitPending--;
    return { ok: false, status: 0, detail: '', message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  if (isWrite) rekvisitPending--;
  // Require a real {ok:true} JSON body — a PHP fatal or WAF page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, detail, message: rekvisitMapError(res.status, detail) };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, detail, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── Sheet definitions ────────────────────────────────────────
const REKVISIT_TABS = [
  { key: 'rekvisitter', label: 'Rekvisitter' },
  { key: 'hvem', label: 'Hvem, hvornår?' },
  { key: 'indkob', label: 'Indkøbsliste' },
  { key: 'braend', label: 'Brændimprenering' },
  { key: 'regnskab', label: 'Regnskab' },
];
const REKVISIT_TAB_KEY = 'matrevy-rekvisit-tab';
const REKVISIT_REVY_KEY = 'matrevy-rekvisit-revy';

// Pill cycles per `<rowSheet>/<key>`; '' is each one's default. Mirrors
// rekvisit_status_values() in update-data.php.
const REKVISIT_STATUSES = {
  'rekvisitter/status': [
    { value: '', label: '-', cls: 'rekvisit-pill-none' },
    { value: 'igang', label: 'I gang', cls: 'rekvisit-pill-warm' },
    { value: 'faerdig', label: 'Færdig', cls: 'rekvisit-pill-done' },
    { value: 'droppet', label: 'Droppet', cls: 'rekvisit-pill-dropped' },
  ],
  'rekvisitter/braend': [
    { value: '', label: '-', cls: 'rekvisit-pill-none' },
    { value: 'ja', label: 'Ja', cls: 'rekvisit-pill-done' },
    { value: 'skalikke', label: 'Skal ikke', cls: 'rekvisit-pill-muted' },
  ],
  'indkob/kobt': [
    { value: '', label: '-', cls: 'rekvisit-pill-none' },
    { value: 'ja', label: 'Ja', cls: 'rekvisit-pill-done' },
  ],
  'regnskab/behandlet': [
    { value: '', label: 'Nej', cls: 'rekvisit-pill-none' },
    { value: 'maaske', label: 'Ja?', cls: 'rekvisit-pill-warm' },
    { value: 'ja', label: 'Ja', cls: 'rekvisit-pill-done' },
  ],
};

// Per tab: rowSheet = whose rows it shows (Brændimprenering borrows
// Rekvisitter's); columns = built-ins (width = default px; status = pill;
// readOnly = shown, not edited; derived = computed; stayRight = custom
// columns are inserted before it); locked = can't be removed; custom =
// text columns can be added; rows = rows can be added/removed/moved.
// Mirrors rekvisit_sheet_defs() in update-data.php.
const REKVISIT_SHEETS = {
  rekvisitter: {
    rowSheet: 'rekvisitter', locked: 'rekvisit', custom: true, rows: true,
    note: 'Rekvisit, Sketch/Sang, Instruktør og Kommentar udfyldes af instruktørerne, resten af rekvisitten.',
    hintRequired: ['rekvisit', 'scene', 'instruktoer'],
    // A header row above the titles shows who fills in what; custom
    // columns belong to the last group.
    groups: [
      { key: 'instr', label: 'Instruktør' },
      { key: 'rekv', label: 'Rekvisit' },
    ],
    // braend lives on the Brændimprenering tab, not here.
    columns: [
      { key: 'rekvisit', label: 'Rekvisit', width: 160, hint: 'Det, der skal laves', group: 'instr' },
      { key: 'scene', label: 'Sketch/Sang', width: 160, hint: 'Til hvilken scene', group: 'instr' },
      { key: 'instruktoer', label: 'Instruktør', width: 110, hint: 'Dit navn', group: 'instr' },
      { key: 'kommentar', label: 'Kommentar', width: 280, hint: 'Hvordan skal den se ud?', group: 'instr' },
      { key: 'type', label: 'Type (pap/stof/hønsenet/træ)', width: 180, group: 'rekv' },
      { key: 'status', label: 'Status', width: 100, status: true, group: 'rekv' },
      { key: 'ansvarlig', label: 'Ansvarlig', width: 110, group: 'rekv' },
      { key: 'ekstra', label: 'Ekstra', width: 200, group: 'rekv' },
    ],
  },
  hvem: {
    rowSheet: 'hvem', locked: 'navn', custom: false, rows: true, days: true,
    note: 'Skriv x, hvis og kun hvis du ikke er her, ellers tidsinterval du er her fx "10-16".',
    hintRequired: ['navn'],
    columns: [
      { key: 'navn', label: 'Navn', width: 200, hint: 'Dit navn' },
    ],
  },
  indkob: {
    rowSheet: 'indkob', locked: 'hvad', custom: true, rows: true,
    columns: [
      { key: 'hvad', label: 'Hvad?', width: 220 },
      { key: 'hvor', label: 'Hvor', width: 150 },
      { key: 'forventetPris', label: 'Forventet pris', width: 120, amount: true },
      { key: 'faktiskPris', label: 'Faktisk pris', width: 120, amount: true },
      { key: 'kobt', label: 'Købt?', width: 90, status: true },
    ],
  },
  braend: {
    rowSheet: 'rekvisitter', locked: null, custom: false, rows: false,
    note: 'Rækkerne kommer fra fanen Rekvisitter.',
    columns: [
      { key: 'rekvisit', label: 'Rekvisit', width: 180, readOnly: true },
      { key: 'kommentar', label: 'Kommentar', width: 320, readOnly: true },
      { key: 'braend', label: 'Brændimprægneret', width: 130, status: true },
      { key: 'braendNote', label: 'Note', width: 220 },
    ],
  },
  regnskab: {
    rowSheet: 'regnskab', locked: 'udgift', custom: true, rows: true, budget: true,
    columns: [
      { key: 'udgift', label: 'Udgift', width: 200 },
      { key: 'belob', label: 'Beløb', width: 110, amount: true },
      { key: 'bilag', label: 'Bilag', width: 100 },
      { key: 'lagtUd', label: 'Lagt ud', width: 150 },
      { key: 'behandlet', label: 'Behandlet', width: 100, status: true },
      { key: 'rest', label: 'Restbeløb', width: 120, derived: true, amount: true, stayRight: true },
    ],
  },
};

const REKVISIT_HANDLE_COL_WIDTH = 26;
const REKVISIT_ACTIONS_COL_WIDTH = 40;
const REKVISIT_DAY_COL_WIDTH = 76;
const REKVISIT_MIN_COL_WIDTH = 48;
const REKVISIT_CUSTOM_COL_WIDTH = 140;
const REKVISIT_CUSTOM_KEY_RE = /^c[0-9a-f]{8,40}$/; // mirrors rekvisit_custom_key_valid()

let rekvisitActiveTab = (() => {
  let stored = '';
  try { stored = localStorage.getItem(REKVISIT_TAB_KEY) || ''; } catch (e) { /* ignore */ }
  return REKVISIT_TABS.some((t) => t.key === stored) ? stored : 'rekvisitter';
})();
let rekvisitFolder = '';
let rekvisitSheets = null; // the read's `sheets` (every tab, back-filled)
let rekvisitLoadSeq = 0;
let rekvisitDragRow = null;

function rekvisitDef(tab = rekvisitActiveTab) {
  return REKVISIT_SHEETS[tab];
}

// The tab's own stored doc (titles/widths/custom columns) …
function rekvisitTabDoc(tab = rekvisitActiveTab) {
  return rekvisitSheets[tab];
}

// … and the doc whose rows it shows.
function rekvisitRowDoc(tab = rekvisitActiveTab) {
  return rekvisitSheets[rekvisitDef(tab).rowSheet];
}

// An empty PHP map can arrive as [] — always keep a plain object.
function rekvisitPlainMap(value) {
  return (value && typeof value === 'object' && !Array.isArray(value)) ? value : {};
}

// ── Revy picker + edit rights ────────────────────────────────
function rekvisitCurrentProductionFolder() {
  return (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
}

function rekvisitArchiveYears() {
  const override = (typeof siteLoadOverride === 'function') ? siteLoadOverride('archive') : null;
  return (override || (typeof ARCHIVE_DATA !== 'undefined' ? ARCHIVE_DATA : [])).filter((y) => y && y.folder);
}

// Newest year first; the current production is always offered, even
// before Koordinator has added its Arkiv entry. (Bandet's picker, minus
// its extra instances.)
function rekvisitRevyOptions() {
  const options = rekvisitArchiveYears().map((y) => ({ value: y.folder, label: y.name || y.folder, year: y.year || 0 }));
  const current = rekvisitCurrentProductionFolder();
  if (current && !options.some((o) => o.value === current)) {
    const m = /\d{4}/.exec(current);
    options.push({ value: current, label: current.replace(/_/g, ' '), year: m ? Number(m[0]) : 9999 });
  }
  return options.sort((a, b) => (b.year - a.year) || a.label.localeCompare(b.label, 'da'));
}

function rekvisitInitialFolder(options) {
  let stored = '';
  try { stored = localStorage.getItem(REKVISIT_REVY_KEY) || ''; } catch (e) { /* ignore */ }
  if (stored && options.some((o) => o.value === stored)) return stored;
  const current = rekvisitCurrentProductionFolder();
  if (current) return current;
  return options.length ? options[0].value : '';
}

// Boss/admin edit any year; revysts only the current production. Mirrors
// the read_only check in update-data.php's dispatch.
function rekvisitCanEdit() {
  if (typeof siteHasLevel === 'function' && siteHasLevel('boss')) return true;
  return rekvisitFolder !== '' && rekvisitFolder === rekvisitCurrentProductionFolder();
}

function rekvisitRenderPicker() {
  const mount = document.getElementById('rekvisit-revy-picker');
  if (!mount) return;
  const options = rekvisitRevyOptions();
  if (!options.length) { mount.replaceChildren(); return; }
  const picker = siteCreateDropdownField(options.map(({ value, label }) => ({ value, label })), rekvisitFolder);
  picker.classList.add('rekvisit-revy-select');
  picker.setAttribute('aria-label', 'Vælg revy');
  picker.addEventListener('change', () => {
    if (picker.value === rekvisitFolder) return;
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    rekvisitFolder = picker.value;
    try { localStorage.setItem(REKVISIT_REVY_KEY, rekvisitFolder); } catch (e) { /* ignore */ }
    rekvisitSheets = null;
    rekvisitLoad();
  });
  mount.replaceChildren(picker);
}

// ── Load + render ────────────────────────────────────────────
function rekvisitRoot() {
  return document.getElementById('rekvisit-root');
}

// "Tidligere år kan kun redigeres af bosser" — only on an older year.
function rekvisitUpdateEditNote() {
  const note = document.getElementById('rekvisit-edit-note');
  if (note) note.hidden = rekvisitFolder === rekvisitCurrentProductionFolder();
}

async function rekvisitLoad() {
  const root = rekvisitRoot();
  rekvisitUpdateEditNote();
  if (!rekvisitFolder) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'rekvisit-muted', 'Der er ingen revyer endnu.'));
    root.replaceChildren(card);
    return;
  }
  const seq = ++rekvisitLoadSeq;
  if (!rekvisitSheets) root.replaceChildren(el('p', 'rekvisit-muted', 'Indlæser…'));
  const result = await rekvisitApi('rekvisit_read', {});
  // A slower read for a revy you've since switched away from is dropped.
  if (seq !== rekvisitLoadSeq) return;
  if (!result.ok) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'rekvisit-error', result.message || 'Kunne ikke indlæse arkene.'));
    root.replaceChildren(card);
    return;
  }
  const sheets = result.data.sheets || {};
  rekvisitSheets = {};
  for (const tab of Object.keys(REKVISIT_SHEETS)) {
    const s = sheets[tab] || {};
    rekvisitSheets[tab] = {
      ...s,
      rows: (s.rows || []).map((row) => (tab === 'hvem' ? { ...row, days: rekvisitPlainMap(row.days) } : row)),
      columnLabels: rekvisitPlainMap(s.columnLabels),
      columnWidths: rekvisitPlainMap(s.columnWidths),
      customColumns: s.customColumns || [],
      hiddenColumns: s.hiddenColumns || [],
      extraDays: s.extraDays || [],
      hiddenDays: s.hiddenDays || [],
      budget: typeof s.budget === 'string' ? s.budget : '',
    };
  }
  rekvisitRender();
}

function rekvisitRender() {
  const root = rekvisitRoot();
  root.replaceChildren();
  if (!rekvisitSheets) return;
  rekvisitRenderTabs(root);
  const def = rekvisitDef();
  const canEdit = rekvisitCanEdit();
  const card = el('section', 'card rekvisit-sheet-card');

  const head = el('div', 'rekvisit-card-head');
  if (def.budget) head.appendChild(rekvisitBuildBudgetField(canEdit));
  const notes = [];
  if (def.note) notes.push(def.note);
  if (!canEdit) notes.push('Tidligere år kan kun redigeres af bosser.');
  for (const text of notes) head.appendChild(el('p', 'rekvisit-muted rekvisit-note', text));
  if (head.childNodes.length) card.appendChild(head);

  const wrap = el('div', 'rekvisit-table-wrap');
  wrap.appendChild(rekvisitBuildSheetTable(canEdit));
  card.appendChild(wrap);
  if (def.rows && canEdit) {
    const addRow = rekvisitAddPlusBtn('Tilføj række');
    addRow.classList.add('rekvisit-add-row');
    addRow.addEventListener('click', () => rekvisitAddDraftRow(card));
    card.appendChild(addRow);
  }
  root.appendChild(card);
}

// Styled like Ninjas' page tabs (.ninjas-mode-tabs, duplicated as
// .rekvisit-mode-tabs in rekvisit.css).
function rekvisitRenderTabs(root) {
  const tabs = el('div', 'rekvisit-mode-tabs');
  for (const tab of REKVISIT_TABS) {
    const btn = el('button', 'rekvisit-mode-tab' + (tab.key === rekvisitActiveTab ? ' active' : ''), tab.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (tab.key === rekvisitActiveTab) return;
      // Commit whatever is being typed first (its blur fires before the
      // re-render).
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      siteCloseFieldPopup();
      rekvisitActiveTab = tab.key;
      try { localStorage.setItem(REKVISIT_TAB_KEY, rekvisitActiveTab); } catch (e) { /* ignore */ }
      rekvisitRender();
      // Re-read so each tab shows what others saved meanwhile.
      rekvisitLoad();
    });
    tabs.appendChild(btn);
  }
  root.appendChild(tabs);
}

function rekvisitShowError(message) {
  if (!message) return;
  siteShowToast(message);
}

// A 409/404 means the page is out of date — reload rather than keep
// editing a stale copy.
function rekvisitHandleFailure(result) {
  rekvisitShowError(result.message);
  if (result.status === 409 || result.status === 404) rekvisitLoad();
}

// ── Columns ──────────────────────────────────────────────────
// Visible built-ins plus the custom columns (before a stayRight column,
// else at the end), plus Hvem's day columns.
function rekvisitSheetColumns(tab = rekvisitActiveTab) {
  const def = rekvisitDef(tab);
  const doc = rekvisitTabDoc(tab);
  const hidden = new Set(doc.hiddenColumns);
  const cols = def.columns.filter((c) => !hidden.has(c.key));
  if (def.custom) {
    const group = def.groups ? def.groups[def.groups.length - 1].key : undefined;
    const custom = doc.customColumns.map((c) => ({ key: c.key, label: c.label, width: REKVISIT_CUSTOM_COL_WIDTH, custom: true, group }));
    const right = cols.findIndex((c) => c.stayRight);
    cols.splice(right === -1 ? cols.length : right, 0, ...custom);
  }
  if (def.days) cols.push(...rekvisitDayColumns());
  return cols;
}

// Every value key a row can carry (hidden ones included, so a draft keeps
// them and a row with only hidden content still counts).
function rekvisitAllValueKeys(tab = rekvisitActiveTab) {
  const def = rekvisitDef(tab);
  return [
    ...def.columns.filter((c) => !c.derived && !c.readOnly).map((c) => c.key),
    ...(def.custom ? rekvisitTabDoc(tab).customColumns.map((c) => c.key) : []),
  ];
}

function rekvisitRowHasContent(row) {
  if (rekvisitAllValueKeys().some((key) => String(row[key] || '').trim() !== '')) return true;
  return Object.values(row.days || {}).some((v) => String(v || '').trim() !== '');
}

function rekvisitRowLabel(row) {
  const def = rekvisitDef();
  return String(row[def.locked || def.columns[0].key] || '').trim() || 'Række';
}

function rekvisitStatusOptions(key) {
  return REKVISIT_STATUSES[`${rekvisitDef().rowSheet}/${key}`] || [{ value: '', label: '-', cls: 'rekvisit-pill-none' }];
}

// ── Hvem, hvornår?: day columns ──────────────────────────────
function rekvisitAddDays(iso, n) {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Copy of faellesCurrentHalfYearRange().
function rekvisitCurrentHalfYearRange() {
  const today = todayIso();
  const year = today.slice(0, 4);
  return Number(today.slice(5, 7)) <= 6
    ? { start: `${year}-01-01`, end: `${year}-06-30` }
    : { start: `${year}-07-01`, end: `${year}-12-31` };
}

// July–December of the revy's own year, so an old revy shows its own days.
function rekvisitDayRange() {
  const m = /\d{4}/.exec(rekvisitFolder);
  return m ? { start: `${m[0]}-07-01`, end: `${m[0]}-12-31` } : rekvisitCurrentHalfYearRange();
}

function rekvisitCalendarEvents() {
  const override = (typeof siteLoadOverride === 'function') ? siteLoadOverride('calendar') : null;
  if (override) return override;
  return (typeof CALENDAR_DATA !== 'undefined' && Array.isArray(CALENDAR_DATA)) ? CALENDAR_DATA : [];
}

// One column per date (same-date events merge, multi-day events expand —
// like koordLokalerDays()): Kalender's øvedage/forestillinger in range,
// minus hiddenDays, plus every extra day.
function rekvisitDayColumns() {
  const doc = rekvisitSheets.hvem;
  const range = rekvisitDayRange();
  const hidden = new Set(doc.hiddenDays);
  const byDate = new Map();
  const entry = (date) => {
    if (!byDate.has(date)) byDate.set(date, { titles: [], extraIds: [], fromCalendar: false });
    return byDate.get(date);
  };
  for (const ev of rekvisitCalendarEvents()) {
    if (!ev || (ev.category !== 'ove' && ev.category !== 'forestilling') || !ev.date) continue;
    const end = (ev.endDate && ev.endDate >= ev.date) ? ev.endDate : ev.date;
    let date = ev.date;
    for (let i = 0; i < 62 && date <= end; i++, date = rekvisitAddDays(date, 1)) {
      if (date < range.start || date > range.end || hidden.has(date)) continue;
      const e = entry(date);
      e.fromCalendar = true;
      const title = (ev.title || '').trim();
      if (title && !e.titles.includes(title)) e.titles.push(title);
    }
  }
  for (const day of doc.extraDays) {
    const e = entry(day.date);
    e.extraIds.push(day.id);
    if (day.title && !e.titles.includes(day.title)) e.titles.push(day.title);
  }
  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, e]) => {
      const d = parseIsoDate(date);
      return {
        key: `day:${date}`, day: date, label: `${d.getDate()}/${d.getMonth() + 1}`,
        width: REKVISIT_DAY_COL_WIDTH, ...e,
      };
    });
}

// "x" = not here at all ("1" too — the 2025 sheet used it); anything else
// = part of the day.
function rekvisitDayAbsent(text) {
  return /^\s*[1xX]\s*$/.test(text || '');
}

function rekvisitPaintDayCell(td, text) {
  td.classList.toggle('rekvisit-day-absent', rekvisitDayAbsent(text));
  td.classList.toggle('rekvisit-day-partial', !rekvisitDayAbsent(text) && String(text || '').trim() !== '');
}

function rekvisitOpenAddDayModal() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj dag');
  modal.classList.add('rekvisit-column-modal');
  const dateField = siteCreateDateField(todayIso());
  form.appendChild(siteEditField('Dato', dateField));
  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = 80;
  titleInput.placeholder = 'Fx Brunch';
  form.appendChild(siteEditField('Titel (valgfri)', titleInput));
  const addBtn = rekvisitPillBtn('Tilføj', 'site-btn-success');
  async function submit() {
    if (!dateField.value) { error.textContent = 'Vælg en dato.'; return; }
    addBtn.disabled = true;
    const result = await rekvisitApi('rekvisit_add_day', { date: dateField.value, title: titleInput.value.trim() });
    if (!result.ok) { addBtn.disabled = false; error.textContent = result.message; return; }
    rekvisitSheets.hvem.extraDays = result.data.extraDays || [];
    rekvisitSheets.hvem.hiddenDays = result.data.hiddenDays || [];
    close();
    rekvisitRender();
  }
  addBtn.addEventListener('click', submit);
  titleInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  actions.appendChild(addBtn);
}

// An extra day is deleted; a Kalender date is only hidden on this sheet.
function rekvisitRemoveDay(col) {
  const description = col.fromCalendar
    ? 'Dagen skjules kun her. Kalender ændres ikke. Det, der er skrevet i kolonnen, gemmes.'
    : 'Det, der er skrevet i kolonnen, gemmes, men vises ikke.';
  rekvisitConfirm(`Fjern dagen ${col.label}?`, description, 'Fjern', async () => {
    for (const dayId of col.extraIds) {
      const result = await rekvisitApi('rekvisit_delete_day', { dayId });
      if (!result.ok) { rekvisitShowError(result.message); return false; }
      rekvisitSheets.hvem.extraDays = result.data.extraDays || [];
    }
    if (col.fromCalendar) {
      const result = await rekvisitApi('rekvisit_hide_day', { date: col.day });
      if (!result.ok) { rekvisitShowError(result.message); return false; }
      rekvisitSheets.hvem.hiddenDays = result.data.hiddenDays || [];
    }
    rekvisitRender();
    return true;
  });
}

// ── Amounts (Indkøbsliste, Regnskab) ─────────────────────────
// Danish-style money as typed: "1.061,70", "130", "283,50 kr". null when
// there's no number.
function rekvisitParseAmount(text) {
  let s = String(text || '').replace(/kr\.?/gi, '').replace(/\s+/g, '');
  if (!s) return null;
  if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.');
  else if (/^-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function rekvisitFormatAmount(n) {
  return n.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function rekvisitSum(rows, key) {
  let sum = 0;
  let any = false;
  for (const row of rows) {
    const n = rekvisitParseAmount(row[key]);
    if (n !== null) { sum += n; any = true; }
  }
  return any ? rekvisitFormatAmount(sum) : '';
}

// Regnskab's Restbeløb: budget minus the running total of Beløb, in row
// order; blank on rows without an amount (or without a budget).
function rekvisitRestValues(rows) {
  const budget = rekvisitParseAmount(rekvisitSheets.regnskab.budget);
  const out = new Map();
  let rest = budget;
  for (const row of rows) {
    const n = rekvisitParseAmount(row.belob);
    if (budget === null || n === null) { out.set(row, ''); continue; }
    rest -= n;
    out.set(row, rekvisitFormatAmount(rest));
  }
  return { perRow: out, final: budget === null ? '' : rekvisitFormatAmount(rest) };
}

// The footer row's cells, by column key (null = no footer).
function rekvisitFooterValues(rows, columns) {
  const tab = rekvisitActiveTab;
  if (tab === 'hvem') {
    const named = rows.filter((r) => String(r.navn || '').trim() !== '');
    const out = { navn: 'Til stede' };
    for (const col of columns) {
      if (col.day) out[col.key] = String(named.filter((r) => !rekvisitDayAbsent(r.days[col.day])).length);
    }
    return out;
  }
  if (tab === 'indkob') {
    return { hvad: 'I alt', forventetPris: rekvisitSum(rows, 'forventetPris'), faktiskPris: rekvisitSum(rows, 'faktiskPris') };
  }
  if (tab === 'regnskab') {
    const firstKey = columns[0] ? columns[0].key : 'udgift';
    return { [firstKey]: 'I alt', belob: rekvisitSum(rows, 'belob'), rest: rekvisitRestValues(rows).final };
  }
  return null;
}

// The rows on screen right now (draft rows included), as typed.
function rekvisitScreenRows() {
  const tbody = document.querySelector('.rekvisit-table tbody');
  return tbody ? Array.from(tbody.querySelectorAll('tr.rekvisit-row')).map((tr) => tr._row) : [];
}

// Re-computes the derived cells and the footer as you type.
function rekvisitRefreshComputed() {
  const table = document.querySelector('.rekvisit-table');
  if (!table) return;
  const rows = rekvisitScreenRows();
  if (rekvisitActiveTab === 'regnskab') {
    const { perRow } = rekvisitRestValues(rows);
    for (const tr of table.querySelectorAll('tbody tr.rekvisit-row')) {
      const cell = tr.querySelector('.rekvisit-derived[data-key="rest"]');
      if (cell) cell.textContent = perRow.get(tr._row) || '';
    }
  }
  const values = rekvisitFooterValues(rows, rekvisitSheetColumns());
  if (!values) return;
  for (const td of table.querySelectorAll('tfoot td[data-key]')) td.textContent = values[td.dataset.key] || '';
}

// ── Regnskab's budget ────────────────────────────────────────
function rekvisitBuildBudgetField(canEdit) {
  const wrap = el('label', 'rekvisit-budget');
  wrap.appendChild(el('span', 'rekvisit-budget-label', 'Budget:'));
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.className = 'rekvisit-field rekvisit-budget-input';
  input.maxLength = 30;
  input.value = rekvisitSheets.regnskab.budget;
  input.placeholder = '0';
  input.readOnly = !canEdit;
  let saved = input.value;
  input.addEventListener('input', () => {
    rekvisitSheets.regnskab.budget = input.value;
    rekvisitRefreshComputed();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = saved; input.dispatchEvent(new Event('input')); input.blur(); }
  });
  input.addEventListener('blur', async () => {
    if (!canEdit || input.value.trim() === saved) return;
    const result = await rekvisitApi('rekvisit_set_budget', { budget: input.value });
    if (!result.ok) { rekvisitHandleFailure(result); return; }
    saved = result.data.budget;
    rekvisitSheets.regnskab.budget = saved;
  });
  wrap.appendChild(input);
  wrap.appendChild(el('span', 'rekvisit-budget-label', 'kr.'));
  return wrap;
}

// ── The sheet ────────────────────────────────────────────────
// Fixed table layout driven by a <colgroup>, so a dragged width is exact
// and the other columns don't shift to absorb it.
function rekvisitBuildSheetTable(canEdit) {
  const def = rekvisitDef();
  const table = el('table', 'rekvisit-table');
  const colgroup = el('colgroup');
  const cols = {};
  const addCol = (key, width) => {
    const c = el('col');
    c.style.width = `${width}px`;
    colgroup.appendChild(c);
    if (key) cols[key] = c;
  };
  const columns = rekvisitSheetColumns();
  const withHandle = def.rows && canEdit;
  const withActions = canEdit && (def.rows || def.custom || def.days);
  if (withHandle) addCol(null, REKVISIT_HANDLE_COL_WIDTH);
  for (const col of columns) addCol(col.key, rekvisitColumnWidth(col));
  if (withActions) addCol(null, REKVISIT_ACTIONS_COL_WIDTH);
  table.appendChild(colgroup);
  rekvisitUpdateSheetWidth(table, withHandle, withActions);

  const thead = el('thead');
  if (def.groups) thead.appendChild(rekvisitBuildGroupRow(columns, withHandle, withActions));
  const headRow = el('tr');
  if (withHandle) headRow.appendChild(rekvisitStickyCell(el('th', 'rekvisit-col-handle'), 0));
  for (const col of columns) {
    const th = el('th', rekvisitCellClass(col, 'rekvisit-col-resizable'));
    rekvisitMaybeSticky(th, col, columns, withHandle);
    if (col.day) {
      th.appendChild(rekvisitDayHead(col, canEdit));
    } else if (canEdit) {
      // Clearing the title and pressing Backspace/Delete once more asks to
      // remove the column (the locked one, derived and borrowed ones excepted).
      const removable = col.custom || (def.rows && col.key !== def.locked && !col.derived && !col.readOnly);
      th.appendChild(rekvisitColumnTitleInput(col.key, col.label, removable ? () => rekvisitRemoveColumn(col) : null));
      th.appendChild(rekvisitColumnResizer(col, cols[col.key], table, withHandle, withActions));
    } else {
      th.appendChild(el('div', 'rekvisit-head-label', rekvisitColumnLabel(col.key, col.label)));
    }
    headRow.appendChild(th);
  }
  if (withActions) {
    const addTh = el('th', 'rekvisit-col-actions');
    if (def.days) {
      const addDay = rekvisitAddPlusBtn('Tilføj dag');
      addDay.addEventListener('click', rekvisitOpenAddDayModal);
      addTh.appendChild(addDay);
    } else if (def.custom) {
      const addColBtn = rekvisitAddPlusBtn('Tilføj kolonne');
      addColBtn.addEventListener('click', rekvisitOpenAddColumnModal);
      addTh.appendChild(addColBtn);
    }
    headRow.appendChild(addTh);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  let rows = rekvisitRowDoc().rows;
  // Brændimprenering lists only the props that have a name.
  if (!def.rows) rows = rows.filter((r) => String(r.rekvisit || '').trim() !== '');
  const rest = rekvisitActiveTab === 'regnskab' ? rekvisitRestValues(rows).perRow : null;
  rows.forEach((row) => tbody.appendChild(rekvisitRenderRow(row, columns, canEdit, rest)));
  if (withHandle) tbody.appendChild(rekvisitBuildDropTail(columns.length + (withActions ? 2 : 1)));
  table.appendChild(tbody);
  if (!rows.length && !def.rows) {
    const tr = el('tr');
    const td = el('td', 'rekvisit-muted rekvisit-empty', 'Ingen rekvisitter endnu.');
    td.colSpan = columns.length;
    tr.appendChild(td);
    tbody.appendChild(tr);
  }

  const footer = rekvisitFooterValues(rows, columns);
  if (footer) {
    const tfoot = el('tfoot');
    const tr = el('tr', 'rekvisit-footer-row');
    if (withHandle) tr.appendChild(rekvisitStickyCell(el('td'), 0));
    for (const col of columns) {
      const td = el('td', rekvisitCellClass(col), footer[col.key] || '');
      rekvisitMaybeSticky(td, col, columns, withHandle);
      td.dataset.key = col.key;
      tr.appendChild(td);
    }
    if (withActions) tr.appendChild(el('td'));
    tfoot.appendChild(tr);
    table.appendChild(tfoot);
  }
  if (canEdit) rekvisitRefreshHints(tbody);
  return table;
}

// The first column (and the drag handle before it) stays put while the
// sheet scrolls sideways, like Fællesspisning's Navn.
function rekvisitStickyCell(cell, left) {
  cell.classList.add('rekvisit-col-sticky');
  cell.style.left = `${left}px`;
  return cell;
}

function rekvisitMaybeSticky(cell, col, columns, withHandle) {
  if (col === columns[0]) rekvisitStickyCell(cell, withHandle ? REKVISIT_HANDLE_COL_WIDTH : 0);
}

// One cell per run of same-group columns; the handle/actions columns join
// the first/last run so the band is unbroken.
function rekvisitBuildGroupRow(columns, withHandle, withActions) {
  const def = rekvisitDef();
  const tr = el('tr', 'rekvisit-group-row');
  const runs = [];
  for (const col of columns) {
    const last = runs[runs.length - 1];
    if (last && last.key === col.group) last.span++;
    else runs.push({ key: col.group, span: 1 });
  }
  runs.forEach((run, i) => {
    const group = def.groups.find((g) => g.key === run.key);
    const th = el('th', `rekvisit-group rekvisit-group-${run.key}`, group ? group.label : '');
    th.colSpan = run.span + (i === 0 && withHandle ? 1 : 0) + (i === runs.length - 1 && withActions ? 1 : 0);
    tr.appendChild(th);
  });
  return tr;
}

function rekvisitCellClass(col, extra) {
  const classes = extra ? [extra] : [];
  if (col.status) classes.push('rekvisit-col-status');
  if (col.group) classes.push(`rekvisit-in-group-${col.group}`);
  if (col.amount) classes.push('rekvisit-col-amount');
  if (col.day) classes.push('rekvisit-col-day');
  return classes.join(' ') || null;
}

// A day column's header: d/m (titles as tooltip) and, when editable, ✕.
function rekvisitDayHead(col, canEdit) {
  const wrap = el('div', 'rekvisit-day-head');
  const label = el('span', 'rekvisit-day-label', col.label);
  const weekday = DA_WEEKDAYS_SHORT[(parseIsoDate(col.day).getDay() + 6) % 7];
  label.title = [`${weekday} ${formatDaDate(col.day)}`, ...col.titles].join('\n');
  wrap.appendChild(el('span', 'rekvisit-day-weekday', weekday));
  wrap.appendChild(label);
  if (canEdit) {
    const remove = rekvisitRemoveBtn(`Fjern ${col.label}`);
    remove.classList.add('rekvisit-day-remove');
    remove.addEventListener('click', () => rekvisitRemoveDay(col));
    wrap.appendChild(remove);
  }
  return wrap;
}

// Text cell. `saved` is the last committed value, so typing can update the
// row (for the live sums) and a blur still knows whether to commit.
function rekvisitCreateTextInput(row, key, tr, canEdit, dayDate) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rekvisit-field';
  input.dataset.key = key;
  const read = () => (dayDate ? (row.days[dayDate] || '') : (row[key] || ''));
  input.value = read();
  let saved = input.value;
  if (!canEdit) {
    input.readOnly = true;
    input.title = input.value; // the full text of a cut-off cell
    return input;
  }
  input.addEventListener('input', () => {
    if (dayDate) {
      row.days[dayDate] = input.value;
      rekvisitPaintDayCell(input.parentNode, input.value);
    } else {
      row[key] = input.value;
    }
    rekvisitRefreshHints(tr.parentNode);
    rekvisitRefreshComputed();
  });
  input.addEventListener('blur', () => {
    if (saved === input.value && row.id !== null) return;
    saved = input.value;
    rekvisitCommitRow(row, dayDate ? { days: { [dayDate]: input.value } } : { [key]: input.value }, tr);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  return input;
}

// Click to cycle the column's values; commits right away.
function rekvisitStatusToggle(row, key, tr, canEdit) {
  const options = rekvisitStatusOptions(key);
  const btn = el('button', 'rekvisit-pill');
  btn.type = 'button';
  btn.disabled = !canEdit;
  function paint() {
    const meta = options.find((st) => st.value === (row[key] || '')) || options[0];
    btn.className = 'rekvisit-pill ' + meta.cls;
    btn.textContent = meta.label;
    btn.title = canEdit ? `${meta.label} (klik for at skifte)` : meta.label;
  }
  paint();
  btn.addEventListener('click', () => {
    const idx = options.findIndex((st) => st.value === (row[key] || ''));
    row[key] = options[(idx + 1) % options.length].value;
    paint();
    rekvisitCommitRow(row, { [key]: row[key] }, tr);
  });
  return btn;
}

// The example hints sit on the topmost row that doesn't yet have the
// sheet's hintRequired columns filled in (by what's typed right now), so
// they move down as rows are completed and back up when one is cleared.
function rekvisitRefreshHints(tbody) {
  const def = rekvisitDef();
  if (!tbody || !def.hintRequired) return;
  const hints = Object.fromEntries(def.columns.map((c) => [c.key, c.hint || '']));
  let hinted = false;
  for (const tr of tbody.querySelectorAll('tr.rekvisit-row')) {
    const inputs = Array.from(tr.querySelectorAll('input.rekvisit-field'));
    const complete = inputs
      .filter((i) => def.hintRequired.includes(i.dataset.key))
      .every((i) => i.value.trim() !== '');
    const target = !complete && !hinted;
    if (target) hinted = true;
    for (const input of inputs) input.placeholder = target ? (hints[input.dataset.key] || '') : '';
  }
}

function rekvisitRenderRow(row, columns, canEdit, rest) {
  const def = rekvisitDef();
  const tr = el('tr', 'rekvisit-row');
  tr._row = row;
  if (def.rows && canEdit) {
    const handleTd = rekvisitStickyCell(el('td', 'rekvisit-col-handle'), 0);
    const handle = el('span', 'boss-manage-drag-handle rekvisit-drag-handle', '⠿');
    handle.title = 'Træk for at flytte';
    handleTd.appendChild(handle);
    tr.appendChild(handleTd);
    rekvisitWireRowDrag(tr, handle, row);
  }
  for (const col of columns) {
    const td = el('td', rekvisitCellClass(col));
    rekvisitMaybeSticky(td, col, columns, def.rows && canEdit);
    if (col.status) {
      td.appendChild(rekvisitStatusToggle(row, col.key, tr, canEdit));
    } else if (col.derived) {
      const span = el('span', 'rekvisit-derived', rest ? (rest.get(row) || '') : '');
      span.dataset.key = col.key;
      td.appendChild(span);
    } else if (col.readOnly) {
      const text = String(row[col.key] || '');
      const span = el('span', 'rekvisit-readonly', text);
      span.title = text;
      td.appendChild(span);
    } else if (col.day) {
      td.appendChild(rekvisitCreateTextInput(row, col.key, tr, canEdit, col.day));
      rekvisitPaintDayCell(td, row.days[col.day]);
    } else {
      td.appendChild(rekvisitCreateTextInput(row, col.key, tr, canEdit));
    }
    tr.appendChild(td);
  }
  if (canEdit && (def.rows || def.custom || def.days)) {
    const actions = el('td', 'rekvisit-col-actions');
    if (def.rows) {
      const removeBtn = rekvisitRemoveBtn('Slet række');
      removeBtn.addEventListener('click', () => rekvisitDeleteRow(row, tr));
      actions.appendChild(removeBtn);
    }
    tr.appendChild(actions);
  }
  return tr;
}

// Adds an unsaved row at the end; it's created server-side on the first
// blur that leaves it non-empty (an abandoned "+" leaves nothing behind).
function rekvisitAddDraftRow(card) {
  const row = { id: null };
  rekvisitAllValueKeys().forEach((key) => { row[key] = ''; });
  if (rekvisitDef().days) row.days = {};
  const tbody = card.querySelector('.rekvisit-table tbody');
  const tr = rekvisitRenderRow(row, rekvisitSheetColumns(), true, null);
  tr.classList.add('rekvisit-draft-row');
  tbody.insertBefore(tr, tbody.querySelector('.rekvisit-drop-tail-row'));
  rekvisitRefreshHints(tbody);
  rekvisitRefreshComputed();
  const first = tr.querySelector('input');
  if (first) first.focus();
}

// Commits `fields` of one row to its row sheet. A draft row is created
// with all its current fields; commits on the same row are serialized via
// row._inFlight so two quick blurs on a draft can't create it twice.
async function rekvisitCommitRow(row, fields, tr) {
  const sheet = rekvisitDef().rowSheet;
  if (row.id === null && !rekvisitRowHasContent(row)) return;
  if (row._inFlight) await row._inFlight;
  const isNew = row.id === null;
  let body;
  if (isNew) {
    const payload = {};
    rekvisitAllValueKeys().forEach((key) => { payload[key] = row[key] || ''; });
    if (row.days) payload.days = { ...row.days };
    body = { sheet, row: payload };
  } else {
    body = { sheet, row: { id: row.id, ...fields } };
  }
  const promise = rekvisitApi('rekvisit_upsert_row', body);
  row._inFlight = promise;
  const result = await promise;
  row._inFlight = null;
  if (!result.ok) {
    rekvisitHandleFailure(result);
    return;
  }
  if (isNew) {
    row.id = result.data.row.id;
    if (tr) tr.classList.remove('rekvisit-draft-row');
    rekvisitSheets[sheet].rows.push(row);
  }
}

function rekvisitDeleteRow(row, tr) {
  const sheet = rekvisitDef().rowSheet;
  if (row.id === null) {
    const tbody = tr.parentNode;
    tr.remove();
    rekvisitRefreshHints(tbody);
    rekvisitRefreshComputed();
    return;
  }
  const remove = async () => {
    const result = await rekvisitApi('rekvisit_delete_row', { sheet, rowId: row.id });
    if (!result.ok) { rekvisitShowError(result.message); return false; }
    rekvisitSheets[sheet].rows = rekvisitSheets[sheet].rows.filter((r) => r !== row);
    rekvisitRender();
    return true;
  };
  // An empty row goes without asking.
  if (!rekvisitRowHasContent(row)) { remove(); return; }
  rekvisitConfirm(`Slet "${rekvisitRowLabel(row)}"?`, 'Dette kan ikke fortrydes.', 'Slet', remove);
}

// Styled "Er du sikker?" overlay. onConfirm returns false to keep the modal
// open (e.g. on a failed request).
function rekvisitConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('rekvisit-confirm-modal');
  if (description) form.appendChild(el('p', 'rekvisit-confirm-text', description));
  const cancelBtn = rekvisitPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = rekvisitPillBtn(confirmLabel, 'site-btn-danger');
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

// ── Drag to reorder ──────────────────────────────────────────
// Trailing drop zone — a per-row drop target can only insert *before* a row.
function rekvisitBuildDropTail(colSpan) {
  const tr = el('tr', 'rekvisit-drop-tail-row');
  const td = el('td');
  td.colSpan = colSpan;
  tr.appendChild(td);
  rekvisitWireDropHighlight(tr, () => rekvisitMoveRow(rekvisitDragRow, null));
  return tr;
}

// Only the handle starts a drag — a draggable row would swallow text
// selection inside its inputs.
function rekvisitWireRowDrag(tr, handle, row) {
  handle.addEventListener('mousedown', () => { tr.draggable = row.id !== null; });
  handle.addEventListener('touchstart', () => { tr.draggable = row.id !== null; }, { passive: true });
  tr.addEventListener('dragstart', (e) => {
    rekvisitDragRow = row;
    e.dataTransfer.effectAllowed = 'move';
    const ghost = rekvisitGetDragImageEl();
    ghost.textContent = rekvisitRowLabel(row);
    e.dataTransfer.setDragImage(ghost, 12, 16);
  });
  tr.addEventListener('dragend', () => {
    tr.draggable = false;
    rekvisitDragRow = null;
  });
  // A draft row isn't in the sheet's rows yet, so it can't be a drop anchor.
  rekvisitWireDropHighlight(tr, () => { if (row.id !== null) rekvisitMoveRow(rekvisitDragRow, row); });
}

function rekvisitGetDragImageEl() {
  let ghost = document.getElementById('rekvisit-drag-image');
  if (!ghost) {
    ghost = el('div', 'rekvisit-drag-image');
    ghost.id = 'rekvisit-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// Duplicated from kostume.js's kostumeWireDropHighlight.
function rekvisitWireDropHighlight(rowEl, onDrop) {
  let depth = 0;
  rowEl.addEventListener('dragenter', (e) => {
    if (!rekvisitDragRow) return;
    e.preventDefault();
    depth++;
    rowEl.classList.add('rekvisit-drop-target');
  });
  rowEl.addEventListener('dragover', (e) => { if (rekvisitDragRow) e.preventDefault(); });
  rowEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) rowEl.classList.remove('rekvisit-drop-target');
  });
  rowEl.addEventListener('drop', (e) => {
    if (!rekvisitDragRow) return;
    e.preventDefault();
    depth = 0;
    rowEl.classList.remove('rekvisit-drop-target');
    onDrop();
  });
}

// Moves `item` to just before `target` (null = the end), optimistically,
// then sends the full id order.
async function rekvisitMoveRow(item, target) {
  if (!item || item === target || item.id === null) return;
  const sheet = rekvisitDef().rowSheet;
  const rows = rekvisitSheets[sheet].rows;
  const previous = rows.slice();
  const from = rows.indexOf(item);
  if (from === -1) return;
  rows.splice(from, 1);
  const to = target ? rows.indexOf(target) : rows.length;
  rows.splice(to === -1 ? rows.length : to, 0, item);
  if (rows.every((r, i) => r === previous[i])) return;
  rekvisitRender();
  const result = await rekvisitApi('rekvisit_reorder', { sheet, order: rows.map((r) => r.id) });
  if (!result.ok) {
    rekvisitSheets[sheet].rows = previous;
    rekvisitRender();
    rekvisitHandleFailure(result);
  }
}

// ── Resizable columns ────────────────────────────────────────
function rekvisitColumnWidth(col) {
  const px = rekvisitTabDoc().columnWidths[col.key];
  return Number.isInteger(px) ? px : col.width;
}

function rekvisitUpdateSheetWidth(table, withHandle, withActions) {
  const total = (withHandle ? REKVISIT_HANDLE_COL_WIDTH : 0) + (withActions ? REKVISIT_ACTIONS_COL_WIDTH : 0)
    + rekvisitSheetColumns().reduce((sum, col) => sum + rekvisitColumnWidth(col), 0);
  // Never narrower than the card; wider columns overflow into the scroll.
  table.style.width = `max(100%, ${total}px)`;
}

// A grip on the header's right edge: drag to resize (pointer events, so
// touch works too), double-click to go back to the default width.
function rekvisitColumnResizer(col, colEl, table, withHandle, withActions) {
  const grip = el('div', 'rekvisit-col-resizer');
  grip.title = 'Træk for at ændre bredden (dobbeltklik for standard)';
  const widths = () => rekvisitTabDoc().columnWidths;
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    const startX = e.clientX;
    const startWidth = rekvisitColumnWidth(col);
    const onMove = (ev) => {
      widths()[col.key] = Math.max(REKVISIT_MIN_COL_WIDTH, Math.round(startWidth + ev.clientX - startX));
      colEl.style.width = `${widths()[col.key]}px`;
      rekvisitUpdateSheetWidth(table, withHandle, withActions);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      grip.classList.remove('active');
      if (rekvisitColumnWidth(col) !== startWidth) rekvisitSaveColumnWidths();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
  grip.addEventListener('dblclick', () => {
    if (!(col.key in widths())) return;
    delete widths()[col.key];
    colEl.style.width = `${col.width}px`;
    rekvisitUpdateSheetWidth(table, withHandle, withActions);
    rekvisitSaveColumnWidths();
  });
  return grip;
}

let rekvisitColumnWidthsInFlight = null;
async function rekvisitSaveColumnWidths() {
  if (rekvisitColumnWidthsInFlight) await rekvisitColumnWidthsInFlight;
  const sheet = rekvisitActiveTab;
  const promise = rekvisitApi('rekvisit_save_column_widths', { sheet, columnWidths: { ...rekvisitTabDoc(sheet).columnWidths } });
  rekvisitColumnWidthsInFlight = promise;
  const result = await promise;
  rekvisitColumnWidthsInFlight = null;
  if (!result.ok) rekvisitHandleFailure(result);
}

// ── Adding/removing columns ──────────────────────────────────
// Removing a built-in column only hides it (values kept, it can be added
// back); removing a custom column deletes it with its values.
async function rekvisitSaveColumns(customColumns, hiddenColumns) {
  const sheet = rekvisitActiveTab;
  const result = await rekvisitApi('rekvisit_save_columns', { sheet, customColumns, hiddenColumns });
  if (!result.ok) { rekvisitShowError(result.message); return false; }
  const doc = rekvisitTabDoc(sheet);
  doc.customColumns = result.data.customColumns || [];
  doc.hiddenColumns = result.data.hiddenColumns || [];
  // A deleted custom column's title/width went with it server-side.
  const live = new Set(rekvisitAllValueKeys(sheet));
  for (const map of [doc.columnLabels, doc.columnWidths]) {
    for (const key of Object.keys(map)) if (REKVISIT_CUSTOM_KEY_RE.test(key) && !live.has(key)) delete map[key];
  }
  rekvisitRender();
  return true;
}

function rekvisitRemoveColumn(col) {
  const doc = rekvisitTabDoc();
  const label = rekvisitColumnLabel(col.key, col.label);
  const description = col.custom
    ? 'Kolonnen og alt dens indhold slettes. Dette kan ikke fortrydes.'
    : 'Kolonnen skjules. Indholdet gemmes og kommer tilbage, hvis du tilføjer kolonnen igen.';
  rekvisitConfirm(`Fjern kolonnen "${label}"?`, description, 'Fjern', () => {
    if (col.custom) {
      return rekvisitSaveColumns(doc.customColumns.filter((c) => c.key !== col.key), doc.hiddenColumns);
    }
    return rekvisitSaveColumns(doc.customColumns, [...doc.hiddenColumns, col.key]);
  });
}

function rekvisitOpenAddColumnModal() {
  const doc = rekvisitTabDoc();
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj kolonne');
  modal.classList.add('rekvisit-column-modal');
  const hidden = rekvisitDef().columns.filter((c) => doc.hiddenColumns.includes(c.key));

  let pick = null;
  if (hidden.length) {
    pick = siteCreateDropdownField([
      { value: '', label: 'Ny kolonne' },
      ...hidden.map((c) => ({ value: c.key, label: `${rekvisitColumnLabel(c.key, c.label)} (tidligere fjernet)` })),
    ], '');
    form.appendChild(siteEditField('Kolonne', pick));
  }
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 100;
  nameInput.placeholder = 'Fx Mål';
  const nameField = siteEditField('Navn', nameInput);
  form.appendChild(nameField);
  if (pick) {
    pick.addEventListener('change', () => { nameField.hidden = pick.value !== ''; });
  }

  const addBtn = rekvisitPillBtn('Tilføj', 'site-btn-success');
  async function submit() {
    let ok;
    if (pick && pick.value) {
      addBtn.disabled = true;
      ok = await rekvisitSaveColumns(doc.customColumns, doc.hiddenColumns.filter((k) => k !== pick.value));
    } else {
      const label = nameInput.value.trim();
      if (!label) { error.textContent = 'Skriv et navn.'; nameInput.focus(); return; }
      addBtn.disabled = true;
      ok = await rekvisitSaveColumns([...doc.customColumns, { label }], doc.hiddenColumns);
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
// Stored per revy and tab as columnLabels {key: title}; only renamed
// columns are saved, so clearing a title brings the default back.
function rekvisitColumnLabel(key, fallback) {
  const label = rekvisitTabDoc().columnLabels[key];
  return (typeof label === 'string' && label.trim()) ? label : fallback;
}

// Editable text rather than an <input>, so a long title wraps instead of
// being cut off. Read back through textContent only.
// `onDeleteEmpty` (optional): called when Backspace/Delete is pressed on an
// already-empty title — used to offer removing the column.
function rekvisitColumnTitleInput(key, fallback, onDeleteEmpty) {
  const labels = () => rekvisitTabDoc().columnLabels;
  const title = el('div', 'rekvisit-head-input', rekvisitColumnLabel(key, fallback));
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
      title.textContent = rekvisitColumnLabel(key, fallback);
      title.blur();
      onDeleteEmpty();
    }
  });
  title.addEventListener('blur', () => {
    const value = (title.textContent || '').replace(/\s+/g, ' ').trim();
    const next = value && value !== fallback ? value : '';
    const changed = (labels()[key] || '') !== next;
    if (next) labels()[key] = next;
    else delete labels()[key];
    title.textContent = rekvisitColumnLabel(key, fallback);
    if (changed) rekvisitSaveColumnLabels();
  });
  return title;
}

let rekvisitColumnLabelsInFlight = null;
async function rekvisitSaveColumnLabels() {
  if (rekvisitColumnLabelsInFlight) await rekvisitColumnLabelsInFlight;
  const sheet = rekvisitActiveTab;
  const promise = rekvisitApi('rekvisit_save_column_labels', { sheet, columnLabels: { ...rekvisitTabDoc(sheet).columnLabels } });
  rekvisitColumnLabelsInFlight = promise;
  const result = await promise;
  rekvisitColumnLabelsInFlight = null;
  if (!result.ok) rekvisitHandleFailure(result);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = rekvisitRoot();
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'rekvisit-muted', 'Rekvisitten kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  rekvisitFolder = rekvisitInitialFolder(rekvisitRevyOptions());
  rekvisitRenderPicker();
  window.addEventListener('beforeunload', (e) => {
    if (rekvisitPending > 0) { e.preventDefault(); e.returnValue = ''; }
  });
  if (typeof siteRegisterUnsavedCheck === 'function') siteRegisterUnsavedCheck(() => rekvisitPending > 0);
  rekvisitLoad();
});
