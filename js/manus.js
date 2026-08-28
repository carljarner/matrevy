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

// GitHub's Commits API, used by manusFetchPdfStatus (below) to check a
// specific file's real change history rather than the deployed site's own
// (redeploy-tainted) headers. Unauthenticated, like MANUS_TEX_RAW_BASE.
const MANUS_COMMITS_API_BASE = 'https://api.github.com/repos/carljarner/matrevy/commits';

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

// Program tab's own data/program.json shadow — the ordinary site-wide
// siteLoadOverride/siteSaveOverride pattern (like Kalender/Wiki/Posts), NOT
// manusDraft's in-memory-only optimistic shadow, since the Program tab isn't
// racing scripts/generate-pdfs.js the way Aktfordeling/Rollefordeling's
// scenes/cast save is (see renderProgramTab/saveProgram below).
let programOverride = siteLoadOverride('program');

function getEffectiveProgram() {
  return programOverride || (typeof PROGRAM_DATA !== 'undefined' ? PROGRAM_DATA : { medvirkende: [], ordliste: [], qrCodes: [] });
}

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
    const normalizedTitle = title.toLowerCase();
    const isDuplicate = getEffectiveManuscripts().some(
      s => (s.title || '').trim().toLowerCase() === normalizedTitle
    );
    if (isDuplicate) {
      error.textContent = 'Der findes allerede en scene med den titel. Vælg en anden titel.';
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
      siteShowToast('Manus uploadet – der går 1-2 min før siden er opdateret');
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
// Shared by the blank voting sheet (manusOpenVotingSheet, rows with no
// point/comment yet) and the point-entry modal's results print
// (manusPrintPointResults, rows already computed/ordered) — same table
// shape either way, just with or without values filled in.
function manusRenderPrintTable(titleText, rows) {
  const sheet = document.getElementById('manus-print-sheet');
  sheet.textContent = '';

  const title = document.createElement('h2');
  title.className = 'manus-print-title';
  title.textContent = titleText;
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
  for (const row of rows) {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = row.name;
    tr.appendChild(tdName);
    const tdPoint = document.createElement('td');
    tdPoint.textContent = row.point || '';
    tr.appendChild(tdPoint);
    const tdComment = document.createElement('td');
    tdComment.textContent = row.comment || '';
    tr.appendChild(tdComment);
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  sheet.appendChild(table);

  window.print();
}

function manusOpenVotingSheet(type) {
  const items = getEffectiveManuscripts()
    .filter(s => s.type === type)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));

  manusRenderPrintTable(
    `Stemmeark – ${MANUS_TYPE_COLUMN_LABEL[type]}`,
    items.map(item => ({ name: item.title }))
  );
}

// Used by the point-entry modal's results view "Udskriv" button — same
// sheet shape/header as manusOpenVotingSheet's blank one, but rows are
// already sorted by descending average with Point/Kommentar filled in.
function manusPrintPointResults(type, rows) {
  manusRenderPrintTable(
    `Stemmeark – ${MANUS_TYPE_COLUMN_LABEL[type]}`,
    rows.map(row => ({
      name: row.title,
      point: row.avg === null ? '' : formatPointsAvg(row.avg),
      comment: row.comments.join(' / '),
    }))
  );
}

// ── "Indtast point": transcribe one paper Stemmeark at a time ──
// Purely localStorage-based (matrevy-manus-points) — unlike every other
// Manus resource this deliberately never syncs through the server/GitHub;
// it's private scratch data for whichever single browser transcribes the
// physical Stemmeark sheets (see CLAUDE.md's Manus section for why every
// other resource here IS globally synced — this is the one exception).
// Votes are keyed by each submission's stable server-assigned `id` (from
// data/manuscripts.json, via getEffectiveManuscripts() — the very same
// source manusOpenVotingSheet() above reads), not by any manusDraft.rows
// key or scene.id — those are a runtime counter / recomputed positional
// string respectively and don't survive a save+reload, but a submission's
// id never changes regardless of placement.
//
// store[type] = { sheets: [ { [submissionId]: { point?, comment? } }, ... ] }
// — one plain object per physical sheet, indexed by position (sheet #N is
// sheets[N-1]); an item key only exists on a sheet once it actually has a
// point and/or comment, so `Object.keys(sheet).length === 0` is exactly
// "this sheet is empty" (used by the left-nav pruning rule below).
const MANUS_POINTS_KEY = 'matrevy-manus-points';
const MANUS_POINTS_VALUES = Array.from({ length: 11 }, (_, i) => i); // 0-10

