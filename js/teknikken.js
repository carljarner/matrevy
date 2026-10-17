/* =========================================================
   Matematikrevyen – Teknikken (teknikken.html)

   The tech crew's shared files during the revy, replacing a Google
   Drive folder: a nested folder tree with videos, slides, images and
   anything else, up to 500 MB per file. Lives in the private
   TEKNIK_DATA_DIR store via authenticated teknik_* actions — one store
   for the whole site, not per revy, and never archived (people save
   what they want to keep themselves).

   Big files can't go through the usual one-JSON-request upload
   (php.ini caps a request at 25 MB), so each file is sent in 8 MB
   base64 chunks (teknik_upload_start → _chunk × N → _finish), one file
   at a time, each chunk retried a few times. Downloads ask for a
   short-lived signed URL (teknik_download_url) and let the browser
   fetch it natively, instead of holding the whole file as a blob.

   The open folder is in location.hash (#<folderId>, empty = top), so
   Back/Forward and shared links work. Fully open at the revyst tier.

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

// First-level (inline) button.
function teknikBtn(label, extraClass) {
  const btn = el('button', 'btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  btn.type = 'button';
  return btn;
}

// Second-level button, for buttons inside a modal overlay only.
function teknikPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

function teknikRemoveBtn(title) {
  const btn = el('button', 'teknik-remove-btn', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

function teknikIconBtn(icon, title) {
  const btn = el('button', 'teknik-icon-btn');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(icon);
  return btn;
}

function teknikSvg(viewBox, size, strokeWidth, paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', String(strokeWidth));
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  for (const d of paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

// Arrow-into-tray download glyph — same drawing as band.js's bandDownloadIcon.
function teknikDownloadIcon() {
  return teknikSvg('0 0 24 24', 16, 2, ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14']);
}

// Pencil glyph — same drawing as band.js's bandPencilIcon.
function teknikPencilIcon() {
  return teknikSvg('0 0 16 16', 15, 1.3, ['M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z', 'M9 4l3 3']);
}

function teknikFolderIcon() {
  return teknikSvg('0 0 24 24', 20, 1.8, ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']);
}

// ── Authenticated API (mirrors band.js's bandApi) ────────────
const TEKNIK_MAX_UPLOAD_MB = 500; // mirrors teknik_max_upload_bytes() in update-data.php
const TEKNIK_CHUNK_BYTES = 8 * 1024 * 1024; // mirrors teknik_max_chunk_bytes()
const TEKNIK_CHUNK_ATTEMPTS = 4;

function teknikResolvePassword() {
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

function teknikMapError(status, detail) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet — en anden har måske lige slettet den. Genindlæs siden.';
  if (status === 413 || detail === 'too_large') return `Filen er for stor. Maks. ${TEKNIK_MAX_UPLOAD_MB} MB.`;
  if (status === 507 || detail === 'disk_full') return 'Serveren er ved at løbe tør for plads. Slet nogle gamle filer, eller sig det til Carl.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, status, message, data } —
// message '' = cancelled password prompt (silent no-op).
async function teknikApi(action, body) {
  const password = teknikResolvePassword();
  if (!password) return { ok: false, status: 0, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...(body || {}) }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  // Require a real {ok:true} JSON body — a PHP fatal or WAF page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, message: teknikMapError(res.status, detail), data };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.', data };
  }
  return { ok: true, data };
}

function teknikShowError(message) {
  if (message) siteShowToast(message);
}

// ── State ────────────────────────────────────────────────────
let teknikState = null; // { folders, files } once loaded

function teknikRoot() {
  return document.getElementById('teknikken-root');
}

function teknikFolderById(id) {
  return id ? (teknikState.folders.find((f) => f.id === id) || null) : null;
}

// The open folder, from the hash; an unknown id falls back to the top.
function teknikCurrentFolderId() {
  const id = decodeURIComponent(location.hash.replace(/^#/, ''));
  return teknikState && teknikFolderById(id) ? id : null;
}

function teknikOpenFolder(id) {
  const next = id ? '#' + id : '';
  if (location.hash === next || (!id && !location.hash)) { teknikRender(); return; }
  if (id) location.hash = id;
  else history.pushState(null, '', location.pathname + location.search);
  teknikRender();
}

function teknikChildFolders(parentId) {
  return teknikState.folders.filter((f) => (f.parentId || null) === parentId);
}

function teknikFolderFiles(folderId) {
  return teknikState.files.filter((f) => (f.folderId || null) === folderId);
}

// Every folder id at or below `folderId`.
function teknikSubtreeIds(folderId) {
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of teknikState.folders) {
      if (!ids.has(f.id) && ids.has(f.parentId)) { ids.add(f.id); grew = true; }
    }
  }
  return ids;
}

function teknikCompareNames(a, b) {
  return (a.name || '').localeCompare(b.name || '', 'da', { sensitivity: 'base', numeric: true });
}

function teknikFormatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return value.toLocaleString('da-DK', { maximumFractionDigits: digits }) + ' ' + units[unit];
}

function teknikPlural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// ── File kinds ───────────────────────────────────────────────
const TEKNIK_KINDS = [
  { key: 'video', label: 'VIDEO', exts: ['mov', 'mp4', 'm4v', 'avi', 'mkv', 'webm', 'wmv'] },
  { key: 'slides', label: 'SLIDES', exts: ['pptx', 'ppt', 'key', 'odp'] },
  { key: 'pdf', label: 'PDF', exts: ['pdf'] },
  { key: 'image', label: 'BILLEDE', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'tif', 'tiff', 'bmp'] },
  { key: 'audio', label: 'LYD', exts: ['mp3', 'wav', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg'] },
];
// Mirrors teknik_inline_types(): what opens in a browser tab on click.
const TEKNIK_INLINE_EXTS = ['pdf', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'mp4', 'm4v', 'mov', 'mp3', 'm4a', 'wav'];

function teknikFileKind(ext) {
  const kind = TEKNIK_KINDS.find((k) => k.exts.includes(ext));
  if (kind) return kind;
  return { key: 'other', label: ext ? ext.toUpperCase().slice(0, 5) : 'FIL' };
}

function teknikFileExt(name) {
  return name.includes('.') ? (name.split('.').pop() || '').toLowerCase() : '';
}

function teknikFileDisplayName(file) {
  return file.ext ? file.name.replace(new RegExp('\\.' + file.ext + '$', 'i'), '') || file.name : file.name;
}

// ── Load + render ────────────────────────────────────────────
async function teknikLoad() {
  const root = teknikRoot();
  root.replaceChildren(el('p', 'teknik-muted', 'Indlæser…'));
  const result = await teknikApi('teknik_read', {});
  if (!result.ok) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'teknik-error', result.message || 'Kunne ikke indlæse Teknikken.'));
    root.replaceChildren(card);
    return;
  }
  teknikState = { folders: result.data.folders || [], files: result.data.files || [] };
  teknikRender();
}

function teknikRender() {
  const root = teknikRoot();
  if (!root || !teknikState) return;
  const folderId = teknikCurrentFolderId();
  const card = el('section', 'card teknik-card');

  const head = el('div', 'card-head teknik-card-head');
  head.appendChild(teknikBuildBreadcrumb(folderId));
  const headActions = el('div', 'teknik-head-actions');
  const newFolderBtn = teknikBtn('+ Ny mappe');
  newFolderBtn.addEventListener('click', () => teknikOpenFolderNameModal(null, folderId));
  headActions.appendChild(newFolderBtn);
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    input.value = '';
    teknikEnqueue(picked, folderId);
  });
  const uploadBtn = teknikBtn('Upload filer');
  uploadBtn.addEventListener('click', () => input.click());
  headActions.appendChild(uploadBtn);
  headActions.appendChild(input);
  head.appendChild(headActions);
  card.appendChild(head);

  card.appendChild(teknikBuildList(folderId));
  teknikWireFileDrop(card, card, () => folderId);

  // The upload panel survives re-renders of the list.
  root.replaceChildren(card, teknikUploadPanel());
  teknikRenderUploads();
}

function teknikBuildBreadcrumb(folderId) {
  const nav = el('nav', 'teknik-breadcrumb');
  nav.setAttribute('aria-label', 'Mapper');
  const chain = [];
  for (let f = teknikFolderById(folderId); f; f = teknikFolderById(f.parentId)) chain.unshift(f);
  const crumbs = [{ id: null, name: 'Alle filer' }].concat(chain);
  crumbs.forEach((crumb, i) => {
    if (i > 0) nav.appendChild(el('span', 'teknik-crumb-sep', '›'));
    if (i === crumbs.length - 1) {
      nav.appendChild(el('h2', 'teknik-crumb-current', crumb.name));
      return;
    }
    const btn = el('button', 'teknik-crumb', crumb.name);
    btn.type = 'button';
    btn.addEventListener('click', () => teknikOpenFolder(crumb.id));
    teknikWireFileDrop(btn, btn, () => crumb.id);
    nav.appendChild(btn);
  });
  return nav;
}

function teknikBuildList(folderId) {
  const list = el('div', 'teknik-list');
  const folders = teknikChildFolders(folderId).sort(teknikCompareNames);
  const files = teknikFolderFiles(folderId).sort(teknikCompareNames);
  for (const folder of folders) list.appendChild(teknikBuildFolderRow(folder));
  for (const file of files) list.appendChild(teknikBuildFileRow(file));
  if (!folders.length && !files.length) {
    list.appendChild(el('p', 'teknik-muted teknik-empty',
      folderId ? 'Mappen er tom. Træk filer hertil, eller brug "Upload filer".'
        : 'Her er ingen filer endnu. Opret en mappe, eller træk filer hertil.'));
  }
  return list;
}

function teknikFolderSummary(folder) {
  const subfolders = teknikChildFolders(folder.id).length;
  const files = teknikFolderFiles(folder.id).length;
  if (!subfolders && !files) return 'Tom';
  const parts = [];
  if (subfolders) parts.push(teknikPlural(subfolders, 'mappe', 'mapper'));
  if (files) parts.push(teknikPlural(files, 'fil', 'filer'));
  return parts.join(', ');
}

function teknikBuildFolderRow(folder) {
  const row = el('div', 'teknik-row teknik-folder-row');
  const open = el('button', 'teknik-row-main');
  open.type = 'button';
  open.title = 'Åbn mappen';
  const icon = el('span', 'teknik-folder-icon');
  icon.appendChild(teknikFolderIcon());
  open.appendChild(icon);
  open.appendChild(el('span', 'teknik-row-name', folder.name));
  open.addEventListener('click', () => teknikOpenFolder(folder.id));
  row.appendChild(open);
  row.appendChild(el('span', 'teknik-row-meta', teknikFolderSummary(folder)));

  const actions = el('div', 'teknik-row-actions');
  const editBtn = teknikIconBtn(teknikPencilIcon(), 'Omdøb mappen');
  editBtn.addEventListener('click', () => teknikOpenFolderNameModal(folder, folder.parentId || null));
  actions.appendChild(editBtn);
  const removeBtn = teknikRemoveBtn('Slet mappen');
  removeBtn.addEventListener('click', () => teknikConfirmDeleteFolder(folder));
  actions.appendChild(removeBtn);
  row.appendChild(actions);

  // Files dropped on a folder row go into that folder.
  teknikWireFileDrop(row, row, () => folder.id);
  return row;
}

function teknikBuildFileRow(file) {
  const row = el('div', 'teknik-row teknik-file-row');
  const kind = teknikFileKind(file.ext);
  const inline = TEKNIK_INLINE_EXTS.includes(file.ext);
  const open = el('button', 'teknik-row-main');
  open.type = 'button';
  open.title = inline ? 'Åbn' : 'Download';
  open.appendChild(el('span', 'teknik-kind teknik-kind-' + kind.key, kind.label));
  open.appendChild(el('span', 'teknik-row-name', teknikFileDisplayName(file)));
  open.addEventListener('click', () => (inline ? teknikOpenFile(file) : teknikDownloadFile(file)));
  row.appendChild(open);
  const date = (file.uploadedAt || '').slice(0, 10);
  row.appendChild(el('span', 'teknik-row-meta',
    teknikFormatBytes(file.size || 0) + (date ? ' · ' + formatDaDate(date) : '')));

  const actions = el('div', 'teknik-row-actions');
  const downloadBtn = teknikIconBtn(teknikDownloadIcon(), 'Download');
  downloadBtn.addEventListener('click', () => teknikDownloadFile(file));
  actions.appendChild(downloadBtn);
  const editBtn = teknikIconBtn(teknikPencilIcon(), 'Omdøb');
  editBtn.addEventListener('click', () => teknikOpenRenameFileModal(file));
  actions.appendChild(editBtn);
  const removeBtn = teknikRemoveBtn('Slet fil');
  removeBtn.addEventListener('click', () => {
    teknikConfirm(`Slet "${teknikFileDisplayName(file)}"?`, 'Dette kan ikke fortrydes.', 'Slet', async () => {
      const result = await teknikApi('teknik_delete_file', { fileId: file.id });
      if (!result.ok) { teknikShowError(result.message); return false; }
      teknikState.files = teknikState.files.filter((f) => f.id !== file.id);
      teknikRender();
      return true;
    });
  });
  actions.appendChild(removeBtn);
  row.appendChild(actions);
  return row;
}

// ── Modals ───────────────────────────────────────────────────
function teknikConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('teknik-confirm-modal');
  if (description) form.appendChild(el('p', 'teknik-confirm-text', description));
  const cancelBtn = teknikPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = teknikPillBtn(confirmLabel, 'site-btn-danger');
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

// One text field + Gem/Opret; `submit(value)` returns an error message or ''.
function teknikOpenNameModal(title, initial, placeholder, confirmLabel, submit) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose(title);
  modal.classList.add('teknik-name-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 190;
  input.value = initial;
  input.placeholder = placeholder;
  form.appendChild(siteEditField('Navn', input));
  const cancelBtn = teknikPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const saveBtn = teknikPillBtn(confirmLabel, 'site-btn-success');
  async function onSubmit() {
    const value = input.value.trim();
    if (!value) { error.textContent = 'Skriv et navn.'; input.focus(); return; }
    if (value === initial) { close(); return; }
    saveBtn.disabled = true;
    error.textContent = '';
    const message = await submit(value);
    saveBtn.disabled = false;
    if (message === null) return; // cancelled password prompt
    if (message) { error.textContent = message; return; }
    close();
  }
  saveBtn.addEventListener('click', onSubmit);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    onSubmit();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  input.focus();
  input.select();
}

// `folder` null = create a new folder inside `parentId`; else rename it.
function teknikOpenFolderNameModal(folder, parentId) {
  teknikOpenNameModal(folder ? 'Omdøb mappe' : 'Ny mappe', folder ? folder.name : '', 'Fx Lyd, Video, Slides',
    folder ? 'Gem' : 'Opret', async (name) => {
      const result = folder
        ? await teknikApi('teknik_rename_folder', { folderId: folder.id, name })
        : await teknikApi('teknik_create_folder', { parentId, name });
      if (!result.ok) return result.message || null;
      if (folder) folder.name = result.data.folder.name;
      else teknikState.folders.push(result.data.folder);
      teknikRender();
      return '';
    });
}

function teknikOpenRenameFileModal(file) {
  teknikOpenNameModal('Omdøb fil', teknikFileDisplayName(file), '', 'Gem', async (name) => {
    const result = await teknikApi('teknik_rename_file', { fileId: file.id, name });
    if (!result.ok) return result.message || null;
    file.name = result.data.file.name;
    teknikRender();
    return '';
  });
}

function teknikConfirmDeleteFolder(folder) {
  const ids = teknikSubtreeIds(folder.id);
  const fileCount = teknikState.files.filter((f) => ids.has(f.folderId)).length;
  const folderCount = ids.size - 1;
  const contents = [];
  if (folderCount) contents.push(teknikPlural(folderCount, 'undermappe', 'undermapper'));
  if (fileCount) contents.push(teknikPlural(fileCount, 'fil', 'filer'));
  const description = (contents.length ? `Mappen og alt i den (${contents.join(' og ')}) slettes. ` : '')
    + 'Dette kan ikke fortrydes.';
  teknikConfirm(`Slet "${folder.name}"?`, description, 'Slet', async () => {
    const result = await teknikApi('teknik_delete_folder', { folderId: folder.id });
    if (!result.ok) { teknikShowError(result.message); return false; }
    teknikState.folders = teknikState.folders.filter((f) => !ids.has(f.id));
    teknikState.files = teknikState.files.filter((f) => !ids.has(f.folderId));
    teknikRender();
    return true;
  });
}

// ── Download / open ──────────────────────────────────────────
async function teknikDownloadUrl(file, inline) {
  const result = await teknikApi('teknik_download_url', { fileId: file.id, inline });
  if (!result.ok) { teknikShowError(result.message); return null; }
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  return SITE_API_ENDPOINT + sep + result.data.query;
}

// A hidden iframe starts the download without navigating this page (a
// navigation would fire beforeunload and warn during uploads). iOS shows
// downloads as a preview anyway, so it just goes there.
let teknikDownloadFrame = null;
async function teknikDownloadFile(file) {
  const url = await teknikDownloadUrl(file, false);
  if (!url) return;
  if (siteIsIos()) { window.location.href = url; return; }
  if (!teknikDownloadFrame) {
    teknikDownloadFrame = document.createElement('iframe');
    teknikDownloadFrame.hidden = true;
    teknikDownloadFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(teknikDownloadFrame);
  }
  teknikDownloadFrame.src = url;
}

// The window is opened synchronously (inside the click) so popup blockers
// allow it, then pointed at the file once its URL has arrived — same
// recipe as band.js's bandOpenFile.
async function teknikOpenFile(file) {
  const sameTab = siteIsIos();
  const win = sameTab ? null : window.open('', '_blank');
  const url = await teknikDownloadUrl(file, true);
  if (!url) { if (win) win.close(); return; }
  if (sameTab || !win) { window.location.href = url; return; }
  win.location.replace(url);
}

// ── Upload queue ─────────────────────────────────────────────
// [{key, file, folderId, sent, state: 'waiting'|'uploading'|'failed', message, cancelled, uploadId}]
const teknikQueue = [];
let teknikQueueRunning = false;
let teknikUploadKey = 0;
let teknikPanelEl = null;

function teknikUploadsPending() {
  return teknikQueue.some((item) => item.state !== 'failed');
}

function teknikUploadPanel() {
  if (!teknikPanelEl) teknikPanelEl = el('section', 'card teknik-uploads');
  return teknikPanelEl;
}

function teknikEnqueue(files, folderId) {
  const maxBytes = TEKNIK_MAX_UPLOAD_MB * 1024 * 1024;
  let added = 0;
  for (const file of files) {
    if (!file.size) {
      siteShowToast(`"${file.name}" blev sprunget over — tom fil eller en mappe.`);
      continue;
    }
    if (file.size > maxBytes) {
      siteShowToast(`"${file.name}" er for stor (maks. ${TEKNIK_MAX_UPLOAD_MB} MB).`);
      continue;
    }
    teknikQueue.push({ key: ++teknikUploadKey, file, folderId, sent: 0, state: 'waiting', message: '', cancelled: false, uploadId: null });
    added++;
  }
  if (!added) return;
  teknikRenderUploads();
  teknikRunQueue();
}

function teknikRenderUploads() {
  const panel = teknikUploadPanel();
  panel.hidden = !teknikQueue.length;
  if (!teknikQueue.length) { panel.replaceChildren(); return; }
  const head = el('div', 'card-head teknik-uploads-head');
  head.appendChild(el('h2', null, 'Uploads'));
  if (teknikQueue.some((item) => item.state === 'failed')) {
    const clearBtn = teknikBtn('Ryd fejlede');
    clearBtn.addEventListener('click', () => {
      for (let i = teknikQueue.length - 1; i >= 0; i--) {
        if (teknikQueue[i].state === 'failed') teknikQueue.splice(i, 1);
      }
      teknikRenderUploads();
    });
    head.appendChild(clearBtn);
  }
  panel.replaceChildren(head);
  for (const item of teknikQueue) panel.appendChild(teknikBuildUploadRow(item));
}

function teknikBuildUploadRow(item) {
  const row = el('div', 'teknik-upload');
  item.rowEl = row;
  const top = el('div', 'teknik-upload-top');
  top.appendChild(el('span', 'teknik-upload-name', item.file.name));
  const where = teknikFolderById(item.folderId);
  top.appendChild(el('span', 'teknik-upload-where', '→ ' + (where ? where.name : 'Alle filer')));
  const status = el('span', 'teknik-upload-status');
  item.statusEl = status;
  top.appendChild(status);
  const cancelBtn = teknikRemoveBtn(item.state === 'failed' ? 'Fjern' : 'Annuller upload');
  cancelBtn.addEventListener('click', () => teknikCancelUpload(item));
  top.appendChild(cancelBtn);
  row.appendChild(top);
  const bar = el('div', 'teknik-progress');
  const fill = el('div', 'teknik-progress-fill');
  item.fillEl = fill;
  bar.appendChild(fill);
  row.appendChild(bar);
  if (item.state === 'failed') row.classList.add('teknik-upload-failed');
  teknikPaintUpload(item);
  return row;
}

function teknikPaintUpload(item) {
  if (!item.statusEl) return;
  const pct = item.file.size ? Math.floor((item.sent / item.file.size) * 100) : 0;
  item.fillEl.style.width = pct + '%';
  if (item.state === 'failed') item.statusEl.textContent = item.message || 'Fejlede';
  else if (item.state === 'waiting') item.statusEl.textContent = 'Venter';
  else item.statusEl.textContent = `${pct} % af ${teknikFormatBytes(item.file.size)}`;
}

function teknikRemoveFromQueue(item) {
  const idx = teknikQueue.indexOf(item);
  if (idx >= 0) teknikQueue.splice(idx, 1);
  teknikRenderUploads();
}

function teknikCancelUpload(item) {
  if (item.state === 'uploading') {
    item.cancelled = true; // the running loop aborts after its current chunk
    item.statusEl.textContent = 'Annullerer…';
    return;
  }
  teknikRemoveFromQueue(item);
}

async function teknikRunQueue() {
  if (teknikQueueRunning) return;
  teknikQueueRunning = true;
  for (;;) {
    const item = teknikQueue.find((i) => i.state === 'waiting');
    if (!item) break;
    item.state = 'uploading';
    teknikPaintUpload(item);
    const outcome = await teknikUploadOne(item);
    if (outcome.ok) {
      teknikRemoveFromQueue(item);
      teknikState.files.push(outcome.file);
      teknikRender();
      siteShowToast(`"${item.file.name}" er uploadet.`);
    } else if (outcome.cancelled) {
      teknikRemoveFromQueue(item);
    } else {
      item.state = 'failed';
      item.message = outcome.message || 'Fejlede';
      teknikRenderUploads();
    }
  }
  teknikQueueRunning = false;
}

function teknikReadChunkBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function teknikDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns {ok, file} | {cancelled} | {message}.
async function teknikUploadOne(item) {
  const { file } = item;
  const start = await teknikApi('teknik_upload_start', { folderId: item.folderId, name: file.name, size: file.size });
  if (!start.ok) return { message: start.message || 'Annulleret' };
  item.uploadId = start.data.uploadId;
  const chunkBytes = Math.min(TEKNIK_CHUNK_BYTES, start.data.chunkBytes || TEKNIK_CHUNK_BYTES);
  let offset = 0;
  while (offset < file.size) {
    if (item.cancelled) {
      await teknikApi('teknik_upload_abort', { uploadId: item.uploadId });
      return { cancelled: true };
    }
    let contentBase64;
    try {
      contentBase64 = await teknikReadChunkBase64(file.slice(offset, offset + chunkBytes));
    } catch (e) {
      await teknikApi('teknik_upload_abort', { uploadId: item.uploadId });
      return { message: 'Kunne ikke læse filen.' };
    }
    let result = null;
    for (let attempt = 1; attempt <= TEKNIK_CHUNK_ATTEMPTS; attempt++) {
      result = await teknikApi('teknik_upload_chunk', { uploadId: item.uploadId, offset, contentBase64 });
      // Network errors and 5xx are worth retrying; 4xx won't change.
      if (result.ok || (result.status >= 400 && result.status < 500)) break;
      if (attempt < TEKNIK_CHUNK_ATTEMPTS) await teknikDelay(1000 * 2 ** attempt);
    }
    if (!result.ok) {
      // The server holds a different amount than we think: carry on from there.
      if (result.status === 409 && result.data && Number.isInteger(result.data.received)) {
        offset = result.data.received;
        continue;
      }
      await teknikApi('teknik_upload_abort', { uploadId: item.uploadId });
      return { message: result.message };
    }
    offset = Math.max(offset, result.data.received);
    item.sent = offset;
    teknikPaintUpload(item);
  }
  const finish = await teknikApi('teknik_upload_finish', { uploadId: item.uploadId });
  if (!finish.ok) {
    if (finish.status === 404) return { message: 'Mappen blev slettet under uploaden.' };
    return { message: finish.message };
  }
  return { ok: true, file: finish.data.file };
}

// Files dragged from the desktop onto `target` upload into folderOf().
// Nested targets (a folder row inside the card) win: they stop the event.
function teknikWireFileDrop(target, highlightEl, folderOf) {
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  target.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.teknik-dragover').forEach((n) => { if (n !== highlightEl) n.classList.remove('teknik-dragover'); });
    highlightEl.classList.add('teknik-dragover');
  });
  target.addEventListener('dragleave', (e) => {
    if (!target.contains(e.relatedTarget)) highlightEl.classList.remove('teknik-dragover');
  });
  target.addEventListener('drop', (e) => {
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    document.querySelectorAll('.teknik-dragover').forEach((n) => n.classList.remove('teknik-dragover'));
    teknikEnqueue(Array.from(e.dataTransfer.files), folderOf());
  });
}

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (!teknikUploadsPending()) return;
  e.preventDefault();
  e.returnValue = '';
});

window.addEventListener('hashchange', () => teknikRender());
window.addEventListener('popstate', () => teknikRender());

document.addEventListener('DOMContentLoaded', () => {
  const root = teknikRoot();
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'teknik-muted', 'Teknikken kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  if (typeof siteRegisterUnsavedCheck === 'function') siteRegisterUnsavedCheck(teknikUploadsPending);
  teknikLoad();
});
