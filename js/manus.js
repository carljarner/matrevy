/* =========================================================
   Matematikrevyen – Manus page (manus.html)

   Two parts:

   1. Upload pool (data/manuscripts.json, embedded as MANUSCRIPTS_DATA):
      any revyst+ can submit a sketch/song (title/sender/.pdf/.tex),
      shown as two alphabetical columns. Boss/admin can remove a
      submission via a small ✕. Modeled directly on posts.js's
      create-post flow — manusApi()/manusResolvePassword() mirror
      postsApi()/postsResolvePassword() since posts_create-style
      append-only actions need an ANY-level authenticated call, not
      just boss/admin (siteSaveResource only trusts boss/admin logins).

   2. Selection (boss/admin only): "Hent stemmeark" prints a blank
      Navn/Point/Kommentar voting sheet per column; "Aktfordeling"
      opens a builder that seeds its 4 acts from the CURRENT
      data/scenes.json (via getEffectiveScenesData(), the same
      manus-data.js shadow import.js uses) so existing scenes/cast
      are carried over untouched, then lets Boss drag in not-yet-used
      pool submissions and set a per-scene Tidsestimat (duration).
      "Gem" reuses the existing boss-level `manus` resource
      (siteSaveResource('manus', {scenes, cast})) — no new server
      resource needed, save_manus() only validates act-level shape.
      "Intast point" is a stub for now (see matrevy-plan.md).

   DOM is built via createElement/textContent only — never innerHTML.
   ========================================================= */

'use strict';

const MANUS_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MANUS_TYPES = ['sang', 'sketch'];
const MANUS_TYPE_COLUMN_LABEL = { sketch: 'Sketches', sang: 'Sange' };
const MANUS_SCENE_TYPE_LABELS = { sketch: 'Sketch', sang: 'Sang', dans: 'Dans', bandsang: 'Bandsang', video: 'Video' };

// ── Data (with a localStorage-backed shadow after a create/delete) ──
let manuscriptsOverride = siteLoadOverride('manuscripts');

function getEffectiveManuscripts() {
  return manuscriptsOverride || MANUSCRIPTS_DATA;
}

// ── Any-level authenticated API (revyst-level manuscripts_create) ──
// Mirrors posts.js's postsApi()/postsResolvePassword() exactly — see the
// file header for why this can't just use site-utils.js's siteSaveResource
// (which only trusts a boss/admin login).
function manusResolvePassword() {
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

function manusMapError(status) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 413) return 'Filerne er for store. Maks. 5 MB pr. fil.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

async function manusApi(action, body) {
  const password = manusResolvePassword();
  if (!password) return { ok: false, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...body }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) return { ok: false, message: manusMapError(res.status) };
  if (!data || data.ok !== true) return { ok: false, message: 'Uventet svar fra serveren. Prøv igen senere.' };
  return { ok: true, data };
}

// Raw base64 (no "data:...;base64," prefix) — pdf/tex are stored as-is,
// no client-side re-encoding needed (unlike posts.js's image compression).
function manusFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const i = s.indexOf(',');
      resolve(i === -1 ? s : s.slice(i + 1));
    };
    reader.onerror = () => reject(new Error('read_failed'));
    reader.readAsDataURL(file);
  });
}

// ── Poll a just-uploaded file until GitHub Pages has actually deployed it
// (a push to main takes ~1-2 min to go live, per CLAUDE.md's Deployment
// section) so the pool never shows a link that 404s in the meantime. The
// pending flag lives only in the local override (never sent to/read from
// the server), so it just falls away once the override's TTL expires.
let manusPendingPollTimer = null;

// Rotates every MANUS_PENDING_MESSAGE_INTERVAL_MS based on elapsed time
// since the upload, not a per-row timer — renderPdfRow just recomputes the
// index each time it's called, and the poll interval below re-renders
// often enough to keep it moving.
const MANUS_PENDING_MESSAGES = [
  'Uploading...',
  'Forbinder til Github...',
  'Gratis services tager tid...',
  'Et øjeblik mere...',
  'Næsten færdig...',
];
const MANUS_PENDING_MESSAGE_INTERVAL_MS = 10000;

