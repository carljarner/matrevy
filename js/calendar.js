/* =========================================================
   Matematikrevyen – Kalender (kalender.html)
   Month-grid + list view over CALENDAR_DATA (embedded from
   data/calendar.json); admins add/edit/delete events, saved
   globally via siteSaveResource ('calendar' resource in
   server/update-data.php).

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

// ── Categories ───────────────────────────────────────────────
// Data stores the ASCII key; label + color class live here.
const CAL_CATEGORIES = {
  deadline:     { label: 'Deadline' },
  manus:        { label: 'Manus' },
  ove:          { label: 'Øvning' },
  forestilling: { label: 'Forestilling' },
  andet:        { label: 'Andet' },
};

function calCategoryClass(category) {
  return CAL_CATEGORIES[category] ? `cal-cat-${category}` : 'cal-cat-andet';
}

function calCategoryLabel(category) {
  return CAL_CATEGORIES[category] ? CAL_CATEGORIES[category].label : 'Andet';
}

// ── Data (with in-memory shadow after a save) ────────────────
let calendarOverride = null;

function getEffectiveEvents() {
  return calendarOverride || CALENDAR_DATA;
}

function getSortedEvents() {
  return getEffectiveEvents().slice().sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    return (a.start || '') < (b.start || '') ? -1 : (a.start || '') > (b.start || '') ? 1 : 0;
  });
}

// Multi-day events store endDate >= date; a single-day event has endDate === date.
function calEventEndDate(ev) {
  return (ev.endDate && ev.endDate >= ev.date) ? ev.endDate : ev.date;
}

// Every ISO date an event spans (inclusive) — used to place a multi-day event
// on each day it covers in the month grid.
function calDateRangeIso(startIso, endIso) {
  const pad = n => String(n).padStart(2, '0');
  const dates = [];
  let d = parseIsoDate(startIso);
  const end = parseIsoDate(endIso);
  while (d <= end) {
    dates.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
  }
  return dates;
}

// ── View state ───────────────────────────────────────────────
const CAL_VIEW_KEY = 'matrevy-cal-view';

const calState = { view: 'month', year: 0, month: 0 }; // month: 0-11

function initCalState() {
  let view = null;
  try { view = localStorage.getItem(CAL_VIEW_KEY); } catch (e) { /* ignore */ }
  if (view !== 'month' && view !== 'list') {
    view = window.matchMedia('(max-width: 640px)').matches ? 'list' : 'month';
  }
  calState.view = view;
  const now = new Date();
  calState.year = now.getFullYear();
  calState.month = now.getMonth();
}

function setCalView(view) {
  calState.view = view;
  try { localStorage.setItem(CAL_VIEW_KEY, view); } catch (e) { /* ignore */ }
  renderCalendar();
}

function shiftMonth(delta) {
  const d = new Date(calState.year, calState.month + delta, 1);
  calState.year = d.getFullYear();
  calState.month = d.getMonth();
  renderCalendar();
}

// ── Rendering ────────────────────────────────────────────────
function renderCalendar() {
  const monthBtn = document.getElementById('cal-view-month');
  const listBtn = document.getElementById('cal-view-list');
  const monthNav = document.getElementById('cal-month-nav');
  const adminSlot = document.getElementById('cal-admin');
  const view = document.getElementById('cal-view');
  if (!view) return;

  monthBtn.classList.toggle('active', calState.view === 'month');
  listBtn.classList.toggle('active', calState.view === 'list');
  monthNav.style.display = calState.view === 'month' ? 'flex' : 'none';

  adminSlot.textContent = '';
  if (siteHasLevel('boss')) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-small';
    addBtn.textContent = '+ Ny begivenhed';
    addBtn.addEventListener('click', () => openEventEditor(null));
    adminSlot.appendChild(addBtn);
  }

  view.textContent = '';
  if (calState.view === 'month') renderMonthView(view);
  else renderListView(view);
}

