/* =========================================================
   Matematikrevyen – Kalender (kalender.html)
   Month-grid + list view over CALENDAR_DATA (embedded from
   data/calendar.json); admins add/edit/delete events, saved
   globally via siteSaveResource ('calendar' resource in
   server/update-data.php). Below it, an admin-edited Gantt chart of
   the revy period (GANTT_DATA, 'gantt' resource — see renderGantt), and
   below that the revyst-only "Revyugen" week schedule (REVYUGEN_DATA,
   'revyugen' resource — see renderRevyugen).

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
    // Same breakpoint as the site-wide mobile nav (see CLAUDE.md) — a
    // portrait phone defaults to list view, landscape keeps the grid.
    view = window.matchMedia('(max-width: 719px)').matches ? 'list' : 'month';
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
    addBtn.appendChild(document.createTextNode('+ '));
    // Separate span (not one textContent string) so calendar.css's mobile
    // block can hide just the label and shrink the button to "+".
    const addLabel = document.createElement('span');
    addLabel.className = 'cal-admin-btn-label';
    addLabel.textContent = 'Ny begivenhed';
    addBtn.appendChild(addLabel);
    addBtn.setAttribute('aria-label', 'Ny begivenhed');
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
      chip.title = ev.title;
      // Time and title are separate spans (not one textContent string) so
      // calendar.css's mobile block can hide just the time and let the
      // title use the full chip width.
      if (ev.start) {
        const timeSpan = document.createElement('span');
        timeSpan.className = 'cal-chip-time';
        timeSpan.textContent = ev.start + ' ';
        chip.appendChild(timeSpan);
      }
      chip.appendChild(document.createTextNode(ev.title));
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

    if (ev.location || ev.note) {
      const note = document.createElement('span');
      note.className = 'cal-list-note';
      note.textContent = ev.location && ev.note
        ? `${ev.location}: ${ev.note}`
        : (ev.location || ev.note);
      content.appendChild(note);
    }

    row.appendChild(content);
    container.appendChild(row);
  }
}

// A square colored button for Kalender's modals — see style.css's shared
// .site-btn-success/-danger/-warm for the styling (blue .site-btn-primary is reserved for Login/Archive; also used by every other
// page's modals). variant defaults to 'site-btn-warm' (e.g. Annuller).
function calPillBtn(label, variant) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = variant || 'site-btn-warm';
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
    const editBtn = calPillBtn('Rediger', 'site-btn-warm');
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
// Kalender's own categories as {key, label, dotClass} options — the
// default for calCreateCategoryField; Revyugen passes its own list.
function calEventCategoryOptions() {
  return Object.entries(CAL_CATEGORIES).map(([key, def]) => ({ key, label: def.label, dotClass: calCategoryClass(key) }));
}

function openCalCategoryPicker(anchor, currentKey, options, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-dd-pop';

  for (const opt of options) {
    const key = opt.key;
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-list-row cal-cp-row';
    if (key === currentKey) row.classList.add('site-list-selected');
    const dot = document.createElement('span');
    dot.className = `cal-dot ${opt.dotClass}`;
    row.appendChild(dot);
    row.appendChild(document.createTextNode(opt.label));
    row.addEventListener('click', () => { close(); onSelect(key); });
    pop.appendChild(row);
  }

  const close = siteOpenFieldPopup(anchor, pop);
}

function calCreateCategoryField(initialKey, options = calEventCategoryOptions()) {
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

  let _value = initialKey || options[0].key;
  function render() {
    const opt = options.find(o => o.key === _value) || options[0];
    dot.className = `cal-dot ${opt.dotClass}`;
    text.textContent = opt.label;
  }
  Object.defineProperty(btn, 'value', {
    get() { return _value; },
    set(v) { _value = v; render(); },
  });
  render();

  btn.addEventListener('click', () => {
    siteToggleFieldPopup(btn, () => {
      openCalCategoryPicker(btn, _value, options, (key) => {
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
  actions.classList.add('cal-event-actions');

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

  const catField = calCreateCategoryField(existing && CAL_CATEGORIES[existing.category] ? existing.category : 'andet');

  const catRow = document.createElement('div');
  catRow.className = 'edit-field-row';
  catRow.appendChild(siteEditField('Lokale', locationInput));
  catRow.appendChild(siteEditField('Kategori', catField));
  form.appendChild(catRow);

  const noteArea = document.createElement('textarea');
  noteArea.value = existing ? existing.note || '' : '';
  form.appendChild(siteEditField('Note', noteArea));

  const save = calPillBtn('Gem', 'site-btn-success');

  if (existing) {
    const del = calPillBtn('Slet', 'site-btn-danger');
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
  info.textContent = `Slet "${ev.title}"?`;
  form.appendChild(info);

  const sub = document.createElement('p');
  sub.className = 'cal-confirm-sub';
  sub.textContent = 'Dette kan ikke fortrydes.';
  form.appendChild(sub);

  const cancelBtn = calPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = calPillBtn('Slet', 'site-btn-danger');
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

// ── Gantt (revy-periode) ─────────────────────────────────────
// Overview of the revy period below the calendar, from data/gantt.json
// (GANTT_DATA) via the admin-only 'gantt' resource. One chart: `year` picks
// the September–November window; each row is an admin-named section holding
// any number of date-range bars (overlapping bars stack into extra lanes).
// Visible to everyone (hidden entirely while empty); admin edits a local
// draft (ganttDraft) and nothing is saved until "Gem".
const GANTT_FIRST_MONTH = 8;  // September (0-based)
const GANTT_LAST_MONTH = 10;  // November
// Bar colours (.gantt-color-<key> in calendar.css). A bar stores its own
// `color` key; a bar saved without one falls back to its row's position in
// this list, cycled.
const GANTT_COLORS = [
  { key: 'green',  label: 'Grøn' },
  { key: 'blue',   label: 'Blå' },
  { key: 'yellow', label: 'Gul' },
  { key: 'purple', label: 'Lilla' },
  { key: 'red',    label: 'Rød' },
  { key: 'teal',   label: 'Turkis' },
];

let ganttOverride = siteLoadOverride('gantt');
let ganttDraft = null; // non-null while admin edit mode is open
let ganttSaving = false;
let ganttError = '';
let ganttDragId = null;
let calTooltipEl = null;

function getEffectiveGantt() {
  const data = ganttOverride || (typeof GANTT_DATA !== 'undefined' ? GANTT_DATA : null);
  return data && Array.isArray(data.rows) ? data : { year: new Date().getFullYear(), rows: [] };
}

function ganttNewId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function ganttWindow(year) {
  const pad = n => String(n).padStart(2, '0');
  const lastDay = new Date(year, GANTT_LAST_MONTH + 1, 0).getDate();
  const start = `${year}-${pad(GANTT_FIRST_MONTH + 1)}-01`;
  const end = `${year}-${pad(GANTT_LAST_MONTH + 1)}-${pad(lastDay)}`;
  return { start, end, totalDays: calDaysBetweenIso(start, end) + 1 };
}

// Left edge of a day as a percentage of the window's width.
function ganttPct(iso, win) {
  return (calDaysBetweenIso(win.start, iso) / win.totalDays) * 100;
}

// Clips each bar to the window (dropping those entirely outside it) and
// greedily assigns lanes so overlapping bars in one row never cover each
// other.
function ganttLayoutBars(bars, win) {
  const visible = [];
  for (const bar of bars) {
    const s = bar.start > win.start ? bar.start : win.start;
    const e = bar.end < win.end ? bar.end : win.end;
    if (s > e) continue;
    visible.push({ bar, s, e, lane: 0 });
  }
  visible.sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0));
  const laneEnds = [];
  for (const v of visible) {
    let lane = laneEnds.findIndex(end => end < v.s);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(v.e);
    } else {
      laneEnds[lane] = v.e;
    }
    v.lane = lane;
  }
  return { visible, laneCount: Math.max(1, laneEnds.length) };
}

function ganttBarColor(bar, rowIdx) {
  if (bar && GANTT_COLORS.some(c => c.key === bar.color)) return bar.color;
  return GANTT_COLORS[Math.max(0, rowIdx) % GANTT_COLORS.length].key;
}

function ganttBarRangeLabel(bar) {
  return bar.start === bar.end ? formatDaDate(bar.start) : `${formatDaDate(bar.start)} – ${formatDaDate(bar.end)}`;
}

// Hover tooltip on a Gantt bar or Revyugen block: `text` (a bar's date
// range, a block's time range), with `label` above when there is one — a
// short bar/block truncates its own label — and an optional `note` below. Same look as
// faellesspisning.js's faellesShowFieldTooltip (duplicated per the
// per-feature convention).
function calShowTooltip(anchor, label, text, note) {
  calHideTooltip();
  const tip = document.createElement('div');
  tip.className = 'gantt-tooltip';
  if (label) {
    const labelEl = document.createElement('div');
    labelEl.className = 'gantt-tooltip-label';
    labelEl.textContent = label;
    tip.appendChild(labelEl);
  }
  const range = document.createElement('div');
  range.textContent = text;
  tip.appendChild(range);
  if (note) {
    const noteEl = document.createElement('div');
    noteEl.className = 'gantt-tooltip-note';
    noteEl.textContent = note;
    tip.appendChild(noteEl);
  }
  document.body.appendChild(tip);
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let top = anchorRect.top - tipRect.height - 6;
  if (top < 4) top = anchorRect.bottom + 6;
  let left = anchorRect.left + anchorRect.width / 2 - tipRect.width / 2;
  if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
  if (left < 4) left = 4;
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  calTooltipEl = tip;
}

function calHideTooltip() {
  if (calTooltipEl) { calTooltipEl.remove(); calTooltipEl = null; }
}
// position:fixed — any scroll (page or the chart's own horizontal
// scroller, hence capture) would leave it floating away from its bar.
window.addEventListener('scroll', calHideTooltip, true);

// Off-screen drag image for row reordering — see forms.js's
// formsGetDragImageEl for the rationale (CLAUDE.md's drag-image recipe).
function calGetDragImageEl() {
  let ghost = document.getElementById('gantt-drag-image');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'gantt-drag-image';
    ghost.className = 'gantt-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// Mirrors wiki.js's wikiWireDropHighlight (not loaded on this page).
function ganttWireDropHighlight(el, onDrop) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    if (!ganttDragId) return;
    e.preventDefault();
    depth++;
    el.classList.add('gantt-drop-target');
  });
  el.addEventListener('dragover', (e) => {
    if (ganttDragId) e.preventDefault(); // required for 'drop' to fire at all
  });
  el.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove('gantt-drop-target');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    el.classList.remove('gantt-drop-target');
    onDrop();
  });
}

// Moves the dragged row before `beforeId` (or to the end when null).
function ganttMoveRow(id, beforeId) {
  const rows = ganttDraft.rows;
  const idx = rows.findIndex(r => r.id === id);
  if (idx === -1 || id === beforeId) return;
  const [item] = rows.splice(idx, 1);
  const beforeIdx = beforeId ? rows.findIndex(r => r.id === beforeId) : -1;
  if (beforeIdx === -1) rows.push(item);
  else rows.splice(beforeIdx, 0, item);
  renderGantt();
}

function renderGantt() {
  const card = document.getElementById('gantt-card');
  if (!card) return;
  const canEdit = siteHasLevel('admin');
  if (!canEdit) ganttDraft = null;
  const editing = ganttDraft !== null;
  const data = editing ? ganttDraft : getEffectiveGantt();
  calHideTooltip(); // its bar is about to be replaced

  card.textContent = '';
  card.hidden = !canEdit && data.rows.length === 0;
  if (card.hidden) return;

  const head = document.createElement('div');
  head.className = 'gantt-head';
  const title = document.createElement('h2');
  title.className = 'gantt-title';
  if (editing) {
    title.textContent = 'Revyperiode';
    head.appendChild(title);
    head.appendChild(ganttBuildYearInput());
  } else {
    title.textContent = `Revyperiode ${data.year}`;
    head.appendChild(title);
    if (canEdit) {
      const editBtn = document.createElement('button');
      editBtn.type = 'button';
      editBtn.className = 'btn-small gantt-edit-btn';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => {
        ganttDraft = structuredClone(getEffectiveGantt());
        ganttError = '';
        renderGantt();
      });
      head.appendChild(editBtn);
    }
  }
  card.appendChild(head);

  if (!editing && data.rows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'gantt-empty';
    empty.textContent = 'Ingen sektioner endnu.';
    card.appendChild(empty);
    return;
  }

  const win = ganttWindow(data.year);
  const today = todayIso();
  const todayPct = today >= win.start && today <= win.end
    ? ((calDaysBetweenIso(win.start, today) + 0.5) / win.totalDays) * 100
    : null;
  const pad = n => String(n).padStart(2, '0');
  const months = [];
  for (let m = GANTT_FIRST_MONTH; m <= GANTT_LAST_MONTH; m++) {
    months.push({
      month: m,
      startIso: `${data.year}-${pad(m + 1)}-01`,
      days: new Date(data.year, m + 1, 0).getDate(),
    });
  }

  const scroll = document.createElement('div');
  scroll.className = 'gantt-scroll';
  const chart = document.createElement('div');
  chart.className = editing ? 'gantt gantt-editing' : 'gantt';

  // Month header row.
  const headerRow = document.createElement('div');
  headerRow.className = 'gantt-row gantt-header-row';
  const corner = document.createElement('div');
  corner.className = 'gantt-label';
  headerRow.appendChild(corner);
  const monthsEl = document.createElement('div');
  monthsEl.className = 'gantt-months';
  for (const m of months) {
    const cell = document.createElement('div');
    cell.className = 'gantt-month';
    cell.style.flex = `${m.days} 0 0`;
    const name = DA_MONTHS[m.month];
    cell.textContent = name.charAt(0).toUpperCase() + name.slice(1);
    monthsEl.appendChild(cell);
  }
  headerRow.appendChild(monthsEl);
  chart.appendChild(headerRow);

  data.rows.forEach((row, idx) => {
    chart.appendChild(ganttBuildRow(row, idx, win, months, todayPct, editing));
  });

  if (editing) {
    // Trailing drop zone so a row can be dragged to the very end (a
    // per-row drop target can only ever insert *before* that row).
    const tail = document.createElement('div');
    tail.className = 'gantt-drop-tail';
    ganttWireDropHighlight(tail, () => { if (ganttDragId) ganttMoveRow(ganttDragId, null); });
    chart.appendChild(tail);
  }

  scroll.appendChild(chart);
  card.appendChild(scroll);

  if (editing) card.appendChild(ganttBuildEditFooter());
}

function ganttBuildRow(row, idx, win, months, todayPct, editing) {
  const rowEl = document.createElement('div');
  rowEl.className = 'gantt-row';

  const label = document.createElement('div');
  label.className = 'gantt-label';
  if (editing) {
    const handle = document.createElement('span');
    handle.className = 'gantt-drag-handle';
    handle.textContent = '⠿';
    handle.draggable = true;
    handle.title = 'Træk for at flytte';
    handle.addEventListener('dragstart', (e) => {
      ganttDragId = row.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', row.id);
      const ghost = calGetDragImageEl();
      ghost.textContent = row.title || 'Sektion';
      e.dataTransfer.setDragImage(ghost, 12, 16);
    });
    handle.addEventListener('dragend', () => {
      ganttDragId = null;
      document.querySelectorAll('.gantt-drop-target').forEach(el => el.classList.remove('gantt-drop-target'));
    });
    label.appendChild(handle);

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'gantt-label-input';
    input.value = row.title;
    input.maxLength = 200;
    input.setAttribute('aria-label', 'Sektionens navn');
    input.addEventListener('input', () => { row.title = input.value; });
    label.appendChild(input);

    const addBar = document.createElement('button');
    addBar.type = 'button';
    addBar.className = 'boss-manage-add-plus';
    addBar.textContent = '+';
    addBar.title = 'Tilføj periode';
    addBar.setAttribute('aria-label', 'Tilføj periode');
    addBar.addEventListener('click', () => ganttOpenBarEditor(row, null, win.start));
    label.appendChild(addBar);

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'boss-edit-remove';
    remove.textContent = '✕';
    remove.title = 'Fjern sektion';
    remove.setAttribute('aria-label', 'Fjern sektion');
    remove.addEventListener('click', () => ganttRemoveRow(row));
    label.appendChild(remove);

    ganttWireDropHighlight(rowEl, () => { if (ganttDragId) ganttMoveRow(ganttDragId, row.id); });
  } else {
    label.textContent = row.title;
    label.title = row.title;
  }
  rowEl.appendChild(label);

  const { visible, laneCount } = ganttLayoutBars(row.bars, win);
  const track = document.createElement('div');
  track.className = 'gantt-track';
  track.style.setProperty('--gantt-lanes', String(laneCount));

  for (const m of months.slice(1)) {
    const line = document.createElement('div');
    line.className = 'gantt-month-line';
    line.style.left = `${ganttPct(m.startIso, win)}%`;
    track.appendChild(line);
  }
  if (todayPct !== null) {
    const todayLine = document.createElement('div');
    todayLine.className = 'gantt-today';
    todayLine.style.left = `${todayPct}%`;
    track.appendChild(todayLine);
  }

  for (const v of visible) {
    const bar = document.createElement(editing ? 'button' : 'div');
    if (editing) bar.type = 'button';
    bar.className = `gantt-bar gantt-color-${ganttBarColor(v.bar, idx)}`;
    if (v.s !== v.bar.start) bar.classList.add('gantt-bar-clip-start');
    if (v.e !== v.bar.end) bar.classList.add('gantt-bar-clip-end');
    bar.style.left = `${ganttPct(v.s, win)}%`;
    bar.style.width = `${((calDaysBetweenIso(v.s, v.e) + 1) / win.totalDays) * 100}%`;
    bar.style.setProperty('--gantt-lane', String(v.lane));
    bar.textContent = v.bar.label;
    bar.setAttribute('aria-label', v.bar.label ? `${v.bar.label}: ${ganttBarRangeLabel(v.bar)}` : ganttBarRangeLabel(v.bar));
    bar.addEventListener('mouseenter', () => calShowTooltip(bar, v.bar.label, ganttBarRangeLabel(v.bar)));
    bar.addEventListener('mouseleave', calHideTooltip);
    if (editing) bar.addEventListener('click', () => { calHideTooltip(); ganttOpenBarEditor(row, v.bar); });
    track.appendChild(bar);
  }

  if (editing) {
    // Clicking an empty spot on the track adds a bar starting that day.
    track.classList.add('gantt-track-editable');
    track.addEventListener('click', (e) => {
      if (e.target !== track) return;
      const rect = track.getBoundingClientRect();
      const dayIdx = Math.min(win.totalDays - 1,
        Math.max(0, Math.floor(((e.clientX - rect.left) / rect.width) * win.totalDays)));
      ganttOpenBarEditor(row, null, calAddDaysIso(win.start, dayIdx));
    });
  }
  rowEl.appendChild(track);
  return rowEl;
}

// Changing the year offers to move every bar along with it, so a new
// production's chart can start from last year's layout in one step.
function ganttBuildYearInput() {
  const input = document.createElement('input');
  input.type = 'number';
  input.className = 'gantt-year-input';
  input.min = '1900';
  input.max = '2100';
  input.value = String(ganttDraft.year);
  input.setAttribute('aria-label', 'År');
  input.addEventListener('change', () => {
    const next = parseInt(input.value, 10);
    const prev = ganttDraft.year;
    if (!Number.isInteger(next) || next < 1900 || next > 2100) {
      input.value = String(prev);
      return;
    }
    if (next === prev) return;
    const hasBars = ganttDraft.rows.some(r => r.bars.length > 0);
    if (!hasBars) {
      ganttDraft.year = next;
      renderGantt();
      return;
    }
    ganttOpenShiftYearConfirm(prev, next);
  });
  return input;
}

function ganttShiftIsoYear(iso, delta) {
  return String(parseInt(iso.slice(0, 4), 10) + delta) + iso.slice(4);
}

function ganttOpenShiftYearConfirm(prev, next) {
  const { modal, form, actions, close } = siteOpenEditModal('');
  modal.classList.add('cal-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'cal-confirm-text';
  info.textContent = `Flyt alle perioder til ${next}?`;
  form.appendChild(info);
  const sub = document.createElement('p');
  sub.className = 'cal-confirm-sub';
  sub.textContent = `Ellers beholder de deres datoer i ${prev} og vises ikke i ${next}.`;
  form.appendChild(sub);

  function apply(shift) {
    ganttDraft.year = next;
    if (shift) {
      const delta = next - prev;
      for (const row of ganttDraft.rows) {
        for (const bar of row.bars) {
          bar.start = ganttShiftIsoYear(bar.start, delta);
          bar.end = ganttShiftIsoYear(bar.end, delta);
        }
      }
    }
    close();
    renderGantt();
  }
  const keepBtn = calPillBtn('Nej');
  keepBtn.addEventListener('click', () => apply(false));
  const shiftBtn = calPillBtn('Flyt', 'site-btn-success');
  shiftBtn.addEventListener('click', () => apply(true));
  actions.appendChild(keepBtn);
  actions.appendChild(shiftBtn);
}

function ganttRemoveRow(row) {
  function remove() {
    ganttDraft.rows = ganttDraft.rows.filter(r => r !== row);
    renderGantt();
  }
  if (row.bars.length === 0) {
    remove();
    return;
  }
  const { modal, form, actions, close } = siteOpenEditModal('');
  modal.classList.add('cal-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'cal-confirm-text';
  info.textContent = `Fjern "${row.title || 'sektion'}"?`;
  form.appendChild(info);
  const sub = document.createElement('p');
  sub.className = 'cal-confirm-sub';
  sub.textContent = 'Sektionen og alle dens perioder fjernes.';
  form.appendChild(sub);

  const cancelBtn = calPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = calPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', () => { close(); remove(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Colour swatches (GANTT_COLORS) for the Gantt bar editor — the chosen one gets the site-wide orange "selected" ring.
function calBuildColorSwatches(initial, onPick) {
  let color = initial;
  const swatches = document.createElement('div');
  swatches.className = 'gantt-swatches';
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Farve');
  function render() {
    swatches.textContent = '';
    for (const c of GANTT_COLORS) {
      const sw = document.createElement('button');
      sw.type = 'button';
      sw.className = `gantt-swatch gantt-color-${c.key}`;
      if (c.key === color) sw.classList.add('gantt-swatch-selected');
      sw.title = c.label;
      sw.setAttribute('role', 'radio');
      sw.setAttribute('aria-label', c.label);
      sw.setAttribute('aria-checked', String(c.key === color));
      sw.addEventListener('click', () => { color = c.key; onPick(c.key); render(); });
      swatches.appendChild(sw);
    }
  }
  render();
  return swatches;
}

// Add/edit one bar in the draft. Nothing is saved here — the card's own Gem
// sends the whole chart.
function ganttOpenBarEditor(row, bar, defaultStart) {
  const { form, error, actions, close } = siteOpenModalWithClose(bar ? 'Rediger periode' : 'Ny periode');
  actions.classList.add('cal-event-actions');

  const section = document.createElement('p');
  section.className = 'gantt-editor-section';
  section.textContent = row.title;
  form.appendChild(section);

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.maxLength = 200;
  labelInput.placeholder = 'Valgfri';
  labelInput.value = bar ? bar.label : '';
  form.appendChild(siteEditField('Tekst', labelInput));

  const startIso = bar ? bar.start : defaultStart;
  const startField = siteCreateDateField(startIso);
  const endField = siteCreateDateField(bar ? bar.end : calAddDaysIso(startIso, 6));

  // Same constant-span behavior as the event editor's Dato/Slutdato pair.
  let spanDays = calDaysBetweenIso(startField.value, endField.value);
  startField.addEventListener('change', () => {
    if (startField.value) endField.value = calAddDaysIso(startField.value, spanDays);
  });
  endField.addEventListener('change', () => {
    if (endField.value && endField.value < startField.value) endField.value = startField.value;
    spanDays = calDaysBetweenIso(startField.value, endField.value);
  });

  const dateRow = document.createElement('div');
  dateRow.className = 'edit-field-row';
  dateRow.appendChild(siteEditField('Fra', startField));
  dateRow.appendChild(siteEditField('Til', endField));
  form.appendChild(dateRow);

  let color = ganttBarColor(bar, ganttDraft.rows.indexOf(row));
  form.appendChild(siteEditField('Farve', calBuildColorSwatches(color, (c) => { color = c; })));

  if (bar) {
    const del = calPillBtn('Slet', 'site-btn-danger');
    del.addEventListener('click', () => {
      row.bars = row.bars.filter(b => b !== bar);
      close();
      renderGantt();
    });
    actions.appendChild(del);
  }
  const save = calPillBtn('Gem', 'site-btn-success');
  save.addEventListener('click', () => {
    const start = startField.value;
    const end = endField.value;
    if (!start || !end) {
      error.textContent = 'Vælg både start- og slutdato.';
      return;
    }
    const item = { id: bar ? bar.id : ganttNewId(), start, end: end >= start ? end : start, label: labelInput.value.trim(), color };
    if (bar) row.bars = row.bars.map(b => (b === bar ? item : b));
    else row.bars.push(item);
    close();
    renderGantt();
  });
  actions.appendChild(save);

  labelInput.focus();
}

function ganttBuildEditFooter() {
  const footer = document.createElement('div');
  footer.className = 'gantt-edit-footer';

  const addWrap = document.createElement('div');
  addWrap.className = 'gantt-add-row-wrap';
  const addRow = document.createElement('button');
  addRow.type = 'button';
  addRow.className = 'boss-manage-add-plus';
  addRow.textContent = '+';
  addRow.title = 'Tilføj sektion';
  addRow.setAttribute('aria-label', 'Tilføj sektion');
  addRow.addEventListener('click', () => {
    ganttDraft.rows.push({ id: ganttNewId(), title: 'Ny sektion', bars: [] });
    renderGantt();
    const inputs = document.querySelectorAll('#gantt-card .gantt-label-input');
    const last = inputs[inputs.length - 1];
    if (last) { last.focus(); last.select(); }
  });
  addWrap.appendChild(addRow);
  footer.appendChild(addWrap);

  const hint = document.createElement('p');
  hint.className = 'gantt-hint';
  hint.textContent = 'Klik på en tom plads i en sektion for at tilføje en periode, eller på en periode for at rette den.';
  footer.appendChild(hint);

  const error = document.createElement('div');
  error.className = 'login-error gantt-error';
  error.textContent = ganttError;
  footer.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'gantt-edit-actions';
  const cancel = calPillBtn('Annuller');
  cancel.disabled = ganttSaving;
  cancel.addEventListener('click', () => {
    ganttDraft = null;
    ganttError = '';
    renderGantt();
  });
  const save = calPillBtn(ganttSaving ? 'Gemmer…' : 'Gem', 'site-btn-success');
  save.disabled = ganttSaving;
  save.addEventListener('click', ganttSave);
  actions.appendChild(cancel);
  actions.appendChild(save);
  footer.appendChild(actions);
  return footer;
}

async function ganttSave() {
  if (!ganttDraft || ganttSaving) return;
  if (ganttDraft.rows.some(r => !r.title.trim())) {
    ganttError = 'Alle sektioner skal have et navn.';
    renderGantt();
    return;
  }
  const payload = {
    year: ganttDraft.year,
    rows: ganttDraft.rows.map((r, idx) => ({
      id: r.id,
      title: r.title.trim(),
      bars: r.bars.map(b => ({ id: b.id, start: b.start, end: b.end, label: b.label, color: ganttBarColor(b, idx) })),
    })),
  };
  ganttSaving = true;
  ganttError = '';
  renderGantt();
  const result = await siteSaveResource('gantt', payload);
  ganttSaving = false;
  if (result.ok) {
    ganttOverride = payload;
    siteSaveOverride('gantt', payload);
    ganttDraft = null;
    siteShowToast('Gemt');
  } else {
    // message === '' means the password prompt was cancelled — stay silent.
    ganttError = result.message;
  }
  renderGantt();
}

// ── Revyugen (week schedule) ─────────────────────────────────
// Hour-by-hour plan for the revy's final days, below the Gantt chart, from
// data/revyugen.json (REVYUGEN_DATA) via the admin-only 'revyugen'
// resource. Days run across the top (`startDate`–`endDate`), time
// down the side (`startHour`–`endHour`); each block is one timed entry on
// one day, and overlapping blocks share their day column side by side.
// Visible to revyst+ only (hidden while empty below admin); admin edits a
// local draft (revyugenDraft) and nothing is saved until "Gem".
const REVYUGEN_DEFAULT_DAYS = 9;
const REVYUGEN_MAX_DAYS = 31; // mirrored by save_revyugen
const REVYUGEN_SNAP_MINUTES = 30;
// What a block's colour means — the same five hues as Kalender's own
// categories (.revyugen-color-<color> in calendar.css), but with
// Revyugen's own meanings. Order = legend/dropdown order. Mirrored by
// save_revyugen's allow-list.
const REVYUGEN_CATEGORIES = [
  { key: 'ove',          label: 'Øvning',       color: 'blue' },
  { key: 'frivillig',    label: 'Frivillig',    color: 'green' },
  { key: 'scenefolk',    label: 'Scenefolk',    color: 'yellow' },
  { key: 'obligatorisk', label: 'Obligatorisk', color: 'red' },
  { key: 'andet',        label: 'Andet',        color: 'purple' },
];

let revyugenOverride = siteLoadOverride('revyugen');
let revyugenDraft = null; // non-null while admin edit mode is open
let revyugenSaving = false;
let revyugenError = '';

function getEffectiveRevyugen() {
  const data = revyugenOverride || (typeof REVYUGEN_DATA !== 'undefined' ? REVYUGEN_DATA : null);
  if (data && Array.isArray(data.blocks)) return data;
  const startDate = todayIso();
  return { startDate, endDate: calAddDaysIso(startDate, REVYUGEN_DEFAULT_DAYS - 1), startHour: 8, endHour: 24, blocks: [] };
}

// `endDate` is optional on read — a file saved without one shows the
// default nine days.
function revyugenEndDate(data) {
  return data.endDate || calAddDaysIso(data.startDate, REVYUGEN_DEFAULT_DAYS - 1);
}

function revyugenDays(data) {
  const days = [];
  const end = revyugenEndDate(data);
  for (let iso = data.startDate; iso <= end && days.length < REVYUGEN_MAX_DAYS; iso = calAddDaysIso(iso, 1)) days.push(iso);
  return days;
}

// "Lør 14/11" — compact enough for many columns side by side.
function revyugenDayLabel(iso) {
  const d = parseIsoDate(iso);
  const wd = DA_WEEKDAYS_SHORT[(d.getDay() + 6) % 7];
  return `${wd.charAt(0).toUpperCase() + wd.slice(1)} ${d.getDate()}/${d.getMonth() + 1}`;
}

function revyugenToMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function revyugenFromMinutes(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

function revyugenCategory(key) {
  return REVYUGEN_CATEGORIES.find(c => c.key === key) || REVYUGEN_CATEGORIES[REVYUGEN_CATEGORIES.length - 1];
}

function revyugenRangeLabel(block) {
  return `${block.start} – ${block.end}`;
}

// Clips one day's blocks to the visible hours, then lays out overlapping
// ones side by side: blocks that (transitively) overlap form a cluster, and
// each gets the first free column within it — the usual week-view layout.
function revyugenLayoutDay(blocks, minStart, minEnd) {
  const items = [];
  for (const block of blocks) {
    const s = Math.max(minStart, revyugenToMinutes(block.start));
    const e = Math.min(minEnd, revyugenToMinutes(block.end));
    if (s >= e) continue;
    items.push({ block, s, e, col: 0, cols: 1 });
  }
  items.sort((a, b) => a.s - b.s || b.e - a.e);
  let cluster = [];
  let clusterEnd = -1;
  function flush() {
    const cols = cluster.reduce((n, it) => Math.max(n, it.col + 1), 1);
    for (const it of cluster) it.cols = cols;
    cluster = [];
  }
  const colEnds = [];
  for (const it of items) {
    if (it.s >= clusterEnd) {
      flush();
      colEnds.length = 0;
      clusterEnd = -1;
    }
    let col = colEnds.findIndex(end => end <= it.s);
    if (col === -1) { col = colEnds.length; colEnds.push(it.e); } else colEnds[col] = it.e;
    it.col = col;
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.e);
  }
  flush();
  return items;
}

function renderRevyugen() {
  const card = document.getElementById('revyugen-card');
  if (!card) return;
  const canEdit = siteHasLevel('admin');
  if (!canEdit) revyugenDraft = null;
  const editing = revyugenDraft !== null;
  const data = editing ? revyugenDraft : getEffectiveRevyugen();
  calHideTooltip(); // its block is about to be replaced

  card.textContent = '';
  card.hidden = !siteHasLevel('revyst') || (!canEdit && data.blocks.length === 0);
  if (card.hidden) return;

  const head = document.createElement('div');
  head.className = 'gantt-head revyugen-head';
  const title = document.createElement('h2');
  title.className = 'gantt-title';
  title.textContent = `Revyugen ${data.startDate.slice(0, 4)}`;
  head.appendChild(title);
  if (editing) {
    head.appendChild(revyugenBuildSettings());
  } else {
    head.classList.add('revyugen-head-view');
    head.appendChild(revyugenBuildLegend());
  }
  if (!editing && canEdit) {
    const editBtn = document.createElement('button');
    editBtn.type = 'button';
    editBtn.className = 'btn-small gantt-edit-btn';
    editBtn.textContent = 'Rediger';
    editBtn.addEventListener('click', () => {
      revyugenDraft = structuredClone(getEffectiveRevyugen());
      revyugenDraft.endDate = revyugenEndDate(revyugenDraft);
      revyugenError = '';
      renderRevyugen();
    });
    head.appendChild(editBtn);
  }
  card.appendChild(head);

  const days = revyugenDays(data);
  const minStart = data.startHour * 60;
  const minEnd = data.endHour * 60;
  const hours = data.endHour - data.startHour;
  const today = todayIso();

  const scroll = document.createElement('div');
  scroll.className = 'revyugen-scroll';
  const grid = document.createElement('div');
  grid.className = editing ? 'revyugen revyugen-editing' : 'revyugen';
  grid.style.setProperty('--revyugen-hours', String(hours));
  grid.style.setProperty('--revyugen-days', String(days.length));

  // Header row: an empty corner over the time column, then one cell per day.
  const corner = document.createElement('div');
  corner.className = 'revyugen-corner';
  grid.appendChild(corner);
  for (const iso of days) {
    const cell = document.createElement('div');
    cell.className = 'revyugen-day-head';
    if (iso === today) cell.classList.add('revyugen-today');
    cell.textContent = revyugenDayLabel(iso);
    grid.appendChild(cell);
  }

  const times = document.createElement('div');
  times.className = 'revyugen-times';
  for (let h = data.startHour; h < data.endHour; h++) {
    const label = document.createElement('div');
    label.className = 'revyugen-time';
    label.style.setProperty('--revyugen-at', String(h - data.startHour));
    label.textContent = `${String(h).padStart(2, '0')}:00`;
    times.appendChild(label);
  }
  grid.appendChild(times);

  for (const iso of days) {
    const col = document.createElement('div');
    col.className = 'revyugen-day';
    if (iso === today) col.classList.add('revyugen-today');
    const dayBlocks = data.blocks.filter(b => b.date === iso);
    for (const it of revyugenLayoutDay(dayBlocks, minStart, minEnd)) {
      col.appendChild(revyugenBuildBlock(it, minStart, editing));
    }
    if (editing) {
      // Clicking an empty spot adds a block starting at that (snapped) time.
      col.classList.add('revyugen-day-editable');
      col.addEventListener('click', (e) => {
        if (e.target !== col) return;
        const rect = col.getBoundingClientRect();
        const frac = Math.min(Math.max((e.clientY - rect.top) / rect.height, 0), 0.999);
        const snapped = minStart + Math.floor((frac * hours * 60) / REVYUGEN_SNAP_MINUTES) * REVYUGEN_SNAP_MINUTES;
        revyugenOpenBlockEditor(null, iso, snapped);
      });
    }
    grid.appendChild(col);
  }

  scroll.appendChild(grid);
  card.appendChild(scroll);

  if (editing) card.appendChild(revyugenBuildEditFooter());
}

function revyugenBuildBlock(it, minStart, editing) {
  const { block } = it;
  const el = document.createElement(editing ? 'button' : 'div');
  if (editing) el.type = 'button';
  const cat = revyugenCategory(block.category);
  el.className = `revyugen-block revyugen-color-${cat.color}`;
  el.style.setProperty('--revyugen-top', String((it.s - minStart) / 60));
  el.style.setProperty('--revyugen-len', String((it.e - it.s) / 60));
  // 1px gap on each side so neighbouring blocks and the column lines
  // don't run together.
  el.style.left = `calc(${(it.col / it.cols) * 100}% + 1px)`;
  el.style.width = `calc(${100 / it.cols}% - 2px)`;

  const title = document.createElement('span');
  title.className = 'revyugen-block-title';
  title.textContent = block.title;
  el.appendChild(title);
  if (block.text) {
    const text = document.createElement('span');
    text.className = 'revyugen-block-text';
    text.textContent = block.text;
    el.appendChild(text);
  }
  const range = `${revyugenRangeLabel(block)} · ${cat.label}`;
  el.setAttribute('aria-label', `${block.title}: ${range}${block.text ? `. ${block.text}` : ''}`);
  el.addEventListener('mouseenter', () => calShowTooltip(el, block.title, range, block.text));
  el.addEventListener('mouseleave', calHideTooltip);
  if (editing) el.addEventListener('click', () => { calHideTooltip(); revyugenOpenBlockEditor(block); });
  return el;
}

// Colour key, centered in the head (view mode only).
function revyugenBuildLegend() {
  const legend = document.createElement('div');
  legend.className = 'revyugen-legend';
  for (const cat of REVYUGEN_CATEGORIES) {
    const item = document.createElement('span');
    item.className = 'cal-legend-item';
    const dot = document.createElement('span');
    dot.className = `cal-dot revyugen-dot-${cat.color}`;
    item.appendChild(dot);
    item.appendChild(document.createTextNode(cat.label));
    legend.appendChild(item);
  }
  return legend;
}

// Edit-mode header controls: the first/last day and the visible hour range.
// Moving the first day moves the whole period — last day and every block —
// by the same number of days (same constant-span behaviour as the event
// editor's Dato/Slutdato pair), so next year's plan can start from this
// year's; moving the last day only changes where the period ends.
function revyugenBuildSettings() {
  const wrap = document.createElement('div');
  wrap.className = 'revyugen-settings';

  const startField = siteCreateDateField(revyugenDraft.startDate);
  startField.setAttribute('aria-label', 'Første dag');
  startField.addEventListener('change', () => {
    const next = startField.value;
    const prev = revyugenDraft.startDate;
    if (!next || next === prev) return;
    const delta = calDaysBetweenIso(prev, next);
    revyugenDraft.startDate = next;
    revyugenDraft.endDate = calAddDaysIso(revyugenDraft.endDate, delta);
    for (const block of revyugenDraft.blocks) block.date = calAddDaysIso(block.date, delta);
    renderRevyugen();
  });
  wrap.appendChild(revyugenSettingsField('Første dag', startField));

  const endField = siteCreateDateField(revyugenDraft.endDate);
  endField.setAttribute('aria-label', 'Sidste dag');
  endField.addEventListener('change', () => {
    const start = revyugenDraft.startDate;
    let next = endField.value;
    if (!next) return;
    if (next < start) next = start;
    const maxEnd = calAddDaysIso(start, REVYUGEN_MAX_DAYS - 1);
    if (next > maxEnd) next = maxEnd;
    revyugenDraft.endDate = next;
    renderRevyugen();
  });
  wrap.appendChild(revyugenSettingsField('Sidste dag', endField));

  function hourInput(key, min, max, label) {
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'revyugen-hour-input';
    input.min = String(min);
    input.max = String(max);
    input.value = String(revyugenDraft[key]);
    input.setAttribute('aria-label', label);
    input.addEventListener('change', () => {
      const v = parseInt(input.value, 10);
      const other = key === 'startHour' ? revyugenDraft.endHour : revyugenDraft.startHour;
      const ok = Number.isInteger(v) && v >= min && v <= max
        && (key === 'startHour' ? v < other : v > other);
      if (!ok) { input.value = String(revyugenDraft[key]); return; }
      revyugenDraft[key] = v;
      renderRevyugen();
    });
    return revyugenSettingsField(label, input);
  }
  wrap.appendChild(hourInput('startHour', 0, 23, 'Fra kl.'));
  wrap.appendChild(hourInput('endHour', 1, 24, 'Til kl.'));
  return wrap;
}

function revyugenSettingsField(labelText, control) {
  const label = document.createElement('label');
  label.className = 'revyugen-setting';
  const text = document.createElement('span');
  text.textContent = labelText;
  label.appendChild(text);
  label.appendChild(control);
  return label;
}

// Add/edit one block in the draft. Nothing is saved here — the card's own
// Gem sends the whole schedule. The time field can't type "24:00", so an
// end of "00:00" means midnight at the end of that day.
function revyugenOpenBlockEditor(block, defaultDate, defaultStartMin) {
  const { form, error, actions, close } = siteOpenModalWithClose(block ? 'Rediger punkt' : 'Nyt punkt');
  actions.classList.add('cal-event-actions');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.maxLength = 200;
  titleInput.placeholder = 'Fx Generalprøve';
  titleInput.value = block ? block.title : '';
  form.appendChild(siteEditField('Titel', titleInput));

  const textInput = document.createElement('textarea');
  textInput.rows = 3;
  textInput.maxLength = 1000;
  textInput.placeholder = 'Valgfri';
  textInput.value = block ? block.text : '';
  form.appendChild(siteEditField('Tekst', textInput));

  const days = revyugenDays(revyugenDraft);
  const dateValue = block ? block.date : defaultDate;
  const dayOptions = days.map(iso => ({ value: iso, label: revyugenDayLabel(iso) }));
  if (!days.includes(dateValue)) dayOptions.push({ value: dateValue, label: formatDaDate(dateValue) });
  const dayField = siteCreateDropdownField(dayOptions, dateValue);
  form.appendChild(siteEditField('Dag', dayField));

  const startMin = block ? revyugenToMinutes(block.start) : defaultStartMin;
  const endMin = block ? revyugenToMinutes(block.end) : Math.min(startMin + 60, 24 * 60);
  const startField = siteCreateTimeField(revyugenFromMinutes(startMin));
  const endField = siteCreateTimeField(revyugenFromMinutes(endMin % (24 * 60)));
  const timeRow = document.createElement('div');
  timeRow.className = 'edit-field-row';
  timeRow.appendChild(siteEditField('Fra', startField));
  timeRow.appendChild(siteEditField('Til', endField));
  form.appendChild(timeRow);

  const catField = calCreateCategoryField(
    revyugenCategory(block ? block.category : REVYUGEN_CATEGORIES[0].key).key,
    REVYUGEN_CATEGORIES.map(c => ({ key: c.key, label: c.label, dotClass: `revyugen-dot-${c.color}` })),
  );
  form.appendChild(siteEditField('Kategori', catField));

  if (block) {
    const del = calPillBtn('Slet', 'site-btn-danger');
    del.addEventListener('click', () => {
      revyugenDraft.blocks = revyugenDraft.blocks.filter(b => b !== block);
      close();
      renderRevyugen();
    });
    actions.appendChild(del);
  }
  const save = calPillBtn('Gem', 'site-btn-success');
  save.addEventListener('click', () => {
    const title = titleInput.value.trim();
    if (!title) {
      error.textContent = 'Giv punktet en titel.';
      return;
    }
    const start = startField.value;
    let end = endField.value;
    if (!start || !end) {
      error.textContent = 'Udfyld både start- og sluttid.';
      return;
    }
    if (end === '00:00') end = '24:00';
    if (end <= start) {
      error.textContent = 'Sluttiden skal ligge efter starttiden.';
      return;
    }
    const item = { id: block ? block.id : ganttNewId(), date: dayField.value, start, end, title, text: textInput.value.trim(), category: catField.value };
    if (block) revyugenDraft.blocks = revyugenDraft.blocks.map(b => (b === block ? item : b));
    else revyugenDraft.blocks.push(item);
    close();
    renderRevyugen();
  });
  actions.appendChild(save);

  titleInput.focus();
}

function revyugenBuildEditFooter() {
  const footer = document.createElement('div');
  footer.className = 'gantt-edit-footer';

  const hint = document.createElement('p');
  hint.className = 'gantt-hint';
  hint.textContent = 'Klik på en tom plads for at tilføje et punkt, eller på et punkt for at rette det.';
  footer.appendChild(hint);

  const error = document.createElement('div');
  error.className = 'login-error gantt-error';
  error.textContent = revyugenError;
  footer.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'gantt-edit-actions';
  const cancel = calPillBtn('Annuller');
  cancel.disabled = revyugenSaving;
  cancel.addEventListener('click', () => {
    revyugenDraft = null;
    revyugenError = '';
    renderRevyugen();
  });
  const save = calPillBtn(revyugenSaving ? 'Gemmer…' : 'Gem', 'site-btn-success');
  save.disabled = revyugenSaving;
  save.addEventListener('click', revyugenSave);
  actions.appendChild(cancel);
  actions.appendChild(save);
  footer.appendChild(actions);
  return footer;
}

async function revyugenSave() {
  if (!revyugenDraft || revyugenSaving) return;
  const d = revyugenDraft;
  const payload = {
    startDate: d.startDate,
    endDate: revyugenEndDate(d),
    startHour: d.startHour,
    endHour: d.endHour,
    blocks: d.blocks
      .slice()
      .sort((a, b) => (a.date + a.start < b.date + b.start ? -1 : a.date + a.start > b.date + b.start ? 1 : 0))
      .map(b => ({ id: b.id, date: b.date, start: b.start, end: b.end, title: b.title, text: b.text, category: b.category })),
  };
  revyugenSaving = true;
  revyugenError = '';
  renderRevyugen();
  const result = await siteSaveResource('revyugen', payload);
  revyugenSaving = false;
  if (result.ok) {
    revyugenOverride = payload;
    siteSaveOverride('revyugen', payload);
    revyugenDraft = null;
    siteShowToast('Gemt');
  } else {
    // message === '' means the password prompt was cancelled — stay silent.
    revyugenError = result.message;
  }
  renderRevyugen();
}

// ── Calendar-subscribe (.ics) ─────────────────────────────────
// Static file served by GitHub Pages — the underlying data is already fully
// public (this page has no login gate), so there's no server round-trip.
const CALENDAR_FEED_URL = 'https://matematikrevy.dk/calendar.ics';

function openSubscribeModal() {
  const { form, actions } = siteOpenModalWithClose('Abonner på kalenderen');

  const info = document.createElement('p');
  info.textContent = 'Tilføj linket herunder som et kalenderabonnement, så følger din kalender-app automatisk med i alle begivenheder: Google Kalender ("Fra URL"), Apple Kalender ("Nyt kalenderabonnement") eller Outlook ("Abonner fra internettet").';
  form.appendChild(info);

  const urlInput = document.createElement('input');
  urlInput.type = 'text';
  urlInput.value = CALENDAR_FEED_URL;
  urlInput.readOnly = true;
  form.appendChild(siteEditField('', urlInput));

  const copyBtn = calPillBtn('Kopier link', 'site-btn-warm');
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(CALENDAR_FEED_URL);
      copyBtn.textContent = 'Kopieret!';
      setTimeout(() => { copyBtn.textContent = 'Kopier link'; }, 1500);
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
  renderGantt();
  renderRevyugen();
});
