/* =========================================================
   Matematikrevyen – Schedule Tool
   ========================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────
let state = {
  rooms: [],
  slots: [],        // [{ label, startMinutes }]
  absentees: [],    // [{ name, start, end }, ...] — start/end in minutes-since-midnight
  // grid[slotIdx][roomIdx] = { sceneId, customCast?, customText?, customName?, pairedSceneId? } | null
  grid: [],
  scenes: [],       // schedulable scenes
  allScenes: [],    // all scenes from JSON
  title: 'MatRevy - Øveplan', // editable heading shown above the grid
};

// ── Custom scenes ─────────────────────────────────────────
// Tool-level utility "scenes" that aren't part of the production's script.
// Kept here (not in data/scenes.json) so they survive being replaced each production.
const SCENEMODE_ID    = 'custom-scenemode';
const REKVISITTEN_ID  = 'custom-rekvisitten';
const CUSTOM_SCENES = [
  { id: SCENEMODE_ID,   name: 'Scenemøde',   actLabel: 'Diverse', schedulable: true, priority: 0, cast: [], custom: true },
  { id: REKVISITTEN_ID, name: 'Rekvisitten', actLabel: 'Diverse', schedulable: true, priority: 0, cast: [], custom: true },
];

// ── Dance/actor split scenes ───────────────────────────────
// A scene whose manus-tool `types` combine 'dans' with 'sketch' or 'sang' is
// split at load time into two independently-schedulable/placeable entries:
// the main (acting/singing) part keeps the original id/name; a derived
// "(Dans)" part carries the dancers. Selecting both in the same picker visit
// re-merges them into one placement (see collapseDanceSplitPairs). Purely a
// runtime derivation — data/scenes.json, cast.json, import.js are untouched.
const DANCE_SPLIT_SUFFIX = '::dans'; // scene ids are "act-number" (e.g. "1-3"); ':' never appears, collision-safe.

// A cast entry counts as the dance half if its role is already a classified
// category (Dans/Koreograf, as the manus tool's Apply flow writes) or, for
// raw script codes (as committed data/scenes.json actually stores), contains
// a Y (koreograf) or D (danser) — same signal import.js's classifyRoleCode
// uses per-cast-member, applied here directly to the whole scene's split.
function isDanceCastRole(role) {
  const r = (role || '').trim();
  if (r === 'Dans' || r === 'Koreograf') return true;
  const c = r.toUpperCase();
  return c.includes('Y') || c.includes('D');
}

function isDanceSplitCandidate(scene) {
  return !scene.custom
    && Array.isArray(scene.types)
    && scene.types.includes('dans')
    && (scene.types.includes('sketch') || scene.types.includes('sang'));
}

// Returns [mainPart, dancePart], or null if the scene doesn't qualify.
function splitDanceScene(scene) {
  if (!isDanceSplitCandidate(scene)) return null;
  const mainCast = [];
  const danceCast = [];
  for (const c of scene.cast) {
    // A cast entry with no recognized role (e.g. legacy un-normalized data)
    // defaults to the main/acting half — the same place it'd be if the
    // scene had never been split, so nobody silently vanishes.
    (isDanceCastRole(c.role) ? danceCast : mainCast).push(c);
  }
  const danceId = scene.id + DANCE_SPLIT_SUFFIX;
  const mainPart = { ...scene, cast: mainCast, danceCounterpartId: danceId };
  const dancePart = {
    ...scene, id: danceId, name: scene.name + ' (Dans)',
    cast: danceCast, mainCounterpartId: scene.id,
  };
  return [mainPart, dancePart];
}

// Replaces every qualifying scene with its [main, dance] pair, preserving
// relative order so the two stay adjacent — renderPickerList's pairing
// detection relies on this adjacency.
function applyDanceSplits(scenes) {
  const result = [];
  for (const scene of scenes) {
    const split = splitDanceScene(scene);
    if (split) result.push(...split); else result.push(scene);
  }
  return result;
}

function getDanceCounterpartId(scene) {
  return (scene && (scene.danceCounterpartId || scene.mainCounterpartId)) || null;
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btn-build').addEventListener('click', buildGrid);
  document.getElementById('btn-export').addEventListener('click', () => window.print());
  document.getElementById('btn-clear-schedule').addEventListener('click', clearSchedule);
  document.getElementById('picker-close').addEventListener('click', closePicker);
  document.getElementById('picker-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closePicker();
  });
  document.getElementById('picker-confirm').addEventListener('click', confirmPicker);
  document.getElementById('btn-add-absent').addEventListener('click', openAbsentForm);
  document.getElementById('absent-form-cancel').addEventListener('click', closeAbsentForm);
  document.getElementById('absent-form-confirm').addEventListener('click', addAbsence);

  const titleEl = document.getElementById('sched-grid-title');
  titleEl.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); titleEl.blur(); }
  });
  titleEl.addEventListener('blur', () => {
    const val = titleEl.textContent.trim() || 'MatRevy - Øveplan';
    titleEl.textContent = val;
    state.title = val;
    saveState();
  });

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
  state.allScenes = applyDanceSplits([...CUSTOM_SCENES, ...getEffectiveScenesData()]);
}

// ── Build grid ────────────────────────────────────────────
async function buildGrid() {
  await loadScenes();

  const startTime = document.getElementById('input-start').value || '10:00';
  const endTime   = document.getElementById('input-end').value   || '17:00';
  const segmentMinutes = parseInt(document.getElementById('input-segment').value, 10) || 30;

  const roomLines = document.getElementById('input-rooms').value
    .split('\n').map(r => r.trim()).filter(Boolean);

  if (!roomLines.length) { alert('Tilføj mindst ét lokale.'); return; }
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    alert('Sluttidspunktet skal være efter starttidspunktet.'); return;
  }

  // Preserve existing grid assignments if the time config matches — rooms
  // are handled below by NAME, not index, so adding/removing/reordering
  // rooms doesn't wipe or misattribute existing placements.
  const newSlots = buildSlots(startTime, endTime, segmentMinutes);
  const slotsMatch = JSON.stringify(newSlots) === JSON.stringify(state.slots);
  const oldRooms = state.rooms;
  const oldGrid  = state.grid;

  state.rooms    = roomLines;
  state.slots    = newSlots;

  // Build scenes list, keep priorities if we have them
  const prevPriorities = {};
  for (const sc of state.scenes) prevPriorities[sc.id] = sc.priority;

  state.scenes = state.allScenes
    .filter(s => s.schedulable)
    .map(s => ({ ...s, priority: prevPriorities[s.id] ?? s.priority ?? 0 }));

  // Reset grid only if the time configuration changed — slot indices no
  // longer correspond to the same time windows, so nothing can be carried
  // over safely in that case.
  if (!slotsMatch) {
    state.grid = state.slots.map(() => state.rooms.map(() => null));
  } else {
    // Preserve each room's placements by matching its NAME against the old
    // room list (not its array position) — a room appended, removed, or
    // reordered keeps its own placements attached to it; a renamed room is
    // treated as a new room (its old placements can't be told apart from a
    // genuine remove+add from a flat text-list diff).
    state.grid = state.slots.map((_, si) =>
      state.rooms.map(room => {
        const oldRi = oldRooms.indexOf(room);
        return (oldRi !== -1 && oldGrid[si] && oldGrid[si][oldRi] !== undefined)
          ? oldGrid[si][oldRi] : null;
      })
    );
  }

  const titleEl = document.getElementById('sched-grid-title');
  if (!titleEl.textContent.trim()) titleEl.textContent = state.title || 'MatRevy - Øveplan';
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
    inner.ondragstart = () => startDrag(assignment.sceneId, si, ri, {
      customCast: assignment.customCast || null,
      pairedSceneId: assignment.pairedSceneId || null,
      customText: assignment.customText || null,
      customName: assignment.customName || null,
    });
    inner.ondragover  = e => { e.preventDefault(); highlightDrop(td, si, ri); };
    inner.ondragleave = () => clearDropHighlight(td);
    inner.ondrop      = e => { e.preventDefault(); handleDrop(si, ri); };
    inner.title = scene && scene.id === SCENEMODE_ID
      ? 'Klik for at redigere tekst, træk for at flytte'
      : 'Klik for at redigere rollebesætning, træk for at flytte';
    if (scene && scene.id === SCENEMODE_ID) {
      inner.onclick = () => openScenemodeTextEditor(si, ri);
    } else if (scene) {
      inner.onclick = () => openCellEditor(si, ri);
    }

    // Scene name
    const nameEl = document.createElement('div');
    nameEl.className = 'cell-scene-name';
    nameEl.textContent = scene
      ? (scene.id === SCENEMODE_ID && assignment.customName ? assignment.customName : scene.name)
      : assignment.sceneId;
    inner.appendChild(nameEl);

    // Cast list
    if (scene && scene.id === SCENEMODE_ID) {
      const castEl = document.createElement('div');
      castEl.className = 'cell-cast-list';
      castEl.textContent = assignment.customText || 'Alle';
      inner.appendChild(castEl);
    } else if (scene) {
      const names = getDisplayCastNames(assignment);
      if (names.length) {
        const castEl = document.createElement('div');
        castEl.className = 'cell-cast-list';
        castEl.innerHTML = renderCastListHtml(names, si);
        inner.appendChild(castEl);
      }
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

// Cast names actually shown/pre-selected by default for a placement — never
// Statist, and for an unmerged song/dance-half, narrowed further to the
// roles relevant to that half. Purely a display default: once cell.customCast
// exists (a merged placement, or anything the coordinator has explicitly
// edited via the cell editor) it's returned verbatim, never re-filtered, so
// an explicit choice always sticks.
// Statists remain in the real scene cast for conflict detection either way —
// getCellCastNames() (used by getConflicts/getPickerConflictNames) is
// unaffected by this filter.
function getDisplayCastNames(cell) {
  if (!cell) return [];
  if (cell.customCast) return cell.customCast;
  const scene = getSceneById(cell.sceneId);
  if (!scene || scene.custom) return getCellCastNames(cell);

  const isSong = !!(scene.types && scene.types.includes('sang'));
  const isDans = !!(scene.types && scene.types.includes('dans'));
  const isDansHalf = !!scene.mainCounterpartId;

  return scene.cast
    .filter(c => {
      const category = classifyOrKeep(c.role, isSong, isDans);
      if (category === 'Statist' || category === 'Ninja') return false;
      if (isDansHalf) return category === 'Dans' || category === 'Koreograf' || category === 'Instruktør';
      if (isSong) return category === 'Sang/Rap' || category === 'Kor' || category === 'Instruktør';
      return true; // sketch (or a sketch+dans combo's sketch half, placed alone)
    })
    .map(c => c.name);
}

// Builds cast-list HTML as one <span> per name with the separator embedded
// inside the span (never a bare text node between spans), so a
// display:block rule on the span (e.g. in print) can't strand a lone comma
// on its own line between names.
function renderCastListHtml(names, si) {
  return names.map((n, i) => {
    const absent = isPersonAbsentAtSlot(n, si);
    const sep = i < names.length - 1 ? ', ' : '';
    // The separator sits outside the "absent" span so the strikethrough
    // only crosses the name itself, not the trailing comma.
    const nameHtml = absent ? `<span class="absent">${escHtml(n)}</span>` : escHtml(n);
    return `<span>${nameHtml}${sep}</span>`;
  }).join('');
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
    const clash = castNames.filter(n => otherCast.includes(n) && !isPersonAbsentAtSlot(n, si));
    if (clash.length) conflicts.push(...clash);
  });
  return [...new Set(conflicts)];
}

function castConflictsAtNames(si, castNames, excludeRi = -1) {
  // Returns true if placing a scene with these cast names at slot si would create a conflict
  if (!castNames.length) return false;
  const names = new Set(castNames.filter(n => !isPersonAbsentAtSlot(n, si)));
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
let dragState = null; // { sceneId, fromSlot, fromRoom, customCast, pairedSceneId }

function startDrag(sceneId, fromSlot, fromRoom, extra = {}) {
  dragState = { sceneId, fromSlot: fromSlot ?? null, fromRoom: fromRoom ?? null, ...extra };
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
  const { sceneId, fromSlot, fromRoom, customCast, pairedSceneId, customText, customName } = dragState;
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
  const placed = { sceneId };
  if (customCast) placed.customCast = customCast;
  if (pairedSceneId) placed.pairedSceneId = pairedSceneId;
  if (customText) placed.customText = customText;
  if (customName) placed.customName = customName;
  state.grid[toSlot][toRoom] = placed;
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

function clearSchedule() {
  if (!state.grid.length) return;
  if (!confirm('Ryd alle placerede scener fra skemaet? Dette kan ikke fortrydes.')) return;
  state.grid = state.slots.map(() => state.rooms.map(() => null));
  renderGrid();
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

// ── Absentees ─────────────────────────────────────────────
function getSlotRange(si) {
  const slot = state.slots[si];
  if (!slot) return null;
  const segmentMinutes = parseInt(document.getElementById('input-segment').value, 10) || 30;
  const nextStart = state.slots[si + 1] ? state.slots[si + 1].startMinutes : undefined;
  const end = nextStart !== undefined ? nextStart : slot.startMinutes + segmentMinutes;
  return { start: slot.startMinutes, end };
}

function isPersonAbsentAtSlot(name, si) {
  const range = getSlotRange(si);
  if (!range) return false;
  return state.absentees.some(a =>
    a.name === name && a.start < range.end && a.end > range.start);
}

function renderAbsentList() {
  const container = document.getElementById('absent-list');
  container.innerHTML = '';
  if (!state.absentees.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = 'Ingen registreret fravær.';
    container.appendChild(hint);
    return;
  }
  state.absentees.forEach((a, i) => {
    const row = document.createElement('div');
    row.className = 'absent-row';

    const nameEl = document.createElement('span');
    nameEl.className = 'absent-row-name';
    nameEl.textContent = a.name;

    const timeEl = document.createElement('span');
    timeEl.className = 'absent-row-time';
    timeEl.textContent = minutesToTime(a.start) + '–' + minutesToTime(a.end);

    const rmBtn = document.createElement('button');
    rmBtn.className = 'absent-remove-btn';
    rmBtn.textContent = '✕';
    rmBtn.title = 'Fjern fravær';
    rmBtn.onclick = () => removeAbsence(i);

    row.append(nameEl, timeEl, rmBtn);
    container.appendChild(row);
  });
}

function openAbsentForm() {
  const nameSel = document.getElementById('absent-form-name');
  nameSel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Vælg revyster…';
  placeholder.disabled = true;
  placeholder.selected = true;
  nameSel.appendChild(placeholder);
  getEffectiveCastData().map(c => c.name).forEach(name => {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    nameSel.appendChild(opt);
  });
  document.getElementById('absent-form-start').value =
    document.getElementById('input-start').value || '10:00';
  document.getElementById('absent-form-end').value =
    document.getElementById('input-end').value || '17:00';
  document.getElementById('absent-form').style.display = 'block';
  document.getElementById('btn-add-absent').style.display = 'none';
}

function closeAbsentForm() {
  document.getElementById('absent-form').style.display = 'none';
  document.getElementById('btn-add-absent').style.display = 'block';
}

function addAbsence() {
  const name     = document.getElementById('absent-form-name').value;
  const startVal = document.getElementById('absent-form-start').value;
  const endVal   = document.getElementById('absent-form-end').value;
  if (!name) { alert('Vælg en revyster.'); return; }
  if (!startVal || !endVal) { alert('Udfyld start- og sluttidspunkt.'); return; }
  const start = timeToMinutes(startVal);
  const end   = timeToMinutes(endVal);
  if (start >= end) { alert('Sluttidspunktet skal være efter starttidspunktet.'); return; }

  state.absentees.push({ name, start, end });
  closeAbsentForm();
  renderAbsentList();
  renderGrid();
  saveState();
}

function removeAbsence(i) {
  state.absentees.splice(i, 1);
  renderAbsentList();
  renderGrid();
  saveState();
}

// ── Scene picker modal ────────────────────────────────────
let pickerSlot = null;        // slot index (si) the picker is open for
let pickerRoom = null;        // room index (ri) that was clicked to open the picker, if any
let pickerSelected = new Set(); // set of sceneIds currently selected
let pickerMode = 'list';      // 'list' | 'rekvisitten' | 'edit-cell' (cast-selection sub-views)
let rekvisittenCastSelected = new Set(); // cast names selected in the Rekvisitten sub-view
let cellEditCastSelected = new Set(); // cast names selected in the per-cell editor sub-view

function openPicker(si, ri = null) {
  pickerSlot = si;
  pickerRoom = ri;
  pickerMode = 'list';
  pickerSelected = new Set();
  rekvisittenCastSelected = new Set();
  cellEditCastSelected = new Set();
  document.getElementById('picker-title').textContent = 'Vælg scener';
  _updatePickerFooter();
  document.getElementById('picker-overlay').style.display = 'flex';
  renderPickerList();
  document.getElementById('picker-list').scrollTop = 0;
}

function closePicker() {
  document.getElementById('picker-overlay').style.display = 'none';
  pickerSlot = null;
  pickerRoom = null;
  pickerMode = 'list';
  pickerSelected = new Set();
  rekvisittenCastSelected = new Set();
  cellEditCastSelected = new Set();
}

// Collapses any fully-selected dance-split pair into a single merged
// placement (main part's id + union of both casts); everything else passes
// through as a plain { sceneId } placement, unchanged from today.
function collapseDanceSplitPairs(sceneIds) {
  const idSet = new Set(sceneIds);
  const consumed = new Set();
  const placements = [];
  for (const id of sceneIds) {
    if (consumed.has(id)) continue;
    const scene = getSceneById(id);
    const counterpartId = getDanceCounterpartId(scene);
    if (counterpartId && idSet.has(counterpartId)) {
      const mainId  = scene.danceCounterpartId ? id : counterpartId;
      const danceId = scene.danceCounterpartId ? counterpartId : id;
      const mainScene  = getSceneById(mainId);
      const danceScene = getSceneById(danceId);
      // A merged main+dance placement shows everyone but Statist/Ninja by
      // default, same as a plain sketch — filtered here so a fresh merge
      // already satisfies that without a manual cell-editor edit.
      const isSong = !!(mainScene.types && mainScene.types.includes('sang'));
      const mergedCast = [...mainScene.cast, ...danceScene.cast]
        .filter(c => {
          const category = classifyOrKeep(c.role, isSong, true);
          return category !== 'Statist' && category !== 'Ninja';
        })
        .map(c => c.name);
      placements.push({
        sceneId: mainId,
        customCast: mergedCast,
        pairedSceneId: danceId,
      });
      consumed.add(mainId); consumed.add(danceId);
    } else {
      placements.push({ sceneId: id });
      consumed.add(id);
    }
  }
  return placements;
}

function confirmPicker() {
  if (pickerMode === 'rekvisitten') { confirmRekvisitten(); return; }
  if (pickerMode === 'edit-cell')  { confirmCellEditor(); return; }
  if (pickerMode === 'edit-scenemode') { confirmScenemodeTextEditor(); return; }
  if (pickerSlot === null || !pickerSelected.size) return;
  const placements = collapseDanceSplitPairs([...pickerSelected]);

  // A single placement goes straight into the room that was clicked, if any.
  if (placements.length === 1 && pickerRoom !== null && !state.grid[pickerSlot][pickerRoom]) {
    state.grid[pickerSlot][pickerRoom] = placements[0];
  } else {
    // Multiple placements: find empty rooms in this slot, fill left-to-right.
    const emptyRooms = [];
    for (let ri = 0; ri < state.rooms.length; ri++) {
      if (!state.grid[pickerSlot][ri]) emptyRooms.push(ri);
    }
    placements.forEach((placement, idx) => {
      if (idx >= emptyRooms.length) return;
      state.grid[pickerSlot][emptyRooms[idx]] = placement;
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
  // Also fold in cast from scenes selected-but-not-yet-confirmed in this same
  // picker visit — mirrors getPickerConflictNames's pattern for the reverse
  // case (a candidate scene checked against other selected-but-unconfirmed
  // scenes).
  for (const selId of pickerSelected) {
    const sel = getSceneById(selId);
    if (sel) sel.cast.forEach(c => occupied.add(c.name));
  }

  const names = getEffectiveCastData().map(c => c.name);

  for (const name of names) {
    const isOccupied = occupied.has(name);
    const isAbsent = isPersonAbsentAtSlot(name, pickerSlot);
    const isUnavailable = isOccupied || isAbsent;
    const isSelected = rekvisittenCastSelected.has(name);

    let cls = 'picker-item';
    if (isSelected) cls += ' picker-selected';
    if (isUnavailable) cls += ' picker-at-cap';

    const item = document.createElement('div');
    item.className = cls;

    const nameSpan = document.createElement('span');
    nameSpan.style.flex = '1';
    nameSpan.textContent = name + (isOccupied ? ' (optaget)' : isAbsent ? ' (fraværende)' : '');
    item.appendChild(nameSpan);

    if (!isUnavailable) {
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

// ── Per-cell cast editor: cross out present cast or add extras ─
let cellEditorRolesOpen = true;   // "Roller" (scene's own cast) — open by default
let cellEditorOthersOpen = false; // "Andre revyster" (rest of the roster) — closed by default

function openCellEditor(si, ri) {
  pickerSlot = si;
  pickerRoom = ri;
  pickerMode = 'edit-cell';
  const cell = state.grid[si][ri];
  cellEditCastSelected = new Set(getDisplayCastNames(cell));
  const scene = cell ? getSceneById(cell.sceneId) : null;
  cellEditorRolesOpen = true;
  // Rekvisitten has no fixed cast — "Roller" would be empty, so open "Andre
  // revyster" by default there instead of making the coordinator expand it.
  cellEditorOthersOpen = !!(scene && scene.id === REKVISITTEN_ID);
  document.getElementById('picker-title').textContent =
    'Rediger' + (scene ? ' – ' + scene.name : '');
  _updatePickerFooter();
  document.getElementById('picker-overlay').style.display = 'flex';
  renderCellEditorList();
}

// Cast belonging to a scene, each with its classified role category — the
// "Roller" section. For a scene split into a main and a "(Dans)" part, this
// always includes BOTH halves' cast, regardless of whether this particular
// cell holds just one half or the merged placement — they're still one
// larger scene, so the full cast belongs in "Roller" either way.
function getSceneCastWithRoles(scene) {
  const isSong = !!(scene.types && scene.types.includes('sang'));
  const isDans = !!(scene.types && scene.types.includes('dans'));
  const all = [...scene.cast];
  const counterpartId = getDanceCounterpartId(scene);
  if (counterpartId) {
    const counterpart = getSceneById(counterpartId);
    if (counterpart) all.push(...counterpart.cast);
  }
  const seen = new Set();
  const result = [];
  for (const c of all) {
    if (seen.has(c.name)) continue;
    seen.add(c.name);
    result.push({ name: c.name, category: classifyOrKeep(c.role, isSong, isDans) });
  }
  return result;
}

function renderCellEditorList() {
  const container = document.getElementById('picker-list');
  container.innerHTML = '';

  const cell = state.grid[pickerSlot][pickerRoom];
  const scene = cell ? getSceneById(cell.sceneId) : null;

  // Cast occupied in OTHER cells of this slot (not the cell being edited).
  const occupied = new Set();
  for (let ri2 = 0; ri2 < state.rooms.length; ri2++) {
    if (ri2 === pickerRoom) continue;
    const other = state.grid[pickerSlot][ri2];
    if (other) getCellCastNames(other).forEach(n => occupied.add(n));
  }

  const makeRow = (name, roleLabel) => {
    const isOccupied = occupied.has(name);
    const isAbsent = isPersonAbsentAtSlot(name, pickerSlot);
    const isSelected = cellEditCastSelected.has(name);
    // Someone already in THIS cell must remain removable even if now
    // flagged occupied/absent elsewhere — otherwise the coordinator could
    // never uncheck the very person this editor exists to let them cross out.
    const isUnavailable = (isOccupied || isAbsent) && !isSelected;

    let cls = 'picker-item';
    if (isSelected) cls += ' picker-selected';
    if (isUnavailable) cls += ' picker-at-cap';

    const item = document.createElement('div');
    item.className = cls;

    const nameSpan = document.createElement('span');
    nameSpan.style.flex = '1';
    const suffix = isOccupied ? ' (optaget)' : isAbsent ? ' (fraværende)' : '';
    nameSpan.textContent = name + (roleLabel ? ` (${roleLabel})` : '') + suffix;
    item.appendChild(nameSpan);

    if (!isUnavailable) {
      item.onclick = () => {
        if (cellEditCastSelected.has(name)) cellEditCastSelected.delete(name);
        else cellEditCastSelected.add(name);
        _updatePickerFooter();
        renderCellEditorList();
      };
    }
    return item;
  };

  const sceneCast = scene ? getSceneCastWithRoles(scene) : [];
  const sceneNames = new Set(sceneCast.map(c => c.name));
  const otherNames = getEffectiveCastData().map(c => c.name).filter(n => !sceneNames.has(n));

  const renderSection = (title, open, setOpen, count, renderBody) => {
    const section = document.createElement('div');
    section.className = 'import-act-section';

    const header = document.createElement('div');
    header.className = 'import-act-header';
    header.onclick = () => { setOpen(!open); renderCellEditorList(); };

    const chevron = document.createElement('span');
    chevron.className = 'import-chevron';
    chevron.textContent = open ? '▾' : '▸';
    header.appendChild(chevron);

    const label = document.createElement('span');
    label.className = 'picker-act-label';
    label.textContent = title;
    header.appendChild(label);

    const countEl = document.createElement('span');
    countEl.className = 'import-act-count';
    countEl.textContent = count;
    header.appendChild(countEl);

    section.appendChild(header);
    if (open) renderBody(section);
    container.appendChild(section);
  };

  renderSection('Roller', cellEditorRolesOpen, v => { cellEditorRolesOpen = v; }, sceneCast.length,
    section => { for (const c of sceneCast) section.appendChild(makeRow(c.name, c.category)); });

  renderSection('Andre revyster', cellEditorOthersOpen, v => { cellEditorOthersOpen = v; }, otherNames.length,
    section => { for (const name of otherNames) section.appendChild(makeRow(name, null)); });
}

function confirmCellEditor() {
  if (pickerSlot === null || pickerRoom === null || !cellEditCastSelected.size) return;
  const cell = state.grid[pickerSlot][pickerRoom];
  if (!cell) { closePicker(); return; }
  cell.customCast = [...cellEditCastSelected];
  renderGrid();
  renderSceneSidebar();
  saveState();
  closePicker();
}

// ── Scenemøde custom-text editor ──────────────────────────
function openScenemodeTextEditor(si, ri) {
  pickerSlot = si;
  pickerRoom = ri;
  pickerMode = 'edit-scenemode';
  const cell = state.grid[si][ri];
  document.getElementById('picker-title').textContent = 'Rediger – ' + ((cell && cell.customName) || 'Scenemøde');
  _updatePickerFooter();
  document.getElementById('picker-overlay').style.display = 'flex';
  renderScenemodeTextEditor();
}

function renderScenemodeTextEditor() {
  const container = document.getElementById('picker-list');
  container.innerHTML = '';
  const cell = state.grid[pickerSlot][pickerRoom];

  const nameWrap = document.createElement('label');
  nameWrap.className = 'field-label picker-text-editor';
  nameWrap.appendChild(document.createTextNode('Navn'));

  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.id = 'scenemode-name-input';
  nameInput.placeholder = 'Scenemøde';
  nameInput.value = (cell && cell.customName) || '';
  nameWrap.appendChild(nameInput);

  container.appendChild(nameWrap);

  const wrap = document.createElement('label');
  wrap.className = 'field-label picker-text-editor';
  wrap.appendChild(document.createTextNode('Personer'));

  const input = document.createElement('input');
  input.type = 'text';
  input.id = 'scenemode-text-input';
  input.placeholder = 'Alle';
  input.value = (cell && cell.customText) || '';
  wrap.appendChild(input);

  container.appendChild(wrap);
  nameInput.focus();
}

function confirmScenemodeTextEditor() {
  if (pickerSlot === null || pickerRoom === null) { closePicker(); return; }
  const cell = state.grid[pickerSlot][pickerRoom];
  if (!cell) { closePicker(); return; }
  const nameInput = document.getElementById('scenemode-name-input');
  const nameVal = nameInput ? nameInput.value.trim() : '';
  if (nameVal) cell.customName = nameVal; else delete cell.customName;
  const input = document.getElementById('scenemode-text-input');
  const val = input ? input.value.trim() : '';
  if (val) cell.customText = val; else delete cell.customText;
  renderGrid();
  renderSceneSidebar();
  saveState();
  closePicker();
}

function _emptyRoomCount(si) {
  return state.rooms.reduce((n, _, ri) => n + (state.grid[si][ri] ? 0 : 1), 0);
}

function _updatePickerFooter() {
  const modal = document.querySelector('#picker-overlay .picker-modal');
  if (modal) modal.classList.toggle('picker-modal-fixed-height', pickerMode !== 'edit-scenemode');

  const confirmBtn = document.getElementById('picker-confirm');
  confirmBtn.textContent = (pickerMode === 'edit-cell' || pickerMode === 'edit-scenemode') ? 'Opdater' : 'Placer';
  if (pickerMode === 'rekvisitten') {
    confirmBtn.disabled = rekvisittenCastSelected.size === 0;
    return;
  }
  if (pickerMode === 'edit-cell') {
    confirmBtn.disabled = cellEditCastSelected.size === 0;
    return;
  }
  if (pickerMode === 'edit-scenemode') {
    confirmBtn.disabled = false; // blank input is valid — falls back to "Alle"
    return;
  }
  confirmBtn.disabled = pickerSelected.size === 0;
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
    .filter(n => !isPersonAbsentAtSlot(n, si) && occupiedCast.has(n));
}

// Cast members of `sceneId` who are absent during slot `si`'s time window.
// Purely advisory — never affects selectability, unlike getPickerConflictNames.
function getPickerAbsentNames(si, sceneId) {
  const scene = getSceneById(sceneId);
  if (!scene || !scene.cast.length) return [];
  return scene.cast
    .map(c => c.name)
    .filter(n => isPersonAbsentAtSlot(n, si));
}

// A fully-selected dance-split pair collapses into one room at confirm time
// (see collapseDanceSplitPairs), so it must count as 1 toward the room cap,
// not 2.
function _pickerSelectedRoomCount() {
  let count = 0;
  const seen = new Set();
  for (const id of pickerSelected) {
    if (seen.has(id)) continue;
    seen.add(id);
    const counterpartId = getDanceCounterpartId(getSceneById(id));
    if (counterpartId && pickerSelected.has(counterpartId)) seen.add(counterpartId);
    count++;
  }
  return count;
}

function buildPickerSceneItem(scene, placed, half) {
  // Custom scenes (Scenemøde, Rekvisitten) can be used in multiple slots per day
  const isPlaced = !scene.custom && placed.has(scene.id);
  const isSelected = pickerSelected.has(scene.id);
  const conflictNames = pickerSlot !== null
    ? getPickerConflictNames(pickerSlot, scene.id)
    : [];
  const hasConflict = conflictNames.length > 0;
  const absentNames = pickerSlot !== null
    ? getPickerAbsentNames(pickerSlot, scene.id)
    : [];
  const hasAbsent = absentNames.length > 0;

  const counterpartId = getDanceCounterpartId(scene);
  const counterpartSelected = !!counterpartId && pickerSelected.has(counterpartId);
  // Selecting this half either consumes a new room, or (if its counterpart
  // is already selected) merges into that placement and consumes none — so
  // it must never be blocked by the room cap in that case.
  const wouldMerge = !isSelected && counterpartSelected;
  const max = pickerSlot !== null ? _emptyRoomCount(pickerSlot) : 0;
  // Disable selecting more once we've hit the room cap (unless already selected)
  const atCap = !isSelected && !wouldMerge && _pickerSelectedRoomCount() >= max;

  let cls = 'picker-item';
  if (half) cls += ' picker-item-half';
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
    tag.textContent = 'O';
    nameSpan.appendChild(tag);
  }
  if (hasAbsent) {
    const absentTag = document.createElement('span');
    absentTag.className = 'picker-absent-tag';
    absentTag.textContent = 'F';
    nameSpan.appendChild(absentTag);
  }
  // If selected AND has conflict, show the names below
  if (isSelected && hasConflict) {
    const conflictEl = document.createElement('div');
    conflictEl.className = 'picker-conflict-names';
    conflictEl.textContent = conflictNames.join(', ');
    nameSpan.appendChild(conflictEl);
  }
  if (isSelected && hasAbsent) {
    const absentEl = document.createElement('div');
    absentEl.className = 'picker-absent-names';
    absentEl.textContent = absentNames.join(', ');
    nameSpan.appendChild(absentEl);
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

  return item;
}

function buildLegendItem(tagClass, tagText, label) {
  const item = document.createElement('span');
  item.className = 'picker-legend-item';
  const tag = document.createElement('span');
  tag.className = tagClass;
  tag.textContent = tagText;
  item.appendChild(tag);
  item.appendChild(document.createTextNode(label));
  return item;
}

function renderPickerList() {
  const placed = getPlacedSceneIds();
  const container = document.getElementById('picker-list');
  container.innerHTML = '';

  const byAct = {};
  for (const scene of state.scenes) {
    if (!byAct[scene.actLabel]) byAct[scene.actLabel] = [];
    byAct[scene.actLabel].push(scene);
  }

  const legend = document.createElement('div');
  legend.className = 'picker-legend';
  legend.appendChild(buildLegendItem('picker-conflict-tag', 'O', ': Overlap'));
  legend.appendChild(buildLegendItem('picker-absent-tag', 'F', ': Fravær'));
  container.appendChild(legend);

  for (const [actLabel, scenes] of Object.entries(byAct)) {
    const header = document.createElement('div');
    header.className = 'picker-act-label';
    header.textContent = actLabel;
    container.appendChild(header);

    // Dance-split pairs (main part immediately followed by its "(Dans)"
    // counterpart, per applyDanceSplits) render as one row split into two
    // half-width buttons instead of two full-width rows.
    for (let i = 0; i < scenes.length; i++) {
      const scene = scenes[i];
      const next = scenes[i + 1];
      if (scene.danceCounterpartId && next && next.id === scene.danceCounterpartId) {
        const row = document.createElement('div');
        row.className = 'picker-pair-row';
        row.appendChild(buildPickerSceneItem(scene, placed, true));
        row.appendChild(buildPickerSceneItem(next, placed, true));
        container.appendChild(row);
        i++; // consumed the dance-part entry too
        continue;
      }
      container.appendChild(buildPickerSceneItem(scene, placed, false));
    }
  }
}

// ── Helpers ───────────────────────────────────────────────
function getSceneById(id) {
  return state.allScenes.find(s => s.id === id) || null;
}

function getPlacedSceneIds() {
  const ids = new Set();
  for (const row of state.grid) {
    for (const cell of row) {
      if (!cell) continue;
      ids.add(cell.sceneId);
      if (cell.pairedSceneId) ids.add(cell.pairedSceneId);
    }
  }
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
      title: state.title,
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

    // Absentees and the title are independent of whether a grid has ever
    // been built.
    state.absentees = snap.absentees || [];
    renderAbsentList();
    state.title = snap.title || 'MatRevy - Øveplan';

    // Restore grid state
    if (snap.rooms && snap.rooms.length && snap.slots && snap.grid) {
      await loadScenes();
      state.rooms    = snap.rooms;
      state.slots    = snap.slots;
      state.grid     = snap.grid;
      state.scenes   = state.allScenes
        .filter(s => s.schedulable)
        .map(s => ({ ...s, priority: snap.priorities?.[s.id] ?? 0 }));

      document.getElementById('sched-grid-title').textContent = state.title;
      document.getElementById('sched-empty-state').style.display = 'none';
      document.getElementById('sched-grid-container').style.display = 'block';
      document.getElementById('scene-sidebar').style.display = 'block';

      renderGrid();
      renderSceneSidebar();
    }
  } catch(e) { /* ignore corrupt state */ }
}
