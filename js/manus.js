/* =========================================================
   Matematikrevyen – Manus page (manus.html)

   Two parts:

   1. Upload pool (data/manuscripts.json, embedded as MANUSCRIPTS_DATA):
      any revyst+ can submit a sketch/song (title/sender/.pdf/.tex),
      shown as two alphabetical columns, each an open-by-default toggle
      section. Boss/admin can remove a submission via a small ✕.
      Modeled directly on posts.js's create-post flow —
      manusApi()/manusResolvePassword() mirror
      postsApi()/postsResolvePassword() since posts_create-style
      append-only actions need an ANY-level authenticated call, not
      just boss/admin (siteSaveResource only trusts boss/admin logins).
      Revyst-level visitors see only the pool columns + the guide box —
      everything below (the read-only "Dette års manus" list and the
      whole Main Manus View) is boss/admin only.

   2. Main Manus View (boss/admin only): a tabbed section below the pool
      — Vælg scener / Aktfordeling / Rollefordeling / Stjerneark, styled
      as folder tabs filling the section's top row evenly — all four
      sharing one flat draft-state row list (manusDraft, built by
      manusInitDraft() from the CURRENT data/scenes.json + not-yet-used
      pool submissions). Vælg scener is a click-to-select row (no
      checkbox — amber highlight, not a blue checked box) per pool
      submission, unselected by default; a selected count replaces the
      old "(total)" in each column's header. Aktfordeling/Rollefordeling/
      Stjerneark all share one act-columns grid (renderActColumnsGrid(),
      N columns = manusDraft.acts.length, 4 for the fixed skeleton) —
      Aktfordeling additionally renders "Ikke placeret" as its own
      full-width row below the acts (same column grid, filled row-wise,
      selected-but-unplaced pool rows only), and its drag-and-drop makes
      each whole column a drop target (not just its card-list strip) via a
      shared wireDropHighlight() helper that counts dragenter/dragleave
      pairs instead of toggling straight off dragover/dragleave so it
      doesn't flicker as the pointer crosses child cards — deliberately no
      visible highlight box on the column itself while dragging over it
      (only a placed card still gets one, for precise "insert before this
      card" feedback), just the underlying drop-target class toggling with
      no CSS attached; Rollefordeling assigns
      cast per already-placed scene via a scene *button* that opens an
      overlay (Øveplan-style — openRoleSceneModal(), ROLE_CATEGORIES/
      classifyRoleCode/classifyOrKeep duplicated from import.js — manus.html
      doesn't load it); Stjerneark sets a 0-3 priority per scene, splitting a
      dance-combined scene into two independent rows exactly like
      Øveplan does (splitDanceScene()/applyDanceSplits-style helpers
      duplicated from schedule.js). One shared "Gem" (manusSaveMain())
      saves everything via the existing boss-level `manus` resource
      (siteSaveResource('manus', {scenes, cast})). Deselecting a pool
      row in Vælg scener only marks it locally — a separate "Bekræft
      fravalg" step calls the new manuscripts_discard server action,
      which moves the files into archive/<folder>/not_selected/ (folder
      hardcoded server-side in data/config.json's currentProductionFolder
      for now, not read or shown client-side) and removes them from
      data/manuscripts.json. "Intast point" is still a stub (see
      matrevy-plan.md).

   DOM is built via createElement/textContent only — never innerHTML.
   ========================================================= */

'use strict';

const MANUS_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MANUS_TYPES = ['sang', 'sketch'];
const MANUS_TYPE_COLUMN_LABEL = { sketch: 'Sketches', sang: 'Sange' };
const MANUS_SCENE_TYPE_LABELS = { sketch: 'Sketch', sang: 'Sang', dans: 'Dans', bandsang: 'Bandsang', video: 'Video' };

// ── Duplicated from import.js/schedule.js ───────────────────────
// manus.html doesn't load either script, and this file already reimplements
// rather than cross-file-reuses their DOM-coupled logic (see the Main Manus
// View section below) — these are the pure, non-DOM parts, copied verbatim.

// From import.js: cast role codes get normalized into one of these.
const ROLE_CATEGORIES = ['Instruktør', 'Koreograf', 'Skuespil', 'Sang/Rap', 'Dans', 'Kor', 'Statist', 'Ninja'];

function classifyRoleCode(code, isSong, isDans) {
  const raw = code.trim();
  const c = raw.toUpperCase();
  if (raw.includes('I')) return 'Instruktør';
  if (c.includes('Y')) return 'Koreograf';
  if (c.startsWith('ST')) return 'Statist';
  if (isSong) {
    if (c.includes('D')) return 'Dans';
    if (c.startsWith('K')) return 'Kor';
    if (c.includes('N')) return 'Ninja';
    return 'Sang/Rap';
  }
  if (isDans && c.includes('D')) return 'Dans';
  if (c.includes('N')) return 'Ninja';
  return 'Skuespil';
}

