/* =========================================================
   Matematikrevyen – Manus page (manus.html)

   Two parts:

   1. Upload pool (data/manuscripts.json, embedded as MANUSCRIPTS_DATA):
      any revyst+ can submit a sketch/song (title/sender/.pdf/.tex),
      shown as two alphabetical columns, each a toggle section, open by
      default (nothing else on the page for a plain revyst visitor to look
      at); same split applies to the Manus Guide box. Revyst-level visitors
      can remove nothing; boss/admin can, via a small ✕ — except boss/admin
      never actually see this block at all: renderPoolLayoutVisibility()
      hides `.manus-layout` (pool columns + guide box) outright at that
      level, since Main Manus View's own Vælg scener tab already lists every
      pool submission with a working PDF link (see part 2 below) and the
      raw pool/guide add nothing on top of that. Modeled directly on
      posts.js's create-post flow — manusApi()/manusResolvePassword() mirror
      postsApi()/postsResolvePassword() since posts_create-style
      append-only actions need an ANY-level authenticated call, not
      just boss/admin (siteSaveResource only trusts boss/admin logins).

   2. Main Manus View (boss/admin only): a tabbed section below the pool
      — Vælg scener / Aktfordeling / Rollefordeling / Manus / Stjerneark,
      styled as folder tabs filling the section's top row evenly — all five
      sharing one flat draft-state row list (manusDraft, built by
      manusInitDraft() from the CURRENT data/scenes.json + not-yet-used
      pool submissions). Vælg scener shows two read-only columns
      (Sketches/Sange, every pool submission plus every already-placed
      scene of that type) — each row's title opens that scene's PDF in a
      new tab (manusRowPdfPath(), same link the upload pool's own rows use;
      a manual bandsang/video row has no PDF behind it and stays plain
      text) — with a "Vælg scener" button opening openSelectScenesOverlay()
      — the actual click-to-select rows (no
      checkbox — amber highlight, not a blue checked box) live only inside
      that overlay, toggling a local `pending` map rather than the row
      itself, so nothing behind the overlay (the tab's own highlighting,
      Aktfordeling's "Ikke placeret" pool) changes until the overlay's own
      "Gem" commits the whole batch at once and closes it — closing without
      Gem (X/Escape) discards every change. A pool row's initial selection
      is derived from which of archive/<folder>/{submitted,sketches,songs}/
      its file currently sits in (manusSubmissionIsSelected()) — there's no
      separate persisted selected flag, the folder itself is the record. A
      selected count replaces the old "(total)" in each column's header.
      Aktfordeling/Rollefordeling/
      Manus/Stjerneark all share one act-columns grid (renderActColumnsGrid(),
      N columns = manusDraft.acts.length, 4 for the fixed skeleton, one row —
      Stjerneark alone passes an explicit 2-column override so its wider
      rows wrap Akt1/Akt2 onto a first row and Akt3/Ekstranumre onto a
      second) —
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
      {scenes, cast})) runs as before. This is a second, separate commit
      point from the Vælg scener overlay's own local "Gem" above — that one
      only ever updates manusDraft in memory; this one is what actually
      moves files on the server and persists everything to git, and the
      folder reconciliation re-runs on every click of it, in both
      directions, so a later deselect moves a submission's files straight
      back to submitted/ even if it was already committed locally once.

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

// Checked against the full `tags` array, not just `role` (which only ever
// stores tags[0] — see manusRowScene() below), so a cast member tagged both
// Instruktør and Koreograf is still detected regardless of tag order. Falls
// back to classifying `role` itself for raw script codes with no tags yet.
function isDanceCastRole(c) {
  if (Array.isArray(c.tags) && c.tags.length) {
    return c.tags.includes('Dans') || c.tags.includes('Koreograf');
  }
  const r = (c.role || '').trim();
  if (r === 'Dans' || r === 'Koreograf') return true;
  const code = r.toUpperCase();
  return code.includes('Y') || code.includes('D');
}

// A scene is a dance-split candidate if any cast member is dance-classified
// (Dans or Koreograf, per isDanceCastRole above — so a scene with only
// credited dancers and no separate choreographer still qualifies) rather
// than checking scene.types for 'dans', since nothing in this file's own
// save path (manusRowScene()) ever adds 'dans' to a scene's types.
function isDanceSplitCandidate(scene) {
  return (scene.cast || []).some(isDanceCastRole);
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
    (isDanceCastRole(c) ? danceCast : mainCast).push(c);
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
  'Ups, forkert vej...',
  'Vente vente...',
  'Hvad har du lavet i dag?...',
  'God sketch!...',
];
const MANUS_PENDING_MESSAGE_INTERVAL_MS = 10000;

// Deterministic per-step pseudo-random pick (classic sine hash) so the
// message stays stable across re-renders within the same 10s window but
// still looks random step to step, with no per-row timer needed.
function manusPendingMessage(item) {
  const startedAt = item.createdAt ? new Date(item.createdAt).getTime() : Date.now();
  const step = Math.floor((Date.now() - startedAt) / MANUS_PENDING_MESSAGE_INTERVAL_MS);
  const rand = Math.sin(step * 12.9898) * 43758.5453;
  const idx = Math.floor((rand - Math.floor(rand)) * MANUS_PENDING_MESSAGES.length);
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
function createManusTypeToggle(options = [{ value: 'sketch', label: 'Sketch' }, { value: 'sang', label: 'Sang' }]) {
  const wrap = document.createElement('div');
  wrap.className = 'manus-type-toggle';
  let selected = null;
  const boxes = {};
  for (const opt of options) {
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

// "Gemt"/"Ikke gemt" tracking (mirrors Budget's markSheetDirty/beforeunload
// pattern) — deliberately no autosave, just a passive comparison against a
// snapshot taken whenever manusDraft last had nothing unsaved (see
// manusInitDraft). A polling comparison, not a dirty flag set at every
// mutation site, since several edit paths (the Manus tab's scriptBody
// textarea, Stjerneark's priority circles) deliberately mutate manusDraft
// without re-rendering, to avoid disrupting typing/UI state — a flag set
// only from render-triggered call sites would miss those.
let manusLastSavedSnapshot = null;

// Keys prefixed `_` are internal bookkeeping (e.g. row._scriptImportTried,
// set the moment a row's tab is first opened, regardless of whether the
// fetch it guards finds anything new) — never part of the save payload, so
// they must not affect the dirty diff below.
function manusSerializeDraft(draft) {
  return JSON.stringify(draft, (key, value) => (key.startsWith('_') ? undefined : value));
}

function manusIsDirty() {
  return !!manusDraft && manusSerializeDraft(manusDraft) !== manusLastSavedSnapshot;
}

// manusImportFromTex() below backfills a handful of fields on a row purely
// by re-deriving them from that row's own already-uploaded .tex — content
// that, unlike a real edit, is fully reproducible on the next page load, so
// it shouldn't itself demand a save. Rather than excluding those fields from
// the diff outright (they're real, savable content once a genuine edit
// touches them), fold the just-imported values into the baseline for this
// one row so the passive backfill doesn't look like unsaved work, while any
// real edit made on top of it still correctly diverges from that baseline.
function manusAbsorbImportIntoBaseline(row, fields) {
  if (!manusLastSavedSnapshot) return;
  try {
    const baseline = JSON.parse(manusLastSavedSnapshot);
    const baseRow = (baseline.rows || []).find(r => r.key === row.key);
    if (!baseRow) return;
    for (const f of fields) baseRow[f] = row[f];
    manusLastSavedSnapshot = manusSerializeDraft(baseline);
  } catch (e) { /* malformed/stale snapshot — leave dirty as the safe fallback */ }
}

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
      appliedSelected: true,
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
      appliedSelected: manusSubmissionIsSelected(sub),
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
  const draft = { acts, rows };
  // Baseline for the "Gemt"/"Ikke gemt" indicator (see manusIsDirty below):
  // this function only ever runs at page load or right after a successful
  // Gem resets manusDraft to null (forcing a fresh one built from the
  // just-saved data) — both moments genuinely have nothing unsaved yet, so
  // snapshotting here, in one place, correctly re-baselines after either
  // without needing to touch manusSaveMain's own success/failure branches.
  manusLastSavedSnapshot = manusSerializeDraft(draft);
  return draft;
}

