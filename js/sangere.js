/* =========================================================
   Matematikrevyen – Sangere (sangere.html)

   The singers' practice audio during the revy: a nested folder tree of
   sound files, capped at 500 MB for the whole store (a usage bar at the
   top). A page-scoped copy of teknikken.js on its own store: the server
   runs Teknikken's store code on SANGERE_DATA_DIR via the sangere_*
   actions (teknik_stores() in update-data.php). One store for the whole
   site, not per revy, never archived, and emptied by Koordinator's
   "Afslut revyen" (people save what they want to keep).

   Differences from Teknikken: one "Upload lyd-filer" button (audio
   files only), every file gets a name typed in the upload modal, like
   Bandet's sheet music (sent as "<navn>.<ext>", shown without the
   extension), no Afsender and no Boss Box.

   Uploads go in 8 MB base64 chunks (sangere_upload_start → _chunk × N →
   _finish), one file at a time; downloads ask for a short-lived signed
   URL and let the browser fetch it natively.

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
function sangBtn(label, extraClass) {
  const btn = el('button', 'btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  btn.type = 'button';
  return btn;
}

// Second-level button, for buttons inside a modal overlay only.
function sangPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

function sangRemoveBtn(title) {
  const btn = el('button', 'sang-remove-btn', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

function sangIconBtn(icon, title) {
  const btn = el('button', 'sang-icon-btn');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(icon);
  return btn;
}

function sangSvg(viewBox, size, strokeWidth, paths) {
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
function sangDownloadIcon() {
  return sangSvg('0 0 24 24', 16, 2, ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14']);
}

// Pencil glyph — same drawing as band.js's bandPencilIcon.
function sangPencilIcon() {
  return sangSvg('0 0 16 16', 15, 1.3, ['M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z', 'M9 4l3 3']);
}

function sangFolderIcon() {
  return sangSvg('0 0 24 24', 20, 1.8, ['M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z']);
}

// ── Authenticated API (mirrors band.js's bandApi) ────────────
const SANG_DEFAULT_QUOTA_BYTES = 500 * 1024 * 1024; // mirrors teknik_stores()['sangere'] in update-data.php
const SANG_CHUNK_BYTES = 8 * 1024 * 1024; // mirrors teknik_max_chunk_bytes()
const SANG_CHUNK_ATTEMPTS = 4;

function sangResolvePassword() {
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

function sangMapError(status, detail) {
  if (detail === 'uploads_closed') return SANG_CLOSED_TEXT;
  if (detail === 'quota_exceeded') {
    return `Der er ikke plads nok. Sangernes filer må højst fylde ${sangFormatBytes(sangQuotaBytes)} i alt. Slet nogle filer først.`;
  }
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. En anden har måske lige slettet den. Genindlæs siden.';
  if (status === 507 || detail === 'disk_full') return 'Serveren er ved at løbe tør for plads. Sig det til Carl.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, status, message, data } —
// message '' = cancelled password prompt (silent no-op).
async function sangApi(action, body) {
  const password = sangResolvePassword();
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
  if (!res.ok) return { ok: false, status: res.status, message: sangMapError(res.status, detail), data };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.', data };
  }
  return { ok: true, data };
}

function sangShowError(message) {
  if (message) siteShowToast(message);
}

// ── State ────────────────────────────────────────────────────
let sangState = null; // { folders, files } once loaded
let sangQuotaBytes = SANG_DEFAULT_QUOTA_BYTES;
// False while no revy is active (Koordinator's "Afslut revyen" closes
// uploads until "Ny Revy"); the server refuses them too (uploads_closed).
let sangUploadsOpen = true;
const SANG_CLOSED_TEXT = 'Revyen er afsluttet, så der kan ikke uploades lydfiler, før en ny revy er startet.';
const SANG_OPEN_KEY = 'matrevy-sangere-open';
const sangOpenFolders = (() => {
  try { return new Set(JSON.parse(localStorage.getItem(SANG_OPEN_KEY) || '[]')); } catch (e) { return new Set(); }
})();

function sangSaveOpenFolders() {
  try { localStorage.setItem(SANG_OPEN_KEY, JSON.stringify([...sangOpenFolders])); } catch (e) { /* ignore */ }
}

function sangRoot() {
  return document.getElementById('sangere-root');
}

function sangFolderById(id) {
  return id ? (sangState.folders.find((f) => f.id === id) || null) : null;
}

function sangChildFolders(parentId) {
  return sangState.folders.filter((f) => (f.parentId || null) === parentId);
}

function sangFolderFiles(folderId) {
  return sangState.files.filter((f) => (f.folderId || null) === folderId);
}

// Every folder id at or below `folderId`.
function sangSubtreeIds(folderId) {
  const ids = new Set([folderId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of sangState.folders) {
      if (!ids.has(f.id) && ids.has(f.parentId)) { ids.add(f.id); grew = true; }
    }
  }
  return ids;
}

function sangSubtreeFiles(folderId) {
  const ids = sangSubtreeIds(folderId);
  return sangState.files.filter((f) => ids.has(f.folderId));
}

// "Revysange › Stemme 1"
function sangFolderPath(folderId) {
  const names = [];
  for (let f = sangFolderById(folderId); f; f = sangFolderById(f.parentId)) names.unshift(f.name);
  return names.join(' › ');
}

function sangFolderLabel(folderId) {
  return folderId ? sangFolderPath(folderId) : 'Øverst (ingen mappe)';
}

// Dropdown options: the top level, then every folder in tree order.
function sangFolderOptions() {
  const options = [{ value: '', label: sangFolderLabel(null) }];
  const walk = (parentId) => {
    for (const folder of sangChildFolders(parentId).sort(sangCompareNames)) {
      options.push({ value: folder.id, label: sangFolderPath(folder.id) });
      walk(folder.id);
    }
  };
  walk(null);
  return options;
}

function sangCompareNames(a, b) {
  return (a.name || '').localeCompare(b.name || '', 'da', { sensitivity: 'base', numeric: true });
}

function sangFormatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return value.toLocaleString('da-DK', { maximumFractionDigits: digits }) + ' ' + units[unit];
}

function sangPlural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

