/* =========================================================
   Matematikrevyen – Shared helpers for the data-driven pages
   (forside, kalender, arkiv, budget).

   Loaded AFTER site.js (uses SITE_API_ENDPOINT/getSiteAuth) and
   only on pages that need it — schedule.html/manus.html keep
   their own save flow in import.js untouched.

   Rendering rule for the pages using these helpers: build DOM
   via createElement/textContent only — never innerHTML — so no
   HTML escaping is ever needed (escHtml lives in schedule.js
   and is not loaded here).
   ========================================================= */

'use strict';

// ── Danish dates ─────────────────────────────────────────────
const DA_MONTHS = ['januar', 'februar', 'marts', 'april', 'maj', 'juni',
  'juli', 'august', 'september', 'oktober', 'november', 'december'];
// Monday-first (Danish convention); convert JS getDay() with (d + 6) % 7.
const DA_WEEKDAYS_SHORT = ['man', 'tir', 'ons', 'tor', 'fre', 'lør', 'søn'];
const DA_WEEKDAYS_LONG = ['mandag', 'tirsdag', 'onsdag', 'torsdag', 'fredag', 'lørdag', 'søndag'];

// Always construct from parts — new Date('YYYY-MM-DD') parses as UTC
// midnight and can shift a day in local time.
function parseIsoDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function formatDaDate(iso) {
  const d = parseIsoDate(iso);
  return `${d.getDate()}. ${DA_MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

function formatDaDateShort(iso) {
  const d = parseIsoDate(iso);
  return `${DA_WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${d.getDate()}. ${DA_MONTHS[d.getMonth()]}`;
}

function todayIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function nowIso() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${todayIso()}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// Like parseIsoDate but also reads an optional THH:MM(:SS) suffix — still
// always constructs from parts, never `new Date(isoString)`, for the same
// UTC-shift reason. Tolerates a bare date-only string (time defaults to 0).
function parseIsoDateTime(iso) {
  const [datePart, timePart] = iso.split('T');
  const [y, m, d] = datePart.split('-').map(Number);
  const [h, mi, s] = (timePart || '0:0:0').split(':').map(Number);
  return new Date(y, m - 1, d, h || 0, mi || 0, s || 0);
}

function formatDaDateTime(iso) {
  const d = parseIsoDateTime(iso);
  const pad = n => String(n).padStart(2, '0');
  const datePart = iso.split('T')[0];
  return `${formatDaDate(datePart)} kl. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// ── Toast (brief bottom-of-page confirmation) ─────────────────
let siteToastEl = null;
let siteToastTimer = null;

function siteShowToast(message) {
  if (siteToastTimer) clearTimeout(siteToastTimer);
  if (!siteToastEl) {
    siteToastEl = document.createElement('div');
    siteToastEl.className = 'site-toast';
    document.body.appendChild(siteToastEl);
  }
  siteToastEl.textContent = message;
  // Force a reflow so re-triggering the class while already visible
  // still restarts the transition instead of being a no-op.
  siteToastEl.classList.remove('site-toast-visible');
  void siteToastEl.offsetWidth;
  siteToastEl.classList.add('site-toast-visible');
  siteToastTimer = setTimeout(() => {
    siteToastEl.classList.remove('site-toast-visible');
  }, 2200);
}

// ── Global save ──────────────────────────────────────────────
// Mirrors import.js's applyImport save flow (same endpoint, same
// error mapping, same sessionStorage-cached prompt fallback and
// key, so a file:// admin is only prompted once per tab across
// the manus tool and these pages).
const SITE_UTILS_PIN_KEY = 'matrevy-manus-pin';

function siteUtilsGetCachedPin() {
  try { return sessionStorage.getItem(SITE_UTILS_PIN_KEY) || ''; } catch (e) { return ''; }
}

function siteUtilsSetCachedPin(pin) {
  try { sessionStorage.setItem(SITE_UTILS_PIN_KEY, pin); } catch (e) { /* ignore */ }
}

// Returns { password, fromLogin } or null if the user cancelled the
// password prompt — shared by siteSaveResource/siteUploadFile/siteDeleteFile
// so the prompt/cache dance only lives in one place.
function siteResolvePassword() {
  const siteAuth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  // revyst's password never passes a boss/admin-level save, so only trust a
  // stored login at boss level or above; revyst (and file://'s synthetic
  // admin) still hit the cache/prompt fallback below.
  const fromLogin = siteAuth && (siteAuth.level === 'boss' || siteAuth.level === 'admin') && siteAuth.password;
  let password = fromLogin ? siteAuth.password : siteUtilsGetCachedPin();
  if (!password) {
    password = (prompt('Indtast boss- eller admin-adgangskoden for at gemme ændringer globalt:') || '').trim();
    if (!password) return null;
  }
  return { password, fromLogin };
}

// Returns { ok: true } or { ok: false, message } — message is ''
// when the user cancelled the password prompt (silent no-op).
async function siteSaveResource(resource, payload) {
  const resolved = siteResolvePassword();
  if (!resolved) return { ok: false, message: '' };
  const { password, fromLogin } = resolved;

  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save', password, resource, payload }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }

  if (res.status === 401 || res.status === 403) {
    siteUtilsSetCachedPin('');
    return { ok: false, message: 'Forkert eller utilstrækkelig adgangskode. Log ind med tilstrækkelig adgang og prøv igen.' };
  }
  if (res.status === 409) {
    return { ok: false, message: 'En anden har lige gemt ændringer. Genindlæs siden og prøv igen.' };
  }
  if (!res.ok) {
    return { ok: false, message: 'Kunne ikke gemme ændringer (serverfejl). Prøv igen senere.' };
  }

  // Require a real {ok:true} JSON body — a PHP fatal error (or a WAF
  // challenge page) can come back as HTTP 200 with an HTML body, and must
  // NOT be mistaken for success (see budgetApi/manusApi, which already
  // guard against this).
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!data || data.ok !== true) {
    return { ok: false, message: 'Uventet svar fra serveren. Prøv igen senere.' };
  }

  if (!fromLogin) siteUtilsSetCachedPin(password);
  return { ok: true };
}

// Shared request logic for the file-upload/delete actions — same error
// mapping as siteSaveResource, plus a 413 (too-large) case.
async function siteFileAction(action, extraBody) {
  const resolved = siteResolvePassword();
  if (!resolved) return { ok: false, message: '' };
  const { password, fromLogin } = resolved;

  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...extraBody }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }

  if (res.status === 401 || res.status === 403) {
    siteUtilsSetCachedPin('');
    return { ok: false, message: 'Forkert eller utilstrækkelig adgangskode. Log ind som admin og prøv igen.' };
  }
  if (res.status === 409) {
    return { ok: false, message: 'En anden har lige gemt en fil med samme navn. Prøv igen.' };
  }
  if (res.status === 413) {
    return { ok: false, message: 'Filen er for stor. Maks. 5 MB.' };
  }
  if (!res.ok) {
    return { ok: false, message: 'Kunne ikke gemme filen (serverfejl). Prøv igen senere.' };
  }

  // Same WAF/HTML-200 guard as siteSaveResource — never trust a bare 2xx.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!data || data.ok !== true) {
    return { ok: false, message: 'Uventet svar fra serveren. Prøv igen senere.' };
  }

  if (!fromLogin) siteUtilsSetCachedPin(password);
  return { ok: true };
}