function manusDraftRowsForLane(lane, draft = manusDraft) {
  return draft.rows.filter(r => r.lane === lane);
}

// row.titleOverride (set by the Manus tab's title/author/melody header field
// — see openScriptSceneModal below) always wins once present, regardless of
// origin: it's how that field's \title{} line actually renames a scene, a
// pool submission, or a manual row alike.
function manusRowTitle(row) {
  if (row.titleOverride) return row.titleOverride;
  if (row.origin === 'manual') return row.manualName;
  return row.origin === 'existing' ? row.scene.name : row.submission.title;
}

function manusRowType(row) {
  if (row.origin === 'manual') return row.manualType;
  if (row.origin !== 'existing') return row.submission.type;
  const types = row.scene.types || [];
  return types.find(t => t === 'sketch' || t === 'sang') || types[0] || '';
}

// A manual row (bandsang/video added by hand, no upload behind it) has no
// PDF. Otherwise mirrors renderPdfRow's link source in the upload pool.
function manusRowPdfPath(row) {
  if (row.origin === 'existing') return row.scene.sourcePdf || null;
  if (row.origin === 'pool') return row.submission.pdfPath || null;
  return null;
}

// Only updates `selected` itself, never `lane` — called only from the Vælg
// scener overlay's own Gem handler (openSelectScenesOverlay), once per row in
// its staged batch. The lane/appliedSelected reconciliation (pool <-> act, in
// either direction) is a separate step right after, in that same handler —
// kept split from this function so a bare toggle mid-overlay never risks
// ripping a row out of its act before the batch is actually committed.
function manusSetRowSelected(key, selected) {
  const row = manusDraft.rows.find(r => r.key === key);
  if (!row) return;
  row.selected = selected;
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

// Mirror scripts/generate-pdfs.js's own extractTexAuthor/extractTexMelody
// (same duplicated-table convention as ROLE_CATEGORIES/classifyRoleCode
// above), plus a \title{} counterpart for the Manus tab's header field below.
function extractTexTitle(texText) {
  const m = texText.match(/\\title\{([^}]*)\}/);
  return m ? m[1].trim() : '';
}

function extractTexAuthor(texText) {
  const m = texText.match(/\\author\{([^}]*)\}/);
  return m ? m[1].trim() : '';
}

function extractTexMelody(texText) {
  const m = texText.match(/\\melody\{([^}]*)\}/);
  return m ? m[1].trim() : '';
}

// \eta{} holds the scene's running time, but freely as hand-typed prose
// ("$3$ minutter", "$15$ sekunder", "$1$ minut og $46$ sekunder",
// "$2:56$ minutter", "$3-4$ minutter", "?", "Ved ikke", ...) rather than a
// clean number — parseEtaDurationMinutes() covers every distinct form found
// across the real archive .tex files, rounding to the 0.5-minute step the
// duration input already uses, and falling back to 0 when nothing parses.
function extractTexDuration(texText) {
  const m = texText.match(/\\eta\{([^}]*)\}/);
  return parseEtaDurationMinutes(m ? m[1] : '');
}