function classifyOrKeep(code, isSong, isDans) {
  return ROLE_CATEGORIES.includes(code) ? code : classifyRoleCode(code, isSong, isDans);
}

// From schedule.js: a scene whose types combine 'dans' with 'sketch'/'sang'
// is displayed here as two rows ("X" and "X (Dans)"), same split schedule.js
// does for its own scheduling grid — display-only in this file, never re-saved
// from the split form (see manusRowScene()/renderStjerneArkTab() below).
const DANCE_SPLIT_SUFFIX = '::dans';

function isDanceCastRole(role) {
  const r = (role || '').trim();
  if (r === 'Dans' || r === 'Koreograf') return true;
  const c = r.toUpperCase();
  return c.includes('Y') || c.includes('D');
}

function isDanceSplitCandidate(scene) {
  return Array.isArray(scene.types)
    && scene.types.includes('dans')
    && (scene.types.includes('sketch') || scene.types.includes('sang'));
}

// Returns [mainPart, dancePart], or null if the scene doesn't qualify. Unlike
// schedule.js's own copy, the dance half's priority comes from the scene's
// own (persisted) dansPriority field, not a fresh 0 — Stjerneark's whole
// point is to persist real priorities, so the split display must reflect
// what's actually stored/drafted rather than resetting on every render.
function splitDanceScene(scene) {
  if (!isDanceSplitCandidate(scene)) return null;
  const mainCast = [];
  const danceCast = [];
  for (const c of scene.cast) {
    (isDanceCastRole(c.role) ? danceCast : mainCast).push(c);
  }
  const danceId = scene.id + DANCE_SPLIT_SUFFIX;
  const mainPart = { ...scene, cast: mainCast };
  const dancePart = {
    ...scene,
    id: danceId,
    name: scene.name + ' (Dans)',
    cast: danceCast,
    priority: scene.dansPriority != null ? scene.dansPriority : 0,
  };
  return [mainPart, dancePart];
}

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

// Each pool column is a toggle section, open by default.
function renderColumn(type) {
  const section = document.createElement('section');
  section.className = 'card manus-column';

  const items = getEffectiveManuscripts()
    .filter(s => s.type === type)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));

  let expanded = true;

  const list = document.createElement('div');
  list.className = 'manus-col-list';

  const header = document.createElement('button');
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

  return section;
}

function renderColumns() {
  const mount = document.getElementById('manus-columns');
  mount.textContent = '';
  for (const type of MANUS_TYPES) mount.appendChild(renderColumn(type));
}

