/* =========================================================
   Matematikrevyen – Manus page (manus.html)

   Two parts:

   1. Upload pool (data/manuscripts.json, embedded as MANUSCRIPTS_DATA):
      any revyst+ can submit a sketch/song (title/sender/.pdf/.tex),
      shown as two alphabetical columns, each a toggle section — open by
      default for revyst, closed by default for boss/admin (who have the
      much longer Main Manus View below to get to; same split applies to
      the Manus Guide box). Boss/admin can remove a submission via a small ✕.
      Modeled directly on posts.js's create-post flow —
      manusApi()/manusResolvePassword() mirror
      postsApi()/postsResolvePassword() since posts_create-style
      append-only actions need an ANY-level authenticated call, not
      just boss/admin (siteSaveResource only trusts boss/admin logins).
      Revyst-level visitors see only the pool columns + the guide box —
      the whole Main Manus View below is boss/admin only.

   2. Main Manus View (boss/admin only): a tabbed section below the pool
      — Vælg scener / Aktfordeling / Rollefordeling / Manus / Stjerneark,
      styled as folder tabs filling the section's top row evenly — all five
      sharing one flat draft-state row list (manusDraft, built by
      manusInitDraft() from the CURRENT data/scenes.json + not-yet-used
      pool submissions). Vælg scener is a click-to-select row (no
      checkbox — amber highlight, not a blue checked box) per pool
      submission; a row's initial selection is derived from which of
      archive/<folder>/{submitted,sketches,songs}/ its file currently sits
      in (manusSubmissionIsSelected()) — there's no separate persisted
      selected flag, the folder itself is the record. A selected count
      replaces the old "(total)" in each column's header. Aktfordeling/Rollefordeling/
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
      no CSS attached; Rollefordeling and Manus both assign a scene's cast/
      script by opening an overlay from a scene *button* (Øveplan-style —
      openRoleSceneModal()/openScriptSceneModal(), ROLE_CATEGORIES/
      classifyRoleCode/classifyOrKeep duplicated from import.js — manus.html
      doesn't load it), and both edit their content as raw LaTeX text rather
      than a structured form: Rollefordeling's overlay is a read-only roles
      summary (renderRoleSummaryList(), shared by both tabs) over a textarea
      seeded from formatRolesText(row.cast) — editing is entirely textual
      (the scene's \role{<code>}[<name>] <description> lines) until
      "Opdater roller" is clicked, which re-parses the textarea
      (parseRolesText()) back into row.cast, classifying each roleCode via
      classifyOrKeep() for the (no-longer-manually-editable) category; Manus
      reuses the same pattern for the scene's actual script body
      (row.scriptBody) — live-bound there, no separate save step, since it's
      the only field in that overlay. Both row.scriptBody and row.cast
      auto-import once from an already-uploaded .tex, fetched straight from
      the public repo (manusImportFromTex(), triggered from either tab's
      render loop, for every row shown — not just freshly-placed ones);
      Stjerneark sets a 0-3 priority per scene, splitting a
      dance-combined scene into two independent rows exactly like
      Øveplan does (splitDanceScene()/applyDanceSplits-style helpers
      duplicated from schedule.js). One shared "Gem" (manusSaveMain())
      saves everything: first a silent manuscripts_sync_selection call
      reconciles every non-graduated pool submission's archive folder to
      match its current Vælg-scener selection (selected → .../sketches/
      or .../songs/ by type; deselected → .../submitted/ — folder
      hardcoded server-side in data/config.json's currentProductionFolder
      for now, not read or shown client-side), then the existing
      boss-level `manus` resource save (siteSaveResource('manus',
      {scenes, cast})) runs as before. No separate confirm step — toggling
      a row in Vælg scener only changes local draft state until Gem is
      clicked, and the reconciliation re-runs on every Gem, in both
      directions, so a later deselect moves a submission's files straight
      back to submitted/.

   DOM is built via createElement/textContent only — never innerHTML.
   ========================================================= */

'use strict';

const MANUS_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MANUS_TYPES = ['sang', 'sketch'];
const MANUS_TYPE_COLUMN_LABEL = { sketch: 'Sketches', sang: 'Sange' };

// Public-repo raw base for the .tex auto-import below (see
// manusImportFromTex()) — the repo has no auth needs for a read of its own
// public content, so a plain fetch() needs no server round-trip.
const MANUS_TEX_RAW_BASE = 'https://raw.githubusercontent.com/carljarner/matrevy/main/';

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

