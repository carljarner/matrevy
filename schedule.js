/* =========================================================
   Matematikrevyen – Schedule Tool
   ========================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────
let state = {
  rooms: [],
  slots: [],        // [{ label, startMinutes }]
  absentees: [],    // [name, ...]
  // grid[slotIdx][roomIdx] = { sceneId, customCast? } | null
  grid: [],
  scenes: [],       // schedulable scenes
  allScenes: [],    // all scenes from JSON
};

// ── Custom scenes ─────────────────────────────────────────
// Tool-level utility "scenes" that aren't part of the production's script.
// Kept here (not in data/scenes.json) so they survive being replaced each production.
const SCENEMODE_ID    = 'custom-scenemode';
const REKVISITTEN_ID  = 'custom-rekvisitten';
const CUSTOM_SCENES = [
  { id: SCENEMODE_ID,   name: 'Scenemøde',   actLabel: 'Diverse', duration_minutes: 30, schedulable: true, priority: 0, cast: [], custom: true },
  { id: REKVISITTEN_ID, name: 'Rekvisitten', actLabel: 'Diverse', duration_minutes: 30, schedulable: true, priority: 0, cast: [], custom: true },
];

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-build').addEventListener('click', buildGrid);
  document.getElementById('btn-export').addEventListener('click', () => window.print());
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePicker();
  });
  document.getElementById('picker-confirm').addEventListener('click', confirmPicker);

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
function buildSlots(startTime, endTime, segmentMinutes) {
  const start = timeToMinutes(startTime);
  const end   = timeToMinutes(endTime);
  const slots = [];
  for (let t = start; t + segmentMinutes - 5 <= end; t += segmentMinutes) {
    slots.push({ label: minutesToTime(t) + ' – ' + minutesToTime(t + segmentMinutes), startMinutes: t });
  }
  return slots;
}

// ── Load scenes ───────────────────────────────────────────
// Data is embedded via scenes-data.js (SCENES_DATA constant) to avoid
// fetch() failing on file:// protocol when opened locally.
async function loadScenes() {
  if (state.allScenes.length) return;
  // CUSTOM_SCENES first so they sort above "Akt 1" in the act-grouped lists.
  // getEffectiveScenesData() (manus-data.js) returns the manus-import override
  // from localStorage if present, else falls back to SCENES_DATA (scenes-data.js).
  state.allScenes = [...CUSTOM_SCENES, ...getEffectiveScenesData()];
}

// ── Build grid ────────────────────────────────────────────
async function buildGrid() {
  await loadScenes();

  const startTime = document.getElementById('input-start').value || '10:00';
  const endTime   = document.getElementById('input-end').value   || '17:00';
  const segmentMinutes = parseInt(document.getElementById('input-segment').value, 10) || 30;

  const roomLines = document.getElementById('input-rooms').value
    .split('\n').map(r => r.trim()).filter(Boolean);
  const absentLines = document.getElementById('input-absent').value
    .split('\n').map(n => n.trim()).filter(Boolean);

  if (!roomLines.length) { alert('Tilføj mindst ét lokale.'); return; }
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    alert('Sluttidspunktet skal være efter starttidspunktet.'); return;
  }

  // Preserve existing grid assignments if rooms/slots match
  const newSlots = buildSlots(startTime, endTime, segmentMinutes);
  const slotsMatch = JSON.stringify(newSlots) === JSON.stringify(state.slots);
  const roomsMatch = JSON.stringify(roomLines) === JSON.stringify(state.rooms);

  state.rooms    = roomLines;
  state.slots    = newSlots;
  state.absentees = absentLines;

  // Build scenes list, keep priorities if we have them
  const prevPriorities = {};
  for (const sc of state.scenes) prevPriorities[sc.id] = sc.priority;

  state.scenes = state.allScenes
    .filter(s => s.schedulable)
    .map(s => ({ ...s, priority: prevPriorities[s.id] ?? s.priority ?? 0 }));

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

  document.getElementById('sched-grid-title').textContent = 'Øveplan';
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
    // Time cell — clicking it opens the picker for this slot
    const timeTd = document.createElement('td');
    timeTd.className = 'col-time col-time-clickable';
    timeTd.textContent = slot.label;
    timeTd.title = 'Klik for at tilføje scener til dette tidspunkt';
    timeTd.onclick = () => openPicker(si);
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
    const conflicts = getConflicts(si, ri, assignment);
    inner.classList.add('cell-filled');
    if (conflicts.length) inner.classList.add('has-conflict');
    inner.draggable = true;
    inner.ondragstart = () => startDrag(assignment.sceneId, si, ri, assignment.customCast || null);
    inner.ondragover  = e => { e.preventDefault(); highlightDrop(td, si, ri); };
    inner.ondragleave = () => clearDropHighlight(td);
    inner.ondrop      = e => { e.preventDefault(); handleDrop(si, ri); };

    // Scene name
    const nameEl = document.createElement('div');
    nameEl.className = 'cell-scene-name';
    nameEl.textContent = scene ? scene.name : assignment.sceneId;
    inner.appendChild(nameEl);

    // Cast list
    if (scene && scene.id === SCENEMODE_ID) {
      const castEl = document.createElement('div');
      castEl.className = 'cell-cast-list';
      castEl.textContent = 'Alle';
      inner.appendChild(castEl);
    } else if (scene && scene.id === REKVISITTEN_ID) {
      const names = assignment.customCast || [];
      if (names.length) {
        const castEl = document.createElement('div');
        castEl.className = 'cell-cast-list';
        castEl.innerHTML = names.map(n => {
          const absent = state.absentees.includes(n);
          return `<span class="${absent ? 'absent' : ''}">${escHtml(n)}</span>`;
        }).join(', ');
        inner.appendChild(castEl);
      }
    } else if (scene && scene.cast.length) {
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
// Rekvisitten's cast is picked per-placement (cell.customCast), not fixed on
// the scene definition, so conflict checks resolve cast names per-cell.
function getCellCastNames(cell) {
  if (!cell) return [];
  if (cell.customCast) return cell.customCast;
  const scene = getSceneById(cell.sceneId);
  return scene ? scene.cast.map(c => c.name) : [];
}

function getConflicts(si, ri, cell) {
  const castNames = getCellCastNames(cell);
  if (!castNames.length) return [];
  const conflicts = [];
  state.rooms.forEach((_, otherRi) => {
    if (otherRi === ri) return;
    const other = state.grid[si][otherRi];
    if (!other) return;
    const otherCast = getCellCastNames(other);
    const clash = castNames.filter(n => otherCast.includes(n) && !state.absentees.includes(n));
    if (clash.length) conflicts.push(...clash);
  });
  return [...new Set(conflicts)];
}

function castConflictsAtNames(si, castNames, excludeRi = -1) {
  // Returns true if placing a scene with these cast names at slot si would create a conflict
  if (!castNames.length) return false;
  const names = new Set(castNames.filter(n => !state.absentees.includes(n)));
  for (let ri = 0; ri < state.rooms.length; ri++) {
    if (ri === excludeRi) continue;
    const other = state.grid[si][ri];
    if (!other) continue;
    for (const n of getCellCastNames(other)) {
      if (names.has(n)) return true;
    }
  }
  return false;
}

function castConflictsAt(si, sceneId, excludeRi = -1) {
  const scene = getSceneById(sceneId);
  return scene ? castConflictsAtNames(si, scene.cast.map(c => c.name), excludeRi) : false;
}

// ── Drag & drop ───────────────────────────────────────────
let dragState = null; // { sceneId, fromSlot, fromRoom, customCast }

function startDrag(sceneId, fromSlot, fromRoom, customCast = null) {
  dragState = { sceneId, fromSlot: fromSlot ?? null, fromRoom: fromRoom ?? null, customCast };
  // Mark chip as dragging
  const chip = document.querySelector(`.scene-chip[data-id="${sceneId}"]`);
  if (chip) chip.classList.add('dragging');
}

function highlightDrop(td, si, ri) {
  clearAllDropHighlights();
  if (!dragState) return;
  const castNames = getCellCastNames(dragState);
  const wouldConflict = castConflictsAtNames(si, castNames,
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
  const { sceneId, fromSlot, fromRoom, customCast } = dragState;
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
  state.grid[toSlot][toRoom] = customCast ? { sceneId, customCast } : { sceneId };
  if (existing && fromSlot !== null && fromRoom !== null) {
    state.grid[fromSlot][fromRoom] = existing;
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
  const placed = getPlacedSceneIds();

  const container = document.getElementById('scene-list');
  container.innerHTML = '';

  // Group by act (custom scenes never show in this sidebar)
  const byAct = {};
  for (const scene of state.scenes) {
    if (scene.custom) continue;
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
      chip.draggable = true;
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

      chip.appendChild(prioSpan);
      chip.appendChild(nameSpan);
      chip.appendChild(prioSel);
      container.appendChild(chip);
    }
  }
}

// ── Scene picker modal ────────────────────────────────────
let pickerSlot = null;        // slot index (si) the picker is open for
let pickerRoom = null;        // room index (ri) that was clicked to open the picker, if any
let pickerSelected = new Set(); // set of sceneIds currently selected
let pickerMode = 'list';      // 'list' | 'rekvisitten' (cast-selection sub-view)
let rekvisittenCastSelected = new Set(); // cast names selected in the Rekvisitten sub-view

function openPicker(si, ri = null) {
  pickerSlot = si;
  pickerRoom = ri;
  pickerMode = 'list';
  pickerSelected = new Set();
  rekvisittenCastSelected = new Set();
  document.getElementById('picker-title').textContent = 'Vælg scener';
  _updatePickerFooter();
  document.getElementById('picker-overlay').style.display = 'flex';
  renderPickerList();
}

function closePicker() {
  document.getElementById('picker-overlay').style.display = 'none';
  pickerSlot = null;
  pickerRoom = null;
  pickerMode = 'list';
  pickerSelected = new Set();
  rekvisittenCastSelected = new Set();
}

function confirmPicker() {
  if (pickerMode === 'rekvisitten') { confirmRekvisitten(); return; }
  if (pickerSlot === null || !pickerSelected.size) return;
  const toPlace = [...pickerSelected];

  // A single scene goes straight into the room that was clicked, if any.
  if (toPlace.length === 1 && pickerRoom !== null && !state.grid[pickerSlot][pickerRoom]) {
    state.grid[pickerSlot][pickerRoom] = { sceneId: toPlace[0] };
  } else {
    // Multiple scenes: find empty rooms in this slot, fill left-to-right.
    const emptyRooms = [];
    for (let ri = 0; ri < state.rooms.length; ri++) {
      if (!state.grid[pickerSlot][ri]) emptyRooms.push(ri);
    }
    toPlace.forEach((sceneId, idx) => {
      if (idx >= emptyRooms.length) return;
      state.grid[pickerSlot][emptyRooms[idx]] = { sceneId };
    });
  }

  renderGrid();
  renderSceneSidebar();
  saveState();
  closePicker();
}

// ── Rekvisitten: pick the cast working props for this slot ─
function openRekvisittenCastPicker() {
  pickerMode = 'rekvisitten';
  rekvisittenCastSelected = new Set();
  document.getElementById('picker-title').textContent = 'Vælg hold til Rekvisitten';
  _updatePickerFooter();
  renderRekvisittenCastList();
}

function renderRekvisittenCastList() {
  const container = document.getElementById('picker-list');
  container.innerHTML = '';

  const back = document.createElement('div');
  back.className = 'picker-back';
  back.textContent = '← Tilbage til scener';
  back.onclick = () => {
    pickerMode = 'list';
    document.getElementById('picker-title').textContent = 'Vælg scener';
    _updatePickerFooter();
    renderPickerList();
  };
  container.appendChild(back);

  // Cast already occupied elsewhere in this slot can't also work Rekvisitten
  const occupied = new Set();
  for (let ri = 0; ri < state.rooms.length; ri++) {
    const cell = state.grid[pickerSlot][ri];
    if (cell) getCellCastNames(cell).forEach(n => occupied.add(n));
  }

  const names = getEffectiveCastData().map(c => c.name);

  for (const name of names) {
    const isOccupied = occupied.has(name);
    const isSelected = rekvisittenCastSelected.has(name);

    let cls = 'picker-item';
    if (isSelected) cls += ' picker-selected';
    if (isOccupied) cls += ' picker-at-cap';

    const item = document.createElement('div');
    item.className = cls;

    const nameSpan = document.createElement('span');
    nameSpan.style.flex = '1';
    nameSpan.textContent = name + (isOccupied ? ' (optaget)' : '');
    item.appendChild(nameSpan);

    if (!isOccupied) {
      item.onclick = () => {
        if (rekvisittenCastSelected.has(name)) rekvisittenCastSelected.delete(name);
        else rekvisittenCastSelected.add(name);
        _updatePickerFooter();
        renderRekvisittenCastList();
      };
    }

    container.appendChild(item);
  }
}

function confirmRekvisitten() {
  if (pickerSlot === null || !rekvisittenCastSelected.size) return;

  let targetRoom = (pickerRoom !== null && !state.grid[pickerSlot][pickerRoom]) ? pickerRoom : null;
  if (targetRoom === null) {
    for (let ri = 0; ri < state.rooms.length; ri++) {
      if (!state.grid[pickerSlot][ri]) { targetRoom = ri; break; }
    }
  }
  if (targetRoom === null) { closePicker(); return; }

  state.grid[pickerSlot][targetRoom] = { sceneId: REKVISITTEN_ID, customCast: [...rekvisittenCastSelected] };

  renderGrid();
  renderSceneSidebar();
  saveState();
  closePicker();
}

function _emptyRoomCount(si) {
  return state.rooms.reduce((n, _, ri) => n + (state.grid[si][ri] ? 0 : 1), 0);
}

function _updatePickerFooter() {
  const confirmBtn = document.getElementById('picker-confirm');
  if (pickerMode === 'rekvisitten') {
    const n = rekvisittenCastSelected.size;
    confirmBtn.disabled = n === 0;
    confirmBtn.textContent = n > 0 ? `Placer Rekvisitten (${n})` : 'Placer Rekvisitten';
    return;
  }
  const n = pickerSelected.size;
  confirmBtn.disabled = n === 0;
  confirmBtn.textContent = n > 0 ? `Placer ${n} scene${n !== 1 ? 'r' : ''}` : 'Placer valgte scener';
}

// Returns conflicting cast member names for sceneId at slot si,
// also counting any other scenes already selected in the picker.
function getPickerConflictNames(si, sceneId) {
  const scene = getSceneById(sceneId);
  if (!scene || !scene.cast.length) return [];

  const occupiedCast = new Set();
  // Cast already in grid cells at this slot
  for (let ri = 0; ri < state.rooms.length; ri++) {
    const cell = state.grid[si][ri];
    if (!cell) continue;
    getCellCastNames(cell).forEach(n => occupiedCast.add(n));
  }
  // Cast from other currently-selected scenes in the picker
  for (const selId of pickerSelected) {
    if (selId === sceneId) continue;
    const sel = getSceneById(selId);
    if (sel) sel.cast.forEach(c => occupiedCast.add(c.name));
  }

  return scene.cast
    .map(c => c.name)
    .filter(n => !state.absentees.includes(n) && occupiedCast.has(n));
}

function renderPickerList() {
  const placed = getPlacedSceneIds();
  const container = document.getElementById('picker-list');
  container.innerHTML = '';

  const max = pickerSlot !== null ? _emptyRoomCount(pickerSlot) : 0;

  const byAct = {};
  for (const scene of state.scenes) {
    if (!byAct[scene.actLabel]) byAct[scene.actLabel] = [];
    byAct[scene.actLabel].push(scene);
  }

  for (const [actLabel, scenes] of Object.entries(byAct)) {
    const header = document.createElement('div');
    header.className = 'picker-act-label';
    header.textContent = actLabel;
    container.appendChild(header);

    for (const scene of scenes) {
      // Custom scenes (Scenemøde, Rekvisitten) can be used in multiple slots per day
      const isPlaced = !scene.custom && placed.has(scene.id);
      const isSelected = pickerSelected.has(scene.id);
      const conflictNames = pickerSlot !== null
        ? getPickerConflictNames(pickerSlot, scene.id)
        : [];
      const hasConflict = conflictNames.length > 0;
      // Disable selecting more once we've hit the room cap (unless already selected)
      const atCap = !isSelected && pickerSelected.size >= max;

      let cls = 'picker-item';
      if (isSelected) cls += ' picker-selected';
      if (isPlaced)   cls += ' picker-placed';
      if (atCap)      cls += ' picker-at-cap';

      const item = document.createElement('div');
      item.className = cls;

      const prioSpan = document.createElement('span');
      prioSpan.className = `chip-priority prio-${scene.priority}`;
      prioSpan.textContent = scene.priority;
      item.appendChild(prioSpan);

      // Name + inline conflict tag
      const nameSpan = document.createElement('span');
      nameSpan.style.flex = '1';
      nameSpan.textContent = scene.name + (isPlaced ? ' (placeret)' : '');
      if (hasConflict) {
        const tag = document.createElement('span');
        tag.className = 'picker-conflict-tag';
        tag.textContent = 'rollekonflikt';
        nameSpan.appendChild(tag);
      }
      // If selected AND has conflict, show the names below
      if (isSelected && hasConflict) {
        const conflictEl = document.createElement('div');
        conflictEl.className = 'picker-conflict-names';
        conflictEl.textContent = conflictNames.join(', ');
        nameSpan.appendChild(conflictEl);
      }

      item.appendChild(nameSpan);

      if (scene.id === REKVISITTEN_ID) {
        item.onclick = () => openRekvisittenCastPicker();
      } else if (!atCap) {
        item.onclick = () => {
          if (pickerSelected.has(scene.id)) {
            pickerSelected.delete(scene.id);
          } else {
            pickerSelected.add(scene.id);
          }
          _updatePickerFooter();
          renderPickerList();
        };
      }

      container.appendChild(item);
    }
  }
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
      startTime: document.getElementById('input-start').value,
      endTime: document.getElementById('input-end').value,
      segmentMinutes: document.getElementById('input-segment').value,
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
    if (snap.startTime) document.getElementById('input-start').value   = snap.startTime;
    if (snap.endTime)   document.getElementById('input-end').value     = snap.endTime;
    if (snap.segmentMinutes) document.getElementById('input-segment').value = snap.segmentMinutes;
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
        .map(s => ({ ...s, priority: snap.priorities?.[s.id] ?? 0 }));

      document.getElementById('sched-grid-title').textContent = 'Øveplan';
      document.getElementById('sched-empty-state').style.display = 'none';
      document.getElementById('sched-grid-container').style.display = 'block';
      document.getElementById('scene-sidebar').style.display = 'block';

      renderGrid();
      renderSceneSidebar();
    }
  } catch(e) { /* ignore corrupt state */ }
}