// ── Bottom CTA: Upload manus (revyst only) ───────────────────
// Boss/admin get no bottom CTA anymore — the full Main Manus View section
// further down the page (see below) is always visible to them instead.
function renderBottomActions() {
  const mount = document.getElementById('manus-bottom-actions');
  mount.textContent = '';
  if (!siteHasLevel('revyst') || siteHasLevel('boss')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-pill-btn site-pill-warm';
  btn.textContent = 'Upload';
  btn.addEventListener('click', openUploadModal);
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

// Boss/admin only — revyst only ever sees the upload pool columns + guide,
// per the page's access-level split (see file header).
function renderYearView() {
  const scenes = getEffectiveScenesData();
  const section = document.getElementById('manus-year-section');
  const mount = document.getElementById('manus-year-acts');
  mount.textContent = '';
  if (!siteHasLevel('boss') || !scenes.length) { section.style.display = 'none'; return; }
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
  colgroup.appendChild(document.createElement('col'));
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

// ── Main Manus View (boss/admin only) — shared draft state ────
// One flat row list shared by all 4 tabs, with a `lane` field ('pool' or an
// act code) — the same shape import.js's flat scene list uses with an
// actCode, reimplemented independently here since the input shape (pool
// submissions vs. already-cast-assigned scenes) differs too much to share
// import.js's code directly (see matrevy-plan.md's Phase 4 notes). Lives for
// the page session — built once when the section first renders, NOT rebuilt
// on a bare tab switch (that would drop in-progress edits), only after a
// successful main save or discard-finalize.
let manusDraft = null;
let manusDragKey = null;
let manusKeyCounter = 0;

function manusNextKey() {
  manusKeyCounter += 1;
  return `k${manusKeyCounter}`;
}

// Fixed Akt 1/2/3/Ekstranumre skeleton (matches the current production's
// act codes), plus any other code actually found in the data — so a scene
// with an unexpected act code is never silently dropped from the view.
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

// Seeds the draft from the CURRENT production (existing scenes keep all
// their fields — cast, priority, etc. — untouched, just re-shaped into a row)
// plus every pool submission not already referenced by an existing scene's
// sourcePdf. Pool rows default to selected:false — Vælg scener starts with
// nothing chosen, and a coordinator clicks each submission they want to keep
// in the running; anything left unselected is what "Bekræft fravalg" offers
// to archive.
function manusInitDraft() {
  const existing = getEffectiveScenesData();
  const acts = manusBuildActSkeleton(existing);
  const placedPaths = new Set();
  const rows = [];
  for (const s of existing) {
    if (s.sourcePdf) placedPaths.add(s.sourcePdf);
    const isSong = (s.types || []).includes('sang');
    const isDans = (s.types || []).includes('dans');
    rows.push({
      key: manusNextKey(),
      origin: 'existing',
      lane: String(s.id).split('-')[0],
      scene: s,
      selected: true,
      duration: s.duration != null ? s.duration : null,
      cast: (s.cast || []).map(c => ({ code: classifyOrKeep(c.role, isSong, isDans), name: c.name })),
      priority: s.priority || 0,
      dansPriority: isDanceSplitCandidate(s) ? (s.dansPriority != null ? s.dansPriority : 0) : null,
      repeat: !!s.repeat,
      dansRepeat: isDanceSplitCandidate(s) ? !!s.dansRepeat : null,
    });
  }
  const pool = getEffectiveManuscripts()
    .filter(s => !placedPaths.has(s.pdfPath))
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));
  for (const sub of pool) {
    rows.push({
      key: manusNextKey(),
      origin: 'pool',
      lane: 'pool',
      submission: sub,
      selected: false,
      duration: null,
      cast: [],
      priority: 0,
      dansPriority: null,
      repeat: false,
      dansRepeat: null,
    });
  }
  return { acts, rows };
}

function manusDraftRowsForLane(lane) {
  return manusDraft.rows.filter(r => r.lane === lane);
}

function manusRowTitle(row) {
  return row.origin === 'existing' ? row.scene.name : row.submission.title;
}

function manusRowType(row) {
  return row.origin === 'existing' ? ((row.scene.types || [])[0] || '') : row.submission.type;
}

// Unselecting a row that's currently placed in an act also forces it back to
// the pool lane — a row marked for discard can't remain placed.
function manusSetRowSelected(key, selected) {
  const row = manusDraft.rows.find(r => r.key === key);
  if (!row) return;
  row.selected = selected;
  if (!selected && row.lane !== 'pool') row.lane = 'pool';
}

function manusMoveRow(key, targetLane, beforeKey) {
  const rows = manusDraft.rows;
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
  manusDragKey = null;
  renderAktfordelingTab();
}

// Robust dragenter/dragleave pairing via a nesting counter, shared by a whole
// lane container (wireLaneDropZone) and a single draggable card
// (renderDraftRowCard) — plain dragover-driven highlighting (the old
// approach) re-fires on every child element the pointer crosses, so
// dragleave also fires on every child boundary and flickers the highlight
// on/off constantly; counting enter/leave pairs only clears it once the
// pointer has actually left the whole element. `stop: true` also
// stopPropagation()s every event so a card being hovered doesn't also
// light up its containing column at the same time.
function wireDropHighlight(el, onDrop, { stop = false } = {}) {
  let depth = 0;
  el.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth++;
    el.classList.add('manus-drop-target');
  });
  el.addEventListener('dragover', (e) => {
    e.preventDefault(); // required for 'drop' to fire at all
    if (stop) e.stopPropagation();
  });
  el.addEventListener('dragleave', (e) => {
    if (stop) e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) el.classList.remove('manus-drop-target');
  });
  el.addEventListener('drop', (e) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth = 0;
    el.classList.remove('manus-drop-target');
    onDrop();
  });
}

// A lane container (an act column or the "Ikke placeret" section) — dropping
// anywhere in it (not on a specific card) appends to the end of that lane.
function wireLaneDropZone(zoneEl, laneCode) {
  wireDropHighlight(zoneEl, () => {
    if (manusDragKey) manusMoveRow(manusDragKey, laneCode, null);
  });
}

// Builds one fully-shaped scene object for a placed row (idx = position
// within its act) — the single source of truth for both what gets saved
// (manusBuildActsPayload) and what Rollefordeling/Stjerneark display, so
// display and save can never drift apart.
function manusRowScene(row, act, idx) {
  const number = idx + 1;
  const id = `${act.code}-${number}`;
  const cast = row.cast
    .filter(c => c.name.trim() && c.code.trim())
    .map(c => ({ name: c.name.trim(), role: c.code.trim() }));

  let scene;
  if (row.origin === 'existing') {
    scene = { ...row.scene };
    delete scene.actLabel;
    scene.id = id;
    scene.number = number;
    scene.cast = cast;
  } else {
    const sub = row.submission;
    scene = {
      id,
      number,
      name: sub.title,
      types: [sub.type],
      schedulable: true,
      cast,
      sourcePdf: sub.pdfPath,
      sourceTex: sub.texPath,
    };
  }
  scene.priority = row.priority || 0;
  if (isDanceSplitCandidate(scene) && row.dansPriority != null) scene.dansPriority = row.dansPriority;
  else delete scene.dansPriority;
  scene.repeat = !!row.repeat;
  if (isDanceSplitCandidate(scene) && row.dansRepeat) scene.dansRepeat = true;
  else delete scene.dansRepeat;
  if (row.duration != null && row.duration !== '') scene.duration = row.duration;
  else delete scene.duration;
  return scene;
}