function sangUsedBytes() {
  return sangState.files.reduce((sum, f) => sum + (f.size || 0), 0);
}

// Space still free once this tab's queued uploads have landed.
function sangFreeBytes() {
  const queued = sangQueue.reduce((sum, item) => sum + (item.state === 'failed' ? 0 : item.file.size), 0);
  return Math.max(0, sangQuotaBytes - sangUsedBytes() - queued);
}

// ── File kinds ───────────────────────────────────────────────
// Only audio is uploaded here; the kind badge still covers anything else.
const SANG_AUDIO_EXTS = ['mp3', 'wav', 'm4a', 'aac', 'aif', 'aiff', 'flac', 'ogg'];
const SANG_KINDS = [
  { key: 'audio', label: 'LYD', exts: SANG_AUDIO_EXTS },
];
// Mirrors teknik_inline_types(): what opens (plays) in a browser tab on click.
const SANG_INLINE_EXTS = ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac'];

function sangFileKind(ext) {
  const kind = SANG_KINDS.find((k) => k.exts.includes(ext));
  if (kind) return kind;
  return { key: 'other', label: ext ? ext.toUpperCase().slice(0, 5) : 'FIL' };
}

function sangFileDisplayName(file) {
  return file.ext ? file.name.replace(new RegExp('\\.' + file.ext + '$', 'i'), '') || file.name : file.name;
}

// ── Load + render ────────────────────────────────────────────
async function sangLoad() {
  const root = sangRoot();
  root.replaceChildren(el('p', 'sang-muted', 'Indlæser…'));
  const result = await sangApi('sangere_read', {});
  if (!result.ok) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'sang-error', result.message || 'Kunne ikke indlæse Sangere.'));
    root.replaceChildren(card);
    return;
  }
  sangState = { folders: result.data.folders || [], files: result.data.files || [] };
  if (Number.isInteger(result.data.quotaBytes)) sangQuotaBytes = result.data.quotaBytes;
  sangUploadsOpen = result.data.uploadsOpen !== false;
  sangGuideSaved = result.data.guide || null;
  // Forget open folders that no longer exist.
  for (const id of [...sangOpenFolders]) if (!sangFolderById(id)) sangOpenFolders.delete(id);
  sangSaveOpenFolders();
  sangRender();
  if (!sangGuideEditing) sangRenderGuide();
}

function sangRender() {
  const root = sangRoot();
  if (!root || !sangState) return;
  const card = el('section', 'card sang-card');

  const head = el('div', 'card-head sang-card-head');
  head.appendChild(el('h2', null, 'Filer'));
  const center = el('div', 'sang-head-center');
  const newFolderBtn = sangBtn('+ Mappe');
  newFolderBtn.addEventListener('click', () => sangOpenNewFolderModal(null));
  center.appendChild(newFolderBtn);
  head.appendChild(center);
  const uploadBtns = el('div', 'sang-upload-btns');
  const uploadBtn = sangBtn('Upload lyd-filer');
  uploadBtn.addEventListener('click', () => sangPickFiles(null));
  uploadBtn.disabled = !sangUploadsOpen;
  uploadBtns.appendChild(uploadBtn);
  head.appendChild(uploadBtns);
  card.appendChild(head);
  if (!sangUploadsOpen) {
    card.appendChild(el('p', 'sang-muted sang-closed-notice', SANG_CLOSED_TEXT));
  }

  const list = el('div', 'sang-list');
  sangBuildLevel(list, null, 0);
  if (!list.childElementCount) {
    list.appendChild(el('p', 'sang-muted sang-empty', sangUploadsOpen
      ? 'Her er ingen lydfiler endnu. Opret en mappe, eller træk lydfiler hertil.'
      : 'Her er ingen filer.'));
  }
  card.appendChild(list);
  if (sangState.files.length) {
    const foot = el('div', 'sang-card-foot');
    const allBtn = sangBtn('Download alt');
    allBtn.title = 'Alle lydfilerne som én .zip-fil';
    allBtn.addEventListener('click', () => sangDownloadFolder(null));
    foot.appendChild(allBtn);
    card.appendChild(foot);
  }
  sangWireDrop(card);

  // The usage bar and the upload panel survive re-renders of the list.
  root.replaceChildren(sangUsageEl(), card, sangUploadPanel());
  sangRenderUsage();
  sangRenderUploads();
}

// Folders, then files, of one level; an open folder's contents follow
// right after its row, one step further in.
function sangBuildLevel(list, parentId, depth) {
  for (const folder of sangChildFolders(parentId).sort(sangCompareNames)) {
    list.appendChild(sangBuildFolderRow(folder, depth));
    if (!sangOpenFolders.has(folder.id)) continue;
    const before = list.childElementCount;
    sangBuildLevel(list, folder.id, depth + 1);
    if (list.childElementCount === before) {
      const empty = el('div', 'sang-row sang-empty-row', 'Tom mappe');
      empty.style.setProperty('--depth', depth + 1);
      empty.dataset.target = folder.id;
      list.appendChild(empty);
    }
  }
  for (const file of sangFolderFiles(parentId).sort(sangCompareNames)) {
    list.appendChild(sangBuildFileRow(file, depth));
  }
}

function sangFolderSummary(folder) {
  const subfolders = sangChildFolders(folder.id).length;
  const files = sangFolderFiles(folder.id).length;
  if (!subfolders && !files) return 'Tom';
  const parts = [];
  if (subfolders) parts.push(sangPlural(subfolders, 'mappe', 'mapper'));
  if (files) parts.push(sangPlural(files, 'fil', 'filer'));
  return parts.join(', ');
}

