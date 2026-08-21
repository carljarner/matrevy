/* =========================================================
   Matematikrevyen – Schedule Tool
   ========================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────
let state = {
  rooms: [],
  slots: [],        // [{ label, startMinutes, endMinutes }]
  slotsConfig: null, // { startTime, endTime, segmentMinutes, gapMinutes } from the last buildGrid() — lets a rebuild tell "config unchanged" (preserve state.slots as-is, including manual edits) from "config changed" (regenerate)
  absentees: [],    // [{ name, start, end }, ...] — start/end in minutes-since-midnight
  // grid[slotIdx][roomIdx] = { sceneId, customCast?, crossedOutCast?, customText?, customName?, pairedSceneId? } | null
  grid: [],
  scenes: [],       // schedulable scenes
  allScenes: [],    // all scenes from JSON
  allCast: [],      // full cast roster (CAST_DATA, or a fresher manus override — see loadScenes())
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

// ── Cast role classification (moved from the now-removed import.js — the
// "Rediger Manus" tool this used to serve exclusively) ─────
// Cast role codes get normalized into one of these categories.
const ROLE_CATEGORIES = ['Instruktør', 'Koreograf', 'Skuespil', 'Sang/Rap', 'Dans', 'Kor', 'Statist', 'Ninja'];

// Simple rules that work ~99% of the time, given by the coordinator. Only ever run on a
// raw script code (not an already-classified category — see classifyOrKeep()), and only
// once, at parse time; scenes don't get retroactively reclassified if their type changes later.
// The pattern codes (I/Y/D/K/St/N) are code-shape-only and apply regardless of scene type;
// only the final ambiguous fallback needs to know sketch vs. song (isSong).
function classifyRoleCode(code, isSong, isDans) {
  const raw = code.trim();
  const c = raw.toUpperCase();
  // Case-sensitive: only a literal uppercase "I" counts, so codes like "Ni"
  // (Ninja) aren't caught here just because they contain a lowercase "i".
  if (raw.includes('I')) return 'Instruktør';
  if (c.includes('Y')) return 'Koreograf';
  if (c.startsWith('ST')) return 'Statist';
  if (isSong) {
    if (c.includes('D')) return 'Dans';
    if (c.startsWith('K')) return 'Kor';
    if (c.includes('N')) return 'Ninja';
    return 'Sang/Rap';
  }
  // A sketch combined with a dance number (types includes both 'sketch' and
  // 'dans', e.g. "Første Arbejdsdag") still uses D-coded cast for dancers.
  if (isDans && c.includes('D')) return 'Dans';
  if (c.includes('N')) return 'Ninja';
  return 'Skuespil';
}

function classifyOrKeep(code, isSong, isDans) {
  return ROLE_CATEGORIES.includes(code) ? code : classifyRoleCode(code, isSong, isDans);
}

// ── Dance/actor split scenes ───────────────────────────────
// A scene with a Koreograf-classified cast member (see isDanceSplitCandidate
// below) is split at load time into two independently-schedulable/placeable
// entries: the main (acting/singing) part keeps the original id/name; a
// derived "(Dans)" part carries the dancers/choreographer. Selecting both in
// the same picker visit re-merges them into one placement (see
// collapseDanceSplitPairs). Purely a runtime derivation — data/scenes.json
// and cast.json are untouched.
const DANCE_SPLIT_SUFFIX = '::dans'; // scene ids are "act-number" (e.g. "1-3"); ':' never appears, collision-safe.

// A cast entry counts as the dance half if it carries a Dans or Koreograf
// tag — checked against the full `tags` array, not just `role`, since `role`
// only ever stores tags[0] (manus.js's manusRowScene()): a cast member
// tagged both Instruktør and Koreograf would be missed here whenever
// Instruktør happened to be tags[0]. Falls back to classifying `role` itself
// for raw script codes with no tags yet (legacy/un-Rollefordeling-touched
// data) — contains a Y (koreograf) or D (danser).
function isDanceCastRole(c) {
  if (Array.isArray(c.tags) && c.tags.length) {
    return c.tags.includes('Dans') || c.tags.includes('Koreograf');
  }
  const r = (c.role || '').trim();
  if (r === 'Dans' || r === 'Koreograf') return true;
  const code = r.toUpperCase();
  return code.includes('Y') || code.includes('D');
}

// A scene is a dance-split candidate if any cast member is dance-classified
// (Dans or Koreograf, per isDanceCastRole above — so a scene with only
// credited dancers and no separate choreographer still qualifies, not just
// one with an explicit Koreograf) rather than checking scene.types for
// 'dans', since nothing in the Manus page's own save path ever adds 'dans'
// to a scene's types.
function isDanceSplitCandidate(scene) {
  return !scene.custom && (scene.cast || []).some(isDanceCastRole);
}

// Returns [mainPart, dancePart], or null if the scene doesn't qualify. The
// dance half's own priority/repeat come from the scene's dansPriority/
// dansRepeat fields (set independently by Manus's Stjerneark tab), never
// copied from the main half's priority/repeat — a plain `{...scene}` spread
// would otherwise leave both halves showing the same value.
function splitDanceScene(scene) {
  if (!isDanceSplitCandidate(scene)) return null;
  const mainCast = [];
  const danceCast = [];
  for (const c of scene.cast) {
    // A cast entry with no recognized role (e.g. legacy un-normalized data)
    // defaults to the main/acting half — the same place it'd be if the
    // scene had never been split, so nobody silently vanishes.
    (isDanceCastRole(c) ? danceCast : mainCast).push(c);
  }
  const danceId = scene.id + DANCE_SPLIT_SUFFIX;
  const mainPart = { ...scene, cast: mainCast, danceCounterpartId: danceId };
  const dancePart = {
    ...scene, id: danceId, name: scene.name + ' (Dans)',
    cast: danceCast, mainCounterpartId: scene.id,
    priority: scene.dansPriority != null ? scene.dansPriority : 0,
    repeat: !!scene.dansRepeat,
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

// ── Custom time field ────────────────────────────────────
// Native <input type="time">'s hour/minute segments share one highlight
// color with no way to tell, via CSS, which one is currently being typed
// into — a real, empirically-confirmed WebKit limit (see the removed CSS
// comment this replaces) — and its clock-icon dropdown is unstylable
// OS/browser chrome. This mirrors site-utils.js's siteCreateTimeField/
// siteOpenTimePicker (duplicated rather than loaded — schedule.html
// deliberately doesn't load site-utils.js, see CLAUDE.md) but reuses that
// file's .site-field-combo/.site-field-pop/.site-tp-*/.site-list-* classes,
// already shared in style.css (loaded on every page), so it comes out
// themed identically with no new CSS needed. Free-typing the whole value
// (like "1437" or "14:37") sidesteps the segment-ambiguity problem
// entirely instead of trying to fix it.
let schedFieldPopupClose = null;
let schedFieldPopupAnchor = null;