function loadPointsStore() {
  try {
    const raw = localStorage.getItem(MANUS_POINTS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function savePointsStore(store) {
  try {
    localStorage.setItem(MANUS_POINTS_KEY, JSON.stringify(store));
  } catch {
    // localStorage unavailable (private browsing quota, etc.) — silently drop.
  }
}

// Same source/filter/sort as manusOpenVotingSheet() so this modal's row
// order always matches what's on the physical printed sheet.
function pointsItemsForType(type) {
  return getEffectiveManuscripts()
    .filter(s => s.type === type)
    .slice()
    .sort((a, b) => a.title.localeCompare(b.title, 'da'));
}

function isPointsSheetEmpty(sheet) {
  return Object.keys(sheet).length === 0;
}

// Below 6 is displayed as a flat "< 6" (in both the results table and the
// printed sheet) rather than the exact figure — sorting still uses the real
// `avg`, only this display string is coarsened. Only call with a non-null
// avg; callers handle the "no votes yet" case themselves.
function formatPointsAvg(avg) {
  return avg < 6 ? '< 6' : avg.toFixed(1);
}

function openPointEntryModal(type) {
  const store = loadPointsStore();
  if (!store[type] || !Array.isArray(store[type].sheets)) store[type] = { sheets: [] };
  const bucket = store[type];

  // Resume on the last sheet (most likely where transcription left off).
  let currentIndex = Math.max(0, bucket.sheets.length - 1);

  // Every click/keystroke saves straight to localStorage (see
  // renderPointsRow() below), so there's no in-progress work a backdrop
  // click or Escape could lose — the modal closes normally.
  const { modal, form, actions, close } = siteOpenModalWithClose(
    `Indtast point – ${MANUS_TYPE_COLUMN_LABEL[type]}`
  );
  modal.classList.add('manus-points-modal');
  // Both views put their own button row in `form` (see the sheet-navigator
  // and results button row below) — the shared bottom `actions` bar is
  // unused here, and left visible it added its own margin-top below the
  // real button row, unbalancing the space above/below it.
  actions.style.display = 'none';

  let mode = 'entry'; // 'entry' | 'results'

  function renderBody() {
    form.textContent = '';
    if (mode === 'entry') renderEntryView();
    else renderResultsView();
  }

  // Guarantees at least one sheet exists and currentIndex points at a real
  // one — needed after "Nulstil alle point" empties the array, and cheap
  // enough to just call unconditionally on every entry-view render.
  function ensureSheets() {
    if (bucket.sheets.length === 0) bucket.sheets.push({});
    if (currentIndex >= bucket.sheets.length) currentIndex = bucket.sheets.length - 1;
    if (currentIndex < 0) currentIndex = 0;
  }

  function renderEntryView() {
    ensureSheets();
    const sheet = bucket.sheets[currentIndex];

    const items = pointsItemsForType(type);
    if (items.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'Ingen uploads af denne type endnu.';
      form.appendChild(empty);
    } else {
      const list = document.createElement('div');
      list.className = 'manus-points-list';
      for (const item of items) list.appendChild(renderPointsRow(item, sheet));
      form.appendChild(list);
    }

    // Sheet navigator — sits right below the row list (still inside `form`,
    // so it's always visible without scrolling the list itself) — moving
    // right past the last sheet creates a fresh blank one; moving left off
    // the last sheet drops it first if it was never actually filled in.
    // "Resultat" shares this same row, pinned to the right, via the shared
    // .manus-points-grid-row 3-column layout (see manus.css).
    const nav = document.createElement('div');
    nav.className = 'manus-points-grid-row';

    const navGroup = document.createElement('div');
    navGroup.className = 'manus-points-nav-group manus-points-col-center';

    const prevBtn = document.createElement('button');
    prevBtn.type = 'button';
    prevBtn.className = 'site-pill-btn';
    prevBtn.textContent = '‹ Forrige';
    prevBtn.disabled = currentIndex === 0;
    prevBtn.addEventListener('click', () => {
      const isLast = currentIndex === bucket.sheets.length - 1;
      if (isLast && bucket.sheets.length > 1 && isPointsSheetEmpty(bucket.sheets[currentIndex])) {
        bucket.sheets.pop();
      }
      currentIndex = Math.max(0, currentIndex - 1);
      savePointsStore(store);
      renderBody();
    });

    const label = document.createElement('span');
    label.className = 'manus-points-sheet-label';
    label.textContent = `Ark ${currentIndex + 1}/${bucket.sheets.length}`;

    const nextBtn = document.createElement('button');
    nextBtn.type = 'button';
    nextBtn.className = 'site-pill-btn';
    nextBtn.textContent = 'Næste ›';
    nextBtn.addEventListener('click', () => {
      if (currentIndex === bucket.sheets.length - 1) bucket.sheets.push({});
      currentIndex += 1;
      savePointsStore(store);
      renderBody();
    });

    navGroup.appendChild(prevBtn);
    navGroup.appendChild(label);
    navGroup.appendChild(nextBtn);
    nav.appendChild(navGroup);

    const resultsBtn = document.createElement('button');
    resultsBtn.type = 'button';
    resultsBtn.className = 'site-pill-btn site-pill-warm manus-points-col-end';
    resultsBtn.textContent = 'Resultat';
    resultsBtn.addEventListener('click', () => {
      mode = 'results';
      renderBody();
    });
    nav.appendChild(resultsBtn);

    form.appendChild(nav);
  }

  // One row: title + eleven 0-10 point circles + a comment field. Every
  // click/keystroke writes straight into `sheet`/localStorage immediately
  // (no separate save step, mirroring schedule.js's per-mutation autosave)
  // and only that row's own circle highlighting is refreshed — never a full
  // renderEntryView() — so typing a comment elsewhere keeps its focus/caret.
  function renderPointsRow(item, sheet) {
    const row = document.createElement('div');
    row.className = 'manus-points-row';

    const title = document.createElement('span');
    title.className = 'manus-points-row-title';
    title.textContent = item.title;
    row.appendChild(title);

    function currentEntry(create) {
      let entry = sheet[item.id];
      if (!entry && create) entry = sheet[item.id] = {};
      return entry;
    }
    function pruneIfEmpty(entry) {
      if (entry && entry.point === undefined && !entry.comment) delete sheet[item.id];
    }

    const circles = document.createElement('div');
    circles.className = 'manus-points-circles';
    const circleEls = [];
    for (const value of MANUS_POINTS_VALUES) {
      const circle = document.createElement('button');
      circle.type = 'button';
      circle.className = `manus-points-circle manus-points-circle-v${value}`;
      circle.dataset.value = String(value);
      circle.textContent = String(value);
      circle.addEventListener('click', () => {
        const entry = currentEntry(true);
        if (entry.point === value) delete entry.point;
        else entry.point = value;
        pruneIfEmpty(entry);
        savePointsStore(store);
        updateCircles();
      });
      circles.appendChild(circle);
      circleEls.push(circle);
    }
    row.appendChild(circles);

    function updateCircles() {
      const entry = sheet[item.id];
      const active = entry ? entry.point : undefined;
      for (const el of circleEls) {
        el.classList.toggle('manus-points-circle-active', Number(el.dataset.value) === active);
      }
    }
    updateCircles();

    const commentInput = document.createElement('input');
    commentInput.type = 'text';
    commentInput.className = 'manus-points-comment-input';
    commentInput.placeholder = 'Kommentar';
    commentInput.value = (sheet[item.id] && sheet[item.id].comment) || '';
    commentInput.addEventListener('input', () => {
      const entry = currentEntry(true);
      if (commentInput.value.trim()) entry.comment = commentInput.value;
      else delete entry.comment;
      pruneIfEmpty(entry);
      savePointsStore(store);
    });
    row.appendChild(commentInput);

    return row;
  }

  function computePointsStats(item) {
    let sum = 0, count = 0;
    const comments = [];
    for (const sheet of bucket.sheets) {
      const entry = sheet[item.id];
      if (!entry) continue;
      if (typeof entry.point === 'number') { sum += entry.point; count += 1; }
      if (entry.comment && entry.comment.trim()) comments.push(entry.comment.trim());
    }
    return { avg: count > 0 ? sum / count : null, count, comments };
  }

  function renderResultsView() {
    const items = pointsItemsForType(type);
    const rows = items.map(item => ({ title: item.title, ...computePointsStats(item) }));
    rows.sort((a, b) => {
      if (a.avg === null && b.avg === null) return a.title.localeCompare(b.title, 'da');
      if (a.avg === null) return 1;
      if (b.avg === null) return -1;
      return b.avg - a.avg;
    });

    const table = document.createElement('table');
    table.className = 'manus-points-results-table';

    const thead = document.createElement('thead');
    const headRow = document.createElement('tr');
    for (const label of ['Navn', 'Gennemsnit', 'Antal', 'Kommentarer']) {
      const th = document.createElement('th');
      th.textContent = label;
      headRow.appendChild(th);
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    for (const row of rows) {
      const tr = document.createElement('tr');

      const tdName = document.createElement('td');
      tdName.textContent = row.title;
      tr.appendChild(tdName);

      const tdAvg = document.createElement('td');
      tdAvg.textContent = row.avg === null ? '–' : formatPointsAvg(row.avg);
      tr.appendChild(tdAvg);

      const tdCount = document.createElement('td');
      tdCount.textContent = String(row.count);
      tr.appendChild(tdCount);

      const tdComments = document.createElement('td');
      tdComments.textContent = row.comments.join(' / ');
      tr.appendChild(tdComments);

      tbody.appendChild(tr);
    }
    table.appendChild(tbody);

    const scroll = document.createElement('div');
    scroll.className = 'manus-points-results-scroll';
    scroll.appendChild(table);
    form.appendChild(scroll);

    // Button row directly below the scroll area (same .manus-points-grid-row
    // layout as the entry view's sheet navigator, so both views end up the
    // same overall height) — Nulstil far left, Udskriv centered, Tilbage
    // far right.
    const buttonRow = document.createElement('div');
    buttonRow.className = 'manus-points-grid-row';

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'site-pill-btn site-pill-danger manus-points-col-start';
    resetBtn.textContent = 'Nulstil';
    resetBtn.addEventListener('click', () => {
      openResetPointsConfirm(bucket, store, renderBody);
    });

    const printBtn = document.createElement('button');
    printBtn.type = 'button';
    printBtn.className = 'site-pill-btn site-pill-warm manus-points-col-center';
    printBtn.textContent = 'Udskriv';
    printBtn.addEventListener('click', () => {
      // Close the modal first — otherwise it's still sitting on top of the
      // actual print sheet at print time (it isn't hidden by the @media
      // print rules, since manusOpenVotingSheet never has a modal open when
      // it prints), which is what made the printout look like a screenshot
      // of the app instead of the plain typewriter-style sheet.
      close();
      manusPrintPointResults(type, rows);
    });

    const backBtn = document.createElement('button');
    backBtn.type = 'button';
    backBtn.className = 'site-pill-btn manus-points-col-end';
    backBtn.textContent = 'Tilbage';
    backBtn.addEventListener('click', () => {
      mode = 'entry';
      renderBody();
    });

    buttonRow.appendChild(resetBtn);
    buttonRow.appendChild(printBtn);
    buttonRow.appendChild(backBtn);
    form.appendChild(buttonRow);
  }

  renderBody();
}

// Same "Er du sikker?" narrow-confirm shape as openManuscriptDeleteConfirm
// above. Mutates `bucket` (the same object stored at store[type]) in place
// rather than replacing store[type] wholesale, so the caller's already-held
// `bucket` closure reference stays correct after a reset.
function openResetPointsConfirm(bucket, store, onReset) {
  const { modal, form, actions, close } = siteOpenEditModal('');
  modal.classList.add('manus-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'manus-confirm-text';
  info.textContent = 'Er du sikker?';
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-pill-btn site-pill-danger';
  confirmBtn.textContent = 'Nulstil';
  confirmBtn.addEventListener('click', () => {
    bucket.sheets = [];
    savePointsStore(store);
    close();
    onReset();
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
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

// Reserved act code used only to round-trip unplaced manual video/bandsang
// rows through scenes.json (see manusBuildActsPayload below) — deliberately
// the same string as the `lane: 'pool'` sentinel every other still-unplaced
// row already uses, so a reloaded row lands back in "Ikke placeret" with no
// special-casing needed in manusInitDraft's row-building loop. Never a real
// act: manusBuildActSkeleton excludes it from draft.acts so it can't show up
// as its own column in Aktfordeling/Rollefordeling/Manus/Stjerneark.
const MANUS_POOL_ACT_CODE = 'pool';

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
    if (code === MANUS_POOL_ACT_CODE) continue;
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

// True for any row whose "Videoer & Bandsange" flow this is (see
// renderMediaColumn() below) — checked off manusRowType(), not row.origin,
// since a saved-and-reloaded video/bandsang
// scene comes back as origin:'existing' and is only still distinguishable by
// its type. Used to keep these rows out of Rollefordeling/Manus/Stjerneark
// (they have no cast/roles) while still showing in Aktfordeling.
function manusRowIsManualMedia(row) {
  const t = manusRowType(row);
  return t === 'video' || t === 'bandsang';
}

function manusAnyNonMediaPlaced() {
  return manusDraft.acts.some(act => manusDraftRowsForLane(act.code).some(r => !manusRowIsManualMedia(r)));
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

function extractTexRevyname(texText) {
  const m = texText.match(/\\revyname\{([^}]*)\}/);
  return m ? m[1].trim() : '';
}

function extractTexRevyyear(texText) {
  const m = texText.match(/\\revyyear\{([^}]*)\}/);
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
// row.cast, used to seed Rollefordeling's (and openVideoBandsangModal's own
// Roller field's) textarea with whatever's currently stored (from a prior
// "Opdater roller"/"Gem" click, or an auto-import) each time the modal
// opens. Filters on roleCode (parseRolesText's own guarantee — every entry
// it produces has one), not name: an uncast role (no name yet, e.g. a
// video/bandsang row's still-unfilled placeholder \role{R} Revyst) must
// round-trip too, or it silently vanishes the next time the modal reopens —
// the bracket itself is only emitted once a name is actually present.
function formatRolesText(cast) {
  return cast
    .filter(c => c.roleCode && c.roleCode.trim())
    .map(c => {
      const code = c.roleCode.trim();
      const name = (c.name || '').trim();
      const desc = (c.description || '').trim();
      return `\\role{${code}}${name ? '[' + name + ']' : ''}${desc ? ' ' + desc : ''}`;
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
  // A manual video/bandsang row has no backing store of its own — unlike a
  // pool sketch/sang submission, which survives indefinitely in
  // data/manuscripts.json even while unplaced, a manual row only exists at
  // all inside scenes.json. Still-unplaced ones (lane 'pool') would
  // otherwise be silently dropped by the act loop above, since 'pool' never
  // matches a real act code — stash them under the reserved
  // MANUS_POOL_ACT_CODE act instead, so "create, then Gem without dragging
  // into an act" round-trips correctly. manusBuildActSkeleton keeps this
  // pseudo-act out of draft.acts, so it never renders as its own column.
  const unplacedMedia = manusDraftRowsForLane(MANUS_POOL_ACT_CODE, draft).filter(manusRowIsManualMedia);
  if (unplacedMedia.length) {
    const poolAct = { code: MANUS_POOL_ACT_CODE, label: 'Ikke placeret' };
    const scenes = unplacedMedia.map((row, idx) => manusRowScene(row, poolAct, idx));
    scenesActs.push({ act: poolAct.code, label: poolAct.label, scenes });
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
  const acts = skeleton.map(({ code, label }) => {
    const scenes = flatScenes
      .filter((s) => String(s.id).split('-')[0] === code)
      .map(({ actLabel, ...scene }) => scene)
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    return { act: code, label, scenes };
  });
  // manusBuildActSkeleton deliberately excludes the reserved pool pseudo-act
  // (MANUS_POOL_ACT_CODE — still-unplaced video/bandsang rows), since it's
  // never a real column. Re-attach its scenes here too, or "Generér PDF'er"
  // (which rebuilds straight from the currently-saved data, not a draft)
  // would silently drop them on every regeneration.
  const poolScenes = flatScenes
    .filter((s) => String(s.id).split('-')[0] === MANUS_POOL_ACT_CODE)
    .map(({ actLabel, ...scene }) => scene)
    .sort((a, b) => (a.number || 0) - (b.number || 0));
  if (poolScenes.length) acts.push({ act: MANUS_POOL_ACT_CODE, label: 'Ikke placeret', scenes: poolScenes });
  return acts;
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

// A phantom trailing "card" filling the rest of an act column's own height
// (the list is flex:1 inside the column, so a column shorter than its
// tallest CSS-grid-row sibling already has this space open) — without it,
// dropping below the last real card silently appended to the lane via
// wireLaneDropZone's column-wide fallback with no visual cue at all, which
// read as "you can't drop there." Reuses the exact same
// .manus-akt-row::before insertion-line treatment (see manus.css) so the
// end-of-lane drop target looks and behaves exactly like dropping between
// two real cards.
function renderDropTailCard(laneCode) {
  const el = document.createElement('div');
  el.className = 'manus-akt-drop-tail';
  wireDropHighlight(el, () => {
    if (manusDragKey) manusMoveRow(manusDragKey, laneCode, null);
  }, { stop: true });
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

// ── Delete a scene from Vælg scener — sketch/song (admin only, purges the
// uploaded files too) or video/bandsang (any boss, in-memory draft only) ──
// Two-step confirm mirroring budget.js's openDeleteYearWarning/
// openDeleteYearConfirm — step 1's wording branches on manusRowIsManualMedia
// (a manual row has no backing archive files, so it skips that sentence),
// step 2 is the same "Er du sikker?" confirm either way. Works on a row
// regardless of placement (still-unplaced pool upload or already in an act)
// — on success the row is filtered out of manusDraft.rows entirely, so a
// placed scene also disappears from its act (effective on the next Gem).
function openManuscriptDeleteWarning(row) {
  const { modal, form, actions, close } = siteOpenModalWithClose('Slet scene?');
  modal.classList.add('manus-delete-warning-modal');

  const info = document.createElement('p');
  info.textContent = manusRowIsManualMedia(row)
    ? `Slet "${manusRowTitle(row)}" permanent?`
    : `Dette sletter "${manusRowTitle(row)}" permanent, inklusive de uploadede .tex- og .pdf-filer fra GitHub.`;
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const continueBtn = document.createElement('button');
  continueBtn.className = 'site-pill-btn site-pill-danger';
  continueBtn.textContent = 'Fortsæt';
  continueBtn.addEventListener('click', () => {
    close();
    openManuscriptDeleteConfirm(row);
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(continueBtn);
}

function openManuscriptDeleteConfirm(row) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('manus-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'manus-confirm-text';
  info.textContent = 'Er du sikker?';
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-pill-btn site-pill-danger';
  confirmBtn.textContent = 'Slet';
  confirmBtn.addEventListener('click', async () => {
    // A manual media row has no backing archive files/manuscripts.json
    // record — nothing to call the server for, just drop it from the draft.
    if (manusRowIsManualMedia(row)) {
      manusDraft.rows = manusDraft.rows.filter(r => r.key !== row.key);
      close();
      renderSelectTab();
      return;
    }
    confirmBtn.disabled = true;
    error.textContent = '';
    const pdfPath = manusRowPdfPath(row);
    const texPath = manusRowTexPath(row);
    const id = row.origin === 'pool' ? row.submission.id : null;
    const result = await manusApi('manuscripts_delete', { pdfPath, texPath, id });
    if (result.ok) {
      manusDraft.rows = manusDraft.rows.filter(r => r.key !== row.key);
      if (id) {
        manuscriptsOverride = getEffectiveManuscripts().filter(s => s.id !== id);
        siteSaveOverride('manuscripts', manuscriptsOverride);
      }
      close();
      renderSelectTab();
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Plain numeric text field for a row's duration — deliberately not
// <input type="number">, whose spinner arrows steal the click (and the
// keyboard focus lands mid-value) instead of just placing the caret. Filters
// on every keystroke to digits plus a single "," or "." (both treated as the
// decimal point, matching how a Dane would naturally type a fraction).
// Shared by renderSelectRow's read-only branch and renderVideoBandsangRow.
function manusCreateDurationInput(row) {
  const durationInput = document.createElement('input');
  durationInput.type = 'text';
  durationInput.inputMode = 'decimal';
  durationInput.className = 'manus-select-duration';
  durationInput.placeholder = '–';
  durationInput.value = row.duration != null ? row.duration : '';
  durationInput.addEventListener('click', (e) => e.stopPropagation());
  durationInput.addEventListener('input', () => {
    let v = durationInput.value.replace(/[^0-9.,]/g, '');
    const sepIdx = v.search(/[.,]/);
    if (sepIdx !== -1) {
      v = v.slice(0, sepIdx + 1) + v.slice(sepIdx + 1).replace(/[.,]/g, '');
    }
    if (v !== durationInput.value) durationInput.value = v;
    row.duration = v === '' ? null : Number(v.replace(',', '.'));
  });
  return durationInput;
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

  const durationInput = manusCreateDurationInput(row);
  durationInput.dataset.manusSelectDuration = row.key;
  el.appendChild(durationInput);
  const suffix = document.createElement('span');
  suffix.className = 'manus-akt-duration-suffix';
  suffix.textContent = 'min';
  el.appendChild(suffix);

  // Admin-only, stricter than the page's ambient boss floor — see
  // openManuscriptDeleteWarning above. Never shown for a manual media row
  // (manusRowPdfPath is always null there; those get Feature A's in-modal
  // Slet button instead).
  if (siteHasLevel('admin') && manusRowPdfPath(row)) {
    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'manus-select-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Slet permanent';
    removeBtn.setAttribute('aria-label', `Slet ${manusRowTitle(row)} permanent`);
    removeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openManuscriptDeleteWarning(row);
    });
    el.appendChild(removeBtn);
  }

  return el;
}

// ── "Videoer & Bandsange" (its own card, below Udvælgelse) ──────
// A row here is title+duration only, like renderSelectRow's own read-only
// branch above (same duration input markup) — but since there's no PDF to
// link to, the whole row is itself a click-to-edit target
// (openVideoBandsangModal). Always rendered as "selected"
// (.manus-select-row-selected, the same warm-fill/bold-orange style
// Sketches/Sange give a real in-the-revy row) since a manual media row is
// selected by construction — there's no separate select/deselect step for
// it the way an uploaded submission has.
function renderVideoBandsangRow(row) {
  const el = document.createElement('div');
  el.className = 'manus-select-row manus-select-row-selected';
  el.setAttribute('role', 'button');
  el.tabIndex = 0;

  const title = document.createElement('span');
  title.className = 'manus-pdf-title';
  title.textContent = manusRowTitle(row);
  el.appendChild(title);

  const durationInput = manusCreateDurationInput(row);
  el.appendChild(durationInput);
  const suffix = document.createElement('span');
  suffix.className = 'manus-akt-duration-suffix';
  suffix.textContent = 'min';
  el.appendChild(suffix);

  // Same in-row delete entry point as a sketch/song's (no admin gate here —
  // a manual media row has no backing archive files, so openManuscriptDeleteWarning
  // skips that sentence for it; see manusRowIsManualMedia there).
  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'manus-select-remove';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Slet';
  removeBtn.setAttribute('aria-label', `Slet ${manusRowTitle(row)}`);
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openManuscriptDeleteWarning(row);
  });
  el.appendChild(removeBtn);

  const open = () => openVideoBandsangModal(row);
  el.addEventListener('click', open);
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
  });

  return el;
}

// Opens the create form for a new manual video/bandsang row — the row itself
// (same shape the old, now-removed Aktfordeling "+ Tilføj scene" modal used
// to build) is only pushed into manusDraft.rows once its own "Gem" is
// clicked with a non-empty title (see openVideoBandsangModal's isNew
// branch); closing the modal without saving discards it, nothing is placed.
function addManualMediaRow(manualType) {
  const row = {
    key: manusNextKey(),
    origin: 'manual',
    lane: 'pool',
    manualName: manualType === 'bandsang' ? 'Bandsang: ' : 'Video: ',
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
  };
  openVideoBandsangModal(row, { isNew: true });
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
  const pointBtnRow = document.createElement('div');
  pointBtnRow.className = 'manus-select-panel-btn-row';
  for (const type of MANUS_TYPES) {
    const pointBtn = document.createElement('button');
    pointBtn.type = 'button';
    pointBtn.className = 'site-pill-btn site-pill-warm';
    pointBtn.textContent = MANUS_TYPE_COLUMN_LABEL[type];
    pointBtn.addEventListener('click', () => openPointEntryModal(type));
    pointBtnRow.appendChild(pointBtn);
  }
  pointGroup.appendChild(pointBtnRow);
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

// Its own card, stacked below Udvælgelse in the same (third) column — see
// renderSelectTab()'s .manus-select-col-stack wrapper — rather than a panel
// inside Udvælgelse, so it reads as a peer of Sange/Sketches, not a control
// tucked under "Udvælgelse". Videos/band jingles never come from an upload
// (data/manuscripts.json is sketch/sang only), so this is the only place to
// create one. Lists every such row regardless of lane (placed or not), same
// "show everything of this kind" convention as the Sange/Sketches columns,
// and the `(N)` header count mirrors theirs too — unlike there, every row
// here is selected by construction (renderVideoBandsangRow), so the count is
// simply every row's count, not a filtered "selected so far" one.
function renderMediaColumn() {
  const section = document.createElement('section');
  section.className = 'card manus-column';

  const mediaRows = manusDraft.rows
    .filter(manusRowIsManualMedia)
    .slice()
    .sort((a, b) => manusRowTitle(a).localeCompare(manusRowTitle(b), 'da'));

  const header = document.createElement('div');
  header.className = 'manus-col-header';
  const h2 = document.createElement('h2');
  h2.textContent = 'Videoer & Bandsange';
  header.appendChild(h2);
  const count = document.createElement('span');
  count.className = 'manus-col-count';
  count.textContent = `(${mediaRows.length})`;
  header.appendChild(count);
  section.appendChild(header);

  const list = document.createElement('div');
  list.className = 'manus-col-list';
  if (!mediaRows.length) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen videoer eller bandsange endnu.';
    list.appendChild(empty);
  } else {
    for (const row of mediaRows) list.appendChild(renderVideoBandsangRow(row));
  }
  section.appendChild(list);

  const btnRow = document.createElement('div');
  btnRow.className = 'manus-select-panel-btn-row manus-media-btn-row';
  const videoBtn = document.createElement('button');
  videoBtn.type = 'button';
  videoBtn.className = 'site-pill-btn site-pill-warm';
  videoBtn.textContent = 'Video';
  videoBtn.addEventListener('click', () => addManualMediaRow('video'));
  btnRow.appendChild(videoBtn);
  const bandBtn = document.createElement('button');
  bandBtn.type = 'button';
  bandBtn.className = 'site-pill-btn site-pill-warm';
  bandBtn.textContent = 'Bandsang';
  bandBtn.addEventListener('click', () => addManualMediaRow('bandsang'));
  btnRow.appendChild(bandBtn);
  section.appendChild(btnRow);

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

  // Fixed-height modal with the list area as its own scroll region (like
  // openPointEntryModal's .manus-points-list) — the shared `actions` bar
  // with the Gem button below `form` stays visible without scrolling.
  const scrollMount = document.createElement('div');
  scrollMount.className = 'manus-select-overlay-scroll';
  form.appendChild(scrollMount);

  const listsMount = document.createElement('div');
  listsMount.className = 'manus-select-overlay-lists';
  scrollMount.appendChild(listsMount);

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

  // Third column is a stack of two cards (Udvælgelse, then Videoer &
  // Bandsange below it) rather than a single grid item, so the latter reads
  // as its own section without disturbing the Sange/Sketches columns' widths.
  const col3 = document.createElement('div');
  col3.className = 'manus-select-col-stack';
  col3.appendChild(renderSelectionColumn());
  col3.appendChild(renderMediaColumn());
  columns.appendChild(col3);

  mount.appendChild(columns);
}

// Builds one act's header+body block (unstyled position — the caller places
// it into the grid or a stack wrapper, see renderActColumnsGrid below).
function buildActColumn(act, buildColumnBody, rowFilter = null) {
  const col = document.createElement('div');
  col.className = 'manus-kanban-col';

  const header = document.createElement('div');
  header.className = 'manus-kanban-col-header';
  const label = document.createElement('span');
  label.className = 'manus-akt-label';
  label.textContent = act.label;
  header.appendChild(label);
  const rowsInAct = rowFilter ? manusDraftRowsForLane(act.code).filter(rowFilter) : manusDraftRowsForLane(act.code);
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
// just the body's own strip — see wireLaneDropZone(). `rowFilter`, when
// given, narrows both the "N scener" header count and rowsInAct together
// (via buildActColumn) — used by Rollefordeling/Manus/Stjerneark to exclude
// manual video/bandsang rows (manusRowIsManualMedia) from a tab they have no
// cast/roles/script relevance in; Aktfordeling passes none, so those rows
// still count and render there.
function renderActColumnsGrid(buildColumnBody, columns = manusDraft.acts.length, rowFilter = null) {
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
      const col = buildActColumn(group[0], buildColumnBody, rowFilter);
      col.style.gridColumn = String(colIdx + 1);
      grid.appendChild(col);
      return;
    }
    const stack = document.createElement('div');
    stack.className = 'manus-kanban-col-stack';
    stack.style.gridColumn = String(colIdx + 1);
    for (const act of group) stack.appendChild(buildActColumn(act, buildColumnBody, rowFilter));
    grid.appendChild(stack);
  });

  return grid;
}

// ── Tab 2: Aktfordeling — act columns in a row, "Ikke placeret" below ──
// Bandsang/Video never come from an uploaded submission (data/manuscripts.json
// is sketch/sang only) — the "Videoer & Bandsange" card in the Vælg scener
// tab's third column (see addManualMediaRow()/renderMediaColumn() below) is
// the only way to get one into the pipeline at all, so it can end up in the
// generated Aktoversigt/Manuskript output. A new row lands straight
// in "Ikke placeret" (appliedSelected: true — there's no prior placement to
// protect, unlike a Vælg-scener submission, so no staging delay is needed)
// ready to be dragged into an act like any other row.
function renderAktfordelingTab() {
  const mount = document.getElementById('manus-tab-aktfordeling');
  mount.textContent = '';

  const kanban = renderActColumnsGrid((body, act, rowsInAct, col) => {
    for (const row of rowsInAct) body.appendChild(renderDraftRowCard(row));
    // Trailing phantom card so "drop after the last card" gets the same
    // insertion-line feedback as dropping between two real ones — see
    // renderDropTailCard(). The whole column (header + body) still also
    // accepts a drop as a fallback (dropping on a specific card still
    // inserts before it — renderDraftRowCard's own dragover/drop, which
    // stopPropagation()s so it wins over this).
    body.appendChild(renderDropTailCard(act.code));
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

  poolSection.appendChild(poolHeader);

  const poolGrid = document.createElement('div');
  poolGrid.className = 'manus-kanban-pool-grid';
  poolGrid.style.gridTemplateColumns = `repeat(${manusDraft.acts.length}, minmax(220px, 1fr))`;
  if (!poolRows.length) {
    const empty = document.createElement('p');
    empty.className = 'manus-col-empty';
    empty.textContent = 'Ingen uplacerede scener.';
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

  const anyPlaced = manusAnyNonMediaPlaced();
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
  }, undefined, row => !manusRowIsManualMedia(row)));
}

// ── Tab: Manus (script text) ─────────────────────────────────────
// Reuses the same per-act kanban (renderActColumnsGrid) and button-opens-
// overlay pattern as Rollefordeling (openRoleSceneModal/renderRoleSceneButton
// above) — a scene is a button; clicking it opens an overlay with a small
// header textarea (revyname/revyyear/title/author/melody, see below), a
// read-only "Roller" reference list (renderRoleSummaryList(), which
// \says{}/\sings{} labels exist), and a plain monospace textarea for the
// scene's actual LaTeX body (row.scriptBody — everything that goes between
// \begin{sketch}/\begin{song} and \end{...} in the .tex
// scripts/generate-pdfs.js builds).
// \revyname{}/\revyyear{} let a scene keep its original production's name/
// year (e.g. a sketch actually performed in 2024) instead of always falling
// back to the current one — generate-pdfs.js already prioritizes
// scene.sourceProduction/sourceYear over the current production, this is
// just the UI that sets them. `status` was also tried and cut for being too
// much to fill in per scene; scenes.json/generate-pdfs.js still support it
// (safe to omit), just nothing in this UI sets it. Both textareas mutate the
// row directly, no draft rebuild — same as the cast editor above.
function manusRowIsSong(row) {
  const t = manusRowType(row);
  return t === 'sang' || t === 'bandsang';
}

// The header field's raw LaTeX-line text, built fresh every time the modal
// opens (or the auto-import backfill lands) from the row's current
// sourceProduction/sourceYear/title/writtenBy/melody — the same
// "reconstruct from the row, don't persist the textarea's own text"
// convention Rollefordeling's role textarea uses (formatRolesText).
// \revyname{}/\revyyear{} are blank by default (every scene today) — left
// blank, manusRowScene omits them from the saved scene entirely, so
// generate-pdfs.js keeps falling back to the current production's name/
// year. \melody{} only appears for a song-typed row.
function manusBuildHeaderText(row) {
  const lines = [
    `\\revyname{${row.sourceProduction || ''}}`,
    `\\revyyear{${row.sourceYear || ''}}`,
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
// \revyname{}/\revyyear{}/\author{}/\melody{} clear normally when emptied
// (clearing revyname/revyyear reverts the scene to the current production's
// name/year, since manusRowScene omits an empty sourceProduction/sourceYear).
function manusApplyHeaderText(row, text) {
  row.sourceProduction = extractTexRevyname(text);
  row.sourceYear = extractTexRevyyear(text);
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
  headerTextarea.rows = manusRowIsSong(row) ? 5 : 4;
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
  form.appendChild(siteEditField('Revynavn / år / titel / forfatter' + (manusRowIsSong(row) ? ' / melodi' : '') + ' (LaTeX)', headerTextarea));

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

// Create/edit view for a "Videoer & Bandsange" row (renderVideoBandsangRow/
// addManualMediaRow above) — same header (\revyname{}/\revyyear{}/\title{}/
// \author{}[/\melody{}]) + scriptBody-textarea shape as openScriptSceneModal,
// reusing its
// manusBuildHeaderText/manusRowIsSong helpers (manusRowIsSong now also
// covers 'bandsang' — see its own doc comment), plus a Roller field (raw
// editable \role{} lines, same textarea-as-LaTeX convention as
// Rollefordeling's own openRoleSceneModal — see manusApplyMediaRolesText
// below) between the header and the manus body, since these scenes do get
// cast eventually even though they never go through the Rollefordeling tab
// itself. A brand-new row (`isNew: true`) seeds Roller/Manus from a
// type-specific placeholder template (manusMediaDefaultRolesText/
// manusMediaDefaultScriptText) instead of starting empty — editing an
// existing row always shows its real current content instead. The manus
// body textarea is shorter for video than bandsang/sketch/song (`rows`
// below) — a video's own manus text is usually just a short cue, not a full
// script. Unlike openScriptSceneModal, no field is live-bound: everything is
// staged in the textareas and only applied to `row` when "Gem" is clicked,
// which also requires a non-empty \title{} (everything else is optional) —
// for a new row that Gem click is also the moment it actually gets pushed
// into manusDraft.rows and becomes visible; closing via X/Escape beforehand
// discards it with no trace, same as the old "+ Tilføj scene" modal's
// up-front validation, just against the richer LaTeX fields instead of a
// plain Titel input.
function manusMediaDefaultRolesText(manualType) {
  return manualType === 'bandsang'
    ? '\\role{S1} Sanger\n\\role{S2} Sanger'
    : '\\role{R} Revyst\n\\role{C} Revyst\n\\role{L} Revyst\n\\role{A} Revyst';
}

function manusMediaDefaultScriptText(manualType) {
  return manualType === 'bandsang'
    ? '\\sings{S1}[Vers] Wow, sikke en god sang vi skal til at synge\n\n\\sings{S2}[Omkvæd] Håber publikum kan lide vores tema i år'
    : '\\says{C} Er det ikke lidt lang tid siden vi har haft en video?\n\\says{A} Jo! Og det her sceneskift ville passe helt perfekt!\n\\scene{Tenikken viser en sjov video på AV}\n\\says{R} Damn, vi kan sku stadig finde ud af at lave gode videoer\n\\says{L} Virkelig, men nu tror jeg også næste scene er klar til at gå på';
}

// Mirrors openRoleSceneModal's "Opdater roller" handler exactly (see its own
// doc comment) — parses the textarea's \role{}[] lines back into row.cast,
// carrying each roleCode's existing tags forward (a genuinely new roleCode
// still gets a classifyOrKeep() default).
function manusApplyMediaRolesText(row, text) {
  const isSong = manusRowIsSong(row);
  const isDans = manusRowIsDans(row);
  const previousTagsByCode = new Map(row.cast.map(c => [c.roleCode, c.tags || []]));
  row.cast = parseRolesText(text).map(r => {
    const existing = previousTagsByCode.get(r.roleCode);
    const tags = existing && existing.length ? existing.slice() : [classifyOrKeep(r.roleCode, isSong, isDans)];
    return { name: r.name, roleCode: r.roleCode, description: r.description, tags };
  });
}

function openVideoBandsangModal(row, { isNew = false } = {}) {
  const title0 = isNew ? (row.manualType === 'bandsang' ? 'Ny bandsang' : 'Ny video') : manusRowTitle(row);
  const { modal, form, error, actions, close } = siteOpenModalWithClose(title0);
  modal.classList.add('manus-script-modal');

  const headerTextarea = document.createElement('textarea');
  headerTextarea.className = 'manus-script-textarea manus-script-header-textarea';
  headerTextarea.rows = manusRowIsSong(row) ? 5 : 4;
  headerTextarea.spellcheck = false;
  headerTextarea.value = manusBuildHeaderText(row);
  form.appendChild(siteEditField('Revynavn / år / titel / forfatter' + (manusRowIsSong(row) ? ' / melodi' : '') + ' (LaTeX)', headerTextarea));

  const rolesTextarea = document.createElement('textarea');
  rolesTextarea.className = 'manus-script-textarea manus-script-roles-textarea';
  rolesTextarea.rows = manusRowType(row) === 'video' ? 4 : 3;
  rolesTextarea.spellcheck = false;
  rolesTextarea.value = isNew ? manusMediaDefaultRolesText(row.manualType) : formatRolesText(row.cast);
  form.appendChild(siteEditField('Roller (LaTeX)', rolesTextarea));

  const bodyTextarea = document.createElement('textarea');
  bodyTextarea.className = 'manus-script-textarea';
  bodyTextarea.rows = manusRowType(row) === 'video' ? 8 : 20;
  bodyTextarea.spellcheck = false;
  bodyTextarea.value = isNew ? manusMediaDefaultScriptText(row.manualType) : (row.scriptBody || '');
  form.appendChild(siteEditField('Manus (LaTeX)', bodyTextarea));

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'site-pill-btn site-pill-primary';
  saveBtn.textContent = 'Gem';
  actions.appendChild(saveBtn);

  saveBtn.addEventListener('click', () => {
    if (!extractTexTitle(headerTextarea.value)) {
      error.textContent = 'Udfyld en titel.';
      return;
    }
    manusApplyHeaderText(row, headerTextarea.value);
    manusApplyMediaRolesText(row, rolesTextarea.value);
    row.scriptBody = bodyTextarea.value;
    if (isNew) manusDraft.rows.push(row);
    close();
    renderSelectTab();
  });
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

  const anyPlaced = manusAnyNonMediaPlaced();
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
  }, undefined, row => !manusRowIsManualMedia(row)));
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

  const anyPlaced = manusAnyNonMediaPlaced();
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
  }, 3, row => !manusRowIsManualMedia(row)));
}

// ── Program tab (Medvirkende / Ordliste / QR-koder → Program.pdf) ──
// Architecturally independent of manusDraft (entirely scene-scoped) — its
// own resource, own shadow (getEffectiveProgram, above), own "Gem" button.
// A local mutable clone, built once on first visit to the tab and only
// reset to null after a successful save — so switching to another Main
// Manus View tab and back preserves an in-progress edit within the same
// page session (mirrors manusDraft's "only rebuilt after a successful
// save" rule, scoped to just this tab).
let programDraft = null;
let programDragId = null;

function programNextId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// Splices `id` out of `arr` (matched by .id) and re-inserts it right before
// `beforeId` (or at the end when null) — the no-lane simplification of
// manusMoveRow above, since every Program list is a single flat array with
// no lane concept.
function programMoveInArray(arr, id, beforeId) {
  const idx = arr.findIndex((x) => x.id === id);
  if (idx === -1) return;
  const [item] = arr.splice(idx, 1);
  if (beforeId) {
    const beforeIdx = arr.findIndex((x) => x.id === beforeId);
    arr.splice(beforeIdx === -1 ? arr.length : beforeIdx, 0, item);
  } else {
    arr.push(item);
  }
}

// Makes `rowEl` both a drag source and a drop target within `arr` (its own
// backing array — a category list, a single category's name list, the
// ordliste list, or the qrCodes list) — reuses wireDropHighlight's own
// enter/leave/drop handling (and .manus-akt-row's existing drop-indicator
// CSS) exactly like Aktfordeling's own rows do.
function programWireRowDrag(rowEl, id, arr, onMoved) {
  rowEl.draggable = true;
  rowEl.addEventListener('dragstart', (e) => {
    programDragId = id;
    e.dataTransfer.effectAllowed = 'move';
  });
  wireDropHighlight(rowEl, () => {
    if (programDragId && programDragId !== id) {
      programMoveInArray(arr, programDragId, id);
      programDragId = null;
      onMoved();
    }
  }, { stop: true });
}

function programRemoveBtn(title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'manus-select-remove';
  btn.textContent = '✕';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.addEventListener('click', onClick);
  return btn;
}

function programDragHandle() {
  const handle = document.createElement('span');
  handle.className = 'manus-akt-drag-handle';
  handle.textContent = '⠿';
  return handle;
}

function renderProgramNameRow(cat, person) {
  const row = document.createElement('div');
  row.className = 'manus-akt-row manus-program-name-row';
  row.appendChild(programDragHandle());

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.className = 'manus-program-input';
  nameInput.placeholder = 'Navn';
  nameInput.value = person.name;
  nameInput.addEventListener('input', () => { person.name = nameInput.value; });
  row.appendChild(nameInput);

  const noteInput = document.createElement('input');
  noteInput.type = 'text';
  noteInput.className = 'manus-program-input manus-program-note-input';
  noteInput.placeholder = 'Note (valgfri, fx Boss)';
  noteInput.value = person.note || '';
  noteInput.addEventListener('input', () => { person.note = noteInput.value; });
  row.appendChild(noteInput);

  row.appendChild(programRemoveBtn(`Slet ${person.name || 'navn'}`, () => {
    cat.names = cat.names.filter((n) => n.id !== person.id);
    renderProgramTab();
  }));

  programWireRowDrag(row, person.id, cat.names, renderProgramTab);
  return row;
}

function renderProgramCategoryRow(cat) {
  const wrap = document.createElement('div');
  wrap.className = 'manus-program-cat-row';

  const header = document.createElement('div');
  header.className = 'manus-akt-row manus-program-cat-header';
  header.appendChild(programDragHandle());

  const catInput = document.createElement('input');
  catInput.type = 'text';
  catInput.className = 'manus-program-input manus-program-cat-input';
  catInput.placeholder = 'Kategori (fx Koordinatorer)';
  catInput.value = cat.category;
  catInput.addEventListener('input', () => { cat.category = catInput.value; });
  header.appendChild(catInput);

  header.appendChild(programRemoveBtn(`Slet kategorien ${cat.category || 'uden navn'}`, () => {
    programDraft.medvirkende = programDraft.medvirkende.filter((c) => c.id !== cat.id);
    renderProgramTab();
  }));

  wrap.appendChild(header);
  programWireRowDrag(header, cat.id, programDraft.medvirkende, renderProgramTab);

  const nameList = document.createElement('div');
  nameList.className = 'manus-program-name-list';
  cat.names.forEach((person) => nameList.appendChild(renderProgramNameRow(cat, person)));
  wrap.appendChild(nameList);

  const addNameBtn = document.createElement('button');
  addNameBtn.type = 'button';
  addNameBtn.className = 'manus-program-add-name-btn';
  addNameBtn.textContent = '+ Navn';
  addNameBtn.addEventListener('click', () => {
    cat.names.push({ id: programNextId(), name: '', note: '' });
    renderProgramTab();
  });
  wrap.appendChild(addNameBtn);

  return wrap;
}

function renderProgramMedvirkendeSection() {
  const section = document.createElement('section');
  section.className = 'card manus-program-section';
  const h2 = document.createElement('h2');
  h2.textContent = 'Medvirkende';
  section.appendChild(h2);

  const list = document.createElement('div');
  list.className = 'manus-program-cat-list';
  programDraft.medvirkende.forEach((cat) => list.appendChild(renderProgramCategoryRow(cat)));
  section.appendChild(list);

  const addCatBtn = document.createElement('button');
  addCatBtn.type = 'button';
  addCatBtn.className = 'site-pill-btn site-pill-warm';
  addCatBtn.textContent = '+ Kategori';
  addCatBtn.addEventListener('click', () => {
    programDraft.medvirkende.push({ id: programNextId(), category: '', names: [] });
    renderProgramTab();
  });
  section.appendChild(addCatBtn);

  return section;
}

function renderProgramTermRow(entry) {
  const row = document.createElement('div');
  row.className = 'manus-akt-row manus-program-term-row';
  row.appendChild(programDragHandle());

  const termInput = document.createElement('input');
  termInput.type = 'text';
  termInput.className = 'manus-program-input';
  termInput.placeholder = 'Ord';
  termInput.value = entry.term;
  termInput.addEventListener('input', () => { entry.term = termInput.value; });
  row.appendChild(termInput);

  const defInput = document.createElement('textarea');
  defInput.className = 'manus-program-input manus-program-def-input';
  defInput.rows = 1;
  defInput.placeholder = 'Forklaring';
  defInput.value = entry.definition;
  defInput.addEventListener('input', () => { entry.definition = defInput.value; });
  row.appendChild(defInput);

  row.appendChild(programRemoveBtn(`Slet ordet ${entry.term || 'uden navn'}`, () => {
    programDraft.ordliste = programDraft.ordliste.filter((o) => o.id !== entry.id);
    renderProgramTab();
  }));

  programWireRowDrag(row, entry.id, programDraft.ordliste, renderProgramTab);
  return row;
}

function renderProgramOrdlisteSection() {
  const section = document.createElement('section');
  section.className = 'card manus-program-section';
  const h2 = document.createElement('h2');
  h2.textContent = 'Ordliste';
  section.appendChild(h2);

  const hint = document.createElement('p');
  hint.className = 'manus-col-empty';
  hint.textContent = 'Sorteres alfabetisk automatisk, når Program.pdf bygges — rækkefølgen her er kun til redigering.';
  section.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'manus-program-term-list';
  programDraft.ordliste.forEach((entry) => list.appendChild(renderProgramTermRow(entry)));
  section.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'site-pill-btn site-pill-warm';
  addBtn.textContent = '+ Ord';
  addBtn.addEventListener('click', () => {
    programDraft.ordliste.push({ id: programNextId(), term: '', definition: '' });
    renderProgramTab();
  });
  section.appendChild(addBtn);

  return section;
}

function renderProgramQrRow(qr) {
  const row = document.createElement('div');
  row.className = 'manus-akt-row manus-program-qr-row';
  row.appendChild(programDragHandle());

  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  labelInput.className = 'manus-program-input';
  labelInput.placeholder = 'Label (fx Sangtekster)';
  labelInput.value = qr.label;
  labelInput.addEventListener('input', () => { qr.label = labelInput.value; });
  row.appendChild(labelInput);

  const urlInput = document.createElement('input');
  urlInput.type = 'url';
  urlInput.className = 'manus-program-input';
  urlInput.placeholder = 'https://...';
  urlInput.value = qr.url;
  const updateUrlValidity = () => {
    urlInput.classList.toggle('manus-program-input-invalid', !!urlInput.value && !/^https?:\/\//i.test(urlInput.value));
  };
  urlInput.addEventListener('input', () => { qr.url = urlInput.value; updateUrlValidity(); });
  updateUrlValidity();
  row.appendChild(urlInput);

  row.appendChild(programRemoveBtn(`Slet QR-koden ${qr.label || 'uden navn'}`, () => {
    programDraft.qrCodes = programDraft.qrCodes.filter((q) => q.id !== qr.id);
    renderProgramTab();
  }));

  programWireRowDrag(row, qr.id, programDraft.qrCodes, renderProgramTab);
  return row;
}

function renderProgramQrSection() {
  const section = document.createElement('section');
  section.className = 'card manus-program-section';
  const h2 = document.createElement('h2');
  h2.textContent = 'QR-koder';
  section.appendChild(h2);

  const hint = document.createElement('p');
  hint.className = 'manus-col-empty';
  hint.textContent = 'QR-koden tegnes automatisk ud fra linket, når Program.pdf bygges — der uploades ikke selve billedet.';
  section.appendChild(hint);

  const list = document.createElement('div');
  list.className = 'manus-program-qr-list';
  programDraft.qrCodes.forEach((qr) => list.appendChild(renderProgramQrRow(qr)));
  section.appendChild(list);

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'site-pill-btn site-pill-warm';
  addBtn.textContent = '+ QR-kode';
  addBtn.addEventListener('click', () => {
    programDraft.qrCodes.push({ id: programNextId(), label: '', url: '' });
    renderProgramTab();
  });
  section.appendChild(addBtn);

  return section;
}

// Trims every field and drops rows the admin added but never filled in at
// all (an untouched blank "+ Kategori"/"+ Ord"/"+ QR-kode" row) — anything
// with *some* content survives verbatim, including a partially-filled row,
// so a genuine mistake (e.g. a name with no category) is caught by
// save_program's own server-side validation and surfaced as an error,
// rather than silently dropped here.
function programBuildSavePayload() {
  const medvirkende = programDraft.medvirkende
    .map((c) => ({
      id: c.id,
      category: c.category.trim(),
      names: c.names
        .map((n) => ({ id: n.id, name: n.name.trim(), note: (n.note || '').trim() }))
        .filter((n) => n.name || n.note),
    }))
    .filter((c) => c.category || c.names.length);

  const ordliste = programDraft.ordliste
    .map((o) => ({ id: o.id, term: o.term.trim(), definition: (o.definition || '').trim() }))
    .filter((o) => o.term || o.definition);

  const qrCodes = programDraft.qrCodes
    .map((q) => ({ id: q.id, label: q.label.trim(), url: (q.url || '').trim() }))
    .filter((q) => q.label || q.url);

  return { medvirkende, ordliste, qrCodes };
}

async function saveProgram(saveBtn, errorEl) {
  saveBtn.disabled = true;
  errorEl.textContent = '';
  const payload = programBuildSavePayload();
  const result = await siteSaveResource('program', payload);
  if (result.ok) {
    programOverride = payload;
    siteSaveOverride('program', payload);
    programDraft = null;
    renderProgramTab();
    siteShowToast('Program gemt');
  } else {
    saveBtn.disabled = false;
    errorEl.textContent = result.message;
  }
}

function renderProgramSaveRow() {
  const row = document.createElement('div');
  row.className = 'manus-program-actions';

  const error = document.createElement('span');
  error.className = 'manus-main-view-error';
  row.appendChild(error);

  const saveBtn = document.createElement('button');
  saveBtn.type = 'button';
  saveBtn.className = 'site-pill-btn site-pill-primary';
  // "Gem Program", not a bare "Gem" — this sits directly above
  // #manus-main-view-actions' own "Gem" (the separate scenes/cast save), so
  // a plain "Gem" here would read as a second, confusingly identical button.
  saveBtn.textContent = 'Gem Program';
  saveBtn.addEventListener('click', () => saveProgram(saveBtn, error));
  row.appendChild(saveBtn);

  return row;
}

function renderProgramTab() {
  const mount = document.getElementById('manus-tab-program');
  mount.textContent = '';
  if (!programDraft) programDraft = structuredClone(getEffectiveProgram());

  const hint = document.createElement('p');
  hint.className = 'manus-col-empty';
  hint.textContent = 'Gem herunder, og klik derefter "Generér PDF\'er" (i Aktfordeling) for at opdatere Program.pdf.';
  mount.appendChild(hint);

  mount.appendChild(renderProgramMedvirkendeSection());
  mount.appendChild(renderProgramOrdlisteSection());
  mount.appendChild(renderProgramQrSection());
  mount.appendChild(renderProgramSaveRow());
}

// ── Tab bar + section chrome ───────────────────────────────────
const MANUS_MAIN_TABS = [
  { key: 'select', label: 'Scener', render: renderSelectTab },
  { key: 'aktfordeling', label: 'Aktfordeling', render: renderAktfordelingTab },
  { key: 'rollefordeling', label: 'Rollefordeling', render: renderRollefordelingTab },
  { key: 'manus', label: 'Manus', render: renderManusTextTab },
  { key: 'stjerneark', label: 'Stjerneark', render: renderStjerneArkTab },
  { key: 'program', label: 'Program', render: renderProgramTab },
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
  if (manusResourceSaveInFlight) return;
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
  manusResourceSaveInFlight = true;
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
      manusResourceSaveInFlight = false;
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
  manusResourceSaveInFlight = false;
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
  // "Manus gemt" only fires here, once the real GitHub commit has actually
  // landed — the earlier renderAll() above already optimistically shows the
  // saved content (so there's no flash back to stale data, and edits made
  // while this request was in flight safely landed in a fresh, separately
  // detached manusDraft rather than racing this save), but the toast itself
  // used to fire at that same optimistic point, before either network call
  // had even been sent — moved here on request, since a failed save was
  // only ever visible afterward as small inline text near the button, easy
  // to miss once a "saved" toast had already been seen.
  siteShowToast('Manus gemt');
  renderMainViewActions();
}

// ── PDF regeneration status (pulse + last-generated badge) ────
// There is no server-side "build finished" signal available to the client —
// the site's GitHub token has no Actions permission to poll workflow status,
// so save_manus() returning ok just means the scenes.json/cast.json commit
// landed, not that generate-pdfs.yml has actually run pdflatex yet. The only
// way to detect real completion is to watch one of the generated files'
// real git commit history (via the public GitHub Commits API — see
// manusFetchPdfStatus below for why a same-origin HEAD request's
// Last-Modified header doesn't work here) for a change versus a snapshot
// taken right before triggering. Manuskript.pdf is used as that reference
// file since it's the last file the build produces before the workflow's
// single end-of-job commit, and every file in that commit goes live
// together. This is plain in-memory state, not synced
// through the server — a page reload mid-poll silently drops back to idle
// (same accepted limitation as manusDraft's own dirty tracking elsewhere in
// this file), and another visitor's tab never sees this tab's pulse.
// True only while a manus-resource write (the scenes.json+cast.json PUT
// itself, via siteSaveResource) is actually in flight — set by both
// manusSaveMain() and manusRegeneratePdfs(), since they write the exact
// same two files and nothing else prevented them from racing each other:
// clicking "Generér PDF'er" right after "Gem" (or vice versa, mid-Gem)
// used to fire a second, concurrent PUT against the same files, which
// could read a stale sha and come back as a confusing 409 conflict on
// whichever one lost the race — even though Gem's own optimistic "Manus
// gemt" toast had already fired. Deliberately narrower than
// manusPdfGenerating (which also spans the multi-minute post-write poll,
// during which no further writes happen and other saves are meant to stay
// possible — see the PDF quick-link buttons staying clickable during
// generation, below).
let manusResourceSaveInFlight = false;
let manusPdfGenerating = false;
let manusPdfTimestampLoaded = false;
let manusPdfLastGeneratedAt = null; // Date | null
let manusPdfConfirmedAbsent = false; // true only when the file has no commit history at all — distinct from "couldn't check"
let manusPdfCheckFailed = false; // true when the check itself couldn't run/complete at all
// true only when manusPollPdfCompletion gave up after MANUS_PDF_POLL_TIMEOUT_MS without
// ever observing a newer commit touching Manuskript.pdf — kept distinct from the idle state
// so the UI can say so explicitly instead of silently looking identical to a real success.
// Cleared at the start of the next manusRegeneratePdfs() call.
let manusPdfPollTimedOut = false;

// A genuine "never generated" (empty commit history for the path) is
// reported distinctly from "couldn't check" (thrown fetch, a non-2xx from
// the GitHub API — e.g. rate-limited, or fetch() flatly refusing file://
// URLs with "URL scheme file is not supported", the same file://
// limitation documented at the top of this file for the login endpoint):
// only the former is safe to ever surface as "Endnu ikke genereret" —
// silently mapping a failed check to that same message would misreport a
// file that actually exists. checkFailed gets its own visible fallback
// text below rather than staying blank, so a file:// visitor (or one
// hitting GitHub's unauthenticated API rate limit) sees an honest "Ukendt"
// instead of what looks like a missing feature.
//
// Deliberately queries the GitHub Commits API scoped to this exact file
// path, rather than the deployed file's own Last-Modified/ETag headers
// (an earlier version did a same-origin HEAD request instead): GitHub
// Pages sets those headers to when the *site* was last redeployed, not
// when that specific file's content last actually changed — confirmed
// live 2026-08-21 by checking a completely unrelated, untouched file
// (CNAME, last really changed 2026-07-10) and finding its Last-Modified
// header still read as "today." Since *any* push to main redeploys the
// whole site (a scenes.json/cast.json commit, embed-scenes.yml's fast
// commit, ...), that HEAD-based check could — and did — report "changed"
// well before generate-pdfs.yml's own commit (the one that actually
// produces new PDF bytes) had even landed, showing "PDF'erne er
// opdateret" before it was true. The Commits API's `path` filter reflects
// real git history for that one file, immune to unrelated redeploys. This
// is a public repo, so no auth token is needed — but unauthenticated
// requests are capped at 60/hour per IP, hence the poll interval/timeout
// below being sized to stay well under that even for one full-length poll.
async function manusFetchPdfStatus(path) {
  if (!path) return { date: null, confirmedAbsent: false, checkFailed: true };
  try {
    const res = await fetch(
      `${MANUS_COMMITS_API_BASE}?path=${encodeURIComponent(path)}&per_page=1`,
      { cache: 'no-store' }
    );
    if (!res.ok) return { date: null, confirmedAbsent: false, checkFailed: true };
    const commits = await res.json();
    if (!Array.isArray(commits) || !commits.length) return { date: null, confirmedAbsent: true, checkFailed: false };
    const date = new Date(commits[0].commit.committer.date);
    return { date: isNaN(date.getTime()) ? null : date, confirmedAbsent: false, checkFailed: isNaN(date.getTime()) };
  } catch (e) {
    return { date: null, confirmedAbsent: false, checkFailed: true };
  }
}

// Repo-relative path, not a URL — fed to the GitHub Commits API's `path`
// filter above (also happens to be the same string a browser HEAD request
// against the deployed site would have used, back when this checked
// Last-Modified headers instead — kept the name to avoid touching every
// call site over a cosmetic rename).
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
  // Checked before manusPdfLastGeneratedAt so a timed-out poll always reads
  // as "we couldn't confirm this" rather than silently falling back to
  // whatever (now stale) timestamp was last known.
  if (manusPdfPollTimedOut) return 'Kunne ikke bekræfte om PDF’erne er opdateret endnu — tjek "Tjek om klar" på Koordinator-siden om lidt';
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

// 15s, not the earlier 10s: manusFetchPdfStatus now hits GitHub's
// unauthenticated Commits API (60 requests/hour per IP) instead of a plain
// same-origin HEAD request, so the interval is sized to keep a single
// full-length poll comfortably under that ceiling (see
// MANUS_PDF_POLL_TIMEOUT_MS below) — a real concern given this is used by a
// small group who may share one venue/rehearsal WiFi's public IP.
const MANUS_PDF_POLL_INTERVAL_MS = 15000;
// A generous backstop, not the primary completion signal: the real pipeline
// is a fresh commit → generate-pdfs.yml (queue + compile) → a second commit
// → a GitHub Pages redeploy, so it can legitimately take a couple of
// minutes, especially under concurrent Actions load — confirmed live
// 2026-08-21 at ~2.5 minutes end-to-end for a normal run (see CLAUDE.md for
// the per-step timing breakdown). 10 minutes at the 15s interval above caps
// a single full-timeout poll at 40 requests, safely under the 60/hour
// unauthenticated ceiling; this was 20 minutes when the check was still a
// free same-origin HEAD request with no rate limit to worry about. The
// timeout branch below says so explicitly instead of silently reverting to
// idle as if generation had succeeded.
const MANUS_PDF_POLL_TIMEOUT_MS = 10 * 60 * 1000;

function manusPollPdfCompletion(beforeDate, url) {
  const startedAt = Date.now();
  const beforeTime = beforeDate ? beforeDate.getTime() : null;

  const tick = async () => {
    if (Date.now() - startedAt > MANUS_PDF_POLL_TIMEOUT_MS) {
      manusPdfGenerating = false;
      manusPdfPollTimedOut = true;
      renderManusPdfLinksSection();
      renderMainViewActions();
      siteShowToast('Kunne ikke bekræfte at PDF’erne er opdateret — tjek Koordinator-siden om lidt');
      return;
    }
    const current = await manusFetchPdfStatus(url);
    const currentTime = current.date ? current.date.getTime() : null;
    if (currentTime !== null && currentTime !== beforeTime) {
      manusPdfGenerating = false;
      manusPdfPollTimedOut = false;
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
// server always stamps a fresh `generatedAt` timestamp on every save
// (save_manus() in update-data.php), so this reliably produces a fresh,
// non-empty commit even with zero real content change (a bare `version`
// re-stamp alone used to only manage this on the first save of each
// calendar day — see CLAUDE.md). The three buttons below all call this
// same function. The `regeneratePdfs: true` flag sent below is what
// actually asks generate-pdfs.yml to run: save_manus() turns it into a
// `[regen-pdfs]` commit-message marker, which the workflow's job-level
// `if:` checks for — a plain Gem (manusSaveMain, no flag) still saves
// normally but leaves the last-generated PDFs untouched, so frequent
// in-progress Gem clicks don't each force a ~2.5 min CI regen:
// "full rebuild every time" was a deliberate choice over a --only flag,
// since Manuskript is a merge of every other scene PDF and a partial
// rebuild risks the three documents drifting out of sync with each other.
async function manusRegeneratePdfs() {
  if (manusPdfGenerating || manusResourceSaveInFlight) return;

  const errEl = manusMainViewErrorEl();
  if (errEl) errEl.textContent = '';
  manusPdfPollTimedOut = false;

  const referenceUrl = manusPdfReferenceUrl();
  const before = (await manusFetchPdfStatus(referenceUrl)).date;

  manusPdfGenerating = true;
  manusResourceSaveInFlight = true;
  renderManusPdfLinksSection();
  renderMainViewActions();

  const scenesActs = manusCurrentActsPayload();
  const castRoster = manusBuildCastRoster(scenesActs);
  const result = await siteSaveResource('manus', { scenes: scenesActs, cast: castRoster, regeneratePdfs: true });
  manusResourceSaveInFlight = false;
  if (!result.ok) {
    manusPdfGenerating = false;
    renderManusPdfLinksSection();
    renderMainViewActions();
    const el = manusMainViewErrorEl();
    if (el) el.textContent = result.message;
    return;
  }
  // The write itself has landed — re-enable Gem even though manusPdfGenerating
  // (and the button's own pulse) stays true for the whole polling phase below,
  // since that phase does no further writes and other saves are meant to
  // stay possible while PDFs regenerate in the background.
  renderMainViewActions();
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
  generateBtn.disabled = manusPdfGenerating || manusResourceSaveInFlight;
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
  saveBtn.disabled = manusResourceSaveInFlight;
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

  // GitHub Pages serves everything under archive/ with a 10-minute
  // Cache-Control (confirmed live: max-age=600, via the Fastly CDN in
  // front of Pages). manusFetchPdfStatus's own HEAD check bypasses this
  // with {cache: 'no-store'}, so the completion poll/toast are honest about
  // when the file actually changed server-side — but a plain window.open()
  // here is a normal navigation, subject to that same 10-minute cache, so a
  // browser that had ever opened this exact URL before could still serve
  // the pre-regeneration bytes straight from its own cache for up to that
  // long after the poll already confirmed the real file was updated
  // (reported live 2026-08-21). Appending manusPdfLastGeneratedAt as a
  // cache-busting query string forces a fresh fetch exactly when this tab's
  // own last-known-good timestamp actually changes (i.e. right after a
  // regeneration this tab observed), while still letting repeat clicks
  // between regenerations reuse the cache normally. Falls back to
  // Date.now() before that timestamp has ever loaded. Doesn't help a tab
  // that never observed a newer regeneration at all (e.g. another
  // coordinator's tab triggered it) — same accepted cross-tab limitation as
  // the pulse/poll state themselves (see the "PDF regeneration status"
  // comment above).
  const openFile = (filename) => {
    const bust = manusPdfLastGeneratedAt ? manusPdfLastGeneratedAt.getTime() : Date.now();
    window.open(`archive/${folder}/${filename}?v=${bust}`, '_blank');
  };

  const linkRow = document.createElement('div');
  linkRow.className = 'manus-pdf-links-row';

  const files = [
    ['Aktfordeling', 'Aktoversigt.pdf'],
    ['Rollefordeling', 'Rolleoversigt.pdf'],
    ['Manus', 'Manuskript.pdf'],
    ['Program', 'Program.pdf'],
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
    // "Sangboss" is a fixed pseudo-person (every song, regardless of cast —
    // see scripts/generate-pdfs.js's buildSangbossManuskript), not a
    // data/cast.json roster entry, so it's added here rather than sourced
    // from getEffectiveCastData(); pinned first since it's always relevant.
    const names = getEffectiveCastData()
      .map((c) => c.name)
      .slice()
      .sort((a, b) => a.localeCompare(b, 'da'));
    const options = ['Sangboss', ...names].map((name) => ({ value: name, label: name }));
    siteOpenDropdownPicker(individualBtn, options, null, (name) => {
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
  stayBtn.textContent = 'Bliv';
  stayBtn.addEventListener('click', close);

  const leaveBtn = document.createElement('button');
  leaveBtn.className = 'site-pill-btn site-pill-danger';
  leaveBtn.textContent = 'Forlad';
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
