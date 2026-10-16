/* =========================================================
   Matematikrevyen – Ninjas, Mics & Cues (ninjas.html)

   Three tabs, styled like Bandet's:
   - Ninjaplan: placeholder until the plan exists.
   - Mikrofonplan: replaces the old Mic-plan spreadsheet — one row per
     scene (grouped by act), one column per mic (name, tape label, colour),
     a cell = who wears it (a name, "X", …).
   - Cues: replaces the old Cueark — per scene Instruktør, Start cue,
     Giver cue, Slut cue, Bemærkninger; each instructor gets their own
     colour automatically.

   Rows come from Manus (SCENES_DATA, or a fresh Manus save's override),
   keyed by the scene's permanent uid, so a cell follows its scene when it
   is moved or renamed. Extra rows (Bandintro, …) are added by hand per act
   and shown in both tabs. Everything lives in the private NINJAS_DATA_DIR
   store via authenticated ninjas_* actions, always for the current
   production.

   Any revyst can edit, behind the Rediger/Færdig toggle top-right. Live
   writes like Fællesspisning: a cell commits on blur/Enter, one cell per
   request, so several people can edit at once.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helpers (mirror band.js's own) ─────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// Second-level button, for buttons inside a modal overlay only.
function ninjasPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

function ninjasAddPlusBtn(title) {
  const btn = el('button', 'boss-manage-add-plus', '+');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

// ── Authenticated API (mirrors band.js's bandApi) ────────────
function ninjasResolvePassword() {
  const auth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  if (auth && auth.password) return auth.password;
  let pin = '';
  try { pin = sessionStorage.getItem('matrevy-manus-pin') || ''; } catch (e) { /* ignore */ }
  if (!pin) {
    pin = (prompt('Indtast adgangskoden:') || '').trim();
    if (!pin) return null;
  }
  return pin;
}

function ninjasMapError(status, detail) {
  if (detail === 'no_production') return 'Der er ingen aktiv revy lige nu.';
  if (detail === 'stale_mics') return 'Mikrofonerne er blevet ændret af en anden — siden er opdateret.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  return detail ? `Serverfejl: ${detail}` : `Serverfejl (${status}). Prøv igen senere.`;
}

