/* =========================================================
   Matematikrevyen – Teknikken (teknikken.html)

   The tech crew's shared files during the revy, replacing a Google
   Drive folder: a nested folder tree with videos, slides, images and
   anything else, capped at 5 GB for the whole store (a usage bar at
   the top). Lives in the private TEKNIK_DATA_DIR store via
   authenticated teknik_* actions — one store for the whole site, not
   per revy, and never archived (people save what they want to keep).

   Folders open and close in place (Bandet's Noder style), indented by
   depth; which ones are open is remembered per browser. Files drag
   between folders (or to the top level); the edit modal can move them
   too, for touch screens. Uploading always goes through a modal that
   asks which folder the files go into.

   Big files can't go through the usual one-JSON-request upload
   (php.ini caps a request at 25 MB), so each file is sent in 8 MB
   base64 chunks (teknik_upload_start → _chunk × N → _finish), one file
   at a time, each chunk retried a few times. Downloads — one file, or a
   whole folder as a .zip — ask for a short-lived signed URL and let the
   browser fetch it natively, instead of holding the file as a blob.

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
const TEKNIK_DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024 * 1024; // mirrors teknik_quota_bytes() in update-data.php
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
  if (detail === 'quota_exceeded') {
    return `Der er ikke plads nok — Teknikken må højst fylde ${teknikFormatBytes(teknikQuotaBytes)} i alt. Slet nogle filer først.`;
  }
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet — en anden har måske lige slettet den. Genindlæs siden.';
  if (status === 507 || detail === 'disk_full') return 'Serveren er ved at løbe tør for plads. Sig det til Carl.';
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
let teknikQuotaBytes = TEKNIK_DEFAULT_QUOTA_BYTES;
const TEKNIK_OPEN_KEY = 'matrevy-teknik-open';
const teknikOpenFolders = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(TEKNIK_OPEN_KEY) || '[]')); } catch (e) { return new Set(); }
})();

function teknikSaveOpenFolders() {
  try { localStorage.setItem(TEKNIK_OPEN_KEY, JSON.stringify([...teknikOpenFolders])); } catch (e) { /* ignore */ }
}

function teknikRoot() {
  return document.getElementById('teknikken-root');
}