function renderMonthView(container) {
  document.getElementById('cal-month-label').textContent =
    `${DA_MONTHS[calState.month]} ${calState.year}`;

  // Index events by date for the visible month in one pass. Multi-day events
  // are placed on every date they span, not just their start date.
  const byDate = new Map();
  for (const ev of getSortedEvents()) {
    for (const iso of calDateRangeIso(ev.date, calEventEndDate(ev))) {
      if (!byDate.has(iso)) byDate.set(iso, []);
      byDate.get(iso).push(ev);
    }
  }

  const wrap = document.createElement('div');
  wrap.className = 'cal-grid-wrap';
  const grid = document.createElement('div');
  grid.className = 'cal-grid';

  for (const wd of DA_WEEKDAYS_SHORT) {
    const cell = document.createElement('div');
    cell.className = 'cal-weekday';
    cell.textContent = wd;
    grid.appendChild(cell);
  }

  const firstOffset = (new Date(calState.year, calState.month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(calState.year, calState.month + 1, 0).getDate();
  const totalCells = Math.ceil((firstOffset + daysInMonth) / 7) * 7;
  const today = todayIso();
  const pad = n => String(n).padStart(2, '0');

  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - firstOffset + 1;
    const cell = document.createElement('div');
    if (dayNum < 1 || dayNum > daysInMonth) {
      cell.className = 'cal-day cal-day-blank';
      grid.appendChild(cell);
      continue;
    }
    const iso = `${calState.year}-${pad(calState.month + 1)}-${pad(dayNum)}`;
    cell.className = 'cal-day' + (iso === today ? ' cal-today' : '');

    const num = document.createElement('div');
    num.className = 'cal-day-num';
    num.textContent = dayNum;
    cell.appendChild(num);

    for (const ev of byDate.get(iso) || []) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = `cal-chip ${calCategoryClass(ev.category)}`;
      chip.textContent = ev.start ? `${ev.start} ${ev.title}` : ev.title;
      chip.title = ev.title;
      chip.addEventListener('click', () => openEventDetail(ev));
      cell.appendChild(chip);
    }

    grid.appendChild(cell);
  }

  wrap.appendChild(grid);
  container.appendChild(wrap);
}

