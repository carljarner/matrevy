/* =========================================================
   Matematikrevyen – Koordinator (koordinator.html)

   Admin-only cross-cutting tools. First tool: closing out the current
   production year in Manus and starting the next one — see "Afslut
   revyen" below. Øveplan (schedule.js)
   has no server-side state of its own to touch (it's purely
   localStorage-based, per schedule.js's own architecture notes), so
   nothing here needs to reach it directly; it just picks up the reset
   data the next time someone opens it fresh.

   This page deliberately does NOT load js/manus.js (it's wired to
   manus.html's own DOM and would throw here) or js/scenes-data.js/
   js/manuscripts-data.js (the reset payloads below don't need to read
   current scenes/cast/manuscripts content — see koordCloseYear). The
   small PDF-freshness-poll helpers are therefore duplicated from
   manus.js rather than cross-file-reused, same rationale as every
   other page-scoped duplication in this codebase (import.js/
   schedule.js/manus.js's own triple-duplicated role-classification
   logic, scripts/generate-pdfs.js's own copy, etc).

   Second tool: an "Arkiv" section for managing data/archive.json's
   years directly from here (archive.js's own openYearEditor()/
   deleteYear() exist but were never wired to any UI on arkiv.html).
   This page also does NOT load js/archive.js (same reasoning as
   above — it's wired to arkiv.html's own #arkiv-list DOM), so the
   handful of plain, DOM-independent helpers it needs (slug/path
   building, file-to-base64, cover re-encoding) are duplicated here
   too rather than cross-file-reused.

   Third tool: "Masterplan" — a checklist grid (data/masterplan.json)
   replacing an externally-maintained spreadsheet of recurring
   production to-dos, grouped into 5 fixed phase-tabs. See the
   "Masterplan" section below.

   Rendering rule (as elsewhere): createElement/textContent only,
   never innerHTML.
   ========================================================= */

'use strict';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// ── Archive data (with a localStorage-backed shadow after a save) ──
let koordArchiveOverride = siteLoadOverride('archive');

function getEffectiveArchiveYears() {
  return koordArchiveOverride || ARCHIVE_DATA;
}

const ARCHIVE_MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // mirrors archive.js's own constant

// ── Archive year name -> folder/path helpers (duplicated verbatim from
// archive.js — see file header) ────────────────────────────────
function slugifyFolderName(name) {
  const map = { æ: 'ae', ø: 'oe', å: 'aa', Æ: 'Ae', Ø: 'Oe', Å: 'Aa' };
  let s = name.trim().replace(/[æøåÆØÅ]/g, (ch) => map[ch]);
  s = s.replace(/\s+/g, '_').replace(/[^A-Za-z0-9_-]/g, '');
  s = s.replace(/^[_-]+|[_-]+$/g, '');
  return s;
}

function buildArchivePath(folder, kind) {
  if (kind === 'cover') return `archive/${folder}/cover.jpg`;
  return `archive/${folder}/manus.pdf`; // kind === 'manus'
}

function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result); // "data:<mime>;base64,<data>"
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function stripDataUrlPrefix(dataUrl) {
  const i = dataUrl.indexOf(',');
  return i === -1 ? dataUrl : dataUrl.slice(i + 1);
}

// Cover photos are always re-encoded to JPEG so the stored filename/extension
// never changes across re-uploads (overwrite-in-place, no orphan-cleanup
// needed for a changed extension).
async function compressCoverImage(file, { maxWidth = 1600, quality = 0.8 } = {}) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// Full-array-replace save, mirroring archive.js's own saveYears() — keeps the
// localStorage-backed override shadow (siteLoadOverride/siteSaveOverride) in
// sync so this tab reflects the change immediately, before the worker
// regenerates archive-data.js.
async function saveArchiveYears(next) {
  const result = await siteSaveResource('archive', { years: next });
  if (result.ok) {
    koordArchiveOverride = next;
    siteSaveOverride('archive', next);
    renderArkivSection();
  }
  return result;
}

// ── PDF freshness check (mirrors manus.js's manusFetchPdfStatus) ──
// One-shot check behind the "Tjek om klar" button: does the file exist, and
// when was it last written? Same-origin HEAD via siteFileStatus
// (site-utils.js) — on the server a file's Last-Modified only changes when
// that file is actually rewritten.
async function koordFetchPdfStatus(path) {
  const { exists, date, checkFailed } = await siteFileStatus(path);
  return {
    date,
    confirmedAbsent: !exists && !checkFailed,
    checkFailed: checkFailed || (exists && !date),
  };
}

function koordCurrentFolder() {
  return (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
}

function koordPdfReferenceUrl() {
  const folder = koordCurrentFolder();
  return folder ? `archive/${folder}/manus.pdf` : null;
}

function koordFormatGeneratedAt(date) {
  const datePart = date.toLocaleDateString('da-DK', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Copenhagen' });
  const timePart = date.toLocaleTimeString('da-DK', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Copenhagen' });
  return `Sidst genereret: ${datePart} kl. ${timePart}`;
}

// ── Small helpers ────────────────────────────────────────────
// UTF-8-safe text -> base64, for siteUploadFile (which expects raw base64,
// no "data:...;base64," prefix) — btoa() alone chokes on non-Latin1
// characters (æøå), and a scenes.json snapshot is easily too large for a
// spread-based one-shot String.fromCharCode call, hence the chunked loop.
function koordTextToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// "MatRevy_2026" -> "MatRevy 2026" — just a starting-point guess for the
// closing year's archive-entry display name, freely editable in the modal.
function koordGuessNameFromFolder(folder) {
  return folder.replace(/_/g, ' ').trim();
}

// "MatRevy_2026" -> "MatRevy_2027" — increments the first 4-digit run found
// in the folder name, a starting-point guess for the new production folder,
// freely editable in the modal. Falls back to the bare folder name (with no
// suggested change) if no 4-digit year is found in it.
function koordSuggestNextFolder(folder) {
  const m = folder.match(/\d{4}/);
  if (!m) return folder;
  const nextYear = String(Number(m[0]) + 1);
  return folder.slice(0, m.index) + nextYear + folder.slice(m.index + m[0].length);
}

// Prefill guess for "Start ny revy"'s own folder field. The normal case is
// right after "Afslut revyen" already cleared currentProductionFolder, so
// there's no active folder left to increment from — falls back to the
// newest Arkiv year's own folder instead (koordCloseYear always creates or
// reuses one for the folder it just closed, and saveArchiveYears keeps this
// page's own override cache fresh, so this reflects that closed year
// immediately, no reload needed). Only when Arkiv has no years at all (a
// brand-new deploy) does this come back empty.
function koordGuessNextProductionFolder(currentFolder) {
  if (currentFolder) return koordSuggestNextFolder(currentFolder);
  const years = getEffectiveArchiveYears();
  if (!years.length) return '';
  const newest = years.slice().sort((a, b) => b.year - a.year)[0];
  return koordSuggestNextFolder(newest.folder);
}

function koordPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

// ── Arkiv section (edit/delete data/archive.json years) ──
// The card itself only ever shows one button — Rediger, opening a dropdown
// picker (same primitive as Manus's own "Manus" quick-link picker) that
// lists every existing year. No year list is ever shown directly on this
// page, and there's no "+ Tilføj" here — every entry a Koordinator admin
// needs already gets created automatically by koordCloseYear/
// koordStartNewYear (see openKoordYearEditor's own comment); a year outside
// that (e.g. hand-fixing a much older entry) is still addable via Arkiv's
// own page.
function renderArkivSection() {
  const container = document.getElementById('koord-arkiv-body');
  if (!container) return;
  container.textContent = '';

  container.appendChild(el('span', null, 'Rediger arkivet.'));

  const editBtn = el('button', 'btn-small', 'Rediger');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => openArkivYearPicker(editBtn));
  container.appendChild(editBtn);
}

// Dropdown popup listing every year (newest first), same primitive as
// manus.js's "Manus" quick-link cast picker (siteOpenDropdownPicker).
// Picking a year opens the editor for that entry.
function openArkivYearPicker(anchor) {
  const years = getEffectiveArchiveYears().slice().sort((a, b) => b.year - a.year);
  const options = years.map((y) => ({ value: y.folder, label: y.name }));
  siteOpenDropdownPicker(anchor, options, null, (value) => {
    const entry = getEffectiveArchiveYears().find((y) => y.folder === value);
    if (entry) openKoordYearEditor(entry);
  });
}

// Near-duplicate of archive.js's openYearEditor(existing) (see file header
// for why it's not cross-file-reused), trimmed down per Koordinator's own
// simpler needs: no cover-image preview (just a link to the current file),
// no manuscript upload (manusPdf is always the CI-generated
// archive/<folder>/manus.pdf, derived automatically — see
// scripts/generate-pdfs.js), and X-close/green-Gem-pill chrome instead of
// the shared edit-modal's Annuller/blue-Gem pair. Edit-only — Koordinator's
// own picker (openArkivYearPicker above) never offers "+ Tilføj"; adding a
// year here would duplicate koordCloseYear/koordStartNewYear's own
// guarded-create logic for no real benefit, since every entry a Koordinator
// admin needs already gets created automatically by those two flows.
function openKoordYearEditor(existing) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Rediger årgang');
  modal.classList.add('koord-year-edit-modal');

  const group = el('div', 'koord-year-edit-group');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'MatRevy 2024';
  nameInput.value = existing.name;

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = String(existing.year);

  const nameYearRow = el('div', 'koord-year-edit-row');
  nameYearRow.appendChild(siteEditField('Navn', nameInput));
  nameYearRow.appendChild(siteEditField('Årstal', yearInput));
  group.appendChild(nameYearRow);

  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.accept = 'image/*';
  coverInput.className = 'site-file-input';
  let pendingCover = null;
  coverInput.addEventListener('change', () => {
    pendingCover = coverInput.files[0] || null;
  });
  const coverRow = el('div', 'koord-year-edit-file-row');
  coverRow.appendChild(coverInput);
  if (existing.coverImage) {
    // .btn-small — same treatment as this page's own "Gå til Manus-siden"
    // link and Wiki's attachment links, rather than a plain blue &lt;a&gt;.
    const coverLink = document.createElement('a');
    coverLink.target = '_blank';
    coverLink.rel = 'noopener';
    coverLink.textContent = 'Nuværende cover-foto';
    coverLink.className = 'btn-small';
    coverLink.href = existing.coverImage;
    coverRow.appendChild(coverLink);
  }
  group.appendChild(siteEditField('Cover-foto (kvadratisk billede anbefalet)', coverRow));

  const youtubeInput = document.createElement('input');
  youtubeInput.type = 'url';
  youtubeInput.placeholder = 'https://www.youtube.com/watch?v=...';
  youtubeInput.value = existing.youtubeUrl || '';
  group.appendChild(siteEditField('Link til YouTube', youtubeInput));

  const spotifyInput = document.createElement('input');
  spotifyInput.type = 'url';
  spotifyInput.placeholder = 'https://open.spotify.com/album/...';
  spotifyInput.value = existing.spotifyUrl || '';
  group.appendChild(siteEditField('Link til Spotify', spotifyInput));

  const driveInput = document.createElement('input');
  driveInput.type = 'url';
  driveInput.placeholder = 'https://drive.google.com/drive/folders/...';
  driveInput.value = existing.driveUrl || '';
  group.appendChild(siteEditField('Link til Google Drive', driveInput));

  form.appendChild(group);

  const progress = el('div', 'koord-progress');
  form.appendChild(progress);

  const save = koordPillBtn('Gem', 'site-btn-success');

  const del = el('button', 'site-btn-danger edit-actions-left', 'Slet');
  del.type = 'button';
  del.addEventListener('click', () => { close(); openDeleteArchiveYearConfirm(existing); });
  actions.appendChild(del);
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    error.textContent = '';
    const name = nameInput.value.trim();
    if (!name) { error.textContent = 'Navnet er påkrævet.'; return; }

    const year = parseInt(yearInput.value, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      error.textContent = 'Angiv et gyldigt årstal (1900–2100).';
      return;
    }

    const current = getEffectiveArchiveYears();
    const folder = existing.folder; // stable, never re-derived from name/year

    if (pendingCover && pendingCover.size > ARCHIVE_MAX_UPLOAD_BYTES) {
      error.textContent = `Filen "${pendingCover.name}" er for stor (maks. 5 MB).`;
      return;
    }

    // manusPdf is never uploaded here — it's always the CI-generated file in
    // the year's own archive folder (scripts/generate-pdfs.js keeps it
    // fresh on every "Generér PDF'er" run in Manus).
    const entryDraft = {
      year,
      name,
      folder,
      coverImage: existing.coverImage || '',
      youtubeUrl: youtubeInput.value.trim(),
      spotifyUrl: spotifyInput.value.trim(),
      driveUrl: driveInput.value.trim(),
      manusPdf: `archive/${folder}/manus.pdf`,
    };

    save.disabled = true;

    if (pendingCover) {
      progress.textContent = 'Gemmer cover-foto…';
      const blob = await compressCoverImage(pendingCover);
      const dataUrl = await readFileAsDataURL(blob);
      const path = buildArchivePath(folder, 'cover');
      const result = await siteUploadFile(path, stripDataUrlPrefix(dataUrl));
      if (!result.ok) {
        save.disabled = false;
        progress.textContent = '';
        error.textContent = result.message;
        return;
      }
      entryDraft.coverImage = path;
    }
    progress.textContent = '';

    const next = current.map((e) => (e.folder === existing.folder ? entryDraft : e));

    const result = await saveArchiveYears(next);
    if (result.ok) {
      progress.textContent = 'Gemt!';
      save.textContent = 'Gemt';
      setTimeout(close, 1400);
    } else {
      save.disabled = false;
      error.textContent = result.message;
    }
  });

  nameInput.focus();
}