function parseEtaDurationMinutes(raw) {
  const s = (raw || '').replace(/\$/g, '').replace(/(\d),(\d)/g, '$1.$2');
  let minutes = null;
  let m;
  if ((m = s.match(/(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)/))) {
    minutes = Number(m[1]) + Number(m[2]) / 60; // mm:ss, e.g. "2:56 minutter"
  } else if ((m = s.match(/(\d+(?:\.\d+)?)\s*-\s*(\d+(?:\.\d+)?)/))) {
    minutes = (Number(m[1]) + Number(m[2])) / 2; // range, e.g. "3-4 minutter" -> average
  } else if ((m = s.match(/(\d+(?:\.\d+)?)\s*minut(?:ter)?\s*(?:og\s*)?(\d+(?:\.\d+)?)\s*sek/i))) {
    minutes = Number(m[1]) + Number(m[2]) / 60; // compound, e.g. "1 minut og 46 sekunder"
  } else if (/sek/i.test(s) && !/minut/i.test(s) && (m = s.match(/(\d+(?:\.\d+)?)\s*sek/i))) {
    minutes = Number(m[1]) / 60; // seconds-only, e.g. "15 sekunder"
  } else if ((m = s.match(/(\d+(?:\.\d+)?)/))) {
    minutes = Number(m[1]); // plain minutes, or best-effort digit
  }
  if (minutes == null || Number.isNaN(minutes)) return 0;
  return Math.round(minutes / 0.5) * 0.5;
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

    // Deliberately does NOT backfill titleOverride from the .tex's own
    // \title{} line: unlike scriptBody/cast/writtenBy/melody, a title is
    // never actually missing — manusRowTitle() already falls back to the
    // real row.scene.name/submission.title — so treating "!titleOverride"
    // as "no title yet" would silently overwrite an already-current,
    // possibly deliberately-diverged scenes.json title with whatever the
    // original uploaded .tex happens to say, the moment its tab is opened.
    let headerChanged = false;
    if (!row.writtenBy) {
      const author = extractTexAuthor(text);
      if (author) { row.writtenBy = author; headerChanged = true; }
    }
    if (manusRowIsSong(row) && !row.melody) {
      const melody = extractTexMelody(text);
      if (melody) { row.melody = melody; headerChanged = true; }
    }
    if (headerChanged) {
      const headerEl = document.querySelector(`[data-manus-header-textarea="${row.key}"]`);
      if (headerEl) headerEl.value = manusBuildHeaderText(row);
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

    if (row.duration == null) {
      const mins = extractTexDuration(text);
      if (row.duration == null) {
        row.duration = mins;
        const durationInput = document.querySelector(`[data-manus-select-duration="${row.key}"]`);
        if (durationInput && durationInput.value === '') durationInput.value = String(mins);
      }
    }

    manusAbsorbImportIntoBaseline(row, ['scriptBody', 'writtenBy', 'melody', 'cast', 'duration']);
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
  } else if (row.origin === 'manual') {
    // A Bandsang/Video scene added directly here (see the Aktfordeling "+
    // Tilføj scene" button) — never came from an upload, so no cast/roles
    // and not schedulable in Øveplan; it only exists to be part of the
    // generated Aktoversigt/Manuskript output.
    scene = {
      id,
      number,
      name: row.manualName,
      types: [row.manualType],
      schedulable: false,
      cast,
    };
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
  // The Manus tab's header field (see manusApplyHeaderText) can rename a
  // scene/submission/manual row alike via its \title{} line — applied last
  // so it always wins over whichever origin branch above seeded scene.name.
  if (row.titleOverride) scene.name = row.titleOverride;
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

// The inverse of manusFlattenActs, for regenerating the nested acts payload
// straight from the currently-saved (not draft) data — used by
// manusRegeneratePdfs(), which has no draft to build from since it isn't
// editing anything, just re-triggering the PDF pipeline against whatever is
// already saved. A scene's act code is recovered from its own id (format
// "<act>-<number>", e.g. "1-3"/"E-2" — the same convention manusInitDraft's
// row.lane already relies on), and manusBuildActSkeleton keeps the fixed
// Akt 1/2/3/Ekstranumre ordering consistent with every other act listing.
function manusCurrentActsPayload() {
  const flatScenes = getEffectiveScenesData();
  const skeleton = manusBuildActSkeleton(flatScenes);
  return skeleton.map(({ code, label }) => {
    const scenes = flatScenes
      .filter((s) => String(s.id).split('-')[0] === code)
      .map(({ actLabel, ...scene }) => scene)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    return { act: code, label, scenes };
  });
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

  return section;
}

// Title + duration only. Selection itself is no longer toggled by clicking
// a row here — that moved into the "Vælg scener" overlay (openSelectScenesOverlay)
// so a stray click on this list can't silently flip whether a scene is in the
// revy. Pass { interactive: true } to get the overlay's click/Enter/Space
// toggle behaviour back (used only inside that overlay) — the overlay drives
// `selected`/`onToggle` itself off its own local staging map rather than
// `row.selected` directly, so a toggle in there never touches the real row
// (and therefore never affects the tab/Aktfordeling behind it) until its own
// Gem commits the whole batch at once. The non-interactive (background tab)
// call site below omits both and falls back to the row's real committed state.
function renderSelectRow(row, { interactive = false, selected = row.selected === true, onToggle = null } = {}) {
  const el = document.createElement('div');
  el.className = 'manus-select-row' + (selected ? ' manus-select-row-selected' : '');

  // Outside the selection overlay this row is just a read-only listing (like
  // the upload pool's own columns — see renderPdfRow), so the title opens
  // the scene's PDF exactly the same way. Inside the overlay the whole row
  // is itself a select/deselect toggle, so it stays plain text there — a
  // nested link would fight the row's own click handler.
  const pdfPath = !interactive ? manusRowPdfPath(row) : null;
  const title = document.createElement(pdfPath ? 'a' : 'span');
  title.className = 'manus-pdf-title';
  title.textContent = manusRowTitle(row);
  if (pdfPath) {
    title.href = pdfPath;
    title.target = '_blank';
    title.rel = 'noopener noreferrer';
  }
  el.appendChild(title);

  if (interactive) {
    el.setAttribute('role', 'button');
    el.tabIndex = 0;
    el.setAttribute('aria-pressed', String(selected));

    const toggle = () => onToggle(row.key);
    el.addEventListener('click', toggle);
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); }
    });
    return el;
  }

  const durationInput = document.createElement('input');
  durationInput.type = 'number';
  durationInput.min = '0';
  durationInput.step = '0.5';
  durationInput.className = 'manus-select-duration';
  durationInput.placeholder = '–';
  durationInput.value = row.duration != null ? row.duration : '';
  durationInput.dataset.manusSelectDuration = row.key;
  durationInput.addEventListener('click', (e) => e.stopPropagation());
  durationInput.addEventListener('input', () => {
    row.duration = durationInput.value === '' ? null : Number(durationInput.value);
  });
  el.appendChild(durationInput);
  const suffix = document.createElement('span');
  suffix.className = 'manus-akt-duration-suffix';
  suffix.textContent = 'min';
  el.appendChild(suffix);

  return el;
}

// ── "Udvælgelse" control column ─────────────────────────────────
function renderSelectPanelGroup(heading) {
  const group = document.createElement('div');
  group.className = 'manus-select-panel-group';
  const h3 = document.createElement('h3');
  h3.textContent = heading;
  group.appendChild(h3);
  return group;
}