// contentBase64 is raw base64 (no "data:...;base64," prefix).
function siteUploadFile(path, contentBase64) {
  return siteFileAction('upload', { path, contentBase64 });
}

function siteDeleteFile(path) {
  return siteFileAction('delete', { path });
}

// ── Override persistence (survive a refresh during the ~1-2 min embed regen) ──
// A save sets a page's in-memory shadow (postsOverride/calendarOverride/
// archiveOverride) so the saving tab sees its own change immediately,
// without waiting for the GitHub Action to regenerate the embedded data
// file and Pages to redeploy it. These two helpers back that shadow with
// localStorage so it also survives a refresh during that window — trusted
// for SITE_OVERRIDE_TTL_MS, so a tab reopened well later falls back to the
// real embedded data instead of masking someone else's concurrent edit
// behind a stale snapshot. manus-data.js's shadow deliberately stays
// in-memory-only and does not use these.
const SITE_OVERRIDE_TTL_MS = 5 * 60 * 1000;

function siteSaveOverride(resource, data) {
  const key = `matrevy-override-${resource}`;
  try {
    if (data == null) {
      localStorage.removeItem(key);
    } else {
      localStorage.setItem(key, JSON.stringify({ data, savedAt: Date.now() }));
    }
  } catch (e) { /* storage unavailable/full — override just won't survive a refresh */ }
}

