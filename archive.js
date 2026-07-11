/* =========================================================
   Matematikrevyen – Arkiv (arkiv.html)
   Renders ARCHIVE_DATA (embedded from data/archive.json) as a
   poster grid: one card per previous year with a cover photo,
   a YouTube link, and a manuscript PDF link. Admins add/edit/
   delete years directly through the browser — cover photos,
   manuscripts, and individual sketch/song/other-material files
   are uploaded here and committed to the repo under
   archive/<folder>/ via server/update-data.php's 'upload'/
   'delete' actions (see siteUploadFile/siteDeleteFile in
   site-utils.js). Metadata itself still saves globally via
   siteSaveResource ('archive' resource).

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
    card.appendChild(buildPoster(entry));

    const body = document.createElement('div');
    body.className = 'arkiv-card-body';

    const head = document.createElement('div');
    head.className = 'arkiv-card-head';
    const h2 = document.createElement('h2');
    h2.textContent = entry.name;
    head.appendChild(h2);
    if (isAdmin) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => openYearEditor(entry));
      head.appendChild(editBtn);
    }
    body.appendChild(head);

    const manus = document.createElement('p');
    if (entry.manusPdf) {
      const a = document.createElement('a');
      a.href = entry.manusPdf;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Manus (PDF)';
      manus.appendChild(a);
    } else {
      manus.textContent = 'Intet manus uploadet endnu.';
    }
    body.appendChild(manus);

    if (entry.youtubeUrl) {
      const p = document.createElement('p');
      const a = document.createElement('a');
      a.href = entry.youtubeUrl;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = 'Se video (YouTube)';
      p.appendChild(a);
      body.appendChild(p);
    }

    card.appendChild(body);
    list.appendChild(card);
  }

  if (isAdmin) {
    const addTile = document.createElement('article');
    addTile.className = 'arkiv-add-tile';
    addTile.setAttribute('role', 'button');
    addTile.setAttribute('tabindex', '0');
    addTile.setAttribute('aria-label', 'Tilføj årgang');
    addTile.textContent = '+';
    addTile.addEventListener('click', () => openYearEditor(null));
    addTile.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openYearEditor(null); }
    });
    list.appendChild(addTile);
  }
}

function buildPoster(entry) {
  const wrap = document.createElement('div');
  if (entry.coverImage) {
    const img = document.createElement('img');
    img.className = 'arkiv-poster';
    img.src = entry.coverImage;
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = entry.name;
    img.addEventListener('error', () => wrap.replaceChildren(buildPlaceholder(entry)), { once: true });
    wrap.appendChild(img);
  } else {
    wrap.appendChild(buildPlaceholder(entry));
  }
  return wrap;
}

function buildPlaceholder(entry) {
  const ph = document.createElement('div');
  ph.className = 'arkiv-poster-placeholder';
  ph.textContent = String(entry.year);
  return ph;
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

function sanitizeUploadFilename(filename) {
  const dot = filename.lastIndexOf('.');
  const base = dot === -1 ? filename : filename.slice(0, dot);
  const ext = dot === -1 ? '' : filename.slice(dot);
  const map = { æ: 'ae', ø: 'oe', å: 'aa', Æ: 'Ae', Ø: 'Oe', Å: 'Aa' };
  let cleanBase = base.replace(/[æøåÆØÅ]/g, (ch) => map[ch])
    .replace(/\s+/g, '_')
    .replace(/[^A-Za-z0-9_-]/g, '');
  if (!cleanBase) cleanBase = 'fil';
  const cleanExt = ext.replace(/[^A-Za-z0-9.]/g, '').toLowerCase();
  return cleanBase + cleanExt;
}

function buildArchivePath(folder, kind, filename) {
  if (kind === 'cover') return `archive/${folder}/cover.jpg`;
  if (kind === 'manus') return `archive/${folder}/manus.pdf`;
  return `archive/${folder}/${kind}/${sanitizeUploadFilename(filename)}`;
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

// ── File-list section (sketches / songs / andet) ─────────────
// Manages both already-uploaded files (removable via a queued
// delete) and newly picked pending files (uploaded only on Gem).
function buildFileListSection(sectionLabel, existingList) {
  const wrap = document.createElement('div');
  wrap.className = 'edit-field';
  const lbl = document.createElement('label');
  lbl.textContent = sectionLabel;
  wrap.appendChild(lbl);

  const rowsEl = document.createElement('div');
  wrap.appendChild(rowsEl);

  const keptExisting = (existingList || []).slice();
  const pendingRemovePaths = [];
  const pendingAdds = [];

  function renderRows() {
    rowsEl.textContent = '';
    for (const f of keptExisting) {
      const row = document.createElement('div');
      row.className = 'edit-field-row';
      const a = document.createElement('a');
      a.href = f.path;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = f.filename;
      const remove = document.createElement('button');
      remove.className = 'btn-small btn-small-danger';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        const idx = keptExisting.indexOf(f);
        if (idx !== -1) keptExisting.splice(idx, 1);
        pendingRemovePaths.push(f.path);
        renderRows();
      });
      row.appendChild(a);
      row.appendChild(remove);
      rowsEl.appendChild(row);
    }
    for (const file of pendingAdds) {
      const row = document.createElement('div');
      row.className = 'edit-field-row arkiv-pending-row';
      const span = document.createElement('span');
      span.textContent = `${file.name} (afventer upload)`;
      const remove = document.createElement('button');
      remove.className = 'btn-small btn-small-danger';
      remove.textContent = '✕';
      remove.addEventListener('click', () => {
        const idx = pendingAdds.indexOf(file);
        if (idx !== -1) pendingAdds.splice(idx, 1);
        renderRows();
      });
      row.appendChild(span);
      row.appendChild(remove);
      rowsEl.appendChild(row);
    }
  }
  renderRows();

  const btnRow = document.createElement('div');
  btnRow.className = 'arkiv-upload-buttons';
  for (const ext of ['pdf', 'tex']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-small';
    btn.textContent = `Upload .${ext}`;
    const hiddenInput = document.createElement('input');
    hiddenInput.type = 'file';
    hiddenInput.accept = '.' + ext;
    hiddenInput.style.display = 'none';
    hiddenInput.addEventListener('change', () => {
      const file = hiddenInput.files[0];
      if (file) { pendingAdds.push(file); renderRows(); }
      hiddenInput.value = '';
    });
    btn.addEventListener('click', () => hiddenInput.click());
    btnRow.appendChild(btn);
    btnRow.appendChild(hiddenInput);
  }
  wrap.appendChild(btnRow);

  return {
    element: wrap,
    getKeptExisting: () => keptExisting,
    getPendingAdds: () => pendingAdds,
    getPendingRemovePaths: () => pendingRemovePaths,
  };
}

// ── Editor modal ─────────────────────────────────────────────
function openYearEditor(existing) {
  const { form, error, actions, close } = siteOpenEditModal(existing ? 'Rediger årgang' : 'Tilføj årgang');

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.placeholder = 'MatRevy 2024';
  nameInput.value = existing ? existing.name : '';
  form.appendChild(siteEditField('Navn', nameInput));

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = existing ? String(existing.year) : '';
  form.appendChild(siteEditField('Årstal', yearInput));

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
  form.appendChild(coverField);

  const youtubeInput = document.createElement('input');
  youtubeInput.type = 'url';
  youtubeInput.placeholder = 'https://www.youtube.com/watch?v=...';
  youtubeInput.value = existing ? existing.youtubeUrl || '' : '';
  form.appendChild(siteEditField('Link til YouTube', youtubeInput));

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
  form.appendChild(manusField);

  const sketchesSection = buildFileListSection('Upload individuelle sketches', existing ? existing.sketches : []);
  form.appendChild(sketchesSection.element);
  const songsSection = buildFileListSection('Upload individuelle sange', existing ? existing.songs : []);
  form.appendChild(songsSection.element);
  const andetSection = buildFileListSection('Andet materiale', existing ? existing.andet : []);
  form.appendChild(andetSection.element);

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
    const duplicateYear = current.some((e) => e.year === year && (!existing || e.folder !== existing.folder));
    if (duplicateYear) {
      error.textContent = `Årgangen ${year} findes allerede.`;
      return;
    }

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

    const allPending = [
      pendingCover, pendingManus,
      ...sketchesSection.getPendingAdds(), ...songsSection.getPendingAdds(), ...andetSection.getPendingAdds(),
    ].filter(Boolean);
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
      manusPdf: existing ? existing.manusPdf || '' : '',
      sketches: sketchesSection.getKeptExisting(),
      songs: songsSection.getKeptExisting(),
      andet: andetSection.getKeptExisting(),
    };

    const uploadSteps = [];
    if (pendingCover) uploadSteps.push({ kind: 'cover', file: pendingCover });
    if (pendingManus) uploadSteps.push({ kind: 'manus', file: pendingManus });
    const sectionsByKind = { sketches: sketchesSection, songs: songsSection, andet: andetSection };
    for (const kind of ['sketches', 'songs', 'andet']) {
      for (const file of sectionsByKind[kind].getPendingAdds()) uploadSteps.push({ kind, file });
    }
    const deletePaths = [
      ...sketchesSection.getPendingRemovePaths(),
      ...songsSection.getPendingRemovePaths(),
      ...andetSection.getPendingRemovePaths(),
    ];

    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';

    for (const path of deletePaths) {
      const delResult = await siteDeleteFile(path);
      if (!delResult.ok) {
        save.disabled = false;
        save.textContent = 'Gem';
        error.textContent = delResult.message || 'Kunne ikke slette en fil.';
        return;
      }
    }

    const uploaded = [];
    for (let i = 0; i < uploadSteps.length; i++) {
      progress.textContent = `Gemmer fil ${i + 1}/${uploadSteps.length}…`;
      const { kind, file } = uploadSteps[i];
      const blob = kind === 'cover' ? await compressCoverImage(file) : file;
      const dataUrl = await readFileAsDataURL(blob);
      const path = buildArchivePath(folder, kind, file.name);
      const result = await siteUploadFile(path, stripDataUrlPrefix(dataUrl));
      if (!result.ok) {
        save.disabled = false;
        save.textContent = 'Gem';
        progress.textContent = '';
        error.textContent = `${result.message} (${uploaded.length}/${uploadSteps.length} filer blev gemt før fejlen. Prøv igen — allerede uploadede filer bliver ikke uploadet igen.)`;
        return;
      }
      uploaded.push({ kind, path, filename: file.name });
    }
    progress.textContent = '';

    for (const u of uploaded) {
      if (u.kind === 'cover') entryDraft.coverImage = u.path;
      else if (u.kind === 'manus') entryDraft.manusPdf = u.path;
      else entryDraft[u.kind].push({ filename: u.filename, path: u.path });
    }

    const next = existing
      ? current.map((e) => (e.folder === existing.folder ? entryDraft : e))
      : current.concat([entryDraft]);

    const result = await saveYears(next);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) close();
    else error.textContent = result.message;
  });

  nameInput.focus();
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderArchive);