function renderSelectionColumn() {
  const section = document.createElement('section');
  section.className = 'card manus-column';

  const header = document.createElement('div');
  header.className = 'manus-col-header';
  const h2 = document.createElement('h2');
  h2.textContent = 'Udvælgelse';
  header.appendChild(h2);
  section.appendChild(header);

  const voteGroup = renderSelectPanelGroup('Stemmeark');
  const voteBtnRow = document.createElement('div');
  voteBtnRow.className = 'manus-select-panel-btn-row';
  for (const type of MANUS_TYPES) {
    const voteBtn = document.createElement('button');
    voteBtn.type = 'button';
    voteBtn.className = 'site-pill-btn site-pill-warm';
    voteBtn.textContent = MANUS_TYPE_COLUMN_LABEL[type];
    voteBtn.addEventListener('click', () => manusOpenVotingSheet(type));
    voteBtnRow.appendChild(voteBtn);
  }
  voteGroup.appendChild(voteBtnRow);
  section.appendChild(voteGroup);

  const pointGroup = renderSelectPanelGroup('Indtast point');
  const pointBtn = document.createElement('button');
  pointBtn.type = 'button';
  pointBtn.className = 'site-pill-btn site-pill-warm';
  pointBtn.textContent = 'Point';
  pointBtn.disabled = true;
  pointGroup.appendChild(pointBtn);
  section.appendChild(pointGroup);

  const selectGroup = renderSelectPanelGroup('Vælg Scener');
  const selectBtn = document.createElement('button');
  selectBtn.type = 'button';
  selectBtn.className = 'site-pill-btn site-pill-primary';
  selectBtn.textContent = 'Vælg scener';
  selectBtn.addEventListener('click', () => openSelectScenesOverlay());
  selectGroup.appendChild(selectBtn);
  section.appendChild(selectGroup);

  return section;
}

// Selection is staged entirely locally here (`pending`, keyed by row.key —
// seeded from every sang/sketch row's current `selected` when the overlay
// opens) and never written back to the real `manusDraft` rows until "Gem"
// below is clicked: toggling a row only flips its entry in `pending` and
// re-renders the overlay's own lists, so closing via the X/Escape without
// saving silently discards every change with no trace on the row objects —
// the Vælg-scener tab behind the overlay and Aktfordeling's "Ikke placeret"
// pool (which reads `appliedSelected`, not `selected`) are both completely
// unaffected until Gem commits the whole batch at once.
function openSelectScenesOverlay() {
  const { modal, form, actions, close } = siteOpenModalWithClose('Vælg scener');
  modal.classList.add('manus-select-overlay-modal');

  const pending = new Map();
  for (const row of manusDraft.rows) {
    if (MANUS_TYPES.includes(manusRowType(row))) pending.set(row.key, row.selected === true);
  }

  const listsMount = document.createElement('div');
  listsMount.className = 'manus-select-overlay-lists';
  form.appendChild(listsMount);

  function togglePending(key) {
    pending.set(key, !pending.get(key));
    renderOverlayLists();
  }

  // Re-renders just this overlay's own lists off `pending`, not `row.selected`
  // — the underlying manus-tab-select list is untouched until Gem.
  function renderOverlayLists() {
    listsMount.textContent = '';
    for (const type of MANUS_TYPES) {
      const rows = manusDraft.rows
        .filter(r => manusRowType(r) === type)
        .slice()
        .sort((a, b) => manusRowTitle(a).localeCompare(manusRowTitle(b), 'da'));

      const group = document.createElement('div');
      group.className = 'manus-select-overlay-group';
      const h3 = document.createElement('h3');
      h3.textContent = MANUS_TYPE_COLUMN_LABEL[type];
      group.appendChild(h3);

      const list = document.createElement('div');
      list.className = 'manus-col-list';
      if (!rows.length) {
        const empty = document.createElement('p');
        empty.className = 'manus-col-empty';
        empty.textContent = 'Ingen upload endnu.';
        list.appendChild(empty);
      } else {
        for (const row of rows) {
          list.appendChild(renderSelectRow(row, { interactive: true, selected: pending.get(row.key), onToggle: togglePending }));
        }
      }
      group.appendChild(list);
      listsMount.appendChild(group);
    }
  }
  renderOverlayLists();

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'site-pill-btn site-pill-primary';
  saveBtn.textContent = 'Gem';
  saveBtn.addEventListener('click', () => {
    // Commit the whole staged batch at once: flip `selected`, then the same
    // selected → appliedSelected/lane reconciliation manusSaveMain() performs
    // at final-Save time (a deselected row snaps back to the pool lane; see
    // its own comment for why that's deferred rather than immediate on a
    // bare checkbox click) — done here too so Aktfordeling's "Ikke placeret"
    // and the tab's own highlighting both reflect the change right away,
    // without waiting for the page's separate, server-writing Gem.
    for (const [key, sel] of pending) manusSetRowSelected(key, sel);
    for (const row of manusDraft.rows) {
      if (row.selected !== row.appliedSelected) {
        if (!row.selected && row.lane !== 'pool') row.lane = 'pool';
        row.appliedSelected = row.selected;
      }
    }
    close();
    renderSelectTab();
  });
  actions.appendChild(saveBtn);
}

function renderSelectTab() {
  const mount = document.getElementById('manus-tab-select');
  mount.textContent = '';

  const columns = document.createElement('div');
  columns.className = 'manus-select-columns';
  for (const type of MANUS_TYPES) columns.appendChild(renderSelectColumn(type));
  columns.appendChild(renderSelectionColumn());
  mount.appendChild(columns);
}

// Builds one act's header+body block (unstyled position — the caller places
// it into the grid or a stack wrapper, see renderActColumnsGrid below).
function buildActColumn(act, buildColumnBody) {
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

  return col;
}

// ── Shared: one column per act, laid out in a row of N equal columns ──
// (N = manusDraft.acts.length, 4 for the fixed Akt1/2/3/Ekstranumre
// skeleton) — used by Aktfordeling's act row and, unchanged otherwise, by
// Rollefordeling/Manus below so those three tabs read as the same grid.
// Stjerneark alone passes an explicit `columns` override (3) so it wraps —
// that tab's rows are wide (priority circles + repeat toggle alongside the
// title), so four side-by-side columns read as cramped there in a way the
// other tabs' plainer rows don't. Any act beyond the first `columns - 1`
// stacks into that *last* column — for the fixed 4-act skeleton at 3
// columns that means Akt3 and Ekstranumre both land in column 3. That stack
// is its own flex column (`.manus-kanban-col-stack`), not a second CSS grid
// row: a real second grid row would size to the *tallest* column in that
// row (i.e. however long Akt1/Akt2 happen to be), leaving a large gap
// between Akt3's last card and Ekstranumre's header — a flex wrapper sizes
// Ekstranumre flush against Akt3 regardless of its siblings' height.
// buildColumnBody(bodyEl, act, rowsInAct, colEl) fills each column's body;
// whatever it doesn't wire up (drag-and-drop, in Aktfordeling's case) simply
// isn't there for the other tabs. colEl (header+body together) is handed
// through so Aktfordeling can make the *whole* column a drop target, not
// just the body's own strip — see wireLaneDropZone().
function renderActColumnsGrid(buildColumnBody, columns = manusDraft.acts.length) {
  const grid = document.createElement('div');
  grid.className = 'manus-kanban';
  grid.style.gridTemplateColumns = `repeat(${columns}, minmax(220px, 1fr))`;

  const groups = Array.from({ length: columns }, () => []);
  manusDraft.acts.forEach((act, idx) => {
    groups[Math.min(idx, columns - 1)].push(act);
  });

  groups.forEach((group, colIdx) => {
    if (group.length < 2) {
      if (!group.length) return;
      const col = buildActColumn(group[0], buildColumnBody);
      col.style.gridColumn = String(colIdx + 1);
      grid.appendChild(col);
      return;
    }
    const stack = document.createElement('div');
    stack.className = 'manus-kanban-col-stack';
    stack.style.gridColumn = String(colIdx + 1);
    for (const act of group) stack.appendChild(buildActColumn(act, buildColumnBody));
    grid.appendChild(stack);
  });

  return grid;
}

