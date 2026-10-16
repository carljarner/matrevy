/* =========================================================
   Matematikrevyen – Kostumetinder (kostumetinder.html)

   A shared costume sheet for the current revy, styled like Bandet's
   Sangoversigt (no sections, just rows): what someone needs ("Jeg
   mangler"), for which scene, their name, who has it ("Jeg har det"), and
   a note. Columns can be renamed, resized, removed and added, rows
   reordered by their handle.

   One sheet per revy, always the current production's — the server
   resolves the folder itself (kostume_* actions, private
   KOSTUME_DATA_DIR store, since the sheet carries names). A revy without
   a sheet yet reads as 10 blank rows with stable ids; the topmost empty
   row's cells show example hints as placeholders.

   Live writes like Bandet: a text cell commits on blur, a reorder on
   drop — each a row-granular server merge, so several people can edit at
   once. Fully open at the revyst tier.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helpers (mirror band.js's own) ─────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Second-level button, for buttons inside a modal overlay only.
function kostumePillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

function kostumeAddPlusBtn(title) {
  const btn = el('button', 'boss-manage-add-plus', '+');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

function kostumeRemoveBtn(title) {
  const btn = el('button', 'kostume-remove-btn', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

// ── Authenticated API (mirrors band.js's bandApi) ────────────
function kostumeResolvePassword() {
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

function kostumeMapError(status, detail) {
  if (detail === 'no_production') return 'Der er ingen aktiv revy lige nu.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet — en anden har måske lige slettet den. Genindlæs siden.';
  if (status === 409) return 'Nogen andre har lige ændret arket. Genindlæser…';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, status, detail, message } —
// message '' = cancelled password prompt (silent no-op).
async function kostumeApi(action, body) {
  const password = kostumeResolvePassword();
  if (!password) return { ok: false, status: 0, detail: '', message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...(body || {}) }),
    });
  } catch (e) {
    return { ok: false, status: 0, detail: '', message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  // Require a real {ok:true} JSON body — a PHP fatal or WAF page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, detail, message: kostumeMapError(res.status, detail) };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, detail, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── State ────────────────────────────────────────────────────
// `width` = default px; `hint` = the topmost empty row's example placeholder.
const KOSTUME_COLUMNS = [
  { key: 'jegMangler', label: 'Jeg mangler', width: 180, hint: 'Det du skal bruge' },
  { key: 'scene', label: 'Sang/sketch', width: 170, hint: 'Til hvilken scene' },
  { key: 'navn', label: 'Navn', width: 150, hint: 'Dit eget navn' },
  { key: 'jegHarDet', label: 'Jeg har det', width: 180, hint: 'Navn på dig, der har det' },
  { key: 'note', label: 'Note', width: 170, hint: '' },
  { key: 'status', label: 'Status', width: 110, hint: '', status: true },
];

// The status toggle's cycle; '' (Søger) is the default. Mirrors
// kostume_status_values() in update-data.php.
const KOSTUME_STATUSES = [
  { value: '', label: 'Søger', cls: 'kostume-status-soeger' },
  { value: 'laant', label: 'Lånt', cls: 'kostume-status-laant' },
  { value: 'returneret', label: 'Returneret', cls: 'kostume-status-returneret' },
];
const KOSTUME_HANDLE_COL_WIDTH = 26;
const KOSTUME_ACTIONS_COL_WIDTH = 40;
const KOSTUME_MIN_COL_WIDTH = 48;
const KOSTUME_CUSTOM_COL_WIDTH = 140;
const KOSTUME_CUSTOM_KEY_RE = /^c[0-9a-f]{8,40}$/; // mirrors kostume_custom_key_valid()
const KOSTUME_LOCKED_COLUMN = 'jegMangler'; // mirrors kostume_locked_column()

let kostumeState = null; // { rows, columnLabels, columnWidths, customColumns, hiddenColumns }
let kostumeDragRow = null;

// Visible built-ins plus the custom columns, placed before Status so it
// stays rightmost.
function kostumeSheetColumns() {
  const hidden = new Set(kostumeState.hiddenColumns);
  const cols = KOSTUME_COLUMNS.filter((c) => !hidden.has(c.key));
  const custom = kostumeState.customColumns.map((c) => ({
    key: c.key, label: c.label, width: KOSTUME_CUSTOM_COL_WIDTH, hint: '', custom: true,
  }));
  const status = cols.findIndex((c) => c.status);
  cols.splice(status === -1 ? cols.length : status, 0, ...custom);
  return cols;
}

// Every value key a row can carry (hidden ones included, so a draft keeps
// them and a row with only hidden content still counts).
function kostumeAllValueKeys() {
  return [...KOSTUME_COLUMNS.map((c) => c.key), ...kostumeState.customColumns.map((c) => c.key)];
}

function kostumeRowHasContent(row) {
  return kostumeAllValueKeys().some((key) => (row[key] || '').trim() !== '');
}

function kostumeRowLabel(row) {
  return (row.jegMangler || '').trim() || 'Række';
}

// ── Load + render ────────────────────────────────────────────
function kostumeRoot() {
  return document.getElementById('kostume-root');
}

async function kostumeLoad() {
  const root = kostumeRoot();
  root.replaceChildren(el('p', 'kostume-muted', 'Indlæser…'));
  const result = await kostumeApi('kostume_read', {});
  if (!result.ok) {
    const card = el('section', 'card');
    const message = result.detail === 'no_production'
      ? 'Der er ingen aktiv revy lige nu — arket kommer, når en ny revy er startet.'
      : (result.message || 'Kunne ikke indlæse arket.');
    card.appendChild(el('p', result.detail === 'no_production' ? 'kostume-muted' : 'kostume-error', message));
    root.replaceChildren(card);
    return;
  }
  const labels = result.data.columnLabels;
  const widths = result.data.columnWidths;
  kostumeState = {
    rows: result.data.rows || [],
    // An empty PHP map can arrive as [] — always keep a plain object.
    columnLabels: (labels && !Array.isArray(labels)) ? labels : {},
    columnWidths: (widths && !Array.isArray(widths)) ? widths : {},
    customColumns: result.data.customColumns || [],
    hiddenColumns: result.data.hiddenColumns || [],
  };
  kostumeRender();
}

function kostumeRender() {
  const root = kostumeRoot();
  root.replaceChildren();
  if (!kostumeState) return;
  const card = el('section', 'card');
  const wrap = el('div', 'kostume-table-wrap');
  wrap.appendChild(kostumeBuildSheetTable());
  card.appendChild(wrap);
  const addRow = kostumeAddPlusBtn('Tilføj række');
  addRow.classList.add('kostume-add-row');
  addRow.addEventListener('click', () => kostumeAddDraftRow(card));
  card.appendChild(addRow);
  root.appendChild(card);
}

function kostumeShowError(message) {
  if (!message) return;
  siteShowToast(message);
}

// A 409/404 means the page is out of date — reload rather than keep
// editing a stale copy.
function kostumeHandleFailure(result) {
  kostumeShowError(result.message);
  if (result.status === 409 || result.status === 404) kostumeLoad();
}

// ── The sheet ────────────────────────────────────────────────
// Fixed table layout driven by a <colgroup>, so a dragged width is exact
// and the other columns don't shift to absorb it.
function kostumeBuildSheetTable() {
  const table = el('table', 'kostume-table');
  const colgroup = el('colgroup');
  const cols = {};
  const addCol = (key, width) => {
    const c = el('col');
    c.style.width = `${width}px`;
    colgroup.appendChild(c);
    if (key) cols[key] = c;
  };
  const columns = kostumeSheetColumns();
  addCol(null, KOSTUME_HANDLE_COL_WIDTH);
  for (const col of columns) addCol(col.key, kostumeColumnWidth(col));
  addCol(null, KOSTUME_ACTIONS_COL_WIDTH);
  table.appendChild(colgroup);
  kostumeUpdateSheetWidth(table);

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'kostume-col-handle'));
  for (const col of columns) {
    const th = el('th', col.status ? 'kostume-col-resizable kostume-col-status' : 'kostume-col-resizable');
    // Clearing the title and pressing Backspace/Delete once more asks to
    // remove the column ("Jeg mangler" excepted).
    const onDeleteEmpty = col.key === KOSTUME_LOCKED_COLUMN ? null : () => kostumeRemoveColumn(col);
    th.appendChild(kostumeColumnTitleInput(col.key, col.label, onDeleteEmpty));
    th.appendChild(kostumeColumnResizer(col, cols[col.key], table));
    headRow.appendChild(th);
  }
  const addTh = el('th', 'kostume-col-actions');
  const addColBtn = kostumeAddPlusBtn('Tilføj kolonne');
  addColBtn.addEventListener('click', kostumeOpenAddColumnModal);
  addTh.appendChild(addColBtn);
  headRow.appendChild(addTh);
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  kostumeState.rows.forEach((row) => tbody.appendChild(kostumeRenderRow(row)));
  tbody.appendChild(kostumeBuildDropTail());
  table.appendChild(tbody);
  kostumeRefreshHints(tbody);
  return table;
}

function kostumeCreateTextInput(row, key, tr) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'kostume-field';
  input.dataset.key = key;
  input.value = row[key] || '';
  // Typing into the hinted row moves the hints on to the next empty one.
  input.addEventListener('input', () => kostumeRefreshHints(tr.parentNode));
  input.addEventListener('blur', () => {
    if ((row[key] || '') === input.value && row.id !== null) return;
    row[key] = input.value;
    kostumeCommitRow(row, { [key]: input.value }, tr);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') input.blur();
  });
  return input;
}

// Click to cycle Søger → Lånt → Returneret; commits right away.
function kostumeStatusToggle(row, key, tr) {
  const btn = el('button', 'kostume-status');
  btn.type = 'button';
  function paint() {
    const meta = KOSTUME_STATUSES.find((st) => st.value === (row[key] || '')) || KOSTUME_STATUSES[0];
    btn.className = 'kostume-status ' + meta.cls;
    btn.textContent = meta.label;
    btn.title = `${meta.label} — klik for at skifte`;
  }
  paint();
  btn.addEventListener('click', () => {
    const idx = KOSTUME_STATUSES.findIndex((st) => st.value === (row[key] || ''));
    row[key] = KOSTUME_STATUSES[(idx + 1) % KOSTUME_STATUSES.length].value;
    paint();
    kostumeCommitRow(row, { [key]: row[key] }, tr);
  });
  return btn;
}

// The columns a row must have filled in before the example hints move on
// (a hidden one is skipped).
const KOSTUME_HINT_REQUIRED = ['jegMangler', 'scene', 'navn'];

// The example hints sit on the topmost row that doesn't yet have Jeg
// mangler, Sang/sketch and Navn all filled in (by what's typed right now),
// so they move down as rows are completed and back up when one is cleared.
function kostumeRefreshHints(tbody) {
  if (!tbody) return;
  const hints = Object.fromEntries(KOSTUME_COLUMNS.map((c) => [c.key, c.hint]));
  let hinted = false;
  for (const tr of tbody.querySelectorAll('tr.kostume-row')) {
    const inputs = Array.from(tr.querySelectorAll('input.kostume-field'));
    const complete = inputs
      .filter((i) => KOSTUME_HINT_REQUIRED.includes(i.dataset.key))
      .every((i) => i.value.trim() !== '');
    const target = !complete && !hinted;
    if (target) hinted = true;
    for (const input of inputs) input.placeholder = target ? (hints[input.dataset.key] || '') : '';
  }
}

function kostumeRenderRow(row) {
  const tr = el('tr', 'kostume-row');
  tr._row = row;
  const handleTd = el('td', 'kostume-col-handle');
  const handle = el('span', 'boss-manage-drag-handle kostume-drag-handle', '⠿');
  handle.title = 'Træk for at flytte';
  handleTd.appendChild(handle);
  tr.appendChild(handleTd);
  kostumeWireRowDrag(tr, handle, row);

  for (const col of kostumeSheetColumns()) {
    const td = el('td', col.status ? 'kostume-col-status' : null);
    td.appendChild(col.status ? kostumeStatusToggle(row, col.key, tr) : kostumeCreateTextInput(row, col.key, tr));
    tr.appendChild(td);
  }
  const actions = el('td', 'kostume-col-actions');
  const removeBtn = kostumeRemoveBtn('Slet række');
  removeBtn.addEventListener('click', () => kostumeDeleteRow(row, tr));
  actions.appendChild(removeBtn);
  tr.appendChild(actions);
  return tr;
}

// Adds an unsaved row at the end; it's created server-side on the first
// blur that leaves it non-empty (an abandoned "+" leaves nothing behind).
function kostumeAddDraftRow(card) {
  const row = { id: null };
  kostumeAllValueKeys().forEach((key) => { row[key] = ''; });
  const tbody = card.querySelector('.kostume-table tbody');
  const tr = kostumeRenderRow(row);
  tr.classList.add('kostume-draft-row');
  tbody.insertBefore(tr, tbody.querySelector('.kostume-drop-tail-row'));
  kostumeRefreshHints(tbody);
  const first = tr.querySelector('input');
  if (first) first.focus();
}

// Commits `fields` of one row. A draft row is created with all its current
// fields; commits on the same row are serialized via row._inFlight so two
// quick blurs on a draft can't create it twice.
async function kostumeCommitRow(row, fields, tr) {
  if (row.id === null && !kostumeRowHasContent(row)) return;
  if (row._inFlight) await row._inFlight;
  const isNew = row.id === null;
  let body;
  if (isNew) {
    const payload = {};
    kostumeAllValueKeys().forEach((key) => { payload[key] = row[key] || ''; });
    body = { row: payload };
  } else {
    body = { row: { id: row.id, ...fields } };
  }
  const promise = kostumeApi('kostume_upsert_row', body);
  row._inFlight = promise;
  const result = await promise;
  row._inFlight = null;
  if (!result.ok) {
    kostumeHandleFailure(result);
    return;
  }
  if (isNew) {
    row.id = result.data.row.id;
    if (tr) tr.classList.remove('kostume-draft-row');
    kostumeState.rows.push(row);
  }
}

function kostumeDeleteRow(row, tr) {
  if (row.id === null) {
    const tbody = tr.parentNode;
    tr.remove();
    kostumeRefreshHints(tbody);
    return;
  }
  const remove = async () => {
    const result = await kostumeApi('kostume_delete_row', { rowId: row.id });
    if (!result.ok) { kostumeShowError(result.message); return false; }
    kostumeState.rows = kostumeState.rows.filter((r) => r !== row);
    kostumeRender();
    return true;
  };
  // An empty row goes without asking.
  if (!kostumeRowHasContent(row)) { remove(); return; }
  kostumeConfirm(`Slet "${kostumeRowLabel(row)}"?`, 'Dette kan ikke fortrydes.', 'Slet', remove);
}

// Styled "Er du sikker?" overlay. onConfirm returns false to keep the modal
// open (e.g. on a failed request).
function kostumeConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('kostume-confirm-modal');
  if (description) form.appendChild(el('p', 'kostume-confirm-text', description));
  const cancelBtn = kostumePillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = kostumePillBtn(confirmLabel, 'site-btn-danger');
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
function kostumeBuildDropTail() {
  const tr = el('tr', 'kostume-drop-tail-row');
  const td = el('td');
  td.colSpan = kostumeSheetColumns().length + 2;
  tr.appendChild(td);
  kostumeWireDropHighlight(tr, () => kostumeMoveRow(kostumeDragRow, null));
  return tr;
}

// Only the handle starts a drag — a draggable row would swallow text
// selection inside its inputs.
function kostumeWireRowDrag(tr, handle, row) {
  handle.addEventListener('mousedown', () => { tr.draggable = row.id !== null; });
  handle.addEventListener('touchstart', () => { tr.draggable = row.id !== null; }, { passive: true });
  tr.addEventListener('dragstart', (e) => {
    kostumeDragRow = row;
    e.dataTransfer.effectAllowed = 'move';
    const ghost = kostumeGetDragImageEl();
    ghost.textContent = kostumeRowLabel(row);
    e.dataTransfer.setDragImage(ghost, 12, 16);
  });
  tr.addEventListener('dragend', () => {
    tr.draggable = false;
    kostumeDragRow = null;
  });
  // A draft row isn't in kostumeState.rows yet, so it can't be a drop anchor.
  kostumeWireDropHighlight(tr, () => { if (row.id !== null) kostumeMoveRow(kostumeDragRow, row); });
}

function kostumeGetDragImageEl() {
  let ghost = document.getElementById('kostume-drag-image');
  if (!ghost) {
    ghost = el('div', 'kostume-drag-image');
    ghost.id = 'kostume-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// Duplicated from band.js's bandWireDropHighlight.
function kostumeWireDropHighlight(rowEl, onDrop) {
  let depth = 0;
  rowEl.addEventListener('dragenter', (e) => {
    if (!kostumeDragRow) return;
    e.preventDefault();
    depth++;
    rowEl.classList.add('kostume-drop-target');
  });
  rowEl.addEventListener('dragover', (e) => { if (kostumeDragRow) e.preventDefault(); });
  rowEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) rowEl.classList.remove('kostume-drop-target');
  });
  rowEl.addEventListener('drop', (e) => {
    if (!kostumeDragRow) return;
    e.preventDefault();
    depth = 0;
    rowEl.classList.remove('kostume-drop-target');
    onDrop();
  });
}

// Moves `item` to just before `target` (null = the end), optimistically,
// then sends the full id order.
async function kostumeMoveRow(item, target) {
  if (!item || item === target || item.id === null) return;
  const rows = kostumeState.rows;
  const previous = rows.slice();
  const from = rows.indexOf(item);
  if (from === -1) return;
  rows.splice(from, 1);
  const to = target ? rows.indexOf(target) : rows.length;
  rows.splice(to === -1 ? rows.length : to, 0, item);
  if (rows.every((r, i) => r === previous[i])) return;
  kostumeRender();
  const result = await kostumeApi('kostume_reorder', { order: rows.map((r) => r.id) });
  if (!result.ok) {
    kostumeState.rows = previous;
    kostumeRender();
    kostumeHandleFailure(result);
  }
}

// ── Resizable columns ────────────────────────────────────────
function kostumeColumnWidth(col) {
  const px = kostumeState.columnWidths[col.key];
  return Number.isInteger(px) ? px : col.width;
}

function kostumeUpdateSheetWidth(table) {
  const total = KOSTUME_HANDLE_COL_WIDTH + KOSTUME_ACTIONS_COL_WIDTH
    + kostumeSheetColumns().reduce((sum, col) => sum + kostumeColumnWidth(col), 0);
  // Never narrower than the card; wider columns overflow into the scroll.
  table.style.width = `max(100%, ${total}px)`;
}

// A grip on the header's right edge: drag to resize (pointer events, so
// touch works too), double-click to go back to the default width.
function kostumeColumnResizer(col, colEl, table) {
  const grip = el('div', 'kostume-col-resizer');
  grip.title = 'Træk for at ændre bredden — dobbeltklik for standard';
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    grip.classList.add('active');
    const startX = e.clientX;
    const startWidth = kostumeColumnWidth(col);
    const onMove = (ev) => {
      kostumeState.columnWidths[col.key] = Math.max(KOSTUME_MIN_COL_WIDTH, Math.round(startWidth + ev.clientX - startX));
      colEl.style.width = `${kostumeState.columnWidths[col.key]}px`;
      kostumeUpdateSheetWidth(table);
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      grip.classList.remove('active');
      if (kostumeColumnWidth(col) !== startWidth) kostumeSaveColumnWidths();
    };
    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });
  grip.addEventListener('dblclick', () => {
    if (!(col.key in kostumeState.columnWidths)) return;
    delete kostumeState.columnWidths[col.key];
    colEl.style.width = `${col.width}px`;
    kostumeUpdateSheetWidth(table);
    kostumeSaveColumnWidths();
  });
  return grip;
}

let kostumeColumnWidthsInFlight = null;
async function kostumeSaveColumnWidths() {
  if (kostumeColumnWidthsInFlight) await kostumeColumnWidthsInFlight;
  const promise = kostumeApi('kostume_save_column_widths', { columnWidths: { ...kostumeState.columnWidths } });
  kostumeColumnWidthsInFlight = promise;
  const result = await promise;
  kostumeColumnWidthsInFlight = null;
  if (!result.ok) kostumeHandleFailure(result);
}

// ── Adding/removing columns ──────────────────────────────────
// Removing a built-in column only hides it (values kept, it can be added
// back); removing a custom column deletes it with its values.
async function kostumeSaveColumns(customColumns, hiddenColumns) {
  const result = await kostumeApi('kostume_save_columns', { customColumns, hiddenColumns });
  if (!result.ok) { kostumeShowError(result.message); return false; }
  kostumeState.customColumns = result.data.customColumns || [];
  kostumeState.hiddenColumns = result.data.hiddenColumns || [];
  // A deleted custom column's title/width went with it server-side.
  const live = new Set(kostumeAllValueKeys());
  for (const map of [kostumeState.columnLabels, kostumeState.columnWidths]) {
    for (const key of Object.keys(map)) if (KOSTUME_CUSTOM_KEY_RE.test(key) && !live.has(key)) delete map[key];
  }
  kostumeRender();
  return true;
}

function kostumeRemoveColumn(col) {
  const label = kostumeColumnLabel(col.key, col.label);
  const description = col.custom
    ? 'Kolonnen og alt dens indhold slettes. Dette kan ikke fortrydes.'
    : 'Kolonnen skjules. Indholdet gemmes og kommer tilbage, hvis du tilføjer kolonnen igen.';
  kostumeConfirm(`Fjern kolonnen "${label}"?`, description, 'Fjern', () => {
    if (col.custom) {
      return kostumeSaveColumns(kostumeState.customColumns.filter((c) => c.key !== col.key), kostumeState.hiddenColumns);
    }
    return kostumeSaveColumns(kostumeState.customColumns, [...kostumeState.hiddenColumns, col.key]);
  });
}

function kostumeOpenAddColumnModal() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj kolonne');
  modal.classList.add('kostume-column-modal');
  const hidden = KOSTUME_COLUMNS.filter((c) => kostumeState.hiddenColumns.includes(c.key));

  let pick = null;
  if (hidden.length) {
    pick = siteCreateDropdownField([
      { value: '', label: 'Ny kolonne' },
      ...hidden.map((c) => ({ value: c.key, label: `${kostumeColumnLabel(c.key, c.label)} (tidligere fjernet)` })),
    ], '');
    form.appendChild(siteEditField('Kolonne', pick));
  }
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 100;
  nameInput.placeholder = 'Fx Størrelse';
  const nameField = siteEditField('Navn', nameInput);
  form.appendChild(nameField);
  if (pick) {
    pick.addEventListener('change', () => { nameField.hidden = pick.value !== ''; });
  }

  const addBtn = kostumePillBtn('Tilføj', 'site-btn-success');
  async function submit() {
    let ok;
    if (pick && pick.value) {
      addBtn.disabled = true;
      ok = await kostumeSaveColumns(kostumeState.customColumns, kostumeState.hiddenColumns.filter((k) => k !== pick.value));
    } else {
      const label = nameInput.value.trim();
      if (!label) { error.textContent = 'Skriv et navn.'; nameInput.focus(); return; }
      addBtn.disabled = true;
      ok = await kostumeSaveColumns([...kostumeState.customColumns, { label }], kostumeState.hiddenColumns);
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
function kostumeColumnLabel(key, fallback) {
  const label = kostumeState.columnLabels[key];
  return (typeof label === 'string' && label.trim()) ? label : fallback;
}

// Editable text rather than an <input>, so a long title wraps instead of
// being cut off. Read back through textContent only.
// `onDeleteEmpty` (optional): called when Backspace/Delete is pressed on an
// already-empty title — used to offer removing the column.
function kostumeColumnTitleInput(key, fallback, onDeleteEmpty) {
  const title = el('div', 'kostume-head-input', kostumeColumnLabel(key, fallback));
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
      title.textContent = kostumeColumnLabel(key, fallback);
      title.blur();
      onDeleteEmpty();
    }
  });
  title.addEventListener('blur', () => {
    const value = (title.textContent || '').replace(/\s+/g, ' ').trim();
    const next = value && value !== fallback ? value : '';
    const changed = (kostumeState.columnLabels[key] || '') !== next;
    if (next) kostumeState.columnLabels[key] = next;
    else delete kostumeState.columnLabels[key];
    title.textContent = kostumeColumnLabel(key, fallback);
    if (changed) kostumeSaveColumnLabels();
  });
  return title;
}

let kostumeColumnLabelsInFlight = null;
async function kostumeSaveColumnLabels() {
  if (kostumeColumnLabelsInFlight) await kostumeColumnLabelsInFlight;
  const promise = kostumeApi('kostume_save_column_labels', { columnLabels: { ...kostumeState.columnLabels } });
  kostumeColumnLabelsInFlight = promise;
  const result = await promise;
  kostumeColumnLabelsInFlight = null;
  if (!result.ok) kostumeHandleFailure(result);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = kostumeRoot();
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'kostume-muted', 'Kostumetinder kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  kostumeLoad();
});