// Each pool column is a toggle section — open by default for a plain
// revyst visitor (who has nothing else on the page to look at), closed by
// default for boss/admin (who land on a much longer page, Main Manus View
// included, and don't need the raw pool expanded every time).
function renderColumn(type) {
  const section = document.createElement('section');
  section.className = 'card manus-column';

  const items = getEffectiveManuscripts()
    .filter(s => s.type === type)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));

  let expanded = !siteHasLevel('boss');

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

// A pool submission's file currently sitting under archive/<folder>/sketches/
// or .../songs/ means a previous Gem already reconciled it as "selected";
// anything else (archive/<folder>/submitted/, or a not-yet-migrated legacy
// manus/<type>/ path) means it isn't. There is no separate persisted
// `selected` boolean anymore — the folder a file currently sits in on the
// server IS the persistent record (see manuscripts_sync_selection on the
// server, which moves a file to match this exact rule on every Gem click).
const MANUS_SELECTED_PATH_RE = /^archive\/[^/]+\/(sketches|songs)\//;
function manusSubmissionIsSelected(sub) {
  return MANUS_SELECTED_PATH_RE.test(sub.pdfPath || '');
}

// Seeds the draft from the CURRENT production (existing scenes keep all
// their fields — cast, priority, etc. — untouched, just re-shaped into a row)
// plus every pool submission not already referenced by an existing scene's
// sourcePdf. A pool row's `selected` is seeded from manusSubmissionIsSelected()
// — toggling a row in Vælg scener only changes local draft state; the actual
// file move for every non-graduated submission happens as part of the
// shared Gem click (manusSaveMain → manuscripts_sync_selection), not via a
// separate confirm step, and runs as a full reconciliation every time.
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
      cast: (s.cast || []).map(c => ({
        name: c.name,
        roleCode: c.roleCode || '',
        description: c.description || '',
        tags: Array.isArray(c.tags) && c.tags.length ? c.tags.slice() : (c.role ? [classifyOrKeep(c.role, isSong, isDans)] : []),
      })),
      priority: s.priority || 0,
      dansPriority: isDanceSplitCandidate(s) ? (s.dansPriority != null ? s.dansPriority : 0) : null,
      repeat: !!s.repeat,
      dansRepeat: isDanceSplitCandidate(s) ? !!s.dansRepeat : null,
      scriptBody: s.scriptBody || '',
      status: s.status || '',
      melody: s.melody || '',
      writtenBy: s.writtenBy || '',
      sourceProduction: s.sourceProduction || '',
      sourceYear: s.sourceYear || '',
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
      selected: manusSubmissionIsSelected(sub),
      duration: null,
      cast: [],
      priority: 0,
      dansPriority: null,
      repeat: false,
      dansRepeat: null,
      scriptBody: '',
      status: '',
      melody: '',
      writtenBy: '',
      sourceProduction: '',
      sourceYear: '',
    });
  }
  return { acts, rows };
}

function manusDraftRowsForLane(lane, draft = manusDraft) {
  return draft.rows.filter(r => r.lane === lane);
}

function manusRowTitle(row) {
  return row.origin === 'existing' ? row.scene.name : row.submission.title;
}

function manusRowType(row) {
  if (row.origin !== 'existing') return row.submission.type;
  const types = row.scene.types || [];
  return types.find(t => t === 'sketch' || t === 'sang') || types[0] || '';
}

// Unselecting a row that's currently placed in an act also forces it back to
// the pool lane — a row marked for discard can't remain placed.
function manusSetRowSelected(key, selected) {
  const row = manusDraft.rows.find(r => r.key === key);
  if (!row) return;
  row.selected = selected;
  if (!selected && row.lane !== 'pool') row.lane = 'pool';
}

function manusRowIsDans(row) {
  return row.origin === 'existing' && Array.isArray(row.scene.types) && row.scene.types.includes('dans');
}

// A row's .tex source, regardless of origin — the one thing manusMoveRow's
// old, narrower "pool row just got placed" hook and the current tab-wide
// auto-import (see renderManusTextTab()) both need to resolve.
function manusRowTexPath(row) {
  return row.origin === 'existing' ? (row.scene && row.scene.sourceTex) : (row.submission && row.submission.texPath);
}

