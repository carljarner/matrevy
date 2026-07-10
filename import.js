/* =========================================================
   Matematikrevyen – Manus edit tool
   Shows the entire current scene catalog grouped by act, just like
   the scheduling sidebar. Each scene is a collapsible row you can
   drag to reorder (or drag into a different act) while collapsed;
   opening it reveals the same editable fields as before minus
   act/number, which are now derived purely from which act-section
   a scene sits in and its position within it. New scenes (manual
   add, or an uploaded .tex that doesn't name-match anything) land
   in a staging "Ikke placeret" section until dragged into an act.
   Applying writes the result straight into localStorage (read via
   manus-data.js's getEffectiveScenesData()/getEffectiveCastData())
   and reloads. This does NOT touch data/scenes.json — it's a fast
   local-iteration loop, not the git-committed publishing pipeline.
   Only \title{} and \begin{roles}...\end{roles} are parsed out of
   uploaded .tex files; everything else (props, sketch body, \says,
   stage directions) is deliberately ignored.
   ========================================================= */

'use strict';

// ── State ─────────────────────────────────────────────────
// importActs: [{ code, label }] — fixed, derived from the current data each time the modal opens.
let importActs = [];
// importState.scenes: ordered array; array order = position within whichever act each entry belongs to.
// Entry: { key, fileName, name, cast:[{code,name}], unassigned:[code], hasTitle, hasRoles, actCode, types:[], open }
let importState = { scenes: [] };
let manusDragKey = null; // key of the scene row currently being dragged

let _importKeySeq = 0;
function nextImportKey() { return 'f' + (_importKeySeq++); }

const SCENE_TYPES = ['sketch', 'sang', 'dans', 'bandsang', 'video'];
const SCENE_TYPE_LABELS = { sketch: 'Sketch', sang: 'Sang', dans: 'Dans', bandsang: 'Bandsang', video: 'Video' };
const EXCLUSIVE_TYPES = new Set(['bandsang', 'video']); // exclusive of everything, including each other
const BASE_TYPES = new Set(['sketch', 'sang']);          // mutually exclusive with each other, compatible with 'dans'
const NON_SCHEDULABLE_TYPES = new Set(['bandsang', 'video']);
const UNPLACED_ACT = { code: '', label: 'Ikke placeret', open: true };

// Cast role codes get normalized into one of these on import/parse — see classifyRoleCode().
const ROLE_CATEGORIES = ['Instruktør', 'Koreograf', 'Skuespil', 'Sang/Rap', 'Dans', 'Kor', 'Statist'];

// Simple rules that work ~99% of the time, given by the coordinator. Only ever run on a
// raw script code (not an already-classified category — see classifyOrKeep()), and only
// once, at parse time; scenes don't get retroactively reclassified if their type changes later.
// The pattern codes (I/Y/D/K/St) are code-shape-only and apply regardless of scene type;
// only the final ambiguous fallback needs to know sketch vs. song (isSong).
function classifyRoleCode(code, isSong) {
  const c = code.trim().toUpperCase();
  if (c === 'I') return 'Instruktør';
  if (c === 'Y') return 'Koreograf';
  if (c.includes('D')) return 'Dans';
  if (c.startsWith('K')) return 'Kor';
  if (c.startsWith('ST')) return 'Statist';
  return isSong ? 'Sang/Rap' : 'Skuespil';
}

function classifyOrKeep(code, isSong) {
  return ROLE_CATEGORIES.includes(code) ? code : classifyRoleCode(code, isSong);
}

// Force an act section open so a just-added/just-updated scene inside it is actually visible.
function ensureActOpen(actCode) {
  if (actCode === '') { UNPLACED_ACT.open = true; return; }
  const act = importActs.find(a => a.code === actCode);
  if (act) act.open = true;
}