function manusPendingMessage(item) {
  const startedAt = item.createdAt ? new Date(item.createdAt).getTime() : Date.now();
  const step = Math.floor((Date.now() - startedAt) / MANUS_PENDING_MESSAGE_INTERVAL_MS);
  const idx = Math.max(0, Math.min(step, MANUS_PENDING_MESSAGES.length - 1));
  return MANUS_PENDING_MESSAGES[idx];
}

function manusHasPendingDeploys() {
  return getEffectiveManuscripts().some(s => s.pendingDeploy);
}

async function manusCheckPendingDeploys() {
  const items = getEffectiveManuscripts();
  const anyPending = items.some(s => s.pendingDeploy);
  let changed = false;
  for (const item of items) {
    if (!item.pendingDeploy) continue;
    try {
      const res = await fetch(item.pdfPath, { method: 'HEAD', cache: 'no-store' });
      if (res.ok) { item.pendingDeploy = false; changed = true; }
    } catch (e) { /* not live yet, or offline — keep polling */ }
  }
  if (changed) {
    manuscriptsOverride = items;
    siteSaveOverride('manuscripts', manuscriptsOverride);
  }
  // Re-render even when nothing became ready yet, so the rotating wait
  // message stays in sync with elapsed time.
  if (anyPending) renderColumns();
  if (!manusHasPendingDeploys() && manusPendingPollTimer) {
    clearInterval(manusPendingPollTimer);
    manusPendingPollTimer = null;
  }
}

function manusStartPendingPoll() {
  if (manusPendingPollTimer || !manusHasPendingDeploys()) return;
  manusPendingPollTimer = setInterval(manusCheckPendingDeploys, 2000);
}

// ── Upload pool: two-column render ────────────────────────────
function renderPdfRow(item) {
  const row = document.createElement('div');
  row.className = 'manus-pdf-row';

  if (item.pendingDeploy) {
    const pending = document.createElement('span');
    pending.className = 'manus-pdf-title manus-pdf-pending';
    pending.textContent = item.title;
    row.appendChild(pending);

    const status = document.createElement('span');
    status.className = 'manus-pdf-pending-label';
    status.textContent = manusPendingMessage(item);
    row.appendChild(status);
  } else {
    const link = document.createElement('a');
    link.className = 'manus-pdf-title';
    link.href = item.pdfPath;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = item.title;
    row.appendChild(link);
  }

  const sender = document.createElement('span');
  sender.className = 'manus-pdf-sender';
  sender.textContent = item.sender;
  row.appendChild(sender);

  if (siteHasLevel('boss')) {
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'manus-pdf-remove';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', `Fjern ${item.title}`);
    remove.title = 'Fjern upload';
    remove.addEventListener('click', () => confirmDeleteManuscript(item));
    row.appendChild(remove);
  }

  return row;
}

// A column becomes a closed-by-default toggle once this year's manus
// (scenes.json) has content — before that, it's a plain always-open list.
function manusHasProduction() {
  return getEffectiveScenesData().length > 0;
}