// Small custom confirm (not native confirm()) — matches the site's now-usual
// pattern for a destructive action (Wiki's openDeleteChapterConfirm,
// Kalender's openDeleteConfirm), rather than archive.js's older confirm()
// call which this replaces the intent of for Koordinator's own delete path.
function openDeleteArchiveYearConfirm(entry) {
  const { modal, form, error, actions, close } = siteOpenEditModal(`Slet "${entry.name}"?`);
  modal.classList.add('koord-arkiv-confirm-modal');

  form.appendChild(el('p', 'koord-arkiv-confirm-text', 'De tilhørende filer bliver ikke slettet.'));

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = koordPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    const next = getEffectiveArchiveYears().filter((e) => e.folder !== entry.folder);
    const result = await saveArchiveYears(next);
    if (result.ok) {
      close();
    } else {
      error.textContent = result.message || 'Kunne ikke slette årgangen.';
      cancelBtn.disabled = false;
      confirmBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Close-year sequence ──────────────────────────────────────
// Runs the steps of a Manus year-close in order, reporting progress via
// onProgress(text) before each step starts. Throws (with a Danish message)
// on the first failing step — every step here is either a pure read, a
// guarded-idempotent create, or a plain overwrite of a known target shape,
// so it's always safe to just fix the problem and re-run the whole sequence
// rather than needing any rollback logic (see the plan's own note on this).
//
// Deliberately does NOT pick a new production folder — it only closes the
// current one (clears currentProductionFolder back to '', which
// manus_current_production_folder() server-side treats as "no active
// production", blocking manuscripts_create). Starting the next production
// is a separate, explicit step — see koordStartNewYear below — so an admin
// can close a revy without immediately having to name the next one.
async function koordCloseYear({ closingFolder, closingName, closingYear }, onProgress) {
  onProgress('Henter nuværende scenes.json og cast.json...');
  const rawBase = '/';
  const [scenesText, castText] = await Promise.all([
    fetch(rawBase + 'data/scenes.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('Kunne ikke hente data/scenes.json.'); return r.text(); }),
    fetch(rawBase + 'data/cast.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('Kunne ikke hente data/cast.json.'); return r.text(); }),
  ]);

  const currentYears = getEffectiveArchiveYears();
  if (!currentYears.some((y) => y.folder === closingFolder)) {
    onProgress('Opretter arkiv-indgang for det afsluttende år...');
    const nextYears = currentYears.concat([{
      year: closingYear,
      name: closingName,
      folder: closingFolder,
      coverImage: '',
      youtubeUrl: '',
      spotifyUrl: '',
      driveUrl: '',
      manusPdf: `archive/${closingFolder}/manus.pdf`,
    }]);
    const archiveRes = await saveArchiveYears(nextYears);
    if (!archiveRes.ok) throw new Error(archiveRes.message || 'Kunne ikke oprette arkiv-indgangen.');
  }

  onProgress('Gemmer snapshot af scenes.json/cast.json i arkivet...');
  const scenesUpload = await siteUploadFile(`archive/${closingFolder}/snapshot/scenes.json`, koordTextToBase64(scenesText));
  if (!scenesUpload.ok) throw new Error(scenesUpload.message || 'Kunne ikke gemme snapshot af scenes.json.');
  const castUpload = await siteUploadFile(`archive/${closingFolder}/snapshot/cast.json`, koordTextToBase64(castText));
  if (!castUpload.ok) throw new Error(castUpload.message || 'Kunne ikke gemme snapshot af cast.json.');

  onProgress('Nulstiller scener og rollebesætning...');
  const resetActs = [
    { act: '1', label: 'Akt 1', scenes: [] },
    { act: '2', label: 'Akt 2', scenes: [] },
    { act: '3', label: 'Akt 3', scenes: [] },
    { act: 'E', label: 'Ekstranumre', scenes: [] },
  ];
  const manusRes = await siteSaveResource('manus', { scenes: resetActs, cast: [] });
  if (!manusRes.ok) throw new Error(manusRes.message || 'Kunne ikke nulstille manus (scenes.json/cast.json).');

  onProgress('Nulstiller indsendte manuskripter...');
  const manuscriptsRes = await siteSaveResource('manuscripts', { submissions: [] });
  if (!manuscriptsRes.ok) throw new Error(manuscriptsRes.message || 'Kunne ikke nulstille indsendte manuskripter.');

  onProgress('Lukker den aktive produktionsmappe...');
  // Resets "Vis PDF'er for revyster" back to hidden and "Luk for uploads"
  // back to open in the same write, so the next production cycle starts
  // private-but-open again — see manus.js's own renderAdminSettings. An
  // empty currentProductionFolder is a valid, deliberate state — see
  // save_config()'s own comment server-side and
  // manus_current_production_folder(), which treats '' as "no active
  // production" and rejects manuscripts_create with no_production_folder.
  const configRes = await siteSaveResource('config', { currentProductionFolder: '', pdfLinksVisibleToRevyst: false, sketchUploadsClosedForRevyst: false, songUploadsClosedForRevyst: false });
  if (!configRes.ok) throw new Error(configRes.message || 'Kunne ikke lukke produktionsmappen.');

  onProgress('Færdig!');
}

// Sets a new active production folder — the second, separate half of the
// old combined "close + start" flow (see koordCloseYear above). Run on its
// own, with no reset of scenes/cast/manuscripts, since koordCloseYear
// already did that when the previous production closed; this step just
// re-opens the door for revyst uploads under the new folder name.
//
// Also updates data/scenes.json's own top-level `production` field (e.g.
// "MatRevy 2027") — a completely different string from
// currentProductionFolder's archive-folder slug ("MatRevy_2027"), but the
// one scripts/generate-pdfs.js actually prints as \revyname{}/\revyyear{}
// on every generated PDF's title page. Left untouched by koordCloseYear
// (which only ever resets acts/cast), so without this every PDF generated
// for the new production would keep printing the old year until someone
// noticed and hand-edited the JSON.
async function koordStartNewYear(newFolder, productionName, productionYear, onProgress) {
  onProgress('Opdaterer produktionsnavn...');
  const prodRes = await siteSaveResource('production', { name: productionName, year: String(productionYear) });
  if (!prodRes.ok) throw new Error(prodRes.message || 'Kunne ikke opdatere produktionsnavnet.');

  // Formularer's own "Revy" field (and its Oversigt year filter's label)
  // sources its option list from Arkiv (ARCHIVE_DATA) — see
  // formsRevyOptions()'s own comment there, which assumes "the current
  // production always has an Arkiv entry." That used to hold automatically
  // (a folder was always hand-seeded into Arkiv before anything targeted
  // it), but koordCloseYear only ever creates an Arkiv entry for the
  // folder it's *closing*, not the one being started here — so without
  // this, a brand-new production had no Arkiv entry until it was archived
  // in turn, and nothing could target it from Formularer in the meantime
  // (confirmed live: MatRevy 2027 was unselectable in the form builder,
  // and showed as a bare "2027" — no Arkiv name to look up — in Oversigt's
  // own year filter). Guarded exactly like koordCloseYear's own
  // idempotent create, reusing the same productionName/productionYear
  // this step already collected.
  const currentYears = getEffectiveArchiveYears();
  if (!currentYears.some((y) => y.folder === newFolder)) {
    onProgress('Opretter arkiv-indgang for den nye produktion...');
    const nextYears = currentYears.concat([{
      year: productionYear,
      name: productionName,
      folder: newFolder,
      coverImage: '',
      youtubeUrl: '',
      spotifyUrl: '',
      driveUrl: '',
      manusPdf: `archive/${newFolder}/manus.pdf`,
    }]);
    const archiveRes = await saveArchiveYears(nextYears);
    if (!archiveRes.ok) throw new Error(archiveRes.message || 'Kunne ikke oprette arkiv-indgangen.');
  }

  onProgress('Skifter til den nye produktionsmappe...');
  const configRes = await siteSaveResource('config', { currentProductionFolder: newFolder, pdfLinksVisibleToRevyst: false, sketchUploadsClosedForRevyst: false, songUploadsClosedForRevyst: false });
  if (!configRes.ok) throw new Error(configRes.message || 'Kunne ikke skifte produktionsmappe.');
  onProgress('Færdig!');
}

// Trin 1 of the old modal: a guide for checking the final files are ready
// (the PDF-generation reminder + "Tjek om klar" freshness check) — now
// rendered directly into the Manus card itself rather than hidden behind
// the "Afslut" button, since it's just a check, not a destructive action.
// Only the actual archiving step (openCloseYearModal below) still needs a
// modal.
function renderKoordCloseYearGuide(container) {
  container.appendChild(el('h3', 'koord-step-heading koord-step-heading-first', 'Klargør filerne'));
  container.appendChild(el('p', null,
    'Færdiggør alle rettelser i Manus, og klik der på "Generér PDF\'er". Det genkompilerer hver scenes .tex/.pdf med den ' +
    'endelige tekst og rollebesætning og gemmer dem i arkivet. Bekræft herunder, at det er landet, ' +
    'før du afslutter revyen nedenfor.'));
  const checkRow = el('div', 'koord-check-row');
  const checkBtn = el('button', 'btn-small', 'Tjek om klar');
  checkBtn.type = 'button';
  const statusText = el('span', 'koord-status-value', '');
  checkBtn.addEventListener('click', async () => {
    checkBtn.disabled = true;
    statusText.textContent = 'Tjekker...';
    const { date, confirmedAbsent, checkFailed } = await koordFetchPdfStatus(koordPdfReferenceUrl());
    if (date) statusText.textContent = koordFormatGeneratedAt(date);
    else if (confirmedAbsent) statusText.textContent = 'Endnu ikke genereret';
    else if (checkFailed) statusText.textContent = 'Sidst genereret: ukendt';
    checkBtn.disabled = false;
  });
  checkRow.appendChild(checkBtn);
  checkRow.appendChild(statusText);
  container.appendChild(checkRow);
}

// ── Modals ────────────────────────────────────────────────────
// Opened by the "Afslut revyen" subtitle's "Afslut" button — archives the
// current production and closes it (see koordCloseYear above; the guide
// that used to precede this as the modal's own "Trin 1" now sits inline in
// the guide card, see renderKoordCloseYearGuide above). Deliberately does
// NOT pick a new production folder — that's "Start ny revy" below, a
// separate step so closing a revy doesn't force naming the next one in the
// same breath.
function openCloseYearModal(closingFolder) {
  const { modal, form, error, actions, close } = siteOpenEditModal('Afslut revyen');
  modal.classList.add('koord-close-year-modal');

  const intro = el('p', 'koord-modal-intro',
    `Dette nulstiller Manus (scener, rollebesætning, indsendte manuskripter), gemmer et snapshot af den nuværende produktion ("${closingFolder}") i arkivet, og lukker den aktive produktionsmappe — revyster kan herefter ikke indsende manuskripter, før en ny revy startes.`);
  form.appendChild(intro);

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = koordGuessNameFromFolder(closingFolder);
  form.appendChild(siteEditField('Afsluttende års navn (til arkivet)', nameInput));

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  const yearMatch = closingFolder.match(/\d{4}/);
  yearInput.value = yearMatch ? yearMatch[0] : '';
  form.appendChild(siteEditField('Afsluttende års årstal', yearInput));

  const progress = el('div', 'koord-progress');
  form.appendChild(progress);

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = koordPillBtn('Afslut revyen', 'site-btn-success');
  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    const closingName = nameInput.value.trim();
    const closingYear = Number(yearInput.value);

    if (!closingName) { error.textContent = 'Angiv et navn til det afsluttende år.'; return; }
    if (!Number.isInteger(closingYear) || closingYear < 1900 || closingYear > 2100) {
      error.textContent = 'Angiv et gyldigt årstal.';
      return;
    }

    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    try {
      await koordCloseYear(
        { closingFolder, closingName, closingYear },
        (text) => { progress.textContent = text; }
      );
      // CONFIG_DATA is this tab's embedded snapshot from page load — it has
      // no localStorage override mechanism (unlike calendar/archive/posts/
      // wiki/manus), so the status cards above can't reflect the closed
      // production folder until a reload picks up the regenerated
      // config-data.js (a few seconds after the save, once the worker has
      // re-embedded it). Say so explicitly rather than silently re-rendering
      // a status card that would still show the old folder.
      progress.textContent = 'Revyen er afsluttet, og produktionsmappen er lukket. Genindlæs siden for at se det afspejlet ovenfor.';
      siteShowToast('Revyen er afsluttet');
      cancelBtn.textContent = 'Luk';
      cancelBtn.disabled = false;
    } catch (e) {
      error.textContent = e.message || 'Der opstod en fejl. Det er trygt at prøve igen — allerede fuldførte trin gentages uden problemer.';
      cancelBtn.disabled = false;
      confirmBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Opened by the "Start ny revy" subtitle's "Start" button — the second,
// separate half of the old combined close+start flow (see
// koordStartNewYear above). `currentFolder` is whatever's active right now
// (usually '' after "Afslut revyen" has run, but not enforced — an admin
// can also use this to rename/redirect the active production without
// closing it first, hence the warning below when one's already set).
function openStartNewYearModal(currentFolder) {
  const { modal, form, error, actions, close } = siteOpenEditModal('Start ny revy');
  modal.classList.add('koord-close-year-modal');

  const intro = el('p', 'koord-modal-intro', currentFolder
    ? `Der er allerede en aktiv produktionsmappe ("${currentFolder}"). Dette skifter til en ny uden at arkivere eller nulstille den nuværende — brug "Afslut revyen" først, medmindre du er sikker på at det ikke er nødvendigt.`
    : 'Gør en ny mappe til den aktive produktion, så revyster igen kan indsende manuskripter til Manus.');
  form.appendChild(intro);

  const guessedFolder = koordGuessNextProductionFolder(currentFolder);
  const guessedYearMatch = guessedFolder.match(/\d{4}/);
  const guessedYear = guessedYearMatch ? guessedYearMatch[0] : '';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  // "MatRevy <year>" matches archive.json's own naming convention for every
  // historical entry ("MatRevy 2026", "MatRevy 2025", ...) — sent to the
  // server as-is (not rebuilt from the Årstal field below), a jubilee year
  // wants something else, freely editable like every other guessed field
  // on this page.
  nameInput.value = guessedYear ? `MatRevy ${guessedYear}` : 'MatRevy';
  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = guessedYear;
  // Same 2:1 side-by-side row as openKoordYearEditor's own Navn/Årstal
  // pair (koord-year-edit-row, reused verbatim — already exactly this
  // ratio, collapsing to stacked on mobile).
  const nameYearRow = el('div', 'koord-year-edit-row');
  nameYearRow.appendChild(siteEditField('Navn', nameInput));
  nameYearRow.appendChild(siteEditField('Årstal', yearInput));
  form.appendChild(nameYearRow);

  const newFolderInput = document.createElement('input');
  newFolderInput.type = 'text';
  newFolderInput.value = guessedFolder;
  form.appendChild(siteEditField('Ny produktionsmappe', newFolderInput));

  const progress = el('div', 'koord-progress');
  form.appendChild(progress);

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = koordPillBtn('Start ny revy', 'site-btn-success');
  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    const productionName = nameInput.value.trim();
    const productionYear = Number(yearInput.value);
    const newFolder = newFolderInput.value.trim();

    if (!productionName) { error.textContent = 'Angiv revyens navn.'; return; }
    if (!Number.isInteger(productionYear) || productionYear < 1900 || productionYear > 2100) {
      error.textContent = 'Angiv et gyldigt årstal.';
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(newFolder)) {
      error.textContent = 'Produktionsmappen må kun indeholde bogstaver, tal, "_" og "-".';
      return;
    }
    if (newFolder === currentFolder) {
      error.textContent = 'Den nye produktionsmappe skal være forskellig fra den nuværende.';
      return;
    }

    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    try {
      await koordStartNewYear(newFolder, productionName, productionYear, (text) => { progress.textContent = text; });
      progress.textContent = `Ny produktionsmappe startet (${newFolder}). Genindlæs siden for at se det afspejlet ovenfor.`;
      siteShowToast('Ny produktionsmappe startet');
      cancelBtn.textContent = 'Luk';
      cancelBtn.disabled = false;
    } catch (e) {
      error.textContent = e.message || 'Der opstod en fejl. Det er trygt at prøve igen.';
      cancelBtn.disabled = false;
      confirmBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Note: the "Vis PDF'er for revyster" toggle that used to live here has
// moved to the bottom of manus.html (js/manus.js's
// manusRenderPdfVisibilityToggle, admin-only) — its natural home, since it
// governs what that page shows revyst-level visitors, not something
// Koordinator-specific.

// ── Masterplan (a checklist grid replacing an externally-maintained
// spreadsheet of recurring production to-dos, grouped into 5 fixed
// phase-tabs — Blok 4 / August / Blok 1 / Revyen / Efter revyen). Tab
// keys/labels are hardcoded here (mirrors manus.js's own MANUS_MAIN_TABS) —
// only each tab's row content is data (data/masterplan.json). One
// checklist is called a "plan" — one per production year (e.g. "MatRevy
// 2026", "MatRevy 2025", ...); the admin switches which plan is being
// viewed via a small "Viser plan for:" picker (same siteOpenDropdownPicker
// primitive as this file's own Arkiv year picker above), which also offers
// "+ Tilføj" to create a new plan. Always editable: every field writes
// straight into a local draft of the *currently viewed plan only*, and
// koordMpAutosave re-saves the whole plans array with that one entry
// replaced about a second after the last change. ──────
let koordMasterplanOverride = siteLoadOverride('masterplan');
function getEffectiveMasterplanDoc() {
  return koordMasterplanOverride || MASTERPLAN_DATA;
}
function getMasterplanPlans() {
  return getEffectiveMasterplanDoc().plans || [];
}
function sortedMasterplanPlans() {
  return getMasterplanPlans().slice().sort((a, b) => b.year - a.year || b.label.localeCompare(a.label, 'da'));
}

const KOORD_MP_TABS = [
  { key: 'blok4', label: 'Blok 4' },
  { key: 'august', label: 'August' },
  { key: 'blok1', label: 'Blok 1' },
  { key: 'revyen', label: 'Revyen' },
  { key: 'efterrevyen', label: 'Efter revyen' },
];

// Cycles unset -> mangler -> igang -> faerdig -> unset on click (red/yellow/
// green, matching the source spreadsheet's own Status column fills).
const KOORD_MP_STATUSES = [
  { value: '', label: '–' },
  { value: 'mangler', label: 'Mangler' },
  { value: 'igang', label: 'I gang' },
  { value: 'faerdig', label: 'Færdig' },
];

const KOORD_MP_TAB_KEY = 'matrevy-koord-mp-tab';
const koordMpStoredTab = localStorage.getItem(KOORD_MP_TAB_KEY);
let koordMpActiveTab = KOORD_MP_TABS.some((t) => t.key === koordMpStoredTab) ? koordMpStoredTab : KOORD_MP_TABS[0].key;

// Which plan is currently being viewed/edited — persisted in localStorage
// like budget.js's own budgetViewId, but with no "active" concept
// alongside it (unlike Budget, Masterplan has no revyst-facing submission
// flow that needs a single designated target — every plan is just an
// admin-viewed document).
const KOORD_MP_VIEW_KEY = 'matrevy-koord-mp-view';
let masterplanViewId = localStorage.getItem(KOORD_MP_VIEW_KEY);

// Resolves masterplanViewId against the real plan list — falls back to the
// newest plan (by year) if the stored id is missing/stale (a plan deleted
// elsewhere, or the very first load).
function resolveMasterplanViewId() {
  const plans = getMasterplanPlans();
  if (plans.some((p) => p.id === masterplanViewId)) return masterplanViewId;
  const newest = sortedMasterplanPlans()[0];
  return newest ? newest.id : null;
}

function getCurrentMasterplan() {
  const id = resolveMasterplanViewId();
  return getMasterplanPlans().find((p) => p.id === id) || null;
}

// Built once (a clone of getCurrentMasterplan(), i.e. just the single
// currently-viewed plan — not the whole multi-plan document) the first
// time the card renders after a fresh load/switch, and kept across
// auto-saves (rebuilding it would re-render under the caret).
// masterplanLastSavedSnapshot is the serialized draft as last sent to the
// server, compared against to tell whether anything is still unsaved.
let masterplanDraft = null;
let masterplanLastSavedSnapshot = '';
let koordMpDragItem = null;

function koordMpNewId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function koordMpEnsureDraft() {
  if (masterplanDraft) return;
  const plan = getCurrentMasterplan();
  masterplanDraft = plan ? structuredClone(plan) : null;
  masterplanLastSavedSnapshot = JSON.stringify(masterplanDraft);
}

function masterplanIsDirty() {
  return JSON.stringify(masterplanDraft) !== masterplanLastSavedSnapshot;
}

// Splices `item` out of `draft` and reinserts it just before `beforeItem`
// (or at the end if falsy) — duplicated verbatim from budget.js's own
// budgetMoveDraftItem (see that function's own header comment for the other
// existing duplicates of this same helper), per this codebase's
// per-feature duplication convention (koordinator.js doesn't load
// budget.js).
function koordMoveDraftItem(draft, item, beforeItem, rerender) {
  const idx = draft.indexOf(item);
  if (idx === -1) return;
  draft.splice(idx, 1);
  const beforeIdx = beforeItem ? draft.indexOf(beforeItem) : -1;
  if (beforeIdx === -1) draft.push(item);
  else draft.splice(beforeIdx, 0, item);
  rerender();
}

// A native drag lets the browser snapshot the dragged element itself as the
// drag image, which for a Masterplan row (7 columns' worth of text inputs)
// reads as a messy oversized preview rather than a clean one. Routes
// through one shared, off-screen (not display:none — that would keep it
// from being paintable) <div> instead, restyled right before dragstart
// calls setDragImage on it — see forms.js's formsGetDragImageEl for the
// page this pattern originated on. Unlike the single-line ghosts on other
// pages, a task row has no one title field, so the ghost shows up to three
// stacked lines (Emne/To do/Beskrivelse — the row's first three, most
// identifying columns) instead of picking just one.
function koordMpGetDragImageEl() {
  let ghost = document.getElementById('koord-mp-drag-image');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'koord-mp-drag-image';
    ghost.className = 'koord-mp-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

function koordMpDragGhostLines(row) {
  if (row.type === 'group') return [(row.title || '').trim() || 'Gruppe'];
  const lines = [row.emne, row.todo, row.beskrivelse].map((v) => (v || '').trim()).filter(Boolean);
  return lines.length ? lines : ['Opgave'];
}

// Duplicated verbatim from budget.js's own budgetWireDropHighlight.
function koordWireDropHighlight(rowEl, onDrop) {
  let depth = 0;
  rowEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    rowEl.classList.add('koord-mp-drop-target');
  });
  rowEl.addEventListener('dragover', (e) => { e.preventDefault(); }); // required for 'drop' to fire
  rowEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) rowEl.classList.remove('koord-mp-drop-target');
  });
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    rowEl.classList.remove('koord-mp-drop-target');
    onDrop();
  });
}

function koordMpStatusMeta(status) {
  return KOORD_MP_STATUSES.find((s) => s.value === status) || KOORD_MP_STATUSES[0];
}

function koordMpNextStatus(status) {
  const idx = KOORD_MP_STATUSES.findIndex((s) => s.value === status);
  return KOORD_MP_STATUSES[(idx + 1) % KOORD_MP_STATUSES.length].value;
}

// Small styled "Er du sikker?" confirm (mirrors openDeleteArchiveYearConfirm/
// openDeleteMasterplanPlanConfirm's own title+description shape) — `title`
// becomes the modal's real centered heading, `description` (optional) an
// extra centered/muted line below it. Used for every non-empty row removal
// here (group or task) — an empty row (see koordMpRowIsEmpty below) skips
// this entirely and deletes straight away, since there's nothing in it to
// lose.
function koordMpDeleteConfirm(title, description, onConfirm) {
  const { modal, form, actions, close } = siteOpenEditModal(title);
  modal.classList.add('koord-mp-confirm-modal');
  if (description) form.appendChild(el('p', 'koord-mp-confirm-text', description));
  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = koordPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// A row with nothing typed into it yet — removing it loses no real content,
// so the caller skips koordMpDeleteConfirm entirely for these.
function koordMpRowIsEmpty(row) {
  if (row.type === 'group') return !row.title || !row.title.trim();
  return !row.emne?.trim() && !row.todo?.trim() && !row.beskrivelse?.trim()
    && !row.ansvarA?.trim() && !row.ansvarB?.trim() && !row.status;
}

// Renders both the desktop flat-tab bar and a mobile dropdown, exact same
// pattern as manus.js's own renderTabBar/MANUS_MAIN_TABS (duplicated —
// koordinator.html doesn't load manus.js).
function renderMpTabBar() {
  const mount = document.getElementById('koord-mp-tab-bar');
  mount.textContent = '';

  const btnBar = el('div', 'koord-mp-tab-btn-bar');
  KOORD_MP_TABS.forEach((tab) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'koord-mp-tab-btn' + (tab.key === koordMpActiveTab ? ' active' : '');
    btn.textContent = tab.label;
    btn.addEventListener('click', () => {
      koordMpActiveTab = tab.key;
      localStorage.setItem(KOORD_MP_TAB_KEY, koordMpActiveTab);
      renderMpTabBar();
      renderMpGrid();
    });
    btnBar.appendChild(btn);
  });
  mount.appendChild(btnBar);

  const dropdown = siteCreateDropdownField(
    KOORD_MP_TABS.map((t) => ({ value: t.key, label: t.label })),
    koordMpActiveTab
  );
  dropdown.classList.add('koord-mp-tab-select-mobile');
  dropdown.setAttribute('aria-label', 'Vælg fane');
  dropdown.addEventListener('change', () => {
    koordMpActiveTab = dropdown.value;
    localStorage.setItem(KOORD_MP_TAB_KEY, koordMpActiveTab);
    renderMpTabBar();
    renderMpGrid();
  });
  mount.appendChild(dropdown);
}

// Called after every edit (cheap, also on every keystroke): queues an
// auto-save and repaints the status text — never rebuilds the grid
// (rebuilding on every input would steal focus mid-type).
function koordMpUpdateSaveStatus() {
  if (masterplanDraft && masterplanIsDirty()) koordMpAutosave.schedule();
  koordMpPaintSaveStatus();
}

let koordMpSaveError = null; // message of the last failed save, null when it succeeded

function koordMpPaintSaveStatus() {
  koordPaintAutosaveStatus(document.getElementById('koord-mp-save-status'),
    koordMpAutosave.isBusy(), koordMpSaveError, Boolean(masterplanDraft) && masterplanIsDirty());
}

// Shared by Masterplan and Lokalebooking: "Gemmer…" while a save is
// pending/in flight, the error after a failed one, "Gemt" once everything
// is on the server, and nothing for a draft not yet edited (Lokalebooking's
// pre-filled default rooms).
function koordPaintAutosaveStatus(status, busy, error, dirty) {
  if (!status) return;
  let text = 'Gemt';
  if (busy) text = 'Gemmer…';
  else if (error !== null) text = error ? `Ikke gemt: ${error}` : 'Ikke gemt';
  else if (dirty) text = '';
  status.textContent = text;
  status.className = 'koord-mp-save-status' + (!busy && error !== null ? ' dirty' : '');
}

function koordMpCreateField(row, key, className) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'koord-mp-field ' + className;
  input.value = row[key] || '';
  input.addEventListener('input', () => {
    row[key] = input.value;
    koordMpUpdateSaveStatus();
  });
  return input;
}

function koordMpWireRowDrag(rowEl, row, rows) {
  rowEl.draggable = true;
  rowEl.addEventListener('dragstart', (e) => {
    koordMpDragItem = row;
    e.dataTransfer.effectAllowed = 'move';
    const ghost = koordMpGetDragImageEl();
    ghost.replaceChildren(...koordMpDragGhostLines(row).map((line) => el('div', 'koord-mp-drag-image-line', line)));
    e.dataTransfer.setDragImage(ghost, 12, 16);
  });
  rowEl.addEventListener('dragend', () => rowEl.classList.remove('koord-mp-drop-target'));
  koordWireDropHighlight(rowEl, () => {
    if (koordMpDragItem && koordMpDragItem !== row) {
      koordMoveDraftItem(rows, koordMpDragItem, row, renderMpGrid);
      koordMpUpdateSaveStatus();
    }
  });
}

function renderMpGroupRow(row, rows) {
  const rowEl = el('div', 'koord-mp-row koord-mp-row-group');
  koordMpWireRowDrag(rowEl, row, rows);

  rowEl.appendChild(el('span', 'koord-mp-col-handle boss-manage-drag-handle', '⠿'));

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.className = 'koord-mp-field koord-mp-col-group-title';
  titleInput.placeholder = 'Overskrift (kan stå tom)';
  titleInput.value = row.title || '';
  titleInput.addEventListener('input', () => {
    row.title = titleInput.value;
    koordMpUpdateSaveStatus();
  });
  rowEl.appendChild(titleInput);

  const removeBtn = el('button', 'koord-mp-col-remove boss-manage-remove-btn', '✕');
  removeBtn.type = 'button';
  removeBtn.title = 'Fjern gruppe';
  removeBtn.addEventListener('click', () => {
    const remove = () => {
      const idx = rows.indexOf(row);
      if (idx !== -1) rows.splice(idx, 1);
      koordMpUpdateSaveStatus();
      renderMpGrid();
    };
    if (koordMpRowIsEmpty(row)) { remove(); return; }
    koordMpDeleteConfirm(
      `Fjern "${row.title}"?`,
      'Opgaverne under den bliver stående.',
      remove
    );
  });
  rowEl.appendChild(removeBtn);

  return rowEl;
}

function renderMpTaskRow(row, rows) {
  const rowEl = el('div', 'koord-mp-row koord-mp-row-task');
  koordMpWireRowDrag(rowEl, row, rows);

  rowEl.appendChild(el('span', 'koord-mp-col-handle boss-manage-drag-handle', '⠿'));
  rowEl.appendChild(koordMpCreateField(row, 'emne', 'koord-mp-col-emne'));
  rowEl.appendChild(koordMpCreateField(row, 'todo', 'koord-mp-col-todo'));
  rowEl.appendChild(koordMpCreateField(row, 'beskrivelse', 'koord-mp-col-besk'));
  rowEl.appendChild(koordMpCreateField(row, 'ansvarA', 'koord-mp-col-ansvar'));
  rowEl.appendChild(koordMpCreateField(row, 'ansvarB', 'koord-mp-col-ansvar'));

  const statusBtn = document.createElement('button');
  statusBtn.type = 'button';
  function paintStatus() {
    const meta = koordMpStatusMeta(row.status);
    statusBtn.textContent = meta.label;
    statusBtn.className = 'koord-mp-col-status koord-mp-status koord-mp-status-' + (row.status || 'none');
  }
  paintStatus();
  statusBtn.title = 'Klik for at skifte status';
  statusBtn.addEventListener('click', () => {
    row.status = koordMpNextStatus(row.status);
    paintStatus();
    koordMpUpdateSaveStatus();
  });
  rowEl.appendChild(statusBtn);

  const removeBtn = el('button', 'koord-mp-col-remove boss-manage-remove-btn', '✕');
  removeBtn.type = 'button';
  removeBtn.title = 'Fjern opgave';
  removeBtn.addEventListener('click', () => {
    const remove = () => {
      const idx = rows.indexOf(row);
      if (idx !== -1) rows.splice(idx, 1);
      koordMpUpdateSaveStatus();
      renderMpGrid();
    };
    if (koordMpRowIsEmpty(row)) { remove(); return; }
    const title = (row.todo || row.emne) ? `Fjern "${row.todo || row.emne}"?` : 'Fjern denne opgave?';
    koordMpDeleteConfirm(title, row.beskrivelse?.trim() || null, remove);
  });
  rowEl.appendChild(removeBtn);

  return rowEl;
}

// Structural render — rebuilds every row in the active tab. Called on tab
// switch, add/remove/drag, save, and reset; never on a plain keystroke (see
// koordMpCreateField/koordMpUpdateSaveStatus above).
function renderMpGrid() {
  const mount = document.getElementById('koord-mp-grid');
  mount.textContent = '';
  const rows = masterplanDraft.tabs[koordMpActiveTab];

  // Header row — the two Ansvar columns are fixed labels, not per-plan data
  // (see koordMpTabsFromPrevious): "Ansvarlig sidste revy" always shows who
  // held the role last time, "Ansvarlig" who holds it now, so a new plan's
  // "+ Tilføj" can shift last year's Ansvarlig into this column automatically.
  const header = el('div', 'koord-mp-row koord-mp-row-header');
  header.appendChild(el('span', 'koord-mp-col-handle'));
  header.appendChild(el('span', 'koord-mp-col-emne', 'Emne'));
  header.appendChild(el('span', 'koord-mp-col-todo', 'To do'));
  header.appendChild(el('span', 'koord-mp-col-besk', 'Beskrivelse'));
  header.appendChild(el('span', 'koord-mp-col-ansvar', 'Ansvarlig sidste revy'));
  header.appendChild(el('span', 'koord-mp-col-ansvar', 'Ansvarlig'));
  header.appendChild(el('span', 'koord-mp-col-status', 'Status'));
  header.appendChild(el('span', 'koord-mp-col-remove'));
  mount.appendChild(header);

  rows.forEach((row) => {
    mount.appendChild(row.type === 'group' ? renderMpGroupRow(row, rows) : renderMpTaskRow(row, rows));
  });

  // A per-row-only drop target can only ever insert *before* that row —
  // this trailing spacer is the only way to drop a row after the last one,
  // same drop-tail recipe as wiki.js's/manus.js's own reorderable lists.
  const tailRow = el('div', 'koord-mp-drop-tail');
  koordWireDropHighlight(tailRow, () => {
    if (koordMpDragItem) {
      koordMoveDraftItem(rows, koordMpDragItem, null, renderMpGrid);
      koordMpUpdateSaveStatus();
    }
  });
  mount.appendChild(tailRow);

  // Two plain icon "+" buttons (style.css's site-wide .boss-manage-add-plus,
  // same as Program's/Wiki's own add-row controls) instead of labelled
  // pills — Tilføj gruppe sits under the Emne column (koord-mp-add-row's own
  // padding-left matches the header row's post-handle offset), Tilføj
  // opgave is centered on the row as a whole (position:absolute — see CSS)
  // regardless of where the group button sits.
  const addRow = el('div', 'koord-mp-add-row');
  const addGroupBtn = document.createElement('button');
  addGroupBtn.type = 'button';
  addGroupBtn.className = 'boss-manage-add-plus koord-mp-add-group-btn';
  addGroupBtn.title = 'Tilføj gruppe';
  addGroupBtn.setAttribute('aria-label', 'Tilføj gruppe');
  addGroupBtn.textContent = '+';
  addGroupBtn.addEventListener('click', () => {
    rows.push({ id: koordMpNewId('g'), type: 'group', title: '' });
    koordMpUpdateSaveStatus();
    renderMpGrid();
  });
  const addTaskBtn = document.createElement('button');
  addTaskBtn.type = 'button';
  addTaskBtn.className = 'boss-manage-add-plus koord-mp-add-task-btn';
  addTaskBtn.title = 'Tilføj opgave';
  addTaskBtn.setAttribute('aria-label', 'Tilføj opgave');
  addTaskBtn.textContent = '+';
  addTaskBtn.addEventListener('click', () => {
    rows.push({ id: koordMpNewId('r'), type: 'task', emne: '', todo: '', beskrivelse: '', ansvarA: '', ansvarB: '', status: '' });
    koordMpUpdateSaveStatus();
    renderMpGrid();
  });
  addRow.appendChild(addGroupBtn);
  addRow.appendChild(addTaskBtn);
  mount.appendChild(addRow);
}

// Saves the whole plans array with the currently-viewed plan's entry
// replaced by the draft (full-array-replace, same convention as every
// other resource on this site). The plan is cloned from a snapshot so the
// shadow never shares arrays with the still-edited draft.
async function koordMpSaveNow() {
  if (!masterplanDraft) return { ok: true, message: '' };
  const snapshot = JSON.stringify(masterplanDraft);
  const draft = JSON.parse(snapshot);
  const updatedPlan = {
    id: draft.id,
    year: draft.year,
    label: draft.label,
    tabs: {},
  };
  KOORD_MP_TABS.forEach((tab) => { updatedPlan.tabs[tab.key] = draft.tabs[tab.key]; });
  const nextPlans = getMasterplanPlans().map((p) => (p.id === updatedPlan.id ? updatedPlan : p));

  const result = await siteSaveResource('masterplan', { plans: nextPlans });
  if (result.ok) {
    koordMasterplanOverride = { plans: nextPlans };
    siteSaveOverride('masterplan', koordMasterplanOverride);
    masterplanLastSavedSnapshot = snapshot;
  }
  return result;
}

const koordMpAutosave = siteCreateAutosave({
  save: koordMpSaveNow,
  onStatus(state, message) {
    if (state === 'saved') koordMpSaveError = null;
    else if (state === 'error') koordMpSaveError = message;
    koordMpPaintSaveStatus();
  },
});

// Any other full-array masterplan write (create/delete a plan) and a plan
// switch first wait for pending row edits, so the shadow they build on
// includes them. A failure is shown as a toast and aborts the action.
async function koordMpFlushOrWarn() {
  const result = await koordMpAutosave.flush();
  if (!result.ok && result.message) siteShowToast(`Masterplanen kunne ikke gemmes: ${result.message}`);
  return result.ok;
}

// Full top-level re-render — cheap (everything renders from local state),
// mirrors budget.js's own loadAndRenderAdmin() re-invocation on year
// switch. Used whenever which plan is being viewed changes.
function koordMpRerenderPage() {
  const root = document.getElementById('koordinator-root');
  if (root) renderKoordinator(root);
}

async function koordMpSwitchView(id) {
  if (id === masterplanViewId) return;
  if (!(await koordMpFlushOrWarn())) {
    koordMpRerenderPage(); // put the plan picker back on the unsaved plan
    return;
  }
  masterplanViewId = id;
  if (id) localStorage.setItem(KOORD_MP_VIEW_KEY, id);
  else localStorage.removeItem(KOORD_MP_VIEW_KEY);
  masterplanDraft = null;
  koordMpRerenderPage();
}

// Mirrors archive.js's own folder-slug dedupe loop (see openKoordYearEditor
// above) — reuses slugifyFolderName (already duplicated in this file for
// Arkiv) since a plan id has the exact same shape requirements.
function koordMpSlugifyPlanId(label) {
  const existing = new Set(getMasterplanPlans().map((p) => p.id));
  const base = slugifyFolderName(label) || 'plan';
  let id = base;
  let n = 2;
  while (existing.has(id)) { id = `${base}-${n}`; n++; }
  return id;
}

function koordMpEmptyTabs() {
  const tabs = {};
  KOORD_MP_TABS.forEach((t) => { tabs[t.key] = []; });
  return tabs;
}

// A new plan starts as a copy of the previous one, not blank: every task
// row's "Ansvarlig" name shifts left into "Ansvarlig sidste revy" (this
// year's coordinator becomes next year's point of reference), "Ansvarlig"
// itself is cleared for the incoming coordinator to fill in, and Status
// resets since none of last year's to-dos are done yet in the new cycle.
// Group headings carry over unchanged. Falls back to genuinely empty tabs
// when there's no previous plan to copy (the very first plan ever).
function koordMpTabsFromPrevious(prevPlan) {
  if (!prevPlan) return koordMpEmptyTabs();
  const tabs = structuredClone(prevPlan.tabs || {});
  KOORD_MP_TABS.forEach((tab) => {
    (tabs[tab.key] || []).forEach((row) => {
      if (row.type !== 'task') return;
      row.ansvarA = row.ansvarB || '';
      row.ansvarB = '';
      row.status = '';
    });
  });
  return tabs;
}

// "+ Tilføj" — copies the newest existing plan forward (see
// koordMpTabsFromPrevious), with Navn/Årstal pre-filled as a starting-point
// guess from it (mirrors koordGuessNameFromFolder/koordSuggestNextFolder's
// own guess-but-freely-editable posture for Arkiv's close-year flow) —
// freely editable before saving. Unlike row edits (batched into the draft),
// creating a plan is a structural action that saves immediately, same
// posture as adding an Arkiv year.
function openCreateMasterplanModal() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Ny plan');
  modal.classList.add('koord-mp-plan-modal');

  const prevPlan = sortedMasterplanPlans()[0] || null;

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'MatRevy 2027';
  nameInput.value = prevPlan ? koordSuggestNextFolder(prevPlan.label) : '';
  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = prevPlan ? String(prevPlan.year + 1) : '';

  let yearTouched = false;
  yearInput.addEventListener('input', () => { yearTouched = true; });
  nameInput.addEventListener('input', () => {
    if (yearTouched) return;
    const m = nameInput.value.match(/\b(19|20)\d{2}\b/);
    if (m) yearInput.value = m[0];
  });

  if (prevPlan) {
    form.appendChild(el('p', 'koord-modal-intro',
      `Kopieres fra "${prevPlan.label}" (Ansvarlig flyttes til Ansvarlig sidste revy)`));
  }
  form.appendChild(siteEditField('Navn', nameInput));
  form.appendChild(siteEditField('Årstal', yearInput));

  const save = koordPillBtn('Gem', 'site-btn-success');
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    error.textContent = '';
    const label = nameInput.value.trim();
    if (!label) { error.textContent = 'Navnet er påkrævet.'; return; }
    const year = parseInt(yearInput.value, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      error.textContent = 'Angiv et gyldigt årstal (1900–2100).';
      return;
    }

    save.disabled = true;
    if (!(await koordMpFlushOrWarn())) { save.disabled = false; return; }
    const id = koordMpSlugifyPlanId(label);
    // Re-read the source plan: it may have auto-saved edits since the modal opened.
    const source = prevPlan ? (getMasterplanPlans().find((p) => p.id === prevPlan.id) || prevPlan) : null;
    const newPlan = { id, year, label, tabs: koordMpTabsFromPrevious(source) };
    const nextPlans = getMasterplanPlans().concat([newPlan]);

    const result = await siteSaveResource('masterplan', { plans: nextPlans });
    if (result.ok) {
      koordMasterplanOverride = { plans: nextPlans };
      siteSaveOverride('masterplan', koordMasterplanOverride);
      close();
      koordMpSwitchView(id);
    } else {
      save.disabled = false;
      error.textContent = result.message || 'Kunne ikke oprette planen.';
    }
  });

  nameInput.focus();
}