function sangBuildFolderRow(folder, depth) {
  const isOpen = sangOpenFolders.has(folder.id);
  const row = el('div', 'sang-row sang-folder-row' + (isOpen ? ' open' : ''));
  row.style.setProperty('--depth', depth);
  row.dataset.folderId = folder.id;
  row.dataset.target = folder.id;

  const toggle = el('button', 'sang-row-main');
  toggle.type = 'button';
  toggle.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
  toggle.appendChild(el('span', 'sang-chevron', isOpen ? '▾' : '▸'));
  const icon = el('span', 'sang-folder-icon');
  icon.appendChild(sangFolderIcon());
  toggle.appendChild(icon);
  toggle.appendChild(el('span', 'sang-row-name', folder.name));
  toggle.addEventListener('click', () => {
    if (sangOpenFolders.has(folder.id)) sangOpenFolders.delete(folder.id);
    else sangOpenFolders.add(folder.id);
    sangSaveOpenFolders();
    sangRender();
  });
  row.appendChild(toggle);
  row.appendChild(el('span', 'sang-row-meta', sangFolderSummary(folder)));

  const actions = el('div', 'sang-row-actions');
  const downloadBtn = sangIconBtn(sangDownloadIcon(), 'Download mappen som .zip');
  downloadBtn.addEventListener('click', () => sangDownloadFolder(folder.id));
  actions.appendChild(downloadBtn);
  const editBtn = sangIconBtn(sangPencilIcon(), 'Omdøb mappen');
  editBtn.addEventListener('click', () => sangOpenRenameFolderModal(folder));
  actions.appendChild(editBtn);
  const removeBtn = sangRemoveBtn('Slet mappen');
  removeBtn.addEventListener('click', () => sangConfirmDeleteFolder(folder));
  actions.appendChild(removeBtn);
  row.appendChild(actions);
  return row;
}

function sangBuildFileRow(file, depth) {
  const row = el('div', 'sang-row sang-file-row');
  row.style.setProperty('--depth', depth);
  row.dataset.target = file.folderId || '';
  row.draggable = true;
  sangWireFileDrag(row, file);

  const kind = sangFileKind(file.ext);
  const inline = SANG_INLINE_EXTS.includes(file.ext);
  const open = el('button', 'sang-row-main');
  open.type = 'button';
  open.title = inline ? 'Åbn' : 'Download';
  open.appendChild(el('span', 'sang-kind sang-kind-' + kind.key, kind.label));
  open.appendChild(el('span', 'sang-row-name', sangFileDisplayName(file)));
  open.addEventListener('click', () => (inline ? sangOpenFile(file) : sangDownloadFile(file)));
  row.appendChild(open);
  const date = (file.uploadedAt || '').slice(0, 10);
  row.appendChild(el('span', 'sang-row-meta',
    sangFormatBytes(file.size || 0) + (date ? ' · ' + formatDaDate(date) : '')));

  const actions = el('div', 'sang-row-actions');
  const downloadBtn = sangIconBtn(sangDownloadIcon(), 'Download');
  downloadBtn.addEventListener('click', () => sangDownloadFile(file));
  actions.appendChild(downloadBtn);
  const editBtn = sangIconBtn(sangPencilIcon(), 'Omdøb eller flyt');
  editBtn.addEventListener('click', () => sangOpenEditFileModal(file));
  actions.appendChild(editBtn);
  const removeBtn = sangRemoveBtn('Slet fil');
  removeBtn.addEventListener('click', () => {
    sangConfirm(`Slet "${sangFileDisplayName(file)}"?`, 'Dette kan ikke fortrydes.', 'Slet', async () => {
      const result = await sangApi('sangere_delete_file', { fileId: file.id });
      if (!result.ok) { sangShowError(result.message); return false; }
      sangState.files = sangState.files.filter((f) => f.id !== file.id);
      sangRender();
      return true;
    });
  });
  actions.appendChild(removeBtn);
  row.appendChild(actions);
  return row;
}

// ── Usage bar (top centre) ───────────────────────────────────
let sangUsageNode = null;

function sangUsageEl() {
  if (!sangUsageNode) sangUsageNode = el('div', 'sang-usage');
  return sangUsageNode;
}

function sangRenderUsage() {
  const node = sangUsageEl();
  const used = sangUsedBytes();
  const pct = Math.min(100, (used / sangQuotaBytes) * 100);
  node.classList.toggle('sang-usage-full', pct >= 90);
  const bar = el('div', 'sang-usage-bar');
  bar.setAttribute('role', 'progressbar');
  bar.setAttribute('aria-valuemin', '0');
  bar.setAttribute('aria-valuemax', '100');
  bar.setAttribute('aria-valuenow', String(Math.round(pct)));
  bar.setAttribute('aria-label', 'Brugt plads');
  const fill = el('div', 'sang-usage-fill');
  fill.style.width = pct + '%';
  bar.appendChild(fill);
  node.replaceChildren(bar, el('div', 'sang-usage-text',
    `${sangFormatBytes(used)} af ${sangFormatBytes(sangQuotaBytes)} brugt`));
}

// ── Guide til øvetracks med Moises.ai ────────────────────────
// Below Filer, laid out like Koordinator's "Guide til Arkivering"
// (renderKoordGuide): intro, then one heading + paragraph per step; a URL in
// the text becomes a link (sangLinkify). Saved in sangere.json via the boss
// sangere_set_guide action; SANG_GUIDE is shown until it has been saved once.
// Boss/admin edit it in place like Forside's Bosser card: the pencil in the
// card head turns on editing, the check mark saves and leaves it. It lives
// in its own #sangere-guide container, so sangRender() (folder toggles,
// finished uploads) never rebuilds it mid-edit.
const SANG_GUIDE = {
  title: 'Guide til øvetracks med Moises.ai',
  intro: 'Sådan laver du øvetracks til sangerne, fx en version uden vokal at synge med på eller en med kun vokalen. '
    + '(Udkast, teksten kommer snart.)',
  steps: [
    {
      title: '1. Find sangen',
      text: 'Skaf originalsangen som en lydfil (mp3). Ligger den kun på YouTube eller Spotify, så brug en side, der kan '
        + 'hente lyden ned som mp3.',
    },
    {
      title: '2. Upload til Moises',
      text: 'Log ind på https://moises.ai og upload lydfilen.',
    },
    {
      title: '3. Del sangen op',
      text: 'Vælg hvilke spor Moises skal skille ad (fx vokal og instrumenter), og hent de spor ned, I skal bruge.',
    },
    {
      title: '4. Upload her',
      text: 'Upload sporene ovenfor med "Upload lyd-filer" i sangens mappe, og giv dem et navn, så det er tydeligt, hvad de er.',
    },
  ],
};