function schedCloseFieldPopup() {
  if (schedFieldPopupClose) { schedFieldPopupClose(); schedFieldPopupClose = null; }
  schedFieldPopupAnchor = null;
}

// Toggle helper for a field's open button: closes the popup if it's already
// open for this exact anchor (so a second click closes instead of
// re-opening an identical popup), otherwise runs `openFn` to open it fresh.
function schedToggleFieldPopup(anchor, openFn) {
  if (schedFieldPopupAnchor === anchor) { schedCloseFieldPopup(); return; }
  openFn();
}

function schedPositionFieldPopup(pop, anchor) {
  const rect = anchor.getBoundingClientRect();
  const popRect = pop.getBoundingClientRect();
  let left = Math.min(rect.left, window.innerWidth - popRect.width - 8);
  left = Math.max(left, 8);
  let top = rect.bottom + 4;
  if (top + popRect.height > window.innerHeight - 8) top = rect.top - popRect.height - 4;
  pop.style.left = `${left}px`;
  pop.style.top = `${Math.max(top, 8)}px`;
}

// Opens `pop` anchored to `anchor` with the close-on-outside-click/Escape/
// reposition-on-scroll behaviour every field popup needs. Returns the
// close function.
function schedOpenFieldPopup(anchor, pop) {
  schedCloseFieldPopup();
  pop.style.position = 'fixed';
  document.body.appendChild(pop);
  schedPositionFieldPopup(pop, anchor);

  function onDocMousedown(e) {
    if (!pop.contains(e.target) && e.target !== anchor) close();
  }
  function onKeydown(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close(); anchor.focus(); }
  }
  function onReposition() { schedPositionFieldPopup(pop, anchor); }
  document.addEventListener('mousedown', onDocMousedown, true);
  document.addEventListener('keydown', onKeydown, true);
  window.addEventListener('resize', onReposition);
  document.addEventListener('scroll', onReposition, true);

  function close() {
    document.removeEventListener('mousedown', onDocMousedown, true);
    document.removeEventListener('keydown', onKeydown, true);
    window.removeEventListener('resize', onReposition);
    document.removeEventListener('scroll', onReposition, true);
    pop.remove();
    if (schedFieldPopupClose === close) { schedFieldPopupClose = null; schedFieldPopupAnchor = null; }
  }
  schedFieldPopupClose = close;
  schedFieldPopupAnchor = anchor;
  return close;
}

function schedClockIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const circle = document.createElementNS(svgNS, 'circle');
  circle.setAttribute('cx', '8');
  circle.setAttribute('cy', '8');
  circle.setAttribute('r', '6.5');
  svg.appendChild(circle);
  const hands = document.createElementNS(svgNS, 'path');
  hands.setAttribute('d', 'M8 4.5V8l2.8 1.6');
  svg.appendChild(hands);
  return svg;
}

function schedTimeOptions() {
  const opts = [];
  for (let h = 0; h < 24; h++) {
    for (let m = 0; m < 60; m += 15) opts.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
  }
  return opts;
}

