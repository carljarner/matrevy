/* =========================================================
   Matematikrevyen – Schedule Tool
   ========================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────
let state = {
  rooms: [],
  slots: [],        // [{ label, startMinutes }]
  absentees: [],    // [name, ...]
  // grid[slotIdx][roomIdx] = { sceneId, autoPlaced } | null
  grid: [],
  scenes: [],       // schedulable scenes with priority
  allScenes: [],    // all scenes from JSON
};

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-build').addEventListener('click', buildGrid);
  document.getElementById('btn-export').addEventListener('click', () => window.print());
  document.getElementById('btn-autoplace').addEventListener('click', autoPlace);
  document.getElementById('btn-clear-auto').addEventListener('click', clearAutoPlaced);
  document.getElementById('scene-search').addEventListener('input', renderSceneSidebar);
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePicker();
  });
  document.getElementById('picker-search').addEventListener('input', renderPickerList);

  // Restore from localStorage if available
  restoreState();
});

// ── Time helpers ──────────────────────────────────────────
function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}
function minutesToTime(m) {
  const h = Math.floor(m / 60);
  const min = m % 60;
  return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}
function buildSlots(startTime, endTime) {
  const start = timeToMinutes(startTime);
  const end   = timeToMinutes(endTime);
  const slots = [];
  for (let t = start; t + 30 <= end; t += 35) {
    slots.push({ label: minutesToTime(t) + ' – ' + minutesToTime(t + 30), startMinutes: t });
  }
  return slots;
}

// ── Load scenes ───────────────────────────────────────────
// Data is embedded via scenes-data.js (SCENES_DATA constant) to avoid
// fetch() failing on file:// protocol when opened locally.
async function loadScenes() {
  if (state.allScenes.length) return;
  state.allScenes = SCENES_DATA; // defined in scenes-data.js
}

// ── Build grid ────────────────────────────────────────────
async function buildGrid() {
  await loadScenes();

  const startTime = document.getElementById('input-start').value || '10:00';
  const endTime   = document.getElementById('input-end').value   || '17:00';
  const dateVal   = document.getElementById('input-date').value;

  const roomLines = document.getElementById('input-rooms').value
    .split('\n').map(r => r.trim()).filter(Boolean);
  const absentLines = document.getElementById('input-absent').value
    .split('\n').map(n => n.trim()).filter(Boolean);

  if (!roomLines.length) { alert('Tilføj mindst ét lokale.'); return; }
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    alert('Sluttidspunktet skal være efter starttidspunktet.'); return;
  }

  // Preserve existing grid assignments if rooms/slots match
  const newSlots = buildSlots(startTime, endTime);
  const slotsMatch = JSON.stringify(newSlots) === JSON.stringify(state.slots);
  const roomsMatch = JSON.stringify(roomLines) === JSON.stringify(state.rooms);

  state.rooms    = roomLines;
  state.slots    = newSlots;
  state.absentees = absentLines;

  // Build scenes list, keep priorities if we have them
  const prevPriorities = {};
  for (const sc of state.scenes) prevPriorities[sc.id] = sc.priority;

  const prevOverrides = {};
  for (const sc of state.scenes) prevOverrides[sc.id] = sc.override;

  state.scenes = state.allScenes
    .filter(s => s.schedulable)
    .map(s => ({ ...s, priority: prevPriorities[s.id] ?? s.priority ?? 0, override: prevOverrides[s.id] ?? false }));

  // Reset grid only if layout changed
  if (!slotsMatch || !roomsMatch) {
    state.grid = state.slots.map(() => state.rooms.map(() => null));
  } else {
    // Ensure grid dimensions match (add/remove rows/cols)
    state.grid = state.slots.map((_, si) =>
      state.rooms.map((_, ri) => (state.grid[si] && state.grid[si][ri] !== undefined)
        ? state.grid[si][ri] : null)
    );
  }

  // Title
  const title = dateVal
    ? 'Øveplan · ' + new Date(dateVal + 'T12:00:00').toLocaleDateString('da-DK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
    : 'Øveplan';
  document.getElementById('sched-grid-title').textContent = title;

  document.getElementById('sched-empty-state').style.display = 'none';
  document.getElementById('sched-grid-container').style.display = 'block';
  document.getElementById('scene-sidebar').style.display = 'block';

  renderGrid();
  renderSceneSidebar();
  saveState();
}

// ── Render grid ───────────────────────────────────────────
function renderGrid() {
  const thead = document.getElementById('sched-thead');
  const tbody = document.getElementById('sched-tbody');

  // Header row
  let hRow = '<tr><th class="col-time">Tidspunkt</th>';
  for (const room of state.rooms) hRow += `<th>${escHtml(room)}</th>`;
  hRow += '</tr>';
  thead.innerHTML = hRow;

  // Body rows
  tbody.innerHTML = '';
  state.slots.forEach((slot, si) => {
    const tr = document.createElement('tr');
    // Time cell
    const timeTd = document.createElement('td');
    timeTd.className = 'col-time';
    timeTd.textContent = slot.label;
    tr.appendChild(timeTd);

    // Room cells
    state.rooms.forEach((_, ri) => {
      const td = document.createElement('td');
      td.dataset.slot = si;
      td.dataset.room = ri;
      renderCell(td, si, ri);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
}

function renderCell(td, si, ri) {
  const assignment = state.grid[si][ri];
  td.innerHTML = '';
  td.ondragover  = null;
  td.ondrop      = null;
  td.ondragleave = null;

  const inner = document.createElement('div');
  inner.className = 'cell-inner';

  if (!assignment) {
    inner.classList.add('cell-empty');
    inner.innerHTML = '<div class="cell-plus">+</div>';
    inner.onclick = () => openPicker(si, ri);
    inner.ondragover = e => { e.preventDefault(); highlightDrop(td, si, ri); };
    inner.ondragleave = () => clearDropHighlight(td);
    inner.ondrop = e => { e.preventDefault(); handleDrop(si, ri); };
  } else {
    const scene = getSceneById(assignment.sceneId);
    const conflicts = getConflicts(si, ri, assignment.sceneId);
    inner.classList.add('cell-filled');
    if (assignment.autoPlaced) inner.classList.add('is-autoplace');
    if (conflicts.length) inner.classList.add('has-conflict');
    inner.draggable = true;
    inner.ondragstart = () => startDrag(assignment.sceneId, si, ri);
    inner.ondragover  = e => { e.preventDefault(); highlightDrop(td, si, ri); };
    inner.ondragleave = () => clearDropHighlight(td);
    inner.ondrop      = e => { e.preventDefault(); handleDrop(si, ri); };

    // Scene name
    const nameEl = document.createElement('div');
    nameEl.className = 'cell-scene-name';
    nameEl.textContent = scene ? scene.name : assignment.sceneId;
    inner.appendChild(nameEl);

    // Cast list
    if (scene && scene.cast.length) {
      const castEl = document.createElement('div');
      castEl.className = 'cell-cast-list';
      castEl.innerHTML = scene.cast.map(c => {
        const absent = state.absentees.includes(c.name);
        return `<span class="${absent ? 'absent' : ''}">${escHtml(c.name)}</span>`;
      }).join(', ');
      inner.appendChild(castEl);
    }

    // Conflict badge
    if (conflicts.length) {
      const badge = document.createElement('div');
      badge.className = 'conflict-badge';
      badge.textContent = '⚠ ' + conflicts.join(', ');
      inner.appendChild(badge);
    }

    // Remove button
    const removeBtn = document.createElement('button');
    removeBtn.className = 'cell-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Fjern scene';
    removeBtn.onclick = e => { e.stopPropagation(); removeFromCell(si, ri); };
    inner.appendChild(removeBtn);
  }

  td.appendChild(inner);
}

// ── Conflict detection ────────────────────────────────────
function getConflicts(si, ri, sceneId) {
  const scene = getSceneById(sceneId);
  if (!scene || !scene.cast.length) return [];
  const castNames = scene.cast.map(c => c.name);
  const conflicts = [];
  state.rooms.forEach((_, otherRi) => {
    if (otherRi === ri) return;
    const other = state.grid[si][otherRi];
    if (!other) return;
    const otherScene = getSceneById(other.sceneId);
    if (!otherScene) return;
    const otherCast = otherScene.cast.map(c => c.name);
    const clash = castNames.filter(n => otherCast.includes(n) && !state.absentees.includes(n));
    if (clash.length) conflicts.push(...clash);
  });
  return [...new Set(conflicts)];
}

function castConflictsAt(si, sceneId, excludeRi = -1) {
  // Returns true if placing sceneId at slotSi would create a cast conflict
  const scene = getSceneById(sceneId);
  if (!scene || !scene.cast.length) return false;
  const castNames = new Set(scene.cast.map(c => c.name).filter(n => !state.absentees.includes(n)));
  for (let ri = 0; ri < state.rooms.length; ri++) {
    if (ri === excludeRi) continue;
    const other = state.grid[si][ri];
    if (!other) continue;
    const otherScene = getSceneById(other.sceneId);
    if (!otherScene) continue;
    for (const c of otherScene.cast) {
      if (castNames.has(c.name)) return true;
    }
  }
  return false;
}

function hasAbsentBlocker(sceneId) {
  const scene = getSceneById(sceneId);
  if (!scene) return false;
  return scene.cast.some(c => state.absentees.includes(c.name));
}

// ── Drag & drop ───────────────────────────────────────────
let dragState = null; // { sceneId, fromSlot, fromRoom }

function startDrag(sceneId, fromSlot, fromRoom) {
  dragState = { sceneId, fromSlot: fromSlot ?? null, fromRoom: fromRoom ?? null };
  // Mark chip as dragging
  const chip = document.querySelector(`.scene-chip[data-id="${sceneId}"]`);
  if (chip) chip.classList.add('dragging');
}

function highlightDrop(td, si, ri) {
  clearAllDropHighlights();
  if (!dragState) return;
  const wouldConflict = castConflictsAt(si, dragState.sceneId,
    dragState.fromSlot === si ? dragState.fromRoom : -1);
  td.querySelector('.cell-inner').classList.add(wouldConflict ? 'cell-drop-blocked' : 'cell-drop-target');
}

function clearDropHighlight(td) {
  const inner = td.querySelector('.cell-inner');
  if (inner) { inner.classList.remove('cell-drop-target', 'cell-drop-blocked'); }
}

function clearAllDropHighlights() {
  document.querySelectorAll('.cell-drop-target, .cell-drop-blocked').forEach(el => {
    el.classList.remove('cell-drop-target', 'cell-drop-blocked');
  });
}

function handleDrop(toSlot, toRoom) {
  clearAllDropHighlights();
  if (!dragState) return;
  const { sceneId, fromSlot, fromRoom } = dragState;
  dragState = null;

  // Remove chip dragging style
  document.querySelectorAll('.scene-chip.dragging').forEach(c => c.classList.remove('dragging'));

  // Don't drop onto itself
  if (fromSlot === toSlot && fromRoom === toRoom) return;

  // If source was a grid cell, vacate it
  if (fromSlot !== null && fromRoom !== null) {
    state.grid[fromSlot][fromRoom] = null;
  }

  // Place in target (swap if occupied)
  const existing = state.grid[toSlot][toRoom];
  state.grid[toSlot][toRoom] = { sceneId, autoPlaced: false };
  if (existing && fromSlot !== null && fromRoom !== null) {
    state.grid[fromSlot][fromRoom] = { ...existing, autoPlaced: false };
  }

  renderGrid();
  renderSceneSidebar();
  saveState();
}

// ── Remove from cell ──────────────────────────────────────
function removeFromCell(si, ri) {
  state.grid[si][ri] = null;
  const td = document.querySelector(`td[data-slot="${si}"][data-room="${ri}"]`);
  if (td) renderCell(td, si, ri);
  renderSceneSidebar();
  saveState();
}

// ── Scene sidebar ─────────────────────────────────────────
function renderSceneSidebar() {
  const query = (document.getElementById('scene-search').value || '').toLowerCase();
  const placed = getPlacedSceneIds();

  // Count unplaced
  const unplaced = state.scenes.filter(s => !placed.has(s.id));
  document.getElementById('scene-count-label').textContent =
    `(${unplaced.length} tilbage af ${state.scenes.length})`;

  const container = document.getElementById('scene-list');
  container.innerHTML = '';

  // Group by act
  const byAct = {};
  for (const scene of state.scenes) {
    if (query && !scene.name.toLowerCase().includes(query)) continue;
    if (!byAct[scene.actLabel]) byAct[scene.actLabel] = [];
    byAct[scene.actLabel].push(scene);
  }

  for (const [actLabel, scenes] of Object.entries(byAct)) {
    const header = document.createElement('div');
    header.className = 'picker-act-label';
    header.textContent = actLabel;
    container.appendChild(header);

    for (const scene of scenes) {
      const isPlaced = placed.has(scene.id);
      const chip = document.createElement('div');
      chip.className = 'scene-chip' + (isPlaced ? ' placed' : '');
      chip.dataset.id = scene.id;
      chip.draggable = !isPlaced;
      chip.ondragstart = () => startDrag(scene.id, null, null);

      // Priority badge + selector
      const prioSpan = document.createElement('span');
      prioSpan.className = `chip-priority prio-${scene.priority}`;
      prioSpan.textContent = scene.priority;

      const prioSel = document.createElement('select');
      prioSel.className = 'chip-prio-select';
      prioSel.title = 'Prioritet';
      [0,1,2,3].forEach(v => {
        const opt = document.createElement('option');
        opt.value = v; opt.textContent = v;
        if (v === scene.priority) opt.selected = true;
        prioSel.appendChild(opt);
      });
      prioSel.onchange = e => {
        e.stopPropagation();
        scene.priority = parseInt(e.target.value);
        prioSpan.textContent = scene.priority;
        prioSpan.className = `chip-priority prio-${scene.priority}`;
        saveState();
      };
      prioSel.ondragstart = e => e.stopPropagation();

      const nameSpan = document.createElement('span');
      nameSpan.className = 'chip-name';
      nameSpan.textContent = scene.name;

      // Override toggle (allow placement despite absent cast)
      const overrideLabel = document.createElement('label');
      overrideLabel.className = 'chip-override';
      overrideLabel.title = 'Tillad auto-placering selvom nogen mangler';
      const overrideCheck = document.createElement('input');
      overrideCheck.type = 'checkbox';
      overrideCheck.checked = !!scene.override;
      overrideCheck.onchange = e => {
        e.stopPropagation();
        scene.override = e.target.checked;
        saveState();
      };
      overrideCheck.ondragstart = e => e.stopPropagation();
      overrideLabel.appendChild(overrideCheck);
      overrideLabel.insertAdjacentText('beforeend', ' ↩');

      chip.appendChild(prioSpan);
      chip.appendChild(nameSpan);
      chip.appendChild(prioSel);
      chip.appendChild(overrideLabel);
      container.appendChild(chip);
    }
  }
}

// ── Scene picker modal ────────────────────────────────────
let pickerTarget = null; // { si, ri }

function openPicker(si, ri) {
  pickerTarget = { si, ri };
  document.getElementById('picker-search').value = '';
  document.getElementById('picker-overlay').style.display = 'flex';
  renderPickerList();
  document.getElementById('picker-search').focus();
}

function closePicker() {
  document.getElementById('picker-overlay').style.display = 'none';
  pickerTarget = null;
}

function renderPickerList() {
  const query = (document.getElementById('picker-search').value || '').toLowerCase();
  const placed = getPlacedSceneIds();
  const container = document.getElementById('picker-list');
  container.innerHTML = '';

  const byAct = {};
  for (const scene of state.scenes) {
    if (query && !scene.name.toLowerCase().includes(query)) continue;
    if (!byAct[scene.actLabel]) byAct[scene.actLabel] = [];
    byAct[scene.actLabel].push(scene);
  }

  for (const [actLabel, scenes] of Object.entries(byAct)) {
    const header = document.createElement('div');
    header.className = 'picker-act-label';
    header.textContent = actLabel;
    container.appendChild(header);

    for (const scene of scenes) {
      const isPlaced = placed.has(scene.id);
      const item = document.createElement('div');
      item.className = 'picker-item' + (isPlaced ? ' picker-placed' : '');

      const badge = document.createElement('span');
      badge.className = `chip-priority prio-${scene.priority}`;
      badge.textContent = scene.priority;

      const name = document.createElement('span');
      name.textContent = scene.name + (isPlaced ? ' (placeret)' : '');

      item.appendChild(badge);
      item.appendChild(name);

      if (!isPlaced) {
        item.onclick = () => {
          if (!pickerTarget) return;
          state.grid[pickerTarget.si][pickerTarget.ri] = { sceneId: scene.id, autoPlaced: false };
          const td = document.querySelector(`td[data-slot="${pickerTarget.si}"][data-room="${pickerTarget.ri}"]`);
          if (td) renderCell(td, pickerTarget.si, pickerTarget.ri);
          renderSceneSidebar();
          saveState();
          closePicker();
        };
      }
      container.appendChild(item);
    }
  }
}

// ── Auto-place algorithm ──────────────────────────────────
function autoPlace() {
  const placed = getPlacedSceneIds();
  // Collect unplaced priority-3 scenes, sort hardest (most cast) first
  const candidates = state.scenes
    .filter(s => s.priority === 3 && !placed.has(s.id))
    .sort((a, b) => b.cast.length - a.cast.length);

  if (!candidates.length) {
    showAutoplaceSummary('Ingen uplacerede prioritet-3 scener fundet.', 0, 0);
    return;
  }

  let placedCount = 0;
  const blocked = [];

  for (const scene of candidates) {
    // Absent blocker — skip unless coordinator overrode
    if (hasAbsentBlocker(scene.id) && !scene.override) {
      blocked.push(`${scene.name} (fraværende)`);
      continue;
    }
    // Try every slot × room, pick first free cell without cast clash
    let didPlace = false;
    outer:
    for (let si = 0; si < state.slots.length; si++) {
      for (let ri = 0; ri < state.rooms.length; ri++) {
        if (state.grid[si][ri] !== null) continue;
        if (castConflictsAt(si, scene.id)) continue;
        state.grid[si][ri] = { sceneId: scene.id, autoPlaced: true };
        placedCount++;
        didPlace = true;
        break outer;
      }
    }
    if (!didPlace) blocked.push(`${scene.name} (ingen ledig plads)`);
  }

  renderGrid();
  renderSceneSidebar();
  saveState();

  const total = candidates.length + blocked.filter(b => b.includes('fraværende')).length;
  const blockedMsg = blocked.length ? ' Ikke placeret: ' + blocked.join(', ') + '.' : '';
  showAutoplaceSummary(
    `Placerede ${placedCount} prioritet-3 scene${placedCount !== 1 ? 'r' : ''}.` + blockedMsg,
    placedCount,
    blocked.length
  );
}

function clearAutoPlaced() {
  let count = 0;
  for (let si = 0; si < state.grid.length; si++) {
    for (let ri = 0; ri < state.grid[si].length; ri++) {
      if (state.grid[si][ri]?.autoPlaced) {
        state.grid[si][ri] = null;
        count++;
      }
    }
  }
  renderGrid();
  renderSceneSidebar();
  saveState();
  showAutoplaceSummary(
    count ? `Fjernede ${count} auto-placerede scene${count !== 1 ? 'r' : ''}.` : 'Ingen auto-placerede scener at fjerne.',
    0, 0
  );
}

function showAutoplaceSummary(msg, placed, blocked) {
  const el = document.getElementById('autoplace-summary');
  el.style.display = 'block';
  el.className = 'autoplace-summary' + (blocked > 0 ? ' has-blocked' : placed > 0 ? ' has-placed' : '');
  el.textContent = msg;
  clearTimeout(el._hideTimer);
  el._hideTimer = setTimeout(() => { el.style.display = 'none'; }, 8000);
}

// ── Helpers ───────────────────────────────────────────────
function getSceneById(id) {
  return state.allScenes.find(s => s.id === id) || null;
}

function getPlacedSceneIds() {
  const ids = new Set();
  for (const row of state.grid) for (const cell of row) if (cell) ids.add(cell.sceneId);
  return ids;
}

function escHtml(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Persist state ─────────────────────────────────────────
function saveState() {
  try {
    const snapshot = {
      rooms: state.rooms,
      slots: state.slots,
      absentees: state.absentees,
      grid: state.grid,
      priorities: Object.fromEntries(state.scenes.map(s => [s.id, s.priority])),
      overrides:  Object.fromEntries(state.scenes.map(s => [s.id, !!s.override])),
      date: document.getElementById('input-date').value,
      startTime: document.getElementById('input-start').value,
      endTime: document.getElementById('input-end').value,
      roomsRaw: document.getElementById('input-rooms').value,
      absentRaw: document.getElementById('input-absent').value,
    };
    localStorage.setItem('matrevy-schedule', JSON.stringify(snapshot));
  } catch(e) { /* storage full or unavailable */ }
}