// Extracts the raw body text between \begin{sketch}/\begin{song} and its
// matching \end{...} — the same environment-scoping idea import.js already
// uses for \begin{roles}, just targeting the actual dialogue/lyrics content
// instead. Used only by the auto-import below.
function extractTexScriptBody(texText) {
  const m = texText.match(/\\begin\{(sketch|song)\}([\s\S]*?)\\end\{\1\}/);
  return m ? m[2].trim() : '';
}

// Extracts the raw inner text of the file's \begin{roles}...\end{roles}
// block (the \role{}[] lines themselves, no wrapper) — this is what
// Rollefordeling's LaTeX textarea shows/edits (see openRoleSceneModal()
// below), the same "store the body, not the wrapper" convention
// extractTexScriptBody() uses for \begin{sketch}/\begin{song}.
function extractTexRolesBlockText(texText) {
  const m = texText.match(/\\begin\{roles\}([\s\S]*?)\\end\{roles\}/);
  return m ? m[1].trim() : '';
}

// Parses every \role{<code>}[<name>] <description> line out of a roles-block
// text (the same text extractTexRolesBlockText() returns, or whatever's
// currently typed into Rollefordeling's textarea) — <name> and the trailing
// description are both optional in real .tex source (an uncast role has no
// bracket). The description capture deliberately allows backslashes
// (`[^\n]*`, not `[^\n\\]*`) since real descriptions often contain inline
// LaTeX like `$\chi$` — every \role{} line in this dialect starts on its own
// line, so stopping only at the newline is enough to not run into the next
// \role{}.
function parseRolesText(rolesText) {
  const results = [];
  const re = /\\role\{([^}]*)\}(?:\[([^\]]*)\])?([^\n]*)/g;
  let m;
  while ((m = re.exec(rolesText))) {
    const roleCode = m[1].trim();
    if (!roleCode) continue;
    results.push({ roleCode, name: (m[2] || '').trim(), description: (m[3] || '').trim() });
  }
  return results;
}

function extractTexRoles(texText) {
  return parseRolesText(extractTexRolesBlockText(texText));
}

// The inverse of parseRolesText() — reconstructs \role{}[] lines from
// row.cast, used to seed Rollefordeling's textarea with whatever's currently
// stored (from a prior "Opdater roller" click, or an auto-import) each time
// the modal opens.
function formatRolesText(cast) {
  return cast
    .filter(c => c.name && c.name.trim())
    .map(c => {
      const code = (c.roleCode || '').trim();
      const desc = (c.description || '').trim();
      return `\\role{${code}}[${c.name.trim()}]${desc ? ' ' + desc : ''}`;
    })
    .join('\n');
}

// Manus tab's read-only "which codes exist" reference (see
// openScriptSceneModal()) — every entry always has a real roleCode by this
// point (parseRolesText()/extractTexRoles() never produce a codeless entry),
// so this is a plain listing, no fallback-label scheme needed.
function renderRoleSummaryList(row, headingText) {
  const wrap = document.createElement('div');
  wrap.className = 'manus-role-tags-summary';
  wrap.setAttribute('data-manus-role-summary', row.key);

  const entries = row.cast.filter(c => c.name.trim());
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen roller endnu.';
    wrap.appendChild(empty);
    return wrap;
  }

  const heading = document.createElement('div');
  heading.className = 'manus-script-roles-heading';
  heading.textContent = headingText;
  wrap.appendChild(heading);

  // Same one-line-per-role rhythm as Rollefordeling's renderRoleTagLine()
  // (reusing its row/codename styling), but showing description instead of
  // (editable) tags — description is the useful context here for actually
  // writing the scene, tags aren't.
  for (const c of entries) {
    const line = document.createElement('div');
    line.className = 'manus-role-tag-row';

    const codeName = document.createElement('span');
    codeName.className = 'manus-role-tag-codename';
    const code = document.createElement('code');
    code.textContent = c.roleCode || '?';
    codeName.appendChild(code);
    codeName.appendChild(document.createTextNode(` : ${c.name}`));
    line.appendChild(codeName);

    if (c.description) {
      const desc = document.createElement('span');
      desc.className = 'manus-role-tag-description';
      desc.textContent = c.description;
      line.appendChild(desc);
    }

    wrap.appendChild(line);
  }
  return wrap;
}