// ── Boot ──────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const btnManus = document.getElementById('btn-manus');
  if (!btnManus) return; // panel not present on this page

  btnManus.addEventListener('click', () => {
    initImportStateFromCurrentData();
    openImportModal();
  });

  document.getElementById('input-tex-upload').addEventListener('change', handleTexUpload);
  document.getElementById('import-add-manual').addEventListener('click', addManualScene);
  document.getElementById('import-close').addEventListener('click', closeImportModal);
  document.getElementById('import-overlay').addEventListener('click', e => {
    if (e.target === e.currentTarget) closeImportModal();
  });
  document.getElementById('import-apply').addEventListener('click', applyImport);
});

// ── Load current catalog into editable state ───────────────
function initImportStateFromCurrentData() {
  const data = getEffectiveScenesData();

  const seenActs = new Map();
  for (const sc of data) {
    const code = sc.id.split('-')[0];
    if (!seenActs.has(code)) seenActs.set(code, sc.actLabel);
  }
  importActs = [...seenActs.entries()].map(([code, label]) => ({ code, label, open: false }));
  UNPLACED_ACT.open = false;

  importState.scenes = data.map(sc => {
    const types = sc.types && sc.types.length ? sc.types.slice() : (sc.schedulable ? ['sketch'] : ['video']);
    const isSong = types.includes('sang') || types.includes('bandsang');
    const actCode = sc.id.split('-')[0];
    return {
      key: nextImportKey(),
      fileName: null,
      name: sc.name,
      cast: sc.cast.map(c => ({ code: classifyOrKeep(c.role, isSong), name: c.name })),
      unassigned: [],
      hasTitle: true,
      hasRoles: true,
      actCode,
      pendingActCode: actCode,
      types,
      open: false,
    };
  });
}

// ── Parsing ───────────────────────────────────────────────
// A single uploaded file may contain one sketch or an entire manuscript's worth
// (many \title{}/\begin{roles} blocks back to back) — so this always returns an
// array of scenes. Scene boundaries are just \title{} occurrences: the text between
// one title and the next (or EOF) is that scene's scope, and its \begin{roles} block
// is whichever one appears first within that scope.
function parseTexFile(fileName, text) {
  const titleRe = /\\title\{([^}]*)\}/g;
  const titles = [];
  let tm;
  while ((tm = titleRe.exec(text))) {
    titles.push({ start: tm.index, end: tm.index + tm[0].length, name: tm[1].trim() });
  }

  if (!titles.length) {
    return [extractSceneFromScope(text, false, fileName.replace(/\.tex$/i, ''))];
  }

  return titles.map((t, i) => {
    const scopeEnd = i + 1 < titles.length ? titles[i + 1].start : text.length;
    const scope = text.slice(t.end, scopeEnd);
    return extractSceneFromScope(scope, true, t.name);
  });
}

function extractSceneFromScope(scopeText, hasTitle, name) {
  const rolesBlockMatch = scopeText.match(/\\begin\{roles\}([\s\S]*?)\\end\{roles\}/);
  const cast = [];
  const unassigned = [];
  if (rolesBlockMatch) {
    const roleLineRe = /\\role\{([^}]*)\}\s*(?:\[([^\]]*)\])?/g;
    let m;
    while ((m = roleLineRe.exec(rolesBlockMatch[1]))) {
      const code = m[1].trim();
      const roleName = m[2] ? m[2].trim() : '';
      if (roleName) cast.push({ code, name: roleName });
      else if (code) unassigned.push(code);
    }
  }

  // Every scene document wraps its content in \begin{sketch} or \begin{song} — that
  // tells us sketch vs. song directly, without waiting for the user to set a type pill.
  const envMatch = scopeText.match(/\\begin\{(sketch|song)\}/);
  const envType = envMatch ? envMatch[1] : null;

  return { name, cast, unassigned, hasTitle, hasRoles: !!rolesBlockMatch, envType };
}

function readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsText(file);
  });
}

