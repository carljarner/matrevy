/* =========================================================
   Matematikrevyen – Announcements on Forside
   Renders ANNOUNCEMENTS_DATA (embedded from data/announcements.json)
   filtered by the visitor's level; admins get in-page
   add/edit/delete which saves globally via siteSaveResource
   ('announcements' resource in server/update-data.php).

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

// ── Data (with in-memory shadow after a save) ────────────────
// Same idea as manus-data.js: the embed regeneration takes ~1-2
// min, so a successful save shows immediately in this tab only.
let announcementsOverride = null;

function getEffectiveAnnouncements() {
  return announcementsOverride || ANNOUNCEMENTS_DATA;
}

// ── Rendering ────────────────────────────────────────────────
function renderAnnouncements() {
  const list = document.getElementById('announcement-list');
  const adminSlot = document.getElementById('announcement-admin');
  if (!list || !adminSlot) return;

  const isAdmin = siteHasLevel('admin');
  const canSeeRevyst = siteHasLevel('revyst');

  adminSlot.textContent = '';
  if (isAdmin) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-small';
    addBtn.textContent = '+ Ny besked';
    addBtn.addEventListener('click', () => openAnnouncementEditor(null));
    adminSlot.appendChild(addBtn);
  }

  const visible = getEffectiveAnnouncements()
    .filter(a => a.level === 'public' || canSeeRevyst)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  list.textContent = '';
  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Ingen beskeder i øjeblikket.';
    list.appendChild(empty);
    return;
  }

  for (const ann of visible) {
    const article = document.createElement('article');
    article.className = 'message';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const metaText = document.createElement('span');
    metaText.textContent = `${formatDaDate(ann.date)} · ${ann.author}`;
    meta.appendChild(metaText);
    if (ann.level === 'revyst') {
      const badge = document.createElement('span');
      badge.className = 'message-badge';
      badge.textContent = 'Kun revyster';
      meta.appendChild(badge);
    }
    if (isAdmin) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => openAnnouncementEditor(ann));
      meta.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-small btn-small-danger';
      delBtn.textContent = 'Slet';
      delBtn.addEventListener('click', () => deleteAnnouncement(ann));
      meta.appendChild(delBtn);
    }
    article.appendChild(meta);

    for (const line of String(ann.text).split('\n')) {
      if (!line.trim()) continue;
      const p = document.createElement('p');
      p.textContent = line;
      article.appendChild(p);
    }

    list.appendChild(article);
  }
}

// ── Saving ───────────────────────────────────────────────────
async function saveAnnouncements(next) {
  const result = await siteSaveResource('announcements', { announcements: next });
  if (result.ok) {
    announcementsOverride = next;
    renderAnnouncements();
  }
  return result;
}

// ── Editor modal ─────────────────────────────────────────────
function openAnnouncementEditor(existing) {
  const { form, error, actions, close } = siteOpenEditModal(existing ? 'Rediger besked' : 'Ny besked');

  const dateInput = document.createElement('input');
  dateInput.type = 'date';
  dateInput.value = existing ? existing.date : todayIso();
  form.appendChild(siteEditField('Dato', dateInput));

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  authorInput.value = existing ? existing.author : 'Koordinatorerne';
  form.appendChild(siteEditField('Afsender', authorInput));

  const levelSelect = document.createElement('select');
  for (const [value, label] of [['public', 'Offentlig'], ['revyst', 'Kun revyster']]) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    levelSelect.appendChild(opt);
  }
  levelSelect.value = existing ? existing.level : 'public';
  form.appendChild(siteEditField('Synlighed', levelSelect));

  const textArea = document.createElement('textarea');
  textArea.value = existing ? existing.text : '';
  form.appendChild(siteEditField('Besked', textArea));

  const save = document.createElement('button');
  save.className = 'site-btn-primary';
  save.textContent = 'Gem';
  const cancel = document.createElement('button');
  cancel.className = 'site-btn-secondary';
  cancel.textContent = 'Annuller';
  actions.appendChild(save);
  actions.appendChild(cancel);
  cancel.addEventListener('click', close);

  save.addEventListener('click', async () => {
    const date = dateInput.value;
    const text = textArea.value.trim();
    if (!date || !text) {
      error.textContent = 'Udfyld både dato og besked.';
      return;
    }
    const item = {
      id: existing ? existing.id : Date.now().toString(36),
      date,
      author: authorInput.value.trim() || 'Koordinatorerne',
      level: levelSelect.value,
      text,
    };
    const current = getEffectiveAnnouncements();
    const next = existing
      ? current.map(a => (a.id === existing.id ? item : a))
      : current.concat([item]);

    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';
    const result = await saveAnnouncements(next);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) close();
    else error.textContent = result.message;
  });

  textArea.focus();
}

async function deleteAnnouncement(ann) {
  if (!confirm('Slet denne besked?')) return;
  const next = getEffectiveAnnouncements().filter(a => a.id !== ann.id);
  const result = await saveAnnouncements(next);
  if (!result.ok && result.message) alert(result.message);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderAnnouncements);