// ── Rollefordeling's editable roles+tags summary ────────────────
// One role per line: "<code> : <name>" on the left, its type tags (chips,
// ROLE_CATEGORIES values) flowing on the right with a "+" to add another —
// deliberately no description here (that stays in the LaTeX textarea below,
// where it's actually edited). Unlike code/name (only ever changed by
// re-parsing the textarea via "Opdater roller"), tags are edited directly,
// live, right here — mutating the same row.cast[i] object in place, so nothing
// else needs to be told about the change.
function renderRoleTagLine(entry) {
  const line = document.createElement('div');
  line.className = 'manus-role-tag-row';

  const codeName = document.createElement('span');
  codeName.className = 'manus-role-tag-codename';
  const code = document.createElement('code');
  code.textContent = entry.roleCode || '?';
  codeName.appendChild(code);
  codeName.appendChild(document.createTextNode(` : ${entry.name}`));
  line.appendChild(codeName);

  const tagsWrap = document.createElement('span');
  tagsWrap.className = 'manus-role-tags';
  line.appendChild(tagsWrap);

  function renderTags() {
    tagsWrap.textContent = '';
    entry.tags = entry.tags || [];
    for (const tag of entry.tags) {
      const chip = document.createElement('span');
      chip.className = 'manus-role-tag-chip';
      chip.textContent = tag;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'manus-role-tag-remove';
      rm.textContent = '×';
      rm.setAttribute('aria-label', `Fjern ${tag}`);
      rm.addEventListener('click', () => {
        entry.tags = entry.tags.filter(t => t !== tag);
        renderTags();
      });
      chip.appendChild(rm);
      tagsWrap.appendChild(chip);
    }
    const remaining = ROLE_CATEGORIES.filter(cat => !entry.tags.includes(cat));
    if (remaining.length) {
      const addBtn = document.createElement('button');
      addBtn.type = 'button';
      addBtn.className = 'manus-role-tag-add';
      addBtn.textContent = '+';
      addBtn.title = 'Tilføj type';
      // Same themed popup site-utils.js's other <select>-replacement fields
      // use (siteOpenDropdownPicker — see "Site-wide field pickers" in
      // CLAUDE.md): a plain option list whose rows already hover in the warm
      // accent (.site-list-row, style.css), opens straight from the click,
      // no intermediate native <select> to click into.
      addBtn.addEventListener('click', () => {
        siteOpenDropdownPicker(addBtn, remaining.map(cat => ({ value: cat, label: cat })), null, (value) => {
          entry.tags.push(value);
          renderTags();
        });
      });
      tagsWrap.appendChild(addBtn);
    }
  }
  renderTags();

  return line;
}

function renderRoleTagsList(row) {
  const wrap = document.createElement('div');
  wrap.className = 'manus-role-tags-summary';
  wrap.setAttribute('data-manus-role-tags', row.key);

  const entries = row.cast.filter(c => c.name.trim());
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen roller endnu.';
    wrap.appendChild(empty);
    return wrap;
  }

  const heading = document.createElement('div');
  heading.className = 'manus-script-roles-heading';
  heading.textContent = 'Roller:';
  wrap.appendChild(heading);

  for (const c of entries) wrap.appendChild(renderRoleTagLine(c));
  return wrap;
}