function handleTexUpload(e) {
  const files = [...e.target.files];
  e.target.value = ''; // allow re-uploading the same filename later
  if (!files.length) return;

  Promise.all(files.map(readFileAsText)).then(contents => {
    // Each file can yield multiple scenes (a whole-manuscript upload). Auto-expanding
    // every one of them at once would bury the modal in open forms, so only do that
    // when this batch produces exactly one scene overall — the common "fix one sketch"
    // case. A bulk upload leaves rows collapsed; their act sections still get force-opened
    // via ensureActOpen() so the results are visible as a list.
    const perFile = contents.map((text, i) => parseTexFile(files[i].name, text));
    const totalScenes = perFile.reduce((n, scenes) => n + scenes.length, 0);
    const autoOpen = totalScenes === 1;

    perFile.forEach((parsedScenes, i) => {
      parsedScenes.forEach((parsed, sceneIdx) => {
        const label = parsedScenes.length > 1
          ? `${files[i].name} (${sceneIdx + 1}/${parsedScenes.length})`
          : files[i].name;
        const norm = parsed.name.trim().toLowerCase();
        const existing = importState.scenes.find(s => s.name.trim().toLowerCase() === norm);
        // The freshly parsed \begin{sketch}/\begin{song} wrapper is the authoritative
        // signal for what this cast list's codes mean — used for classification only;
        // it never overwrites an existing scene's already-configured type pills.
        const isSong = parsed.envType === 'song';

        if (existing) {
          existing.name = parsed.name;
          existing.cast = parsed.cast.map(c => ({ code: classifyRoleCode(c.code, isSong), name: c.name }));
          existing.unassigned = parsed.unassigned;
          existing.hasTitle = parsed.hasTitle;
          existing.hasRoles = parsed.hasRoles;
          existing.hasEnvType = !!parsed.envType;
          existing.fileName = label;
          existing.pendingActCode = existing.actCode;
          existing.open = autoOpen;
          ensureActOpen(existing.actCode);
        } else {
          ensureActOpen('');
          importState.scenes.push({
            key: nextImportKey(),
            fileName: label,
            name: parsed.name,
            cast: parsed.cast.map(c => ({ code: classifyRoleCode(c.code, isSong), name: c.name })),
            unassigned: parsed.unassigned,
            hasTitle: parsed.hasTitle,
            hasRoles: parsed.hasRoles,
            hasEnvType: !!parsed.envType,
            actCode: '',
            pendingActCode: '',
            types: [parsed.envType === 'song' ? 'sang' : 'sketch'],
            open: autoOpen,
          });
        }
      });
    });
    renderImportList();
  });
}

function addManualScene() {
  ensureActOpen('');
  importState.scenes.push({
    key: nextImportKey(),
    fileName: null,
    name: '',
    cast: [],
    unassigned: [],
    hasTitle: true,
    hasRoles: true,
    actCode: '',
    pendingActCode: '',
    types: [],
    open: true,
  });
  renderImportList();
}

// ── Modal open/close ──────────────────────────────────────
function openImportModal() {
  document.getElementById('import-overlay').style.display = 'flex';
  renderImportList();
}

function closeImportModal() {
  document.getElementById('import-overlay').style.display = 'none';
}

// ── Scene type helpers ─────────────────────────────────────
function setSceneType(f, type, checked) {
  if (!checked) {
    f.types = f.types.filter(t => t !== type);
    return;
  }
  if (EXCLUSIVE_TYPES.has(type)) {
    f.types = [type];
  } else if (type === 'dans') {
    f.types = f.types.filter(t => !EXCLUSIVE_TYPES.has(t));
    if (!f.types.includes('dans')) f.types.push('dans');
  } else { // sketch or sang — mutually exclusive with each other and with bandsang/video
    f.types = f.types.filter(t => !EXCLUSIVE_TYPES.has(t) && !BASE_TYPES.has(t));
    f.types.push(type);
  }
}

function isSchedulable(types) {
  return types.length > 0 && !types.some(t => NON_SCHEDULABLE_TYPES.has(t));
}