// Walks manusDraft.acts, building the nested acts/scenes shape
// data/scenes.json actually uses — the save payload.
function manusBuildActsPayload() {
  const scenesActs = [];
  for (const act of manusDraft.acts) {
    const rowsInAct = manusDraftRowsForLane(act.code);
    const scenes = rowsInAct.map((row, idx) => manusRowScene(row, act, idx));
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

// ── Kanban card (shared by the "Ikke placeret" column and every act
// column in the Aktfordeling tab) ──────────────────────────────
function renderDraftRowCard(row) {
  const el = document.createElement('div');
  el.className = 'manus-akt-row';
  el.draggable = true;

  el.addEventListener('dragstart', (e) => {
    manusDragKey = row.key;
    e.dataTransfer.effectAllowed = 'move';
  });
  el.addEventListener('dragend', () => el.classList.remove('manus-drop-target'));
  // stop:true so hovering a card doesn't also light up its containing
  // column — dropping directly on a card inserts before it, more specific
  // than the column-wide "append to end" in wireLaneDropZone.
  wireDropHighlight(el, () => {
    if (manusDragKey && manusDragKey !== row.key) manusMoveRow(manusDragKey, row.lane, row.key);
  }, { stop: true });

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

  // Duration was already set in Vælg scener for pool-origin rows — this card
  // only offers an editable field for already-placed (existing-origin) rows,
  // which never appear in that tab.
  if (row.origin === 'existing') {
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
  } else if (row.duration != null && row.duration !== '') {
    const dur = document.createElement('span');
    dur.className = 'manus-akt-duration-suffix';
    dur.textContent = `${row.duration} min`;
    el.appendChild(dur);
  }

  if (row.lane !== 'pool') {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'manus-akt-row-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Flyt tilbage til "Ikke placeret"';
    removeBtn.setAttribute('aria-label', removeBtn.title);
    removeBtn.addEventListener('click', () => manusMoveRow(row.key, 'pool', null));
    el.appendChild(removeBtn);
  }

  return el;
}

// ── Tab 1: Vælg scener ─────────────────────────────────────────
function renderSelectColumn(type) {
  const section = document.createElement('section');
  section.className = 'card manus-column';

  const rows = manusDraft.rows
    .filter(r => r.origin === 'pool' && r.submission.type === type)
    .slice()
    .sort((a, b) => a.submission.title.localeCompare(b.submission.title, 'da'));
  const selectedCount = rows.filter(r => r.selected === true).length;

  const header = document.createElement('div');
  header.className = 'manus-col-header';
  const h2 = document.createElement('h2');
  h2.textContent = MANUS_TYPE_COLUMN_LABEL[type];
  header.appendChild(h2);
  const count = document.createElement('span');
  count.className = 'manus-col-count';
  count.textContent = `(${selectedCount})`;
  header.appendChild(count);
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'manus-col-list';
  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen upload endnu.';
    list.appendChild(empty);
  } else {
    for (const row of rows) list.appendChild(renderSelectRow(row));
  }
  section.appendChild(list);

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

  return section;
}

// The whole row is the toggle (no checkbox) — click or Enter/Space flips
// selection; the duration input stops propagation so typing in it doesn't
// also toggle the row.
function renderSelectRow(row) {
  const el = document.createElement('div');
  el.className = 'manus-select-row' + (row.selected === true ? ' manus-select-row-selected' : '');
  el.setAttribute('role', 'button');
  el.tabIndex = 0;
  el.setAttribute('aria-pressed', String(row.selected === true));

  const title = document.createElement('span');
  title.className = 'manus-pdf-title';
  title.textContent = row.submission.title;
  el.appendChild(title);

  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.min = '0';
  durationInput.step = '0.5';
  durationInput.className = 'manus-select-duration';
  durationInput.placeholder = '–';
  durationInput.value = row.duration != null ? row.duration : '';
  durationInput.addEventListener('click', (e) => e.stopPropagation());
  durationInput.addEventListener('input', () => {
    row.duration = durationInput.value === '' ? null : Number(durationInput.value);
  });
  el.appendChild(durationInput);
  const suffix = document.createElement('span');
  suffix.className = 'manus-akt-duration-suffix';
  suffix.textContent = 'min';
  el.appendChild(suffix);

  const toggle = () => {
    manusSetRowSelected(row.key, row.selected !== true);
    renderSelectTab();
  };
  el.addEventListener('click', toggle);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
  });

  return el;
}