const KOORD_MP_ADD_VALUE = '__add__';

// "Slet" — deletes the plan currently in view. Mirrors
// openDeleteArchiveYearConfirm's own async-aware shape (keeps the modal
// open and shows an error on failure) rather than the quick-fire
// koordMpDeleteConfirm used for row-level draft edits above, since this is
// a real, immediate server delete of a whole plan's content.
function openDeleteMasterplanPlanConfirm(plan) {
  const { modal, form, error, actions, close } = siteOpenEditModal(`Slet "${plan.label}"?`);
  modal.classList.add('koord-mp-confirm-modal');
  form.appendChild(el('p', 'koord-mp-confirm-text', 'Planen og alle dens opgaver slettes permanent. Dette kan ikke fortrydes.'));

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = koordPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    // Let a pending row edit land first, so it can't race this write.
    await koordMpAutosave.flush();
    const nextPlans = getMasterplanPlans().filter((p) => p.id !== plan.id);
    const result = await siteSaveResource('masterplan', { plans: nextPlans });
    if (result.ok) {
      koordMasterplanOverride = { plans: nextPlans };
      siteSaveOverride('masterplan', koordMasterplanOverride);
      if (masterplanDraft && masterplanDraft.id === plan.id) masterplanDraft = null;
      close();
      koordMpSwitchView(null);
    } else {
      error.textContent = result.message || 'Kunne ikke slette planen.';
      cancelBtn.disabled = false;
      confirmBtn.disabled = false;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

function renderMasterplanCard(container) {
  const card = el('section', 'card koord-mp-card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Masterplan'));

  const plans = getMasterplanPlans();
  if (plans.length === 0) {
    // Brand-new deploy / every plan deleted — nothing to view/edit yet,
    // same "empty" posture as budget.js's own renderYearToolbar when
    // budgetYearsList is empty.
    card.appendChild(head);
    card.appendChild(el('p', null, 'Ingen planer oprettet endnu.'));
    const addBtn = el('button', 'btn-small', '+ Tilføj plan');
    addBtn.type = 'button';
    addBtn.addEventListener('click', openCreateMasterplanModal);
    card.appendChild(addBtn);
    container.appendChild(card);
    return;
  }

  const pickerWrap = el('div', 'koord-mp-plan-picker');
  pickerWrap.appendChild(el('span', 'koord-mp-plan-picker-label', 'Viser plan for:'));
  // Same compact site-field-btn dropdown as Budget's own "Viser budget
  // for:"/Formularer's "Viser for:" (siteCreateDropdownField), not the
  // anchored siteOpenDropdownPicker popup this used before — "+ Tilføj"
  // opens the create modal and reverts the field's own displayed value
  // right back (it never actually becomes the selected plan).
  const planOptions = [{ value: KOORD_MP_ADD_VALUE, label: '+ Tilføj' }]
    .concat(sortedMasterplanPlans().map((p) => ({ value: p.id, label: p.label })));
  const planDd = siteCreateDropdownField(planOptions, resolveMasterplanViewId());
  planDd.addEventListener('change', () => {
    const value = planDd.value;
    if (value === KOORD_MP_ADD_VALUE) {
      planDd.value = resolveMasterplanViewId();
      openCreateMasterplanModal();
      return;
    }
    koordMpSwitchView(value);
  });
  pickerWrap.appendChild(planDd);
  head.appendChild(pickerWrap);
  card.appendChild(head);

  const currentPlan = getCurrentMasterplan();
  koordMpEnsureDraft();

  const tabBar = el('nav', 'koord-mp-tab-bar');
  tabBar.id = 'koord-mp-tab-bar';
  card.appendChild(tabBar);

  const gridWrap = el('div', 'koord-mp-grid-wrap');
  const grid = el('div', 'koord-mp-grid');
  grid.id = 'koord-mp-grid';
  gridWrap.appendChild(grid);
  card.appendChild(gridWrap);

  const saveBar = el('div', 'koord-mp-save-bar');
  const deleteBtn = el('button', 'site-btn-danger', 'Slet');
  deleteBtn.type = 'button';
  deleteBtn.addEventListener('click', () => openDeleteMasterplanPlanConfirm(currentPlan));
  saveBar.appendChild(deleteBtn);

  const saveGroup = el('div', 'koord-mp-save-group');
  const status = el('span', 'koord-mp-save-status');
  status.id = 'koord-mp-save-status';
  saveGroup.appendChild(status);
  saveBar.appendChild(saveGroup);
  card.appendChild(saveBar);

  container.appendChild(card);

  renderMpTabBar();
  renderMpGrid();
  koordMpPaintSaveStatus();
}

// ── Budget section (Arkivering tab: which budget is active, rename it) ──
// koordinator.html doesn't load js/budget.js (wired to budget.html's own
// DOM), so the tiny bits it needs — the authenticated POST helper and the
// active-budget label — are duplicated here, same rationale as every other
// page-scoped duplication in this file (see the file header). Only the
// three budget actions this card actually needs are used:
// budget_read/budget_create_year/budget_set_active_year/budget_rename_year.
let koordBudgetYearsList = []; // [{budgetId, year, label, createdAt}]
let koordBudgetActiveId = null;
let koordBudgetLoading = false;

// Mirrors budget.js's own budgetApi() byte-for-byte (see that file's own
// comment) — a 2xx response with an HTML body (PHP fatal, or a Simply WAF
// challenge page) must never be mistaken for success.
async function koordBudgetApi(action, body) {
  const auth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  const password = auth && auth.password ? auth.password : null;
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
  if (!res.ok) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    return { ok: false, message: detail ? `Der opstod en serverfejl. (${detail})` : 'Der opstod en serverfejl. Prøv igen senere.' };
  }
  if (!data || data.ok !== true) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    return { ok: false, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

function koordBudgetLabel(budgetId) {
  const entry = koordBudgetYearsList.find((y) => y.budgetId === budgetId);
  return entry ? entry.label : String(budgetId);
}

function renderKoordBudgetSection() {
  const container = document.getElementById('koord-budget-body');
  if (!container) return;
  container.textContent = '';

  if (koordBudgetLoading) {
    container.appendChild(el('span', 'koord-status-value', 'Indlæser…'));
    return;
  }

  const label = koordBudgetActiveId != null ? koordBudgetLabel(koordBudgetActiveId) : 'Intet valgt';
  const text = el('span');
  text.appendChild(document.createTextNode('Aktivt budget: '));
  text.appendChild(el('span', 'koord-budget-active-value', label));
  container.appendChild(text);

  const editBtn = el('button', 'btn-small', 'Rediger');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => openKoordBudgetEditor());
  container.appendChild(editBtn);
}

// Loads years.json's manifest (activeBudgetId + years list) fresh every
// time the Arkivering tab renders — this card only ever shows/edits the
// active budget, so there's no view-state worth caching across visits.
async function koordLoadBudgetYears() {
  koordBudgetLoading = true;
  renderKoordBudgetSection();
  const result = await koordBudgetApi('budget_read', {});
  koordBudgetLoading = false;
  if (result.ok) {
    koordBudgetActiveId = result.data.activeBudgetId;
    koordBudgetYearsList = Array.isArray(result.data.years) ? result.data.years : [];
  }
  renderKoordBudgetSection();
}

// Merges Budget's own former "Omdøb"/"Skift" pair into one flow: pick a
// budget (or "+ Opret nyt" / "Intet valgt") from the same dropdown Budget's
// old "Skift aktivt budget" modal used, optionally fix its label/year in
// the same step, and Gem both renames it (if changed) and makes it the
// active budget (if it wasn't already) — see openSwitchActiveYearModal/
// openRenameYearModal in budget.js for the two flows this replaces.
function openKoordBudgetEditor() {
  const hasYears = koordBudgetYearsList.length > 0;
  const NEW_VALUE = '__new__';
  const NONE_VALUE = '__none__';
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Rediger budgetår');
  modal.classList.add('koord-year-edit-modal');

  const group = el('div', 'koord-year-edit-group');

  let yearSelect = null;
  if (hasYears) {
    const options = [{ value: NEW_VALUE, label: '+ Opret nyt' }]
      .concat(koordBudgetYearsList
        .slice()
        .sort((a, b) => b.year - a.year || String(b.createdAt).localeCompare(String(a.createdAt)))
        .map((y) => ({ value: y.budgetId, label: y.label })))
      .concat([{ value: NONE_VALUE, label: 'Intet valgt' }]);
    const defaultValue = koordBudgetActiveId != null ? koordBudgetActiveId : NONE_VALUE;
    yearSelect = siteCreateDropdownField(options, defaultValue);
    group.appendChild(siteEditField('Aktivt budget', yearSelect));
  }

  const nameYearRow = el('div', 'koord-year-edit-row');
  const labelInput = document.createElement('input');
  labelInput.type = 'text';
  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '2000';
  yearInput.max = '2100';
  nameYearRow.appendChild(siteEditField('Label', labelInput));
  nameYearRow.appendChild(siteEditField('Årstal', yearInput));
  group.appendChild(nameYearRow);
  form.appendChild(group);

  function selectedValue() {
    return yearSelect ? yearSelect.value : NEW_VALUE;
  }

  function updateFields() {
    const val = selectedValue();
    if (val === NONE_VALUE) {
      nameYearRow.style.display = 'none';
      confirmBtn.textContent = 'Vælg';
      return;
    }
    nameYearRow.style.display = '';
    if (val === NEW_VALUE) {
      const activeEntry = koordBudgetActiveId != null
        ? koordBudgetYearsList.find((y) => y.budgetId === koordBudgetActiveId) : null;
      const year = activeEntry ? activeEntry.year + 1 : new Date().getFullYear();
      yearInput.value = String(year);
      labelInput.value = `MatRevy ${year}`;
      confirmBtn.textContent = 'Opret';
    } else {
      const entry = koordBudgetYearsList.find((y) => y.budgetId === val);
      yearInput.value = String(entry ? entry.year : '');
      labelInput.value = entry ? entry.label : '';
      confirmBtn.textContent = 'Gem';
    }
  }

  const confirmBtn = koordPillBtn('Gem', 'site-btn-success');
  actions.appendChild(confirmBtn);
  if (yearSelect) yearSelect.addEventListener('change', updateFields);
  updateFields();

  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    const val = selectedValue();

    if (val === NONE_VALUE) {
      confirmBtn.disabled = true;
      const result = await koordBudgetApi('budget_set_active_year', { budgetId: null });
      confirmBtn.disabled = false;
      if (!result.ok) { if (result.message) error.textContent = result.message; return; }
      close();
      koordLoadBudgetYears();
      return;
    }

    const year = Number(yearInput.value);
    const label = labelInput.value.trim();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) { error.textContent = 'Angiv et gyldigt årstal.'; return; }
    if (!label) { error.textContent = 'Angiv en label.'; return; }

    if (val === NEW_VALUE) {
      confirmBtn.disabled = true;
      const createResult = await koordBudgetApi('budget_create_year', { year, label });
      if (!createResult.ok) {
        confirmBtn.disabled = false;
        if (createResult.message) error.textContent = createResult.message;
        return;
      }
      const activateResult = await koordBudgetApi('budget_set_active_year', { budgetId: createResult.data.budgetId });
      confirmBtn.disabled = false;
      if (!activateResult.ok) { if (activateResult.message) error.textContent = activateResult.message; return; }
      close();
      koordLoadBudgetYears();
      return;
    }

    // An existing budget was picked: rename it if its label/year changed,
    // then switch active to it if it isn't already.
    const entry = koordBudgetYearsList.find((y) => y.budgetId === val);
    confirmBtn.disabled = true;
    if (entry && (entry.year !== year || entry.label !== label)) {
      const renameResult = await koordBudgetApi('budget_rename_year', { budgetId: val, year, label });
      if (!renameResult.ok) {
        confirmBtn.disabled = false;
        if (renameResult.message) error.textContent = renameResult.message;
        return;
      }
    }
    if (val !== koordBudgetActiveId) {
      const activateResult = await koordBudgetApi('budget_set_active_year', { budgetId: val });
      if (!activateResult.ok) {
        confirmBtn.disabled = false;
        if (activateResult.message) error.textContent = activateResult.message;
        return;
      }
    }
    confirmBtn.disabled = false;
    close();
    koordLoadBudgetYears();
  });
}