// ── Drag & drop reordering ──────────────────────────────────
function moveSceneTo(sourceKey, targetActCode, beforeKey) {
  const idx = importState.scenes.findIndex(s => s.key === sourceKey);
  if (idx === -1) return;
  const [item] = importState.scenes.splice(idx, 1);
  item.actCode = targetActCode;
  item.pendingActCode = targetActCode;
  if (beforeKey) {
    let targetIdx = importState.scenes.findIndex(s => s.key === beforeKey);
    if (targetIdx === -1) targetIdx = importState.scenes.length;
    importState.scenes.splice(targetIdx, 0, item);
  } else {
    importState.scenes.push(item);
  }
  renderImportList();
}

// ── Review list rendering ─────────────────────────────────
function renderImportList() {
  const container = document.getElementById('import-list');
  container.innerHTML = '';

  if (!importState.scenes.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.style.padding = '0.75rem';
    empty.textContent = 'Tilføj en scene manuelt eller upload .tex-filer for at komme i gang.';
    container.appendChild(empty);
    return;
  }

  const hasUnplaced = importState.scenes.some(s => s.actCode === '');
  const sections = hasUnplaced ? [UNPLACED_ACT, ...importActs] : importActs;
  sections.forEach(act => container.appendChild(renderActSection(act)));
}

function renderActSection(act) {
  const section = document.createElement('div');
  section.className = 'import-act-section';

  const sceneEntries = importState.scenes.filter(s => s.actCode === act.code);

  const header = document.createElement('div');
  header.className = 'import-act-header';
  header.onclick = () => { act.open = !act.open; renderImportList(); };

  const chevron = document.createElement('span');
  chevron.className = 'import-chevron';
  chevron.textContent = act.open ? '▾' : '▸';
  header.appendChild(chevron);

  const label = document.createElement('span');
  label.className = 'picker-act-label';
  label.textContent = act.label;
  header.appendChild(label);

  const count = document.createElement('span');
  count.className = 'import-act-count';
  count.textContent = sceneEntries.length;
  header.appendChild(count);

  section.appendChild(header);

  if (act.open) {
    sceneEntries.forEach(f => section.appendChild(renderSceneRow(f)));
  }

  section.ondragover = e => { e.preventDefault(); section.classList.add('import-drop-target'); };
  section.ondragleave = () => section.classList.remove('import-drop-target');
  section.ondrop = e => {
    e.preventDefault();
    section.classList.remove('import-drop-target');
    if (manusDragKey) moveSceneTo(manusDragKey, act.code, null);
    manusDragKey = null;
  };

  return section;
}

function renderSceneRow(f) {
  const row = document.createElement('div');
  row.className = 'import-scene';
  row.draggable = !f.open;

  if (!f.open) {
    row.ondragstart = e => { manusDragKey = f.key; e.dataTransfer.effectAllowed = 'move'; };
    row.ondragover = e => { e.preventDefault(); e.stopPropagation(); row.classList.add('import-drop-target'); };
    row.ondragleave = () => row.classList.remove('import-drop-target');
    row.ondrop = e => {
      e.preventDefault();
      e.stopPropagation();
      row.classList.remove('import-drop-target');
      if (manusDragKey && manusDragKey !== f.key) moveSceneTo(manusDragKey, f.actCode, f.key);
      manusDragKey = null;
    };
  }

  const header = document.createElement('div');
  header.className = 'import-scene-header';
  header.onclick = () => {
    if (f.open) {
      f.open = false;
      if (f.pendingActCode !== f.actCode) {
        moveSceneTo(f.key, f.pendingActCode, null); // re-renders; lands at the bottom of the target act
        return;
      }
    } else {
      f.open = true;
    }
    renderImportList();
  };

  if (!f.open) {
    const handle = document.createElement('span');
    handle.className = 'import-drag-handle';
    handle.textContent = '⠿';
    header.appendChild(handle);
  }

  const chevron = document.createElement('span');
  chevron.className = 'import-chevron';
  chevron.textContent = f.open ? '▾' : '▸';
  header.appendChild(chevron);

  const nameEl = document.createElement('span');
  nameEl.className = 'import-scene-name' + (f.name.trim() ? '' : ' import-scene-name-empty');
  nameEl.textContent = f.name.trim() || '(uden navn)';
  header.appendChild(nameEl);

  if (f.types.length) {
    const typeBadge = document.createElement('span');
    typeBadge.className = 'import-type-badge';
    typeBadge.textContent = f.types.map(t => SCENE_TYPE_LABELS[t]).join(', ');
    header.appendChild(typeBadge);
  }

  const removeBtn = document.createElement('button');
  removeBtn.className = 'import-remove-btn';
  removeBtn.textContent = '✕';
  removeBtn.title = 'Fjern scene';
  removeBtn.onclick = e => {
    e.stopPropagation();
    importState.scenes = importState.scenes.filter(x => x.key !== f.key);
    renderImportList();
  };
  header.appendChild(removeBtn);

  row.appendChild(header);
  if (f.open) row.appendChild(renderSceneBody(f));

  return row;
}

