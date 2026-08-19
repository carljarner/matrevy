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

// ── Data (with a localStorage-backed shadow after a save) ────
let calendarOverride = siteLoadOverride('calendar');

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

// Whole-day difference between two ISO dates (endIso - startIso).
function calDaysBetweenIso(startIso, endIso) {
  return Math.round((parseIsoDate(endIso) - parseIsoDate(startIso)) / 86400000);
}

// Adds (possibly negative) whole days to an ISO date.
function calAddDaysIso(iso, days) {
  const d = parseIsoDate(iso);
  const shifted = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  const pad = n => String(n).padStart(2, '0');
  return `${shifted.getFullYear()}-${pad(shifted.getMonth() + 1)}-${pad(shifted.getDate())}`;
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

  // Both lengths are always in the DOM; calendar.css swaps which is visible
  // by screen width (≤719px, the site-wide mobile breakpoint) rather than
  // a JS resize listener — spelled out ("mandag") whenever there's room,
  // abbreviated on narrow screens where the grid columns are tight.
  for (let i = 0; i < DA_WEEKDAYS_SHORT.length; i++) {
    const cell = document.createElement('div');
    cell.className = 'cal-weekday';
    const full = document.createElement('span');
    full.className = 'cal-weekday-full';
    full.textContent = DA_WEEKDAYS_LONG[i];
    const short = document.createElement('span');
    short.className = 'cal-weekday-short';
    short.textContent = DA_WEEKDAYS_SHORT[i];
    cell.appendChild(full);
    cell.appendChild(short);
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

    if (isAdmin) {
      const actionsWrap = document.createElement('span');
      actionsWrap.className = 'cal-list-actions';
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'cal-list-edit-btn';
      editBtn.setAttribute('aria-label', 'Rediger begivenhed');
      editBtn.appendChild(calPencilIcon());
      editBtn.addEventListener('click', () => openEventEditor(ev));
      actionsWrap.appendChild(editBtn);
      content.appendChild(actionsWrap);
    }

    const title = document.createElement('span');
    title.className = 'cal-list-title';
    title.textContent = ev.title;
    content.appendChild(title);

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

// A rounded "pill" button for Kalender's modals — see style.css's shared
// .site-pill-btn for the styling (also used by every other page's modals).
function calPillBtn(label, variant) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-pill-btn' + (variant ? ' ' + variant : '');
  btn.textContent = label;
  return btn;
}

// List-view "Rediger" icon — a plain pencil, built via createElementNS like
// site-utils.js's clock icon / posts.js's pin icon.
function calPencilIcon() {
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
  const { form, actions, close } = siteOpenModalWithClose(ev.title);

  const rows = [
    ['Dato', calDateLabelLong(ev)],
    ['Tid', calTimeRange(ev) || 'Hele dagen'],
    ['Lokale', ev.location || ''],
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
    const editBtn = calPillBtn('Rediger', 'site-pill-warm');
    editBtn.addEventListener('click', () => { close(); openEventEditor(ev); });
    actions.appendChild(editBtn);
  }
}

// ── Saving ───────────────────────────────────────────────────
async function saveEvents(next) {
  const result = await siteSaveResource('calendar', { events: next });
  if (result.ok) {
    calendarOverride = next;
    siteSaveOverride('calendar', next);
    renderCalendar();
  }
  return result;
}

// ── Category field (custom dropdown popup) ────────────────────
// Date/time fields use the shared siteCreateDateField/siteCreateTimeField
// (site-utils.js) directly — only the category field is Kalender-specific
// (it needs a coloured dot per option), built on the same siteOpenFieldPopup
// primitive those share.
function openCalCategoryPicker(anchor, currentKey, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-dd-pop';

  for (const [key, def] of Object.entries(CAL_CATEGORIES)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-list-row cal-cp-row';
    if (key === currentKey) row.classList.add('site-list-selected');
    const dot = document.createElement('span');
    dot.className = `cal-dot ${calCategoryClass(key)}`;
    row.appendChild(dot);
    row.appendChild(document.createTextNode(def.label));
    row.addEventListener('click', () => { close(); onSelect(key); });
    pop.appendChild(row);
  }

  const close = siteOpenFieldPopup(anchor, pop);
}

function calCreateCategoryField(initialKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-field-btn';

  const left = document.createElement('span');
  left.className = 'site-field-left';
  const dot = document.createElement('span');
  dot.className = 'cal-dot';
  const text = document.createElement('span');
  text.className = 'site-field-text';
  left.appendChild(dot);
  left.appendChild(text);
  const chevron = document.createElement('span');
  chevron.className = 'site-field-chevron';
  chevron.textContent = '▾';
  btn.appendChild(left);
  btn.appendChild(chevron);

  let _value = initialKey || 'ove';
  function render() {
    dot.className = `cal-dot ${calCategoryClass(_value)}`;
    text.textContent = calCategoryLabel(_value);
  }
  Object.defineProperty(btn, 'value', {
    get() { return _value; },
    set(v) { _value = v; render(); },
  });
  render();

  btn.addEventListener('click', () => {
    siteToggleFieldPopup(btn, () => {
      openCalCategoryPicker(btn, _value, (key) => {
        _value = key;
        render();
        btn.dispatchEvent(new Event('change'));
      });
    });
  });
  return btn;
}

// ── Editor modal ─────────────────────────────────────────────
function openEventEditor(existing) {
  const { form, error, actions, close } = siteOpenModalWithClose(existing ? 'Rediger begivenhed' : 'Ny begivenhed');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing ? existing.title : '';
  form.appendChild(siteEditField('Titel', titleInput));

  const dateInput = siteCreateDateField('');
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
  const endDateInput = siteCreateDateField(existing ? calEventEndDate(existing) : dateInput.value);

  // Keep the start/end gap constant when the start date changes (0 days for
  // a single-day event stays single-day; a 2-day span stays 2 days), while
  // never letting the end date fall before the start date.
  let dateSpanDays = calDaysBetweenIso(dateInput.value, endDateInput.value);
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    endDateInput.value = calAddDaysIso(dateInput.value, dateSpanDays);
  });
  endDateInput.addEventListener('change', () => {
    if (endDateInput.value && endDateInput.value < dateInput.value) {
      endDateInput.value = dateInput.value;
    }
    dateSpanDays = calDaysBetweenIso(dateInput.value, endDateInput.value);
  });

  const dateRow = document.createElement('div');
  dateRow.className = 'edit-field-row';
  dateRow.appendChild(siteEditField('Dato', dateInput));
  dateRow.appendChild(siteEditField('Slutdato', endDateInput));
  form.appendChild(dateRow);

  const timeRow = document.createElement('div');
  timeRow.className = 'edit-field-row';
  const startInput = siteCreateTimeField(existing ? existing.start || '' : '');
  timeRow.appendChild(siteEditField('Start', startInput));
  const endInput = siteCreateTimeField(existing ? existing.end || '' : '');
  timeRow.appendChild(siteEditField('Slut', endInput));
  form.appendChild(timeRow);

  const locationInput = document.createElement('input');
  locationInput.type = 'text';
  locationInput.value = existing ? existing.location || '' : '';

  const catField = calCreateCategoryField(existing && CAL_CATEGORIES[existing.category] ? existing.category : 'ove');

  const catRow = document.createElement('div');
  catRow.className = 'edit-field-row';
  catRow.appendChild(siteEditField('Lokale', locationInput));
  catRow.appendChild(siteEditField('Kategori', catField));
  form.appendChild(catRow);

  const noteArea = document.createElement('textarea');
  noteArea.value = existing ? existing.note || '' : '';
  form.appendChild(siteEditField('Note', noteArea));

  const save = calPillBtn('Gem', 'site-pill-primary');

  if (existing) {
    const del = calPillBtn('Slet', 'site-pill-danger');
    del.addEventListener('click', () => openDeleteConfirm(existing, close));
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
      category: catField.value,
      location: locationInput.value.trim(),
      note: noteArea.value.trim(),
    };
    const current = getEffectiveEvents();
    const next = existing
      ? current.map(ev => (ev.id === existing.id ? item : ev))
      : current.concat([item]);

    save.disabled = true;
    error.textContent = '';
    const result = await saveEvents(next);
    save.disabled = false;
    if (result.ok) close();
    else error.textContent = result.message;
  });

  titleInput.focus();
}