function renderColumn(type) {
  const section = document.createElement('section');
  section.className = 'card manus-column';

  const items = getEffectiveManuscripts()
    .filter(s => s.type === type)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));

  const collapsible = manusHasProduction();
  let expanded = !collapsible;

  const list = document.createElement('div');
  list.className = 'manus-col-list';

  let header;
  if (collapsible) {
    header = document.createElement('button');
    header.type = 'button';
    header.className = 'manus-col-header';
    header.setAttribute('aria-expanded', String(expanded));
    const chevron = document.createElement('span');
    chevron.className = 'manus-chevron';
    chevron.textContent = '▾';
    header.appendChild(chevron);
    header.addEventListener('click', () => {
      expanded = !expanded;
      header.setAttribute('aria-expanded', String(expanded));
      list.style.display = expanded ? '' : 'none';
    });
  } else {
    header = document.createElement('div');
    header.className = 'manus-col-header';
  }
  const h2 = document.createElement('h2');
  h2.textContent = MANUS_TYPE_COLUMN_LABEL[type];
  header.appendChild(h2);
  const count = document.createElement('span');
  count.className = 'manus-col-count';
  count.textContent = `(${items.length})`;
  header.appendChild(count);
  section.appendChild(header);

  if (items.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen upload endnu.';
    list.appendChild(empty);
  } else {
    for (const item of items) list.appendChild(renderPdfRow(item));
  }
  list.style.display = expanded ? '' : 'none';
  section.appendChild(list);

  if (siteHasLevel('boss')) {
    const actions = document.createElement('div');
    actions.className = 'manus-col-actions';

    const voteBtn = document.createElement('button');
    voteBtn.type = 'button';
    voteBtn.className = 'site-pill-btn site-pill-warm';
    voteBtn.textContent = 'Stemmeark';
    voteBtn.addEventListener('click', () => manusOpenVotingSheet(type));
    actions.appendChild(voteBtn);

    const pointBtn = document.createElement('button');
    pointBtn.type = 'button';
    pointBtn.className = 'site-pill-btn site-pill-warm';
    pointBtn.textContent = 'Point';
    pointBtn.addEventListener('click', () => siteShowToast('Intast point kommer i en senere session.'));
    actions.appendChild(pointBtn);

    section.appendChild(actions);
  }

  return section;
}

function renderColumns() {
  const mount = document.getElementById('manus-columns');
  mount.textContent = '';
  for (const type of MANUS_TYPES) mount.appendChild(renderColumn(type));
}

// ── Bottom CTA: Upload manus (revyst) / Aktfordeling (boss+) ────
function renderBottomActions() {
  const mount = document.getElementById('manus-bottom-actions');
  mount.textContent = '';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-btn-primary';
  if (siteHasLevel('boss')) {
    btn.textContent = 'Aktfordeling';
    btn.addEventListener('click', openAktfordelingBuilder);
  } else if (siteHasLevel('revyst')) {
    btn.textContent = 'Upload manus';
    btn.addEventListener('click', openUploadModal);
  } else {
    return;
  }
  mount.appendChild(btn);
}

// ── "Dette års manus" read view (from getEffectiveScenesData()) ──
function manusGroupByAct(scenes) {
  const order = [];
  const map = new Map();
  for (const s of scenes) {
    const label = s.actLabel || '';
    if (!map.has(label)) { map.set(label, []); order.push(label); }
    map.get(label).push(s);
  }
  return order.map(label => ({ label, scenes: map.get(label) }));
}

function renderYearView() {
  const scenes = getEffectiveScenesData();
  const section = document.getElementById('manus-year-section');
  const mount = document.getElementById('manus-year-acts');
  mount.textContent = '';
  if (!scenes.length) { section.style.display = 'none'; return; }
  section.style.display = '';

  for (const group of manusGroupByAct(scenes)) {
    const wrap = document.createElement('div');
    wrap.className = 'manus-year-act';

    const h3 = document.createElement('h3');
    h3.textContent = group.label || 'Uden akt';
    wrap.appendChild(h3);

    const ol = document.createElement('ol');
    ol.className = 'manus-year-list';
    for (const s of group.scenes.slice().sort((a, b) => (a.number || 0) - (b.number || 0))) {
      const li = document.createElement('li');
      li.appendChild(document.createTextNode(s.name));
      if (s.types && s.types.length) {
        const badge = document.createElement('span');
        badge.className = 'manus-year-type-badge';
        badge.textContent = MANUS_SCENE_TYPE_LABELS[s.types[0]] || s.types[0];
        li.appendChild(badge);
      }
      if (s.duration != null && s.duration !== '') {
        const dur = document.createElement('span');
        dur.className = 'manus-year-duration';
        dur.textContent = `${s.duration} min`;
        li.appendChild(dur);
      }
      ol.appendChild(li);
    }
    wrap.appendChild(ol);
    mount.appendChild(wrap);
  }
}