// Text nodes with every http(s) URL as a link opening in a new tab.
function sangLinkify(text) {
  const frag = document.createDocumentFragment();
  const re = /https?:\/\/[^\s]+[^\s.,;:!?)]/g;
  let last = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const a = el('a', 'sang-guide-link', m[0].replace(/^https?:\/\//, ''));
    a.href = m[0];
    a.target = '_blank';
    a.rel = 'noopener';
    frag.appendChild(a);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

let sangGuideSaved = null; // the saved guide, null = never saved (SANG_GUIDE shown)
let sangGuideEditing = false;
let sangGuideDraft = null; // {title, intro, steps:[{title, text}]} while editing
let sangGuideSaving = false;
let sangGuideDragStep = null;

function sangGuideEffective() {
  return sangGuideSaved || SANG_GUIDE;
}

// The draft as it would be saved: trimmed, fully blank steps dropped.
function sangGuidePayload() {
  return {
    title: sangGuideDraft.title.trim(),
    intro: sangGuideDraft.intro.trim(),
    steps: sangGuideDraft.steps
      .map((st) => ({ title: st.title.trim(), text: st.text.trim() }))
      .filter((st) => st.title || st.text),
  };
}

function sangGuideHasUnsaved() {
  if (!sangGuideEditing || !sangGuideDraft) return false;
  const g = sangGuideEffective();
  return JSON.stringify(sangGuidePayload())
    !== JSON.stringify({ title: g.title, intro: g.intro, steps: g.steps.map((st) => ({ title: st.title, text: st.text })) });
}

function sangGuideIcon(size, strokeWidth, paths) {
  return sangSvg('0 0 16 16', size, strokeWidth, paths);
}

function sangRenderGuide() {
  const host = document.getElementById('sangere-guide');
  if (!host) return;
  host.replaceChildren(sangGuideEditing ? sangBuildGuideEdit() : sangBuildGuide());
}

function sangGuideHead(titleNode) {
  const head = el('div', 'card-head sang-guide-head');
  head.appendChild(titleNode);
  if (siteHasLevel('boss')) {
    const btn = el('button', 'boss-icon-btn');
    btn.type = 'button';
    const label = sangGuideEditing ? 'Gem og afslut redigering' : 'Rediger guiden';
    btn.title = label;
    btn.setAttribute('aria-label', label);
    btn.appendChild(sangGuideEditing
      ? sangGuideIcon(16, 1.6, ['M3 8.5l3.2 3.2L13 5'])
      : sangGuideIcon(15, 1.3, ['M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z', 'M9 4l3 3']));
    btn.disabled = sangGuideSaving;
    btn.addEventListener('click', () => {
      if (sangGuideEditing) { sangGuideSaveAndClose(); return; }
      const g = sangGuideEffective();
      sangGuideDraft = { title: g.title, intro: g.intro, steps: g.steps.map((st) => ({ title: st.title, text: st.text })) };
      sangGuideEditing = true;
      sangRenderGuide();
    });
    head.appendChild(btn);
  }
  return head;
}

function sangBuildGuide() {
  const guide = sangGuideEffective();
  const card = el('section', 'card sang-guide');
  card.appendChild(sangGuideHead(el('h2', null, guide.title)));
  if (guide.intro) {
    const intro = el('p', 'sang-guide-intro');
    intro.appendChild(sangLinkify(guide.intro));
    card.appendChild(intro);
  }
  for (const step of guide.steps) {
    if (step.title) card.appendChild(el('h3', 'sang-step-heading', step.title));
    const p = el('p', 'sang-guide-text' + (step.title ? '' : ' sang-guide-text-alone'));
    p.appendChild(sangLinkify(step.text));
    card.appendChild(p);
  }
  return card;
}

// Check mark: save and leave edit mode. Nothing changed → just leave.
async function sangGuideSaveAndClose() {
  if (sangGuideSaving) return;
  const error = document.querySelector('#sangere-guide .boss-manage-error');
  const payload = sangGuidePayload();
  if (!payload.title) {
    if (error) error.textContent = 'Udfyld titel.';
    return;
  }
  if (sangGuideHasUnsaved()) {
    sangGuideSaving = true;
    if (error) error.textContent = '';
    const btn = document.querySelector('#sangere-guide .boss-icon-btn');
    if (btn) btn.disabled = true;
    const result = await sangApi('sangere_set_guide', { guide: payload });
    sangGuideSaving = false;
    if (btn) btn.disabled = false;
    if (!result.ok) {
      if (error && result.message) error.textContent = result.message;
      return;
    }
    sangGuideSaved = result.data.guide;
    siteShowToast('Gemt');
  }
  sangGuideEditing = false;
  sangGuideDraft = null;
  sangRenderGuide();
}

// A textarea in the inline field style that grows with its text.
function sangGuideTextarea(value, placeholder, onInput) {
  const area = el('textarea', 'boss-manage-text-input sang-guide-textarea');
  area.rows = 1;
  area.value = value;
  area.placeholder = placeholder;
  const grow = () => { area.style.height = 'auto'; area.style.height = area.scrollHeight + 'px'; };
  area.addEventListener('input', () => { onInput(area.value); grow(); });
  requestAnimationFrame(grow);
  return area;
}

function sangGuideInput(value, placeholder, className, onInput) {
  const input = el('input', 'boss-manage-text-input ' + className);
  input.type = 'text';
  input.value = value;
  input.placeholder = placeholder;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

// Shared off-screen drag image (the site-wide recipe).
let sangGuideGhost = null;
function sangGuideGetDragImageEl() {
  if (!sangGuideGhost) {
    sangGuideGhost = el('div', 'sang-drag-ghost');
    document.body.appendChild(sangGuideGhost);
  }
  return sangGuideGhost;
}

// A drop target that inserts the dragged step before `beforeStep` (null = last).
function sangGuideWireDrop(node, beforeStep, rerender) {
  let depth = 0;
  node.addEventListener('dragenter', (e) => {
    if (!sangGuideDragStep) return;
    e.preventDefault();
    depth++;
    node.classList.add('sang-guide-drop-target');
  });
  node.addEventListener('dragover', (e) => { if (sangGuideDragStep) e.preventDefault(); });
  node.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) node.classList.remove('sang-guide-drop-target');
  });
  node.addEventListener('drop', (e) => {
    if (!sangGuideDragStep) return;
    e.preventDefault();
    depth = 0;
    node.classList.remove('sang-guide-drop-target');
    const steps = sangGuideDraft.steps;
    const moving = sangGuideDragStep;
    sangGuideDragStep = null;
    if (moving === beforeStep) return;
    steps.splice(steps.indexOf(moving), 1);
    const at = beforeStep ? steps.indexOf(beforeStep) : -1;
    if (at === -1) steps.push(moving);
    else steps.splice(at, 0, moving);
    rerender();
  });
}