// ── Tab 2: Aktfordeling — act columns in a row, "Ikke placeret" below ──
// Bandsang/Video never come from an uploaded submission (data/manuscripts.json
// is sketch/sang only) — this is the only way to get one into the pipeline at
// all, so it can end up in the generated Aktoversigt/Manuskript output. Lands
// straight in "Ikke placeret" (appliedSelected: true — there's no prior
// placement to protect, unlike a Vælg-scener submission, so no staging delay
// is needed) ready to be dragged into an act like any other row.
function openAddManualSceneModal() {
  const { form, error, actions, close } = siteOpenModalWithClose('Tilføj scene');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  form.appendChild(siteEditField('Titel', nameInput));

  const typeToggle = createManusTypeToggle([
    { value: 'bandsang', label: 'Bandsang' },
    { value: 'video', label: 'Video' },
  ]);
  form.appendChild(siteEditField('Type', typeToggle.element));

  const addBtn = document.createElement('button');
  addBtn.className = 'site-pill-btn site-pill-primary';
  addBtn.textContent = 'Tilføj';
  actions.appendChild(addBtn);

  addBtn.addEventListener('click', () => {
    const manualName = nameInput.value.trim();
    const manualType = typeToggle.value;
    if (!manualType) {
      error.textContent = 'Vælg om det er en bandsang eller en video.';
      return;
    }
    if (!manualName) {
      error.textContent = 'Udfyld en titel.';
      return;
    }
    manusDraft.rows.push({
      key: manusNextKey(),
      origin: 'manual',
      lane: 'pool',
      manualName,
      manualType,
      selected: true,
      appliedSelected: true,
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
    close();
    renderAktfordelingTab();
  });

  nameInput.focus();
}

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
  //
  // Deliberately filters on `appliedSelected`, not the live `selected` —
  // toggling a row inside the Vælg scener overlay must not move anything
  // in/out of Aktfordeling until that overlay's own Gem is clicked (see
  // openSelectScenesOverlay()'s save handler, which reconciles both at once).
  const poolSection = document.createElement('div');
  poolSection.className = 'manus-kanban-pool-section';

  const poolRows = manusDraftRowsForLane('pool').filter(r => r.appliedSelected !== false);
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

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-small';
  addBtn.textContent = '+ Tilføj scene';
  addBtn.addEventListener('click', () => openAddManualSceneModal());
  poolHeader.appendChild(addBtn);

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
// above) — a scene is a button; clicking it opens an overlay with a small
// header textarea (title/author/melody, see below), a read-only "Roller"
// reference list (renderRoleSummaryList(), which \says{}/\sings{} labels
// exist), and a plain monospace textarea for the scene's actual LaTeX body
// (row.scriptBody — everything that goes between \begin{sketch}/\begin{song}
// and \end{...} in the .tex scripts/generate-pdfs.js builds).
// status/sourceProduction/sourceYear were tried and cut for being too much
// to fill in per scene; scenes.json/generate-pdfs.js still support them
// (safe to omit), just nothing in this UI sets them anymore. Both textareas
// mutate the row directly, no draft rebuild — same as the cast editor above.
function manusRowIsSong(row) {
  return manusRowType(row) === 'sang';
}

// The header field's raw LaTeX-line text, built fresh every time the modal
// opens (or the auto-import backfill lands) from the row's current
// title/writtenBy/melody — the same "reconstruct from the row, don't persist
// the textarea's own text" convention Rollefordeling's role textarea uses
// (formatRolesText). \melody{} only appears for a song-typed row.
function manusBuildHeaderText(row) {
  const lines = [
    `\\title{${manusRowTitle(row)}}`,
    `\\author{${row.writtenBy || ''}}`,
  ];
  if (manusRowIsSong(row)) lines.push(`\\melody{${row.melody || ''}}`);
  return lines.join('\n');
}

// Parses the header textarea's current text straight back into the row on
// every keystroke — live-bound, exactly like the scriptBody textarea below
// it, not a separate "Opdater" step. An empty/removed \title{} line is
// ignored (never blanks row.titleOverride, since a scene must keep a name);
// \author{}/\melody{} clear normally when emptied.
function manusApplyHeaderText(row, text) {
  const title = extractTexTitle(text);
  if (title) row.titleOverride = title;
  row.writtenBy = extractTexAuthor(text);
  if (manusRowIsSong(row)) row.melody = extractTexMelody(text);
}

function openScriptSceneModal(row) {
  const { modal, form } = siteOpenModalWithClose(manusRowTitle(row));
  modal.classList.add('manus-script-modal');
  const headingEl = modal.querySelector('h2');

  const headerTextarea = document.createElement('textarea');
  headerTextarea.className = 'manus-script-textarea manus-script-header-textarea';
  headerTextarea.rows = manusRowIsSong(row) ? 3 : 2;
  headerTextarea.spellcheck = false;
  headerTextarea.setAttribute('data-manus-header-textarea', row.key);
  headerTextarea.value = manusBuildHeaderText(row);
  headerTextarea.addEventListener('input', () => {
    manusApplyHeaderText(row, headerTextarea.value);
    // Live-reflect a \title{} edit in the overlay's own heading — every
    // other manusRowTitle() call site (chips, other tabs) only picks it up
    // on the next renderAll(), same as scriptBody edits never live-updating
    // anything outside this textarea.
    if (headingEl) headingEl.textContent = manusRowTitle(row);
  });
  form.appendChild(siteEditField('Titel / forfatter' + (manusRowIsSong(row) ? ' / melodi' : '') + ' (LaTeX)', headerTextarea));

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

// The dance half's own row sits directly under its main half (same `row`,
// same forEach iteration in renderStjerneArkTab below) so repeating the full
// scene name there is redundant — and with a long title, the " (Dans)" suffix
// that used to carry entry.name was the first thing ellipsis truncation ate,
// making the row look identical to its main half. A short, always-visible
// "↳ Dans" badge up front replaces the name entirely for that row instead.
function renderStarRow(row, entry) {
  const isDanceHalf = entry.id.endsWith(DANCE_SPLIT_SUFFIX);
  const el = document.createElement('div');
  el.className = 'manus-akt-row manus-star-row';

  const name = document.createElement('span');
  name.className = 'manus-akt-row-title';
  if (isDanceHalf) {
    name.classList.add('manus-star-dans-label');
    const arrow = document.createElement('span');
    arrow.className = 'manus-star-dans-arrow';
    arrow.textContent = '↳';
    name.appendChild(arrow);
    name.appendChild(document.createTextNode(' Dans'));
  } else {
    name.textContent = entry.name;
  }
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
  }, 3));
}