// ── Lokaler & Fravær tab ─────────────────────────────────────
// Lokalebooking: rooms × rehearsal days, replacing the yearly
// "Lokalebooking" spreadsheet. Day columns come live from Kalender
// (every `ove`/`forestilling` day in the current rolling half-year, plus
// the day after the last show for cleaning) — never stored. Bookings are
// free text keyed by room id + ISO date (data/lokaler.json, admin
// `lokaler` resource), so rooms carry over between years and moving a
// Kalender event never orphans a cell. Grid + "Øvrige bookinger" are one
// auto-saved draft, like Masterplan. Signed booking forms are PDFs in a
// private server store (lokaler_* actions), uploaded/removed live.
let koordLokalerOverride = siteLoadOverride('lokaler');

function getEffectiveLokalerDoc() {
  const doc = koordLokalerOverride || (typeof LOKALER_DATA !== 'undefined' ? LOKALER_DATA : null) || {};
  return {
    rooms: Array.isArray(doc.rooms) ? doc.rooms : [],
    // PHP's json_encode writes an empty map as [] — treat it as {}.
    bookings: (doc.bookings && !Array.isArray(doc.bookings)) ? doc.bookings : {},
    other: Array.isArray(doc.other) ? doc.other : [],
    // Admin-chosen window for importing days from Kalender; absent = the
    // current rolling half-year (koordLokHalfYearRange).
    ...(koordLokValidRange(doc.range) ? { range: { start: doc.range.start, end: doc.range.end } } : {}),
  };
}