function sangBuildGuideEdit() {
  const draft = sangGuideDraft;
  const card = el('section', 'card sang-guide sang-guide-editing');
  const titleWrap = el('h2', 'sang-guide-title-edit');
  titleWrap.appendChild(sangGuideInput(draft.title, 'Titel', 'boss-manage-title-input', (v) => { draft.title = v; }));
  card.appendChild(sangGuideHead(titleWrap));

  const intro = sangGuideTextarea(draft.intro, 'Intro (valgfri)', (v) => { draft.intro = v; });
  intro.classList.add('sang-guide-intro');
  card.appendChild(intro);

  const list = el('div', 'sang-guide-steps');
  card.appendChild(list);
  const renderSteps = () => {
    list.replaceChildren();
    for (const step of draft.steps) {
      const row = el('div', 'sang-guide-step-row');
      const handle = el('span', 'boss-manage-drag-handle sang-guide-handle', '⠿');
      handle.draggable = true;
      handle.title = 'Træk for at flytte trinnet';
      handle.addEventListener('dragstart', (e) => {
        sangGuideDragStep = step;
        const ghost = sangGuideGetDragImageEl();
        ghost.textContent = step.title.trim() || 'Trin';
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ghost.textContent);
        e.dataTransfer.setDragImage(ghost, 12, 16);
        row.classList.add('sang-dragging');
      });
      handle.addEventListener('dragend', () => {
        sangGuideDragStep = null;
        row.classList.remove('sang-dragging');
      });
      row.appendChild(handle);
      const fields = el('div', 'sang-guide-step-fields');
      fields.appendChild(sangGuideInput(step.title, 'Overskrift', 'sang-guide-step-title', (v) => { step.title = v; }));
      fields.appendChild(sangGuideTextarea(step.text, 'Tekst', (v) => { step.text = v; }));
      row.appendChild(fields);
      const remove = el('button', 'boss-manage-remove-btn', '✕');
      remove.type = 'button';
      remove.title = 'Fjern trinnet';
      remove.setAttribute('aria-label', 'Fjern trinnet');
      remove.addEventListener('click', () => {
        draft.steps.splice(draft.steps.indexOf(step), 1);
        renderSteps();
      });
      row.appendChild(remove);
      sangGuideWireDrop(row, step, renderSteps);
      list.appendChild(row);
    }
    const tail = el('div', 'sang-guide-drop-tail');
    sangGuideWireDrop(tail, null, renderSteps);
    list.appendChild(tail);
  };
  renderSteps();

  const bar = el('div', 'boss-editbar');
  const add = el('button', 'boss-manage-add-plus', '+');
  add.type = 'button';
  add.title = 'Tilføj trin';
  add.setAttribute('aria-label', 'Tilføj trin');
  add.addEventListener('click', () => {
    draft.steps.push({ title: '', text: '' });
    renderSteps();
    const inputs = list.querySelectorAll('.sang-guide-step-title');
    if (inputs.length) inputs[inputs.length - 1].focus();
  });
  bar.appendChild(add);
  bar.appendChild(el('div', 'boss-manage-error'));
  card.appendChild(bar);
  return card;
}

// ── Modals ───────────────────────────────────────────────────
function sangConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('sang-confirm-modal');
  if (description) form.appendChild(el('p', 'sang-confirm-text', description));
  const cancelBtn = sangPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = sangPillBtn(confirmLabel, 'site-btn-danger');
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
function sangOpenFormModal({ title, name, placeholder, folderLabel, folderId, confirmLabel, submit }) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose(title);
  modal.classList.add('sang-name-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 190;
  input.value = name;
  input.placeholder = placeholder || '';
  form.appendChild(siteEditField('Navn', input));
  let folderField = null;
  if (folderLabel) {
    folderField = siteCreateDropdownField(sangFolderOptions(), folderId || '');
    form.appendChild(siteEditField(folderLabel, folderField));
  }
  const saveBtn = sangPillBtn(confirmLabel, 'site-btn-success');
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
  actions.appendChild(saveBtn);
  input.focus();
  input.select();
}

function sangOpenNewFolderModal(parentId) {
  sangOpenFormModal({
    title: 'Ny mappe', name: '', placeholder: 'Fx Revysange, Stemme 1',
    folderLabel: 'Placering', folderId: parentId, confirmLabel: 'Opret',
    async submit({ name, folderId }) {
      const result = await sangApi('sangere_create_folder', { parentId: folderId, name });
      if (!result.ok) return result.message || null;
      sangState.folders.push(result.data.folder);
      if (folderId) sangOpenFolders.add(folderId); // show the new folder
      sangSaveOpenFolders();
      sangRender();
      return '';
    },
  });
}

function sangOpenRenameFolderModal(folder) {
  sangOpenFormModal({
    title: 'Omdøb mappe', name: folder.name, confirmLabel: 'Gem',
    async submit({ name }) {
      if (name === folder.name) return '';
      const result = await sangApi('sangere_rename_folder', { folderId: folder.id, name });
      if (!result.ok) return result.message || null;
      folder.name = result.data.folder.name;
      sangRender();
      return '';
    },
  });
}