// Accepts what a user is likely to type — "14:30", "14.30", "930", "0930" —
// and normalizes to strict "HH:MM", or null if unparseable.
function schedParseTimeInput(raw) {
  const s = raw.trim();
  if (!s) return '';
  let m = s.match(/^([0-2]?\d)[:.]([0-5]\d)$/);
  if (!m) m = s.match(/^(\d{1,2})(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h > 23 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function schedOpenTimePicker(anchor, currentValue, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-tp-pop';

  const clearRow = document.createElement('button');
  clearRow.type = 'button';
  clearRow.className = 'site-list-row site-tp-clear';
  clearRow.textContent = 'Ingen tid';
  clearRow.addEventListener('click', () => { close(); onSelect(''); });
  pop.appendChild(clearRow);

  const list = document.createElement('div');
  list.className = 'site-tp-list';
  pop.appendChild(list);

  // Scroll to the option nearest currentValue so the popup opens showing
  // roughly where you are — the list only offers 15-min-grid options, and
  // currentValue can easily fall off that grid (e.g. a slot's end time
  // derived from a non-15-min segment/gap), so this is a nearest match, not
  // necessarily exact. Nothing is marked "selected": clicking any row closes
  // the popup immediately, so a persistent highlight serves no purpose.
  const currentMinutes = currentValue ? timeToMinutes(currentValue) : null;
  let nearestRow = null;
  let nearestDiff = Infinity;
  for (const t of schedTimeOptions()) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-list-row';
    row.textContent = t;
    if (currentMinutes !== null) {
      const diff = Math.abs(timeToMinutes(t) - currentMinutes);
      if (diff < nearestDiff) { nearestDiff = diff; nearestRow = row; }
    }
    row.addEventListener('click', () => { close(); onSelect(t); });
    list.appendChild(row);
  }

  const close = schedOpenFieldPopup(anchor, pop);
  if (nearestRow) nearestRow.scrollIntoView({ block: 'center' });
}

// Generic dropdown popup: `options` is [{value, label}]. Mirrors
// site-utils.js's siteOpenDropdownPicker (duplicated here for the same
// schedule.html-doesn't-load-site-utils.js reason as schedOpenTimePicker
// above), reusing the same .site-field-pop/.site-dd-pop/.site-list-row
// classes so it renders identically.
function schedOpenDropdownPicker(anchor, options, currentValue, onSelect) {
  const pop = document.createElement('div');
  pop.className = 'site-field-pop site-dd-pop';

  for (const opt of options) {
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'site-list-row';
    if (opt.value === currentValue) row.classList.add('site-list-selected');
    row.textContent = opt.label;
    row.addEventListener('click', () => { close(); onSelect(opt.value); });
    pop.appendChild(row);
  }

  const close = schedOpenFieldPopup(anchor, pop);
}

function schedCreateDropdownField(options, initialValue) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-field-btn';
  const text = document.createElement('span');
  text.className = 'site-field-text';
  const chevron = document.createElement('span');
  chevron.className = 'site-field-chevron';
  chevron.textContent = '▾';
  btn.appendChild(text);
  btn.appendChild(chevron);

  let _value = initialValue != null ? initialValue : '';
  function render() {
    const opt = options.find((o) => o.value === _value);
    text.textContent = opt ? opt.label : 'Vælg';
    text.classList.toggle('site-field-placeholder', !opt);
  }
  Object.defineProperty(btn, 'value', {
    get() { return _value; },
    set(v) { _value = v; render(); },
  });
  render();

  btn.addEventListener('click', () => {
    schedToggleFieldPopup(btn, () => {
      schedOpenDropdownPicker(btn, options, _value, (v) => {
        _value = v;
        render();
        btn.dispatchEvent(new Event('change'));
      });
    });
  });
  return btn;
}

function schedCreateTimeField(initialValue) {
  const wrap = document.createElement('div');
  wrap.className = 'site-field-combo';

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'site-field-input';
  input.placeholder = 'tt:mm';
  input.autocomplete = 'off';
  input.inputMode = 'numeric';

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'site-field-toggle';
  toggle.appendChild(schedClockIcon());
  toggle.setAttribute('aria-label', 'Vælg tidspunkt');

  wrap.appendChild(input);
  wrap.appendChild(toggle);

  let _value = initialValue || '';
  input.value = _value;

  Object.defineProperty(wrap, 'value', {
    get() { return _value; },
    set(v) { _value = v || ''; input.value = _value; },
  });

  function commit(newValue) {
    _value = newValue;
    input.value = _value;
  }

  input.addEventListener('blur', () => {
    const parsed = schedParseTimeInput(input.value);
    if (parsed === null) { input.value = _value; return; } // revert, keep last valid value
    commit(parsed);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
  });

  toggle.addEventListener('click', () => {
    schedToggleFieldPopup(toggle, () => {
      schedOpenTimePicker(toggle, _value, (t) => commit(t));
    });
  });

  return wrap;
}

function mountTimeField(mountId, fieldId, initialValue) {
  const mount = document.getElementById(mountId);
  const field = schedCreateTimeField(initialValue);
  field.id = fieldId;
  mount.replaceWith(field);
  return field;
}

function mountDropdownField(mountId, fieldId, options, initialValue) {
  const mount = document.getElementById(mountId);
  const field = schedCreateDropdownField(options, initialValue);
  field.id = fieldId;
  mount.replaceWith(field);
  return field;
}

function minuteOptions(values) {
  return values.map((v) => ({ value: String(v), label: `${v} min` }));
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  mountTimeField('input-start-mount', 'input-start', '10:00');
  mountTimeField('input-end-mount', 'input-end', '17:00');
  mountTimeField('absent-form-start-mount', 'absent-form-start', '');
  mountTimeField('absent-form-end-mount', 'absent-form-end', '');
  mountDropdownField('input-segment-mount', 'input-segment', minuteOptions([5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55, 60]), '25');
  mountDropdownField('input-gap-mount', 'input-gap', minuteOptions([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), '5');

  // Load scenes/cast up front — a plain page reload is NOT on its own a safe
  // moment to prefer a fresh manus override: state.allScenes always starts
  // empty here regardless of whether restoreState() (below) is about to
  // restore a grid full of placements from localStorage. hasSavedPlacements()
  // peeks that same localStorage snapshot first so the override is only
  // used when this really is a from-scratch session (see loadScenes() below).
  await loadScenes(!hasSavedPlacements());

  document.getElementById('btn-build').addEventListener('click', buildGrid);
  document.getElementById('btn-export').addEventListener('click', () => window.print());
  document.getElementById('btn-clear-schedule').addEventListener('click', clearSchedule);
  document.getElementById('clear-confirm-cancel').addEventListener('click', closeClearConfirm);
  document.getElementById('clear-confirm-ok').addEventListener('click', confirmClearSchedule);
  document.getElementById('clear-confirm-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeClearConfirm();
  });
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
function buildSlots(startTime, endTime, segmentMinutes, gapMinutes = 0) {
  const start = timeToMinutes(startTime);
  const end   = timeToMinutes(endTime);
  const slots = [];
  // The gap is dead space between slots, not part of any slot's own
  // duration, so a slot's own endMinutes stays start+segmentMinutes
  // regardless of gap — only the step to the next slot's start grows.
  for (let t = start; t + segmentMinutes - 5 <= end; t += segmentMinutes + gapMinutes) {
    slots.push({
      label: minutesToTime(t) + ' – ' + minutesToTime(t + segmentMinutes),
      startMinutes: t,
      endMinutes: t + segmentMinutes,
    });
  }
  return slots;
}

// ── Manus-save freshness ────────────────────────────────────
// schedule.html doesn't load site-utils.js (it must keep working over
// file://, per the top-of-file note above), so this is a small, read-only
// copy of just the override-reading half of site-utils.js's
// siteSaveOverride/siteLoadOverride: manus.js's Gem (manusSaveMain, via
// manus-data.js's setManusSavedOverride) persists its saved scenes/cast to
// this same localStorage key so a freshly-loaded Øveplan session — nothing
// built on the grid yet — can start from it instead of waiting ~1-2 min for
// the GitHub Action to regenerate scenes-data.js. Never consulted once a
// grid already exists (see loadScenes()/clearSchedule() below) — swapping
// scene/cast data out from under an in-progress schedule could silently
// invalidate placements (e.g. a dance-split boundary shifting a cast member
// into/out of the "(Dans)" half, orphaning a placed cell's sceneId).
const MANUS_OVERRIDE_TTL_MS = 5 * 60 * 1000; // matches site-utils.js's SITE_OVERRIDE_TTL_MS
function loadManusOverride() {
  try {
    const raw = localStorage.getItem('matrevy-override-manus');
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > MANUS_OVERRIDE_TTL_MS) {
      return null;
    }
    return parsed.data;
  } catch (e) {
    return null;
  }
}

// Peeks the persisted schedule snapshot (the same localStorage key
// saveState()/restoreState() use) purely to check whether it holds any
// actual placements — without fully restoring it. Used only to gate the
// boot-time loadScenes() call below: a page reload always starts with an
// empty in-memory state.grid, so state.grid.length alone can't tell "fresh
// session" apart from "about to restore a grid full of placements."
function hasSavedPlacements() {
  try {
    const raw = localStorage.getItem('matrevy-schedule');
    if (!raw) return false;
    const snap = JSON.parse(raw);
    return Array.isArray(snap.grid) && snap.grid.some(row => Array.isArray(row) && row.some(cell => cell != null));
  } catch (e) {
    return false;
  }
}

// ── Load scenes ───────────────────────────────────────────
// Data is embedded via scenes-data.js (SCENES_DATA constant) to avoid
// fetch() failing on file:// protocol when opened locally.
// allowOverride defaults to false (never touch the manus override) so any
// future bare call fails safe; each call site below opts in explicitly only
// when it can actually guarantee nothing is placed yet.
async function loadScenes(allowOverride = false) {
  if (state.allScenes.length) return;
  // CUSTOM_SCENES first so they sort above "Akt 1" in the act-grouped lists.
  // Prefer a still-fresh manus.js save over the embedded SCENES_DATA/CAST_DATA
  // — see loadManusOverride() above for why this is only safe to do here
  // (nothing on the grid yet) and not once a session is already in progress.
  const override = allowOverride ? loadManusOverride() : null;
  const scenesData = override ? override.scenes : SCENES_DATA;
  const castData   = override ? override.cast   : CAST_DATA;
  state.allScenes = applyDanceSplits([...CUSTOM_SCENES, ...scenesData]);
  state.allCast = castData;
}

// ── Build grid ────────────────────────────────────────────
async function buildGrid() {
  await loadScenes();

  const startTime = document.getElementById('input-start').value || '10:00';
  const endTime   = document.getElementById('input-end').value   || '17:00';
  const segmentMinutes = parseInt(document.getElementById('input-segment').value, 10) || 30;
  const gapMinutes = parseInt(document.getElementById('input-gap').value, 10) || 0;

  const roomLines = document.getElementById('input-rooms').value
    .split('\n').map(r => r.trim()).filter(Boolean);

  if (!roomLines.length) { alert('Tilføj mindst ét lokale.'); return; }
  if (timeToMinutes(startTime) >= timeToMinutes(endTime)) {
    alert('Sluttidspunktet skal være efter starttidspunktet.'); return;
  }

  // Preserve existing grid assignments (and any manually-edited slot times,
  // see openSlotTimeEditor) if the time CONFIG matches the last build —
  // rooms are handled below by NAME, not index, so adding/removing/
  // reordering rooms doesn't wipe or misattribute existing placements.
  // Comparing config fields (not the freshly-regenerated slots array itself)
  // means state.slots is left completely untouched when nothing time-related
  // changed, so a manual per-slot time edit survives a rebuild that only
  // changes e.g. the room list.
  const configChanged = !state.slotsConfig ||
    state.slotsConfig.startTime !== startTime ||
    state.slotsConfig.endTime !== endTime ||
    state.slotsConfig.segmentMinutes !== segmentMinutes ||
    state.slotsConfig.gapMinutes !== gapMinutes;
  const oldRooms = state.rooms;
  const oldGrid  = state.grid;

  state.rooms = roomLines;
  if (configChanged) state.slots = buildSlots(startTime, endTime, segmentMinutes, gapMinutes);
  state.slotsConfig = { startTime, endTime, segmentMinutes, gapMinutes };

  // Build scenes list — priority always comes fresh from data/scenes.json
  // (via state.allScenes), never carried over locally: Øveplan is a
  // read-only consumer of Manus's Stjerneark priority, not a second place to
  // edit it.
  state.scenes = state.allScenes
    .filter(s => s.schedulable)
    .map(s => ({ ...s }));

  // Reset grid only if the time configuration changed — slot indices no
  // longer correspond to the same time windows, so nothing can be carried
  // over safely in that case.
  if (configChanged) {
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
    // Time cell — clicking it opens the slot's own time editor. Scenes are
    // still addable per-room via each empty cell's own "+" (see renderCell),
    // so this doesn't remove any existing way to place a scene.
    const timeTd = document.createElement('td');
    timeTd.className = 'col-time col-time-clickable';
    timeTd.textContent = slot.label;
    timeTd.title = 'Klik for at redigere tidspunktet';
    timeTd.onclick = () => openSlotTimeEditor(si);
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
      crossedOutCast: assignment.crossedOutCast || null,
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
        castEl.innerHTML = renderCastListHtml(names, si, assignment);
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
// Cast names actually shown by default for a scene — never Statist/Ninja,
// and for an unmerged song/dance-half, narrowed further to the roles
// relevant to that half. This is the set that's genuinely "written down" on
// the schedule for a placement that hasn't been hand-edited, so it's the
// basis for both display (getCellCastNames/getDisplayCastNames below) and
// overlap detection (getConflicts/getPickerConflictNames) alike — a Statist
// nobody actually cast for a given day shouldn't trigger a false overlap
// just for existing in the scene's full data/scenes.json cast list.
function filteredCastNames(scene) {
  if (!scene || scene.custom) return [];
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

// Rekvisitten's cast is picked per-placement (cell.customCast), not fixed on
// the scene definition, so conflict checks resolve cast names per-cell.
// Once cell.customCast exists (a merged placement, or anything the
// coordinator has explicitly picked via the cell editor — including a
// Statist/Ninja/etc. added on purpose) it's returned verbatim, never
// re-filtered, so an explicit choice always sticks and IS then checked for
// overlap — only the *unfiltered* default falls back to filteredCastNames().
function getCellCastNames(cell) {
  if (!cell) return [];
  if (cell.customCast) return cell.customCast;
  return filteredCastNames(getSceneById(cell.sceneId));
}

// Historically a separate function; getCellCastNames() now *is* the display
// cast (see filteredCastNames() above), so this is a thin alias kept for
// call sites that are conceptually about "what's shown on the cell" rather
// than "what to check for conflicts."
function getDisplayCastNames(cell) {
  return getCellCastNames(cell);
}

// Builds cast-list HTML as one <span> per name with the separator embedded
// inside the span (never a bare text node between spans), so a
// display:block rule on the span (e.g. in print) can't strand a lone comma
// on its own line between names.
function renderCastListHtml(names, si, cell) {
  return names.map((n, i) => {
    const crossedOut = isPersonCrossedOutAtCell(n, cell);
    const absent = !crossedOut && isPersonAbsentAtSlot(n, si);
    const sep = i < names.length - 1 ? ', ' : '';
    // The separator sits outside the "absent"/"crossed-out" span so the
    // strikethrough only crosses the name itself, not the trailing comma.
    const cls = crossedOut ? 'crossed-out' : absent ? 'absent' : null;
    const nameHtml = cls ? `<span class="${cls}">${escHtml(n)}</span>` : escHtml(n);
    return `<span>${nameHtml}${sep}</span>`;
  }).join('');
}

function getConflicts(si, ri, cell) {
  const castNames = getCellCastNames(cell).filter(n => !isPersonCrossedOutAtCell(n, cell));
  if (!castNames.length) return [];
  const conflicts = [];
  state.rooms.forEach((_, otherRi) => {
    if (otherRi === ri) return;
    const other = state.grid[si][otherRi];
    if (!other) return;
    const otherCast = getCellCastNames(other).filter(n => !isPersonCrossedOutAtCell(n, other));
    const clash = castNames.filter(n => otherCast.includes(n) && !isPersonAbsentAtSlot(n, si));
    if (clash.length) conflicts.push(...clash);
  });
  return [...new Set(conflicts)];
}

function castConflictsAtNames(si, castNames, excludeRi = -1) {
  // Returns true if placing a scene with these cast names at slot si would create a conflict.
  // The caller is expected to already have excluded any of its own crossed-out
  // names from castNames (see highlightDrop) — this function only knows the
  // "other" side's cells, so it exempts crossed-out members there itself.
  if (!castNames.length) return false;
  const names = new Set(castNames.filter(n => !isPersonAbsentAtSlot(n, si)));
  for (let ri = 0; ri < state.rooms.length; ri++) {
    if (ri === excludeRi) continue;
    const other = state.grid[si][ri];
    if (!other) continue;
    for (const n of getCellCastNames(other)) {
      if (isPersonCrossedOutAtCell(n, other)) continue;
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
let dragState = null; // { sceneId, fromSlot, fromRoom, customCast, crossedOutCast, pairedSceneId }

function startDrag(sceneId, fromSlot, fromRoom, extra = {}) {
  dragState = { sceneId, fromSlot: fromSlot ?? null, fromRoom: fromRoom ?? null, ...extra };
  // Mark chip as dragging
  const chip = document.querySelector(`.scene-chip[data-id="${sceneId}"]`);
  if (chip) chip.classList.add('dragging');
}

function highlightDrop(td, si, ri) {
  clearAllDropHighlights();
  if (!dragState) return;
  const castNames = getCellCastNames(dragState).filter(n => !isPersonCrossedOutAtCell(n, dragState));
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
  const { sceneId, fromSlot, fromRoom, customCast, crossedOutCast, pairedSceneId, customText, customName } = dragState;
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
  if (crossedOutCast && crossedOutCast.length) placed.crossedOutCast = crossedOutCast;
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
  document.getElementById('clear-confirm-overlay').style.display = 'flex';
}

function closeClearConfirm() {
  document.getElementById('clear-confirm-overlay').style.display = 'none';
}

async function confirmClearSchedule() {
  closeClearConfirm();
  state.grid = state.slots.map(() => state.rooms.map(() => null));

  // Nothing is placed anymore, so this is as safe a moment as a fresh page
  // load to re-resolve scenes/cast — picking up a newer manus.js save (or
  // falling back to the real embedded data, if that override has since
  // expired) instead of staying pinned to whatever was loaded at the start
  // of this session. See loadManusOverride()/loadScenes() above for why this
  // can't happen while a grid is still in use.
  state.allScenes = [];
  state.allCast = [];
  await loadScenes(true); // safe: state.grid was just fully nulled above
  state.scenes = state.allScenes
    .filter(s => s.schedulable)
    .map(s => ({ ...s }));

  renderGrid();
  renderSceneSidebar();
  saveState();
}

// ── Scene sidebar ─────────────────────────────────────────
function renderSceneSidebar() {
  const placedCounts = getPlacedSceneCounts();

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
      const isPlaced = isSceneFullyPlaced(scene, placedCounts);
      const chip = document.createElement('div');
      chip.className = 'scene-chip' + (isPlaced ? ' placed' : '');
      chip.dataset.id = scene.id;
      chip.draggable = true;
      chip.ondragstart = () => startDrag(scene.id, null, null);

      // Priority badge — read-only, sourced from data/scenes.json (set via
      // Manus's Stjerneark tab, not editable here).
      const prioSpan = document.createElement('span');
      prioSpan.className = `chip-priority prio-${scene.priority}`;
      prioSpan.textContent = scene.priority;

      const nameSpan = document.createElement('span');
      nameSpan.className = 'chip-name';
      nameSpan.textContent = scene.name;

      chip.appendChild(prioSpan);
      chip.appendChild(nameSpan);
      if (scene.repeat) {
        const repeatSpan = document.createElement('span');
        repeatSpan.className = 'chip-repeat-tag';
        repeatSpan.textContent = '↻';
        repeatSpan.title = 'Skal øves igen dagen efter';
        chip.appendChild(repeatSpan);
      }
      container.appendChild(chip);
    }
  }
}

// ── Absentees ─────────────────────────────────────────────
function getSlotRange(si) {
  const slot = state.slots[si];
  if (!slot) return null;
  if (slot.endMinutes !== undefined) return { start: slot.startMinutes, end: slot.endMinutes };
  // Legacy localStorage snapshot from before slots carried their own endMinutes.
  const segmentMinutes = parseInt(document.getElementById('input-segment').value, 10) || 30;
  const nextStart = state.slots[si + 1] ? state.slots[si + 1].startMinutes : undefined;
  const end = nextStart !== undefined ? nextStart : slot.startMinutes + segmentMinutes;
  return { start: slot.startMinutes, end };
}

function isPersonCrossedOutAtCell(name, cell) {
  return !!(cell && cell.crossedOutCast && cell.crossedOutCast.includes(name));
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
  const options = [
    { value: '', label: 'Vælg revyster…' },
    ...state.allCast.map(c => ({ value: c.name, label: c.name })),
  ];
  const nameField = schedCreateDropdownField(options, '');
  nameField.id = 'absent-form-name';
  document.getElementById('absent-form-name').replaceWith(nameField);
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
let cellEditCrossedOut = new Set(); // subset of cellEditCastSelected that's crossed out (Roller rows only)

function openPicker(si, ri = null) {
  pickerSlot = si;
  pickerRoom = ri;
  pickerMode = 'list';
  pickerSelected = new Set();
  rekvisittenCastSelected = new Set();
  cellEditCastSelected = new Set();
  cellEditCrossedOut = new Set();
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
  cellEditCrossedOut = new Set();
  slotTimeStartField = null;
  slotTimeEndField = null;
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
  if (pickerMode === 'edit-slot-time') { confirmSlotTimeEditor(); return; }
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
  // (crossed-out members are exempted — crossing out frees them up).
  const occupied = new Set();
  for (let ri = 0; ri < state.rooms.length; ri++) {
    const cell = state.grid[pickerSlot][ri];
    if (cell) getCellCastNames(cell).filter(n => !isPersonCrossedOutAtCell(n, cell)).forEach(n => occupied.add(n));
  }
  // Also fold in cast from scenes selected-but-not-yet-confirmed in this same
  // picker visit — mirrors getPickerConflictNames's pattern for the reverse
  // case (a candidate scene checked against other selected-but-unconfirmed
  // scenes).
  for (const selId of pickerSelected) {
    const sel = getSceneById(selId);
    if (sel) sel.cast.forEach(c => occupied.add(c.name));
  }

  const names = state.allCast.map(c => c.name);

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
  cellEditCrossedOut = new Set((cell && cell.crossedOutCast) || []);
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
  // Crossed-out members of an other cell are exempted — crossing out frees
  // them up to be picked here instead.
  const occupied = new Set();
  for (let ri2 = 0; ri2 < state.rooms.length; ri2++) {
    if (ri2 === pickerRoom) continue;
    const other = state.grid[pickerSlot][ri2];
    if (other) getCellCastNames(other).filter(n => !isPersonCrossedOutAtCell(n, other)).forEach(n => occupied.add(n));
  }

  // isRollerRow: default-cast ("Roller") rows cross out instead of being
  // fully removed once active — mirroring Fravær, a crossed-out person stays
  // shown (struck through) and is exempted from conflict checks rather than
  // disappearing. "Andre revyster" rows keep the plain binary add/remove
  // toggle, since cross-out only applies to people actually in the scene.
  const makeRow = (name, roleLabel, isRollerRow) => {
    const isOccupied = occupied.has(name);
    const isAbsent = isPersonAbsentAtSlot(name, pickerSlot);
    const isSelected = cellEditCastSelected.has(name);
    const isCrossedOut = isRollerRow && cellEditCrossedOut.has(name);
    // Someone already in THIS cell must remain clickable even if now flagged
    // occupied/absent elsewhere — otherwise the coordinator could never
    // toggle the very person this editor exists to let them cross out.
    const isUnavailable = (isOccupied || isAbsent) && !isSelected;

    let cls = 'picker-item';
    if (isCrossedOut) cls += ' picker-crossed-out';
    else if (isSelected) cls += ' picker-selected';
    if (isUnavailable) cls += ' picker-at-cap';

    const item = document.createElement('div');
    item.className = cls;

    const nameSpan = document.createElement('span');
    nameSpan.style.flex = '1';
    const suffix = isCrossedOut ? ' (overstreget)' : isOccupied ? ' (optaget)' : isAbsent ? ' (fraværende)' : '';
    nameSpan.textContent = name + (roleLabel ? ` (${roleLabel})` : '') + suffix;
    item.appendChild(nameSpan);

    if (!isUnavailable) {
      item.onclick = () => {
        if (isRollerRow) {
          if (!isSelected) {
            // Not yet part of the placement (e.g. a Statist not shown by
            // default) — first click adds them, active.
            cellEditCastSelected.add(name);
          } else if (cellEditCrossedOut.has(name)) {
            cellEditCrossedOut.delete(name);
          } else {
            cellEditCrossedOut.add(name);
          }
        } else {
          if (cellEditCastSelected.has(name)) cellEditCastSelected.delete(name);
          else cellEditCastSelected.add(name);
        }
        _updatePickerFooter();
        renderCellEditorList();
      };
    }
    return item;
  };

  const sceneCast = scene ? getSceneCastWithRoles(scene) : [];
  const sceneNames = new Set(sceneCast.map(c => c.name));
  const otherNames = state.allCast.map(c => c.name).filter(n => !sceneNames.has(n));

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
    section => { for (const c of sceneCast) section.appendChild(makeRow(c.name, c.category, true)); });

  renderSection('Andre revyster', cellEditorOthersOpen, v => { cellEditorOthersOpen = v; }, otherNames.length,
    section => { for (const name of otherNames) section.appendChild(makeRow(name, null, false)); });
}

function confirmCellEditor() {
  if (pickerSlot === null || pickerRoom === null || !cellEditCastSelected.size) return;
  const cell = state.grid[pickerSlot][pickerRoom];
  if (!cell) { closePicker(); return; }
  cell.customCast = [...cellEditCastSelected];
  const crossed = [...cellEditCrossedOut].filter(n => cellEditCastSelected.has(n));
  if (crossed.length) cell.crossedOutCast = crossed; else delete cell.crossedOutCast;
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

// ── Per-slot time editor ──────────────────────────────────
// A manual override of one row's own start/end — no ripple to neighboring
// slots (each slot carries its own independent startMinutes/endMinutes).
let slotTimeStartField = null;
let slotTimeEndField = null;

function openSlotTimeEditor(si) {
  pickerSlot = si;
  pickerRoom = null;
  pickerMode = 'edit-slot-time';
  document.getElementById('picker-title').textContent = 'Rediger tidspunkt';
  _updatePickerFooter();
  document.getElementById('picker-overlay').style.display = 'flex';
  renderSlotTimeEditor();
}

function renderSlotTimeEditor() {
  const container = document.getElementById('picker-list');
  container.innerHTML = '';
  // getSlotRange (not slot.startMinutes/endMinutes directly) so a slot
  // restored from a pre-endMinutes localStorage snapshot still shows a real
  // time here instead of NaN:NaN — it falls back to deriving the end from
  // the next slot's start / the segment length.
  const range = getSlotRange(pickerSlot);

  const row = document.createElement('div');
  row.className = 'picker-text-editor-row';

  const startWrap = document.createElement('label');
  startWrap.className = 'field-label picker-text-editor';
  startWrap.appendChild(document.createTextNode('Start'));
  slotTimeStartField = schedCreateTimeField(minutesToTime(range.start));
  startWrap.appendChild(slotTimeStartField);
  row.appendChild(startWrap);

  const endWrap = document.createElement('label');
  endWrap.className = 'field-label picker-text-editor';
  endWrap.appendChild(document.createTextNode('Slut'));
  slotTimeEndField = schedCreateTimeField(minutesToTime(range.end));
  endWrap.appendChild(slotTimeEndField);
  row.appendChild(endWrap);

  container.appendChild(row);
}

function confirmSlotTimeEditor() {
  const slot = state.slots[pickerSlot];
  if (!slot || !slotTimeStartField || !slotTimeEndField) { closePicker(); return; }
  const range = getSlotRange(pickerSlot);
  const newStart = timeToMinutes(slotTimeStartField.value || minutesToTime(range.start));
  const newEnd   = timeToMinutes(slotTimeEndField.value || minutesToTime(range.end));
  if (newEnd <= newStart) { alert('Sluttidspunktet skal være efter starttidspunktet.'); return; }
  slot.startMinutes = newStart;
  slot.endMinutes = newEnd;
  slot.label = minutesToTime(newStart) + ' – ' + minutesToTime(newEnd);
  renderGrid();
  saveState();
  closePicker();
}

function _emptyRoomCount(si) {
  return state.rooms.reduce((n, _, ri) => n + (state.grid[si][ri] ? 0 : 1), 0);
}

function _updatePickerFooter() {
  const modal = document.querySelector('#picker-overlay .picker-modal');
  if (modal) modal.classList.toggle('picker-modal-fixed-height',
    pickerMode !== 'edit-scenemode' && pickerMode !== 'edit-slot-time');
  if (modal) modal.classList.toggle('picker-modal-narrow', pickerMode === 'edit-slot-time');

  const confirmBtn = document.getElementById('picker-confirm');
  confirmBtn.textContent = (pickerMode === 'edit-cell' || pickerMode === 'edit-scenemode' || pickerMode === 'edit-slot-time') ? 'Opdater' : 'Placer';
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
  if (pickerMode === 'edit-slot-time') {
    confirmBtn.disabled = false;
    return;
  }
  confirmBtn.disabled = pickerSelected.size === 0;
}

// Returns conflicting cast member names for sceneId at slot si, also
// counting any other scenes already selected in the picker. Only checks
// names actually "written down" for each side — filteredCastNames() for the
// candidate scene and for other not-yet-placed picker selections (neither
// has a customCast yet), getCellCastNames() (customCast-aware) for cells
// already on the grid — so an unshown Statist/Ninja never trips a false
// overlap, but one explicitly added via the cell editor does.
function getPickerConflictNames(si, sceneId) {
  const scene = getSceneById(sceneId);
  const candidateNames = filteredCastNames(scene);
  if (!candidateNames.length) return [];

  const occupiedCast = new Set();
  // Cast already in grid cells at this slot — a crossed-out member of a
  // placed cell is exempted, same as everywhere else: crossing out frees
  // them up, so a different scene containing them shouldn't be flagged.
  for (let ri = 0; ri < state.rooms.length; ri++) {
    const cell = state.grid[si][ri];
    if (!cell) continue;
    getCellCastNames(cell).filter(n => !isPersonCrossedOutAtCell(n, cell)).forEach(n => occupiedCast.add(n));
  }
  // Cast from other currently-selected scenes in the picker
  for (const selId of pickerSelected) {
    if (selId === sceneId) continue;
    filteredCastNames(getSceneById(selId)).forEach(n => occupiedCast.add(n));
  }

  return candidateNames.filter(n => !isPersonAbsentAtSlot(n, si) && occupiedCast.has(n));
}

// Cast members of `sceneId` who are absent during slot `si`'s time window —
// same filteredCastNames() basis as getPickerConflictNames above, so a
// Statist/Ninja not actually on the schedule doesn't show a false absence
// tag either. Purely advisory — never affects selectability.
function getPickerAbsentNames(si, sceneId) {
  return filteredCastNames(getSceneById(sceneId)).filter(n => isPersonAbsentAtSlot(n, si));
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

function buildPickerSceneItem(scene, placedCounts, half) {
  // Custom scenes (Scenemøde, Rekvisitten) can be used in multiple slots per
  // day. A repeat-flagged scene (Manus's Stjerneark ↻ toggle) similarly
  // wants a second placement that day — see sceneMaxPlacements() — so it
  // only dims once it's actually been placed twice, not after the first.
  const isPlaced = !scene.custom && isSceneFullyPlaced(scene, placedCounts);
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

  // Repeat tag (Manus's Stjerneark ↻ toggle) — sits at the far right of the
  // row itself, not glued onto the name like the O/F tags above, since it's
  // a property of the scene rather than of this particular slot/visit.
  if (scene.repeat) {
    const repeatTag = document.createElement('span');
    repeatTag.className = 'picker-repeat-tag';
    repeatTag.textContent = '↻';
    repeatTag.title = 'Skal øves igen dagen efter';
    item.appendChild(repeatTag);
  }

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
  const placedCounts = getPlacedSceneCounts();
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
        row.appendChild(buildPickerSceneItem(scene, placedCounts, true));
        row.appendChild(buildPickerSceneItem(next, placedCounts, true));
        container.appendChild(row);
        i++; // consumed the dance-part entry too
        continue;
      }
      container.appendChild(buildPickerSceneItem(scene, placedCounts, false));
    }
  }
}

// ── Helpers ───────────────────────────────────────────────
function getSceneById(id) {
  return state.allScenes.find(s => s.id === id) || null;
}

// How many times each scene id currently sits on the grid — a plain
// presence Set isn't enough once a repeat-flagged scene is allowed to be
// placed twice (see sceneMaxPlacements()/isSceneFullyPlaced() below), since
// "placed once" and "placed twice" need to read as different states.
function getPlacedSceneCounts() {
  const counts = new Map();
  const bump = id => counts.set(id, (counts.get(id) || 0) + 1);
  for (const row of state.grid) {
    for (const cell of row) {
      if (!cell) continue;
      bump(cell.sceneId);
      if (cell.pairedSceneId) bump(cell.pairedSceneId);
    }
  }
  return counts;
}

// A repeat-flagged scene (Manus's Stjerneark ↻ toggle) genuinely wants a
// second placement that day, so it takes two placements — not one — before
// it dims as "already placed" in the sidebar/picker.
function sceneMaxPlacements(scene) {
  return scene.repeat ? 2 : 1;
}

function isSceneFullyPlaced(scene, placedCounts) {
  return (placedCounts.get(scene.id) || 0) >= sceneMaxPlacements(scene);
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
      startTime: document.getElementById('input-start').value,
      endTime: document.getElementById('input-end').value,
      segmentMinutes: document.getElementById('input-segment').value,
      gapMinutes: document.getElementById('input-gap').value,
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
    if (snap.gapMinutes !== undefined) document.getElementById('input-gap').value = snap.gapMinutes;
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
        .map(s => ({ ...s }));
      // Re-seed slotsConfig from the just-restored fields so a same-config
      // "Byg øveplan" click after reload still preserves manual slot edits
      // (see buildGrid's configChanged check) instead of always regenerating.
      state.slotsConfig = {
        startTime: document.getElementById('input-start').value,
        endTime: document.getElementById('input-end').value,
        segmentMinutes: parseInt(document.getElementById('input-segment').value, 10) || 30,
        gapMinutes: parseInt(document.getElementById('input-gap').value, 10) || 0,
      };

      document.getElementById('sched-grid-title').textContent = state.title;
      document.getElementById('sched-empty-state').style.display = 'none';
      document.getElementById('sched-grid-container').style.display = 'block';
      document.getElementById('scene-sidebar').style.display = 'block';

      renderGrid();
      renderSceneSidebar();
    }
  } catch(e) { /* ignore corrupt state */ }
}