function siteLoadOverride(resource) {
  const key = `matrevy-override-${resource}`;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > SITE_OVERRIDE_TTL_MS) {
      localStorage.removeItem(key);
      return null;
    }
    return parsed.data;
  } catch (e) {
    return null;
  }
}

// ── Edit modal ───────────────────────────────────────────────
// Imperative overlay in the openLoginModal (site.js) style.
// Returns { overlay, modal, form, error, actions, close } — the
// caller appends its own fields to `form` and buttons to `actions`.
function siteOpenEditModal(titleText) {
  const overlay = document.createElement('div');
  overlay.className = 'login-overlay';

  const modal = document.createElement('div');
  modal.className = 'login-modal edit-modal';

  const heading = document.createElement('h2');
  heading.textContent = titleText;
  modal.appendChild(heading);

  const form = document.createElement('div');
  modal.appendChild(form);

  const error = document.createElement('div');
  error.className = 'login-error';
  modal.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'login-actions';
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
  // A click event's target can be the overlay even when the drag that
  // produced it started inside the modal — e.g. dragging a <textarea>'s
  // resize handle, or selecting text, past the modal's edge and releasing
  // over the backdrop. Checking only the click's own target closes the
  // modal on that release; requiring the *mousedown* to have also landed on
  // the overlay itself is what actually distinguishes a genuine backdrop
  // click from a drag that merely ends there.
  let backdropMousedown = false;
  overlay.addEventListener('mousedown', (e) => { backdropMousedown = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && backdropMousedown) close(); });

  return { overlay, modal, form, error, actions, close };
}

// Variant of siteOpenEditModal with an X-close button top-right instead of
// a "Luk"/"Annuller" button in the actions row, plus Escape-to-close.
// Returns the same shape (minus `overlay`, which callers don't need here).
function siteOpenModalWithClose(titleText) {
  const { overlay, modal, form, error, actions, close } = siteOpenEditModal(titleText);
  modal.classList.add('site-modal');

  function closeModal() {
    document.removeEventListener('keydown', onKeydown);
    close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') closeModal();
  }
  document.addEventListener('keydown', onKeydown);
  // Backdrop click closes via the overlay's own listener (from
  // siteOpenEditModal) — also strip our Escape listener in that case. Same
  // mousedown-must-also-be-on-the-backdrop guard as that listener (see its
  // own comment), so a resize-drag release over the backdrop doesn't strip
  // the Escape handler out from under a modal that correctly didn't close.
  let backdropMousedown = false;
  overlay.addEventListener('mousedown', (e) => { backdropMousedown = e.target === overlay; });
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay && backdropMousedown) document.removeEventListener('keydown', onKeydown);
  });

  const closeX = document.createElement('button');
  closeX.type = 'button';
  closeX.className = 'site-modal-close';
  closeX.textContent = '✕';
  closeX.setAttribute('aria-label', 'Luk');
  closeX.addEventListener('click', closeModal);
  modal.insertBefore(closeX, modal.firstChild);

  return { modal, form, error, actions, close: closeModal };
}

// Labeled field helper for the edit modal: returns the wrapper div
// with `input` attached as a property for easy value access.
function siteEditField(labelText, inputEl) {
  const wrap = document.createElement('div');
  wrap.className = 'edit-field';
  const label = document.createElement('label');
  label.textContent = labelText;
  wrap.appendChild(label);
  wrap.appendChild(inputEl);
  wrap.input = inputEl;
  return wrap;
}