// Rename and/or move (the Mappe dropdown is how touch screens move files).
function sangOpenEditFileModal(file) {
  const oldName = sangFileDisplayName(file);
  sangOpenFormModal({
    title: 'Rediger fil', name: oldName, folderLabel: 'Mappe', folderId: file.folderId,
    confirmLabel: 'Gem',
    async submit({ name, folderId }) {
      if (name !== oldName) {
        const result = await sangApi('sangere_rename_file', { fileId: file.id, name });
        if (!result.ok) return result.message || null;
        file.name = result.data.file.name;
      }
      if (folderId !== (file.folderId || null)) {
        const result = await sangApi('sangere_move_file', { fileId: file.id, folderId });
        if (!result.ok) { sangRender(); return result.message || null; }
        file.folderId = result.data.file.folderId;
      }
      sangRender();
      return '';
    },
  });
}

function sangConfirmDeleteFolder(folder) {
  const ids = sangSubtreeIds(folder.id);
  const fileCount = sangState.files.filter((f) => ids.has(f.folderId)).length;
  const folderCount = ids.size - 1;
  const contents = [];
  if (folderCount) contents.push(sangPlural(folderCount, 'undermappe', 'undermapper'));
  if (fileCount) contents.push(sangPlural(fileCount, 'fil', 'filer'));
  const description = (contents.length ? `Mappen og alt i den (${contents.join(' og ')}) slettes. ` : '')
    + 'Dette kan ikke fortrydes.';
  sangConfirm(`Slet "${folder.name}"?`, description, 'Slet', async () => {
    const result = await sangApi('sangere_delete_folder', { folderId: folder.id });
    if (!result.ok) { sangShowError(result.message); return false; }
    sangState.folders = sangState.folders.filter((f) => !ids.has(f.id));
    sangState.files = sangState.files.filter((f) => !ids.has(f.folderId));
    for (const id of ids) sangOpenFolders.delete(id);
    sangSaveOpenFolders();
    sangRender();
    return true;
  });
}

// ── Moving files (drag and drop) ─────────────────────────────
let sangDragFile = null;
let sangDragGhost = null;

// Shared off-screen drag image (the site-wide recipe).
function sangGetDragImageEl() {
  if (!sangDragGhost) {
    sangDragGhost = el('div', 'sang-drag-ghost');
    document.body.appendChild(sangDragGhost);
  }
  return sangDragGhost;
}

function sangWireFileDrag(row, file) {
  row.addEventListener('dragstart', (e) => {
    sangDragFile = file;
    const ghost = sangGetDragImageEl();
    ghost.textContent = sangFileDisplayName(file);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', file.name);
    e.dataTransfer.setDragImage(ghost, 12, 16);
    row.classList.add('sang-dragging');
  });
  row.addEventListener('dragend', () => {
    sangDragFile = null;
    row.classList.remove('sang-dragging');
    sangClearDropHighlight();
  });
}

function sangClearDropHighlight() {
  document.querySelectorAll('.sang-drop-target').forEach((n) => n.classList.remove('sang-drop-target'));
}

// Where a drop at this element lands: a folder row → that folder, a file
// row → the folder it's in, anywhere else on the card → the top level.
function sangDropTarget(node) {
  const row = node && node.closest ? node.closest('[data-target]') : null;
  return row ? (row.dataset.target || null) : null;
}

function sangHighlightDrop(card, folderId) {
  const target = folderId ? card.querySelector(`.sang-folder-row[data-folder-id="${folderId}"]`) : card;
  if (target && target.classList.contains('sang-drop-target')) return;
  sangClearDropHighlight();
  if (target) target.classList.add('sang-drop-target');
}

// One handler on the card covers both a file row being moved and files
// dragged in from the desktop (which open the upload modal).
function sangWireDrop(card) {
  const isDesktopFiles = (e) => !sangDragFile && e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes('Files');
  card.addEventListener('dragover', (e) => {
    if (!sangDragFile && !isDesktopFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = sangDragFile ? 'move' : 'copy';
    sangHighlightDrop(card, sangDropTarget(e.target));
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) sangClearDropHighlight();
  });
  card.addEventListener('drop', (e) => {
    const folderId = sangDropTarget(e.target);
    sangClearDropHighlight();
    if (sangDragFile) {
      e.preventDefault();
      const file = sangDragFile;
      sangDragFile = null;
      sangMoveFile(file, folderId);
      return;
    }
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    if (!sangUploadsOpen) { sangShowError(SANG_CLOSED_TEXT); return; }
    sangOpenUploadModal(Array.from(e.dataTransfer.files), folderId);
  });
}

async function sangMoveFile(file, folderId) {
  if ((file.folderId || null) === folderId) return;
  const result = await sangApi('sangere_move_file', { fileId: file.id, folderId });
  if (!result.ok) { sangShowError(result.message); return; }
  file.folderId = result.data.file.folderId;
  if (folderId) sangOpenFolders.add(folderId);
  sangSaveOpenFolders();
  sangRender();
  siteShowToast(`Flyttet til ${folderId ? sangFolderPath(folderId) : 'øverste niveau'}.`);
}

// ── Download / open ──────────────────────────────────────────
async function sangSignedUrl(action, body) {
  const result = await sangApi(action, body);
  if (!result.ok) { sangShowError(result.message); return null; }
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  return SITE_API_ENDPOINT + sep + result.data.query;
}

// A hidden iframe starts the download without navigating this page (a
// navigation would fire beforeunload and warn during uploads). iOS shows
// downloads as a preview anyway, so it just goes there.
let sangDownloadFrame = null;
function sangStartDownload(url) {
  if (siteIsIos()) { window.location.href = url; return; }
  if (!sangDownloadFrame) {
    sangDownloadFrame = document.createElement('iframe');
    sangDownloadFrame.hidden = true;
    sangDownloadFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(sangDownloadFrame);
  }
  sangDownloadFrame.src = url;
}

async function sangDownloadFile(file) {
  const url = await sangSignedUrl('sangere_download_url', { fileId: file.id, inline: false });
  if (url) sangStartDownload(url);
}

// A folder (null = everything) as one .zip, built while it downloads.
async function sangDownloadFolder(folderId) {
  const files = folderId ? sangSubtreeFiles(folderId) : sangState.files;
  if (!files.length) { siteShowToast('Mappen er tom.'); return; }
  const url = await sangSignedUrl('sangere_folder_download_url', { folderId });
  if (!url) return;
  sangStartDownload(url);
  const total = files.reduce((sum, f) => sum + (f.size || 0), 0);
  siteShowToast(`Downloader ${sangPlural(files.length, 'fil', 'filer')} (${sangFormatBytes(total)}) som .zip …`);
}