// Two mutually-exclusive clickable boxes (Sketch/Sang) replacing a plain
// dropdown, since there are only two options and neither is a sensible
// default — the uploader must actively choose one.
function createManusTypeToggle() {
  const wrap = document.createElement('div');
  wrap.className = 'manus-type-toggle';
  let selected = null;
  const boxes = {};
  for (const opt of [{ value: 'sketch', label: 'Sketch' }, { value: 'sang', label: 'Sang' }]) {
    const box = document.createElement('button');
    box.type = 'button';
    box.className = 'btn-small manus-type-box';
    box.textContent = opt.label;
    box.addEventListener('click', () => {
      selected = opt.value;
      for (const v in boxes) boxes[v].classList.toggle('active', v === selected);
    });
    boxes[opt.value] = box;
    wrap.appendChild(box);
  }
  return { element: wrap, get value() { return selected; } };
}

// ── Upload (revyst+) ──────────────────────────────────────────
function openUploadModal() {
  const { form, error, actions, close } = siteOpenModalWithClose('Upload manus');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  form.appendChild(siteEditField('Titel', titleInput));

  const senderInput = document.createElement('input');
  senderInput.type = 'text';
  form.appendChild(siteEditField('Afsender', senderInput));

  const pdfInput = document.createElement('input');
  pdfInput.type = 'file';
  pdfInput.accept = '.pdf,application/pdf';
  pdfInput.className = 'site-file-input';
  form.appendChild(siteEditField('Manus (.pdf)', pdfInput));

  const texInput = document.createElement('input');
  texInput.type = 'file';
  texInput.accept = '.tex';
  texInput.className = 'site-file-input';
  form.appendChild(siteEditField('Kildefil (.tex)', texInput));

  const typeToggle = createManusTypeToggle();
  form.appendChild(siteEditField('Type', typeToggle.element));

  const save = document.createElement('button');
  save.className = 'site-pill-btn site-pill-primary';
  save.textContent = 'Upload';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const type = typeToggle.value;
    const title = titleInput.value.trim();
    const sender = senderInput.value.trim();
    const pdfFile = pdfInput.files[0] || null;
    const texFile = texInput.files[0] || null;
    if (!type) {
      error.textContent = 'Vælg om det er en sketch eller en sang.';
      return;
    }
    if (!title || !sender || !pdfFile || !texFile) {
      error.textContent = 'Udfyld titel, afsender, og vælg både en .pdf- og en .tex-fil.';
      return;
    }
    if (pdfFile.size > MANUS_MAX_UPLOAD_BYTES || texFile.size > MANUS_MAX_UPLOAD_BYTES) {
      error.textContent = 'Filerne skal hver især være under 5 MB.';
      return;
    }

    save.disabled = true;
    save.textContent = 'Uploader…';
    error.textContent = '';

    let pdfBase64, texBase64;
    try {
      [pdfBase64, texBase64] = await Promise.all([manusFileToBase64(pdfFile), manusFileToBase64(texFile)]);
    } catch (e) {
      save.disabled = false;
      save.textContent = 'Upload';
      error.textContent = 'Kunne ikke læse filerne. Prøv igen.';
      return;
    }

    const result = await manusApi('manuscripts_create', { type, title, sender, pdfBase64, texBase64 });
    save.disabled = false;
    save.textContent = 'Upload';
    if (result.ok) {
      const local = {
        id: result.data.id,
        type,
        title,
        sender,
        pdfPath: result.data.pdfPath,
        texPath: result.data.texPath,
        createdAt: nowIso(),
        pendingDeploy: true,
      };
      manuscriptsOverride = getEffectiveManuscripts().concat([local]);
      siteSaveOverride('manuscripts', manuscriptsOverride);
      renderColumns();
      manusStartPendingPoll();
      close();
    } else {
      error.textContent = result.message;
    }
  });

  titleInput.focus();
}