function renderListView(container) {
  const today = todayIso();
  // Keep multi-day events that started before today but haven't ended yet.
  const upcoming = getSortedEvents().filter(ev => calEventEndDate(ev) >= today);
  const isAdmin = siteHasLevel('boss');

  if (upcoming.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Ingen kommende begivenheder.';
    container.appendChild(empty);
    return;
  }

  let currentMonthKey = '';
  for (const ev of upcoming) {
    const d = parseIsoDate(ev.date);
    const monthKey = `${d.getFullYear()}-${d.getMonth()}`;
    if (monthKey !== currentMonthKey) {
      currentMonthKey = monthKey;
      const heading = document.createElement('div');
      heading.className = 'cal-list-month';
      heading.textContent = `${DA_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
      container.appendChild(heading);
    }

    const row = document.createElement('div');
    row.className = 'cal-list-row';

    const meta = document.createElement('span');
    meta.className = 'cal-list-meta';

    const dot = document.createElement('span');
    dot.className = `cal-dot ${calCategoryClass(ev.category)}`;
    meta.appendChild(dot);

    const date = document.createElement('span');
    date.className = 'cal-list-date';
    date.textContent = calDateLabelShort(ev);
    meta.appendChild(date);

    const time = document.createElement('span');
    time.className = 'cal-list-time';
    time.textContent = calTimeRange(ev);
    meta.appendChild(time);

    row.appendChild(meta);

    const content = document.createElement('span');
    content.className = 'cal-list-content';

    const titleLine = document.createElement('span');
    titleLine.className = 'cal-list-titleline';

    const title = document.createElement('span');
    title.className = 'cal-list-title';
    title.textContent = ev.title;
    titleLine.appendChild(title);

    if (isAdmin) {
      const actionsWrap = document.createElement('span');
      actionsWrap.className = 'cal-list-actions';
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => openEventEditor(ev));
      actionsWrap.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-small btn-small-danger';
      delBtn.textContent = 'Slet';
      delBtn.addEventListener('click', () => openDeleteConfirm(ev));
      actionsWrap.appendChild(delBtn);
      titleLine.appendChild(actionsWrap);
    }

    content.appendChild(titleLine);

    if (ev.note) {
      const note = document.createElement('span');
      note.className = 'cal-list-note';
      note.textContent = ev.note;
      content.appendChild(note);
    }

    row.appendChild(content);
    container.appendChild(row);
  }
}

// Shared chrome for Kalender's modals: an X-close in the top-right corner
// instead of a "Luk"/"Annuller" button in the actions row, plus Escape-to-
// close (siteOpenEditModal has neither). Kalender-only DOM patch — the
// shared modal helper in site-utils.js is untouched, so every other modal
// on the site is unaffected. Returns the same shape as siteOpenEditModal,
// with `close` already wrapping the Escape-listener cleanup.
function calOpenModal(title) {
  const { overlay, modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('cal-modal');

  function closeModal() {
    document.removeEventListener('keydown', onKeydown);
    close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') closeModal();
  }
  document.addEventListener('keydown', onKeydown);
  // Backdrop click closes via the overlay's own listener (from
  // siteOpenEditModal) — also strip our Escape listener in that case.
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) document.removeEventListener('keydown', onKeydown);
  });

  const closeX = document.createElement('button');
  closeX.type = 'button';
  closeX.className = 'cal-modal-close';
  closeX.textContent = '✕';
  closeX.setAttribute('aria-label', 'Luk');
  closeX.addEventListener('click', closeModal);
  modal.insertBefore(closeX, modal.firstChild);

  return { modal, form, error, actions, close: closeModal };
}

// A rounded "pill" button for Kalender's modals (mirrors budget.js's
// budgetPillBtn — see calendar.css's .cal-pill-btn for the styling).
function calPillBtn(label, variant) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cal-pill-btn' + (variant ? ' ' + variant : '');
  btn.textContent = label;
  return btn;
}

function calTimeRange(ev) {
  if (!ev.start) return '';
  return ev.end ? `${ev.start}–${ev.end}` : ev.start;
}

function calDateLabelShort(ev) {
  const end = calEventEndDate(ev);
  return end === ev.date ? formatDaDateShort(ev.date) : `${formatDaDateShort(ev.date)}–${formatDaDateShort(end)}`;
}

function calDateLabelLong(ev) {
  const end = calEventEndDate(ev);
  return end === ev.date ? formatDaDate(ev.date) : `${formatDaDate(ev.date)} – ${formatDaDate(end)}`;
}

// ── Read-only detail modal (non-admin chip click) ────────────
function openEventDetail(ev) {
  const { form, actions, close } = calOpenModal(ev.title);

  const rows = [
    ['Dato', calDateLabelLong(ev)],
    ['Tid', calTimeRange(ev) || 'Hele dagen'],
    ['Kategori', calCategoryLabel(ev.category)],
  ];
  if (ev.note) rows.push(['Note', ev.note]);
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'cal-detail-row';
    const l = document.createElement('span');
    l.className = 'cal-detail-label';
    l.textContent = label + ':';
    row.appendChild(l);
    const v = document.createElement('span');
    v.textContent = value;
    row.appendChild(v);
    form.appendChild(row);
  }

  if (siteHasLevel('boss')) {
    const editBtn = calPillBtn('Rediger', 'cal-pill-warm');
    editBtn.addEventListener('click', () => { close(); openEventEditor(ev); });
    actions.appendChild(editBtn);
  }
}

// ── Saving ───────────────────────────────────────────────────
async function saveEvents(next) {
  const result = await siteSaveResource('calendar', { events: next });
  if (result.ok) {
    calendarOverride = next;
    renderCalendar();
  }
  return result;
}

// ── Editor modal ─────────────────────────────────────────────
function openEventEditor(existing) {
  const { form, error, actions, close } = calOpenModal(existing ? 'Rediger begivenhed' : 'Ny begivenhed');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing ? existing.title : '';
  form.appendChild(siteEditField('Titel', titleInput));

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  if (existing) {
    dateInput.value = existing.date;
  } else {
    // Default to today, or the 1st of the viewed month when browsing
    // another month than the current one.
    const now = new Date();
    const viewingCurrent = calState.year === now.getFullYear() && calState.month === now.getMonth();
    const pad = n => String(n).padStart(2, '0');
    dateInput.value = (viewingCurrent || calState.view === 'list')
      ? todayIso()
      : `${calState.year}-${pad(calState.month + 1)}-01`;
  }
  const endDateInput = document.createElement('input');
  endDateInput.type = 'date';
  endDateInput.value = existing ? calEventEndDate(existing) : dateInput.value;

  const dateRow = document.createElement('div');
  dateRow.className = 'edit-field-row';
  dateRow.appendChild(siteEditField('Dato', dateInput));
  dateRow.appendChild(siteEditField('Slutdato', endDateInput));
  form.appendChild(dateRow);

  const timeRow = document.createElement('div');
  timeRow.className = 'edit-field-row';
  const startInput = document.createElement('input');
  startInput.type = 'time';
  startInput.value = existing ? existing.start || '' : '';
  timeRow.appendChild(siteEditField('Start', startInput));
  const endInput = document.createElement('input');
  endInput.type = 'time';
  endInput.value = existing ? existing.end || '' : '';
  timeRow.appendChild(siteEditField('Slut', endInput));
  form.appendChild(timeRow);

  const catSelect = document.createElement('select');
  for (const [value, def] of Object.entries(CAL_CATEGORIES)) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = def.label;
    catSelect.appendChild(opt);
  }
  catSelect.value = existing && CAL_CATEGORIES[existing.category] ? existing.category : 'ove';
  form.appendChild(siteEditField('Kategori', catSelect));

  const noteArea = document.createElement('textarea');
  noteArea.value = existing ? existing.note || '' : '';
  form.appendChild(siteEditField('Note', noteArea));

  const save = calPillBtn('Gem', 'cal-pill-primary');

  if (existing) {
    const del = calPillBtn('Slet', 'cal-pill-danger');
    del.addEventListener('click', () => { close(); openDeleteConfirm(existing); });
    actions.appendChild(del);
  }
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const date = dateInput.value;
    if (!title || !date) {
      error.textContent = 'Udfyld både titel og dato.';
      return;
    }
    const endDate = endDateInput.value && endDateInput.value >= date ? endDateInput.value : date;
    const item = {
      id: existing ? existing.id : Date.now().toString(36),
      date,
      endDate,
      start: startInput.value || '',
      end: endInput.value || '',
      title,
      category: catSelect.value,
      note: noteArea.value.trim(),
    };
    const current = getEffectiveEvents();
    const next = existing
      ? current.map(ev => (ev.id === existing.id ? item : ev))
      : current.concat([item]);

    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';
    const result = await saveEvents(next);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) close();
    else error.textContent = result.message;
  });

  titleInput.focus();
}

// Styled "Er du sikker?" overlay, replacing the native confirm() dialog —
// mirrors budget.js's rejectRequest pattern.
function openDeleteConfirm(ev) {
  const { modal, form, error, actions, close } = siteOpenEditModal('Slet begivenhed');
  modal.classList.add('cal-confirm-modal');

  const info = document.createElement('p');
  info.className = 'cal-confirm-text';
  info.textContent = `Slet begivenheden "${ev.title}"?`;
  form.appendChild(info);

  const cancelBtn = calPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = calPillBtn('Slet', 'cal-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectiveEvents().filter(e => e.id !== ev.id);
    const result = await saveEvents(next);
    if (result.ok) {
      close();
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Colour legend (static, rendered once) ─────────────────────
function renderLegend() {
  const legend = document.getElementById('cal-legend');
  if (!legend) return;
  legend.textContent = '';
  for (const [key, def] of Object.entries(CAL_CATEGORIES)) {
    const item = document.createElement('span');
    item.className = 'cal-legend-item';
    const dot = document.createElement('span');
    dot.className = `cal-dot ${calCategoryClass(key)}`;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(def.label));
    legend.appendChild(item);
  }
}

// ── Calendar-subscribe (.ics) ─────────────────────────────────
// Static file served by GitHub Pages — the underlying data is already fully
// public (this page has no login gate), so there's no server round-trip.
const CALENDAR_FEED_URL = 'https://matematikrevy.dk/calendar.ics';

function openSubscribeModal() {
  const { form, actions } = calOpenModal('Abonnér på kalenderen');

  const info = document.createElement('p');
  info.textContent = 'Tilføj linket herunder som et kalenderabonnement, så følger din kalender-app automatisk med i alle begivenheder: Google Kalender ("Fra URL"), Apple Kalender ("Nyt kalenderabonnement") eller Outlook ("Abonnér fra internettet").';
  form.appendChild(info);

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.value = CALENDAR_FEED_URL;
  urlInput.readOnly = true;
  form.appendChild(siteEditField('Link', urlInput));

  const copyBtn = calPillBtn('Kopiér link', 'cal-pill-warm');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(CALENDAR_FEED_URL);
      copyBtn.textContent = 'Kopieret!';
      setTimeout(() => { copyBtn.textContent = 'Kopiér link'; }, 1500);
    } catch (e) {
      urlInput.select();
    }
  });
  actions.appendChild(copyBtn);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCalState();
  document.getElementById('cal-view-month').addEventListener('click', () => setCalView('month'));
  document.getElementById('cal-view-list').addEventListener('click', () => setCalView('list'));
  document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
  document.getElementById('cal-subscribe').addEventListener('click', openSubscribeModal);
  renderLegend();
  renderCalendar();
});
