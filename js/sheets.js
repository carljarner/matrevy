/* =========================================================
   Matematikrevyen – Ark (sheets.html): self-hosted spreadsheet
   replacing Google Sheets. Same privacy posture as Budget/Forms
   (private Simply.com datastore, never the public repo, since
   cell contents may carry names/other personal text) — but every
   action is revyst-level, mirroring only Forms' fill-in tier, not
   its boss-gated management tier: any logged-in cast/crew member
   can create/edit/delete their own sheets.

   Deliberately minimal: no general formula engine (see the
   "Formula engine" section below), no live collaboration (an
   explicit "Gem" full-document-replace save, like every other
   write on this site), fixed colour-swatch palette rather than a
   free-form picker.
   ========================================================= */

'use strict';

const SHEETS_DEFAULT_ROWS = 20;
const SHEETS_DEFAULT_COLS = 10;
const SHEETS_MAX_ROWS = 200;
const SHEETS_MAX_COLS = 50;

// Fixed swatch palette for cell background/text colour — same "fixed
// palette, not a free-form picker" convention as Kalender's
// CAL_CATEGORIES. Keep the keys in sync with sheets_valid_color() in
// server/update-data.php.
const SHEETS_COLORS = {
  red: '#ef4444', orange: '#f97316', yellow: '#eab308', green: '#22c55e',
  teal: '#14b8a6', blue: '#3b82f6', purple: '#a855f7', pink: '#ec4899',
  gray: '#6b7280', brown: '#92400e',
};

// ── Small DOM helper (mirrors forms.js's el()) ────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function sheetsPillBtn(label, variant) {
  const btn = el('button', 'site-pill-btn' + (variant ? ' ' + variant : ''), label);
  btn.type = 'button';
  return btn;
}

// Icon-only row action (list's "Omdøb") — same SVG pencil convention as
// forms.js's formsPencilIcon, duplicated here since sheets.html doesn't
// load forms.js (the established per-feature duplication convention).
function sheetsPencilIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const body = document.createElementNS(svgNS, 'path');
  body.setAttribute('d', 'M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z');
  svg.appendChild(body);
  const tip = document.createElementNS(svgNS, 'path');
  tip.setAttribute('d', 'M9 4l3 3');
  svg.appendChild(tip);
  return svg;
}

// ── Authenticated API (mirrors forms.js's formsResolvePassword/formsApi) ──
function sheetsResolvePassword() {
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

function sheetsMapError(status) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. Genindlæs siden og prøv igen.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, message }.
async function sheetsApi(action, body) {
  const password = sheetsResolvePassword();
  if (!password) return { ok: false, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...body }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  // Require a real {ok:true} JSON body — a PHP fatal error (or a WAF
  // challenge) can come back as HTTP 200 with an HTML body, and must NOT
  // be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    const base = sheetsMapError(res.status);
    return { ok: false, message: detail ? `${base} (${detail})` : base };
  }
  if (!data || data.ok !== true) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    return { ok: false, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── Cell reference helpers (A1 <-> {r,c}), used only by the formula
// parser/renderer below — storage always uses "r_c" keys, see sheets_save. ──
const SHEETS_CELL_REF_RE = /^[A-Za-z]+[0-9]+$/;

function sheetsColLetterToIndex(letters) {
  let n = 0;
  const up = letters.toUpperCase();
  for (let i = 0; i < up.length; i++) n = n * 26 + (up.charCodeAt(i) - 64);
  return n - 1;
}

function sheetsIndexToColLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    s = String.fromCharCode(65 + rem) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function sheetsCellA1ToRC(ref) {
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(ref);
  if (!m) return null;
  return { r: parseInt(m[2], 10) - 1, c: sheetsColLetterToIndex(m[1]) };
}

// ── Minimal formula engine ─────────────────────────────────────
// Deliberately not a general formula system — math is explicitly a
// secondary concern here. Supported grammar, exactly:
//   =A1+B2  =A1-B2  =A1*B2  =A1/B2   (one binary op, cell refs or numbers)
//   =COUNT(A1:A5)                    (one contiguous range)
// Anything else that starts with "=" is displayed as literal text, no
// error state. Evaluated fresh at render time — nothing is pre-computed
// or stored.
function sheetsParseFormula(str) {
  const countMatch = /^=\s*COUNT\(\s*([A-Za-z]+[0-9]+)\s*:\s*([A-Za-z]+[0-9]+)\s*\)\s*$/i.exec(str);
  if (countMatch) return { type: 'count', from: countMatch[1], to: countMatch[2] };
  const binMatch = /^=\s*(-?[A-Za-z0-9.]+)\s*([+\-*/])\s*(-?[A-Za-z0-9.]+)\s*$/.exec(str);
  if (binMatch) {
    const [, a, op, b] = binMatch;
    const validOperand = (t) => SHEETS_CELL_REF_RE.test(t) || !isNaN(parseFloat(t));
    if (validOperand(a) && validOperand(b)) return { type: 'binop', a, op, b };
  }
  return null;
}

function sheetsResolveNumeric(cells, token, seen) {
  if (SHEETS_CELL_REF_RE.test(token)) {
    const rc = sheetsCellA1ToRC(token);
    const val = sheetsEvalCell(cells, rc.r, rc.c, seen);
    if (val === '#REF') return '#REF';
    const num = parseFloat(val);
    return isNaN(num) ? 0 : num;
  }
  const num = parseFloat(token);
  return isNaN(num) ? 0 : num;
}

function sheetsRangeCells(fromRef, toRef) {
  const a = sheetsCellA1ToRC(fromRef);
  const b = sheetsCellA1ToRC(toRef);
  if (!a || !b) return null;
  const out = [];
  for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++) {
    for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push({ r, c });
  }
  return out;
}