// Styled "Er du sikker?" overlay, replacing the native confirm() dialog —
// mirrors budget.js's rejectRequest pattern. Opens on top of the still-open
// editor overlay (the caller no longer closes it first) rather than
// replacing it, so `onDeleted` — the editor's own `close` — only runs once
// the delete actually succeeds, closing both together; Annuller or a failed
// save leaves just this overlay closed and the editor still open beneath it.
function openDeleteConfirm(ev, onDeleted) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('cal-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'cal-confirm-text';
  info.textContent = `Slet begivenheden "${ev.title}"?`;
  form.appendChild(info);

  const cancelBtn = calPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = calPillBtn('Slet', 'site-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectiveEvents().filter(e => e.id !== ev.id);
    const result = await saveEvents(next);
    if (result.ok) {
      close();
      if (onDeleted) onDeleted();
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
  const { form, actions } = siteOpenModalWithClose('Abonnér på kalenderen');

  const info = document.createElement('p');
  info.textContent = 'Tilføj linket herunder som et kalenderabonnement, så følger din kalender-app automatisk med i alle begivenheder: Google Kalender ("Fra URL"), Apple Kalender ("Nyt kalenderabonnement") eller Outlook ("Abonnér fra internettet").';
  form.appendChild(info);

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.value = CALENDAR_FEED_URL;
  urlInput.readOnly = true;
  form.appendChild(siteEditField('Link', urlInput));

  const copyBtn = calPillBtn('Kopiér link', 'site-pill-warm');
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