// Auto-import: any row (existing or pool-origin) with an already-uploaded
// .tex fetches that file's raw content once, straight from the public repo
// (no auth/server round-trip needed), and backfills whichever of
// row.scriptBody (empty text) / row.cast (empty array) is still unset —
// so neither the Manus tab nor Rollefordeling starts blank for material that
// already has a script and/or a roles list. Triggered for every row once,
// from both renderManusTextTab() and renderRollefordelingTab() below (the
// `_scriptImportTried` flag, set unconditionally on the first attempt,
// means only whichever tab is opened first actually fetches — the other
// benefits from the same already-populated row). Fire-and-forget; re-queries
// live DOM by row key rather than closing over it, since neither tab (nor a
// scene's modal) may still be mounted by the time this resolves — see
// openScriptSceneModal()'s data-manus-script-textarea and
// renderRoleSceneButton()'s data-manus-role-badge attributes.
async function manusImportFromTex(row) {
  if (row._scriptImportTried) return;
  row._scriptImportTried = true;
  const texPath = manusRowTexPath(row);
  if (!texPath) return;
  try {
    const res = await fetch(MANUS_TEX_RAW_BASE + texPath);
    if (!res.ok) return;
    const text = await res.text();

    if (!row.scriptBody) {
      const body = extractTexScriptBody(text);
      if (body && !row.scriptBody) {
        row.scriptBody = body;
        const textarea = document.querySelector(`[data-manus-script-textarea="${row.key}"]`);
        if (textarea && !textarea.value) textarea.value = body;
      }
    }

    if (!row.cast.length) {
      const imported = extractTexRoles(text);
      if (imported.length && !row.cast.length) {
        const isSong = manusRowIsSong(row);
        const isDans = manusRowIsDans(row);
        row.cast = imported.map(r => ({
          name: r.name,
          roleCode: r.roleCode,
          description: r.description,
          tags: [classifyOrKeep(r.roleCode, isSong, isDans)],
        }));
        const roleBadge = document.querySelector(`[data-manus-role-badge="${row.key}"]`);
        if (roleBadge) roleBadge.textContent = manusRoleBadgeText(row);
        // Refresh whichever overlay happens to already be open for this row
        // — Manus tab's read-only reference and/or Rollefordeling's
        // editable tags list (only one is normally open at a time, but
        // checking both is cheap and safe).
        const summaryEl = document.querySelector(`[data-manus-role-summary="${row.key}"]`);
        if (summaryEl) summaryEl.replaceWith(renderRoleSummaryList(row, 'Roller:'));
        const tagsEl = document.querySelector(`[data-manus-role-tags="${row.key}"]`);
        if (tagsEl) tagsEl.replaceWith(renderRoleTagsList(row));
        const rolesTextarea = document.querySelector(`[data-manus-role-textarea="${row.key}"]`);
        if (rolesTextarea && !rolesTextarea.value) rolesTextarea.value = formatRolesText(row.cast);
      }
    }
  } catch (e) { /* offline, or not reachable yet — leave scriptBody/cast empty */ }
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
    .filter(c => c.name.trim())
    .map(c => {
      const tags = (c.tags || []).filter(t => t);
      // `role` must always be a string, never omitted — schedule.js's own
      // classifyRoleCode() calls .trim() on it unconditionally, so an
      // undefined role (a role key entirely missing) would throw there.
      const entry = { name: c.name.trim(), role: tags[0] || '' };
      if (c.roleCode && c.roleCode.trim()) entry.roleCode = c.roleCode.trim();
      if (c.description && c.description.trim()) entry.description = c.description.trim();
      if (tags.length) entry.tags = tags;
      return entry;
    });

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
  if (row.scriptBody) scene.scriptBody = row.scriptBody; else delete scene.scriptBody;
  if (row.status) scene.status = row.status; else delete scene.status;
  if (row.melody) scene.melody = row.melody; else delete scene.melody;
  if (row.writtenBy) scene.writtenBy = row.writtenBy; else delete scene.writtenBy;
  if (row.sourceProduction) scene.sourceProduction = row.sourceProduction; else delete scene.sourceProduction;
  if (row.sourceYear) scene.sourceYear = row.sourceYear; else delete scene.sourceYear;
  return scene;
}