// ── Remove a submission (boss/admin) ──────────────────────────
function confirmDeleteManuscript(item) {
  const { form, error, actions, close } = siteOpenEditModal('Fjern upload');

  const info = document.createElement('p');
  info.textContent = `Fjern "${item.title}"? Selve .pdf/.tex-filerne bliver liggende i repoet.`;
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-pill-btn site-pill-danger';
  confirmBtn.textContent = 'Fjern';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectiveManuscripts().filter(s => s.id !== item.id);
    const result = await siteSaveResource('manuscripts', { submissions: next });
    if (result.ok) {
      manuscriptsOverride = next;
      siteSaveOverride('manuscripts', next);
      renderColumns();
      close();
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── "Hent stemmeark": printable Navn/Point/Kommentar sheet ─────
function manusOpenVotingSheet(type) {
  const items = getEffectiveManuscripts()
    .filter(s => s.type === type)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));

  const sheet = document.getElementById('manus-print-sheet');
  sheet.textContent = '';

  const title = document.createElement('h2');
  title.className = 'manus-print-title';
  title.textContent = `Stemmeark – ${MANUS_TYPE_COLUMN_LABEL[type]}`;
  sheet.appendChild(title);

  const table = document.createElement('table');
  table.className = 'manus-print-table';

  const colgroup = document.createElement('colgroup');
  colgroup.appendChild(document.createElement('col'));
  const colPoint = document.createElement('col');
  colPoint.className = 'manus-print-col-point';
  colgroup.appendChild(colPoint);
  const colComment = document.createElement('col');
  colComment.className = 'manus-print-col-comment';
  colgroup.appendChild(colComment);
  table.appendChild(colgroup);

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  for (const label of ['Navn', 'Point', 'Kommentar']) {
    const th = document.createElement('th');
    th.textContent = label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const item of items) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = item.title;
    tr.appendChild(tdName);
    tr.appendChild(document.createElement('td'));
    tr.appendChild(document.createElement('td'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sheet.appendChild(table);

  window.print();
}

// ── Aktfordeling builder (boss/admin) ─────────────────────────
// A flat row list with a `lane` field ('pool' or an act code) — the same
// shape as import.js's flat scene list with an actCode, just reimplemented
// independently here since the input shape (pool submissions vs.
// already-cast-assigned scenes) differs too much to share import.js's code
// directly (see matrevy-plan.md's Phase 4 notes).
let manusAktState = null;
let manusAktDragKey = null;
let manusAktKeyCounter = 0;

function manusNextAktKey() {
  manusAktKeyCounter += 1;
  return `k${manusAktKeyCounter}`;
}

// Fixed Akt 1/2/3/Ekstranumre skeleton (matches the current production's
// act codes), plus any other code actually found in the data — so a scene
// with an unexpected act code is never silently dropped from the builder.
function manusBuildActSkeleton(existingScenes) {
  const fixed = [
    { code: '1', label: 'Akt 1' },
    { code: '2', label: 'Akt 2' },
    { code: '3', label: 'Akt 3' },
    { code: 'E', label: 'Ekstranumre' },
  ];
  const codes = new Set(fixed.map(a => a.code));
  const extra = [];
  for (const s of existingScenes) {
    const code = String(s.id).split('-')[0];
    if (!codes.has(code) && !extra.some(a => a.code === code)) {
      extra.push({ code, label: s.actLabel || code });
      codes.add(code);
    }
  }
  return fixed.concat(extra);
}

// Seeds the builder from the CURRENT production (existing scenes keep all
// their fields — cast, priority, etc. — untouched) plus every pool
// submission not already referenced by an existing scene's sourcePdf.
function manusInitAktState() {
  const existing = getEffectiveScenesData();
  const acts = manusBuildActSkeleton(existing);
  const placedPaths = new Set();
  const rows = [];
  for (const s of existing) {
    if (s.sourcePdf) placedPaths.add(s.sourcePdf);
    rows.push({
      key: manusNextAktKey(),
      origin: 'existing',
      lane: String(s.id).split('-')[0],
      scene: s,
      duration: s.duration != null ? s.duration : null,
    });
  }
  const pool = getEffectiveManuscripts()
    .filter(s => !placedPaths.has(s.pdfPath))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));
  for (const sub of pool) {
    rows.push({ key: manusNextAktKey(), origin: 'pool', lane: 'pool', submission: sub, duration: null });
  }
  return { acts, rows };
}

function manusAktRowsForLane(lane) {
  return manusAktState.rows.filter(r => r.lane === lane);
}

function manusRowTitle(row) {
  return row.origin === 'existing' ? row.scene.name : row.submission.title;
}