// ── Tab bar + section chrome ───────────────────────────────────
const MANUS_MAIN_TABS = [
  { key: 'select', label: 'Scener', render: renderSelectTab },
  { key: 'aktfordeling', label: 'Aktfordeling', render: renderAktfordelingTab },
  { key: 'rollefordeling', label: 'Rollefordeling', render: renderRollefordelingTab },
  { key: 'manus', label: 'Manus', render: renderManusTextTab },
  { key: 'stjerneark', label: 'Stjerneark', render: renderStjerneArkTab },
];
const MANUS_ACTIVE_TAB_KEY = 'matrevy-manus-tab';
const manusStoredTab = localStorage.getItem(MANUS_ACTIVE_TAB_KEY);
let manusActiveTab = MANUS_MAIN_TABS.some(t => t.key === manusStoredTab) ? manusStoredTab : 'select';

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
      localStorage.setItem(MANUS_ACTIVE_TAB_KEY, manusActiveTab);
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

  // Defensive no-op in practice: the Vælg scener overlay's own Gem already
  // reconciles selected -> appliedSelected/lane immediately on commit (see
  // openSelectScenesOverlay()), so every row normally arrives here already in
  // sync. Kept as a safety net rather than removed, in case a row's selected/
  // appliedSelected ever drift apart by the time the page's own Gem runs.
  for (const row of draftSnapshot.rows) {
    if (row.selected !== row.appliedSelected) {
      if (!row.selected && row.lane !== 'pool') row.lane = 'pool';
      row.appliedSelected = row.selected;
    }
  }

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

// ── PDF regeneration status (pulse + last-generated badge) ────
// There is no server-side "build finished" signal available to the client —
// the site's GitHub token has no Actions permission to poll workflow status,
// so save_manus() returning ok just means the scenes.json/cast.json commit
// landed, not that generate-pdfs.yml has actually run pdflatex yet. The only
// way to detect real completion is to watch one of the generated files' own
// Last-Modified header (same-origin HEAD request, no CORS issue) for a
// change versus a snapshot taken right before triggering. Manuskript.pdf is
// used as that reference file since it's the last file the build produces
// before the workflow's single end-of-job commit, and every file in that
// commit goes live together. This is plain in-memory state, not synced
// through the server — a page reload mid-poll silently drops back to idle
// (same accepted limitation as manusDraft's own dirty tracking elsewhere in
// this file), and another visitor's tab never sees this tab's pulse.
let manusPdfGenerating = false;
let manusPdfTimestampLoaded = false;
let manusPdfLastGeneratedAt = null; // Date | null
let manusPdfConfirmedAbsent = false; // true only on a genuine 404 — distinct from "couldn't check"
let manusPdfCheckFailed = false; // true when the check itself couldn't run/complete at all

// A genuine 404 (never generated) is reported distinctly from "couldn't
// check" (thrown fetch — e.g. fetch() flatly refuses file:// URLs with "URL
// scheme file is not supported", the same file:// limitation documented at
// the top of this file for the login endpoint, or a transient network
// error): only the 404 case is safe to ever surface as "Endnu ikke
// genereret" — silently mapping a failed check to that same message would
// misreport a file that actually exists. checkFailed gets its own visible
// fallback text below rather than staying blank, so a file:// visitor sees
// an honest "Ukendt" instead of what looks like a missing feature.
async function manusFetchPdfStatus(url) {
  if (!url) return { date: null, confirmedAbsent: false, checkFailed: true };
  try {
    const res = await fetch(url, { method: 'HEAD', cache: 'no-store' });
    if (res.status === 404) return { date: null, confirmedAbsent: true, checkFailed: false };
    if (!res.ok) return { date: null, confirmedAbsent: false, checkFailed: true };
    const header = res.headers.get('last-modified');
    return { date: header ? new Date(header) : null, confirmedAbsent: false, checkFailed: !header };
  } catch (e) {
    return { date: null, confirmedAbsent: false, checkFailed: true };
  }
}