function teknikFolderById(id) {
  return id ? (teknikState.folders.find((f) => f.id === id) || null) : null;
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

function teknikSubtreeFiles(folderId) {
  const ids = teknikSubtreeIds(folderId);
  return teknikState.files.filter((f) => ids.has(f.folderId));
}

// "Lyd › Jingles"
function teknikFolderPath(folderId) {
  const names = [];
  for (let f = teknikFolderById(folderId); f; f = teknikFolderById(f.parentId)) names.unshift(f.name);
  return names.join(' › ');
}

function teknikFolderLabel(folderId) {
  return folderId ? teknikFolderPath(folderId) : 'Øverst (ingen mappe)';
}

// Dropdown options: the top level, then every folder in tree order.
function teknikFolderOptions() {
  const options = [{ value: '', label: teknikFolderLabel(null) }];
  const walk = (parentId) => {
    for (const folder of teknikChildFolders(parentId).sort(teknikCompareNames)) {
      options.push({ value: folder.id, label: teknikFolderPath(folder.id) });
      walk(folder.id);
    }
  };
  walk(null);
  return options;
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

function teknikUsedBytes() {
  return teknikState.files.reduce((sum, f) => sum + (f.size || 0), 0);
}

// Space still free once this tab's queued uploads have landed.
function teknikFreeBytes() {
  const queued = teknikQueue.reduce((sum, item) => sum + (item.state === 'failed' ? 0 : item.file.size), 0);
  return Math.max(0, teknikQuotaBytes - teknikUsedBytes() - queued);
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
  if (Number.isInteger(result.data.quotaBytes)) teknikQuotaBytes = result.data.quotaBytes;
  // Forget open folders that no longer exist.
  for (const id of [...teknikOpenFolders]) if (!teknikFolderById(id)) teknikOpenFolders.delete(id);
  teknikSaveOpenFolders();
  teknikRender();
}

function teknikRender() {
  const root = teknikRoot();
  if (!root || !teknikState) return;
  const card = el('section', 'card teknik-card');

  const head = el('div', 'card-head teknik-card-head');
  head.appendChild(el('h2', null, 'Filer'));
  const center = el('div', 'teknik-head-center');
  const newFolderBtn = teknikBtn('+ Mappe');
  newFolderBtn.addEventListener('click', () => teknikOpenNewFolderModal(null));
  center.appendChild(newFolderBtn);
  head.appendChild(center);
  // Equal-width pair (CSS grid 1fr 1fr).
  const uploadBtns = el('div', 'teknik-upload-btns');
  const uploadBtn = teknikBtn('Upload filer');
  uploadBtn.addEventListener('click', () => teknikPickFiles(null));
  uploadBtns.appendChild(uploadBtn);
  const videoBtn = teknikBtn('Upload videoer');
  videoBtn.addEventListener('click', () => teknikOpenVideoUploadModal(null));
  uploadBtns.appendChild(videoBtn);
  head.appendChild(uploadBtns);
  card.appendChild(head);

  const list = el('div', 'teknik-list');
  teknikBuildLevel(list, null, 0);
  if (!list.childElementCount) {
    list.appendChild(el('p', 'teknik-muted teknik-empty',
      'Her er ingen filer endnu. Opret en mappe, eller træk filer hertil.'));
  }
  card.appendChild(list);
  if (teknikState.files.length) {
    const foot = el('div', 'teknik-card-foot');
    const allBtn = teknikBtn('Download alt');
    allBtn.title = 'Hele Teknikken som én .zip-fil';
    allBtn.addEventListener('click', () => teknikDownloadFolder(null));
    foot.appendChild(allBtn);
    card.appendChild(foot);
  }
  teknikWireDrop(card);

  // The usage bar and the upload panel survive re-renders of the list.
  root.replaceChildren(teknikUsageEl(), card, teknikUploadPanel());
  teknikRenderUsage();
  teknikRenderUploads();
}

// Folders, then files, of one level; an open folder's contents follow
// right after its row, one step further in.
function teknikBuildLevel(list, parentId, depth) {
  for (const folder of teknikChildFolders(parentId).sort(teknikCompareNames)) {
    list.appendChild(teknikBuildFolderRow(folder, depth));
    if (!teknikOpenFolders.has(folder.id)) continue;
    const before = list.childElementCount;
    teknikBuildLevel(list, folder.id, depth + 1);
    if (list.childElementCount === before) {
      const empty = el('div', 'teknik-row teknik-empty-row', 'Tom mappe');
      empty.style.setProperty('--depth', depth + 1);
      empty.dataset.target = folder.id;
      list.appendChild(empty);
    }
  }
  for (const file of teknikFolderFiles(parentId).sort(teknikCompareNames)) {
    list.appendChild(teknikBuildFileRow(file, depth));
  }
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

function teknikBuildFolderRow(folder, depth) {
  const isOpen = teknikOpenFolders.has(folder.id);
  const row = el('div', 'teknik-row teknik-folder-row' + (isOpen ? ' open' : ''));
  row.style.setProperty('--depth', depth);
  row.dataset.folderId = folder.id;
  row.dataset.target = folder.id;

  const toggle = el('button', 'teknik-row-main');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  toggle.appendChild(el('span', 'teknik-chevron', isOpen ? '▾' : '▸'));
  const icon = el('span', 'teknik-folder-icon');
  icon.appendChild(teknikFolderIcon());
  toggle.appendChild(icon);
  toggle.appendChild(el('span', 'teknik-row-name', folder.name));
  toggle.addEventListener('click', () => {
    if (teknikOpenFolders.has(folder.id)) teknikOpenFolders.delete(folder.id);
    else teknikOpenFolders.add(folder.id);
    teknikSaveOpenFolders();
    teknikRender();
  });
  row.appendChild(toggle);
  row.appendChild(el('span', 'teknik-row-meta', teknikFolderSummary(folder)));

  const actions = el('div', 'teknik-row-actions');
  const downloadBtn = teknikIconBtn(teknikDownloadIcon(), 'Download mappen som .zip');
  downloadBtn.addEventListener('click', () => teknikDownloadFolder(folder.id));
  actions.appendChild(downloadBtn);
  const editBtn = teknikIconBtn(teknikPencilIcon(), 'Omdøb mappen');
  editBtn.addEventListener('click', () => teknikOpenRenameFolderModal(folder));
  actions.appendChild(editBtn);
  const removeBtn = teknikRemoveBtn('Slet mappen');
  removeBtn.addEventListener('click', () => teknikConfirmDeleteFolder(folder));
  actions.appendChild(removeBtn);
  row.appendChild(actions);
  return row;
}

function teknikBuildFileRow(file, depth) {
  const row = el('div', 'teknik-row teknik-file-row');
  row.style.setProperty('--depth', depth);
  row.dataset.target = file.folderId || '';
  row.draggable = true;
  teknikWireFileDrag(row, file);

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
    teknikFormatBytes(file.size || 0) + (date ? ' · ' + formatDaDate(date) : '')
    + (file.uploadedBy ? ' · ' + file.uploadedBy : '')));

  const actions = el('div', 'teknik-row-actions');
  const downloadBtn = teknikIconBtn(teknikDownloadIcon(), 'Download');
  downloadBtn.addEventListener('click', () => teknikDownloadFile(file));
  actions.appendChild(downloadBtn);
  const editBtn = teknikIconBtn(teknikPencilIcon(), 'Omdøb eller flyt');
  editBtn.addEventListener('click', () => teknikOpenEditFileModal(file));
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

// ── Usage bar (top centre) ───────────────────────────────────
let teknikUsageNode = null;

function teknikUsageEl() {
  if (!teknikUsageNode) teknikUsageNode = el('div', 'teknik-usage');
  return teknikUsageNode;
}

function teknikRenderUsage() {
  const node = teknikUsageEl();
  const used = teknikUsedBytes();
  const pct = Math.min(100, (used / teknikQuotaBytes) * 100);
  node.classList.toggle('teknik-usage-full', pct >= 90);
  const bar = el('div', 'teknik-usage-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.setAttribute('aria-label', 'Brugt plads');
  const fill = el('div', 'teknik-usage-fill');
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  const free = Math.max(0, teknikQuotaBytes - used);
  node.replaceChildren(bar, el('div', 'teknik-usage-text',
    `${teknikFormatBytes(used)} af ${teknikFormatBytes(teknikQuotaBytes)} brugt · ${teknikFormatBytes(free)} ledigt`));
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

// Modal chrome for a Navn field (+ optional Mappe dropdown) and Annuller/
// confirm. `submit({name, folderId})` returns an error message, '' when
// done, or null for a cancelled password prompt.
function teknikOpenFormModal({ title, name, placeholder, folderLabel, folderId, confirmLabel, submit }) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose(title);
  modal.classList.add('teknik-name-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 190;
  input.value = name;
  input.placeholder = placeholder || '';
  form.appendChild(siteEditField('Navn', input));
  let folderField = null;
  if (folderLabel) {
    folderField = siteCreateDropdownField(teknikFolderOptions(), folderId || '');
    form.appendChild(siteEditField(folderLabel, folderField));
  }
  const cancelBtn = teknikPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const saveBtn = teknikPillBtn(confirmLabel, 'site-btn-success');
  async function onSubmit() {
    const value = input.value.trim();
    if (!value) { error.textContent = 'Skriv et navn.'; input.focus(); return; }
    saveBtn.disabled = true;
    error.textContent = '';
    const message = await submit({ name: value, folderId: folderField ? (folderField.value || null) : null });
    saveBtn.disabled = false;
    if (message === null) return;
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

function teknikOpenNewFolderModal(parentId) {
  teknikOpenFormModal({
    title: 'Ny mappe', name: '', placeholder: 'Fx Lyd, Video, Slides',
    folderLabel: 'Placering', folderId: parentId, confirmLabel: 'Opret',
    async submit({ name, folderId }) {
      const result = await teknikApi('teknik_create_folder', { parentId: folderId, name });
      if (!result.ok) return result.message || null;
      teknikState.folders.push(result.data.folder);
      if (folderId) teknikOpenFolders.add(folderId); // show the new folder
      teknikSaveOpenFolders();
      teknikRender();
      return '';
    },
  });
}

function teknikOpenRenameFolderModal(folder) {
  teknikOpenFormModal({
    title: 'Omdøb mappe', name: folder.name, confirmLabel: 'Gem',
    async submit({ name }) {
      if (name === folder.name) return '';
      const result = await teknikApi('teknik_rename_folder', { folderId: folder.id, name });
      if (!result.ok) return result.message || null;
      folder.name = result.data.folder.name;
      teknikRender();
      return '';
    },
  });
}

// Rename and/or move (the Mappe dropdown is how touch screens move files).
function teknikOpenEditFileModal(file) {
  const oldName = teknikFileDisplayName(file);
  teknikOpenFormModal({
    title: 'Rediger fil', name: oldName, folderLabel: 'Mappe', folderId: file.folderId,
    confirmLabel: 'Gem',
    async submit({ name, folderId }) {
      if (name !== oldName) {
        const result = await teknikApi('teknik_rename_file', { fileId: file.id, name });
        if (!result.ok) return result.message || null;
        file.name = result.data.file.name;
      }
      if (folderId !== (file.folderId || null)) {
        const result = await teknikApi('teknik_move_file', { fileId: file.id, folderId });
        if (!result.ok) { teknikRender(); return result.message || null; }
        file.folderId = result.data.file.folderId;
      }
      teknikRender();
      return '';
    },
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
    for (const id of ids) teknikOpenFolders.delete(id);
    teknikSaveOpenFolders();
    teknikRender();
    return true;
  });
}

// ── Moving files (drag and drop) ─────────────────────────────
let teknikDragFile = null;
let teknikDragGhost = null;

// Shared off-screen drag image (the site-wide recipe).
function teknikGetDragImageEl() {
  if (!teknikDragGhost) {
    teknikDragGhost = el('div', 'teknik-drag-ghost');
    document.body.appendChild(teknikDragGhost);
  }
  return teknikDragGhost;
}

function teknikWireFileDrag(row, file) {
  row.addEventListener('dragstart', (e) => {
    teknikDragFile = file;
    const ghost = teknikGetDragImageEl();
    ghost.textContent = teknikFileDisplayName(file);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', file.name);
    e.dataTransfer.setDragImage(ghost, 12, 16);
    row.classList.add('teknik-dragging');
  });
  row.addEventListener('dragend', () => {
    teknikDragFile = null;
    row.classList.remove('teknik-dragging');
    teknikClearDropHighlight();
  });
}

function teknikClearDropHighlight() {
  document.querySelectorAll('.teknik-drop-target').forEach((n) => n.classList.remove('teknik-drop-target'));
}

// Where a drop at this element lands: a folder row → that folder, a file
// row → the folder it's in, anywhere else on the card → the top level.
function teknikDropTarget(node) {
  const row = node && node.closest ? node.closest('[data-target]') : null;
  return row ? (row.dataset.target || null) : null;
}

function teknikHighlightDrop(card, folderId) {
  const target = folderId ? card.querySelector(`.teknik-folder-row[data-folder-id="${folderId}"]`) : card;
  if (target && target.classList.contains('teknik-drop-target')) return;
  teknikClearDropHighlight();
  if (target) target.classList.add('teknik-drop-target');
}

// One handler on the card covers both a file row being moved and files
// dragged in from the desktop (which open the upload modal).
function teknikWireDrop(card) {
  const isDesktopFiles = (e) => !teknikDragFile && e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes('Files');
  card.addEventListener('dragover', (e) => {
    if (!teknikDragFile && !isDesktopFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = teknikDragFile ? 'move' : 'copy';
    teknikHighlightDrop(card, teknikDropTarget(e.target));
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) teknikClearDropHighlight();
  });
  card.addEventListener('drop', (e) => {
    const folderId = teknikDropTarget(e.target);
    teknikClearDropHighlight();
    if (teknikDragFile) {
      e.preventDefault();
      const file = teknikDragFile;
      teknikDragFile = null;
      teknikMoveFile(file, folderId);
      return;
    }
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    const dropped = Array.from(e.dataTransfer.files);
    // A lone video goes to the video flow (it needs its project file).
    if (dropped.length === 1 && teknikIsVideo(dropped[0])) teknikOpenVideoUploadModal(folderId, dropped[0]);
    else teknikOpenUploadModal(dropped, folderId);
  });
}

async function teknikMoveFile(file, folderId) {
  if ((file.folderId || null) === folderId) return;
  const result = await teknikApi('teknik_move_file', { fileId: file.id, folderId });
  if (!result.ok) { teknikShowError(result.message); return; }
  file.folderId = result.data.file.folderId;
  if (folderId) teknikOpenFolders.add(folderId);
  teknikSaveOpenFolders();
  teknikRender();
  siteShowToast(`Flyttet til ${folderId ? teknikFolderPath(folderId) : 'øverste niveau'}.`);
}

// ── Download / open ──────────────────────────────────────────
async function teknikSignedUrl(action, body) {
  const result = await teknikApi(action, body);
  if (!result.ok) { teknikShowError(result.message); return null; }
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  return SITE_API_ENDPOINT + sep + result.data.query;
}

// A hidden iframe starts the download without navigating this page (a
// navigation would fire beforeunload and warn during uploads). iOS shows
// downloads as a preview anyway, so it just goes there.
let teknikDownloadFrame = null;
function teknikStartDownload(url) {
  if (siteIsIos()) { window.location.href = url; return; }
  if (!teknikDownloadFrame) {
    teknikDownloadFrame = document.createElement('iframe');
    teknikDownloadFrame.hidden = true;
    teknikDownloadFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(teknikDownloadFrame);
  }
  teknikDownloadFrame.src = url;
}

async function teknikDownloadFile(file) {
  const url = await teknikSignedUrl('teknik_download_url', { fileId: file.id, inline: false });
  if (url) teknikStartDownload(url);
}

// A folder (null = everything) as one .zip, built while it downloads.
async function teknikDownloadFolder(folderId) {
  const files = folderId ? teknikSubtreeFiles(folderId) : teknikState.files;
  if (!files.length) { siteShowToast('Mappen er tom.'); return; }
  const url = await teknikSignedUrl('teknik_folder_download_url', { folderId });
  if (!url) return;
  teknikStartDownload(url);
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  siteShowToast(`Downloader ${teknikPlural(files.length, 'fil', 'filer')} (${teknikFormatBytes(total)}) som .zip …`);
}

// The window is opened synchronously (inside the click) so popup blockers
// allow it, then pointed at the file once its URL has arrived — same
// recipe as band.js's bandOpenFile.
async function teknikOpenFile(file) {
  const sameTab = siteIsIos();
  const win = sameTab ? null : window.open('', '_blank');
  const url = await teknikSignedUrl('teknik_download_url', { fileId: file.id, inline: true });
  if (!url) { if (win) win.close(); return; }
  if (sameTab || !win) { window.location.href = url; return; }
  win.location.replace(url);
}

// ── Upload modal ─────────────────────────────────────────────
function teknikPickFiles(folderId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    if (picked.length) teknikOpenUploadModal(picked, folderId);
  });
  input.click();
}

// The uploader's name, remembered per browser so it's only typed once.
const TEKNIK_UPLOADER_KEY = 'matrevy-teknik-uploader';

function teknikFileExt(name) {
  return (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
}

function teknikIsVideo(file) {
  return teknikFileKind(teknikFileExt(file.name)).key === 'video';
}

// The Afsender field shared by both upload modals.
function teknikBuildUploaderField() {
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.placeholder = 'Dit navn';
  try { input.value = localStorage.getItem(TEKNIK_UPLOADER_KEY) || ''; } catch (e) { /* storage blocked */ }
  return input;
}

function teknikRememberUploader(name) {
  try { localStorage.setItem(TEKNIK_UPLOADER_KEY, name); } catch (e) { /* storage blocked */ }
}

function teknikCleanBaseName(value) {
  return value.trim().replace(/[\\/]/g, '-');
}

function teknikNotEnoughSpace(total, free) {
  return `Der er ikke plads: filerne fylder ${teknikFormatBytes(total)}, men der er kun ${teknikFormatBytes(free)} ledigt `
    + `(højst ${teknikFormatBytes(teknikQuotaBytes)} i alt). Slet nogle filer først.`;
}

// Enter moves to the next text field, and submits from the last one.
function teknikWireEnterChain(inputs, submit) {
  inputs.forEach((input, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i + 1 < inputs.length) inputs[i + 1].focus();
      else submit();
    });
  });
}

// Asks who is uploading (required), lets each file be renamed (prefilled
// with its own name, extension kept) and which folder they go into
// (defaulting to the one they were dropped on); refuses a batch that won't fit.
// Videos are refused here — they go through teknikOpenVideoUploadModal().
function teknikOpenUploadModal(files, folderId) {
  const valid = files.filter((file) => {
    if (teknikIsVideo(file)) {
      siteShowToast(`"${file.name}" er en video — brug "Upload videoer".`);
      return false;
    }
    if (file.size) return true;
    siteShowToast(`"${file.name}" blev sprunget over — tom fil eller en mappe.`);
    return false;
  });
  if (!valid.length) return;
  const total = valid.reduce((sum, f) => sum + f.size, 0);

  const { modal, form, error, actions, close } = siteOpenModalWithClose(
    valid.length === 1 ? 'Upload fil' : `Upload ${valid.length} filer`
  );
  modal.classList.add('teknik-upload-modal');
  const uploaderInput = teknikBuildUploaderField();
  form.appendChild(siteEditField('Afsender', uploaderInput));

  form.appendChild(el('p', 'teknik-upload-label', valid.length === 1 ? 'Filnavn' : 'Filnavne'));
  const list = el('ul', 'teknik-upload-list');
  const entries = valid.map((file) => {
    const ext = teknikFileExt(file.name);
    const item = el('li', 'edit-field teknik-upload-item'); // .edit-field = site input styling
    const head = el('div', 'teknik-upload-item-head');
    const kind = teknikFileKind(ext);
    head.appendChild(el('span', 'teknik-kind teknik-kind-' + kind.key, kind.label));
    head.appendChild(el('span', 'teknik-upload-item-name', file.name));
    head.appendChild(el('span', 'teknik-upload-item-size', teknikFormatBytes(file.size)));
    item.appendChild(head);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 180;
    input.value = teknikFileDisplayName({ name: file.name, ext });
    input.setAttribute('aria-label', `Navn til ${file.name}`);
    item.appendChild(input);
    list.appendChild(item);
    return { file, ext, input };
  });
  form.appendChild(list);
  const folderField = siteCreateDropdownField(teknikFolderOptions(), folderId || '');
  form.appendChild(siteEditField('Upload til', folderField));
  const free = teknikFreeBytes();
  form.appendChild(el('p', 'teknik-upload-space',
    `I alt ${teknikFormatBytes(total)} · ${teknikFormatBytes(free)} ledigt`));

  const cancelBtn = teknikPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const uploadBtn = teknikPillBtn('Upload', 'site-btn-success');
  if (total > free) {
    error.textContent = teknikNotEnoughSpace(total, free);
    uploadBtn.disabled = true;
  }
  function submit() {
    if (uploadBtn.disabled) return;
    const uploadedBy = uploaderInput.value.trim();
    if (!uploadedBy) {
      error.textContent = 'Skriv hvem du er.';
      uploaderInput.focus();
      return;
    }
    const missing = entries.find((entry) => !entry.input.value.trim());
    if (missing) {
      error.textContent = 'Giv hver fil et navn.';
      missing.input.focus();
      return;
    }
    teknikRememberUploader(uploadedBy);
    const target = folderField.value || null;
    close();
    if (target) { teknikOpenFolders.add(target); teknikSaveOpenFolders(); teknikRender(); }
    teknikEnqueue(entries.map(({ file, ext, input }) => {
      const base = teknikCleanBaseName(input.value);
      return { file, name: ext ? `${base}.${ext}` : base };
    }), target, uploadedBy);
  }
  uploadBtn.addEventListener('click', submit);
  teknikWireEnterChain([uploaderInput, ...entries.map((entry) => entry.input)], submit);
  actions.appendChild(cancelBtn);
  actions.appendChild(uploadBtn);
  if (uploaderInput.value) uploadBtn.focus();
  else uploaderInput.focus();
}

// ── Video upload modal ───────────────────────────────────────
const TEKNIK_VIDEO_EXTS = TEKNIK_KINDS.find((k) => k.key === 'video').exts;

// A "Vælg …" button + the chosen file underneath. `check(file)` returns an
// error message or ''. Returns {wrap, get file()}.
function teknikFilePickField(buttonLabel, accept, check, onPick) {
  let chosen = null;
  const wrap = el('div', 'teknik-pick-row');
  const btn = teknikBtn(buttonLabel);
  const shown = el('div', 'teknik-upload-item-head teknik-pick-chosen');
  shown.hidden = true;
  btn.addEventListener('click', () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => {
      const file = input.files && input.files[0];
      if (file) pick(file);
    });
    input.click();
  });
  function pick(file) {
    const problem = check(file);
    if (problem) { onPick(null, problem); return; }
    chosen = file;
    const kind = teknikFileKind(teknikFileExt(file.name));
    shown.replaceChildren(
      el('span', 'teknik-kind teknik-kind-' + kind.key, kind.label),
      el('span', 'teknik-upload-item-name', file.name),
      el('span', 'teknik-upload-item-size', teknikFormatBytes(file.size)),
    );
    shown.hidden = false;
    btn.textContent = 'Skift fil';
    onPick(file, '');
  }
  wrap.appendChild(btn);
  wrap.appendChild(shown);
  return { wrap, pick, get file() { return chosen; } };
}