async function ninjasApi(action, body) {
  const password = ninjasResolvePassword();
  if (!password) return { ok: false, status: 0, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...(body || {}) }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  // Require a real {ok:true} JSON body — a PHP fatal or WAF page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, detail, message: ninjasMapError(res.status, detail) };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, detail, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── State ────────────────────────────────────────────────────
const NINJAS_TABS = [
  { key: 'ninjaplan', label: 'Ninjaplan' },
  { key: 'mikrofonplan', label: 'Mikrofonplan' },
  { key: 'cues', label: 'Cues' },
];
const NINJAS_TAB_KEY = 'matrevy-ninjas-tab';
let ninjasActiveTab = (() => {
  let stored = '';
  try { stored = localStorage.getItem(NINJAS_TAB_KEY) || ''; } catch (e) { /* ignore */ }
  return NINJAS_TABS.some((t) => t.key === stored) ? stored : 'mikrofonplan';
})();

// Mic colours (the old sheet's column fills). Mirrors ninjas_colors() in
// update-data.php.
const NINJAS_COLORS = [
  { key: 'yellow', label: 'Gul' },
  { key: 'red', label: 'Rød' },
  { key: 'green', label: 'Grøn' },
  { key: 'blue', label: 'Blå' },
  { key: 'cream', label: 'Lysegul' },
  { key: 'rose', label: 'Lyserød' },
  { key: 'mint', label: 'Lysegrøn' },
  { key: 'sky', label: 'Lyseblå' },
  { key: 'orange', label: 'Orange' },
  { key: 'brown', label: 'Brun' },
  { key: 'purple', label: 'Lilla' },
  { key: 'grey', label: 'Grå' },
];

// Mirrors ninjas_cue_fields() in update-data.php.
const NINJAS_CUE_COLUMNS = [
  { key: 'instruktoer', label: 'Instruktør' },
  { key: 'startCue', label: 'Start cue', suggestions: ['Lys', 'Band', 'Lyd', 'AV'] },
  { key: 'giverCue', label: 'Giver cue' },
  { key: 'slutCue', label: 'Slut cue' },
  { key: 'note', label: 'Bemærkninger' },
];
const NINJAS_INSTRUCTOR_COLORS = 8; // .ninjas-instr-0 … -7 in ninjas.css

let ninjasEditing = false;
let ninjasDoc = null; // {mics, micCells, cues, extraRows} once loaded
let ninjasDragMicId = null;
// Cell commits not yet confirmed by the server: cellId → value. Re-applied
// over a full-document response so an in-flight edit never flickers back.
const ninjasPending = new Map();
const ninjasCellChains = new Map(); // cellId → promise (commits per cell run in order)

function ninjasNorm(s) {
  return String(s || '').trim().toLocaleLowerCase('da');
}

// ── Scenes → rows ────────────────────────────────────────────
// A scene's permanent key — same as manus.js's manusSceneUid().
function ninjasSceneKey(scene) {
  return scene.uid || `id:${scene.id}`;
}

function ninjasActCode(scene) {
  return String(scene.id || '').split('-')[0] || '?';
}

function ninjasActLabel(act) {
  return act === 'E' ? 'Ekstranumre' : `Akt ${act}`;
}

// Below boss nothing is listed until Manus's "Revyster kan se manus" is
// on — same (cosmetic) gate as Øveplan's schedManusVisible().
function ninjasManusVisible() {
  if (siteHasLevel('boss')) return true;
  const config = siteLoadOverride('config') || (typeof CONFIG_DATA !== 'undefined' ? CONFIG_DATA : {});
  return !!config.pdfLinksVisibleToRevyst;
}

// A fresh Manus save in this browser wins over the embed (as on Øveplan).
function ninjasScenes() {
  const override = siteLoadOverride('manus');
  if (override && Array.isArray(override.scenes)) return override.scenes;
  return (typeof SCENES_DATA !== 'undefined' && Array.isArray(SCENES_DATA)) ? SCENES_DATA : [];
}

function ninjasCastNames(scene) {
  const names = [];
  for (const member of scene.cast || []) {
    const name = member && typeof member.name === 'string' ? member.name.trim() : '';
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

// [{act, label, rows:[{key, title, cast, extra?}]}], in Manus's act order,
// with the extra rows spliced in after their afterKey (null = first in the
// act; an unknown afterKey = last in the act).
function ninjasBuildGroups() {
  const groups = [];
  const byAct = new Map();
  function group(act, label) {
    if (!byAct.has(act)) {
      const g = { act, label: label || ninjasActLabel(act), rows: [] };
      byAct.set(act, g);
      groups.push(g);
    }
    return byAct.get(act);
  }
  for (const scene of ninjasScenes()) {
    const act = ninjasActCode(scene);
    if (act === 'pool') continue; // Manus's reserved pseudo-act
    group(act, scene.actLabel).rows.push({
      key: ninjasSceneKey(scene),
      title: scene.name || scene.title || 'Unavngivet scene',
      cast: ninjasCastNames(scene),
    });
  }
  const extras = (ninjasDoc ? ninjasDoc.extraRows : []).map((x) => ({
    key: `x${x.id}`, title: x.title, cast: [], extra: x,
  }));
  for (const row of extras) group(row.extra.act);
  for (const g of groups) {
    let pending = extras.filter((r) => r.extra.act === g.act);
    // Several passes, since an extra row can sit after another extra row.
    for (let pass = 0; pending.length && pass <= extras.length; pass++) {
      pending = pending.filter((row) => {
        const after = row.extra.afterKey;
        let pos;
        if (after == null) {
          pos = 0;
        } else {
          const idx = g.rows.findIndex((r) => r.key === after);
          if (idx === -1) return true; // not placed yet — maybe next pass
          pos = idx + 1;
        }
        // Keep creation order among rows placed after the same spot.
        while (pos < g.rows.length && g.rows[pos].extra && (g.rows[pos].extra.afterKey ?? null) === (after ?? null)) pos++;
        g.rows.splice(pos, 0, row);
        return false;
      });
    }
    g.rows.push(...pending); // afterKey gone (scene removed from Manus)
  }
  return groups;
}

// ── Load + render ────────────────────────────────────────────
function ninjasRoot() {
  return document.getElementById('ninjas-root');
}

function ninjasMessageCard(text, isError) {
  const card = el('section', 'card');
  card.appendChild(el('p', isError ? 'ninjas-error' : 'ninjas-muted', text));
  return card;
}

async function ninjasLoad() {
  const root = ninjasRoot();
  if (ninjasActiveTab === 'ninjaplan' || !ninjasManusVisible()) {
    ninjasRender();
    return;
  }
  if (ninjasDoc) {
    ninjasRender(); // the new tab right away; refreshed once the read lands
  } else {
    root.replaceChildren();
    ninjasRenderTabs(root);
    root.appendChild(el('p', 'ninjas-muted', 'Indlæser…'));
  }
  const result = await ninjasApi('ninjas_read', {});
  if (!result.ok) {
    ninjasDoc = null;
    root.replaceChildren();
    ninjasRenderTabs(root);
    root.appendChild(ninjasMessageCard(result.message || 'Kunne ikke indlæse planen.', result.detail !== 'no_production'));
    ninjasUpdateEditButton();
    return;
  }
  ninjasApplyDoc(result.data);
  ninjasRender();
}

function ninjasApplyDoc(data) {
  // An empty PHP map can arrive as [] — always keep plain objects.
  const obj = (v) => (v && !Array.isArray(v) && typeof v === 'object') ? v : {};
  ninjasDoc = {
    mics: Array.isArray(data.mics) ? data.mics : [],
    micCells: obj(data.micCells),
    cues: obj(data.cues),
    extraRows: Array.isArray(data.extraRows) ? data.extraRows : [],
  };
  for (const [cellId, value] of ninjasPending) ninjasSetLocal(cellId, value);
}

function ninjasRender() {
  const root = ninjasRoot();
  root.replaceChildren();
  ninjasRenderTabs(root);
  if (ninjasActiveTab === 'ninjaplan') {
    const card = el('section', 'card');
    card.appendChild(el('h2', null, 'Ninjaplan'));
    card.appendChild(el('p', 'ninjas-muted', 'Ninjaplanen kommer snart.'));
    root.appendChild(card);
  } else if (!ninjasManusVisible()) {
    root.appendChild(ninjasMessageCard('Manus er ikke frigivet endnu.'));
  } else if (ninjasDoc) {
    const groups = ninjasBuildGroups();
    if (!groups.length) {
      root.appendChild(ninjasMessageCard('Der er ingen scener i Manus endnu.'));
    } else if (ninjasActiveTab === 'cues') {
      root.appendChild(ninjasBuildCuesCard(groups));
    } else {
      root.appendChild(ninjasBuildMicCard(groups));
    }
  }
  ninjasUpdateEditButton();
  for (const ta of root.querySelectorAll('.ninjas-autogrow')) ninjasAutogrow(ta);
}

// Styled like Bandet's page tabs (.band-mode-tabs, duplicated as
// .ninjas-mode-tabs in ninjas.css).
function ninjasRenderTabs(root) {
  const tabs = el('div', 'ninjas-mode-tabs');
  for (const tab of NINJAS_TABS) {
    const btn = el('button', 'ninjas-mode-tab' + (tab.key === ninjasActiveTab ? ' active' : ''), tab.label);
    btn.type = 'button';
    btn.addEventListener('click', () => {
      if (tab.key === ninjasActiveTab) return;
      siteCloseFieldPopup();
      ninjasActiveTab = tab.key;
      try { localStorage.setItem(NINJAS_TAB_KEY, ninjasActiveTab); } catch (e) { /* ignore */ }
      // Re-read so each tab shows what others saved meanwhile.
      ninjasLoad();
    });
    tabs.appendChild(btn);
  }
  root.appendChild(tabs);
}

// The Rediger/Færdig toggle top-right: only where there's a sheet to edit.
function ninjasUpdateEditButton() {
  const btn = document.getElementById('ninjas-edit-btn');
  if (!btn) return;
  btn.hidden = !(ninjasDoc && ninjasActiveTab !== 'ninjaplan' && ninjasManusVisible());
  btn.textContent = ninjasEditing ? 'Færdig' : 'Rediger';
  btn.classList.toggle('ninjas-edit-active', ninjasEditing);
}

function ninjasToggleEditing() {
  // Commit whatever is being typed (its blur fires before the re-render).
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  siteCloseFieldPopup();
  ninjasEditing = !ninjasEditing;
  ninjasRender();
}

// ── Cell commits (shared by both sheets) ─────────────────────
// cellId = 'mic|<rowKey>|<micId>' or 'cue|<rowKey>|<field>'.
function ninjasGetLocal(cellId) {
  const [kind, rowKey, key] = cellId.split('|');
  const map = kind === 'mic' ? ninjasDoc.micCells : ninjasDoc.cues;
  return (map[rowKey] && map[rowKey][key]) || '';
}

function ninjasSetLocal(cellId, value) {
  const [kind, rowKey, key] = cellId.split('|');
  const map = kind === 'mic' ? ninjasDoc.micCells : ninjasDoc.cues;
  if (value.trim() === '') {
    if (map[rowKey]) {
      delete map[rowKey][key];
      if (!Object.keys(map[rowKey]).length) delete map[rowKey];
    }
  } else {
    if (!map[rowKey] || Array.isArray(map[rowKey])) map[rowKey] = {};
    map[rowKey][key] = value;
  }
}

// Commits one cell if it changed; onSettled(ok) runs after the server
// answered (also used to repaint tints/warnings right away).
function ninjasCommitCell(cellId, value, onLocalChange) {
  if (value === ninjasGetLocal(cellId)) return;
  const previous = ninjasGetLocal(cellId);
  ninjasSetLocal(cellId, value);
  ninjasPending.set(cellId, value);
  if (onLocalChange) onLocalChange();
  const [kind, rowKey, key] = cellId.split('|');
  const prior = ninjasCellChains.get(cellId) || Promise.resolve();
  const run = prior.then(async () => {
    const result = kind === 'mic'
      ? await ninjasApi('ninjas_set_mic_cell', { rowKey, micId: key, value })
      : await ninjasApi('ninjas_set_cue', { rowKey, field: key, value });
    if (ninjasPending.get(cellId) === value) ninjasPending.delete(cellId);
    if (result.ok) return;
    if (result.message) siteShowToast(result.message);
    if (result.status === 409) {
      ninjasPending.delete(cellId);
      ninjasLoad();
      return;
    }
    // Put the old value back unless a newer edit is already queued.
    if (!ninjasPending.has(cellId)) {
      ninjasSetLocal(cellId, previous);
      ninjasRender();
    }
  });
  ninjasCellChains.set(cellId, run);
}

// Enter commits (Shift+Enter = new line in a textarea).
function ninjasWireCommitKeys(input) {
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      input.blur();
    }
  });
}

function ninjasAutogrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight + 2}px`;
}

// ── Suggestion popup ─────────────────────────────────────────
// A filtered list under a cell input (the shared .site-field-pop chrome).
// getOptions() is re-evaluated on every keystroke; picking a row fills the
// input and commits it via onPick.
function ninjasWireSuggestions(input, getOptions, onPick) {
  let active = -1;
  let rows = [];

  function close() {
    if (siteFieldPopupAnchor === input) siteCloseFieldPopup();
    rows = [];
    active = -1;
  }

  function paintActive() {
    rows.forEach((r, i) => r.classList.toggle('site-list-selected', i === active));
    if (rows[active]) rows[active].scrollIntoView({ block: 'nearest' });
  }

  function open() {
    const typed = ninjasNorm(input.value);
    const options = getOptions().filter((opt) => {
      const norm = ninjasNorm(opt);
      return norm !== typed && (typed === '' || norm.includes(typed));
    });
    if (!options.length) { close(); return; }
    const pop = el('div', 'site-field-pop site-dd-pop ninjas-suggest-pop');
    // Keep focus in the input, so no half-typed blur commit fires first.
    pop.addEventListener('mousedown', (e) => e.preventDefault());
    rows = options.map((opt) => {
      const row = el('button', 'site-list-row', opt);
      row.type = 'button';
      row.tabIndex = -1;
      row.addEventListener('click', () => pick(opt));
      pop.appendChild(row);
      return row;
    });
    active = -1;
    siteOpenFieldPopup(input, pop);
  }

  function pick(opt) {
    close();
    input.value = opt;
    if (input.tagName === 'TEXTAREA') ninjasAutogrow(input);
    onPick(opt);
  }

  input.addEventListener('focus', open);
  input.addEventListener('input', open);
  input.addEventListener('blur', close);
  input.addEventListener('keydown', (e) => {
    if (!rows.length) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const n = rows.length;
      active = e.key === 'ArrowDown' ? (active + 1) % n : (active - 1 + n) % n;
      paintActive();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      e.stopImmediatePropagation(); // not also the plain Enter-commits handler
      pick(rows[active].textContent);
    }
  });
}

// ── Act heading row (both sheets) ────────────────────────────
function ninjasActRow(group, colSpan) {
  const tr = el('tr', 'ninjas-act-row');
  const td = el('td');
  td.colSpan = colSpan;
  const inner = el('div', 'ninjas-act-inner');
  inner.appendChild(el('span', 'ninjas-act-label', group.label));
  if (ninjasEditing) {
    const plus = ninjasAddPlusBtn(`Tilføj en ekstra række i ${group.label}`);
    plus.classList.add('ninjas-act-plus');
    plus.addEventListener('click', () => ninjasOpenExtraRowModal(group, null));
    inner.appendChild(plus);
  }
  td.appendChild(inner);
  tr.appendChild(td);
  return tr;
}

// The scene-title cell (sticky first column). An extra row's title opens
// its editor in edit mode.
function ninjasTitleCell(group, row) {
  const td = el('td', 'ninjas-col-title' + (row.extra ? ' ninjas-extra-title' : ''));
  if (row.extra && ninjasEditing) {
    const btn = el('button', 'ninjas-extra-btn', row.title);
    btn.type = 'button';
    btn.title = 'Rediger den ekstra række';
    btn.addEventListener('click', () => ninjasOpenExtraRowModal(group, row));
    td.appendChild(btn);
  } else {
    td.textContent = row.title;
    if (row.extra) td.title = 'Ekstra række (ikke fra Manus)';
  }
  return td;
}

// ── Mikrofonplan ─────────────────────────────────────────────
function ninjasBuildMicCard(groups) {
  const card = el('section', 'card ninjas-sheet-card');
  card.appendChild(el('h2', null, 'Mikrofonplan'));
  const wrap = el('div', 'ninjas-table-wrap');
  const table = el('table', 'ninjas-table ninjas-mic-table' + (ninjasEditing ? ' ninjas-editing' : ''));
  const mics = ninjasDoc.mics;

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'ninjas-col-title', 'Nummer'));
  for (const mic of mics) headRow.appendChild(ninjasMicHeader(mic));
  if (ninjasEditing) {
    const th = el('th', 'ninjas-col-add');
    const plus = ninjasAddPlusBtn('Tilføj mikrofon');
    plus.addEventListener('click', () => ninjasOpenMicModal(null));
    th.appendChild(plus);
    ninjasWireMicDrop(th, null); // drop tail: move to the end
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const colSpan = 1 + mics.length + (ninjasEditing ? 1 : 0);
  const tbody = el('tbody');
  for (const group of groups) {
    tbody.appendChild(ninjasActRow(group, colSpan));
    for (const row of group.rows) tbody.appendChild(ninjasMicRow(group, row));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  if (!mics.length) {
    card.appendChild(el('p', 'ninjas-muted', ninjasEditing
      ? 'Ingen mikrofoner endnu — tilføj en med +.'
      : 'Ingen mikrofoner endnu — tryk Rediger for at tilføje.'));
  }
  return card;
}

function ninjasMicHeader(mic) {
  const th = el('th', `ninjas-mic-head ninjas-color-${mic.color}`);
  th.appendChild(el('div', 'ninjas-mic-name', mic.name));
  if (mic.label) th.appendChild(el('div', 'ninjas-mic-label', mic.label));
  if (!ninjasEditing) return th;
  th.classList.add('ninjas-mic-head-editable');
  th.tabIndex = 0;
  th.title = 'Klik for at redigere — træk for at flytte';
  th.setAttribute('role', 'button');
  th.addEventListener('click', () => ninjasOpenMicModal(mic));
  th.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ninjasOpenMicModal(mic); }
  });
  th.draggable = true;
  th.addEventListener('dragstart', (e) => {
    ninjasDragMicId = mic.id;
    const ghost = ninjasGetDragImageEl();
    ghost.textContent = mic.name;
    e.dataTransfer.setDragImage(ghost, 12, 16);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', mic.name);
    th.classList.add('ninjas-dragging');
  });
  th.addEventListener('dragend', () => {
    ninjasDragMicId = null;
    th.classList.remove('ninjas-dragging');
  });
  ninjasWireMicDrop(th, mic.id);
  return th;
}

// Shared, off-screen drag ghost (the drag-image convention).
function ninjasGetDragImageEl() {
  let ghost = document.getElementById('ninjas-drag-image');
  if (!ghost) {
    ghost = el('div', 'ninjas-drag-image');
    ghost.id = 'ninjas-drag-image';
    document.body.appendChild(ghost);
  }
  return ghost;
}

// A header is a drop target that inserts the dragged mic *before* it;
// beforeId null = the trailing "+" cell (move to the end).
function ninjasWireMicDrop(th, beforeId) {
  let depth = 0;
  th.addEventListener('dragenter', (e) => {
    if (!ninjasDragMicId) return;
    e.preventDefault();
    depth++;
    th.classList.add('ninjas-drop-target');
  });
  th.addEventListener('dragover', (e) => {
    if (ninjasDragMicId) e.preventDefault(); // required for 'drop' to fire at all
  });
  th.addEventListener('dragleave', () => {
    if (!ninjasDragMicId) return;
    depth = Math.max(0, depth - 1);
    if (!depth) th.classList.remove('ninjas-drop-target');
  });
  th.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    th.classList.remove('ninjas-drop-target');
    const dragId = ninjasDragMicId;
    ninjasDragMicId = null;
    if (!dragId || dragId === beforeId) return;
    const mics = ninjasDoc.mics.slice();
    const from = mics.findIndex((m) => m.id === dragId);
    if (from === -1) return;
    const [moved] = mics.splice(from, 1);
    const to = beforeId == null ? mics.length : mics.findIndex((m) => m.id === beforeId);
    mics.splice(to === -1 ? mics.length : to, 0, moved);
    if (mics.every((m, i) => m.id === ninjasDoc.mics[i].id)) return;
    ninjasSaveMics(mics);
  });
}

function ninjasMicRow(group, row) {
  const tr = el('tr', 'ninjas-row');
  tr.appendChild(ninjasTitleCell(group, row));
  const cells = [];
  for (const mic of ninjasDoc.mics) {
    const cellId = `mic|${row.key}|${mic.id}`;
    const td = el('td', `ninjas-mic-cell ninjas-color-${mic.color}`);
    cells.push({ td, cellId });
    if (!ninjasEditing) {
      td.textContent = ninjasGetLocal(cellId);
      tr.appendChild(td);
      continue;
    }
    const input = el('input', 'ninjas-field');
    input.type = 'text';
    input.maxLength = 200;
    input.value = ninjasGetLocal(cellId);
    input.setAttribute('aria-label', `${mic.name} — ${row.title}`);
    const commit = () => ninjasCommitCell(cellId, input.value, () => ninjasPaintMicRow(row, cells));
    input.addEventListener('change', commit);
    // The scene's cast, minus whoever already has a mic in this row.
    ninjasWireSuggestions(input, () => {
      const used = new Set(cells.filter((c) => c.cellId !== cellId).map((c) => ninjasNorm(ninjasGetLocal(c.cellId))));
      return row.cast.filter((name) => !used.has(ninjasNorm(name)));
    }, commit);
    ninjasWireCommitKeys(input);
    td.appendChild(input);
    tr.appendChild(td);
  }
  if (ninjasEditing) tr.appendChild(el('td', 'ninjas-col-add'));
  ninjasPaintMicRow(row, cells);
  return tr;
}

// Tints filled cells and flags a cast member on two mics in one scene.
function ninjasPaintMicRow(row, cells) {
  const castNorm = new Set(row.cast.map(ninjasNorm));
  const counts = new Map();
  for (const { cellId } of cells) {
    const norm = ninjasNorm(ninjasGetLocal(cellId));
    if (castNorm.has(norm)) counts.set(norm, (counts.get(norm) || 0) + 1);
  }
  for (const { td, cellId } of cells) {
    const value = ninjasGetLocal(cellId);
    const norm = ninjasNorm(value);
    const warn = (counts.get(norm) || 0) > 1;
    td.classList.toggle('ninjas-filled', value.trim() !== '');
    td.classList.toggle('ninjas-cell-warn', warn);
    td.title = warn ? `${value.trim()} har to mikrofoner i denne scene` : '';
  }
}

async function ninjasSaveMics(mics) {
  const result = await ninjasApi('ninjas_save_mics', { mics });
  if (!result.ok) {
    if (result.message) siteShowToast(result.message);
    return result.message || '';
  }
  ninjasApplyDoc(result.data);
  ninjasRender();
  return null;
}

// Colour swatches, like Gantt's — the chosen one gets the orange ring.
function ninjasBuildSwatches(initial) {
  let color = initial;
  const swatches = el('div', 'ninjas-swatches');
  swatches.setAttribute('role', 'radiogroup');
  swatches.setAttribute('aria-label', 'Farve');
  function paint() {
    swatches.replaceChildren();
    for (const c of NINJAS_COLORS) {
      const sw = el('button', `ninjas-swatch ninjas-color-${c.key}` + (c.key === color ? ' ninjas-swatch-selected' : ''));
      sw.type = 'button';
      sw.title = c.label;
      sw.setAttribute('role', 'radio');
      sw.setAttribute('aria-checked', c.key === color ? 'true' : 'false');
      sw.setAttribute('aria-label', c.label);
      sw.addEventListener('click', () => { color = c.key; paint(); swatches.querySelector('.ninjas-swatch-selected').focus(); });
      swatches.appendChild(sw);
    }
  }
  paint();
  Object.defineProperty(swatches, 'value', { get() { return color; } });
  return swatches;
}

function ninjasOpenMicModal(mic) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose(mic ? 'Rediger mikrofon' : 'Ny mikrofon');
  modal.classList.add('ninjas-modal');
  const name = el('input');
  name.type = 'text';
  name.maxLength = 60;
  name.value = mic ? mic.name : `Mikrofon ${ninjasDoc.mics.length + 1}`;
  const label = el('input');
  label.type = 'text';
  label.maxLength = 60;
  label.placeholder = 'f.eks. Gul/Hvid';
  label.value = mic ? mic.label || '' : '';
  // A new mic gets the first colour not in use yet.
  const usedColors = new Set(ninjasDoc.mics.map((m) => m.color));
  const firstFree = (NINJAS_COLORS.find((c) => !usedColors.has(c.key)) || NINJAS_COLORS[0]).key;
  const swatches = ninjasBuildSwatches(mic ? mic.color : firstFree);
  form.appendChild(siteEditField('Navn', name));
  form.appendChild(siteEditField('Mærkat (valgfri)', label));
  form.appendChild(siteEditField('Farve', swatches));

  actions.classList.add('ninjas-modal-actions');
  if (mic) {
    const del = ninjasPillBtn('Slet', 'site-btn-danger');
    del.addEventListener('click', () => {
      const used = Object.values(ninjasDoc.micCells).filter((cells) => cells && cells[mic.id]).length;
      ninjasConfirm('Slet mikrofonen?',
        used ? `${mic.name} er sat på ${used} ${used === 1 ? 'scene' : 'scener'}, som bliver ryddet.` : `${mic.name} fjernes fra planen.`,
        'Slet', async () => {
          const message = await ninjasSaveMics(ninjasDoc.mics.filter((m) => m.id !== mic.id));
          if (message !== null) return false;
          close();
          return true;
        });
    });
    actions.appendChild(del);
  }
  const save = ninjasPillBtn('Gem', 'site-btn-success');
  save.addEventListener('click', async () => {
    error.textContent = '';
    const nextName = name.value.trim();
    if (!nextName) { error.textContent = 'Mikrofonen skal have et navn.'; return; }
    const next = { name: nextName, label: label.value.trim(), color: swatches.value };
    const mics = mic
      ? ninjasDoc.mics.map((m) => (m.id === mic.id ? { ...m, ...next } : m))
      : [...ninjasDoc.mics, next];
    save.disabled = true;
    const message = await ninjasSaveMics(mics);
    save.disabled = false;
    if (message !== null) { error.textContent = message; return; }
    close();
  });
  actions.appendChild(save);
  name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
  name.focus();
  name.select();
}

function ninjasConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('ninjas-confirm-modal');
  if (description) form.appendChild(el('p', 'ninjas-confirm-text', description));
  const cancelBtn = ninjasPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = ninjasPillBtn(confirmLabel, 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const ok = await onConfirm();
    if (ok === false) { confirmBtn.disabled = false; return; }
    close();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Cues ─────────────────────────────────────────────────────
function ninjasBuildCuesCard(groups) {
  const card = el('section', 'card ninjas-sheet-card');
  card.appendChild(el('h2', null, 'Cues'));
  const wrap = el('div', 'ninjas-table-wrap');
  const table = el('table', 'ninjas-table ninjas-cue-table' + (ninjasEditing ? ' ninjas-editing' : ''));

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'ninjas-col-title', 'Nummer'));
  for (const col of NINJAS_CUE_COLUMNS) headRow.appendChild(el('th', `ninjas-cue-col-${col.key}`, col.label));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  const instrCells = [];
  for (const group of groups) {
    tbody.appendChild(ninjasActRow(group, 1 + NINJAS_CUE_COLUMNS.length));
    for (const row of group.rows) tbody.appendChild(ninjasCueRow(group, row, instrCells));
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
  ninjasPaintInstructors(instrCells);
  return card;
}

function ninjasCueRow(group, row, instrCells) {
  const tr = el('tr', 'ninjas-row');
  tr.appendChild(ninjasTitleCell(group, row));
  for (const col of NINJAS_CUE_COLUMNS) {
    const cellId = `cue|${row.key}|${col.key}`;
    const td = el('td', `ninjas-cue-cell ninjas-cue-col-${col.key}`);
    if (col.key === 'instruktoer') instrCells.push({ td, cellId });
    if (!ninjasEditing) {
      td.textContent = ninjasGetLocal(cellId);
      tr.appendChild(td);
      continue;
    }
    const ta = el('textarea', 'ninjas-field ninjas-autogrow');
    ta.rows = 1;
    ta.maxLength = 1000;
    ta.value = ninjasGetLocal(cellId);
    ta.setAttribute('aria-label', `${col.label} — ${row.title}`);
    ta.addEventListener('input', () => ninjasAutogrow(ta));
    const commit = () => ninjasCommitCell(cellId, ta.value,
      col.key === 'instruktoer' ? () => ninjasPaintInstructors(instrCells) : null);
    ta.addEventListener('change', commit);
    if (col.key === 'instruktoer') {
      // Instructors already on the sheet.
      ninjasWireSuggestions(ta, () => ninjasDistinctValues('instruktoer'), commit);
    } else if (col.suggestions) {
      ninjasWireSuggestions(ta, () => col.suggestions, commit);
    }
    ninjasWireCommitKeys(ta);
    td.appendChild(ta);
    tr.appendChild(td);
  }
  return tr;
}

function ninjasDistinctValues(field) {
  const seen = new Map();
  for (const cues of Object.values(ninjasDoc.cues)) {
    const value = cues && typeof cues[field] === 'string' ? cues[field].trim() : '';
    if (value && !seen.has(ninjasNorm(value))) seen.set(ninjasNorm(value), value);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b, 'da'));
}

// Each distinct instructor gets the next colour, in order of first
// appearance down the sheet (the old Cueark's per-person colouring).
function ninjasPaintInstructors(cells) {
  const order = new Map();
  for (const { td, cellId } of cells) {
    const norm = ninjasNorm(ninjasGetLocal(cellId));
    for (let i = 0; i < NINJAS_INSTRUCTOR_COLORS; i++) td.classList.remove(`ninjas-instr-${i}`);
    if (!norm) continue;
    if (!order.has(norm)) order.set(norm, order.size % NINJAS_INSTRUCTOR_COLORS);
    td.classList.add(`ninjas-instr-${order.get(norm)}`);
  }
}

// ── Extra rows (Bandintro, …) ────────────────────────────────
// row null = a new extra row in this act.
function ninjasOpenExtraRowModal(group, row) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose(row ? 'Rediger ekstra række' : `Ny række i ${group.label}`);
  modal.classList.add('ninjas-modal');
  const title = el('input');
  title.type = 'text';
  title.maxLength = 120;
  title.placeholder = 'f.eks. Bandintro';
  title.value = row ? row.title : '';
  // Placement: first in the act, or after any other row of the act (not
  // itself, and not a row that sits after it).
  const ownKey = row ? row.key : null;
  const options = [{ value: '', label: 'Først i akten' }];
  for (const r of group.rows) {
    if (r.key === ownKey || (ownKey && r.extra && r.extra.afterKey === ownKey)) continue;
    options.push({ value: r.key, label: `Efter ${r.title}` });
  }
  const initial = row ? (row.extra.afterKey || '') : '';
  const placement = siteCreateDropdownField(options, options.some((o) => o.value === initial) ? initial : '', 'Vælg');
  form.appendChild(siteEditField('Titel', title));
  form.appendChild(siteEditField('Placering', placement));
  form.appendChild(el('p', 'ninjas-muted ninjas-modal-note', 'Ekstra rækker kommer ikke fra Manus og vises både i Mikrofonplan og Cues.'));

  actions.classList.add('ninjas-modal-actions');
  if (row) {
    const del = ninjasPillBtn('Slet', 'site-btn-danger');
    del.addEventListener('click', () => {
      ninjasConfirm('Slet rækken?', `${row.title} og dens mikrofoner og cues fjernes.`, 'Slet', async () => {
        const result = await ninjasApi('ninjas_delete_extra_row', { id: row.extra.id });
        if (!result.ok) {
          if (result.message) siteShowToast(result.message);
          return false;
        }
        ninjasApplyDoc(result.data);
        close();
        ninjasRender();
        return true;
      });
    });
    actions.appendChild(del);
  }
  const save = ninjasPillBtn('Gem', 'site-btn-success');
  save.addEventListener('click', async () => {
    error.textContent = '';
    const nextTitle = title.value.trim();
    if (!nextTitle) { error.textContent = 'Rækken skal have en titel.'; return; }
    save.disabled = true;
    const result = await ninjasApi('ninjas_upsert_extra_row', {
      row: { id: row ? row.extra.id : null, act: group.act, afterKey: placement.value || null, title: nextTitle },
    });
    save.disabled = false;
    if (!result.ok) { error.textContent = result.message || 'Kunne ikke gemme.'; return; }
    ninjasApplyDoc(result.data);
    close();
    ninjasRender();
  });
  actions.appendChild(save);
  title.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save.click(); } });
  title.focus();
}

// ── Init ─────────────────────────────────────────────────────
function ninjasInit() {
  const root = ninjasRoot();
  if (!root) return;
  const editBtn = document.getElementById('ninjas-edit-btn');
  if (editBtn) editBtn.addEventListener('click', ninjasToggleEditing);
  if (typeof siteRegisterUnsavedCheck === 'function') siteRegisterUnsavedCheck(() => ninjasPending.size > 0);
  window.addEventListener('beforeunload', (e) => {
    if (!ninjasPending.size) return;
    e.preventDefault();
    e.returnValue = '';
  });
  // Below revyst the page gate hides <main> anyway — don't prompt for a password.
  if (!siteHasLevel('revyst')) return;
  ninjasLoad();
}

ninjasInit();