function renderSceneBody(f) {
  const body = document.createElement('div');
  body.className = 'import-scene-body';

  if (f.fileName) {
    const fname = document.createElement('div');
    fname.className = 'import-filename';
    fname.textContent = f.fileName;
    body.appendChild(fname);
  }

  if (!f.hasTitle) body.appendChild(importWarning('Ingen \\title fundet — udfyld scenenavn manuelt.'));
  if (!f.hasRoles) body.appendChild(importWarning('Ingen \\begin{roles}-blok fundet — tilføj rollefordeling manuelt.'));
  if (f.fileName && f.hasEnvType === false) body.appendChild(importWarning('Ingen \\begin{sketch}/\\begin{song} fundet — tjek type og rollefordeling manuelt.'));
  if (f.unassigned.length) body.appendChild(importWarning(`Ikke-tildelte rollekoder sprunget over: ${f.unassigned.join(', ')}`));

  const nameRow = document.createElement('div');
  nameRow.className = 'import-namerow';

  const nameField = importTextField('Scenenavn', f.name, v => f.name = v);
  nameField.classList.add('import-namerow-name');
  nameRow.appendChild(nameField);

  const actField = document.createElement('label');
  actField.className = 'field-label import-namerow-act';
  actField.textContent = 'Akt';
  const actSelect = document.createElement('select');
  const unplacedOpt = document.createElement('option');
  unplacedOpt.value = '';
  unplacedOpt.textContent = UNPLACED_ACT.label;
  if (f.pendingActCode === '') unplacedOpt.selected = true;
  actSelect.appendChild(unplacedOpt);
  importActs.forEach(act => {
    const opt = document.createElement('option');
    opt.value = act.code;
    opt.textContent = act.label;
    if (act.code === f.pendingActCode) opt.selected = true;
    actSelect.appendChild(opt);
  });
  actSelect.onchange = () => { f.pendingActCode = actSelect.value; };
  actField.appendChild(actSelect);
  nameRow.appendChild(actField);

  body.appendChild(nameRow);

  // Scene types
  const typeRow = document.createElement('div');
  typeRow.className = 'import-type-row';
  SCENE_TYPES.forEach(type => {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'import-type-pill' + (f.types.includes(type) ? ' active' : '');
    pill.textContent = SCENE_TYPE_LABELS[type];
    pill.onclick = () => { setSceneType(f, type, !f.types.includes(type)); renderImportList(); };
    typeRow.appendChild(pill);
  });
  body.appendChild(typeRow);

  // Cast rows
  const castHeader = document.createElement('div');
  castHeader.className = 'import-cast-header';
  castHeader.textContent = 'Rollefordeling';
  body.appendChild(castHeader);

  const castList = document.createElement('div');
  castList.className = 'import-cast-list';
  f.cast.forEach((c, ci) => {
    const cRow = document.createElement('div');
    cRow.className = 'import-cast-row';

    const codeSelect = document.createElement('select');
    codeSelect.className = 'import-cast-code';
    const placeholderOpt = document.createElement('option');
    placeholderOpt.value = '';
    placeholderOpt.textContent = 'Vælg rolle…';
    placeholderOpt.disabled = true;
    if (!c.code) placeholderOpt.selected = true;
    codeSelect.appendChild(placeholderOpt);
    ROLE_CATEGORIES.forEach(cat => {
      const opt = document.createElement('option');
      opt.value = cat;
      opt.textContent = cat;
      if (c.code === cat) opt.selected = true;
      codeSelect.appendChild(opt);
    });
    codeSelect.onchange = () => { c.code = codeSelect.value; };

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.value = c.name;
    nameInput.placeholder = 'Navn';
    nameInput.className = 'import-cast-name';
    nameInput.oninput = () => { c.name = nameInput.value; };

    const rmBtn = document.createElement('button');
    rmBtn.className = 'import-remove-btn';
    rmBtn.textContent = '✕';
    rmBtn.onclick = () => { f.cast.splice(ci, 1); renderImportList(); };

    cRow.appendChild(codeSelect);
    cRow.appendChild(nameInput);
    cRow.appendChild(rmBtn);
    castList.appendChild(cRow);
  });
  body.appendChild(castList);

  const addCastBtn = document.createElement('button');
  addCastBtn.className = 'btn-secondary import-add-cast-btn';
  addCastBtn.textContent = '+ Tilføj rolle';
  addCastBtn.onclick = () => { f.cast.push({ code: '', name: '' }); renderImportList(); };
  body.appendChild(addCastBtn);

  return body;
}