function manusRowType(row) {
  return row.origin === 'existing' ? ((row.scene.types || [])[0] || '') : row.submission.type;
}

function manusMoveAktRow(key, targetLane, beforeKey) {
  const rows = manusAktState.rows;
  const idx = rows.findIndex(r => r.key === key);
  if (idx === -1) return;
  const [row] = rows.splice(idx, 1);
  row.lane = targetLane;
  if (beforeKey) {
    const beforeIdx = rows.findIndex(r => r.key === beforeKey);
    rows.splice(beforeIdx === -1 ? rows.length : beforeIdx, 0, row);
  } else {
    rows.push(row);
  }
  manusAktDragKey = null;
  renderAktBuilderBody();
}

function wireLaneDropZone(listEl, laneCode) {
  listEl.addEventListener('dragover', (e) => {
    e.preventDefault();
    listEl.classList.add('manus-drop-target');
  });
  listEl.addEventListener('dragleave', () => listEl.classList.remove('manus-drop-target'));
  listEl.addEventListener('drop', (e) => {
    e.preventDefault();
    listEl.classList.remove('manus-drop-target');
    if (manusAktDragKey) manusMoveAktRow(manusAktDragKey, laneCode, null);
  });
}

function renderAktRow(row) {
  const el = document.createElement('div');
  el.className = 'manus-akt-row';
  el.draggable = true;

  el.addEventListener('dragstart', (e) => {
    manusAktDragKey = row.key;
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.add('manus-drop-target');
  });
  el.addEventListener('dragleave', () => el.classList.remove('manus-drop-target'));
  el.addEventListener('dragend', () => el.classList.remove('manus-drop-target'));
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('manus-drop-target');
    if (manusAktDragKey && manusAktDragKey !== row.key) {
      manusMoveAktRow(manusAktDragKey, row.lane, row.key);
    }
  });

  const handle = document.createElement('span');
  handle.className = 'manus-akt-drag-handle';
  handle.textContent = '⠿';
  el.appendChild(handle);

  const title = document.createElement('span');
  title.className = 'manus-akt-row-title';
  title.textContent = manusRowTitle(row);
  el.appendChild(title);

  const type = manusRowType(row);
  if (type) {
    const badge = document.createElement('span');
    badge.className = 'manus-year-type-badge';
    badge.textContent = MANUS_SCENE_TYPE_LABELS[type] || type;
    el.appendChild(badge);
  }

  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.min = '0';
  durationInput.step = '0.5';
  durationInput.className = 'manus-akt-duration';
  durationInput.placeholder = '–';
  durationInput.value = row.duration != null ? row.duration : '';
  durationInput.addEventListener('input', () => {
    row.duration = durationInput.value === '' ? null : Number(durationInput.value);
  });
  el.appendChild(durationInput);

  const suffix = document.createElement('span');
  suffix.className = 'manus-akt-duration-suffix';
  suffix.textContent = 'min';
  el.appendChild(suffix);

  if (row.lane !== 'pool') {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'manus-akt-row-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Flyt tilbage til "Ikke valgt"';
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => manusMoveAktRow(row.key, 'pool', null));
    el.appendChild(removeBtn);
  }

  return el;
}

function renderAktBuilderBody() {
  const poolList = document.getElementById('manus-akt-pool-list');
  poolList.textContent = '';
  const poolRows = manusAktRowsForLane('pool');
  if (poolRows.length === 0) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen uplaceret manus.';
    poolList.appendChild(empty);
  } else {
    for (const row of poolRows) poolList.appendChild(renderAktRow(row));
  }

  const actsMount = document.getElementById('manus-akt-sections');
  actsMount.textContent = '';
  for (const act of manusAktState.acts) {
    const section = document.createElement('div');
    section.className = 'manus-akt-section';

    const header = document.createElement('div');
    header.className = 'manus-akt-header';
    const label = document.createElement('span');
    label.className = 'manus-akt-label';
    label.textContent = act.label;
    header.appendChild(label);
    const rowsInAct = manusAktRowsForLane(act.code);
    const count = document.createElement('span');
    count.className = 'manus-akt-count';
    count.textContent = `${rowsInAct.length} scener`;
    header.appendChild(count);
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'manus-akt-list';
    for (const row of rowsInAct) list.appendChild(renderAktRow(row));
    section.appendChild(list);
    wireLaneDropZone(list, act.code);

    actsMount.appendChild(section);
  }
}

