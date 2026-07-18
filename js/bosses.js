/* =========================================================
   Matematikrevyen – "Bosser for ..." info card on Forside
   Renders BOSSES_DATA (embedded from data/bosses.json): a title plus an
   ordered list of {names, role} rows. Admin-only "Rediger" button next
   to the title opens an overlay to edit the title and each row's
   names/role text, with add/remove — same siteSaveResource full-array
   -replace pattern as calendar.js/archive.js (this resource is `admin`
   level, not `boss`, since it's the site's technical maintainer's info
   card to correct, not a coordinator task).

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

// ── Data (with in-memory shadow after a save) ─────────────────
let bossesOverride = null;

function getEffectiveBosses() {
  return bossesOverride || BOSSES_DATA;
}

// ── Render ─────────────────────────────────────────────────────
function renderBosses() {
  const data = getEffectiveBosses();

  const titleEl = document.getElementById('bosses-title');
  if (titleEl) titleEl.textContent = data.title;

  const list = document.getElementById('bosses-list');
  if (list) {
    list.textContent = '';
    for (const r of data.roles) {
      const li = document.createElement('li');

      const namesEl = document.createElement('span');
      namesEl.className = 'boss-name';
      namesEl.textContent = r.names;
      li.appendChild(namesEl);

      const roleEl = document.createElement('span');
      roleEl.className = 'boss-role';
      roleEl.textContent = r.role;
      li.appendChild(roleEl);

      list.appendChild(li);
    }
  }

  const adminSlot = document.getElementById('bosses-admin');
  if (adminSlot) {
    adminSlot.textContent = '';
    if (siteHasLevel('admin')) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => openBossesEditModal());
      adminSlot.appendChild(editBtn);
    }
  }
}

// ── Edit (admin only) ────────────────────────────────────────
function openBossesEditModal() {
  const existing = getEffectiveBosses();
  const { form, error, actions, close } = siteOpenModalWithClose('Rediger bosser');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing.title;
  form.appendChild(siteEditField('Titel', titleInput));

  const rowsWrap = document.createElement('div');
  rowsWrap.className = 'boss-edit-rows';
  form.appendChild(rowsWrap);

  // Working copy, edited in place and fully re-rendered on add/remove —
  // same shape as calendar.js/import.js's own row lists.
  const roles = existing.roles.map(r => ({ ...r }));

  function renderRows() {
    rowsWrap.textContent = '';
    roles.forEach((r, i) => {
      const row = document.createElement('div');
      row.className = 'boss-edit-row';

      const namesInput = document.createElement('input');
      namesInput.type = 'text';
      namesInput.value = r.names;
      namesInput.placeholder = 'Navn(e), adskilt med komma';
      namesInput.addEventListener('input', () => { r.names = namesInput.value; });
      row.appendChild(siteEditField('Navn(e)', namesInput));

      const roleInput = document.createElement('input');
      roleInput.type = 'text';
      roleInput.value = r.role;
      roleInput.placeholder = 'Rolle';
      roleInput.addEventListener('input', () => { r.role = roleInput.value; });
      row.appendChild(siteEditField('Rolle', roleInput));

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'boss-edit-remove';
      rmBtn.textContent = '✕';
      rmBtn.setAttribute('aria-label', 'Fjern rolle');
      rmBtn.title = 'Fjern rolle';
      rmBtn.addEventListener('click', () => { roles.splice(i, 1); renderRows(); });
      row.appendChild(rmBtn);

      rowsWrap.appendChild(row);
    });
  }
  renderRows();

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'btn-small';
  addBtn.textContent = '+ Tilføj rolle';
  addBtn.addEventListener('click', () => { roles.push({ names: '', role: '' }); renderRows(); });
  form.appendChild(addBtn);

  const save = document.createElement('button');
  save.className = 'site-pill-btn site-pill-primary';
  save.textContent = 'Gem';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    if (!title) {
      error.textContent = 'Udfyld titel.';
      return;
    }
    // Drop rows the admin added but never filled in — never persist a
    // fully-blank row.
    const roleList = roles
      .map(r => ({ names: r.names.trim(), role: r.role.trim() }))
      .filter(r => r.names || r.role);

    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';
    const payload = { title, roles: roleList };
    const result = await siteSaveResource('bosses', payload);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) {
      bossesOverride = payload;
      renderBosses();
      close();
    } else if (result.message) {
      error.textContent = result.message;
    }
  });
}

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderBosses);
