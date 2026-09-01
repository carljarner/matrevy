/* =========================================================
   Matematikrevyen – Fællesspisning (faellesspisning.html)

   Communal-meal rehearsal-day sign-up sheet, replacing a manually
   maintained Google Sheet: one row per person, one column per rehearsal/
   performance day (read live from CALENDAR_DATA's "ove"/"forestilling"
   events), a checkbox marks "eating that day," plus a summary of
   headcount + food preferences per day.

   Same privacy posture as Budget/Forms: names and food preferences never
   touch the public repo / embed pipeline, only the private Simply.com
   store (FAELLESSPISNING_DATA_DIR), via authenticated actions on
   SITE_API_ENDPOINT (site.js).

   One audience for the grid itself (any revyst+ visitor can add/edit/
   delete any row — a fully open shared spreadsheet, no per-row
   ownership). Boss additionally gets:
   - a "Forbind" button to connect the sheet to a Formularer form (which
     field answers Navn, which answers Madforbehold) — once connected,
     every response (existing and future) is synced into the grid
     automatically, no manual re-import needed;
   - a "+" after the last date column to add a Fællesspisning-only day
     column directly (stored on this page's own private document, via
     `faelles_add_day` — never the public `calendar` resource, so it does
     NOT create a Kalender event).

   Only two columns exist beyond the day columns — Navn and Madforbehold,
   fixed, not boss-configurable (there used to be an extra-field editor
   here; removed, this sheet doesn't need more than the two).

   Unlike the now-removed "Ark" page's whole-document-replace save, grid
   edits here are row-granular and commit immediately (on blur/change) —
   many revyster can toggle different rows/days concurrently without a
   batched draft clobbering each other.

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

// First-level (inline, not-in-an-overlay) button — CLAUDE.md's ".btn-small"
// tier, not the square ".site-btn-*" system (that's reserved for buttons
// actually inside a modal, see faellesPillBtn below).
function faellesBtn(label, extraClass) {
  const btn = el('button', 'btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  btn.type = 'button';
  return btn;
}

// Second-level button, for buttons inside a modal overlay only.
function faellesPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

// "+" icon button (add a row, add a date column) — the site-wide
// .boss-manage-add-plus look (style.css), same as Manus' "add QR-kode"
// affordance, rather than a labeled .btn-small pill.
function faellesAddPlusBtn(title) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'boss-manage-add-plus';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.textContent = '+';
  return btn;
}

// ── Hover tooltip (truncated Madforbehold text, a day column's full
// event title) ────────────────────────────────────────────────
// Mirrors forms.js's formsShowResponseTooltip/formsHideResponseTooltip
// (that file isn't loaded on this page, per the per-feature duplication
// convention documented in CLAUDE.md): a fixed-position dark box.
let faellesFieldTooltipEl = null;
function faellesShowFieldTooltip(anchor, text) {
  faellesHideFieldTooltip();
  const tip = el('div', 'faelles-field-tooltip', text);
  document.body.appendChild(tip);
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let top = anchorRect.top - tipRect.height - 6;
  if (top < 4) top = anchorRect.bottom + 6;
  let left = anchorRect.left;
  if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
  if (left < 4) left = 4;
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  faellesFieldTooltipEl = tip;
}
function faellesHideFieldTooltip() {
  if (faellesFieldTooltipEl) { faellesFieldTooltipEl.remove(); faellesFieldTooltipEl = null; }
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

// ── Fields — fixed, not boss-configurable ────────────────────
const FAELLES_FIELDS = [
  { id: 'navn', label: 'Navn', required: true },
  { id: 'madforbehold', label: 'Madforbehold', required: false },
];

// ── Day columns: live CALENDAR_DATA events + this document's own private
// "extra" days, minus whichever are hidden ────────────────────
// The calendar half is never stored here — mirrors formsOptionsFromRehearsals
// in js/forms.js, so it always reflects the current public calendar. A
// local override (mirroring calendar.js's own calendarOverride) means a
// date added via Kalender elsewhere shows up here immediately, without
// waiting for the embed pipeline to regenerate calendar-data.js. The extra
// half (faellesState.extraDays) is Fællesspisning-only — added via the "+"
// button below, stored on this page's own private document, never written
// to the public `calendar` resource (so it does NOT create a Kalender
// event). Every column — calendar or extra — is removable from the bottom
// row's "✕": a calendar-sourced column only gets hidden from this sheet
// (its id added to faellesState.hiddenDays, the real event untouched),
// while an extra column is deleted outright, since nothing else
// references it. Compact d/m label (not formatDaDateShort's
// weekday-inclusive form) since the header needs many narrow columns —
// matches the reference spreadsheet's own "8/11" style.
let faellesCalendarOverride = (typeof siteLoadOverride === 'function') ? siteLoadOverride('calendar') : null;

function faellesEffectiveCalendarEvents() {
  if (faellesCalendarOverride) return faellesCalendarOverride;
  return (typeof CALENDAR_DATA !== 'undefined' && Array.isArray(CALENDAR_DATA)) ? CALENDAR_DATA : [];
}

function faellesRehearsalColumns() {
  const hidden = (faellesState && faellesState.hiddenDays) || [];
  const fromCalendar = faellesEffectiveCalendarEvents()
    .filter((ev) => ev.category === 'ove' || ev.category === 'forestilling')
    .filter((ev) => !hidden.includes(ev.id))
    .map((ev) => ({ id: ev.id, date: ev.date, title: ev.title || '', extra: false }));
  const fromExtra = ((faellesState && faellesState.extraDays) || [])
    .map((d) => ({ id: d.id, date: d.date, title: d.title || '', extra: true }));
  return fromCalendar.concat(fromExtra)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)))
    .map((c) => {
      const d = (typeof parseIsoDate === 'function') ? parseIsoDate(c.date) : new Date(c.date);
      return { id: c.id, label: `${d.getDate()}/${d.getMonth() + 1}`, title: c.title, extra: c.extra };
    });
}

// ── State ─────────────────────────────────────────────────────
// One loaded document, live-synced from every successful write's server
// response — not a batched draft (unlike the removed Ark page's
// sheetState), since edits commit individually on blur/change.
let faellesState = null; // { rows, connection, extraDays, hiddenDays, updatedAt } once loaded

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
  faellesState = {
    rows: result.data.rows || [],
    connection: result.data.connection || null,
    extraDays: result.data.extraDays || [],
    hiddenDays: result.data.hiddenDays || [],
    updatedAt: result.data.updatedAt || null,
  };
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
    const connectLabel = faellesState.connection
      ? `Forbindelse: ${faellesState.connection.formTitle || 'formular'}`
      : 'Forbind';
    const connectBtn = faellesBtn(connectLabel);
    connectBtn.addEventListener('click', () => faellesOpenConnectModal(root));
    actions.appendChild(connectBtn);
  }
  const refreshBtn = faellesBtn('Opdater');
  refreshBtn.addEventListener('click', () => faellesLoad(root));
  actions.appendChild(refreshBtn);
  toolbar.appendChild(actions);
  card.appendChild(toolbar);

  card.appendChild(el('div', 'faelles-error'));

  const wrap = el('div', 'faelles-table-wrap');
  // A stray mouseenter can leave the fixed tooltip anchored to a field
  // that's since scrolled out from under it — drop it on any scroll.
  wrap.addEventListener('scroll', faellesHideFieldTooltip);
  wrap.appendChild(faellesBuildTable(root));
  card.appendChild(wrap);

  root.appendChild(card);
}

function faellesBuildTable(root) {
  const columns = faellesRehearsalColumns();
  const showAddDate = typeof siteHasLevel === 'function' && siteHasLevel('boss');

  const table = el('table', 'faelles-table');

  const thead = el('thead');
  const headRow = el('tr');
  for (const f of FAELLES_FIELDS) {
    headRow.appendChild(el('th', `faelles-col-field faelles-col-${f.id}`, f.label));
  }
  for (const col of columns) {
    const th = el('th', 'faelles-col-day', col.label);
    if (col.title) {
      th.addEventListener('mouseenter', () => faellesShowFieldTooltip(th, col.title));
      th.addEventListener('mouseleave', faellesHideFieldTooltip);
    }
    headRow.appendChild(th);
  }
  if (showAddDate) {
    const addDateTh = el('th', 'faelles-col-day');
    const addDateBtn = faellesAddPlusBtn('Tilføj dato');
    addDateBtn.addEventListener('click', () => faellesOpenQuickAddDateModal(root));
    addDateTh.appendChild(addDateBtn);
    headRow.appendChild(addDateTh);
  }
  headRow.appendChild(el('th', '', ''));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  // Alphabetical by Navn (Danish collation — æøå sort after z), not
  // insertion/signup order.
  const sortedRows = faellesState.rows.slice()
    .sort((a, b) => (a.answers.navn || '').localeCompare(b.answers.navn || '', 'da', { sensitivity: 'base' }));
  for (const row of sortedRows) {
    tbody.appendChild(faellesRenderRow(row, columns, showAddDate));
  }
  // Bottom row: "Tilføj række" (under the Navn/Madforbehold columns) plus
  // one "✕" per day column, at the same row — every day column is
  // removable from the sheet here, calendar-sourced or extra alike (see
  // faellesOpenDeleteDayConfirm for what "removable" means per source).
  const addRow = el('tr', 'faelles-add-row');
  const addCell = el('td', 'faelles-add-row-plus-cell');
  addCell.colSpan = FAELLES_FIELDS.length;
  const addBtn = faellesAddPlusBtn('Tilføj række');
  addBtn.addEventListener('click', () => {
    const draft = { id: null, answers: { navn: '', madforbehold: '' }, days: [] };
    const tr = faellesRenderRow(draft, columns, showAddDate);
    tbody.insertBefore(tr, addRow);
    const firstInput = tr.querySelector('input[type="text"]');
    if (firstInput) firstInput.focus();
  });
  addCell.appendChild(addBtn);
  addRow.appendChild(addCell);

  for (const col of columns) {
    const td = el('td', 'faelles-col-day');
    if (showAddDate) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'faelles-col-day-remove';
      removeBtn.title = col.extra ? 'Fjern dato' : 'Fjern dato fra arket';
      removeBtn.setAttribute('aria-label', removeBtn.title);
      removeBtn.textContent = '✕';
      removeBtn.addEventListener('click', () => faellesOpenDeleteDayConfirm(col, root));
      td.appendChild(removeBtn);
    }
    addRow.appendChild(td);
  }
  if (showAddDate) addRow.appendChild(el('td')); // filler under the header's add-date "+" column
  addRow.appendChild(el('td')); // filler under the trailing per-row remove column

  tbody.appendChild(addRow);
  table.appendChild(tbody);

  const summary = faellesBuildSummaryBody(columns, showAddDate);
  table.appendChild(summary);

  return table;
}

function faellesRenderRow(row, columns, showAddDate) {
  const tr = el('tr');

  for (const f of FAELLES_FIELDS) {
    const td = el('td', `faelles-col-field faelles-col-${f.id}`);
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
    if (f.id === 'madforbehold') {
      // Truncated by CSS (.faelles-col-madforbehold) — show the full
      // text in a tooltip only while actually overflowing, and never
      // while the field is focused for editing.
      input.addEventListener('mouseenter', () => {
        if (document.activeElement === input) return;
        if (input.scrollWidth > input.clientWidth && input.value) faellesShowFieldTooltip(input, input.value);
      });
      input.addEventListener('mouseleave', faellesHideFieldTooltip);
      input.addEventListener('focus', faellesHideFieldTooltip);
    }
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

  if (showAddDate) tr.appendChild(el('td')); // filler under the header's "+" add-date column

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
// new (id === null) row with an empty Navn is a no-op — an abandoned "+"
// click must leave nothing behind server-side. Commits on the same row
// are serialized via row._inFlight — without this, blurring two fields on
// the same still-unsaved row in quick succession could fire two
// concurrent "create" requests and produce a duplicate row.
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

function faellesDeleteRow(row, tr) {
  if (row.id === null) {
    tr.remove();
    return;
  }
  faellesOpenDeleteRowConfirm(row, tr);
}

// Styled "Er du sikker?" overlay, replacing the native confirm() dialog —
// mirrors calendar.js's openDeleteConfirm/manus.js's openManuscriptDeleteConfirm.
function faellesOpenDeleteRowConfirm(row, tr) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('faelles-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'faelles-confirm-text';
  info.textContent = row.answers.navn ? `Fjern "${row.answers.navn}" permanent?` : 'Fjern denne række permanent?';
  form.appendChild(info);

  const cancelBtn = faellesPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = faellesPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await faellesApi('faelles_delete_row', { rowId: row.id });
    if (!result.ok) {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
      return;
    }
    faellesState.rows = faellesState.rows.filter((r) => r !== row);
    faellesRefreshSummary(tr);
    tr.remove();
    close();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
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
  const showAddDate = typeof siteHasLevel === 'function' && siteHasLevel('boss');
  const oldSummary = table.querySelector('tbody.faelles-summary');
  const newSummary = faellesBuildSummaryBody(faellesRehearsalColumns(), showAddDate);
  if (oldSummary) oldSummary.replaceWith(newSummary);
  else table.appendChild(newSummary);
}

// Computed client-side from faellesState.rows — no server round-trip.
function faellesBuildSummaryBody(columns, showAddDate) {
  const tbody = el('tbody', 'faelles-summary');
  const trailingCols = (showAddDate ? 1 : 0) + 1; // add-date filler + remove-column filler

  const countRow = el('tr');
  countRow.appendChild(el('th', '', 'Samlet antal i dag'));
  countRow.appendChild(el('td')); // spans the Madforbehold column
  for (const col of columns) {
    const count = faellesState.rows.filter((r) => r.days.includes(col.id)).length;
    countRow.appendChild(el('td', '', String(count)));
  }
  for (let i = 0; i < trailingCols; i++) countRow.appendChild(el('td'));
  tbody.appendChild(countRow);

  const prefRow = el('tr');
  prefRow.appendChild(el('th', '', 'Madforbehold'));
  prefRow.appendChild(el('td'));
  for (const col of columns) {
    const attendees = faellesState.rows.filter((r) => r.days.includes(col.id));
    const withPrefsRows = attendees.filter((r) => (r.answers.madforbehold || '').trim() !== '');
    const cell = el('td', 'faelles-summary-prefs');
    const btn = el('button', 'faelles-prefs-btn', attendees.length ? `ⓘ ${withPrefsRows.length}` : '–');
    btn.type = 'button';
    btn.title = 'Se madforbehold for denne dag';
    btn.disabled = attendees.length === 0;
    btn.addEventListener('click', () => faellesOpenPreferencesModal(col, withPrefsRows));
    cell.appendChild(btn);
    prefRow.appendChild(cell);
  }
  for (let i = 0; i < trailingCols; i++) prefRow.appendChild(el('td'));
  tbody.appendChild(prefRow);

  return tbody;
}

// Lists only the attendees who actually stated a Madforbehold for one day
// (a blank field is skipped, not shown as "–") — the summary row itself
// only shows a small "ⓘ N" affordance, not the text directly, per the
// site's preference for keeping the grid itself compact.
function faellesOpenPreferencesModal(col, attendees) {
  const { modal, form, actions, close } = siteOpenModalWithClose(`Madforbehold – ${col.label}`);
  modal.classList.add('faelles-prefs-modal');

  if (attendees.length === 0) {
    form.appendChild(el('p', 'faelles-summary-note', 'Ingen har angivet madforbehold denne dag.'));
  } else {
    const list = el('ul', 'faelles-prefs-list');
    for (const row of attendees) {
      const li = document.createElement('li');
      li.appendChild(el('span', 'faelles-prefs-name', row.answers.navn || '(uden navn)'));
      li.appendChild(el('span', 'faelles-prefs-value', row.answers.madforbehold.trim()));
      list.appendChild(li);
    }
    form.appendChild(list);
  }

  const closeBtn = faellesPillBtn('Luk');
  closeBtn.addEventListener('click', close);
  actions.appendChild(closeBtn);
}

// ── Boss: connect the sheet to a Formularer form ─────────────
// Pick a form (e.g. "Tilmelding 2026"), then which of its fields answers
// Navn and which answers Madforbehold. Reuses Forms' own boss-level
// actions directly (forms_admin_list/forms_admin_read) rather than adding
// a dedicated server endpoint for listing/reading — the shared password/
// level model doesn't care which page a request came from. Once saved,
// the server immediately syncs every existing response, and every future
// faelles_read keeps syncing new ones automatically (see faelles_read/
// faelles_sync_connection in update-data.php) — no manual re-import step.
async function faellesOpenConnectModal(root) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Forbind til formular');
  modal.classList.add('faelles-connect-modal');

  const status = el('p', 'faelles-summary-note', 'Indlæser formularer…');
  form.appendChild(status);

  const listResult = await faellesApi('forms_admin_list', {});
  status.remove();
  if (!listResult.ok) {
    error.textContent = listResult.message || 'Kunne ikke hente formularer.';
    return;
  }
  const forms = listResult.data.forms || [];
  if (forms.length === 0) {
    form.appendChild(el('p', 'faelles-summary-note', 'Ingen formularer fundet.'));
    return;
  }

  const currentConnection = faellesState.connection;
  const formOptions = forms.map((f) => ({
    value: f.id,
    label: `${f.title || '(uden titel)'} (${f.responseCount} svar)`,
  }));
  const initialFormId = (currentConnection && forms.some((f) => f.id === currentConnection.formId))
    ? currentConnection.formId : formOptions[0].value;
  const formPicker = siteCreateDropdownField(formOptions, initialFormId);
  form.appendChild(siteEditField('Formular', formPicker));

  const fieldsContainer = el('div');
  form.appendChild(fieldsContainer);

  let currentFormId = null;
  let navnPicker = null;
  let madforboholdPicker = null;

  async function loadFormFields(formId) {
    currentFormId = formId;
    navnPicker = null;
    madforboholdPicker = null;
    fieldsContainer.replaceChildren();
    fieldsContainer.appendChild(el('p', 'faelles-summary-note', 'Indlæser felter…'));
    const readResult = await faellesApi('forms_admin_read', { formId });
    fieldsContainer.replaceChildren();
    if (!readResult.ok) {
      error.textContent = readResult.message || 'Kunne ikke hente formularen.';
      return;
    }
    const fieldOpts = faellesFormFieldOptions(readResult.data.definition);
    if (fieldOpts.length === 0) {
      fieldsContainer.appendChild(el('p', 'faelles-summary-note', 'Formularen har ingen felter at vælge imellem.'));
      return;
    }
    const sameAsConnected = currentConnection && currentConnection.formId === formId;
    const initialNavn = (sameAsConnected && fieldOpts.some((o) => o.value === currentConnection.navnFieldId))
      ? currentConnection.navnFieldId : fieldOpts[0].value;
    const initialMad = (sameAsConnected && fieldOpts.some((o) => o.value === currentConnection.madforboholdFieldId))
      ? currentConnection.madforboholdFieldId : fieldOpts[0].value;
    navnPicker = siteCreateDropdownField(fieldOpts, initialNavn);
    madforboholdPicker = siteCreateDropdownField(fieldOpts, initialMad);
    fieldsContainer.appendChild(siteEditField('Navn-felt', navnPicker));
    fieldsContainer.appendChild(siteEditField('Madforbehold-felt', madforboholdPicker));
    fieldsContainer.appendChild(el('p', 'faelles-summary-note',
      'Alle nuværende og fremtidige svar bliver automatisk skrevet til arket — ingen manuel import nødvendig.'));
  }

  formPicker.addEventListener('change', () => loadFormFields(formPicker.value));
  await loadFormFields(initialFormId);

  if (currentConnection) {
    const disconnectBtn = faellesPillBtn('Fjern', 'site-btn-danger');
    disconnectBtn.addEventListener('click', () => faellesOpenDisconnectConfirm(root, close));
    actions.appendChild(disconnectBtn);
  }

  const connectBtn = faellesPillBtn('Forbind', 'site-btn-success');
  connectBtn.addEventListener('click', async () => {
    if (!currentFormId || !navnPicker || !madforboholdPicker) return;
    const formTitle = (forms.find((f) => f.id === currentFormId) || {}).title || '';
    connectBtn.disabled = true;
    error.textContent = '';
    const result = await faellesApi('faelles_save_connection', {
      formId: currentFormId,
      navnFieldId: navnPicker.value,
      madforboholdFieldId: madforboholdPicker.value,
      formTitle,
    });
    connectBtn.disabled = false;
    if (!result.ok) {
      error.textContent = result.message || 'Kunne ikke forbinde.';
      return;
    }
    faellesState.connection = result.data.connection;
    faellesState.rows = result.data.rows;
    close();
    faellesRender(root);
  });
  actions.appendChild(connectBtn);
}

// Styled "Er du sikker?" confirm for disconnecting a form, replacing a
// native confirm() (a plain browser dialog reads as broken next to the
// rest of the site's own styled modals) — stacks on top of the already-open
// connect modal, same nested-overlay pattern as budget.js's
// openExpenseDeleteConfirm(root, exp, payload, closeParent).
function faellesOpenDisconnectConfirm(root, closeParent) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('faelles-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'faelles-confirm-text';
  info.textContent = 'Fjern forbindelsen til formularen?';
  form.appendChild(info);

  const note = document.createElement('p');
  note.className = 'faelles-confirm-note';
  note.textContent = 'Rækker der allerede er hentet ind, bliver ikke slettet.';
  form.appendChild(note);

  const cancelBtn = faellesPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = faellesPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await faellesApi('faelles_save_connection', { formId: null });
    if (!result.ok) {
      confirmBtn.disabled = false;
      error.textContent = result.message || 'Kunne ikke fjerne forbindelsen.';
      return;
    }
    faellesState.connection = null;
    faellesState.rows = result.data.rows;
    close();
    closeParent();
    faellesRender(root);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// A form's fields can live either directly on the definition or inside its
// sections (see forms_submit's own identical merge server-side) — flatten
// both so every real question is offered, regardless of layout.
function faellesFormFieldOptions(definition) {
  const fields = (definition.fields || []).concat(
    (definition.sections || []).flatMap((s) => s.fields || [])
  );
  return fields
    .filter((f) => f && f.id && f.label)
    .map((f) => ({ value: f.id, label: f.label }));
}

// ── Boss: quick-add a Fællesspisning-only day column ─────────
// Stored on this page's own private document (faelles_add_day) — never
// written to the public `calendar` resource, so this does NOT create a
// Kalender event. No category field either (that's a Kalender-only
// concept with no meaning for a sheet-private day).
async function faellesOpenQuickAddDateModal(root) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj dato');
  modal.classList.add('faelles-quickdate-modal');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Fx Øvedag';
  form.appendChild(siteEditField('Titel', titleInput));

  const dateInput = siteCreateDateField('');
  form.appendChild(siteEditField('Dato', dateInput));

  const saveBtn = faellesPillBtn('Tilføj', 'site-btn-success');
  saveBtn.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const date = dateInput.value;
    if (!title || !date) {
      error.textContent = 'Udfyld både titel og dato.';
      return;
    }

    saveBtn.disabled = true;
    error.textContent = '';
    const result = await faellesApi('faelles_add_day', { title, date });
    saveBtn.disabled = false;
    if (!result.ok) {
      if (result.message) error.textContent = result.message;
      return;
    }
    faellesState.extraDays = result.data.extraDays;
    close();
    faellesRender(root);
  });

  actions.appendChild(saveBtn);
  titleInput.focus();
}

// Styled "Er du sikker?" overlay for removing a day column from the
// sheet — every column is removable this way, but what "removable" means
// depends on where it came from: an extra (Fællesspisning-only) column is
// deleted outright (faelles_delete_day, nothing else references it),
// while a real calendar-sourced column is only *hidden* from this sheet
// (faelles_hide_day adds its id to faellesState.hiddenDays) — the actual
// data/calendar.json event, and Kalender's own display of it, are left
// completely untouched. Either way, any row's `days` entry referencing
// the removed id is left alone server-side, same as a deleted row.
function faellesOpenDeleteDayConfirm(col, root) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('faelles-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'faelles-confirm-text';
  info.textContent = col.extra
    ? `Fjern datoen "${col.title || col.label}"?`
    : `Fjern "${col.title || col.label}" fra arket?`;
  form.appendChild(info);

  // Only a calendar-sourced column can be "removed" without actually
  // deleting anything (faelles_hide_day just hides it from this sheet) —
  // an extra column is genuinely deleted, so no such disclaimer applies.
  if (!col.extra) {
    const note = document.createElement('p');
    note.className = 'faelles-confirm-note';
    note.textContent = 'Begivenheden i Kalenderen bliver ikke slettet.';
    form.appendChild(note);
  }

  const cancelBtn = faellesPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = faellesPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const action = col.extra ? 'faelles_delete_day' : 'faelles_hide_day';
    const result = await faellesApi(action, { dayId: col.id });
    if (!result.ok) {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
      return;
    }
    if (col.extra) faellesState.extraDays = result.data.extraDays;
    else faellesState.hiddenDays = result.data.hiddenDays;
    close();
    faellesRender(root);
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
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