function importWarning(text) {
  const w = document.createElement('div');
  w.className = 'import-warning';
  w.textContent = '⚠ ' + text;
  return w;
}

function importTextField(labelText, value, onChange) {
  const label = document.createElement('label');
  label.className = 'field-label';
  label.textContent = labelText;
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value;
  input.oninput = () => onChange(input.value);
  label.appendChild(input);
  return label;
}

// ── Apply: merge into current data + save ──────────────────
function applyImport() {
  if (!importState.scenes.length) { alert('Ingen scener at opdatere.'); return; }

  for (const f of importState.scenes) {
    const label = f.name.trim() || f.fileName || '(uden navn)';
    if (!f.name.trim()) { alert(`Udfyld scenenavn for "${label}" før du kan opdatere.`); return; }
    if (!f.types.length) { alert(`Vælg mindst én type for "${label}" før du kan opdatere.`); return; }
    if (f.actCode === '') { alert(`Placér "${label}" i en akt (træk den ud af "Ikke placeret") før du kan opdatere.`); return; }
  }

  const castRoster = getEffectiveCastData().map(c => ({ name: c.name, index: c.index }));
  const castNameSet = new Set(castRoster.map(c => c.name));
  function ensureCastMember(name) {
    if (!castNameSet.has(name)) {
      castNameSet.add(name);
      castRoster.push({ name, index: castRoster.length });
    }
  }

  const scenes = [];
  for (const act of importActs) {
    const sceneEntries = importState.scenes.filter(s => s.actCode === act.code);
    sceneEntries.forEach((f, idx) => {
      const number = idx + 1;
      const castList = f.cast
        .filter(c => c.name.trim() && c.code.trim())
        .map(c => ({ name: c.name.trim(), role: c.code.trim() }));
      castList.forEach(c => ensureCastMember(c.name));

      scenes.push({
        id: `${act.code}-${number}`,
        number,
        name: f.name.trim(),
        duration_minutes: 0,
        schedulable: isSchedulable(f.types),
        priority: 0,
        types: f.types.slice(),
        cast: castList,
        actLabel: act.label,
      });
    });
  }

  castRoster.forEach((c, i) => c.index = i);

  localStorage.setItem(MANUS_OVERRIDE_KEY, JSON.stringify({ scenes, cast: castRoster }));
  location.reload();
}