// ── Custom date/time/dropdown picker fields ──────────────────
// Native <input type="date">/type="time"> and <select> hand their
// picker/dropdown UI off to the OS/browser (a closed shadow root,
// unstylable), so these factories replace them with popups built
// and styled like the rest of the site. Each factory returns a
// plain element augmented with a `.value` getter/setter (ISO date,
// 'HH:MM'/'', or the chosen option's value) and a dispatched
// 'change' event on selection, so call sites use them exactly like
// a native input/select. Originally grown for Kalender's editor;
// promoted here so every page's dropdowns/date/time fields share
// the same look (Kalender's own category picker, which needs a
// colored dot per option, stays in calendar.js but builds on the
// siteOpenFieldPopup primitive below).
let siteFieldPopupClose = null; // the one currently-open popup's close fn, if any
let siteFieldPopupAnchor = null; // the button that currently owns the open popup, if any

function siteCloseFieldPopup() {
  if (siteFieldPopupClose) { siteFieldPopupClose(); siteFieldPopupClose = null; }
  siteFieldPopupAnchor = null;
}

// Toggle helper for a field's open button: closes the popup if it's already
// open for this exact anchor (so a second click closes instead of
// re-opening an identical popup), otherwise runs `openFn` to open it fresh.
function siteToggleFieldPopup(anchor, openFn) {
  if (siteFieldPopupAnchor === anchor) { siteCloseFieldPopup(); return; }
  openFn();
}

// Positions `pop` (already appended to <body>) below its anchor button,
// flipping above and clamping horizontally so it never runs off-screen.
function sitePositionFieldPopup(pop, anchor) {
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
// reposition-on-scroll behaviour every field popup needs. Returns the
// close function. Escape stops propagation so it closes just the popup,
// not a surrounding edit modal too (a second Escape closes that).
function siteOpenFieldPopup(anchor, pop) {
  siteCloseFieldPopup();
  pop.style.position = 'fixed';
  document.body.appendChild(pop);
  sitePositionFieldPopup(pop, anchor);

  function onDocMousedown(e) {
    if (!pop.contains(e.target) && e.target !== anchor) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
  }
  function onReposition() { sitePositionFieldPopup(pop, anchor); }
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
    if (siteFieldPopupClose === close) { siteFieldPopupClose = null; siteFieldPopupAnchor = null; }
  }
  siteFieldPopupClose = close;
  siteFieldPopupAnchor = anchor;
  return close;
}