// The window is opened synchronously (inside the click) so popup blockers
// allow it, then pointed at the file once its URL has arrived — same
// recipe as band.js's bandOpenFile.
async function sangOpenFile(file) {
  const sameTab = siteIsIos();
  const win = sameTab ? null : window.open('', '_blank');
  const url = await sangSignedUrl('sangere_download_url', { fileId: file.id, inline: true });
  if (!url) { if (win) win.close(); return; }
  if (sameTab || !win) { window.location.href = url; return; }
  win.location.replace(url);
}

// ── Upload modal ─────────────────────────────────────────────
function sangPickFiles(folderId) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'audio/*,' + SANG_AUDIO_EXTS.map((ext) => '.' + ext).join(',');
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    if (picked.length) sangOpenUploadModal(picked, folderId);
  });
  input.click();
}

function sangFileExt(name) {
  return (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
}

function sangIsAudio(file) {
  return SANG_AUDIO_EXTS.includes(sangFileExt(file.name));
}

function sangCleanBaseName(value) {
  return value.trim().replace(/[\\/]/g, '-');
}

function sangNotEnoughSpace(total, free) {
  return `Der er ikke plads: filerne fylder ${sangFormatBytes(total)}, men der er kun ${sangFormatBytes(free)} ledigt `
    + `(højst ${sangFormatBytes(sangQuotaBytes)} i alt). Slet nogle filer først.`;
}

// Bandet's recipe (bandOpenUploadModal): each file needs a name typed
// here (required, sent as "<navn>.<ext>"), plus which folder they go into
// (defaulting to the one they were dropped on); refuses a batch that
// won't fit. Anything that isn't a sound file is skipped.
function sangOpenUploadModal(files, folderId) {
  const valid = files.filter((file) => {
    if (!sangIsAudio(file)) {
      siteShowToast(`"${file.name}" blev sprunget over (kun lydfiler: ${SANG_AUDIO_EXTS.join(', ')}).`);
      return false;
    }
    if (file.size) return true;
    siteShowToast(`"${file.name}" blev sprunget over (tom fil).`);
    return false;
  });
  if (!valid.length) return;
  const total = valid.reduce((sum, f) => sum + f.size, 0);

  const { modal, form, error, actions, close } = siteOpenModalWithClose(
    valid.length === 1 ? 'Upload lydfil' : `Upload ${valid.length} lydfiler`
  );
  modal.classList.add('sang-upload-modal');
  form.appendChild(el('p', 'sang-upload-hint', 'Skriv det navn, filen skal stå med på siden.'));

  const list = el('ul', 'sang-upload-list');
  const entries = valid.map((file) => {
    const ext = sangFileExt(file.name);
    const item = el('li', 'edit-field sang-upload-item'); // .edit-field = site input styling
    const head = el('div', 'sang-upload-item-head');
    const kind = sangFileKind(ext);
    head.appendChild(el('span', 'sang-kind sang-kind-' + kind.key, kind.label));
    head.appendChild(el('span', 'sang-upload-item-name', file.name));
    head.appendChild(el('span', 'sang-upload-item-size', sangFormatBytes(file.size)));
    item.appendChild(head);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 180;
    input.placeholder = 'Navn, fx Revysang (stemme 1)';
    input.setAttribute('aria-label', `Navn til ${file.name}`);
    item.appendChild(input);
    list.appendChild(item);
    return { file, ext, input };
  });
  form.appendChild(list);
  const folderField = siteCreateDropdownField(sangFolderOptions(), folderId || '');
  form.appendChild(siteEditField('Upload til', folderField));
  const free = sangFreeBytes();
  form.appendChild(el('p', 'sang-upload-space',
    `I alt ${sangFormatBytes(total)} · ${sangFormatBytes(free)} ledigt`));

  const uploadBtn = sangPillBtn('Upload', 'site-btn-success');
  if (total > free) {
    error.textContent = sangNotEnoughSpace(total, free);
    uploadBtn.disabled = true;
  }
  function submit() {
    if (uploadBtn.disabled) return;
    const missing = entries.find((entry) => !entry.input.value.trim());
    if (missing) {
      error.textContent = 'Giv hver fil et navn.';
      missing.input.focus();
      return;
    }
    const target = folderField.value || null;
    close();
    if (target) { sangOpenFolders.add(target); sangSaveOpenFolders(); sangRender(); }
    sangEnqueue(entries.map(({ file, ext, input }) => ({
      file, name: `${sangCleanBaseName(input.value)}.${ext}`,
    })), target);
  }
  uploadBtn.addEventListener('click', submit);
  entries.forEach(({ input }, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i + 1 < entries.length) entries[i + 1].input.focus();
      else submit();
    });
  });
  actions.appendChild(uploadBtn);
  entries[0].input.focus();
}

// ── Upload queue ─────────────────────────────────────────────
// [{key, file, name, folderId, sent, state: 'waiting'|'uploading'|'failed', message, cancelled, uploadId}]
const sangQueue = [];
let sangQueueRunning = false;
let sangUploadKey = 0;
let sangPanelEl = null;

function sangUploadsPending() {
  return sangQueue.some((item) => item.state !== 'failed');
}

function sangUploadPanel() {
  if (!sangPanelEl) sangPanelEl = el('section', 'card sang-uploads');
  return sangPanelEl;
}

// `items` = [{file, name}], name being the one given in the upload modal.
function sangEnqueue(items, folderId) {
  for (const { file, name } of items) {
    sangQueue.push({ key: ++sangUploadKey, file, name, folderId, sent: 0, state: 'waiting', message: '', cancelled: false, uploadId: null });
  }
  sangRenderUploads();
  sangRunQueue();
}