// Walks draft.acts, building the nested acts/scenes shape data/scenes.json
// actually uses — the save payload. Takes an explicit draft (defaulting to
// the live manusDraft) so manusSaveMain can rebuild the payload from a
// snapshot taken at click time, after manusDraft itself has moved on to a
// fresh optimistic draft — see manusSaveMain below.
function manusBuildActsPayload(draft = manusDraft) {
  const scenesActs = [];
  for (const act of draft.acts) {
    const rowsInAct = manusDraftRowsForLane(act.code, draft);
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
    .filter(r => manusRowType(r) === type)
    .slice()
    .sort((a, b) => manusRowTitle(a).localeCompare(manusRowTitle(b), 'da'));
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
  title.textContent = manusRowTitle(row);
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
// below edits the scene's \begin{roles} block as raw LaTeX text (a summary
// list + a textarea + an "Opdater roller" button), not a per-field form.
function manusCastCount(row) {
  return row.cast.filter(c => c.name.trim()).length;
}

function manusRoleBadgeText(row) {
  const n = manusCastCount(row);
  return n === 1 ? '1 rolle' : `${n} roller`;
}

// `badge` is the count span on the scene button behind this modal — mutating
// it directly (rather than re-rendering the whole Rollefordeling tab from in
// here) keeps it in sync live without touching a modal that lives in its own
// part of the DOM (document.body, not #manus-tab-rollefordeling), so nothing
// about the modal itself is ever at risk of being torn down mid-edit.
//
// Editing model: a read-only roles summary (renderRoleSummaryList(), shared
// with the Manus tab's own reference list) sits above a plain monospace
// textarea seeded from formatRolesText(row.cast) — the boss edits the
// \role{}[] lines directly as LaTeX, exactly like the Manus tab's scriptBody
// box, rather than through per-field inputs. Nothing is parsed back into
// row.cast until "Opdater roller" is clicked: parseRolesText() re-derives
// row.cast from the textarea's current content (classifying each roleCode
// via classifyOrKeep(), same as auto-import does), then the summary above
// is rebuilt from that fresh row.cast so it always reflects exactly what
// was last saved, not live keystrokes. There's deliberately no per-field
// category override anymore — classification is always auto-derived from
// the roleCode typed in the textarea.
function openRoleSceneModal(row, badge) {
  const { modal, form, actions } = siteOpenModalWithClose(manusRowTitle(row));
  modal.classList.add('manus-role-modal');

  let summaryEl = renderRoleTagsList(row);
  form.appendChild(summaryEl);

  const textarea = document.createElement('textarea');
  textarea.className = 'manus-script-textarea';
  textarea.rows = 12;
  textarea.spellcheck = false;
  textarea.setAttribute('data-manus-role-textarea', row.key);
  textarea.value = formatRolesText(row.cast);
  form.appendChild(siteEditField('Roller (LaTeX)', textarea));

  const updateBtn = document.createElement('button');
  updateBtn.type = 'button';
  updateBtn.className = 'site-pill-btn site-pill-primary';
  updateBtn.textContent = 'Opdater roller';
  updateBtn.addEventListener('click', () => {
    const isSong = manusRowIsSong(row);
    const isDans = manusRowIsDans(row);
    // Tags are edited independently of the LaTeX text (see
    // renderRoleTagLine()), so re-parsing the textarea must carry a
    // roleCode's existing tags forward by matching on that code — otherwise
    // every "Opdater roller" click would silently wipe any tags added since
    // the last parse. A genuinely new roleCode (not seen before) still gets
    // a sensible one-tag default via classifyOrKeep(), same as auto-import.
    const previousTagsByCode = new Map(row.cast.map(c => [c.roleCode, c.tags || []]));
    row.cast = parseRolesText(textarea.value).map(r => {
      const existing = previousTagsByCode.get(r.roleCode);
      const tags = existing && existing.length ? existing.slice() : [classifyOrKeep(r.roleCode, isSong, isDans)];
      return { name: r.name, roleCode: r.roleCode, description: r.description, tags };
    });
    const nextSummary = renderRoleTagsList(row);
    summaryEl.replaceWith(nextSummary);
    summaryEl = nextSummary;
    badge.textContent = manusRoleBadgeText(row);
  });
  actions.appendChild(updateBtn);
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
  badge.setAttribute('data-manus-role-badge', row.key);
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
    for (const row of rowsInAct) {
      body.appendChild(renderRoleSceneButton(row));
      // Fire-and-forget: backfills row.cast from an already-uploaded .tex's
      // \begin{roles} block for every scene shown here — see
      // manusImportFromTex()'s own doc comment (also triggered from
      // renderManusTextTab(), for scriptBody).
      manusImportFromTex(row);
    }
  }));
}

// ── Tab: Manus (script text) ─────────────────────────────────────
// Reuses the same per-act kanban (renderActColumnsGrid) and button-opens-
// overlay pattern as Rollefordeling (openRoleSceneModal/renderRoleSceneButton
// above) — a scene is a button; clicking it opens an overlay with a
// read-only "Roller" reference list (renderRoleSummaryList(), which
// \says{}/\sings{} labels exist) followed by a plain monospace textarea for
// the scene's actual LaTeX body (row.scriptBody — everything that goes
// between \begin{sketch}/\begin{song} and \end{...} in the .tex
// scripts/generate-pdfs.js builds). That's the only editable field here —
// status/melody/writtenBy/sourceProduction/sourceYear were tried and cut for
// being too much to fill in per scene; scenes.json/generate-pdfs.js still
// support them (safe to omit), just nothing in this UI sets them anymore.
// The textarea mutates the row directly, no draft rebuild — same as the
// cast editor above.
function manusRowIsSong(row) {
  return manusRowType(row) === 'sang';
}

