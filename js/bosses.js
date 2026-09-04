/* =========================================================
   Matematikrevyen – "Bosser for ..." info card on Forside
   Renders BOSSES_DATA (embedded from data/bosses.json): a title plus an
   ordered list of {names, role} rows. Admin-only "Rediger" button next
   to the title toggles the card into an inline edit mode — same
   transparent-textfield-in-place pattern as budget.js's own category
   structure editor (buildCategoryEditSection), not a separate overlay:
   the title and each row become editable text, rows are draggable to
   reorder, a small "+" grows the list, and "Rediger" becomes "Annuller"
   with a "Gem" button appearing at the bottom. Same siteSaveResource
   full-array-replace pattern as calendar.js/archive.js (this resource is
   `admin` level, not `boss`, since it's the site's technical maintainer's
   info card to correct, not a coordinator task).

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

// ── Data (with in-memory shadow after a save) ─────────────────
let bossesOverride = null;
// Non-null only while the inline editor is open — {title, roles:[{names,role}]}.
// Created fresh on entering edit mode, mutated in place by the row/drag
// handlers below (so they can re-render just the rows without resetting
// unsaved edits), and dropped on Gem/Annuller.
let bossesEditMode = false;
let bossesDraft = null;
// The row currently being dragged — module-level (not a renderBossesEdit
// closure var) so the list's own fallback drop zone (wired once, see
// renderBossesEdit) can still read it correctly across edit sessions.
let bossesDragItem = null;

function getEffectiveBosses() {
  return bossesOverride || BOSSES_DATA;
}

// The edit bar (add "+" / error / Gem) has no static slot in index.html —
// it's created once, right after the list, and reused across renders.
function getBossesEditBar() {
  const list = document.getElementById('bosses-list');
  if (!list) return null;
  let bar = document.getElementById('bosses-editbar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'bosses-editbar';
    bar.className = 'boss-editbar';
    list.insertAdjacentElement('afterend', bar);
  }
  return bar;
}

// ── Render ─────────────────────────────────────────────────────
function renderBosses() {
  const data = getEffectiveBosses();
  if (bossesEditMode) {
    renderBossesEdit(data);
  } else {
    renderBossesView(data);
  }
}

function renderBossesView(data) {
  const titleEl = document.getElementById('bosses-title');
  if (titleEl) titleEl.textContent = data.title;

  const list = document.getElementById('bosses-list');
  if (list) {
    list.textContent = '';
    list.classList.remove('boss-list-editing');
    for (const r of data.roles) {
      const li = document.createElement('li');

      const roleEl = document.createElement('span');
      roleEl.className = 'boss-role';
      roleEl.textContent = r.role;
      li.appendChild(roleEl);

      const namesEl = document.createElement('span');
      namesEl.className = 'boss-name';
      namesEl.textContent = r.names;
      li.appendChild(namesEl);

      list.appendChild(li);
    }
  }

  const bar = document.getElementById('bosses-editbar');
  if (bar) bar.textContent = '';

  const adminSlot = document.getElementById('bosses-admin');
  if (adminSlot) {
    adminSlot.textContent = '';
    if (siteHasLevel('admin')) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => {
        bossesEditMode = true;
        renderBosses();
      });
      adminSlot.appendChild(editBtn);
    }
  }
}

// A native drag lets the browser snapshot the dragged element itself as the
// drag image, which for one of these rows (handle + two stacked text
// inputs) reads as a messy oversized preview rather than a clean one.
// Routes through one shared, off-screen (not display:none — that would
// keep it from being paintable) <div> instead, restyled with just the
// dragged role's own title (not the person's name(s) — the row's actual
// identity while reordering, matching what the list is organized by)
// right before dragstart calls setDragImage on it — see forms.js's
// formsGetDragImageEl for the page this pattern originated on.
function bossesGetDragImageEl() {
  let ghost = document.getElementById('bosses-drag-image');
  if (!ghost) {
    ghost = document.createElement('div');
    ghost.id = 'bosses-drag-image';
    ghost.className = 'bosses-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// ── Drag reorder helpers (duplicated from budget.js's own
// budgetWireDropHighlight/budgetMoveDraftItem — see CLAUDE.md's
// per-page-duplication convention, since neither file is loaded here).
// `stop` (used on each row, not on the list-level fallback below) mirrors
// manus.js's own wireDropHighlight `stop` option — stopPropagation()s so
// hovering a row doesn't also light up the list container underneath it.
function bossesWireDropHighlight(rowEl, onDrop, { stop = false } = {}) {
  let depth = 0;
  rowEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth++;
    rowEl.classList.add('boss-drop-target');
  });
  rowEl.addEventListener('dragover', (e) => {
    e.preventDefault(); // required for 'drop' to fire
    if (stop) e.stopPropagation();
  });
  rowEl.addEventListener('dragleave', (e) => {
    if (stop) e.stopPropagation();
    depth = Math.max(0, depth - 1);
    if (depth === 0) rowEl.classList.remove('boss-drop-target');
  });
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    if (stop) e.stopPropagation();
    depth = 0;
    rowEl.classList.remove('boss-drop-target');
    onDrop();
  });
}

function bossesMoveDraftItem(draft, item, beforeItem, rerender) {
  const idx = draft.indexOf(item);
  if (idx === -1) return;
  draft.splice(idx, 1);
  const beforeIdx = beforeItem ? draft.indexOf(beforeItem) : -1;
  if (beforeIdx === -1) draft.push(item);
  else draft.splice(beforeIdx, 0, item);
  rerender();
}

// ── Edit (admin only, inline in the card) ───────────────────────
function renderBossesEdit(data) {
  if (!bossesDraft) {
    bossesDraft = {
      title: data.title,
      roles: data.roles.map(r => ({ ...r })),
    };
  }
  const draft = bossesDraft;

  const titleEl = document.getElementById('bosses-title');
  if (titleEl) {
    titleEl.textContent = '';
    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.className = 'boss-manage-text-input boss-manage-title-input';
    titleInput.value = draft.title;
    titleInput.addEventListener('input', () => { draft.title = titleInput.value; });
    titleEl.appendChild(titleInput);
  }

  const list = document.getElementById('bosses-list');

  // Fallback drop zone covering the whole list (mirrors manus.js's
  // wireLaneDropZone) — each row's own drop handler below stops
  // propagation, so this only fires when the drop lands in the padded
  // space below the last row, letting a row be dragged to the very
  // bottom (a per-row-only drop can only ever insert *before* a row).
  // Wired once and reused across edit sessions (guarded via a dataset
  // flag) since `list` is index.html's static node, not recreated per
  // render — re-running renderBossesEdit on every Rediger click would
  // otherwise stack a fresh duplicate listener on it each time. It reads
  // bossesDraft/bossesDragItem live (both module-level) rather than
  // closing over this call's `draft`, so it stays correct however many
  // sessions later it actually fires.
  if (list && !list.dataset.bossesDropZoneWired) {
    list.dataset.bossesDropZoneWired = '1';
    bossesWireDropHighlight(list, () => {
      if (bossesDragItem && bossesDraft) {
        bossesMoveDraftItem(bossesDraft.roles, bossesDragItem, null, renderBosses);
      }
    });
  }

  function renderRows() {
    if (!list) return;
    list.textContent = '';
    list.classList.add('boss-list-editing');
    draft.roles.forEach((r) => {
      const li = document.createElement('li');
      li.className = 'boss-manage-row';
      li.draggable = true;
      li.addEventListener('dragstart', (e) => {
        bossesDragItem = r;
        e.dataTransfer.effectAllowed = 'move';
        const ghost = bossesGetDragImageEl();
        ghost.textContent = r.role;
        e.dataTransfer.setDragImage(ghost, 12, 16);
      });
      li.addEventListener('dragend', () => li.classList.remove('boss-drop-target'));
      bossesWireDropHighlight(li, () => {
        if (bossesDragItem && bossesDragItem !== r) {
          bossesMoveDraftItem(draft.roles, bossesDragItem, r, renderRows);
        }
      }, { stop: true });

      // Purely-visual grab affordance, leading (leftmost) in the row — same
      // glyph/sizing recipe as manus.css's .manus-akt-drag-handle and
      // wiki.css's .wiki-manage-drag-handle, and now their same leading
      // position (this row used to put it rightmost instead).
      const handle = document.createElement('span');
      handle.className = 'boss-manage-drag-handle';
      handle.textContent = '⠿';
      handle.setAttribute('aria-hidden', 'true');
      li.appendChild(handle);

      // Role above names, matching the view-mode row order (.boss-role
      // then .boss-name — see renderBossesView) so toggling Rediger
      // doesn't visibly reorder each row. Grouped in their own column so
      // the remove button can sit to the right, vertically centered,
      // rather than stacking below both text lines.
      const fields = document.createElement('div');
      fields.className = 'boss-manage-fields';

      const roleInput = document.createElement('input');
      roleInput.type = 'text';
      roleInput.className = 'boss-manage-text-input boss-manage-role-input';
      roleInput.placeholder = 'Rolle';
      roleInput.value = r.role;
      roleInput.addEventListener('input', () => { r.role = roleInput.value; });
      fields.appendChild(roleInput);

      const namesInput = document.createElement('input');
      namesInput.type = 'text';
      namesInput.className = 'boss-manage-text-input boss-manage-name-input';
      namesInput.placeholder = 'Navn(e)';
      namesInput.value = r.names;
      namesInput.addEventListener('input', () => { r.names = namesInput.value; });
      fields.appendChild(namesInput);

      li.appendChild(fields);

      const rmBtn = document.createElement('button');
      rmBtn.type = 'button';
      rmBtn.className = 'boss-manage-remove-btn';
      rmBtn.textContent = '✕';
      rmBtn.title = 'Fjern';
      rmBtn.setAttribute('aria-label', 'Fjern');
      rmBtn.addEventListener('click', () => {
        const idx = draft.roles.indexOf(r);
        if (idx !== -1) draft.roles.splice(idx, 1);
        renderRows();
      });
      li.appendChild(rmBtn);

      list.appendChild(li);
    });
  }
  renderRows();

  const bar = getBossesEditBar();
  if (bar) {
    bar.textContent = '';

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'boss-manage-add-plus';
    addBtn.title = 'Tilføj';
    addBtn.setAttribute('aria-label', 'Tilføj');
    addBtn.textContent = '+';
    addBtn.addEventListener('click', () => {
      draft.roles.push({ names: '', role: '' });
      renderRows();
      const last = list && list.lastElementChild;
      const input = last && last.querySelector('.boss-manage-name-input');
      if (input) input.focus();
    });
    bar.appendChild(addBtn);

    const error = document.createElement('div');
    error.className = 'boss-manage-error';
    bar.appendChild(error);

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.className = 'site-btn-success boss-manage-save-btn';
    saveBtn.textContent = 'Gem';
    saveBtn.addEventListener('click', async () => {
      const title = draft.title.trim();
      if (!title) {
        error.textContent = 'Udfyld titel.';
        return;
      }
      // Drop rows the admin added but never filled in — never persist a
      // fully-blank row.
      const roleList = draft.roles
        .map(r => ({ names: r.names.trim(), role: r.role.trim() }))
        .filter(r => r.names || r.role);

      saveBtn.disabled = true;
      error.textContent = '';
      const payload = { title, roles: roleList };
      const result = await siteSaveResource('bosses', payload);
      saveBtn.disabled = false;
      if (result.ok) {
        bossesOverride = payload;
        bossesEditMode = false;
        bossesDraft = null;
        renderBosses();
      } else if (result.message) {
        error.textContent = result.message;
      }
    });
    bar.appendChild(saveBtn);
  }

  const adminSlot = document.getElementById('bosses-admin');
  if (adminSlot) {
    adminSlot.textContent = '';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-small';
    cancelBtn.textContent = 'Annuller';
    cancelBtn.addEventListener('click', () => {
      bossesEditMode = false;
      bossesDraft = null;
      renderBosses();
    });
    adminSlot.appendChild(cancelBtn);
  }
}

// ── Init ───────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderBosses);