function sangRenderUploads() {
  const panel = sangUploadPanel();
  panel.hidden = !sangQueue.length;
  if (!sangQueue.length) { panel.replaceChildren(); return; }
  const head = el('div', 'card-head sang-uploads-head');
  head.appendChild(el('h2', null, 'Uploads'));
  if (sangQueue.some((item) => item.state === 'failed')) {
    const clearBtn = sangBtn('Ryd fejlede');
    clearBtn.addEventListener('click', () => {
      for (let i = sangQueue.length - 1; i >= 0; i--) {
        if (sangQueue[i].state === 'failed') sangQueue.splice(i, 1);
      }
      sangRenderUploads();
    });
    head.appendChild(clearBtn);
  }
  panel.replaceChildren(head);
  for (const item of sangQueue) panel.appendChild(sangBuildUploadRow(item));
}

function sangBuildUploadRow(item) {
  const row = el('div', 'sang-upload');
  const top = el('div', 'sang-upload-top');
  top.appendChild(el('span', 'sang-upload-name', item.name));
  top.appendChild(el('span', 'sang-upload-where', '→ ' + (item.folderId ? sangFolderPath(item.folderId) || 'slettet mappe' : 'Øverst')));
  const status = el('span', 'sang-upload-status');
  item.statusEl = status;
  top.appendChild(status);
  const cancelBtn = sangRemoveBtn(item.state === 'failed' ? 'Fjern' : 'Annuller upload');
  cancelBtn.addEventListener('click', () => sangCancelUpload(item));
  top.appendChild(cancelBtn);
  row.appendChild(top);
  const bar = el('div', 'sang-progress');
  const fill = el('div', 'sang-progress-fill');
  item.fillEl = fill;
  bar.appendChild(fill);
  row.appendChild(bar);
  if (item.state === 'failed') row.classList.add('sang-upload-failed');
  sangPaintUpload(item);
  return row;
}

function sangPaintUpload(item) {
  if (!item.statusEl) return;
  const pct = item.file.size ? Math.floor((item.sent / item.file.size) * 100) : 0;
  item.fillEl.style.width = pct + '%';
  if (item.state === 'failed') item.statusEl.textContent = item.message || 'Fejlede';
  else if (item.state === 'waiting') item.statusEl.textContent = 'Venter';
  else if (item.cancelled) item.statusEl.textContent = 'Annullerer…';
  else item.statusEl.textContent = `${pct} % af ${sangFormatBytes(item.file.size)}`;
}

function sangRemoveFromQueue(item) {
  const idx = sangQueue.indexOf(item);
  if (idx >= 0) sangQueue.splice(idx, 1);
  sangRenderUploads();
}

function sangCancelUpload(item) {
  if (item.state === 'uploading') {
    item.cancelled = true; // the running loop aborts after its current chunk
    sangPaintUpload(item);
    return;
  }
  sangRemoveFromQueue(item);
}

async function sangRunQueue() {
  if (sangQueueRunning) return;
  sangQueueRunning = true;
  for (;;) {
    const item = sangQueue.find((i) => i.state === 'waiting');
    if (!item) break;
    item.state = 'uploading';
    sangPaintUpload(item);
    const outcome = await sangUploadOne(item);
    if (outcome.ok) {
      sangQueue.splice(sangQueue.indexOf(item), 1);
      sangState.files.push(outcome.file);
      sangRender();
      siteShowToast(`"${item.name}" er uploadet.`);
    } else if (outcome.cancelled) {
      sangRemoveFromQueue(item);
    } else {
      item.state = 'failed';
      item.message = outcome.message || 'Fejlede';
      sangRenderUploads();
    }
  }
  sangQueueRunning = false;
}

function sangReadChunkBase64(blob) {
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

function sangDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns {ok, file} | {cancelled} | {message}.
async function sangUploadOne(item) {
  const { file } = item;
  const start = await sangApi('sangere_upload_start', {
    folderId: item.folderId, name: item.name, size: file.size,
  });
  if (!start.ok) return { message: start.message || 'Annulleret' };
  item.uploadId = start.data.uploadId;
  const chunkBytes = Math.min(SANG_CHUNK_BYTES, start.data.chunkBytes || SANG_CHUNK_BYTES);
  let offset = 0;
  while (offset < file.size) {
    if (item.cancelled) {
      await sangApi('sangere_upload_abort', { uploadId: item.uploadId });
      return { cancelled: true };
    }
    let contentBase64;
    try {
      contentBase64 = await sangReadChunkBase64(file.slice(offset, offset + chunkBytes));
    } catch (e) {
      await sangApi('sangere_upload_abort', { uploadId: item.uploadId });
      return { message: 'Kunne ikke læse filen.' };
    }
    let result = null;
    for (let attempt = 1; attempt <= SANG_CHUNK_ATTEMPTS; attempt++) {
      result = await sangApi('sangere_upload_chunk', { uploadId: item.uploadId, offset, contentBase64 });
      // Network errors and 5xx are worth retrying; 4xx won't change.
      if (result.ok || (result.status >= 400 && result.status < 500)) break;
      if (attempt < SANG_CHUNK_ATTEMPTS) await sangDelay(1000 * 2 ** attempt);
    }
    if (!result.ok) {
      // The server holds a different amount than we think: carry on from there.
      if (result.status === 409 && result.data && Number.isInteger(result.data.received)) {
        offset = result.data.received;
        continue;
      }
      await sangApi('sangere_upload_abort', { uploadId: item.uploadId });
      return { message: result.message };
    }
    offset = Math.max(offset, result.data.received);
    item.sent = offset;
    sangPaintUpload(item);
  }
  const finish = await sangApi('sangere_upload_finish', { uploadId: item.uploadId });
  if (!finish.ok) {
    if (finish.status === 404) return { message: 'Mappen blev slettet under uploaden.' };
    return { message: finish.message };
  }
  return { ok: true, file: finish.data.file };
}

// ── Init ─────────────────────────────────────────────────────
function sangHasPending() {
  return sangUploadsPending() || sangGuideHasUnsaved();
}

window.addEventListener('beforeunload', (e) => {
  if (!sangHasPending()) return;
  e.preventDefault();
  e.returnValue = '';
});

document.addEventListener('DOMContentLoaded', () => {
  const root = sangRoot();
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'sang-muted', 'Sangere kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  if (typeof siteRegisterUnsavedCheck === 'function') siteRegisterUnsavedCheck(sangHasPending);
  sangLoad();
});
