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
  ove:          { label: 'Øve' },
  forestilling: { label: 'Forestilling' },
  deadline:     { label: 'Deadline' },
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

  // Index events by date for the visible month in one pass.
  const byDate = new Map();
  for (const ev of getSortedEvents()) {
    if (!byDate.has(ev.date)) byDate.set(ev.date, []);
    byDate.get(ev.date).push(ev);
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
      chip.addEventListener('click', () => {
        if (siteHasLevel('boss')) openEventEditor(ev);
        else openEventDetail(ev);
      });
      cell.appendChild(chip);
    }

    grid.appendChild(cell);
  }

  wrap.appendChild(grid);
  container.appendChild(wrap);
}

function renderListView(container) {
  const today = todayIso();
  const upcoming = getSortedEvents().filter(ev => ev.date >= today);
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

    const dot = document.createElement('span');
    dot.className = `cal-dot ${calCategoryClass(ev.category)}`;
    row.appendChild(dot);

    const date = document.createElement('span');
    date.className = 'cal-list-date';
    date.textContent = formatDaDateShort(ev.date);
    row.appendChild(date);

    const time = document.createElement('span');
    time.className = 'cal-list-time';
    time.textContent = calTimeRange(ev);
    row.appendChild(time);

    const title = document.createElement('span');
    title.className = 'cal-list-title';
    title.textContent = ev.title;
    row.appendChild(title);

    const cat = document.createElement('span');
    cat.className = 'cal-list-cat';
    cat.textContent = calCategoryLabel(ev.category);
    row.appendChild(cat);

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
      delBtn.addEventListener('click', () => deleteEvent(ev));
      actionsWrap.appendChild(delBtn);
      row.appendChild(actionsWrap);
    }

    if (ev.note) {
      const note = document.createElement('span');
      note.className = 'cal-list-note';
      note.textContent = ev.note;
      row.appendChild(note);
    }

    container.appendChild(row);
  }
}

function calTimeRange(ev) {
  if (!ev.start) return '';
  return ev.end ? `${ev.start}–${ev.end}` : ev.start;
}

// ── Read-only detail modal (non-admin chip click) ────────────
function openEventDetail(ev) {
  const { form, actions, close } = siteOpenEditModal(ev.title);

  const rows = [
    ['Dato', formatDaDate(ev.date)],
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

  const closeBtn = document.createElement('button');
  closeBtn.className = 'site-btn-secondary';
  closeBtn.textContent = 'Luk';
  closeBtn.addEventListener('click', close);
  actions.appendChild(closeBtn);
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
  const { form, error, actions, close } = siteOpenEditModal(existing ? 'Rediger begivenhed' : 'Ny begivenhed');

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
  form.appendChild(siteEditField('Dato', dateInput));

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

  const save = document.createElement('button');
  save.className = 'site-btn-primary';
  save.textContent = 'Gem';
  const cancel = document.createElement('button');
  cancel.className = 'site-btn-secondary';
  cancel.textContent = 'Annuller';

  if (existing) {
    const del = document.createElement('button');
    del.className = 'site-btn-secondary edit-actions-left';
    del.textContent = 'Slet';
    del.addEventListener('click', () => { close(); deleteEvent(existing); });
    actions.appendChild(del);
  }
  actions.appendChild(save);
  actions.appendChild(cancel);
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const date = dateInput.value;
    if (!title || !date) {
      error.textContent = 'Udfyld både titel og dato.';
      return;
    }
    const item = {
      id: existing ? existing.id : Date.now().toString(36),
      date,
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

async function deleteEvent(ev) {
  if (!confirm(`Slet begivenheden "${ev.title}"?`)) return;
  const next = getEffectiveEvents().filter(e => e.id !== ev.id);
  const result = await saveEvents(next);
  if (!result.ok && result.message) alert(result.message);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  initCalState();
  document.getElementById('cal-view-month').addEventListener('click', () => setCalView('month'));
  document.getElementById('cal-view-list').addEventListener('click', () => setCalView('list'));
  document.getElementById('cal-prev').addEventListener('click', () => shiftMonth(-1));
  document.getElementById('cal-next').addEventListener('click', () => shiftMonth(1));
  renderCalendar();
});