function koordLokValidRange(range) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  return Boolean(range && iso.test(range.start || '') && iso.test(range.end || '') && range.start <= range.end);
}

// The window the grid's day columns are taken from: the draft's chosen
// range, else the current half-year.
function koordLokRange() {
  return (lokalerDraft && koordLokValidRange(lokalerDraft.range)) ? lokalerDraft.range : koordLokHalfYearRange();
}

let lokalerDraft = null;
let lokalerLastSavedSnapshot = '';
let koordLokDragItem = null;

// The rooms from the old Lokalebooking spreadsheet — offered (unsaved)
// when nothing has ever been saved, so the first edit stores them.
const KOORD_LOK_DEFAULT_ROOMS = [
  'Store UP1', 'Lille UP1', 'øv-1-0-04', 'øv-1-0-10', 'øv-1-0-14', 'øv-1-0-18',
  'øv-1-0-22', 'øv-1-0-26', 'øv-1-0-30', 'øv-1-0-34', 'øv-3-0-25', 'øv-1-0-17',
  'øv-1-0-37', 'DIKU bib', 'DIKU kantinen (16-20)',
];

function koordLokEnsureDraft() {
  if (lokalerDraft) return;
  lokalerDraft = structuredClone(getEffectiveLokalerDoc());
  lokalerLastSavedSnapshot = JSON.stringify(lokalerDraft);
  const neverSaved = !lokalerDraft.rooms.length && !Object.keys(lokalerDraft.bookings).length
    && !lokalerDraft.other.length && !lokalerDraft.range;
  if (neverSaved) {
    lokalerDraft.rooms = KOORD_LOK_DEFAULT_ROOMS.map((name) => ({ id: koordMpNewId('r'), name }));
  }
}