function openScriptSceneModal(row) {
  const { modal, form } = siteOpenModalWithClose(manusRowTitle(row));
  modal.classList.add('manus-script-modal');

  form.appendChild(renderRoleSummaryList(row, 'Roller:'));

  const textarea = document.createElement('textarea');
  textarea.className = 'manus-script-textarea';
  textarea.rows = 20;
  textarea.spellcheck = false;
  textarea.setAttribute('data-manus-script-textarea', row.key);
  textarea.value = row.scriptBody || '';
  textarea.addEventListener('input', () => { row.scriptBody = textarea.value; });
  form.appendChild(siteEditField('Manus (LaTeX)', textarea));
}

function renderScriptSceneButton(row) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'manus-role-scene-btn';

  const title = document.createElement('span');
  title.className = 'manus-akt-row-title';
  title.textContent = manusRowTitle(row);
  btn.appendChild(title);

  btn.addEventListener('click', () => openScriptSceneModal(row));
  return btn;
}

function renderManusTextTab() {
  const mount = document.getElementById('manus-tab-manus');
  mount.textContent = '';

  const anyPlaced = manusDraft.acts.some(act => manusDraftRowsForLane(act.code).length);
  if (!anyPlaced) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Placér scener i Aktfordeling, før du skriver manus.';
    mount.appendChild(empty);
    return;
  }

  mount.appendChild(renderActColumnsGrid((body, act, rowsInAct) => {
    for (const row of rowsInAct) {
      body.appendChild(renderScriptSceneButton(row));
      // Fire-and-forget: backfills row.scriptBody/row.cast from any
      // already-uploaded .tex for every scene shown here, not just
      // freshly-placed ones — see manusImportFromTex()'s own doc comment
      // above (also triggered from renderRollefordelingTab(), for cast).
      manusImportFromTex(row);
    }
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
  { key: 'manus', label: 'Manus', render: renderManusTextTab },
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

// Patches getEffectiveManuscripts()'s shadow array with the server-confirmed
// pdfPath/texPath returned by manuscripts_sync_selection — this is a real,
// already-happened server-side change (the sync call moved the files),
// independent of whether the scenes.json save that follows it succeeds, so
// it's never rolled back (see manusSaveMain below).
function manusApplySyncResults(results) {
  if (!results.length) return;
  const byId = new Map(results.map(r => [r.id, r]));
  const updated = getEffectiveManuscripts().map(s =>
    byId.has(s.id) ? { ...s, pdfPath: byId.get(s.id).pdfPath, texPath: byId.get(s.id).texPath } : s
  );
  manuscriptsOverride = updated;
  siteSaveOverride('manuscripts', manuscriptsOverride);
}

// Same idea, but patches an explicit rows array (a manusSaveMain draft
// snapshot, not necessarily the live manusDraft — see manusSaveMain) so the
// final save payload's sourcePdf/sourceTex reflect the post-move path.
function manusApplySyncResultsToRows(rows, results) {
  if (!results.length) return;
  const byId = new Map(results.map(r => [r.id, r]));
  for (const row of rows) {
    if (row.origin === 'pool' && byId.has(row.submission.id)) {
      row.submission = { ...row.submission, ...byId.get(row.submission.id) };
    }
  }
}

// Extends the existing cast roster with any new name typed in
// Rollefordeling — needed since, unlike the old Aktfordeling, this flow
// actually edits cast (mirrors import.js's applyImport()).
function manusBuildCastRoster(scenesActs) {
  const castRoster = getEffectiveCastData().map(c => ({ name: c.name, index: c.index }));
  const castNameSet = new Set(castRoster.map(c => c.name));
  for (const act of scenesActs) {
    for (const scene of act.scenes) {
      for (const c of scene.cast) {
        if (!castNameSet.has(c.name)) {
          castNameSet.add(c.name);
          castRoster.push({ name: c.name, index: castRoster.length });
        }
      }
    }
  }
  castRoster.forEach((c, i) => c.index = i);
  return castRoster;
}

// Optimistic save, mirroring posts.js's togglePinned: assume success and
// update the page immediately (toast + re-render), then do the actual
// network round-trip(s) in the background, rolling back only if something
// genuinely fails — the same pattern the rest of the site already uses for
// single-click writes, instead of disabling the UI and blocking on two
// sequential awaited requests (sync then save) the way this used to.
// Trade-off: any further edits made in the few seconds while the background
// save is in flight are lost if that save then fails and rolls back to the
// pre-click snapshot — accepted, same as elsewhere on the site.
// renderAll() (called both optimistically and on rollback, below) replaces
// #manus-main-view-actions' children wholesale each time, including the
// error div — so a reference to that div captured before any render is
// stale by the time an awaited call resolves. Always re-query the live one
// right before writing to it, and always write *after* the render that
// would otherwise wipe it back to empty.
function manusMainViewErrorEl() {
  return document.querySelector('#manus-main-view-actions .manus-main-view-error');
}

async function manusSaveMain() {
  const startError = manusMainViewErrorEl();
  if (startError) startError.textContent = '';

  const draftSnapshot = manusDraft;
  const scenesActs = manusBuildActsPayload(draftSnapshot);
  const castRoster = manusBuildCastRoster(scenesActs);
  const previousManusOverride = manusSavedOverride;

  setManusSavedOverride({ scenes: manusFlattenActs(scenesActs), cast: castRoster });
  manusDraft = null; // forces a fresh manusInitDraft() next render
  siteShowToast('Manus gemt');
  renderAll();

  // Reconcile every non-graduated pool submission's archive location against
  // its current selected state, as part of this same Gem click — silent, no
  // separate confirm step (replaces the old "Bekræft fravalg" flow). Runs on
  // every save, in both directions, so a submission selected then later
  // deselected moves itself straight back to "submitted" on the next Gem.
  const selections = draftSnapshot.rows
    .filter(r => r.origin === 'pool')
    .map(r => ({ id: r.submission.id, selected: r.selected === true }));

  let finalScenesActs = scenesActs;
  if (selections.length) {
    const syncResult = await manusApi('manuscripts_sync_selection', { selections });
    if (!syncResult.ok) {
      setManusSavedOverride(previousManusOverride);
      manusDraft = draftSnapshot;
      renderAll();
      const errEl = manusMainViewErrorEl();
      if (errEl) errEl.textContent = syncResult.message;
      return;
    }
    // A real, already-happened server-side change (moved files) — kept
    // regardless of whether the scenes.json save below succeeds.
    manusApplySyncResults(syncResult.data.results || []);
    manusApplySyncResultsToRows(draftSnapshot.rows, syncResult.data.results || []);
    finalScenesActs = manusBuildActsPayload(draftSnapshot);
  }

  const result = await siteSaveResource('manus', { scenes: finalScenesActs, cast: castRoster });
  if (!result.ok) {
    setManusSavedOverride(previousManusOverride);
    manusDraft = draftSnapshot;
    renderAll();
    const errEl = manusMainViewErrorEl();
    if (errEl) errEl.textContent = result.message;
    return;
  }
  // Silently correct the shadow with the sync-corrected sourcePdf/sourceTex
  // now that it's known — invisible to the user, just keeps future
  // "graduated submission" detection (manusSubmissionIsSelected) accurate.
  if (finalScenesActs !== scenesActs) {
    setManusSavedOverride({ scenes: manusFlattenActs(finalScenesActs), cast: castRoster });
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
  saveBtn.addEventListener('click', () => manusSaveMain());
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
// Its default open/closed state can't be baked into manus.html's static
// markup (the level isn't known until site.js reads localStorage), so it's
// set here instead — same open-for-revyst/closed-for-boss split as the pool
// columns above (renderColumn()).
function wireManusGuideToggle() {
  const header = document.getElementById('manus-guide-header');
  const body = document.getElementById('manus-guide-text');
  const expanded = !siteHasLevel('boss');
  header.setAttribute('aria-expanded', String(expanded));
  body.style.display = expanded ? '' : 'none';
  header.addEventListener('click', () => {
    const nowExpanded = header.getAttribute('aria-expanded') !== 'false';
    header.setAttribute('aria-expanded', String(!nowExpanded));
    body.style.display = nowExpanded ? 'none' : '';
  });
}

function renderAll() {
  renderColumns();
  renderBottomActions();
  renderMainManusView();
  manusStartPendingPoll();
}

document.addEventListener('DOMContentLoaded', () => {
  wireManusGuideToggle();
  renderAll();
});
