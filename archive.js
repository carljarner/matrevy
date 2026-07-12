/* =========================================================
   Matematikrevyen – Arkiv (arkiv.html)
   Renders ARCHIVE_DATA (embedded from data/archive.json) as a
   poster grid: one square-cover card per previous year with the
   title as a caption. Clicking any card opens a read-only detail
   overlay (16:9 cover, title, and Manus/YouTube/Spotify/GitHub/
   Drive link pills); admins also get an Edit button there into the
   year editor. The GitHub pill is derived from the entry's folder
   (archive/<folder>) — that's where per-year sketch/song/other .tex
   sources are browsed; the archive no longer tracks them per file.
   Cover photos and the manuscript PDF are uploaded here and
   committed under archive/<folder>/ via server/update-data.php's
   'upload' action (see siteUploadFile in site-utils.js); metadata
   saves globally via siteSaveResource ('archive' resource).

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

const ARCHIVE_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// ── Data (with in-memory shadow after a save) ────────────────
let archiveOverride = null;

function getEffectiveYears() {
  return archiveOverride || ARCHIVE_DATA;
}

// ── Rendering ────────────────────────────────────────────────
function renderArchive() {
  const list = document.getElementById('arkiv-list');
  if (!list) return;

  const isAdmin = siteHasLevel('admin');
  const years = getEffectiveYears().slice().sort((a, b) => b.year - a.year);

  list.textContent = '';
  if (years.length === 0 && !isAdmin) {
    const empty = document.createElement('p');
    empty.className = 'arkiv-empty';
    empty.textContent = 'Arkivet er tomt endnu. Tidligere års manus og videoer tilføjes her.';
    list.appendChild(empty);
    return;
  }

  for (const entry of years) {
    const card = document.createElement('article');
    card.className = 'arkiv-card';
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', entry.name);
    card.appendChild(buildPoster(entry, 'square'));

    const body = document.createElement('div');
    body.className = 'arkiv-card-body';

    const h2 = document.createElement('h2');
    h2.className = 'arkiv-card-title';
    h2.textContent = entry.name;
    body.appendChild(h2);

    card.appendChild(body);

    const openThis = () => openYearDetail(entry);
    card.addEventListener('click', openThis);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThis(); }
    });

    list.appendChild(card);
  }
}

// variant: 'square' (1:1, grid cards) or 'wide' (16:9, overlay cover).
function buildPoster(entry, variant) {
  const modifier = variant === 'wide' ? 'arkiv-poster--wide' : 'arkiv-poster--square';
  const wrap = document.createElement('div');
  if (entry.coverImage) {
    const img = document.createElement('img');
    img.className = `arkiv-poster ${modifier}`;
    img.src = entry.coverImage;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = entry.name;
    img.addEventListener('error', () => wrap.replaceChildren(buildPlaceholder(entry, modifier)), { once: true });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(buildPlaceholder(entry, modifier));
  }
  return wrap;
}

function buildPlaceholder(entry, modifier) {
  const ph = document.createElement('div');
  ph.className = `arkiv-poster-placeholder ${modifier || 'arkiv-poster--square'}`;
  ph.textContent = String(entry.year);
  return ph;
}

// ── Icon buttons (PDF / YouTube) ──────────────────────────────
// Built via SVG DOM methods, never innerHTML, per the page's no-innerHTML rule.
function svgEl(tag, attrs) {
  const el = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const key in attrs) el.setAttribute(key, attrs[key]);
  return el;
}

function buildPdfIcon() {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  svg.appendChild(svgEl('path', { d: 'M6 2h9l5 5v15H6z' }));
  svg.appendChild(svgEl('path', { d: 'M15 2v5h5' }));
  return svg;
}

function buildPlayIcon() {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  svg.appendChild(svgEl('circle', { cx: '12', cy: '12', r: '10' }));
  svg.appendChild(svgEl('path', { d: 'M10 8.5l6 3.5-6 3.5z', fill: 'currentColor', stroke: 'none' }));
  return svg;
}

function buildSpotifyIcon() {
  const svg = svgEl('svg', {
    viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
  });
  svg.appendChild(svgEl('circle', { cx: '12', cy: '12', r: '10' }));
  svg.appendChild(svgEl('path', { d: 'M7.5 9.5c3-.8 6.3-.5 9 1.2' }));
  svg.appendChild(svgEl('path', { d: 'M8 13c2.4-.6 5-.4 7.2 1' }));
  svg.appendChild(svgEl('path', { d: 'M8.5 16c1.8-.4 3.7-.3 5.4.8' }));
  return svg;
}

function buildGithubIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '18', height: '18' });
  svg.appendChild(svgEl('path', {
    fill: 'currentColor', stroke: 'none',
    d: 'M12 .5C5.37.5 0 5.87 0 12.5c0 5.3 3.44 9.8 8.21 11.39.6.11.82-.26.82-.58 '
      + '0-.29-.01-1.05-.02-2.06-3.34.73-4.04-1.61-4.04-1.61-.55-1.39-1.34-1.76-1.34-1.76'
      + '-1.09-.75.08-.73.08-.73 1.21.09 1.84 1.24 1.84 1.24 1.07 1.84 2.81 1.31 3.5 1 '
      + '.11-.78.42-1.31.76-1.61-2.67-.3-5.47-1.34-5.47-5.95 0-1.31.47-2.38 1.24-3.22'
      + '-.12-.3-.54-1.52.12-3.17 0 0 1.01-.32 3.3 1.23a11.5 11.5 0 0 1 6 0c2.29-1.55 3.3-1.23 '
      + '3.3-1.23.66 1.65.24 2.87.12 3.17.77.84 1.24 1.91 1.24 3.22 0 4.62-2.81 5.64-5.49 5.94'
      + '.43.37.81 1.1.81 2.22 0 1.6-.01 2.9-.01 3.29 0 .32.22.7.83.58A12 12 0 0 0 24 12.5'
      + 'C24 5.87 18.63.5 12 .5z',
  }));
  return svg;
}

// Google Drive logo — three brand-coloured panels forming the folded triangle.
function buildDriveIcon() {
  const svg = svgEl('svg', { viewBox: '0 0 24 24', width: '18', height: '18', class: 'arkiv-drive-icon' });
  // left (blue)
  svg.appendChild(svgEl('path', { fill: '#2684fc', stroke: 'none', d: 'M7.71 3.5 1.15 15l3.43 5.94 6.56-11.44z' }));
  // right (yellow)
  svg.appendChild(svgEl('path', { fill: '#ffba00', stroke: 'none', d: 'M16.29 3.5H9.43l6.56 11.5h6.86z' }));
  // bottom (green)
  svg.appendChild(svgEl('path', { fill: '#00ac47', stroke: 'none', d: 'M4.57 21.44h13.14l3.42-5.94H8z' }));
  return svg;
}

// Labeled pill button (icon + text), used in the detail overlay. A falsy href
// renders a muted, non-clickable placeholder (a <span>) instead of a link, so a
// year missing e.g. a Spotify URL still shows a greyed-out Spotify pill.
function buildActionButton(href, label, iconEl, extraClass) {
  const el = href ? document.createElement('a') : document.createElement('span');
  el.className = 'arkiv-action-btn' + (href && extraClass ? ' ' + extraClass : '') + (href ? '' : ' arkiv-action-disabled');
  if (href) {
    el.href = href;
    el.target = '_blank';
    el.rel = 'noopener';
    el.addEventListener('click', (e) => e.stopPropagation());
  } else {
    el.setAttribute('aria-disabled', 'true');
  }
  el.appendChild(iconEl);
  const text = document.createElement('span');
  text.textContent = label;
  el.appendChild(text);
  return el;
}

const GITHUB_ARCHIVE_BASE = 'https://github.com/carljarner/matrevy/tree/main/archive/';

// All five pills always render; missing links come through greyed and unclickable.
// Two explicit rows (media / repository) in a column container so a single gap
// governs both the horizontal button spacing and the vertical row spacing.
function buildActionRow(entry) {
  const wrap = document.createElement('div');
  wrap.className = 'arkiv-action-rows';

  const media = document.createElement('div');
  media.className = 'arkiv-action-row';
  media.appendChild(buildActionButton(entry.manusPdf, 'Manus', buildPdfIcon()));
  media.appendChild(buildActionButton(entry.youtubeUrl, 'YouTube', buildPlayIcon(), 'arkiv-action-youtube'));
  media.appendChild(buildActionButton(entry.spotifyUrl, 'Spotify', buildSpotifyIcon(), 'arkiv-action-spotify'));
  wrap.appendChild(media);

  const repo = document.createElement('div');
  repo.className = 'arkiv-action-row';
  repo.appendChild(buildActionButton(entry.folder ? GITHUB_ARCHIVE_BASE + entry.folder : '', 'GitHub', buildGithubIcon()));
  repo.appendChild(buildActionButton(entry.driveUrl, 'Drive', buildDriveIcon(), 'arkiv-action-drive'));
  wrap.appendChild(repo);

  return wrap;
}

// ── Read-only detail overlay ──────────────────────────────────
function openYearDetail(entry) {
  const overlay = document.createElement('div');
  overlay.className = 'login-overlay arkiv-detail-overlay';

  function close() { overlay.remove(); }
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

  const modal = document.createElement('div');
  modal.className = 'login-modal arkiv-detail-modal';

  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'arkiv-detail-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Luk');
  closeBtn.addEventListener('click', close);
  modal.appendChild(closeBtn);

  const cover = document.createElement('div');
  cover.className = 'arkiv-detail-cover';
  cover.appendChild(buildPoster(entry, 'wide'));
  modal.appendChild(cover);

  const body = document.createElement('div');
  body.className = 'arkiv-detail-body';

  const title = document.createElement('h2');
  title.className = 'arkiv-detail-title';
  title.textContent = entry.name;
  body.appendChild(title);

  const actionRow = buildActionRow(entry);
  if (actionRow.children.length > 0) body.appendChild(actionRow);

  modal.appendChild(body);
  overlay.appendChild(modal);
  document.body.appendChild(overlay);
}

// ── Name -> folder/year helpers ──────────────────────────────
// Applied once at creation; the folder must stay stable afterward
// or already-uploaded file paths would orphan.
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

// ── Binary file helpers ───────────────────────────────────────
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

// Cover photos are always re-encoded to JPEG so the stored filename/
// extension never changes across re-uploads (overwrite-in-place with
// no orphan-cleanup needed for a changed extension).
async function compressCoverImage(file, { maxWidth = 1600, quality = 0.8 } = {}) {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, maxWidth / bitmap.width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// ── Saving ───────────────────────────────────────────────────
async function saveYears(next) {
  const result = await siteSaveResource('archive', { years: next });
  if (result.ok) {
    archiveOverride = next;
    renderArchive();
  }
  return result;
}

async function deleteYear(entry) {
  if (!confirm(`Slet årgangen "${entry.name}" fra arkivet? Uploadede filer bliver ikke slettet fra reposet.`)) return;
  const next = getEffectiveYears().filter((e) => e.folder !== entry.folder);
  const result = await saveYears(next);
  if (!result.ok && result.message) alert(result.message);
}

// ── Editor modal ─────────────────────────────────────────────
function openYearEditor(existing) {
  const { modal, form, error, actions, close } = siteOpenEditModal(existing ? 'Rediger årgang' : 'Tilføj årgang');
  modal.classList.add('arkiv-edit-modal');

  // All fields live in one metadata card (individual-file tracking was removed —
  // sketches/songs/andet now live in the repo, linked from the overlay's GitHub button).
  const metaGroup = document.createElement('div');
  metaGroup.className = 'arkiv-edit-group';

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'MatRevy 2024';
  nameInput.value = existing ? existing.name : '';
  metaGroup.appendChild(siteEditField('Navn', nameInput));

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = existing ? String(existing.year) : '';
  metaGroup.appendChild(siteEditField('Årstal', yearInput));

  if (!existing) {
    let yearTouched = false;
    yearInput.addEventListener('input', () => { yearTouched = true; });
    nameInput.addEventListener('input', () => {
      if (yearTouched) return;
      const m = nameInput.value.match(/\b(19|20)\d{2}\b/);
      if (m) yearInput.value = m[0];
    });
  }

  const coverPreview = document.createElement('img');
  coverPreview.className = 'arkiv-edit-preview';
  if (existing && existing.coverImage) {
    coverPreview.src = existing.coverImage;
  } else {
    coverPreview.style.display = 'none';
  }
  const coverInput = document.createElement('input');
  coverInput.type = 'file';
  coverInput.accept = 'image/*';
  let pendingCover = null;
  coverInput.addEventListener('change', () => {
    const file = coverInput.files[0];
    if (!file) return;
    pendingCover = file;
    coverPreview.src = URL.createObjectURL(file);
    coverPreview.style.display = '';
  });
  const coverField = siteEditField('Cover-foto', coverInput);
  coverField.appendChild(coverPreview);
  metaGroup.appendChild(coverField);

  const youtubeInput = document.createElement('input');
  youtubeInput.type = 'url';
  youtubeInput.placeholder = 'https://www.youtube.com/watch?v=...';
  youtubeInput.value = existing ? existing.youtubeUrl || '' : '';
  metaGroup.appendChild(siteEditField('Link til YouTube', youtubeInput));

  const spotifyInput = document.createElement('input');
  spotifyInput.type = 'url';
  spotifyInput.placeholder = 'https://open.spotify.com/album/...';
  spotifyInput.value = existing ? existing.spotifyUrl || '' : '';
  metaGroup.appendChild(siteEditField('Link til Spotify', spotifyInput));

  const driveInput = document.createElement('input');
  driveInput.type = 'url';
  driveInput.placeholder = 'https://drive.google.com/drive/folders/...';
  driveInput.value = existing ? existing.driveUrl || '' : '';
  metaGroup.appendChild(siteEditField('Link til Google Drive', driveInput));

  const manusCurrentLink = document.createElement('a');
  manusCurrentLink.target = '_blank';
  manusCurrentLink.rel = 'noopener';
  manusCurrentLink.textContent = 'Nuværende manus (PDF)';
  manusCurrentLink.className = 'arkiv-edit-current-link';
  if (existing && existing.manusPdf) {
    manusCurrentLink.href = existing.manusPdf;
  } else {
    manusCurrentLink.style.display = 'none';
  }
  const manusInput = document.createElement('input');
  manusInput.type = 'file';
  manusInput.accept = 'application/pdf,.pdf';
  let pendingManus = null;
  manusInput.addEventListener('change', () => {
    pendingManus = manusInput.files[0] || null;
  });
  const manusField = siteEditField('Manuskript (PDF)', manusInput);
  manusField.appendChild(manusCurrentLink);
  metaGroup.appendChild(manusField);

  form.appendChild(metaGroup);

  const progress = document.createElement('div');
  progress.className = 'arkiv-edit-progress';
  form.appendChild(progress);

  const save = document.createElement('button');
  save.className = 'site-btn-primary';
  save.textContent = 'Gem';
  const cancel = document.createElement('button');
  cancel.className = 'site-btn-secondary';
  cancel.textContent = 'Annuller';

  if (existing) {
    const del = document.createElement('button');
    del.className = 'site-btn-secondary edit-actions-left';
    del.textContent = 'Slet årgang';
    del.addEventListener('click', () => { close(); deleteYear(existing); });
    actions.appendChild(del);
  }
  actions.appendChild(save);
  actions.appendChild(cancel);
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    const name = nameInput.value.trim();
    if (!name) {
      error.textContent = 'Navnet er påkrævet.';
      return;
    }

    const year = parseInt(yearInput.value, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      error.textContent = 'Angiv et gyldigt årstal (1900–2100).';
      return;
    }

    const current = getEffectiveYears();
    // Year is not unique (e.g. a jubilee revy in the same year as a regular one);
    // folder is the stable unique key, enforced below.

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

    if (pendingManus) {
      const isPdf = pendingManus.type === 'application/pdf' || /\.pdf$/i.test(pendingManus.name);
      if (!isPdf) {
        error.textContent = 'Manuskriptet skal være en PDF-fil.';
        return;
      }
    }

    const allPending = [pendingCover, pendingManus].filter(Boolean);
    const oversized = allPending.filter((f) => f.size > ARCHIVE_MAX_UPLOAD_BYTES);
    if (oversized.length > 0) {
      error.textContent = `Følgende fil(er) er for store (maks. 5 MB): ${oversized.map((f) => f.name).join(', ')}`;
      return;
    }

    const entryDraft = {
      year,
      name,
      folder,
      coverImage: existing ? existing.coverImage || '' : '',
      youtubeUrl: youtubeInput.value.trim(),
      spotifyUrl: spotifyInput.value.trim(),
      driveUrl: driveInput.value.trim(),
      manusPdf: existing ? existing.manusPdf || '' : '',
    };

    const uploadSteps = [];
    if (pendingCover) uploadSteps.push({ kind: 'cover', file: pendingCover });
    if (pendingManus) uploadSteps.push({ kind: 'manus', file: pendingManus });

    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';

    const uploaded = [];
    for (let i = 0; i < uploadSteps.length; i++) {
      progress.textContent = `Gemmer fil ${i + 1}/${uploadSteps.length}…`;
      const { kind, file } = uploadSteps[i];
      const blob = kind === 'cover' ? await compressCoverImage(file) : file;
      const dataUrl = await readFileAsDataURL(blob);
      const path = buildArchivePath(folder, kind);
      const result = await siteUploadFile(path, stripDataUrlPrefix(dataUrl));
      if (!result.ok) {
        save.disabled = false;
        save.textContent = 'Gem';
        progress.textContent = '';
        error.textContent = `${result.message} (${uploaded.length}/${uploadSteps.length} filer blev gemt før fejlen. Prøv igen — allerede uploadede filer bliver ikke uploadet igen.)`;
        return;
      }
      uploaded.push({ kind, path });
    }
    progress.textContent = '';

    for (const u of uploaded) {
      if (u.kind === 'cover') entryDraft.coverImage = u.path;
      else if (u.kind === 'manus') entryDraft.manusPdf = u.path;
    }

    const next = existing
      ? current.map((e) => (e.folder === existing.folder ? entryDraft : e))
      : current.concat([entryDraft]);

    const result = await saveYears(next);
    if (result.ok) {
      progress.textContent = 'Gemt! Det kan tage et par minutter, før ændringen er synlig for andre eller efter en genindlæsning.';
      save.textContent = 'Gemt';
      setTimeout(close, 1400);
    } else {
      save.disabled = false;
      save.textContent = 'Gem';
      error.textContent = result.message;
    }
  });

  nameInput.focus();
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderArchive);