// Mini month-grid popup — same day-grid math as calendar.js's month view,
// but its own compact rendering with no event chips, just pick-a-day.
function siteOpenDatePicker(anchor, currentIso, onSelect) {
  const base = currentIso ? parseIsoDate(currentIso) : new Date();
  let viewYear = base.getFullYear();
  let viewMonth = base.getMonth();

  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-dp-pop';

  const header = document.createElement('div');
  header.className = 'site-dp-header';
  const prevBtn = document.createElement('button');
  prevBtn.type = 'button';
  prevBtn.className = 'site-dp-nav';
  prevBtn.textContent = '‹';
  prevBtn.setAttribute('aria-label', 'Forrige måned');
  const label = document.createElement('span');
  label.className = 'site-dp-label';
  const nextBtn = document.createElement('button');
  nextBtn.type = 'button';
  nextBtn.className = 'site-dp-nav';
  nextBtn.textContent = '›';
  nextBtn.setAttribute('aria-label', 'Næste måned');
  header.appendChild(prevBtn);
  header.appendChild(label);
  header.appendChild(nextBtn);
  pop.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'site-dp-grid';
  pop.appendChild(grid);

  function renderGrid() {
    label.textContent = `${DA_MONTHS[viewMonth]} ${viewYear}`;
    grid.textContent = '';
    for (const wd of DA_WEEKDAYS_SHORT) {
      const wdCell = document.createElement('span');
      wdCell.className = 'site-dp-weekday';
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
      day.className = 'site-dp-day';
      if (iso === today) day.classList.add('site-dp-today');
      if (iso === currentIso) day.classList.add('site-dp-selected');
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

  const close = siteOpenFieldPopup(anchor, pop);
}

function siteCreateDateField(initialIso) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-field-btn';
  const text = document.createElement('span');
  text.className = 'site-field-text';
  const chevron = document.createElement('span');
  chevron.className = 'site-field-chevron';
  chevron.textContent = '▾';
  btn.appendChild(text);
  btn.appendChild(chevron);

  let _value = initialIso || '';
  function render() {
    text.textContent = _value ? formatDaDateShort(_value) : 'Vælg dato';
    text.classList.toggle('site-field-placeholder', !_value);
  }
  Object.defineProperty(btn, 'value', {
    get() { return _value; },
    set(v) { _value = v; render(); },
  });
  render();

  btn.addEventListener('click', () => {
    siteToggleFieldPopup(btn, () => {
      siteOpenDatePicker(btn, _value, (iso) => {
        _value = iso;
        render();
        btn.dispatchEvent(new Event('change'));
      });
    });
  });
  return btn;
}

// Flat, scrollable list of quarter-hour times (matching Øveplan's own
// 15-min step convention) plus a clear row, since start/end are optional.
function siteTimeOptions() {
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return opts;
}

function siteOpenTimePicker(anchor, currentValue, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-tp-pop';

  const clearRow = document.createElement('button');
  clearRow.type = 'button';
  clearRow.className = 'site-list-row site-tp-clear';
  clearRow.textContent = 'Ingen tid';
  clearRow.addEventListener('click', () => { close(); onSelect(''); });
  pop.appendChild(clearRow);

  const list = document.createElement('div');
  list.className = 'site-tp-list';
  pop.appendChild(list);

  let selectedRow = null;
  for (const t of siteTimeOptions()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-list-row';
    row.textContent = t;
    if (t === currentValue) { row.classList.add('site-list-selected'); selectedRow = row; }
    row.addEventListener('click', () => { close(); onSelect(t); });
    list.appendChild(row);
  }

  const close = siteOpenFieldPopup(anchor, pop);
  if (selectedRow) selectedRow.scrollIntoView({ block: 'center' });
}

// Accepts what a user is likely to type — "14:30", "14.30", "930", "0930" —
// and normalizes to strict "HH:MM", or null if unparseable. Kept forgiving
// but not lenient enough to accept outright garbage (hour/minute bounds).
function siteParseTimeInput(raw) {
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
function siteClockIcon() {
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
function siteCreateTimeField(initialValue) {
  const wrap = document.createElement('div');
  wrap.className = 'site-field-combo';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'site-field-input';
  input.placeholder = 'tt:mm';
  input.autocomplete = 'off';
  input.inputMode = 'numeric';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'site-field-toggle';
  toggle.appendChild(siteClockIcon());
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
    const parsed = siteParseTimeInput(input.value);
    if (parsed === null) { input.value = _value; return; } // revert, keep last valid value
    commit(parsed, true);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  toggle.addEventListener('click', () => {
    siteToggleFieldPopup(toggle, () => {
      siteOpenTimePicker(toggle, _value, (t) => commit(t, true));
    });
  });

  return wrap;
}

// Generic dropdown popup: `options` is [{value, label}]. For a plain
// <select> replacement with no per-option colour (Forside's Synlighed
// field, Budget's category fields) — see calendar.js's
// openCalCategoryPicker/calCreateCategoryField for the coloured-dot
// variant, built on the siteOpenFieldPopup primitive above.
function siteOpenDropdownPicker(anchor, options, currentValue, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-dd-pop';

  for (const opt of options) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-list-row';
    if (opt.value === currentValue) row.classList.add('site-list-selected');
    row.textContent = opt.label;
    row.addEventListener('click', () => { close(); onSelect(opt.value); });
    pop.appendChild(row);
  }

  const close = siteOpenFieldPopup(anchor, pop);
}

function siteCreateDropdownField(options, initialValue) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-field-btn';
  const text = document.createElement('span');
  text.className = 'site-field-text';
  const chevron = document.createElement('span');
  chevron.className = 'site-field-chevron';
  chevron.textContent = '▾';
  btn.appendChild(text);
  btn.appendChild(chevron);

  let _value = initialValue != null ? initialValue : '';
  function render() {
    const opt = options.find((o) => o.value === _value);
    text.textContent = opt ? opt.label : 'Vælg';
    text.classList.toggle('site-field-placeholder', !opt);
  }
  Object.defineProperty(btn, 'value', {
    get() { return _value; },
    set(v) { _value = v; render(); },
  });
  render();

  btn.addEventListener('click', () => {
    siteToggleFieldPopup(btn, () => {
      siteOpenDropdownPicker(btn, options, _value, (v) => {
        _value = v;
        render();
        btn.dispatchEvent(new Event('change'));
      });
    });
  });
  return btn;
}