function lokalerIsDirty() {
  return JSON.stringify(lokalerDraft) !== lokalerLastSavedSnapshot;
}

// Called after every edit: queues an auto-save and repaints the status.
// Never from a plain render — a never-saved sheet's pre-filled default
// rooms are only stored once the admin actually edits something.
function koordLokUpdateSaveStatus() {
  if (lokalerDraft && lokalerIsDirty()) koordLokAutosave.schedule();
  koordLokPaintSaveStatus();
}

let koordLokSaveError = null; // message of the last failed save, null when it succeeded

function koordLokPaintSaveStatus() {
  koordPaintAutosaveStatus(document.getElementById('koord-lok-save-status'),
    koordLokAutosave.isBusy(), koordLokSaveError, Boolean(lokalerDraft) && lokalerIsDirty());
}

// Same rolling half-year as faellesspisning.js's faellesCurrentHalfYearRange
// (duplicated — this page doesn't load that file): Jan–Jun or Jul–Dec of
// today, so in the autumn it shows that year's revy.
function koordLokHalfYearRange() {
  const today = todayIso();
  const year = today.slice(0, 4);
  return Number(today.slice(5, 7)) <= 6
    ? { start: `${year}-01-01`, end: `${year}-06-30` }
    : { start: `${year}-07-01`, end: `${year}-12-31` };
}

function koordLokCalendarEvents() {
  const override = siteLoadOverride('calendar');
  if (override) return override;
  return (typeof CALENDAR_DATA !== 'undefined' && Array.isArray(CALENDAR_DATA)) ? CALENDAR_DATA : [];
}

function koordLokIso(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function koordLokAddDays(iso, n) {
  const d = parseIsoDate(iso);
  d.setDate(d.getDate() + n);
  return koordLokIso(d);
}

// [{date, titles}] sorted by date — one column per date, however many
// events fall on it.
function koordLokalerDays() {
  const range = koordLokRange();
  const byDate = new Map();
  const addTitle = (date, title) => {
    if (!byDate.has(date)) byDate.set(date, []);
    const titles = byDate.get(date);
    if (title && !titles.includes(title)) titles.push(title);
  };
  let lastShow = '';
  koordLokCalendarEvents().forEach((ev) => {
    if (!ev || (ev.category !== 'ove' && ev.category !== 'forestilling') || !ev.date) return;
    const end = (ev.endDate && ev.endDate >= ev.date) ? ev.endDate : ev.date;
    let date = ev.date;
    for (let i = 0; i < 62 && date <= end; i++, date = koordLokAddDays(date, 1)) {
      if (date < range.start || date > range.end) continue;
      addTitle(date, (ev.title || '').trim());
      if (ev.category === 'forestilling' && date > lastShow) lastShow = date;
    }
  });
  if (lastShow) addTitle(koordLokAddDays(lastShow, 1), 'Rengøring');
  return Array.from(byDate.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, titles]) => ({ date, titles }));
}

function koordLokRoomHasContent(room) {
  const cells = lokalerDraft.bookings[room.id];
  return Boolean((room.name || '').trim()) || Boolean(cells && Object.keys(cells).length);
}

function koordLokWireDrag(rowEl, item, list, label, rerender) {
  rowEl.draggable = true;
  rowEl.addEventListener('dragstart', (e) => {
    koordLokDragItem = item;
    e.dataTransfer.effectAllowed = 'move';
    const ghost = koordMpGetDragImageEl();
    ghost.replaceChildren(el('div', 'koord-mp-drag-image-line', label() || 'Række'));
    e.dataTransfer.setDragImage(ghost, 12, 16);
  });
  rowEl.addEventListener('dragend', () => { koordLokDragItem = null; });
  koordWireDropHighlight(rowEl, () => {
    if (koordLokDragItem && koordLokDragItem !== item && list.includes(koordLokDragItem)) {
      koordMoveDraftItem(list, koordLokDragItem, item, rerender);
      koordLokUpdateSaveStatus();
    }
  });
}

function koordLokTextInput(value, className, onInput) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'koord-mp-field ' + className;
  input.value = value || '';
  input.addEventListener('input', () => {
    onInput(input.value);
    koordLokUpdateSaveStatus();
  });
  return input;
}

function koordLokAddPlus(title, onClick) {
  const btn = el('button', 'boss-manage-add-plus', '+');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.addEventListener('click', onClick);
  return btn;
}