function renderSelectTab() {
  const mount = document.getElementById('manus-tab-select');
  mount.textContent = '';

  const columns = document.createElement('div');
  columns.className = 'manus-select-columns';
  for (const type of MANUS_TYPES) columns.appendChild(renderSelectColumn(type));
  mount.appendChild(columns);

  const discardBar = document.createElement('div');
  discardBar.className = 'manus-select-discard-bar';
  const deselected = manusDraft.rows.filter(r => r.origin === 'pool' && r.selected === false);
  const countSpan = document.createElement('span');
  countSpan.textContent = deselected.length
    ? `${deselected.length} fravalgt${deselected.length === 1 ? '' : 'e'}, klar til arkivering.`
    : 'Ingen fravalgte endnu.';
  discardBar.appendChild(countSpan);

  const discardBtn = document.createElement('button');
  discardBtn.type = 'button';
  discardBtn.className = 'site-pill-btn site-pill-danger';
  discardBtn.textContent = 'Bekræft fravalg';
  discardBtn.disabled = deselected.length === 0;
  discardBtn.addEventListener('click', () => confirmDiscardRows(deselected));
  discardBar.appendChild(discardBtn);

  mount.appendChild(discardBar);
}

// Explicit confirm step (per design): unchecking a row only marks it locally
// — nothing server-side happens until this is confirmed, so it's freely
// reversible (re-check the row) any time before this click.
function confirmDiscardRows(rows) {
  const { form, error, actions, close } = siteOpenEditModal('Arkiver fravalgte');

  const info = document.createElement('p');
  info.textContent = rows.length === 1
    ? `Arkiver "${rows[0].submission.title}"? Filerne flyttes til arkivets "not_selected"-mappe.`
    : `Arkiver ${rows.length} fravalgte manus? Filerne flyttes til arkivets "not_selected"-mappe.`;
  form.appendChild(info);

  const list = document.createElement('ul');
  for (const row of rows) {
    const li = document.createElement('li');
    li.textContent = row.submission.title;
    list.appendChild(li);
  }
  form.appendChild(list);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-pill-btn site-pill-danger';
  confirmBtn.textContent = 'Arkiver fravalgte';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const ids = rows.map(r => r.submission.id);
    const result = await siteFileAction('manuscripts_discard', { ids });
    if (result.ok) {
      const idSet = new Set(ids);
      manuscriptsOverride = getEffectiveManuscripts().filter(s => !idSet.has(s.id));
      siteSaveOverride('manuscripts', manuscriptsOverride);
      manusDraft.rows = manusDraft.rows.filter(r => !(r.origin === 'pool' && idSet.has(r.submission.id)));
      renderColumns();
      renderSelectTab();
      if (manusActiveTab === 'aktfordeling') renderAktfordelingTab();
      close();
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Shared: one column per act, laid out in a row of N equal columns ──
// (N = manusDraft.acts.length, 4 for the fixed Akt1/2/3/Ekstranumre
// skeleton) — used by Aktfordeling's act row and, unchanged otherwise, by
// Rollefordeling/Stjerneark below so all three tabs read as the same grid.
// buildColumnBody(bodyEl, act, rowsInAct, colEl) fills each column's body;
// whatever it doesn't wire up (drag-and-drop, in Aktfordeling's case) simply
// isn't there for the other two tabs. colEl (header+body together) is handed
// through so Aktfordeling can make the *whole* column a drop target, not
// just the body's own strip — see wireLaneDropZone().
function renderActColumnsGrid(buildColumnBody) {
  const grid = document.createElement('div');
  grid.className = 'manus-kanban';
  grid.style.gridTemplateColumns = `repeat(${manusDraft.acts.length}, minmax(220px, 1fr))`;

  for (const act of manusDraft.acts) {
    const col = document.createElement('div');
    col.className = 'manus-kanban-col';

    const header = document.createElement('div');
    header.className = 'manus-kanban-col-header';
    const label = document.createElement('span');
    label.className = 'manus-akt-label';
    label.textContent = act.label;
    header.appendChild(label);
    const rowsInAct = manusDraftRowsForLane(act.code);
    const count = document.createElement('span');
    count.className = 'manus-akt-count';
    count.textContent = `${rowsInAct.length} scener`;
    header.appendChild(count);
    col.appendChild(header);

    const body = document.createElement('div');
    body.className = 'manus-kanban-col-list';
    buildColumnBody(body, act, rowsInAct, col);
    col.appendChild(body);

    grid.appendChild(col);
  }

  return grid;
}

// ── Tab 2: Aktfordeling — act columns in a row, "Ikke placeret" below ──
function renderAktfordelingTab() {
  const mount = document.getElementById('manus-tab-aktfordeling');
  mount.textContent = '';

  const kanban = renderActColumnsGrid((body, act, rowsInAct, col) => {
    for (const row of rowsInAct) body.appendChild(renderDraftRowCard(row));
    // The whole column (header + body, including any empty space below the
    // last card) accepts a drop, not just the body strip — dropping on a
    // specific card still inserts before it (renderDraftRowCard's own
    // dragover/drop, which stopPropagation()s so it wins over this).
    wireLaneDropZone(col, act.code);
  });
  mount.appendChild(kanban);

  // "Ikke placeret" — selected-but-unplaced rows only; a deselected row
  // (headed for discard in Vælg scener) never appears here. Rendered as its
  // own full-width row below the acts, but internally still split into the
  // same N columns (same widths as the act row above), filled row-wise —
  // that's CSS grid's default auto-placement, no extra JS needed.
  const poolSection = document.createElement('div');
  poolSection.className = 'manus-kanban-pool-section';

  const poolRows = manusDraftRowsForLane('pool').filter(r => r.selected !== false);
  const poolHeader = document.createElement('div');
  poolHeader.className = 'manus-kanban-col-header';
  const poolLabel = document.createElement('span');
  poolLabel.className = 'manus-akt-label';
  poolLabel.textContent = 'Ikke placeret';
  poolHeader.appendChild(poolLabel);
  const poolCount = document.createElement('span');
  poolCount.className = 'manus-akt-count';
  poolCount.textContent = `${poolRows.length} scener`;
  poolHeader.appendChild(poolCount);
  poolSection.appendChild(poolHeader);

  const poolGrid = document.createElement('div');
  poolGrid.className = 'manus-kanban-pool-grid';
  poolGrid.style.gridTemplateColumns = `repeat(${manusDraft.acts.length}, minmax(220px, 1fr))`;
  if (!poolRows.length) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen uplaceret manus.';
    poolGrid.appendChild(empty);
  } else {
    for (const row of poolRows) poolGrid.appendChild(renderDraftRowCard(row));
  }
  poolSection.appendChild(poolGrid);
  // Same "whole area is droppable" treatment as an act column, above.
  wireLaneDropZone(poolSection, 'pool');

  mount.appendChild(poolSection);
}

// ── Tab 3: Rollefordeling ───────────────────────────────────────
// Each scene is a button (Øveplan-style: click a scene, an overlay opens to
// edit it) rather than an always-expanded inline card — openRoleSceneModal()
// holds the same select+name+✕ cast-row editor the inline card used to.
function manusCastCount(row) {
  return row.cast.filter(c => c.name.trim()).length;
}

function manusRoleBadgeText(row) {
  const n = manusCastCount(row);
  return n === 1 ? '1 rolle' : `${n} roller`;
}

function renderRoleCastRow(row, ci, castList, badge) {
  const c = row.cast[ci];
  const cRow = document.createElement('div');
  cRow.className = 'manus-role-cast-row';

  const codeSelect = document.createElement('select');
  codeSelect.className = 'manus-role-cast-code';
  const placeholderOpt = document.createElement('option');
  placeholderOpt.value = '';
  placeholderOpt.textContent = 'Vælg rolle…';
  placeholderOpt.disabled = true;
  if (!c.code) placeholderOpt.selected = true;
  codeSelect.appendChild(placeholderOpt);
  ROLE_CATEGORIES.forEach(cat => {
    const opt = document.createElement('option');
    opt.value = cat;
    opt.textContent = cat;
    if (c.code === cat) opt.selected = true;
    codeSelect.appendChild(opt);
  });
  codeSelect.addEventListener('change', () => { c.code = codeSelect.value; });

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = c.name;
  nameInput.placeholder = 'Navn';
  nameInput.className = 'manus-role-cast-name';
  nameInput.addEventListener('input', () => {
    c.name = nameInput.value;
    badge.textContent = manusRoleBadgeText(row);
  });

  const rmBtn = document.createElement('button');
  rmBtn.type = 'button';
  rmBtn.className = 'manus-akt-row-remove';
  rmBtn.textContent = '✕';
  rmBtn.addEventListener('click', () => {
    row.cast.splice(ci, 1);
    renderRoleCastList(row, castList, badge);
    badge.textContent = manusRoleBadgeText(row);
  });

  cRow.appendChild(codeSelect);
  cRow.appendChild(nameInput);
  cRow.appendChild(rmBtn);
  return cRow;
}

// Rebuilds just the modal's own cast list (not the whole tab underneath —
// see openRoleSceneModal() for why that matters).
function renderRoleCastList(row, castList, badge) {
  castList.textContent = '';
  row.cast.forEach((c, ci) => castList.appendChild(renderRoleCastRow(row, ci, castList, badge)));
}

// `badge` is the count span on the scene button behind this modal — mutating
// it directly (rather than re-rendering the whole Rollefordeling tab from in
// here) keeps it in sync live without touching a modal that lives in its own
// part of the DOM (document.body, not #manus-tab-rollefordeling), so nothing
// about the modal itself is ever at risk of being torn down mid-edit.
function openRoleSceneModal(row, badge) {
  const { form } = siteOpenModalWithClose(manusRowTitle(row));

  const castList = document.createElement('div');
  castList.className = 'manus-role-cast-list';
  renderRoleCastList(row, castList, badge);
  form.appendChild(castList);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-small manus-role-add-cast-btn';
  addBtn.textContent = '+ Tilføj rolle';
  addBtn.addEventListener('click', () => {
    row.cast.push({ code: '', name: '' });
    renderRoleCastList(row, castList, badge);
    badge.textContent = manusRoleBadgeText(row);
  });
  form.appendChild(addBtn);
}

function renderRoleSceneButton(row) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'manus-role-scene-btn';

  const title = document.createElement('span');
  title.className = 'manus-akt-row-title';
  title.textContent = manusRowTitle(row);
  btn.appendChild(title);

  const badge = document.createElement('span');
  badge.className = 'manus-akt-count';
  badge.textContent = manusRoleBadgeText(row);
  btn.appendChild(badge);

  btn.addEventListener('click', () => openRoleSceneModal(row, badge));
  return btn;
}

