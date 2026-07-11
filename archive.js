/* =========================================================
   Matematikrevyen – Arkiv (arkiv.html)
   Renders ARCHIVE_DATA (embedded from data/archive.json): one
   card per previous year with manus PDF link + external video
   links. Admins add/edit/delete years, saved globally via
   siteSaveResource ('archive' resource in server/update-data.php).

   PDF files themselves are committed manually under arkiv/<year>/
   (git), never uploaded via this tool — this only stores the path.

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

// ── Data (with in-memory shadow after a save) ────────────────
let archiveOverride = null;

function getEffectiveYears() {
  return archiveOverride || ARCHIVE_DATA;
}

// ── Rendering ────────────────────────────────────────────────
function renderArchive() {
  const list = document.getElementById('arkiv-list');
  const adminSlot = document.getElementById('arkiv-admin');
  if (!list || !adminSlot) return;

  const isAdmin = siteHasLevel('admin');

  adminSlot.textContent = '';
  if (isAdmin) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-small';
    addBtn.textContent = '+ Tilføj årgang';
    addBtn.addEventListener('click', () => openYearEditor(null));
    adminSlot.appendChild(addBtn);
  }

  const years = getEffectiveYears().slice().sort((a, b) => b.year - a.year);

  list.textContent = '';
  if (years.length === 0) {
    const card = document.createElement('section');
    card.className = 'card';
    const p = document.createElement('p');
    p.textContent = 'Arkivet er tomt endnu. Tidligere års manus og videoer tilføjes her.';
    card.appendChild(p);
    list.appendChild(card);
    return;
  }

  for (const entry of years) {
    const card = document.createElement('section');
    card.className = 'card';

    const head = document.createElement('div');
    head.className = 'card-head';
    const h2 = document.createElement('h2');
    h2.textContent = entry.title
      ? `Matematikrevyen ${entry.year} · ${entry.title}`
      : `Matematikrevyen ${entry.year}`;
    head.appendChild(h2);
    if (isAdmin) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => openYearEditor(entry));
      head.appendChild(editBtn);
    }
    card.appendChild(head);

    const manus = document.createElement('p');
    if (entry.manusPdf) {
      const a = document.createElement('a');
      a.href = entry.manusPdf;
      a.textContent = 'Manus (PDF)';
      manus.appendChild(a);
    } else {
      manus.textContent = 'Intet manus uploadet endnu.';
    }
    card.appendChild(manus);

    if (entry.videos && entry.videos.length > 0) {
      const ul = document.createElement('ul');
      for (const video of entry.videos) {
        const li = document.createElement('li');
        const a = document.createElement('a');
        a.href = video.url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = video.label;
        li.appendChild(a);
        ul.appendChild(li);
      }
      card.appendChild(ul);
    }

    list.appendChild(card);
  }
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

// ── Editor modal ─────────────────────────────────────────────
function openYearEditor(existing) {
  const { form, error, actions, close } = siteOpenEditModal(existing ? 'Rediger årgang' : 'Tilføj årgang');

  const yearInput = document.createElement('input');
  yearInput.type = 'number';
  yearInput.min = '1900';
  yearInput.max = '2100';
  yearInput.value = existing ? String(existing.year) : String(new Date().getFullYear());
  form.appendChild(siteEditField('Årstal', yearInput));

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing ? existing.title || '' : '';
  form.appendChild(siteEditField('Titel (valgfri)', titleInput));

  const pdfInput = document.createElement('input');
  pdfInput.type = 'text';
  pdfInput.placeholder = 'arkiv/2025/manus.pdf';
  pdfInput.value = existing ? existing.manusPdf || '' : '';
  form.appendChild(siteEditField('Manus PDF-sti (lægges i repoet manuelt)', pdfInput));

  // Dynamic video rows: [label input | url input | ✕].
  const videosLabel = document.createElement('div');
  videosLabel.className = 'edit-field';
  const vl = document.createElement('label');
  vl.textContent = 'Videoer (eksterne links)';
  videosLabel.appendChild(vl);
  form.appendChild(videosLabel);

  const videoRows = document.createElement('div');
  form.appendChild(videoRows);

  function addVideoRow(video) {
    const row = document.createElement('div');
    row.className = 'edit-field-row';
    const labelInput = document.createElement('input');
    labelInput.type = 'text';
    labelInput.placeholder = 'Etiket';
    labelInput.value = video ? video.label : '';
    const urlInput = document.createElement('input');
    urlInput.type = 'text';
    urlInput.placeholder = 'https://…';
    urlInput.value = video ? video.url : '';
    const remove = document.createElement('button');
    remove.className = 'btn-small btn-small-danger';
    remove.textContent = '✕';
    remove.addEventListener('click', () => row.remove());
    const labelField = siteEditField('', labelInput);
    const urlField = siteEditField('', urlInput);
    row.appendChild(labelField);
    row.appendChild(urlField);
    row.appendChild(remove);
    row.getVideo = () => ({ label: labelInput.value.trim(), url: urlInput.value.trim() });
    videoRows.appendChild(row);
  }

  for (const video of (existing && existing.videos) || []) addVideoRow(video);

  const addVideoBtn = document.createElement('button');
  addVideoBtn.className = 'btn-small';
  addVideoBtn.textContent = '+ Tilføj video';
  addVideoBtn.addEventListener('click', () => addVideoRow(null));
  form.appendChild(addVideoBtn);

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
    // parseInt so the payload carries a real number — the server's
    // is_int check rejects a string year.
    const year = parseInt(yearInput.value, 10);
    if (!Number.isInteger(year) || year < 1900 || year > 2100) {
      error.textContent = 'Angiv et gyldigt årstal (1900–2100).';
      return;
    }
    const current = getEffectiveYears();
    const duplicate = current.some(e => e.year === year && (!existing || e.year !== existing.year));
    if (duplicate) {
      error.textContent = `Årgangen ${year} findes allerede.`;
      return;
    }

    const videos = [];
    for (const row of videoRows.children) {
      const video = row.getVideo();
      if (!video.label && !video.url) continue; // silently drop empty rows
      if (!video.label || !/^https?:\/\//.test(video.url)) {
        error.textContent = 'Hver video skal have både en etiket og et link, der starter med http:// eller https://.';
        return;
      }
      videos.push(video);
    }

    const item = {
      year,
      title: titleInput.value.trim(),
      manusPdf: pdfInput.value.trim(),
      videos,
    };
    const next = existing
      ? current.map(e => (e.year === existing.year ? item : e))
      : current.concat([item]);

    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';
    const result = await saveYears(next);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) close();
    else error.textContent = result.message;
  });

  yearInput.focus();
}

async function deleteYear(entry) {
  if (!confirm(`Slet årgangen ${entry.year} fra arkivet?`)) return;
  const next = getEffectiveYears().filter(e => e.year !== entry.year);
  const result = await saveYears(next);
  if (!result.ok && result.message) alert(result.message);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderArchive);