// One video + its whole editing project as a .zip, both required, uploaded
// as "<Navn>.<ext>" and "<Navn> (projektfil).zip".
function teknikOpenVideoUploadModal(folderId, initialVideo) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Upload video');
  modal.classList.add('teknik-upload-modal');

  const uploaderInput = teknikBuildUploaderField();
  form.appendChild(siteEditField('Afsender', uploaderInput));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.maxLength = 160;
  nameInput.placeholder = 'Fx Intro-video';
  let nameTouched = false;
  nameInput.addEventListener('input', () => { nameTouched = true; });

  const video = teknikFilePickField(
    'Vælg video',
    'video/*,' + TEKNIK_VIDEO_EXTS.map((ext) => '.' + ext).join(','),
    (file) => {
      if (!teknikIsVideo(file)) return `"${file.name}" er ikke en videofil.`;
      return file.size ? '' : `"${file.name}" er tom.`;
    },
    (file, problem) => {
      error.textContent = problem;
      if (file && (!nameTouched || !nameInput.value.trim())) {
        nameInput.value = teknikFileDisplayName({ name: file.name, ext: teknikFileExt(file.name) });
        nameTouched = false;
      }
      refreshSpace();
    },
  );
  const project = teknikFilePickField(
    'Vælg .zip',
    '.zip,application/zip',
    (file) => {
      if (teknikFileExt(file.name) !== 'zip') return `"${file.name}" er ikke en .zip-fil.`;
      return file.size ? '' : `"${file.name}" er tom.`;
    },
    (file, problem) => { error.textContent = problem; refreshSpace(); },
  );
  const videoField = el('div', 'edit-field');
  videoField.appendChild(el('p', 'teknik-upload-label', 'Videofil'));
  videoField.appendChild(video.wrap);
  form.appendChild(videoField);
  const projectField = el('div', 'edit-field');
  projectField.appendChild(el('p', 'teknik-upload-label', 'Projektfil'));
  projectField.appendChild(el('p', 'teknik-upload-note',
    'Hele projektet (fx Premiere- eller Final Cut-mappen) pakket som én .zip-fil.'));
  projectField.appendChild(project.wrap);
  form.appendChild(projectField);

  form.appendChild(siteEditField('Navn', nameInput));
  const folderField = siteCreateDropdownField(teknikFolderOptions(), folderId || '');
  form.appendChild(siteEditField('Upload til', folderField));
  const space = el('p', 'teknik-upload-space');
  form.appendChild(space);

  const cancelBtn = teknikPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const uploadBtn = teknikPillBtn('Upload', 'site-btn-success');

  function total() {
    return (video.file ? video.file.size : 0) + (project.file ? project.file.size : 0);
  }
  function refreshSpace() {
    const free = teknikFreeBytes();
    space.textContent = `I alt ${teknikFormatBytes(total())} · ${teknikFormatBytes(free)} ledigt`;
    uploadBtn.disabled = total() > free;
    if (uploadBtn.disabled) error.textContent = teknikNotEnoughSpace(total(), free);
  }

  function submit() {
    if (uploadBtn.disabled) return;
    const uploadedBy = uploaderInput.value.trim();
    const base = teknikCleanBaseName(nameInput.value);
    if (!uploadedBy) { error.textContent = 'Skriv hvem du er.'; uploaderInput.focus(); return; }
    if (!video.file) { error.textContent = 'Vælg en videofil.'; return; }
    if (!project.file) { error.textContent = 'Vælg projektfilen (.zip).'; return; }
    if (!base) { error.textContent = 'Giv videoen et navn.'; nameInput.focus(); return; }
    teknikRememberUploader(uploadedBy);
    const target = folderField.value || null;
    close();
    if (target) { teknikOpenFolders.add(target); teknikSaveOpenFolders(); teknikRender(); }
    teknikEnqueue([
      { file: video.file, name: `${base}.${teknikFileExt(video.file.name)}` },
      { file: project.file, name: `${base} (projektfil).zip` },
    ], target, uploadedBy);
  }
  uploadBtn.addEventListener('click', submit);
  teknikWireEnterChain([uploaderInput, nameInput], submit);
  actions.appendChild(cancelBtn);
  actions.appendChild(uploadBtn);
  if (initialVideo) video.pick(initialVideo);
  refreshSpace();
  if (!uploaderInput.value) uploaderInput.focus();
}

