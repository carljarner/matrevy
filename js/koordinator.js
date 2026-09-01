/* =========================================================
   Matematikrevyen – Koordinator (koordinator.html)

   Admin-only cross-cutting tools. First (and currently only) tool:
   closing out the current production year in Manus and starting the
   next one — see "Afslut produktionsår" below. Øveplan (schedule.js)
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
// sync so this tab reflects the change immediately, before the GitHub Action
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

// ── PDF freshness poll (duplicated from manus.js's manusFetchPdfStatus/
// manusPdfReferenceUrl — see file header). Queries GitHub's Commits API
// scoped to the file's own path rather than a same-origin HEAD request's
// Last-Modified/ETag headers: those reflect when the *site* was last
// redeployed (any push to main, not just one touching this file), not when
// this file's content last actually changed — confirmed live 2026-08-21 via
// a completely unrelated, untouched file (CNAME) still reporting "today" as
// its Last-Modified. This is a one-shot manual check (the "Tjek om klar"
// button below), not a repeating poll, so the unauthenticated 60/hour rate
// limit isn't a practical concern here the way it is for manus.js's own
// repeating MANUS_PDF_POLL_INTERVAL_MS poll. ────────────────────────
async function koordFetchPdfStatus(path) {
  if (!path) return { date: null, confirmedAbsent: false, checkFailed: true };
  try {
    const res = await fetch(
      `https://api.github.com/repos/carljarner/matrevy/commits?path=${encodeURIComponent(path)}&per_page=1`,
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

function koordCurrentFolder() {
  return (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
}

function koordPdfReferenceUrl() {
  const folder = koordCurrentFolder();
  return folder ? `archive/${folder}/Manuskript.pdf` : null;
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

function koordPillBtn(label, variant) {
  const btn = el('button', 'site-pill-btn' + (variant ? ' ' + variant : ''), label);
  btn.type = 'button';
  return btn;
}

// ── Arkiv section (add/edit/delete data/archive.json years) ──
// The card itself only ever shows one button — Rediger, opening a dropdown
// picker (same primitive as Manus's own "Manus" quick-link picker) that
// lists every year plus a leading "+ Tilføj" row. No year list is ever
// shown directly on this page.
function renderArkivSection() {
  const container = document.getElementById('koord-arkiv-body');
  if (!container) return;
  container.textContent = '';

  const actionsRow = el('div', 'koord-arkiv-actions');

  const editBtn = el('button', 'btn-small', 'Rediger');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => openArkivYearPicker(editBtn));
  actionsRow.appendChild(editBtn);

  container.appendChild(actionsRow);
}

const KOORD_ARKIV_ADD_VALUE = '__add__';

// Dropdown popup listing "+ Tilføj" followed by every year (newest first),
// same primitive as manus.js's "Manus" quick-link cast picker
// (siteOpenDropdownPicker). Picking a year opens the editor for that entry;
// picking "+ Tilføj" opens it blank.
function openArkivYearPicker(anchor) {
  const years = getEffectiveArchiveYears().slice().sort((a, b) => b.year - a.year);
  const options = [{ value: KOORD_ARKIV_ADD_VALUE, label: '+ Tilføj' }]
    .concat(years.map((y) => ({ value: y.folder, label: y.name })));
  siteOpenDropdownPicker(anchor, options, null, (value) => {
    if (value === KOORD_ARKIV_ADD_VALUE) { openKoordYearEditor(); return; }
    const entry = getEffectiveArchiveYears().find((y) => y.folder === value);
    if (entry) openKoordYearEditor(entry);
  });
}

// Near-duplicate of archive.js's openYearEditor(existing) (see file header
// for why it's not cross-file-reused), trimmed down per Koordinator's own
// simpler needs: no cover-image preview (just a link to the current file),
// no manuscript upload (manusPdf is always the CI-generated
// archive/<folder>/Manuskript.pdf, derived automatically — see
// scripts/generate-pdfs.js), and X-close/green-Gem-pill chrome instead of
// the shared edit-modal's Annuller/blue-Gem pair.
function openKoordYearEditor(existing) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose(existing ? 'Rediger årgang' : 'Tilføj årgang');
  modal.classList.add('koord-year-edit-modal');

  const group = el('div', 'koord-year-edit-group');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'MatRevy 2024';
  nameInput.value = existing ? existing.name : '';

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = existing ? String(existing.year) : '';

  const nameYearRow = el('div', 'koord-year-edit-row');
  nameYearRow.appendChild(siteEditField('Navn', nameInput));
  nameYearRow.appendChild(siteEditField('Årstal', yearInput));
  group.appendChild(nameYearRow);

  if (!existing) {
    let yearTouched = false;
    yearInput.addEventListener('input', () => { yearTouched = true; });
    nameInput.addEventListener('input', () => {
      if (yearTouched) return;
      const m = nameInput.value.match(/\b(19|20)\d{2}\b/);
      if (m) yearInput.value = m[0];
    });
  }

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
  if (existing && existing.coverImage) {
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
  youtubeInput.value = existing ? existing.youtubeUrl || '' : '';
  group.appendChild(siteEditField('Link til YouTube', youtubeInput));

  const spotifyInput = document.createElement('input');
  spotifyInput.type = 'url';
  spotifyInput.placeholder = 'https://open.spotify.com/album/...';
  spotifyInput.value = existing ? existing.spotifyUrl || '' : '';
  group.appendChild(siteEditField('Link til Spotify', spotifyInput));

  const driveInput = document.createElement('input');
  driveInput.type = 'url';
  driveInput.placeholder = 'https://drive.google.com/drive/folders/...';
  driveInput.value = existing ? existing.driveUrl || '' : '';
  group.appendChild(siteEditField('Link til Google Drive', driveInput));

  form.appendChild(group);

  const progress = el('div', 'koord-progress');
  form.appendChild(progress);

  const save = koordPillBtn('Gem', 'site-pill-primary');

  if (existing) {
    const del = el('button', 'site-pill-btn site-pill-danger edit-actions-left', 'Slet');
    del.type = 'button';
    del.addEventListener('click', () => { close(); openDeleteArchiveYearConfirm(existing); });
    actions.appendChild(del);
  }
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
    // Year is not unique (e.g. a jubilee revy in the same year as a regular
    // one); folder is the stable unique key, enforced below.

    let folder;
    if (existing) {
      folder = existing.folder;
    } else {
      const slug = slugifyFolderName(name);
      if (!slug) {
        error.textContent = 'Navnet skal indeholde mindst ét bogstav eller tal.';
        return;
      }
      const usedFolders = new Set(current.map((e) => e.folder));
      folder = slug;
      let n = 2;
      while (usedFolders.has(folder)) { folder = `${slug}-${n}`; n++; }
    }

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
      coverImage: existing ? existing.coverImage || '' : '',
      youtubeUrl: youtubeInput.value.trim(),
      spotifyUrl: spotifyInput.value.trim(),
      driveUrl: driveInput.value.trim(),
      manusPdf: `archive/${folder}/Manuskript.pdf`,
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

    const next = existing
      ? current.map((e) => (e.folder === existing.folder ? entryDraft : e))
      : current.concat([entryDraft]);

    const result = await saveArchiveYears(next);
    if (result.ok) {
      progress.textContent = 'Gemt! Det kan tage et par minutter, før ændringen er synlig for andre eller efter en genindlæsning.';
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

  form.appendChild(el('p', 'koord-arkiv-confirm-text', 'De tilhørende filer bliver ikke slettet fra github.'));

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = koordPillBtn('Slet', 'site-pill-danger');
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
// Runs the four (well, six) steps of a Manus year-close in order, reporting
// progress via onProgress(text) before each step starts. Throws (with a
// Danish message) on the first failing step — every step here is either a
// pure read, a guarded-idempotent create, or a plain overwrite of a known
// target shape, so it's always safe to just fix the problem and re-run the
// whole sequence rather than needing any rollback logic (see the plan's own
// note on this).
async function koordCloseYear({ closingFolder, closingName, closingYear, newFolder }, onProgress) {
  onProgress('Henter nuværende scenes.json og cast.json...');
  const rawBase = 'https://raw.githubusercontent.com/carljarner/matrevy/main/';
  const [scenesText, castText] = await Promise.all([
    fetch(rawBase + 'data/scenes.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('Kunne ikke hente data/scenes.json fra GitHub.'); return r.text(); }),
    fetch(rawBase + 'data/cast.json', { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('Kunne ikke hente data/cast.json fra GitHub.'); return r.text(); }),
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
      manusPdf: `archive/${closingFolder}/Manuskript.pdf`,
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

  onProgress('Skifter til den nye produktionsmappe...');
  const configRes = await siteSaveResource('config', { currentProductionFolder: newFolder });
  if (!configRes.ok) throw new Error(configRes.message || 'Kunne ikke skifte produktionsmappe.');

  onProgress('Færdig!');
}

// ── Modal ─────────────────────────────────────────────────────
function openCloseYearModal(closingFolder) {
  const { modal, form, error, actions, close } = siteOpenEditModal('Afslut produktionsår');
  modal.classList.add('koord-close-year-modal');

  const intro = el('p', 'koord-modal-intro',
    `Dette nulstiller Manus (scener, rollebesætning, indsendte manuskripter) og gør en ny mappe til den aktive produktion. Den nuværende mappe ("${closingFolder}") ændres ikke og bliver stående i arkivet.`);
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

  const newFolderInput = document.createElement('input');
  newFolderInput.type = 'text';
  newFolderInput.value = koordSuggestNextFolder(closingFolder);
  form.appendChild(siteEditField('Ny produktionsmappe', newFolderInput));

  const progress = el('div', 'koord-progress');
  form.appendChild(progress);

  const cancelBtn = koordPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = koordPillBtn('Afslut år og start nyt', 'site-pill-primary');
  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    const closingName = nameInput.value.trim();
    const closingYear = Number(yearInput.value);
    const newFolder = newFolderInput.value.trim();

    if (!closingName) { error.textContent = 'Angiv et navn til det afsluttende år.'; return; }
    if (!Number.isInteger(closingYear) || closingYear < 1900 || closingYear > 2100) {
      error.textContent = 'Angiv et gyldigt årstal.';
      return;
    }
    if (!/^[A-Za-z0-9_-]+$/.test(newFolder)) {
      error.textContent = 'Ny produktionsmappe må kun indeholde bogstaver, tal, "_" og "-".';
      return;
    }
    if (newFolder === closingFolder) {
      error.textContent = 'Den nye produktionsmappe skal være forskellig fra den nuværende.';
      return;
    }

    cancelBtn.disabled = true;
    confirmBtn.disabled = true;
    try {
      await koordCloseYear(
        { closingFolder, closingName, closingYear, newFolder },
        (text) => { progress.textContent = text; }
      );
      // CONFIG_DATA is this tab's embedded snapshot from page load — it has
      // no localStorage override mechanism (unlike calendar/archive/posts/
      // wiki/manus), so the status card above can't reflect the new
      // production folder until a reload picks up the regenerated
      // config-data.js (~1-2 min, same GitHub Action lag as everywhere
      // else on this site). Say so explicitly rather than silently
      // re-rendering a status card that would still show the old folder.
      progress.textContent = `Nyt produktionsår startet (${newFolder}). Genindlæs siden om et par minutter for at se det afspejlet ovenfor.`;
      siteShowToast('Nyt produktionsår startet');
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

// ── Page render ──────────────────────────────────────────────
function renderKoordinator(root) {
  root.textContent = '';

  const folder = koordCurrentFolder();

  // Card 1: current production status + the two-step year-close workflow —
  // previously three separate cards, combined into one section per request.
  const prodCard = el('section', 'card');
  const prodHead = el('div', 'card-head');
  prodHead.appendChild(el('h2', null, 'Afslut produktionsår'));
  prodCard.appendChild(prodHead);

  prodCard.appendChild(el('p', null, folder
    ? `Aktiv produktionsmappe: ${folder}`
    : 'Ingen aktiv produktionsmappe fundet (data/config.json).'));
  const manusLink = document.createElement('a');
  manusLink.href = 'manus.html';
  manusLink.textContent = 'Gå til Manus-siden';
  manusLink.className = 'btn-small';
  prodCard.appendChild(manusLink);

  prodCard.appendChild(el('h3', 'koord-step-heading', 'Trin 1: Klargør de endelige filer'));
  prodCard.appendChild(el('p', null,
    'Færdiggør alle rettelser i Manus, og klik der på "Generér PDF\'er". Det genkompilerer hver scenes .tex/.pdf med den ' +
    'endelige tekst og rollebesætning og gemmer dem i arkivet (tager et par minutter). Bekræft herunder, at det er landet, ' +
    'før du går videre til trin 2.'));
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
  prodCard.appendChild(checkRow);

  prodCard.appendChild(el('h3', 'koord-step-heading', 'Trin 2: Afslut år og start nyt'));
  prodCard.appendChild(el('p', null,
    'Nulstiller Manus (scener, rollebesætning, indsendte manuskripter) til et nyt, tomt produktionsår og gemmer et ' +
    'snapshot af scenes.json/cast.json i arkivet. Gør dette KUN efter at have bekræftet trin 1 ovenfor — se ' +
    'beskrivelsen i modalen for detaljer.'));
  const closeBtn = el('button', 'btn-small', 'Afslut produktionsår');
  closeBtn.type = 'button';
  closeBtn.disabled = !folder;
  closeBtn.addEventListener('click', () => openCloseYearModal(folder));
  prodCard.appendChild(closeBtn);

  // Card 2: Arkiv — a small sidebar card with just Rediger (pick a year from
  // a dropdown, like Manus's "Manus" quick-link picker) and Tilføj. No year
  // list is shown directly on this page (archive.js's own openYearEditor()/
  // deleteYear() exist but were never wired to any UI on arkiv.html either).
  const arkivCard = el('section', 'card');
  const arkivHead = el('div', 'card-head');
  arkivHead.appendChild(el('h2', null, 'Arkiv'));
  arkivCard.appendChild(arkivHead);
  arkivCard.appendChild(el('p', null, 'Tilføj eller redigér tidligere års arkivindgange.'));
  const arkivBody = el('div');
  arkivBody.id = 'koord-arkiv-body';
  arkivCard.appendChild(arkivBody);

  const columns = el('div', 'koord-columns');
  columns.appendChild(prodCard);
  columns.appendChild(arkivCard);
  root.appendChild(columns);

  renderArkivSection();
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