// Builds the same nested acts/scenes shape import.js's applyImport()
// already sends to the `manus` resource. Existing-origin rows keep every
// original field (cast, schedulable, priority, ...); only id/number/
// duration are (re)written. `actLabel` is stripped — it's added only by
// the embed pipeline's flattening, not part of the real per-act schema.
function manusBuildAktSavePayload() {
  const scenesActs = [];
  for (const act of manusAktState.acts) {
    const rowsInAct = manusAktRowsForLane(act.code);
    const scenes = rowsInAct.map((row, idx) => {
      const number = idx + 1;
      const id = `${act.code}-${number}`;
      if (row.origin === 'existing') {
        const scene = { ...row.scene };
        delete scene.actLabel;
        scene.id = id;
        scene.number = number;
        if (row.duration != null && row.duration !== '') scene.duration = row.duration;
        else delete scene.duration;
        return scene;
      }
      const sub = row.submission;
      const scene = {
        id,
        number,
        name: sub.title,
        types: [sub.type],
        schedulable: true,
        priority: 0,
        cast: [],
        sourcePdf: sub.pdfPath,
        sourceTex: sub.texPath,
      };
      if (row.duration != null && row.duration !== '') scene.duration = row.duration;
      return scene;
    });
    scenesActs.push({ act: act.code, label: act.label, scenes });
  }
  return scenesActs;
}

// Mirrors scripts/embed-scenes.js's own flattening, for the in-memory
// manus-data.js shadow (setManusSavedOverride expects SCENES_DATA's shape).
function manusFlattenActs(scenesActs) {
  const flat = [];
  for (const act of scenesActs) {
    for (const scene of act.scenes) flat.push({ ...scene, actLabel: act.label });
  }
  return flat;
}

function openAktfordelingBuilder() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Aktfordeling');
  modal.classList.add('manus-akt-modal');

  manusAktState = manusInitAktState();

  const columns = document.createElement('div');
  columns.className = 'manus-akt-columns';
  form.appendChild(columns);

  const poolCol = document.createElement('div');
  poolCol.className = 'manus-akt-pool';
  const poolHeading = document.createElement('h3');
  poolHeading.textContent = 'Ikke valgt';
  poolCol.appendChild(poolHeading);
  const poolList = document.createElement('div');
  poolList.className = 'manus-akt-pool-list';
  poolList.id = 'manus-akt-pool-list';
  poolCol.appendChild(poolList);
  columns.appendChild(poolCol);

  const structureCol = document.createElement('div');
  structureCol.className = 'manus-akt-structure';
  const structHeading = document.createElement('h3');
  structHeading.textContent = 'Akter';
  structureCol.appendChild(structHeading);
  const actsMount = document.createElement('div');
  actsMount.id = 'manus-akt-sections';
  structureCol.appendChild(actsMount);
  columns.appendChild(structureCol);

  wireLaneDropZone(poolList, 'pool');
  renderAktBuilderBody();

  const saveBtn = document.createElement('button');
  saveBtn.className = 'site-pill-btn site-pill-primary';
  saveBtn.textContent = 'Gem';
  actions.appendChild(saveBtn);

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Gemmer…';
    error.textContent = '';
    const scenesActs = manusBuildAktSavePayload();
    const cast = getEffectiveCastData();
    const result = await siteSaveResource('manus', { scenes: scenesActs, cast });
    saveBtn.disabled = false;
    saveBtn.textContent = 'Gem';
    if (result.ok) {
      setManusSavedOverride({ scenes: manusFlattenActs(scenesActs), cast });
      renderAll();
      close();
    } else {
      error.textContent = result.message;
    }
  });
}

// ── Init ─────────────────────────────────────────────────────
function renderAll() {
  renderColumns();
  renderBottomActions();
  renderYearView();
  manusStartPendingPoll();
}

document.addEventListener('DOMContentLoaded', renderAll);
