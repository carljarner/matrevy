/* =========================================================
   Matematikrevyen – Shared helpers for the data-driven pages
   (announcements/forside, kalender, arkiv).

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
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  return { overlay, modal, form, error, actions, close };
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