async function restoreState() {
  try {
    const raw = localStorage.getItem('matrevy-schedule');
    if (!raw) return;
    const snap = JSON.parse(raw);
    // Restore form fields
    if (snap.date)      document.getElementById('input-date').value    = snap.date;
    if (snap.startTime) document.getElementById('input-start').value   = snap.startTime;
    if (snap.endTime)   document.getElementById('input-end').value     = snap.endTime;
    if (snap.roomsRaw)  document.getElementById('input-rooms').value   = snap.roomsRaw;
    if (snap.absentRaw) document.getElementById('input-absent').value  = snap.absentRaw;
    // Restore grid state
    if (snap.rooms && snap.slots && snap.grid) {
      await loadScenes();
      state.rooms    = snap.rooms;
      state.slots    = snap.slots;
      state.absentees = snap.absentees || [];
      state.grid     = snap.grid;
      state.scenes   = state.allScenes
        .filter(s => s.schedulable)
        .map(s => ({ ...s, priority: snap.priorities?.[s.id] ?? 0, override: snap.overrides?.[s.id] ?? false }));

      const dateVal = snap.date;
      const title = dateVal
        ? 'Øveplan · ' + new Date(dateVal + 'T12:00:00').toLocaleDateString('da-DK', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
        : 'Øveplan';
      document.getElementById('sched-grid-title').textContent = title;
      document.getElementById('sched-empty-state').style.display = 'none';
      document.getElementById('sched-grid-container').style.display = 'block';
      document.getElementById('scene-sidebar').style.display = 'block';

      renderGrid();
      renderSceneSidebar();
    }
  } catch(e) { /* ignore corrupt state */ }
}