function koordLokRemoveBtn(title, onClick) {
  const btn = el('button', 'boss-manage-remove-btn', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

// Shift+arrow keys move between the grid's fields like a spreadsheet (the
// room-name column included), selecting the target's text. Plain arrows
// keep their normal in-field behaviour.
function koordLokWireGridKeys(table) {
  const moves = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
  table.addEventListener('keydown', (e) => {
    const move = moves[e.key];
    if (!move || !e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return;
    const td = e.target.closest('td');
    const tr = td && td.parentElement;
    if (!tr || !tr.classList.contains('koord-lok-tr')) return;
    const rows = Array.from(table.querySelectorAll('tbody tr.koord-lok-tr:not(.koord-lok-drop-tail)'));
    const fieldsOf = (row) => Array.from(row.querySelectorAll('input.koord-mp-field'));
    const rowIdx = rows.indexOf(tr);
    const colIdx = fieldsOf(tr).indexOf(e.target);
    if (rowIdx === -1 || colIdx === -1) return;
    e.preventDefault();
    const targetRow = rows[rowIdx + move[0]];
    const target = targetRow && fieldsOf(targetRow)[colIdx + move[1]];
    if (!target) return;
    target.focus();
    target.select();
  });
}

// Structural render of the booking grid — on add/remove/drag/save, never on
// a keystroke (that would steal focus).
function renderLokGrid() {
  const mount = document.getElementById('koord-lok-grid');
  if (!mount) return;
  mount.textContent = '';
  const days = koordLokalerDays();
  const rooms = lokalerDraft.rooms;

  if (!days.length) {
    mount.appendChild(el('p', 'koord-lok-empty', 'Ingen øvedage i kalenderen i den valgte periode.'));
  }

  const wrap = el('div', 'koord-lok-table-wrap');
  const table = el('table', 'koord-lok-table');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'koord-lok-th-room', 'Lokale'));
  days.forEach((day) => {
    const d = parseIsoDate(day.date);
    const th = el('th', 'koord-lok-th-day');
    // Event title(s) above the date — one line each, ellipsized (the
    // tooltip has them all); th's vertical-align: bottom keeps every date
    // on one line however many titles sit above it.
    if (day.titles.length) {
      day.titles.forEach((t) => th.appendChild(el('div', 'koord-lok-th-title', t)));
      th.title = day.titles.join(' · ');
    }
    th.appendChild(el('div', 'koord-lok-th-date',
      `${DA_WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${d.getDate()}/${d.getMonth() + 1}`));
    headRow.appendChild(th);
  });
  headRow.appendChild(el('th', 'koord-lok-th-remove'));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  rooms.forEach((room) => {
    const tr = el('tr', 'koord-lok-tr');
    koordLokWireDrag(tr, room, rooms, () => (room.name || '').trim(), renderLokGrid);

    const nameTd = el('td', 'koord-lok-td-room');
    const nameWrap = el('div', 'koord-lok-room-wrap');
    nameWrap.appendChild(el('span', 'boss-manage-drag-handle', '⠿'));
    const nameInput = koordLokTextInput(room.name, 'koord-lok-room-input', (v) => { room.name = v; });
    nameInput.placeholder = 'Lokale';
    nameInput.title = room.name || '';
    nameWrap.appendChild(nameInput);
    nameTd.appendChild(nameWrap);
    tr.appendChild(nameTd);

    days.forEach((day) => {
      const td = el('td', 'koord-lok-td-cell');
      const cells = lokalerDraft.bookings[room.id] || {};
      const input = koordLokTextInput(cells[day.date], 'koord-lok-cell-input', (v) => {
        const map = lokalerDraft.bookings[room.id] || (lokalerDraft.bookings[room.id] = {});
        if (v.trim()) map[day.date] = v;
        else delete map[day.date];
        if (!Object.keys(map).length) delete lokalerDraft.bookings[room.id];
        input.title = v;
      });
      input.title = cells[day.date] || '';
      input.setAttribute('aria-label', `${room.name || 'Lokale'} ${day.date}`);
      td.appendChild(input);
      tr.appendChild(td);
    });

    const removeTd = el('td', 'koord-lok-td-remove');
    removeTd.appendChild(koordLokRemoveBtn('Fjern lokale', () => {
      const remove = () => {
        const idx = rooms.indexOf(room);
        if (idx !== -1) rooms.splice(idx, 1);
        delete lokalerDraft.bookings[room.id];
        koordLokUpdateSaveStatus();
        renderLokGrid();
      };
      if (!koordLokRoomHasContent(room)) { remove(); return; }
      koordMpDeleteConfirm(
        room.name ? `Fjern "${room.name}"?` : 'Fjern dette lokale?',
        'Lokalets bookinger fjernes også.',
        remove
      );
    }));
    tr.appendChild(removeTd);
    tbody.appendChild(tr);
  });

  // Drop-tail row: the only way to drop a room after the last one.
  const tailTr = el('tr', 'koord-lok-tr koord-lok-drop-tail');
  const tailTd = el('td');
  tailTd.colSpan = days.length + 2;
  tailTr.appendChild(tailTd);
  koordWireDropHighlight(tailTr, () => {
    if (koordLokDragItem && rooms.includes(koordLokDragItem)) {
      koordMoveDraftItem(rooms, koordLokDragItem, null, renderLokGrid);
      koordLokUpdateSaveStatus();
    }
  });
  tbody.appendChild(tailTr);
  table.appendChild(tbody);
  koordLokWireGridKeys(table);
  wrap.appendChild(table);
  mount.appendChild(wrap);

  const addRow = el('div', 'koord-lok-add-row');
  addRow.appendChild(koordLokAddPlus('Tilføj lokale', () => {
    rooms.push({ id: koordMpNewId('r'), name: '' });
    koordLokUpdateSaveStatus();
    renderLokGrid();
    const inputs = mount.querySelectorAll('.koord-lok-room-input');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }));
  mount.appendChild(addRow);
}

function renderLokOther() {
  const mount = document.getElementById('koord-lok-other');
  if (!mount) return;
  mount.textContent = '';
  const rows = lokalerDraft.other;

  const header = el('div', 'koord-mp-row koord-mp-row-header');
  header.appendChild(el('span', 'koord-mp-col-handle'));
  header.appendChild(el('span', 'koord-lok-col-event', 'Begivenhed'));
  header.appendChild(el('span', 'koord-lok-col-booking', 'Lokale og tid'));
  header.appendChild(el('span', 'koord-mp-col-remove'));
  mount.appendChild(header);

  rows.forEach((row) => {
    const rowEl = el('div', 'koord-mp-row');
    koordLokWireDrag(rowEl, row, rows, () => (row.event || '').trim(), renderLokOther);
    rowEl.appendChild(el('span', 'koord-mp-col-handle boss-manage-drag-handle', '⠿'));
    const eventInput = koordLokTextInput(row.event, 'koord-lok-col-event', (v) => { row.event = v; });
    eventInput.placeholder = 'Fx Infomøde d. 19/9';
    rowEl.appendChild(eventInput);
    const bookingInput = koordLokTextInput(row.booking, 'koord-lok-col-booking', (v) => { row.booking = v; });
    bookingInput.placeholder = 'Fx A107 17-22';
    rowEl.appendChild(bookingInput);
    const removeWrap = el('span', 'koord-mp-col-remove');
    removeWrap.appendChild(koordLokRemoveBtn('Fjern booking', () => {
      const remove = () => {
        const idx = rows.indexOf(row);
        if (idx !== -1) rows.splice(idx, 1);
        koordLokUpdateSaveStatus();
        renderLokOther();
      };
      if (!(row.event || '').trim() && !(row.booking || '').trim()) { remove(); return; }
      koordMpDeleteConfirm(row.event ? `Fjern "${row.event}"?` : 'Fjern denne booking?', null, remove);
    }));
    rowEl.appendChild(removeWrap);
    mount.appendChild(rowEl);
  });

  const tail = el('div', 'koord-mp-drop-tail');
  koordWireDropHighlight(tail, () => {
    if (koordLokDragItem && rows.includes(koordLokDragItem)) {
      koordMoveDraftItem(rows, koordLokDragItem, null, renderLokOther);
      koordLokUpdateSaveStatus();
    }
  });
  mount.appendChild(tail);

  const addRow = el('div', 'koord-lok-add-row');
  addRow.appendChild(koordLokAddPlus('Tilføj booking', () => {
    rows.push({ id: koordMpNewId('o'), event: '', booking: '' });
    koordLokUpdateSaveStatus();
    renderLokOther();
    const inputs = mount.querySelectorAll('.koord-lok-col-event');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }));
  mount.appendChild(addRow);
}

// Saves the draft as it is right now; the draft is kept (no re-render).
async function koordLokSaveNow() {
  if (!lokalerDraft) return { ok: true, message: '' };
  const snapshot = JSON.stringify(lokalerDraft);
  const next = JSON.parse(snapshot);
  const result = await siteSaveResource('lokaler', next);
  if (result.ok) {
    koordLokalerOverride = next;
    siteSaveOverride('lokaler', next);
    lokalerLastSavedSnapshot = snapshot;
  }
  return result;
}

const koordLokAutosave = siteCreateAutosave({
  save: koordLokSaveNow,
  onStatus(state, message) {
    if (state === 'saved') koordLokSaveError = null;
    else if (state === 'error') koordLokSaveError = message;
    koordLokPaintSaveStatus();
  },
});

// ── Signed booking forms (private PDF store) ──
const KOORD_LOK_COLLAPSED_KEY = 'matrevy-koord-lok-collapsed';
const KOORD_LOK_MAX_UPLOAD_BYTES = 15 * 1024 * 1024; // mirrors lokaler_max_upload_bytes()
let koordLokFiles = null; // null = not loaded yet
let koordLokFilesMessage = '';
let koordLokUploading = false;

function koordLokIcon(viewBox, size, strokeWidth, paths) {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', viewBox);
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', strokeWidth);
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  paths.forEach((d) => {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  });
  return svg;
}

function koordLokIconBtn(title, icon) {
  const btn = el('button', 'koord-lok-icon-btn');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(icon);
  return btn;
}

function koordLokFileDisplayName(file) {
  return (file.name || '').replace(/\.pdf$/i, '');
}

async function koordLokLoadFiles() {
  if (location.protocol === 'file:') {
    koordLokFiles = [];
    koordLokFilesMessage = 'Kun tilgængelig online.';
    renderLokFiles();
    return;
  }
  // koordBudgetApi is a generic authenticated POST helper despite its name.
  const result = await koordBudgetApi('lokaler_files_read', {});
  koordLokFiles = result.ok ? (result.data.files || []) : [];
  koordLokFilesMessage = result.ok ? '' : (result.message || 'Kunne ikke hente blanketterne.');
  renderLokFiles();
}

// Streams one stored PDF with the password (never at a public URL).
async function koordLokFetchFile(file) {
  const auth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  const password = auth && auth.password ? auth.password : null;
  if (!password) return { ok: false, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'lokaler_file', password, fileId: file.id }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  const type = res.headers.get('Content-Type') || '';
  if (!res.ok || type.includes('json') || type.includes('html')) {
    return { ok: false, message: 'Kunne ikke hente filen.' };
  }
  const blob = await res.blob();
  return { ok: true, blob: new Blob([blob], { type: 'application/pdf' }) };
}

function koordLokSaveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10 * 1000);
}

// The window is opened synchronously (inside the click) so popup blockers
// allow it, then pointed at the blob once it has arrived — as bandOpenFile.
async function koordLokOpenFile(file) {
  const win = window.open('', '_blank');
  if (win) win.document.title = file.name;
  const result = await koordLokFetchFile(file);
  if (!result.ok) {
    if (win) win.close();
    if (result.message) siteShowToast(result.message);
    return;
  }
  const url = URL.createObjectURL(result.blob);
  if (win) win.location.href = url;
  else koordLokSaveBlob(result.blob, file.name);
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

async function koordLokDownloadFile(file, btn) {
  btn.disabled = true;
  const result = await koordLokFetchFile(file);
  btn.disabled = false;
  if (!result.ok) { if (result.message) siteShowToast(result.message); return; }
  koordLokSaveBlob(result.blob, file.name);
}

function koordLokReadAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

// One file at a time; wrong type/too large is skipped with a toast.
async function koordLokUploadFiles(fileList) {
  if (koordLokUploading) { siteShowToast('Vent til den igangværende upload er færdig.'); return; }
  const files = Array.from(fileList || []);
  const ok = files.filter((f) => /\.pdf$/i.test(f.name) && f.size <= KOORD_LOK_MAX_UPLOAD_BYTES);
  if (ok.length < files.length) siteShowToast('Kun PDF-filer på højst 15 MB kan uploades.');
  if (!ok.length) return;
  koordLokUploading = true;
  renderLokFiles();
  for (const file of ok) {
    let contentBase64;
    try { contentBase64 = await koordLokReadAsBase64(file); } catch (e) { siteShowToast(`Kunne ikke læse ${file.name}.`); continue; }
    const result = await koordBudgetApi('lokaler_upload_file', { name: file.name, contentBase64 });
    if (!result.ok) {
      if (result.message) siteShowToast(result.message);
      break;
    }
    koordLokFiles = result.data.files || [];
    koordLokFilesMessage = '';
    renderLokFiles();
  }
  koordLokUploading = false;
  renderLokFiles();
}

function openKoordLokRenameModal(file) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Omdøb fil');
  modal.classList.add('koord-mp-confirm-modal');
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 120;
  input.value = koordLokFileDisplayName(file);
  form.appendChild(siteEditField('Navn', input));

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const saveBtn = koordPillBtn('Gem', 'site-btn-success');
  async function submit() {
    const name = input.value.trim();
    if (!name) { error.textContent = 'Giv filen et navn.'; input.focus(); return; }
    if (name === koordLokFileDisplayName(file)) { close(); return; }
    saveBtn.disabled = true;
    error.textContent = '';
    const result = await koordBudgetApi('lokaler_rename_file', { fileId: file.id, name });
    saveBtn.disabled = false;
    if (!result.ok) { if (result.message) error.textContent = result.message; return; }
    koordLokFiles = result.data.files || [];
    renderLokFiles();
    close();
  }
  saveBtn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    submit();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(saveBtn);
  input.focus();
  input.select();
}