function sheetsFormatNumber(n) {
  return String(Math.round(n * 1e6) / 1e6);
}

// Resolves the DISPLAY value of one cell, recursively resolving any cell
// refs its formula points at. `seen` (a Set of "r_c" keys) guards against
// a circular formula — on a cycle this returns '#REF' and stops rather
// than looping/crashing.
function sheetsEvalCell(cells, r, c, seen) {
  const key = r + '_' + c;
  if (seen.has(key)) return '#REF';
  const cell = cells[key];
  const raw = cell ? cell.value : '';
  if (typeof raw !== 'string' || raw === '' || raw[0] !== '=') return raw || '';
  const parsed = sheetsParseFormula(raw);
  if (!parsed) return raw; // unrecognized formula syntax — show as literal text
  const nextSeen = new Set(seen);
  nextSeen.add(key);
  if (parsed.type === 'binop') {
    const a = sheetsResolveNumeric(cells, parsed.a, nextSeen);
    const b = sheetsResolveNumeric(cells, parsed.b, nextSeen);
    if (a === '#REF' || b === '#REF') return '#REF';
    if (parsed.op === '/' && b === 0) return '#DIV/0!';
    let result;
    if (parsed.op === '+') result = a + b;
    else if (parsed.op === '-') result = a - b;
    else if (parsed.op === '*') result = a * b;
    else result = a / b;
    return sheetsFormatNumber(result);
  }
  const range = sheetsRangeCells(parsed.from, parsed.to);
  if (!range) return '#REF';
  let count = 0;
  for (const { r: rr, c: cc } of range) {
    if (sheetsEvalCell(cells, rr, cc, nextSeen) !== '') count++;
  }
  return String(count);
}

// ── Reshape: reindexing the sparse cell map ───────────────────
// Shared by both row and column insert/delete. delta > 0 (insert at
// `index`): every cell at row/col >= index shifts by +delta, making room.
// delta < 0 (delete at `index`): the cell(s) exactly at `index` are
// dropped, everything beyond shifts by delta to close the gap.
function sheetsReindexCells(cells, kind, index, delta) {
  const next = {};
  for (const [key, cell] of Object.entries(cells)) {
    const [rStr, cStr] = key.split('_');
    let r = Number(rStr);
    let c = Number(cStr);
    const coord = kind === 'row' ? r : c;
    if (delta < 0 && coord === index) continue;
    if (coord >= index) {
      if (kind === 'row') r += delta; else c += delta;
    }
    if (r < 0 || c < 0) continue;
    next[r + '_' + c] = cell;
  }
  return next;
}

