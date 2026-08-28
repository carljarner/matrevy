/* =========================================================
   Matematikrevyen – Fællesspisning (faellesspisning.html)

   Communal-meal rehearsal-day sign-up sheet, replacing a manually
   maintained Google Sheet: one row per person, one column per rehearsal
   day (read live from CALENDAR_DATA's "ove"-category events), a checkbox
   marks "eating that day," plus a summary of headcount + food
   preferences per day.

   Same privacy posture as Budget/Forms: names and food preferences never
   touch the public repo / embed pipeline, only the private Simply.com
   store (FAELLESSPISNING_DATA_DIR), via authenticated actions on
   SITE_API_ENDPOINT (site.js).

   One audience for the grid itself (any revyst+ visitor can add/edit/
   delete any row — a fully open shared spreadsheet, no per-row
   ownership); boss additionally gets a "Rediger felter" button to manage
   the extra-question list beyond the hardcoded Navn/Madforbehold.

   Unlike the now-removed "Ark" page's whole-document-replace save, edits
   here are row-granular and commit immediately (on blur/change) — many
   revyster can toggle different rows/days concurrently without a batched
   draft clobbering each other.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helper (mirrors budget.js's/forms.js's el()) ──
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function faellesPillBtn(label, variant) {
  const btn = el('button', 'site-pill-btn' + (variant ? ' ' + variant : ''), label);
  btn.type = 'button';
  return btn;
}

// ── Authenticated API (mirrors forms.js's formsResolvePassword/formsApi) ──
function faellesResolvePassword() {
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

function faellesMapError(status) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. Genindlæs siden og prøv igen.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, message }.
async function faellesApi(action, body) {
  const password = faellesResolvePassword();
  if (!password) return { ok: false, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...(body || {}) }),
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
    const base = faellesMapError(res.status);
    return { ok: false, message: detail ? `${base} (${detail})` : base };
  }
  if (!data || data.ok !== true) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    return { ok: false, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── Fields ────────────────────────────────────────────────────
// Navn/Madforbehold are hardcoded, never part of the boss-editable
// `fields` list stored server-side — the field editor only ever shows
// the extras (mirrors faelles_base_field_ids() in update-data.php).
const FAELLES_BASE_FIELDS = [
  { id: 'navn', label: 'Navn', required: true },
  { id: 'madforbehold', label: 'Madforbehold', required: false },
];

function faellesAllFields() {
  return FAELLES_BASE_FIELDS.concat((faellesState && faellesState.fields) || []);
}

// ── Rehearsal-day columns, derived live from CALENDAR_DATA ──────
// Never stored — mirrors formsOptionsFromRehearsals in js/forms.js, so a
// day column always reflects the current calendar. Compact d/m label
// (not formatDaDateShort's weekday-inclusive form) since the header needs
// many narrow columns — matches the reference spreadsheet's own "8/11"
// style.
function faellesRehearsalColumns() {
  if (typeof CALENDAR_DATA === 'undefined' || !Array.isArray(CALENDAR_DATA)) return [];
  return CALENDAR_DATA
    .filter((ev) => ev.category === 'ove')
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((ev) => {
      const d = (typeof parseIsoDate === 'function') ? parseIsoDate(ev.date) : new Date(ev.date);
      return { id: ev.id, label: `${d.getDate()}/${d.getMonth() + 1}` };
    });
}

// ── State ─────────────────────────────────────────────────────
// One loaded document, live-synced from every successful write's server
// response — not a batched draft (unlike the removed Ark page's
// sheetState), since edits commit individually on blur/change.
let faellesState = null; // { fields, rows, updatedAt } once loaded

function faellesRowHasContent(row) {
  return (row.answers.navn || '').trim() !== '';
}

// ── Load + render ─────────────────────────────────────────────
async function faellesLoad(root) {
  root.replaceChildren();
  root.appendChild(el('p', 'faelles-count', 'Indlæser…'));
  const result = await faellesApi('faelles_read', {});
  if (!result.ok) {
    root.replaceChildren();
    const card = el('section', 'card');
    card.appendChild(el('p', 'faelles-error', result.message || 'Kunne ikke indlæse Fællesspisning.'));
    root.appendChild(card);
    return;
  }
  faellesState = { fields: result.data.fields || [], rows: result.data.rows || [], updatedAt: result.data.updatedAt || null };
  faellesRender(root);
}

function faellesRender(root) {
  root.replaceChildren();
  if (!faellesState) return;

  const card = el('section', 'card');

  const toolbar = el('div', 'faelles-toolbar');
  toolbar.appendChild(el('div', 'faelles-count', `${faellesState.rows.length} tilmeldt${faellesState.rows.length === 1 ? '' : 'e'}`));
  const actions = el('div', 'faelles-toolbar-actions');
  if (typeof siteHasLevel === 'function' && siteHasLevel('boss')) {
    const editFieldsBtn = faellesPillBtn('Rediger felter');
    editFieldsBtn.addEventListener('click', () => faellesOpenFieldEditor(root));
    actions.appendChild(editFieldsBtn);
  }
  const refreshBtn = faellesPillBtn('Opdater');
  refreshBtn.addEventListener('click', () => faellesLoad(root));
  actions.appendChild(refreshBtn);
  toolbar.appendChild(actions);
  card.appendChild(toolbar);

  card.appendChild(el('div', 'faelles-error'));

  const wrap = el('div', 'faelles-table-wrap');
  wrap.appendChild(faellesBuildTable());
  card.appendChild(wrap);

  card.appendChild(el('p', 'faelles-summary-note',
    'Madforbehold-rækken er en simpel optælling af den fritekst, folk selv har skrevet — ikke en automatisk kategorisering.'));

  root.appendChild(card);
}

function faellesBuildTable() {
  const columns = faellesRehearsalColumns();
  const fields = faellesAllFields();

  const table = el('table', 'faelles-table');

  const thead = el('thead');
  const headRow = el('tr');
  for (const f of fields) {
    headRow.appendChild(el('th', 'faelles-col-field', f.label));
  }
  for (const col of columns) {
    headRow.appendChild(el('th', 'faelles-col-day', col.label));
  }
  headRow.appendChild(el('th', '', ''));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of faellesState.rows) {
    tbody.appendChild(faellesRenderRow(row, fields, columns));
  }
  const addRow = el('tr', 'faelles-add-row');
  const addCell = el('td');
  addCell.colSpan = fields.length + columns.length + 1;
  const addBtn = faellesPillBtn('+ Tilføj række');
  addBtn.addEventListener('click', () => {
    const draft = { id: null, answers: {}, days: [] };
    for (const f of fields) draft.answers[f.id] = '';
    const tr = faellesRenderRow(draft, fields, columns);
    tbody.insertBefore(tr, addRow);
    const firstInput = tr.querySelector('input[type="text"]');
    if (firstInput) firstInput.focus();
  });
  addCell.appendChild(addBtn);
  addRow.appendChild(addCell);
  tbody.appendChild(addRow);
  table.appendChild(tbody);

  const summary = faellesBuildSummaryBody(columns);
  table.appendChild(summary);

  return table;
}

function faellesRenderRow(row, fields, columns) {
  const tr = el('tr');

  for (const f of fields) {
    const td = el('td', 'faelles-col-field');
    const input = document.createElement('input');
    input.type = 'text';
    input.value = row.answers[f.id] || '';
    if (f.required) input.placeholder = 'Påkrævet';
    input.addEventListener('blur', () => {
      const value = input.value;
      if (row.answers[f.id] === value && row.id !== null) return;
      row.answers[f.id] = value;
      faellesCommitRow(row, tr);
    });
    td.appendChild(input);
    tr.appendChild(td);
  }

  for (const col of columns) {
    const td = el('td', 'faelles-col-day');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = row.days.includes(col.id);
    cb.addEventListener('change', () => {
      if (cb.checked) {
        if (!row.days.includes(col.id)) row.days.push(col.id);
      } else {
        row.days = row.days.filter((d) => d !== col.id);
      }
      faellesCommitRow(row, tr);
    });
    td.appendChild(cb);
    tr.appendChild(td);
  }

  const removeTd = el('td');
  const removeBtn = el('button', 'faelles-remove-btn', '✕');
  removeBtn.type = 'button';
  removeBtn.title = 'Fjern række';
  removeBtn.addEventListener('click', () => faellesDeleteRow(row, tr));
  removeTd.appendChild(removeBtn);
  tr.appendChild(removeTd);

  return tr;
}

// Commits the row's current in-memory answers/days to the server. A brand
// new (id === null) row with an empty Navn is a no-op — an abandoned "+
// Tilføj række" click must leave nothing behind server-side. Commits on
// the same row are serialized via row._inFlight — without this, blurring
// two fields on the same still-unsaved row in quick succession could fire
// two concurrent "create" requests and produce a duplicate row.
async function faellesCommitRow(row, tr) {
  if (row.id === null && !faellesRowHasContent(row)) return;
  if (row._inFlight) await row._inFlight;
  const body = { answers: row.answers, days: row.days };
  if (row.id !== null) body.rowId = row.id;
  const promise = faellesApi('faelles_upsert_row', body);
  row._inFlight = promise;
  const result = await promise;
  row._inFlight = null;
  const errorBox = document.querySelector('.faelles-error');
  if (!result.ok) {
    if (errorBox && result.message) errorBox.textContent = result.message;
    return;
  }
  if (errorBox) errorBox.textContent = '';
  const wasNew = row.id === null;
  row.id = result.data.row.id;
  row.answers = result.data.row.answers;
  row.days = result.data.row.days;
  if (wasNew) faellesState.rows.push(row);
  faellesRefreshSummary(tr);
}

async function faellesDeleteRow(row, tr) {
  if (row.id === null) {
    tr.remove();
    return;
  }
  if (!confirm('Fjern denne række permanent?')) return;
  const result = await faellesApi('faelles_delete_row', { rowId: row.id });
  const errorBox = document.querySelector('.faelles-error');
  if (!result.ok) {
    if (errorBox && result.message) errorBox.textContent = result.message;
    return;
  }
  if (errorBox) errorBox.textContent = '';
  faellesState.rows = faellesState.rows.filter((r) => r !== row);
  faellesRefreshSummary(tr);
  tr.remove();
}

// Re-renders just the summary tbody + the "N tilmeldte" count, without
// touching the rest of the table (so in-progress edits elsewhere in the
// grid never lose focus/state).
function faellesRefreshSummary(tr) {
  const table = tr.closest('table');
  const root = tr.closest('#faelles-root');
  if (root) {
    const countEl = root.querySelector('.faelles-count');
    if (countEl) countEl.textContent = `${faellesState.rows.length} tilmeldt${faellesState.rows.length === 1 ? '' : 'e'}`;
  }
  if (!table) return;
  const oldSummary = table.querySelector('tbody.faelles-summary');
  const newSummary = faellesBuildSummaryBody(faellesRehearsalColumns());
  if (oldSummary) oldSummary.replaceWith(newSummary);
  else table.appendChild(newSummary);
}

// Computed client-side from faellesState.rows — no server round-trip.
function faellesBuildSummaryBody(columns) {
  const tbody = el('tbody', 'faelles-summary');
  const fieldsColSpan = faellesAllFields().length - 1; // leaves room for the row label in the last field column

  const countRow = el('tr');
  countRow.appendChild(el('th', '', 'Samlet antal i dag'));
  if (fieldsColSpan > 0) {
    const spacer = el('td');
    spacer.colSpan = fieldsColSpan;
    countRow.appendChild(spacer);
  }
  for (const col of columns) {
    const count = faellesState.rows.filter((r) => r.days.includes(col.id)).length;
    countRow.appendChild(el('td', '', String(count)));
  }
  countRow.appendChild(el('td'));
  tbody.appendChild(countRow);

  const prefRow = el('tr');
  prefRow.appendChild(el('th', '', 'Madforbehold'));
  if (fieldsColSpan > 0) {
    const spacer = el('td');
    spacer.colSpan = fieldsColSpan;
    prefRow.appendChild(spacer);
  }
  for (const col of columns) {
    const attendees = faellesState.rows.filter((r) => r.days.includes(col.id));
    prefRow.appendChild(el('td', 'faelles-summary-prefs', faellesSummarizePreferences(attendees)));
  }
  prefRow.appendChild(el('td'));
  tbody.appendChild(prefRow);

  return tbody;
}

// Groups non-empty Madforbehold values (trimmed, case-insensitive) among a
// list of rows and renders them as "Vegetar (2), Nøddeallergi (1)". A
// deliberate simplification vs. the old spreadsheet's manually-curated
// pescetar/vegetar/vegan category counts — free text can't be reliably
// auto-classified into fixed diet buckets without a field-type picker,
// which this feature's scope leaves out.
function faellesSummarizePreferences(rows) {
  const counts = new Map(); // lowercased -> { label, count }
  for (const r of rows) {
    const raw = (r.answers.madforbehold || '').trim();
    if (!raw) continue;
    const key = raw.toLowerCase();
    const entry = counts.get(key);
    if (entry) entry.count += 1;
    else counts.set(key, { label: raw, count: 1 });
  }
  if (counts.size === 0) return '–';
  return Array.from(counts.values())
    .sort((a, b) => b.count - a.count)
    .map((e) => `${e.label} (${e.count})`)
    .join(', ');
}

// ── Boss field editor ─────────────────────────────────────────
function faellesOpenFieldEditor(root) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Rediger felter');
  modal.classList.add('faelles-field-modal');

  form.appendChild(el('p', 'faelles-summary-note', 'Navn og Madforbehold er altid med. Tilføj eventuelle ekstra spørgsmål her.'));

  const list = el('div');
  form.appendChild(list);

  // Working copy — {id, label, required}[]; ids only assigned server-side
  // on save for genuinely new fields (a blank client-side id here just
  // marks "not yet saved").
  const draft = (faellesState.fields || []).map((f) => ({ id: f.id, label: f.label, required: !!f.required }));

  function renderList() {
    list.replaceChildren();
    draft.forEach((f, idx) => {
      const row = el('div', 'faelles-field-row');
      const input = document.createElement('input');
      input.type = 'text';
      input.placeholder = 'Spørgsmål';
      input.value = f.label;
      input.addEventListener('input', () => { f.label = input.value; });
      row.appendChild(input);

      const reqLabel = document.createElement('label');
      const reqCb = document.createElement('input');
      reqCb.type = 'checkbox';
      reqCb.checked = f.required;
      reqCb.addEventListener('change', () => { f.required = reqCb.checked; });
      reqLabel.appendChild(reqCb);
      reqLabel.appendChild(document.createTextNode('Påkrævet'));
      row.appendChild(reqLabel);

      const removeBtn = el('button', 'faelles-remove-btn', '✕');
      removeBtn.type = 'button';
      removeBtn.addEventListener('click', () => {
        draft.splice(idx, 1);
        renderList();
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
    });
  }
  renderList();

  const addBtn = faellesPillBtn('+ Tilføj felt');
  addBtn.classList.add('faelles-field-add');
  addBtn.addEventListener('click', () => {
    draft.push({ id: '', label: '', required: false });
    renderList();
    const inputs = list.querySelectorAll('input[type="text"]');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  form.appendChild(addBtn);

  const cancelBtn = faellesPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const saveBtn = faellesPillBtn('Gem', 'site-pill-primary');
  saveBtn.addEventListener('click', async () => {
    const cleanFields = [];
    for (const f of draft) {
      const label = (f.label || '').trim();
      if (!label) continue; // skip a still-blank row rather than reject the whole save
      cleanFields.push({
        id: f.id || faellesSlugForLabel(label, cleanFields.map((c) => c.id)),
        label,
        required: !!f.required,
      });
    }
    saveBtn.disabled = true;
    error.textContent = '';
    const result = await faellesApi('faelles_save_fields', { fields: cleanFields });
    saveBtn.disabled = false;
    if (!result.ok) {
      if (result.message) error.textContent = result.message;
      return;
    }
    faellesState.fields = result.data.fields;
    faellesState.rows = result.data.rows;
    close();
    faellesRender(root);
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
}

// Client-side id proposal for a brand-new field — the server independently
// enforces the real shape/uniqueness rule (faelles_valid_field_id /
// duplicate check in faelles_validate_field_spec), this is just a
// reasonable id to send.
function faellesSlugForLabel(label, existingIds) {
  // Server-side faelles_valid_field_id() only allows [A-Za-z0-9_-], so
  // Danish letters are transliterated (not just stripped) to keep the
  // slug recognizable.
  const base = label
    .toLowerCase()
    .replace(/æ/g, 'ae').replace(/ø/g, 'o').replace(/å/g, 'aa')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 30) || 'felt';
  let candidate = base;
  let n = 2;
  while (existingIds.includes(candidate) || FAELLES_BASE_FIELDS.some((f) => f.id === candidate)) {
    candidate = `${base}_${n}`;
    n += 1;
  }
  return candidate;
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('faelles-root');
  if (!root) return;
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel === 'function' && siteHasLevel('revyst')) {
    faellesLoad(root);
  }
});