function renderLokFiles() {
  const mount = document.getElementById('koord-lok-files');
  if (!mount) return;
  mount.textContent = '';

  if (koordLokFiles === null) {
    mount.appendChild(el('p', 'koord-lok-empty', 'Henter...'));
    return;
  }
  if (koordLokFilesMessage) {
    mount.appendChild(el('p', 'koord-lok-empty', koordLokFilesMessage));
    if (location.protocol === 'file:') return;
  } else if (!koordLokFiles.length) {
    mount.appendChild(el('p', 'koord-lok-empty', 'Ingen blanketter uploadet endnu.'));
  }

  const list = el('ul', 'koord-lok-file-list');
  koordLokFiles.forEach((file) => {
    const li = el('li', 'koord-lok-file-row');
    const nameBtn = el('button', 'koord-lok-file-name', koordLokFileDisplayName(file));
    nameBtn.type = 'button';
    nameBtn.title = 'Åbn PDF';
    nameBtn.addEventListener('click', () => koordLokOpenFile(file));
    li.appendChild(nameBtn);

    const dl = koordLokIconBtn('Download', koordLokIcon('0 0 24 24', '16', '2', ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14']));
    dl.addEventListener('click', () => koordLokDownloadFile(file, dl));
    li.appendChild(dl);

    const rename = koordLokIconBtn('Omdøb', koordLokIcon('0 0 16 16', '15', '1.3', ['M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z', 'M9 4l3 3']));
    rename.addEventListener('click', () => openKoordLokRenameModal(file));
    li.appendChild(rename);

    li.appendChild(koordLokRemoveBtn('Slet fil', () => {
      koordMpDeleteConfirm(`Slet "${koordLokFileDisplayName(file)}"?`, 'Filen slettes permanent.', async () => {
        const result = await koordBudgetApi('lokaler_delete_file', { fileId: file.id });
        if (!result.ok) { if (result.message) siteShowToast(result.message); return; }
        koordLokFiles = result.data.files || [];
        renderLokFiles();
      });
    }));
    list.appendChild(li);
  });
  mount.appendChild(list);

  const bar = el('div', 'koord-lok-upload-bar');
  const picker = document.createElement('input');
  picker.type = 'file';
  picker.accept = '.pdf,application/pdf';
  picker.multiple = true;
  picker.hidden = true;
  picker.addEventListener('change', () => {
    const files = picker.files;
    koordLokUploadFiles(files);
    picker.value = '';
  });
  const uploadBtn = el('button', 'btn-small', koordLokUploading ? 'Uploader...' : 'Upload PDF');
  uploadBtn.type = 'button';
  uploadBtn.disabled = koordLokUploading;
  uploadBtn.addEventListener('click', () => picker.click());
  bar.appendChild(uploadBtn);
  bar.appendChild(picker);
  mount.appendChild(bar);
}

// Dropping PDFs from the desktop anywhere on the files section uploads them.
function koordLokWireFileDrop(zone) {
  let depth = 0;
  const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  zone.addEventListener('dragenter', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth++;
    zone.classList.add('koord-lok-file-drop');
  });
  zone.addEventListener('dragover', (e) => { if (isFiles(e)) e.preventDefault(); });
  zone.addEventListener('dragleave', (e) => {
    if (!isFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) zone.classList.remove('koord-lok-file-drop');
  });
  zone.addEventListener('drop', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    depth = 0;
    zone.classList.remove('koord-lok-file-drop');
    koordLokUploadFiles(e.dataTransfer.files);
  });
}

function renderLokalerTab(container) {
  koordLokEnsureDraft();

  const card = el('section', 'card koord-lok-card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Lokalebooking'));
  card.appendChild(head);

  // Everything below the head lives in `body`, so the head's chevron
  // toggle can collapse the whole section (remembered per browser).
  const body = el('div', 'koord-lok-body');
  let collapsed = false;
  try { collapsed = localStorage.getItem(KOORD_LOK_COLLAPSED_KEY) === '1'; } catch (e) { /* ignore */ }
  const toggle = el('button', 'koord-lok-collapse-btn');
  toggle.type = 'button';
  function paintCollapsed() {
    body.hidden = collapsed;
    card.classList.toggle('koord-lok-collapsed', collapsed);
    toggle.textContent = collapsed ? '▸' : '▾';
    toggle.title = collapsed ? 'Vis' : 'Skjul';
    toggle.setAttribute('aria-label', collapsed ? 'Vis Lokalebooking' : 'Skjul Lokalebooking');
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
  toggle.addEventListener('click', () => {
    collapsed = !collapsed;
    try { localStorage.setItem(KOORD_LOK_COLLAPSED_KEY, collapsed ? '1' : '0'); } catch (e) { /* ignore */ }
    paintCollapsed();
  });
  paintCollapsed();
  head.appendChild(toggle);
  card.appendChild(body);

  // Hint text left, the Fra/Til period right, on one row (wraps when narrow).
  const topRow = el('div', 'koord-lok-top');
  topRow.appendChild(el('p', 'koord-lok-hint',
    'Kolonnerne er øvedage og forestillinger fra Kalenderen i den valgte periode, plus dagen efter sidste forestilling til rengøring.'));

  // Fra/Til: which Kalender days become columns. Part of the saved draft;
  // until an admin picks one, the window is the current half-year.
  const rangeRow = el('div', 'koord-lok-range');
  const range = koordLokRange();
  const fromField = siteCreateDateField(range.start);
  const toField = siteCreateDateField(range.end);
  function onRangeChange(changed) {
    let start = fromField.value;
    let end = toField.value;
    if (start > end) {
      // Keep the window valid: the other end follows the one just moved.
      if (changed === fromField) { end = start; toField.value = end; }
      else { start = end; fromField.value = start; }
    }
    lokalerDraft.range = { start, end };
    koordLokUpdateSaveStatus();
    renderLokGrid();
  }
  fromField.addEventListener('change', () => onRangeChange(fromField));
  toField.addEventListener('change', () => onRangeChange(toField));
  rangeRow.appendChild(el('span', 'koord-lok-range-label', 'Øvedage fra'));
  rangeRow.appendChild(fromField);
  rangeRow.appendChild(el('span', 'koord-lok-range-label', 'til'));
  rangeRow.appendChild(toField);
  topRow.appendChild(rangeRow);
  body.appendChild(topRow);

  const grid = el('div');
  grid.id = 'koord-lok-grid';
  body.appendChild(grid);

  // Øvrige bookinger | Underskrevne blanketter side by side (stacked on a
  // phone), then the auto-save status bottom-right of the card (grid and
  // Øvrige bookinger; the blanketter save live on their own).
  const columns = el('div', 'koord-lok-columns');

  const otherCol = el('div', 'koord-lok-column');
  otherCol.appendChild(el('h3', 'koord-step-heading', 'Øvrige bookinger'));
  const other = el('div', 'koord-lok-other');
  other.id = 'koord-lok-other';
  otherCol.appendChild(other);
  columns.appendChild(otherCol);

  const filesSection = el('div', 'koord-lok-column koord-lok-files-section');
  filesSection.appendChild(el('h3', 'koord-step-heading', 'Underskrevne blanketter'));
  const files = el('div');
  files.id = 'koord-lok-files';
  filesSection.appendChild(files);
  koordLokWireFileDrop(filesSection);
  columns.appendChild(filesSection);
  body.appendChild(columns);

  const saveBar = el('div', 'koord-mp-save-bar koord-lok-save-bar');
  const saveGroup = el('div', 'koord-mp-save-group');
  const status = el('span', 'koord-mp-save-status');
  status.id = 'koord-lok-save-status';
  saveGroup.appendChild(status);
  saveBar.appendChild(saveGroup);
  body.appendChild(saveBar);
  container.appendChild(card);

  const fravaerCard = el('section', 'card');
  const fravaerHead = el('div', 'card-head');
  fravaerHead.appendChild(el('h2', null, 'Fravær'));
  fravaerCard.appendChild(fravaerHead);
  container.appendChild(fravaerCard);

  renderLokGrid();
  renderLokOther();
  koordLokPaintSaveStatus();
  renderLokFiles();
  if (koordLokFiles === null) koordLokLoadFiles();
}

// ── Page render ──────────────────────────────────────────────
// Four top-level page tabs — Masterplan / Tjeklister & Fællesbeskeder /
// Lokaler & Fravær / Arkivering — each getting the full page width to work in, styled like
// Budget's/Formularer's own mode-switch tab bar (.budget-mode-tabs/-tab,
// duplicated here as .koord-mode-tabs/-tab per the site's per-feature
// duplication convention — koordinator.html doesn't load budget.css).
// Replaces the earlier 2fr/1fr side-by-side layout, which read as
// cluttered with Masterplan's own grid squeezed into the wide column.
const KOORD_TABS = [
  { key: 'masterplan', label: 'Masterplan' },
  { key: 'tjeklister', label: 'Tjeklister & Fællesbeskeder' },
  { key: 'lokaler', label: 'Lokaler & Fravær' },
  { key: 'arkivering', label: 'Arkivering' },
];
const KOORD_TAB_KEY = 'matrevy-koord-tab';
let koordActiveTab = KOORD_TABS.some((t) => t.key === localStorage.getItem(KOORD_TAB_KEY))
  ? localStorage.getItem(KOORD_TAB_KEY)
  : KOORD_TABS[0].key;

function renderKoordModeTabs(root) {
  const tabs = el('div', 'koord-mode-tabs');
  KOORD_TABS.forEach((tab) => {
    const btn = el('button', 'koord-mode-tab' + (tab.key === koordActiveTab ? ' active' : ''), tab.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (tab.key === koordActiveTab) return;
      koordActiveTab = tab.key;
      localStorage.setItem(KOORD_TAB_KEY, koordActiveTab);
      renderKoordinator(root);
    });
    tabs.appendChild(btn);
  });
  root.appendChild(tabs);
}

// "Arkivering" tab: a wide left "Guide til arkivering af manus" card
// (three subtitled steps — Klargør filerne, Afslut revyen, Start ny revy)
// and a narrow right column stacking "Budget" (which budget is active, see
// openKoordBudgetEditor), "Arkiv" (unchanged Rediger picker), and "Manus"
// (active-folder status only) — same 2fr/1fr layout as style.css's
// .dashboard-columns, page-scoped as .koord-columns since it only applies
// within this one tab.
function renderArkiveringCard(container) {
  const folder = koordCurrentFolder();

  const layout = el('div', 'koord-columns');

  const guideCard = el('section', 'card');
  const guideHead = el('div', 'card-head');
  guideHead.appendChild(el('h2', null, 'Guide til arkivering af manus'));
  guideCard.appendChild(guideHead);

  renderKoordCloseYearGuide(guideCard);

  guideCard.appendChild(el('h3', 'koord-step-heading', 'Afslut revyen'));
  guideCard.appendChild(el('p', null,
    'Nulstiller Manus (scener, rollebesætning, indsendte manuskripter), gemmer et snapshot af scenes.json/cast.json i ' +
    'arkivet, og lukker den aktive produktionsmappe, så revyster ikke længere kan indsende manuskripter.'));
  const closeBtn = el('button', 'btn-small', 'Afslut');
  closeBtn.type = 'button';
  closeBtn.disabled = !folder;
  closeBtn.addEventListener('click', () => openCloseYearModal(folder));
  guideCard.appendChild(closeBtn);

  guideCard.appendChild(el('h3', 'koord-step-heading', 'Start ny revy'));
  guideCard.appendChild(el('p', null,
    'Gør en ny mappe til den aktive produktion, så revyster igen kan indsende manuskripter til Manus.'));
  const startBtn = el('button', 'btn-small', 'Start');
  startBtn.type = 'button';
  startBtn.addEventListener('click', () => openStartNewYearModal(folder));
  guideCard.appendChild(startBtn);

  layout.appendChild(guideCard);

  const rightCol = el('div', 'koord-right-col');

  const budgetCard = el('section', 'card');
  const budgetHead = el('div', 'card-head');
  budgetHead.appendChild(el('h2', null, 'Budget'));
  budgetCard.appendChild(budgetHead);
  const budgetBody = el('div', 'koord-arkivering-row');
  budgetBody.id = 'koord-budget-body';
  budgetCard.appendChild(budgetBody);
  rightCol.appendChild(budgetCard);

  const arkivCard = el('section', 'card');
  const arkivHead = el('div', 'card-head');
  arkivHead.appendChild(el('h2', null, 'Arkiv'));
  arkivCard.appendChild(arkivHead);
  const arkivBody = el('div', 'koord-arkivering-row');
  arkivBody.id = 'koord-arkiv-body';
  arkivCard.appendChild(arkivBody);
  rightCol.appendChild(arkivCard);

  const manusCard = el('section', 'card');
  const manusHead = el('div', 'card-head');
  manusHead.appendChild(el('h2', null, 'Manus'));
  manusCard.appendChild(manusHead);
  const manusBody = el('div', 'koord-arkivering-row');
  manusBody.id = 'koord-manus-body';
  manusCard.appendChild(manusBody);
  rightCol.appendChild(manusCard);

  layout.appendChild(rightCol);

  container.appendChild(layout);
  renderArkivSection();
  renderKoordManusSection();
  koordLoadBudgetYears();
}

// Right-column "Manus" card: just the active-production-folder status, no
// edit action here (that's the guide card's own "Afslut revyen"/"Start ny
// revy" steps) — mirrors the Budget/Arkiv cards' own koord-arkivering-row
// shape but as a plain status line.
function renderKoordManusSection() {
  const container = document.getElementById('koord-manus-body');
  if (!container) return;
  container.textContent = '';
  const folder = koordCurrentFolder();
  container.appendChild(el('span', null, folder
    ? `Aktiv produktionsmappe: ${folder}`
    : 'Ingen aktiv produktionsmappe.'));
}

// "Tjeklister & Fællesbeskeder" tab: empty placeholder for now.
function renderTjeklisterCard(container) {
  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Tjeklister & Fællesbeskeder'));
  card.appendChild(head);
  container.appendChild(card);
}

function renderKoordinator(root) {
  root.textContent = '';
  renderKoordModeTabs(root);

  if (koordActiveTab === 'masterplan') renderMasterplanCard(root);
  else if (koordActiveTab === 'tjeklister') renderTjeklisterCard(root);
  else if (koordActiveTab === 'lokaler') renderLokalerTab(root);
  else renderArkiveringCard(root);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('koordinator-root');
  if (!root) return;
  // The page gate (site.js) already hides <main> for below-admin visitors —
  // this is a defensive belt-and-braces check, same posture as budget.js.
  if (typeof siteHasLevel === 'function' && siteHasLevel('admin')) {
    renderKoordinator(root);
  }
});
