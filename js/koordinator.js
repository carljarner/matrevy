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

// ── PDF freshness poll (duplicated from manus.js's manusFetchPdfStatus/
// manusPdfReferenceUrl — see file header) ──────────────────────────
async function koordFetchPdfStatus(url) {
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
    const archiveRes = await siteSaveResource('archive', { years: nextYears });
    if (!archiveRes.ok) throw new Error(archiveRes.message || 'Kunne ikke oprette arkiv-indgangen.');
    koordArchiveOverride = nextYears;
    siteSaveOverride('archive', nextYears);
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

  // Card 1: current production status.
  const statusCard = el('section', 'card');
  const statusHead = el('div', 'card-head');
  statusHead.appendChild(el('h2', null, 'Nuværende produktion'));
  statusCard.appendChild(statusHead);
  statusCard.appendChild(el('p', null, folder
    ? `Aktiv produktionsmappe: ${folder}`
    : 'Ingen aktiv produktionsmappe fundet (data/config.json).'));
  const manusLink = document.createElement('a');
  manusLink.href = 'manus.html';
  manusLink.textContent = 'Gå til Manus-siden';
  manusLink.className = 'btn-small';
  statusCard.appendChild(manusLink);
  root.appendChild(statusCard);

  // Card 2: step 1 — confirm the final .tex/PDF regeneration has landed.
  const step1Card = el('section', 'card');
  const step1Head = el('div', 'card-head');
  step1Head.appendChild(el('h2', null, 'Trin 1: Klargør de endelige filer'));
  step1Card.appendChild(step1Head);
  step1Card.appendChild(el('p', null,
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
  step1Card.appendChild(checkRow);
  root.appendChild(step1Card);

  // Card 3: step 2 — the actual close-year reset.
  const step2Card = el('section', 'card');
  const step2Head = el('div', 'card-head');
  step2Head.appendChild(el('h2', null, 'Trin 2: Afslut år og start nyt'));
  step2Card.appendChild(step2Head);
  step2Card.appendChild(el('p', null,
    'Nulstiller Manus (scener, rollebesætning, indsendte manuskripter) til et nyt, tomt produktionsår og gemmer et ' +
    'snapshot af scenes.json/cast.json i arkivet. Gør dette KUN efter at have bekræftet trin 1 ovenfor — se ' +
    'beskrivelsen i modalen for detaljer.'));
  const closeBtn = el('button', 'btn-small', 'Afslut produktionsår');
  closeBtn.type = 'button';
  closeBtn.disabled = !folder;
  closeBtn.addEventListener('click', () => openCloseYearModal(folder));
  step2Card.appendChild(closeBtn);
  root.appendChild(step2Card);
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
