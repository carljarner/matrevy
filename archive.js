/* =========================================================
   Matematikrevyen – Arkiv (arkiv.html)
   Renders ARCHIVE_DATA (embedded from data/archive.json) as a
   poster grid: one clickable card per previous year with a cover
   photo, a centered title, and PDF/YouTube icon buttons. Clicking
   a card opens the admin edit form, or a read-only detail overlay
   (cover, title, icon buttons, and a Sketches/Sange/Andet
   materiale toggle list) for everyone else. Admins add/edit/
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
    card.setAttribute('role', 'button');
    card.setAttribute('tabindex', '0');
    card.setAttribute('aria-label', entry.name);
    card.appendChild(buildPoster(entry));

    const body = document.createElement('div');
    body.className = 'arkiv-card-body';

    const h2 = document.createElement('h2');
    h2.className = 'arkiv-card-title';
    h2.textContent = entry.name;
    body.appendChild(h2);

    const iconRow = buildIconRow(entry);
    if (iconRow.children.length > 0) body.appendChild(iconRow);

    card.appendChild(body);

    const openThis = () => { if (isAdmin) openYearEditor(entry); else openYearDetail(entry); };
    card.addEventListener('click', openThis);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openThis(); }
    });

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

function buildIconButton(href, label, iconEl) {
  const a = document.createElement('a');
  a.className = 'arkiv-icon-btn';
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener';
  a.setAttribute('aria-label', label);
  a.title = label;
  a.appendChild(iconEl);
  a.addEventListener('click', (e) => e.stopPropagation());
  return a;
}

function buildIconRow(entry) {
  const row = document.createElement('div');
  row.className = 'arkiv-icon-row';
  if (entry.manusPdf) row.appendChild(buildIconButton(entry.manusPdf, 'Åbn manus (PDF)', buildPdfIcon()));
  if (entry.youtubeUrl) row.appendChild(buildIconButton(entry.youtubeUrl, 'Se video på YouTube', buildPlayIcon()));
  return row;
}

// ── Read-only detail overlay ──────────────────────────────────
// Groups a file list ({filename, path}[]) by filename stem so e.g.
// "Scene1.pdf" and "Scene1.tex" render as one tagged row.
function groupArchiveFiles(fileList) {
  const order = [];
  const byStem = new Map();
  for (const f of fileList || []) {
    const dot = f.filename.lastIndexOf('.');
    const stem = dot === -1 ? f.filename : f.filename.slice(0, dot);
    const ext = dot === -1 ? '' : f.filename.slice(dot + 1).toLowerCase();
    if (!byStem.has(stem)) {
      byStem.set(stem, { stem, hasPdf: false, hasTex: false });
      order.push(stem);
    }
    const g = byStem.get(stem);
    if (ext === 'pdf') g.hasPdf = true;
    if (ext === 'tex') g.hasTex = true;
  }
  return order.map((s) => byStem.get(s)).sort((a, b) => a.stem.localeCompare(b.stem, 'da'));
}

// Collapsible section (Sketches/Sange/Andet materiale) styled after Øveplan's
// Akt-toggle pattern (import-act-header/-section/-chevron/-count in
// schedule.css) — reimplemented with arkiv-* classes since this page doesn't
// load schedule.css. Open state is local to this call, so it resets each
// time the detail overlay is opened.
function buildToggleSection(label, fileList) {
  const groups = groupArchiveFiles(fileList);
  let open = false;

  const section = document.createElement('div');
  section.className = 'arkiv-toggle-section';

  function render() {
    section.textContent = '';

    const header = document.createElement('div');
    header.className = 'arkiv-toggle-header';
    header.addEventListener('click', () => { open = !open; render(); });

    const chevron = document.createElement('span');
    chevron.className = 'arkiv-toggle-chevron';
    chevron.textContent = open ? '▾' : '▸';
    header.appendChild(chevron);

    const labelEl = document.createElement('span');
    labelEl.className = 'arkiv-toggle-label';
    labelEl.textContent = label;
    header.appendChild(labelEl);

    const count = document.createElement('span');
    count.className = 'arkiv-toggle-count';
    count.textContent = String(groups.length);
    header.appendChild(count);

    section.appendChild(header);

    if (open) {
      if (groups.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'arkiv-toggle-empty';
        empty.textContent = 'Intet materiale uploadet endnu.';
        section.appendChild(empty);
      } else {
        for (const g of groups) {
          const row = document.createElement('div');
          row.className = 'arkiv-scene-row';

          const nameEl = document.createElement('span');
          nameEl.className = 'arkiv-scene-name';
          nameEl.textContent = g.stem;
          row.appendChild(nameEl);

          const tags = document.createElement('span');
          tags.className = 'arkiv-scene-tags';
          if (g.hasPdf) {
            const t = document.createElement('span');
            t.className = 'arkiv-file-tag';
            t.textContent = 'PDF';
            tags.appendChild(t);
          }
          if (g.hasTex) {
            const t = document.createElement('span');
            t.className = 'arkiv-file-tag';
            t.textContent = 'TEX';
            tags.appendChild(t);
          }
          row.appendChild(tags);
          section.appendChild(row);
        }
      }
    }
  }

  render();
  return section;
}

function openYearDetail(entry) {
  const overlay = document.createElement('div');
  overlay.className = 'login-overlay';

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
  cover.appendChild(buildPoster(entry));
  modal.appendChild(cover);

  const body = document.createElement('div');
  body.className = 'arkiv-detail-body';

  const title = document.createElement('h2');
  title.className = 'arkiv-detail-title';
  title.textContent = entry.name;
  body.appendChild(title);

  const iconRow = buildIconRow(entry);
  if (iconRow.children.length > 0) body.appendChild(iconRow);

  body.appendChild(buildToggleSection('Sketches', entry.sketches));
  body.appendChild(buildToggleSection('Sange', entry.songs));
  body.appendChild(buildToggleSection('Andet materiale', entry.andet));

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