function manusPdfReferenceUrl() {
  const folder = (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
  return folder ? `archive/${folder}/Manuskript.pdf` : null;
}

function manusFormatGeneratedAt(date) {
  const datePart = date.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Copenhagen' });
  const timePart = date.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
  return `Sidst genereret: ${datePart} kl. ${timePart}`;
}

function manusPdfStatusText() {
  if (manusPdfLastGeneratedAt) return manusFormatGeneratedAt(manusPdfLastGeneratedAt);
  if (manusPdfConfirmedAbsent) return 'Endnu ikke genereret';
  if (manusPdfCheckFailed) return 'Sidst genereret: ukendt';
  return ''; // still checking — momentary, resolves within one tick
}

function manusPdfTimestampEl() {
  return document.querySelector('#manus-main-view-actions [data-manus-pdf-timestamp]');
}

// Fetched once per page load (guarded by manusPdfTimestampLoaded), not on
// every re-render — a completed poll updates the cache directly instead of
// triggering another fetch. Fire-and-forget; requeries the badge element by
// its data-attribute marker when it resolves, since a re-render may have
// replaced the node by then (same pattern as manusMainViewErrorEl/
// manusImportFromTex elsewhere in this file).
function manusLoadPdfTimestampIfNeeded() {
  if (manusPdfTimestampLoaded || manusPdfGenerating) return;
  manusPdfTimestampLoaded = true;
  manusFetchPdfStatus(manusPdfReferenceUrl()).then(({ date, confirmedAbsent, checkFailed }) => {
    manusPdfLastGeneratedAt = date;
    manusPdfConfirmedAbsent = confirmedAbsent;
    manusPdfCheckFailed = checkFailed;
    const el = manusPdfTimestampEl();
    if (el) el.textContent = manusPdfStatusText();
  });
}

const MANUS_PDF_POLL_INTERVAL_MS = 10000;
const MANUS_PDF_POLL_TIMEOUT_MS = 10 * 60 * 1000;

function manusPollPdfCompletion(beforeDate, url) {
  const startedAt = Date.now();
  const beforeTime = beforeDate ? beforeDate.getTime() : null;

  const tick = async () => {
    if (Date.now() - startedAt > MANUS_PDF_POLL_TIMEOUT_MS) {
      manusPdfGenerating = false;
      renderManusPdfLinksSection();
      renderMainViewActions();
      return;
    }
    const current = await manusFetchPdfStatus(url);
    const currentTime = current.date ? current.date.getTime() : null;
    if (currentTime !== null && currentTime !== beforeTime) {
      manusPdfGenerating = false;
      manusPdfLastGeneratedAt = current.date;
      manusPdfConfirmedAbsent = false;
      manusPdfCheckFailed = false;
      renderManusPdfLinksSection();
      renderMainViewActions();
      siteShowToast("PDF'erne er opdateret");
      return;
    }
    setTimeout(tick, MANUS_PDF_POLL_INTERVAL_MS);
  };
  setTimeout(tick, MANUS_PDF_POLL_INTERVAL_MS);
}

// Re-triggers the PDF pipeline (scripts/generate-pdfs.js, run by the
// generate-pdfs.yml GitHub Action) without touching any in-progress edit:
// unlike manusSaveMain, this never reads or clears manusDraft, so it's safe
// to click mid-edit on any tab. It just re-saves the already-saved data
// as-is through the same boss-level `manus` resource path Gem uses — the
// server always re-stamps scenes.json's version on every save
// (save_manus() in update-data.php), so this reliably produces a fresh
// commit and re-triggers the Action every time, even with zero real
// content change. The three buttons below all call this same function:
// "full rebuild every time" was a deliberate choice over a --only flag,
// since Manuskript is a merge of every other scene PDF and a partial
// rebuild risks the three documents drifting out of sync with each other.
async function manusRegeneratePdfs() {
  if (manusPdfGenerating) return;

  const errEl = manusMainViewErrorEl();
  if (errEl) errEl.textContent = '';

  const referenceUrl = manusPdfReferenceUrl();
  const before = (await manusFetchPdfStatus(referenceUrl)).date;

  manusPdfGenerating = true;
  renderManusPdfLinksSection();
  renderMainViewActions();

  const scenesActs = manusCurrentActsPayload();
  const castRoster = manusBuildCastRoster(scenesActs);
  const result = await siteSaveResource('manus', { scenes: scenesActs, cast: castRoster });
  if (!result.ok) {
    manusPdfGenerating = false;
    renderManusPdfLinksSection();
    renderMainViewActions();
    const el = manusMainViewErrorEl();
    if (el) el.textContent = result.message;
    return;
  }
  siteShowToast('PDF-generering startet (Aktoversigt, Rolleoversigt, Manuskript) – tager et par minutter');
  manusPollPdfCompletion(before, referenceUrl);
}

// Bottom action bar of Main Manus View: a left-side cluster ("Generér
// PDF'er" followed by its own "Sidst genereret" status, mirroring how the
// "Gemt"/"Ikke gemt" status sits next to Gem on the right) and a right-side
// cluster (error text above, then the Gemt/Ikke gemt status next to Gem)
// mirroring where Budget's own save-status sits relative to its save
// button.
function renderMainViewActions() {
  const mount = document.getElementById('manus-main-view-actions');
  mount.textContent = '';

  const left = document.createElement('div');
  left.className = 'manus-main-view-generate-cluster';

  const generateBtn = document.createElement('button');
  generateBtn.type = 'button';
  generateBtn.className = 'site-pill-btn site-pill-warm';
  generateBtn.classList.toggle('manus-pdf-generating', manusPdfGenerating);
  generateBtn.textContent = manusPdfGenerating ? 'Genererer...' : "Generér PDF'er";
  generateBtn.disabled = manusPdfGenerating;
  generateBtn.addEventListener('click', () => manusRegeneratePdfs());
  left.appendChild(generateBtn);

  const pdfStatus = document.createElement('span');
  pdfStatus.className = 'manus-pdf-status';
  pdfStatus.setAttribute('data-manus-pdf-timestamp', '');
  pdfStatus.textContent = manusPdfStatusText();
  left.appendChild(pdfStatus);

  mount.appendChild(left);
  manusLoadPdfTimestampIfNeeded();

  const right = document.createElement('div');
  right.className = 'manus-main-view-save-cluster';

  const error = document.createElement('div');
  error.className = 'manus-main-view-error';
  right.appendChild(error);

  const buttons = document.createElement('div');
  buttons.className = 'manus-main-view-buttons';

  const status = document.createElement('span');
  status.className = 'manus-save-status';
  buttons.appendChild(status);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'site-pill-btn site-pill-primary';
  saveBtn.textContent = 'Gem';
  saveBtn.addEventListener('click', () => manusSaveMain());
  buttons.appendChild(saveBtn);

  right.appendChild(buttons);
  mount.appendChild(right);

  manusUpdateSaveStatus();
}

// Re-queried fresh on every call (like manusMainViewErrorEl) rather than
// cached, since renderMainViewActions rebuilds #manus-main-view-actions'
// children wholesale on every render — a cached reference would go stale
// the moment any tab re-renders the action row.
function manusSaveStatusEl() {
  return document.querySelector('#manus-main-view-actions .manus-save-status');
}

function manusUpdateSaveStatus() {
  const el = manusSaveStatusEl();
  if (!el) return;
  const dirty = manusIsDirty();
  el.textContent = dirty ? 'Ikke gemt' : 'Gemt';
  el.classList.toggle('dirty', dirty);
}

// Mirrors scripts/generate-pdfs.js's own slugify() (æøå transliteration,
// spaces→_, everything else stripped) — needed client-side purely to build
// an individual manuscript's filename (archive/<folder>/manuskripter/
// <slug>.pdf) from a cast member's plain name. Duplicated rather than
// shared, same as the role-classification tables already duplicated across
// import.js/manus.js/generate-pdfs.js in this zero-build-step codebase.
const MANUS_NAME_TRANSLIT = { æ: 'ae', ø: 'oe', å: 'aa', Æ: 'Ae', Ø: 'Oe', Å: 'Aa' };
function manusSlugifyName(name) {
  return String(name)
    .split('').map((ch) => MANUS_NAME_TRANSLIT[ch] || ch).join('')
    .trim().replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_]/g, '');
}