function renderRollefordelingTab() {
  const mount = document.getElementById('manus-tab-rollefordeling');
  mount.textContent = '';

  const anyPlaced = manusDraft.acts.some(act => manusDraftRowsForLane(act.code).length);
  if (!anyPlaced) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Placér scener i Aktfordeling, før du fordeler roller.';
    mount.appendChild(empty);
    return;
  }

  mount.appendChild(renderActColumnsGrid((body, act, rowsInAct) => {
    for (const row of rowsInAct) body.appendChild(renderRoleSceneButton(row));
  }));
}

// ── Tab 4: Stjerneark ────────────────────────────────────────────
// Row styling matches Rollefordeling/Aktfordeling's box (.manus-akt-row) —
// see the "styled the same" request. Priority is four always-visible
// circles (0-3, grey when not the active one, colored via the existing
// .manus-prio-0..3 palette when active) instead of a dropdown, plus a fifth
// "repeat" circle (↻) marking a scene that wants a second rehearsal the
// next day (row.repeat / row.dansRepeat for the dance half — mirrors
// row.priority/row.dansPriority exactly).
const MANUS_PRIO_VALUES = [0, 1, 2, 3];

function renderStarRow(row, entry) {
  const isDanceHalf = entry.id.endsWith(DANCE_SPLIT_SUFFIX);
  const el = document.createElement('div');
  el.className = 'manus-akt-row manus-star-row';

  const name = document.createElement('span');
  name.className = 'manus-akt-row-title';
  name.textContent = entry.name;
  el.appendChild(name);

  const controls = document.createElement('div');
  controls.className = 'manus-star-controls';

  // manus-prio-N is a permanent per-value class (so :hover can preview that
  // value's own color via CSS alone); manus-prio-active is the separate,
  // toggled marker for which one is actually selected.
  const prioBtns = MANUS_PRIO_VALUES.map(v => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `manus-prio-circle manus-prio-${v}`;
    btn.textContent = v;
    btn.title = `Prioritet ${v}`;
    btn.addEventListener('click', () => {
      if (isDanceHalf) row.dansPriority = v; else row.priority = v;
      updatePrioBtns();
    });
    controls.appendChild(btn);
    return btn;
  });
  function updatePrioBtns() {
    const active = isDanceHalf ? (row.dansPriority || 0) : (row.priority || 0);
    prioBtns.forEach((btn, v) => {
      btn.classList.toggle('manus-prio-active', v === active);
      btn.setAttribute('aria-pressed', String(v === active));
    });
  }
  updatePrioBtns();

  const repeatBtn = document.createElement('button');
  repeatBtn.type = 'button';
  repeatBtn.className = 'manus-repeat-circle';
  repeatBtn.textContent = '↻';
  repeatBtn.title = 'Skal øves igen dagen efter';
  function updateRepeatBtn() {
    const active = isDanceHalf ? !!row.dansRepeat : !!row.repeat;
    repeatBtn.classList.toggle('manus-repeat-active', active);
    repeatBtn.setAttribute('aria-pressed', String(active));
  }
  repeatBtn.addEventListener('click', () => {
    if (isDanceHalf) row.dansRepeat = !row.dansRepeat; else row.repeat = !row.repeat;
    updateRepeatBtn();
  });
  updateRepeatBtn();
  controls.appendChild(repeatBtn);

  el.appendChild(controls);
  return el;
}