// ── Sheet list (revyst) ────────────────────────────────────────
function sheetsFormatUpdatedAt(iso) {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function renderSheetsList(root) {
  root.replaceChildren();
  const card = el('section', 'card sheets-list-card');
  const head = el('div', 'sheets-list-head');
  head.appendChild(el('h2', null, 'Dine ark'));
  const newBtn = el('button', 'site-btn-primary', '+ Nyt ark');
  newBtn.type = 'button';
  newBtn.addEventListener('click', () => sheetsOpenNewSheetModal(root));
  head.appendChild(newBtn);
  card.appendChild(head);
  const listWrap = el('div', 'sheets-list', 'Henter ark …');
  card.appendChild(listWrap);
  root.appendChild(card);

  const result = await sheetsApi('sheets_list', {});
  listWrap.replaceChildren();
  if (!result.ok) {
    if (result.message) listWrap.appendChild(el('p', 'sheets-msg error', result.message));
    return;
  }
  const sheets = Array.isArray(result.data.sheets) ? result.data.sheets.slice() : [];
  sheets.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  if (sheets.length === 0) {
    listWrap.appendChild(el('p', 'sheets-intro', 'Der er ingen ark endnu.'));
    return;
  }
  for (const s of sheets) {
    const row = el('div', 'sheets-row');
    const openBtn = el('button', 'sheets-row-open');
    openBtn.type = 'button';
    openBtn.appendChild(el('span', 'sheets-row-name', s.name));
    if (s.updatedAt) openBtn.appendChild(el('span', 'sheets-row-updated', 'Opdateret ' + sheetsFormatUpdatedAt(s.updatedAt)));
    openBtn.addEventListener('click', () => renderSheetGrid(root, s.id));
    row.appendChild(openBtn);

    const actions = el('div', 'sheets-row-actions');
    const renameBtn = el('button', 'sheets-row-icon-btn');
    renameBtn.type = 'button';
    renameBtn.setAttribute('aria-label', 'Omdøb');
    renameBtn.setAttribute('data-tooltip', 'Omdøb');
    renameBtn.appendChild(sheetsPencilIcon());
    renameBtn.addEventListener('click', () => sheetsOpenRenameModal(root, s));
    const deleteBtn = el('button', 'sheets-row-icon-btn sheets-row-icon-danger', '✕');
    deleteBtn.type = 'button';
    deleteBtn.setAttribute('aria-label', 'Slet');
    deleteBtn.setAttribute('data-tooltip', 'Slet');
    deleteBtn.addEventListener('click', () => sheetsOpenDeleteConfirm(root, s));
    actions.appendChild(renameBtn);
    actions.appendChild(deleteBtn);
    row.appendChild(actions);

    listWrap.appendChild(row);
  }
}

function sheetsOpenNewSheetModal(root) {
  const { form, error, actions, close } = siteOpenEditModal('Nyt ark');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 120;
  form.appendChild(siteEditField('Navn', nameInput));
  const cancelBtn = sheetsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const createBtn = sheetsPillBtn('Opret', 'site-pill-primary');
  createBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { error.textContent = 'Angiv et navn.'; return; }
    createBtn.disabled = true;
    const result = await sheetsApi('sheets_save', {
      name, rows: SHEETS_DEFAULT_ROWS, cols: SHEETS_DEFAULT_COLS, cells: {},
    });
    createBtn.disabled = false;
    if (result.ok) {
      close();
      renderSheetGrid(root, result.data.id);
    } else if (result.message) {
      error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(createBtn);
  nameInput.focus();
}

// Renaming resends the full document (fetched fresh first) — same
// fold-into-save convention as Forms' open/close toggle, no separate
// rename action server-side.
function sheetsOpenRenameModal(root, s) {
  const { form, error, actions, close } = siteOpenEditModal('Omdøb ark');
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 120;
  nameInput.value = s.name;
  form.appendChild(siteEditField('Navn', nameInput));
  const cancelBtn = sheetsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const saveBtn = sheetsPillBtn('Gem', 'site-pill-primary');
  saveBtn.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) { error.textContent = 'Angiv et navn.'; return; }
    saveBtn.disabled = true;
    const full = await sheetsApi('sheets_get', { id: s.id });
    if (!full.ok) {
      saveBtn.disabled = false;
      error.textContent = full.message || 'Kunne ikke hente arket.';
      return;
    }
    const sheet = full.data.sheet;
    const result = await sheetsApi('sheets_save', {
      id: s.id, name, rows: sheet.rows, cols: sheet.cols, cells: sheet.cells || {},
    });
    saveBtn.disabled = false;
    if (result.ok) { close(); renderSheetsList(root); }
    else if (result.message) error.textContent = result.message;
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  nameInput.focus();
  nameInput.select();
}

function sheetsOpenDeleteConfirm(root, s) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Slet ark');
  modal.classList.add('sheets-center-modal');
  form.appendChild(el('p', 'sheets-intro', `Slet "${s.name}" permanent? Dette kan ikke fortrydes.`));
  const cancelBtn = sheetsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = sheetsPillBtn('Slet', 'site-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const result = await sheetsApi('sheets_delete', { id: s.id });
    if (result.ok) { close(); renderSheetsList(root); }
    else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

function sheetsOpenLeaveWarning(onLeave) {
  const { form, actions, close } = siteOpenModalWithClose('Forlad siden?');
  form.appendChild(el('p', 'sheets-intro', 'Ikke-gemte ændringer i arket går tabt.'));
  const cancelBtn = sheetsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const leaveBtn = sheetsPillBtn('Forlad', 'site-pill-warm');
  leaveBtn.addEventListener('click', () => { close(); onLeave(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(leaveBtn);
}

// ── Grid editor (revyst) ───────────────────────────────────────
// One module-level draft, mirroring schedule.js's single `state` object —
// set fresh each time a sheet is opened, cleared when leaving.
let sheetState = null;

async function renderSheetGrid(root, sheetId) {
  sheetState = null;
  root.replaceChildren();
  const card = el('section', 'card sheets-app');
  const backBtn = el('button', 'sheets-back-btn', '←');
  backBtn.type = 'button';
  backBtn.title = 'Tilbage til ark';
  backBtn.setAttribute('aria-label', 'Tilbage til ark');
  backBtn.addEventListener('click', () => {
    if (sheetState && sheetState.dirty) sheetsOpenLeaveWarning(() => renderSheetsList(root));
    else renderSheetsList(root);
  });
  card.appendChild(backBtn);
  const title = el('h2', 'sheets-title', 'Indlæser …');
  card.appendChild(title);
  const body = el('div', null, 'Henter ark …');
  card.appendChild(body);
  root.appendChild(card);

  const result = await sheetsApi('sheets_get', { id: sheetId });
  body.replaceChildren();
  if (!result.ok) {
    title.textContent = 'Ark';
    body.appendChild(el('p', 'sheets-msg error', result.message || 'Kunne ikke hente arket.'));
    return;
  }
  const sheet = result.data.sheet;
  title.textContent = sheet.name;

  sheetState = {
    id: sheet.id,
    name: sheet.name,
    rows: sheet.rows,
    cols: sheet.cols,
    cells: sheet.cells || {},
    selected: { r: 0, c: 0 },
    editingTd: null,
    dirty: false,
    savingInFlight: false,
    gridWrap: null,
    statusEl: null,
    toolbar: null,
  };

  const toolbar = sheetsBuildToolbar();
  body.appendChild(toolbar);
  const status = el('div', 'sheets-status');
  body.appendChild(status);
  sheetState.statusEl = status;
  const gridWrap = el('div', 'sheets-grid-wrap');
  body.appendChild(gridWrap);
  sheetState.gridWrap = gridWrap;

  sheetsRenderGridTable();
  sheetsUpdateToolbarState();
  sheetsUpdateStatus();
}

function sheetsCurrentCellData() {
  if (!sheetState.selected) return {};
  const key = sheetState.selected.r + '_' + sheetState.selected.c;
  return sheetState.cells[key] || {};
}

function sheetsEnsureCell(r, c) {
  const key = r + '_' + c;
  if (!sheetState.cells[key]) sheetState.cells[key] = { value: '' };
  return sheetState.cells[key];
}

function sheetsMarkDirty() {
  sheetState.dirty = true;
  sheetsUpdateStatus();
}

function sheetsUpdateStatus(msg, isError) {
  if (!sheetState || !sheetState.statusEl) return;
  if (msg != null) {
    sheetState.statusEl.textContent = msg;
    sheetState.statusEl.classList.toggle('error', !!isError);
    return;
  }
  sheetState.statusEl.textContent = sheetState.dirty ? 'Ikke-gemte ændringer' : 'Alt er gemt';
  sheetState.statusEl.classList.remove('error');
}

// ── Toolbar ────────────────────────────────────────────────────
function sheetsBuildToolbar() {
  const toolbar = el('div', 'sheets-toolbar');

  function group(children, extraClass) {
    const g = el('div', 'sheets-toolbar-group' + (extraClass ? ' ' + extraClass : ''));
    children.forEach((c) => g.appendChild(c));
    return g;
  }
  // Toolbar buttons never steal focus from an actively-edited cell's
  // <input> — a click still fires normally, but the input's cursor/
  // selection survives, and its value (already live-committed on every
  // keystroke, see sheetsEnterEditMode) is never at risk either way.
  function noStealFocus(btn) {
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    return btn;
  }

  function fmtBtn(label, key, title) {
    const btn = noStealFocus(el('button', 'sheets-toolbar-btn', label));
    btn.type = 'button';
    btn.title = title;
    btn.addEventListener('click', () => sheetsToggleFormat(key));
    return btn;
  }
  const boldBtn = fmtBtn('B', 'bold', 'Fed');
  boldBtn.classList.add('sheets-glyph-bold');
  const italicBtn = fmtBtn('I', 'italic', 'Kursiv');
  italicBtn.classList.add('sheets-glyph-italic');
  const underlineBtn = fmtBtn('U', 'underline', 'Understreget');
  underlineBtn.classList.add('sheets-glyph-underline');
  toolbar.appendChild(group([boldBtn, italicBtn, underlineBtn]));

  function alignBtn(label, value, title) {
    const btn = noStealFocus(el('button', 'sheets-toolbar-btn', label));
    btn.type = 'button';
    btn.title = title;
    btn.addEventListener('click', () => sheetsSetAlign(value));
    return btn;
  }
  const alignLeftBtn = alignBtn('⟸', 'left', 'Venstrestil');
  const alignCenterBtn = alignBtn('•', 'center', 'Centrer');
  const alignRightBtn = alignBtn('⟹', 'right', 'Højrestil');
  toolbar.appendChild(group([alignLeftBtn, alignCenterBtn, alignRightBtn]));

  function colorField(labelText) {
    const btn = noStealFocus(el('button', 'sheets-toolbar-btn sheets-color-field-btn'));
    btn.type = 'button';
    btn.title = labelText;
    const swatch = el('span', 'sheets-color-field-swatch');
    btn.appendChild(swatch);
    btn.appendChild(el('span', null, labelText));
    return { btn, swatch };
  }
  const bgField = colorField('Baggrund');
  bgField.btn.addEventListener('click', () => {
    siteToggleFieldPopup(bgField.btn, () => {
      sheetsOpenColorPicker(bgField.btn, sheetsCurrentCellData().bg, (key) => sheetsSetColor('bg', key));
    });
  });
  const textColorField = colorField('Tekst');
  textColorField.btn.addEventListener('click', () => {
    siteToggleFieldPopup(textColorField.btn, () => {
      sheetsOpenColorPicker(textColorField.btn, sheetsCurrentCellData().color, (key) => sheetsSetColor('color', key));
    });
  });
  toolbar.appendChild(group([bgField.btn, textColorField.btn]));

  const addColBtn = el('button', 'sheets-toolbar-btn', '+ Kolonne');
  addColBtn.type = 'button';
  addColBtn.addEventListener('click', sheetsInsertColumn);
  const delColBtn = el('button', 'sheets-toolbar-btn', 'Slet kolonne');
  delColBtn.type = 'button';
  delColBtn.addEventListener('click', sheetsDeleteColumn);
  const addRowBtn = el('button', 'sheets-toolbar-btn', '+ Række');
  addRowBtn.type = 'button';
  addRowBtn.addEventListener('click', sheetsInsertRow);
  const delRowBtn = el('button', 'sheets-toolbar-btn', 'Slet række');
  delRowBtn.type = 'button';
  delRowBtn.addEventListener('click', sheetsDeleteRow);
  toolbar.appendChild(group([addColBtn, delColBtn, addRowBtn, delRowBtn], 'sheets-toolbar-reshape'));

  toolbar.appendChild(el('div', 'sheets-toolbar-spacer'));
  const saveBtn = el('button', 'site-btn-primary', 'Gem');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', sheetsSaveCurrent);
  toolbar.appendChild(saveBtn);

  sheetState.toolbar = {
    boldBtn, italicBtn, underlineBtn,
    alignLeftBtn, alignCenterBtn, alignRightBtn,
    bgField, textColorField,
    addColBtn, delColBtn, addRowBtn, delRowBtn,
    saveBtn,
  };
  return toolbar;
}

function sheetsUpdateToolbarState() {
  const tb = sheetState.toolbar;
  if (!tb) return;
  const cell = sheetsCurrentCellData();
  tb.boldBtn.classList.toggle('active', !!cell.bold);
  tb.italicBtn.classList.toggle('active', !!cell.italic);
  tb.underlineBtn.classList.toggle('active', !!cell.underline);
  tb.alignLeftBtn.classList.toggle('active', cell.align === 'left');
  tb.alignCenterBtn.classList.toggle('active', cell.align === 'center');
  tb.alignRightBtn.classList.toggle('active', cell.align === 'right');
  tb.bgField.swatch.style.background = cell.bg ? SHEETS_COLORS[cell.bg] : '';
  tb.textColorField.swatch.style.background = cell.color ? SHEETS_COLORS[cell.color] : '';
  const disableFormat = !sheetState.selected;
  [tb.boldBtn, tb.italicBtn, tb.underlineBtn, tb.alignLeftBtn, tb.alignCenterBtn, tb.alignRightBtn,
    tb.bgField.btn, tb.textColorField.btn].forEach((b) => { b.disabled = disableFormat; });
  tb.delColBtn.disabled = sheetState.cols <= 1;
  tb.delRowBtn.disabled = sheetState.rows <= 1;
  tb.addColBtn.disabled = sheetState.cols >= SHEETS_MAX_COLS;
  tb.addRowBtn.disabled = sheetState.rows >= SHEETS_MAX_ROWS;
}

function sheetsOpenColorPicker(anchor, currentKey, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop sheets-color-pop';
  const noneBtn = document.createElement('button');
  noneBtn.type = 'button';
  noneBtn.className = 'sheets-color-swatch sheets-color-none' + (!currentKey ? ' selected' : '');
  noneBtn.title = 'Ingen farve';
  noneBtn.textContent = '✕';
  noneBtn.addEventListener('click', () => { close(); onSelect(null); });
  pop.appendChild(noneBtn);
  for (const key of Object.keys(SHEETS_COLORS)) {
    const sw = document.createElement('button');
    sw.type = 'button';
    sw.className = 'sheets-color-swatch' + (key === currentKey ? ' selected' : '');
    sw.style.background = SHEETS_COLORS[key];
    sw.title = key;
    sw.addEventListener('click', () => { close(); onSelect(key); });
    pop.appendChild(sw);
  }
  const close = siteOpenFieldPopup(anchor, pop);
}

function sheetsToggleFormat(key) {
  if (!sheetState.selected) return;
  const { r, c } = sheetState.selected;
  const cell = sheetsEnsureCell(r, c);
  cell[key] = !cell[key];
  sheetsMarkDirty();
  sheetsRerenderCellByCoord(r, c);
  sheetsUpdateToolbarState();
}

function sheetsSetAlign(value) {
  if (!sheetState.selected) return;
  const { r, c } = sheetState.selected;
  const cell = sheetsEnsureCell(r, c);
  cell.align = cell.align === value ? null : value;
  sheetsMarkDirty();
  sheetsRerenderCellByCoord(r, c);
  sheetsUpdateToolbarState();
}

function sheetsSetColor(kind, key) {
  if (!sheetState.selected) return;
  const { r, c } = sheetState.selected;
  const cell = sheetsEnsureCell(r, c);
  cell[kind] = key;
  sheetsMarkDirty();
  sheetsRerenderCellByCoord(r, c);
  sheetsUpdateToolbarState();
}

// ── Reshape actions ────────────────────────────────────────────
function sheetsInsertColumn() {
  if (sheetState.cols >= SHEETS_MAX_COLS) return;
  const at = sheetState.selected ? sheetState.selected.c + 1 : sheetState.cols;
  sheetState.cells = sheetsReindexCells(sheetState.cells, 'col', at, 1);
  sheetState.cols += 1;
  if (sheetState.selected) sheetState.selected.c = at;
  sheetsMarkDirty();
  sheetsRenderGridTable();
  sheetsUpdateToolbarState();
}

function sheetsDeleteColumn() {
  if (sheetState.cols <= 1) return;
  const at = sheetState.selected ? sheetState.selected.c : sheetState.cols - 1;
  sheetState.cells = sheetsReindexCells(sheetState.cells, 'col', at, -1);
  sheetState.cols -= 1;
  if (sheetState.selected) sheetState.selected.c = Math.min(sheetState.selected.c, sheetState.cols - 1);
  sheetsMarkDirty();
  sheetsRenderGridTable();
  sheetsUpdateToolbarState();
}

function sheetsInsertRow() {
  if (sheetState.rows >= SHEETS_MAX_ROWS) return;
  const at = sheetState.selected ? sheetState.selected.r + 1 : sheetState.rows;
  sheetState.cells = sheetsReindexCells(sheetState.cells, 'row', at, 1);
  sheetState.rows += 1;
  if (sheetState.selected) sheetState.selected.r = at;
  sheetsMarkDirty();
  sheetsRenderGridTable();
  sheetsUpdateToolbarState();
}

function sheetsDeleteRow() {
  if (sheetState.rows <= 1) return;
  const at = sheetState.selected ? sheetState.selected.r : sheetState.rows - 1;
  sheetState.cells = sheetsReindexCells(sheetState.cells, 'row', at, -1);
  sheetState.rows -= 1;
  if (sheetState.selected) sheetState.selected.r = Math.min(sheetState.selected.r, sheetState.rows - 1);
  sheetsMarkDirty();
  sheetsRenderGridTable();
  sheetsUpdateToolbarState();
}

// ── Grid table (full rebuild on structural change — mirrors schedule.js's
// renderGrid() convention; single-cell edits patch just that <td>) ──
function sheetsRenderGridTable() {
  sheetState.editingTd = null;
  const wrap = sheetState.gridWrap;
  wrap.replaceChildren();
  const table = el('table', 'sheets-table');

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'sheets-corner'));
  for (let c = 0; c < sheetState.cols; c++) headRow.appendChild(el('th', 'sheets-col-head', sheetsIndexToColLetter(c)));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (let r = 0; r < sheetState.rows; r++) {
    const tr = el('tr');
    tr.appendChild(el('td', 'sheets-row-head', String(r + 1)));
    for (let c = 0; c < sheetState.cols; c++) {
      const td = el('td', 'sheets-cell');
      td.dataset.r = String(r);
      td.dataset.c = String(c);
      sheetsRenderCellDisplay(td, r, c);
      td.addEventListener('click', () => sheetsSelectCell(r, c, td));
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  sheetsHighlightSelected();
}

function sheetsRenderCellDisplay(td, r, c) {
  const key = r + '_' + c;
  const cell = sheetState.cells[key];
  td.textContent = sheetsEvalCell(sheetState.cells, r, c, new Set());
  td.classList.toggle('sheets-bold', !!(cell && cell.bold));
  td.classList.toggle('sheets-italic', !!(cell && cell.italic));
  td.classList.toggle('sheets-underline', !!(cell && cell.underline));
  td.style.textAlign = cell && cell.align ? cell.align : '';
  td.style.background = cell && cell.bg ? SHEETS_COLORS[cell.bg] : '';
  td.style.color = cell && cell.color ? SHEETS_COLORS[cell.color] : '';
}

function sheetsRerenderCellByCoord(r, c) {
  const td = sheetState.gridWrap.querySelector(`td.sheets-cell[data-r="${r}"][data-c="${c}"]`);
  if (td && !td.classList.contains('sheets-editing')) sheetsRenderCellDisplay(td, r, c);
}

function sheetsHighlightSelected() {
  sheetState.gridWrap.querySelectorAll('td.sheets-cell').forEach((td) => {
    const r = Number(td.dataset.r);
    const c = Number(td.dataset.c);
    td.classList.toggle('sheets-selected', !!sheetState.selected && sheetState.selected.r === r && sheetState.selected.c === c);
  });
}

function sheetsSelectCell(r, c, td) {
  if (r < 0 || c < 0 || r >= sheetState.rows || c >= sheetState.cols) return;
  if (sheetState.editingTd && sheetState.editingTd !== td) sheetsExitEditMode(sheetState.editingTd, true);
  sheetState.selected = { r, c };
  sheetsHighlightSelected();
  sheetsUpdateToolbarState();
  const targetTd = td || sheetState.gridWrap.querySelector(`td.sheets-cell[data-r="${r}"][data-c="${c}"]`);
  if (targetTd) sheetsEnterEditMode(targetTd, r, c);
}

function sheetsMoveSelection(r, c) {
  sheetsSelectCell(r, c, null);
}

function sheetsEnterEditMode(td, r, c) {
  if (td.classList.contains('sheets-editing')) return;
  td.classList.add('sheets-editing');
  sheetState.editingTd = td;
  const key = r + '_' + c;
  const cell = sheetState.cells[key];
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'sheets-cell-input';
  input.maxLength = 2000;
  input.value = cell ? cell.value : '';
  td.textContent = '';
  td.appendChild(input);
  input.focus();
  input.select();
  // Committed live on every keystroke (not just on blur/Enter) so a
  // toolbar click's mousedown-preventDefault (see noStealFocus) never
  // risks losing what's been typed so far.
  input.addEventListener('input', () => {
    sheetsEnsureCell(r, c).value = input.value;
    sheetsMarkDirty();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); sheetsExitEditMode(td, true); sheetsMoveSelection(r + 1, c); }
    else if (e.key === 'Escape') { e.preventDefault(); sheetsExitEditMode(td, true); }
    else if (e.key === 'Tab') { e.preventDefault(); sheetsExitEditMode(td, true); sheetsMoveSelection(r, c + (e.shiftKey ? -1 : 1)); }
  });
  input.addEventListener('blur', () => sheetsExitEditMode(td, true));
}

function sheetsExitEditMode(td, rerender) {
  if (!td.classList.contains('sheets-editing')) return;
  td.classList.remove('sheets-editing');
  if (sheetState.editingTd === td) sheetState.editingTd = null;
  if (rerender) sheetsRenderCellDisplay(td, Number(td.dataset.r), Number(td.dataset.c));
}

// ── Save ───────────────────────────────────────────────────────
async function sheetsSaveCurrent() {
  if (!sheetState || sheetState.savingInFlight) return;
  sheetState.savingInFlight = true;
  if (sheetState.toolbar) sheetState.toolbar.saveBtn.disabled = true;
  sheetsUpdateStatus('Gemmer …');
  const payload = {
    id: sheetState.id, name: sheetState.name, rows: sheetState.rows, cols: sheetState.cols, cells: sheetState.cells,
  };
  const result = await sheetsApi('sheets_save', payload);
  sheetState.savingInFlight = false;
  if (sheetState.toolbar) sheetState.toolbar.saveBtn.disabled = false;
  if (!sheetState) return; // the user navigated away while the save was in flight
  if (result.ok) {
    sheetState.id = result.data.sheet.id;
    sheetState.dirty = false;
    sheetsUpdateStatus('Gemt.');
  } else if (result.message) {
    sheetsUpdateStatus(result.message, true);
  } else {
    sheetsUpdateStatus();
  }
}

// ── Entry point ────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('sheets-root');
  if (root) renderSheetsList(root);
});