// Quick-open buttons for the last-generated PDFs, sitting between the pool/
// guide row and Main Manus View — visible to any revyst+ (everyone benefits
// from reading these, not just boss), unlike Main Manus View below which
// stays boss-only. A shortcut to the files scripts/generate-pdfs.js (run via
// generate-pdfs.yml) already produced, not a trigger to (re)build them
// ("Generér PDF'er" moved to Main Manus View's own action row, since that's
// the one boss-only write action here — see renderMainViewActions).
function renderManusPdfLinksSection() {
  const section = document.getElementById('manus-pdf-links');
  if (!siteHasLevel('revyst')) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';
  section.textContent = '';

  const folder = (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
  if (!folder) return;

  const openFile = (filename) => window.open(`archive/${folder}/${filename}`, '_blank');

  const linkRow = document.createElement('div');
  linkRow.className = 'manus-pdf-links-row';

  const files = [
    ['Aktfordeling', 'Aktoversigt.pdf'],
    ['Rollefordeling', 'Rolleoversigt.pdf'],
    ['Manus', 'Manuskript.pdf'],
  ];
  for (const [label, filename] of files) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'site-pill-btn site-pill-warm';
    // Stays fully clickable during generation, label unchanged — opens
    // whichever version is currently live, the pulse alone flags that a
    // fresher one is on its way (see manusRegeneratePdfs/
    // manusPollPdfCompletion above).
    btn.classList.toggle('manus-pdf-generating', manusPdfGenerating);
    btn.textContent = label;
    btn.addEventListener('click', () => openFile(filename));
    linkRow.appendChild(btn);
  }

  const individualBtn = document.createElement('button');
  individualBtn.type = 'button';
  individualBtn.className = 'site-pill-btn site-pill-warm';
  individualBtn.classList.toggle('manus-pdf-generating', manusPdfGenerating);
  individualBtn.textContent = 'Individuelt Manus';
  individualBtn.addEventListener('click', () => {
    const names = getEffectiveCastData()
      .map((c) => c.name)
      .slice()
      .sort((a, b) => a.localeCompare(b, 'da'));
    siteOpenDropdownPicker(individualBtn, names.map((name) => ({ value: name, label: name })), null, (name) => {
      openFile(`manuskripter/${manusSlugifyName(name)}.pdf`);
    });
  });
  linkRow.appendChild(individualBtn);
  section.appendChild(linkRow);

  // No pure-CSS way to make flex items match the widest sibling's own
  // content width (flex:1 stretches all to fill the row instead, which read
  // as "quite ugly" per user feedback) — measured here, once all four
  // buttons are actually in the live DOM, and applied uniformly.
  const rowButtons = Array.from(linkRow.children);
  const maxWidth = Math.max(...rowButtons.map((b) => b.getBoundingClientRect().width));
  rowButtons.forEach((b) => { b.style.minWidth = `${maxWidth}px`; });
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

// Boss/admin get PDF links straight on each scene row in the Vælg scener
// tab (see renderSelectRow) — the raw upload-pool columns + Manus Guide box
// (`.manus-layout`) serve no purpose at that level, unlike a plain revyst
// visitor who has nothing else on the page, so the whole block is hidden
// outright rather than just left collapsed.
function renderPoolLayoutVisibility() {
  document.querySelector('.manus-layout').style.display = siteHasLevel('boss') ? 'none' : '';
}

function renderAll() {
  renderPoolLayoutVisibility();
  renderColumns();
  renderBottomActions();
  renderManusPdfLinksSection();
  renderMainManusView();
  manusStartPendingPoll();
}

// Site-styled stand-in for the native beforeunload dialog, for the one case
// that actually can be intercepted before the page unloads: clicking one of
// this site's own in-page links (header nav, mobile menu nav, or any other
// outbound <a> on this page). Mirrors confirmDeleteManuscript()'s shape.
// The native beforeunload dialog below still covers tab close/refresh/back/
// typed-URL, which browsers deliberately never let a page restyle.
function confirmLeaveDirtyPage(href) {
  const { form, actions, close } = siteOpenEditModal('Forlad siden');

  const info = document.createElement('p');
  info.textContent = 'Du har ændringer, der ikke er gemt endnu. Vil du forlade siden alligevel?';
  form.appendChild(info);

  const stayBtn = document.createElement('button');
  stayBtn.className = 'site-pill-btn';
  stayBtn.textContent = 'Bliv her';
  stayBtn.addEventListener('click', close);

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'site-pill-btn site-pill-danger';
  leaveBtn.textContent = 'Forlad uden at gemme';
  leaveBtn.addEventListener('click', () => { window.location.href = href; });

  actions.appendChild(stayBtn);
  actions.appendChild(leaveBtn);
}

document.addEventListener('DOMContentLoaded', () => {
  wireManusGuideToggle();
  renderAll();

  // Passive polling, not a push from every mutation site (see manusIsDirty's
  // own comment for why) — cheap enough at this page's scale to just re-diff
  // on an interval. No autosave: the interval only ever updates the status
  // text, matching the user's explicit "shouldn't save in the background."
  setInterval(manusUpdateSaveStatus, 500);

  window.addEventListener('beforeunload', (e) => {
    if (manusIsDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Intercept clicks on this page's own links while dirty, in favor of the
  // styled confirmLeaveDirtyPage() modal above instead of an abrupt native
  // beforeunload dialog. Only a plain, unmodified left-click on a same-tab
  // link while genuinely dirty is intercepted — a new-tab/modified click, a
  // hash-only link, or a click while nothing is unsaved all pass through
  // untouched, exactly like beforeunload's own gating.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest('a[href]');
    if (!link || link.target === '_blank') return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (!manusIsDirty()) return;
    e.preventDefault();
    confirmLeaveDirtyPage(link.href);
  }, true);
});