function renderStjerneArkTab() {
  const mount = document.getElementById('manus-tab-stjerneark');
  mount.textContent = '';

  const anyPlaced = manusDraft.acts.some(act => manusDraftRowsForLane(act.code).length);
  if (!anyPlaced) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Placér scener i Aktfordeling, før du prioriterer.';
    mount.appendChild(empty);
    return;
  }

  mount.appendChild(renderActColumnsGrid((body, act, rowsInAct) => {
    rowsInAct.forEach((row, idx) => {
      const scene = manusRowScene(row, act, idx);
      const split = splitDanceScene(scene);
      const entries = split || [scene];
      for (const entry of entries) body.appendChild(renderStarRow(row, entry));
    });
  }));
}

// ── Tab bar + section chrome ───────────────────────────────────
const MANUS_MAIN_TABS = [
  { key: 'select', label: 'Vælg scener', render: renderSelectTab },
  { key: 'aktfordeling', label: 'Aktfordeling', render: renderAktfordelingTab },
  { key: 'rollefordeling', label: 'Rollefordeling', render: renderRollefordelingTab },
  { key: 'stjerneark', label: 'Stjerneark', render: renderStjerneArkTab },
];
let manusActiveTab = 'select';

function renderTabBar() {
  const mount = document.getElementById('manus-tab-bar');
  mount.textContent = '';
  for (const tab of MANUS_MAIN_TABS) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'manus-tab-btn' + (tab.key === manusActiveTab ? ' active' : '');
    btn.textContent = tab.label;
    btn.addEventListener('click', () => {
      manusActiveTab = tab.key;
      renderTabBar();
      renderActiveTabPanel();
    });
    mount.appendChild(btn);
  }
}

