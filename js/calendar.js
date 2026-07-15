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

// ── Custom date/time picker fields ───────────────────────────
// Native <input type="date">/type="time"> hand their picker UI off to the
// OS/browser (a closed shadow root outside the DOM — not stylable), so the
// editor uses these instead: a button showing the formatted value, opening
// a popup built and styled like the rest of the site. Each factory returns
// a plain <button> augmented with a `.value` getter/setter (ISO date, or
// 'HH:MM'/'' for time) and a dispatched 'change' event on selection, so
// call sites below use them exactly like a native input.
let calFieldPopupClose = null; // the one currently-open popup's close fn, if any

function calCloseFieldPopup() {
  if (calFieldPopupClose) { calFieldPopupClose(); calFieldPopupClose = null; }
}

// Positions `pop` (already appended to <body>) below its anchor button,
// flipping above and clamping horizontally so it never runs off-screen.
function calPositionFieldPopup(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - popRect.width - 8);
  left = Math.max(left, 8);
  let top = rect.bottom + 4;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(top, 8)}px`;
}

// Opens `pop` anchored to `anchor` with the close-on-outside-click/Escape/
// reposition-on-scroll behaviour every field popup here needs. Returns the
// close function. Escape stops propagation so it closes just the popup,
// not the surrounding edit modal too (a second Escape closes that).
function calOpenFieldPopup(anchor, pop) {
  calCloseFieldPopup();
  pop.style.position = 'fixed';
  document.body.appendChild(pop);
  calPositionFieldPopup(pop, anchor);

  function onDocMousedown(e) {
    if (!pop.contains(e.target) && e.target !== anchor) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
  }
  function onReposition() { calPositionFieldPopup(pop, anchor); }
  document.addEventListener('mousedown', onDocMousedown, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onReposition);
  document.addEventListener('scroll', onReposition, true);

  function close() {
    document.removeEventListener('mousedown', onDocMousedown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onReposition);
    document.removeEventListener('scroll', onReposition, true);
    pop.remove();
    if (calFieldPopupClose === close) calFieldPopupClose = null;
  }
  calFieldPopupClose = close;
  return close;
}

// Mini month-grid popup — same day-grid math as renderMonthView above, but
// its own compact rendering with no event chips, just pick-a-day.
function openCalDatePicker(anchor, currentIso, onSelect) {
  const base = currentIso ? parseIsoDate(currentIso) : new Date();
  let viewYear = base.getFullYear();
  let viewMonth = base.getMonth();

  const pop = document.createElement('div');
  pop.className = 'cal-field-pop cal-dp-pop';

  const header = document.createElement('div');
  header.className = 'cal-dp-header';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'cal-dp-nav';
  prevBtn.textContent = '‹';
  prevBtn.setAttribute('aria-label', 'Forrige måned');
  const label = document.createElement('span');
  label.className = 'cal-dp-label';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'cal-dp-nav';
  nextBtn.textContent = '›';
  nextBtn.setAttribute('aria-label', 'Næste måned');
  header.appendChild(prevBtn);
  header.appendChild(label);
  header.appendChild(nextBtn);
  pop.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'cal-dp-grid';
  pop.appendChild(grid);

  function renderGrid() {
    label.textContent = `${DA_MONTHS[viewMonth]} ${viewYear}`;
    grid.textContent = '';
    for (const wd of DA_WEEKDAYS_SHORT) {
      const wdCell = document.createElement('span');
      wdCell.className = 'cal-dp-weekday';
      wdCell.textContent = wd;
      grid.appendChild(wdCell);
    }
    const firstOffset = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7;
    const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
    const totalCells = Math.ceil((firstOffset + daysInMonth) / 7) * 7;
    const today = todayIso();
    const pad = n => String(n).padStart(2, '0');
    for (let i = 0; i < totalCells; i++) {
      const dayNum = i - firstOffset + 1;
      if (dayNum < 1 || dayNum > daysInMonth) {
        grid.appendChild(document.createElement('span'));
        continue;
      }
      const iso = `${viewYear}-${pad(viewMonth + 1)}-${pad(dayNum)}`;
      const day = document.createElement('button');
      day.type = 'button';
      day.className = 'cal-dp-day';
      if (iso === today) day.classList.add('cal-dp-today');
      if (iso === currentIso) day.classList.add('cal-dp-selected');
      day.textContent = dayNum;
      day.addEventListener('click', () => { close(); onSelect(iso); });
      grid.appendChild(day);
    }
  }
  renderGrid();

  prevBtn.addEventListener('click', () => {
    viewMonth--; if (viewMonth < 0) { viewMonth = 11; viewYear--; }
    renderGrid();
  });
  nextBtn.addEventListener('click', () => {
    viewMonth++; if (viewMonth > 11) { viewMonth = 0; viewYear++; }
    renderGrid();
  });

  const close = calOpenFieldPopup(anchor, pop);
}

// Flat, scrollable list of quarter-hour times (matching Øveplan's own
// 15-min step convention) plus a clear row, since start/end are optional.
function calTimeOptions() {
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return opts;
}

function openCalTimePicker(anchor, currentValue, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'cal-field-pop cal-tp-pop';

  const clearRow = document.createElement('button');
  clearRow.type = 'button';
  clearRow.className = 'cal-tp-row cal-tp-clear';
  clearRow.textContent = 'Ingen tid';
  clearRow.addEventListener('click', () => { close(); onSelect(''); });
  pop.appendChild(clearRow);

  const list = document.createElement('div');
  list.className = 'cal-tp-list';
  pop.appendChild(list);

  let selectedRow = null;
  for (const t of calTimeOptions()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cal-tp-row';
    row.textContent = t;
    if (t === currentValue) { row.classList.add('cal-tp-selected'); selectedRow = row; }
    row.addEventListener('click', () => { close(); onSelect(t); });
    list.appendChild(row);
  }

  const close = calOpenFieldPopup(anchor, pop);
  if (selectedRow) selectedRow.scrollIntoView({ block: 'center' });
}

function calCreateDateField(initialIso) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cal-field-btn';
  const text = document.createElement('span');
  text.className = 'cal-field-text';
  const chevron = document.createElement('span');
  chevron.className = 'cal-field-chevron';
  chevron.textContent = '▾';
  btn.appendChild(text);
  btn.appendChild(chevron);

  let _value = initialIso || '';
  function render() {
    text.textContent = _value ? formatDaDateShort(_value) : 'Vælg dato';
    text.classList.toggle('cal-field-placeholder', !_value);
  }
  Object.defineProperty(btn, 'value', {
    get() { return _value; },
    set(v) { _value = v; render(); },
  });
  render();

  btn.addEventListener('click', () => {
    openCalDatePicker(btn, _value, (iso) => {
      _value = iso;
      render();
      btn.dispatchEvent(new Event('change'));
    });
  });
  return btn;
}

// Accepts what a user is likely to type — "14:30", "14.30", "930", "0930" —
// and normalizes to strict "HH:MM", or null if unparseable. Kept forgiving
// but not lenient enough to accept outright garbage (hour/minute bounds).
function calParseTimeInput(raw) {
  const s = raw.trim();
  if (!s) return '';
  let m = s.match(/^([0-2]?\d)[:.]([0-5]\d)$/);
  if (!m) m = s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

// Built via createElementNS (not innerHTML — the page's DOM-building rule
// applies to markup fragments same as to data) so the toggle reads as a
// clock, echoing the native time input's old picker icon.
function calClockIcon() {
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
  const circle = document.createElementNS(svgNS, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '6.5');
  svg.appendChild(circle);
  const hands = document.createElementNS(svgNS, 'path');
  hands.setAttribute('d', 'M8 4.5V8l2.8 1.6');
  svg.appendChild(hands);
  return svg;
}

// A typeable text field (unlike the date field — free typing plus a picker
// toggle) since a start/end time is easier to type ("14:30") than to click
// through a list, and this restores the native input's old typing behaviour.
function calCreateTimeField(initialValue) {
  const wrap = document.createElement('div');
  wrap.className = 'cal-field-combo';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'cal-field-input';
  input.placeholder = 'tt:mm';
  input.autocomplete = 'off';
  input.inputMode = 'numeric';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'cal-field-toggle';
  toggle.appendChild(calClockIcon());
  toggle.setAttribute('aria-label', 'Vælg tidspunkt');

  wrap.appendChild(input);
  wrap.appendChild(toggle);

  let _value = initialValue || '';
  input.value = _value;

  Object.defineProperty(wrap, 'value', {
    get() { return _value; },
    set(v) { _value = v || ''; input.value = _value; },
  });

  function commit(newValue, dispatch) {
    const changed = newValue !== _value;
    _value = newValue;
    input.value = _value;
    if (dispatch && changed) wrap.dispatchEvent(new Event('change'));
  }

  input.addEventListener('blur', () => {
    const parsed = calParseTimeInput(input.value);
    if (parsed === null) { input.value = _value; return; } // revert, keep last valid value
    commit(parsed, true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  toggle.addEventListener('click', () => {
    openCalTimePicker(toggle, _value, (t) => commit(t, true));
  });

  return wrap;
}

// ── Category field (custom dropdown popup) ────────────────────
function openCalCategoryPicker(anchor, currentKey, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'cal-field-pop cal-cp-pop';

  for (const [key, def] of Object.entries(CAL_CATEGORIES)) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'cal-tp-row cal-cp-row';
    if (key === currentKey) row.classList.add('cal-tp-selected');
    const dot = document.createElement('span');
    dot.className = `cal-dot ${calCategoryClass(key)}`;
    row.appendChild(dot);
    row.appendChild(document.createTextNode(def.label));
    row.addEventListener('click', () => { close(); onSelect(key); });
    pop.appendChild(row);
  }

  const close = calOpenFieldPopup(anchor, pop);
}

function calCreateCategoryField(initialKey) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'cal-field-btn';

  const left = document.createElement('span');
  left.className = 'cal-field-left';
  const dot = document.createElement('span');
  dot.className = 'cal-dot';
  const text = document.createElement('span');
  text.className = 'cal-field-text';
  left.appendChild(dot);
  left.appendChild(text);
  const chevron = document.createElement('span');
  chevron.className = 'cal-field-chevron';
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
    openCalCategoryPicker(btn, _value, (key) => {
      _value = key;
      render();
      btn.dispatchEvent(new Event('change'));
    });
  });
  return btn;
}

// ── Editor modal ─────────────────────────────────────────────
function openEventEditor(existing) {
  const { form, error, actions, close } = calOpenModal(existing ? 'Rediger begivenhed' : 'Ny begivenhed');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing ? existing.title : '';
  form.appendChild(siteEditField('Titel', titleInput));

  const dateInput = calCreateDateField('');
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
  const endDateInput = calCreateDateField(existing ? calEventEndDate(existing) : dateInput.value);

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
  const startInput = calCreateTimeField(existing ? existing.start || '' : '');
  timeRow.appendChild(siteEditField('Start', startInput));
  const endInput = calCreateTimeField(existing ? existing.end || '' : '');
  timeRow.appendChild(siteEditField('Slut', endInput));
  form.appendChild(timeRow);

  const catField = calCreateCategoryField(existing && CAL_CATEGORIES[existing.category] ? existing.category : 'ove');
  form.appendChild(siteEditField('Kategori', catField));

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
      category: catField.value,
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