// ── Upload queue ─────────────────────────────────────────────
// [{key, file, name, uploadedBy, folderId, sent, state: 'waiting'|'uploading'|'failed', message, cancelled, uploadId}]
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

// `items` = [{file, name}], name being the one given in the upload modal.
function teknikEnqueue(items, folderId, uploadedBy) {
  for (const { file, name } of items) {
    teknikQueue.push({ key: ++teknikUploadKey, file, name, uploadedBy, folderId, sent: 0, state: 'waiting', message: '', cancelled: false, uploadId: null });
  }
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
  const top = el('div', 'teknik-upload-top');
  top.appendChild(el('span', 'teknik-upload-name', item.name));
  top.appendChild(el('span', 'teknik-upload-where', '→ ' + (item.folderId ? teknikFolderPath(item.folderId) || 'slettet mappe' : 'Øverst')));
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
  else if (item.cancelled) item.statusEl.textContent = 'Annullerer…';
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
    teknikPaintUpload(item);
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
      teknikQueue.splice(teknikQueue.indexOf(item), 1);
      teknikState.files.push(outcome.file);
      teknikRender();
      siteShowToast(`"${item.name}" er uploadet.`);
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
  const start = await teknikApi('teknik_upload_start', {
    folderId: item.folderId, name: item.name, uploadedBy: item.uploadedBy, size: file.size,
  });
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

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (!teknikUploadsPending()) return;
  e.preventDefault();
  e.returnValue = '';
});

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