function renderActiveTabPanel() {
  for (const tab of MANUS_MAIN_TABS) {
    document.getElementById(`manus-tab-${tab.key}`).style.display = tab.key === manusActiveTab ? '' : 'none';
  }
  const active = MANUS_MAIN_TABS.find(t => t.key === manusActiveTab);
  if (active) active.render();
}

async function manusSaveMain(saveBtn, error) {
  saveBtn.disabled = true;
  saveBtn.textContent = 'Gemmer…';
  error.textContent = '';

  const scenesActs = manusBuildActsPayload();
  // Extends the existing cast roster with any new name typed in
  // Rollefordeling — needed now since, unlike the old Aktfordeling, this
  // flow actually edits cast (mirrors import.js's applyImport()).
  const castRoster = getEffectiveCastData().map(c => ({ name: c.name, index: c.index }));
  const castNameSet = new Set(castRoster.map(c => c.name));
  function ensureCastMember(name) {
    if (!castNameSet.has(name)) {
      castNameSet.add(name);
      castRoster.push({ name, index: castRoster.length });
    }
  }
  for (const act of scenesActs) {
    for (const scene of act.scenes) {
      for (const c of scene.cast) ensureCastMember(c.name);
    }
  }
  castRoster.forEach((c, i) => c.index = i);

  const result = await siteSaveResource('manus', { scenes: scenesActs, cast: castRoster });
  saveBtn.disabled = false;
  saveBtn.textContent = 'Gem';
  if (result.ok) {
    setManusSavedOverride({ scenes: manusFlattenActs(scenesActs), cast: castRoster });
    manusDraft = null; // forces a fresh manusInitDraft() next render
    renderAll();
  } else {
    error.textContent = result.message;
  }
}

function renderMainViewActions() {
  const mount = document.getElementById('manus-main-view-actions');
  mount.textContent = '';

  const error = document.createElement('div');
  error.className = 'manus-main-view-error';
  mount.appendChild(error);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'site-pill-btn site-pill-primary';
  saveBtn.textContent = 'Gem';
  saveBtn.addEventListener('click', () => manusSaveMain(saveBtn, error));
  mount.appendChild(saveBtn);
}

function renderMainManusView() {
  const section = document.getElementById('manus-main-view');
  if (!siteHasLevel('boss')) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  if (!manusDraft) manusDraft = manusInitDraft();

  renderTabBar();
  renderActiveTabPanel();
  renderMainViewActions();
}

// ── Init ─────────────────────────────────────────────────────
// The Manus Guide box is static markup (not JS-rendered), so its toggle is
// wired once at load rather than re-wired on every renderAll() (renderAll
// re-runs after a save, which would otherwise stack duplicate listeners).
function wireManusGuideToggle() {
  const header = document.getElementById('manus-guide-header');
  const body = document.getElementById('manus-guide-text');
  header.addEventListener('click', () => {
    const expanded = header.getAttribute('aria-expanded') !== 'false';
    header.setAttribute('aria-expanded', String(!expanded));
    body.style.display = expanded ? 'none' : '';
  });
}

function renderAll() {
  renderColumns();
  renderBottomActions();
  renderYearView();
  renderMainManusView();
  manusStartPendingPoll();
}

document.addEventListener('DOMContentLoaded', () => {
  wireManusGuideToggle();
  renderAll();
});
