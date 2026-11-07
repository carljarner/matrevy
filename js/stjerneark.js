'use strict';

// ── Stjerneark (stjerneark.html) ─────────────────────────────
// One table like the old Stjerneark spreadsheet: the acts stacked
// vertically, one row per scene of the current production (from Manus's
// scenes.json), with four 0-3 priorities (Skuespil/Sang/Dans/Band), three
// checkboxes and a comment. Boss/admin edit; every change auto-saves via
// the boss manus_set_stars action, which sets only these fields (plus the
// derived priority/dansRepeat) on the scenes named by uid, so it needs no
// read or merge and never touches Manus's other fields (last save wins per
// scene). Manus's Gem never changes these fields itself, so its three-way
// merge keeps what was saved here. Revyster see the table read-only, once
// Manus's "Revyster kan se manus" and "Revyster kan se roller" are on.
//
// The field helpers below are copied from manus.js (manusStarFieldsFromScene
// & co.), which still needs them to write a scene's save shape on Gem.

// ── Fields ───────────────────────────────────────────────────
const STJERNE_PRIO_FIELDS = [
  { key: 'prioSkuespil', label: 'Skuespil' },
  { key: 'prioSang', label: 'Sang' },
  { key: 'dansPriority', label: 'Dans' },
  { key: 'prioBand', label: 'Band' },
];
const STJERNE_CHECK_FIELDS = [
  { key: 'repeat', label: 'Dobbeltsegment' },
  { key: 'oevetBand', label: 'Øvet med band' },
  { key: 'oevetScene', label: 'Øvet på scene' },
];
const STJERNE_NOTE_MAX = 2000;
const STJERNE_PRIO_KEYS = STJERNE_PRIO_FIELDS.map(f => f.key);
const STJERNE_PRIO_VALUES = [0, 1, 2, 3];
// A shown picker that was never set starts at 3.
const STJERNE_START = 3;

// Copied from schedule.js (Øveplan's rule for splitting off a Dans part):
// a cast member tagged Dans or Koreograf, or a raw role code with Y/D when
// there are no tags yet.
function stjerneIsDanceCastRole(c) {
  if (Array.isArray(c.tags) && c.tags.length) {
    return c.tags.includes('Dans') || c.tags.includes('Koreograf');
  }
  const r = (c.role || '').trim();
  if (r === 'Dans' || r === 'Koreograf') return true;
  const code = r.toUpperCase();
  return code.includes('Y') || code.includes('D');
}

// Which priority pickers a scene shows without being added by hand:
// a sketch only Skuespil; a song Skuespil, Sang and Band, plus Dans when
// it has dancers.
function stjerneDefaultFields(scene) {
  if (!(scene.types || []).includes('sang')) return ['prioSkuespil'];
  const keys = ['prioSkuespil', 'prioSang', 'prioBand'];
  if ((scene.cast || []).some(stjerneIsDanceCastRole)) keys.push('dansPriority');
  return keys;
}

// 0-3, null (shown, nothing selected) or undefined (never set).
function stjernePrioValue(v) {
  if (v === null) return null;
  return Number.isInteger(v) && v >= 0 && v <= 3 ? v : undefined;
}

// A scene's Stjerneark values. A scene from before the four columns has
// only `priority`, which becomes Skuespil.
function stjerneFieldsFromScene(s) {
  return {
    prioSkuespil: stjernePrioValue('prioSkuespil' in s ? s.prioSkuespil : s.priority),
    prioSang: stjernePrioValue(s.prioSang),
    dansPriority: stjernePrioValue(s.dansPriority),
    prioBand: stjernePrioValue(s.prioBand),
    repeat: !!s.repeat,
    oevetBand: !!s.oevetBand,
    oevetScene: !!s.oevetScene,
    stjerneNote: typeof s.stjerneNote === 'string' ? s.stjerneNote : '',
    // Pickers added by hand with "+", in column order.
    stjerneExtra: STJERNE_PRIO_KEYS.filter(k => Array.isArray(s.stjerneExtra) && s.stjerneExtra.includes(k)),
  };
}

// Whether a scene shows a picker for `key`: a default, added with "+", or
// an older value above 0 (so nothing set before the defaults disappears).
function stjernePickerShown(scene, values, key) {
  return stjerneDefaultFields(scene).includes(key)
    || values.stjerneExtra.includes(key)
    || values[key] > 0;
}

function stjerneEffective(v) {
  return v === undefined ? STJERNE_START : v;
}

// What manus_set_stars gets for a scene (and what its stored scene looks
// like afterwards): a hidden picker's value is left out, a shown one that
// was never set is sent as 3.
function stjerneSaveValues(scene, values) {
  const out = {
    repeat: values.repeat,
    oevetBand: values.oevetBand,
    oevetScene: values.oevetScene,
    stjerneNote: values.stjerneNote,
    stjerneExtra: values.stjerneExtra,
  };
  for (const key of STJERNE_PRIO_KEYS) {
    if (stjernePickerShown(scene, values, key)) out[key] = stjerneEffective(values[key]);
  }
  return out;
}

// Copy of manus_set_stars() in update-data.php, for this tab's shadow.
function stjerneApplyToScene(scene, u) {
  const next = { ...scene };
  for (const key of STJERNE_PRIO_KEYS) {
    if (key in u) next[key] = u[key]; else delete next[key];
  }
  next.priority = Math.max(u.prioSkuespil || 0, u.prioSang || 0);
  next.repeat = u.repeat;
  if (u.repeat) next.dansRepeat = true; else delete next.dansRepeat;
  if (u.oevetBand) next.oevetBand = true; else delete next.oevetBand;
  if (u.oevetScene) next.oevetScene = true; else delete next.oevetScene;
  if (u.stjerneNote) next.stjerneNote = u.stjerneNote; else delete next.stjerneNote;
  if (u.stjerneExtra.length) next.stjerneExtra = u.stjerneExtra; else delete next.stjerneExtra;
  return next;
}

// ── Data ─────────────────────────────────────────────────────
function stjerneConfig() {
  return siteLoadOverride('config') || (typeof CONFIG_DATA !== 'undefined' ? CONFIG_DATA : {});
}

// A fresh Manus save in this browser wins over the embed (as on Øveplan).
function stjerneManusData() {
  const override = siteLoadOverride('manus');
  if (override && Array.isArray(override.scenes)) return override;
  return {
    scenes: (typeof SCENES_DATA !== 'undefined' && Array.isArray(SCENES_DATA)) ? SCENES_DATA : [],
    cast: (typeof CAST_DATA !== 'undefined' && Array.isArray(CAST_DATA)) ? CAST_DATA : [],
  };
}

function stjerneSceneKey(scene) {
  return scene.uid || `id:${scene.id}`;
}

function stjerneActCode(scene) {
  return String(scene.id || '').split('-')[0] || '?';
}

function stjerneActLabel(act) {
  return act === 'E' ? 'Ekstranumre' : `Akt ${act}`;
}

// Videos and band jingles (Manus's manusRowIsManualMedia rule on `types`).
function stjerneSceneIsMedia(scene) {
  const types = Array.isArray(scene.types) ? scene.types : [];
  const type = types.find(t => t === 'sketch' || t === 'sang') || types[0] || '';
  return type === 'video' || type === 'bandsang';
}

function stjerneCanEdit() {
  return siteHasLevel('boss');
}

// Below boss nothing is listed until both Manus toggles are on.
function stjerneHiddenMessage() {
  if (siteHasLevel('boss')) return '';
  const config = stjerneConfig();
  if (!config.pdfLinksVisibleToRevyst) return 'Manus er ikke frigivet endnu.';
  if (!config.rolesVisibleToRevyst) return 'Rollerne er ikke frigivet endnu.';
  return '';
}

// [{act, label, rows:[row]}], in Manus's order. A row is the scene plus
// its current values and the last values known to be saved.
let stjerneGroups = [];

function stjerneBuildGroups() {
  const groups = [];
  const byAct = new Map();
  for (const scene of stjerneManusData().scenes) {
    const act = stjerneActCode(scene);
    if (act === 'pool' || stjerneSceneIsMedia(scene)) continue;
    if (!byAct.has(act)) {
      const g = { act, label: scene.actLabel || stjerneActLabel(act), rows: [] };
      byAct.set(act, g);
      groups.push(g);
    }
    const values = stjerneFieldsFromScene(scene);
    byAct.get(act).rows.push({
      uid: stjerneSceneKey(scene),
      scene,
      values,
      saved: JSON.stringify(stjerneSaveValues(scene, values)),
    });
  }
  return groups;
}

// ── Server ───────────────────────────────────────────────────
function stjerneResolvePassword() {
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

async function stjerneApi(action, body) {
  const password = stjerneResolvePassword();
  if (!password) return { ok: false, message: '' };
  let res;
  try {
    res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, password, ...body }),
    });
  } catch (e) {
    return { ok: false, message: 'Kunne ikke oprette forbindelse til serveren. Tjek din internetforbindelse.' };
  }
  // Require a real {ok:true} JSON body: a PHP fatal or WAF page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (res.status === 401 || res.status === 403) return { ok: false, message: 'Forkert eller utilstrækkelig adgangskode. Log ind igen.' };
  if (!res.ok) return { ok: false, message: `Serverfejl (${res.status}). Prøv igen senere.` };
  if (!data || data.ok !== true) return { ok: false, message: 'Uventet svar fra serveren. Prøv igen senere.' };
  return { ok: true, data };
}

// ── Auto-save ────────────────────────────────────────────────
// Sends every row whose values differ from what was last saved.
async function stjerneSave() {
  const changed = [];
  for (const g of stjerneGroups) {
    for (const row of g.rows) {
      const sent = stjerneSaveValues(row.scene, row.values);
      const json = JSON.stringify(sent);
      if (json !== row.saved) changed.push({ row, sent, json });
    }
  }
  if (!changed.length) return { ok: true };

  const result = await stjerneApi('manus_set_stars', { updates: changed.map(c => ({ uid: c.row.uid, ...c.sent })) });
  if (!result.ok) return result;
  const missing = new Set(result.data.missing || []);
  const savedByUid = new Map();
  for (const c of changed) {
    if (missing.has(c.row.uid)) continue;
    c.row.saved = c.json;
    savedByUid.set(c.row.uid, c.sent);
  }
  // Same-browser shadow, read by Manus, Øveplan and Ninjas.
  const data = stjerneManusData();
  siteSaveOverride('manus', {
    scenes: data.scenes.map((sc) => {
      const u = savedByUid.get(stjerneSceneKey(sc));
      return u ? stjerneApplyToScene({ ...sc, uid: stjerneSceneKey(sc) }, u) : sc;
    }),
    cast: data.cast,
  });
  if (missing.size) return { ok: false, message: 'Nogle scener findes ikke længere i Manus. Genindlæs siden.' };
  return { ok: true };
}

let stjerneStatusEl = null;

function stjernePaintStatus(state, message) {
  if (!stjerneStatusEl) return;
  stjerneStatusEl.textContent = state === 'saving' ? 'Gemmer…'
    : state === 'error' ? (message || 'Ikke gemt')
      : 'Gemmes automatisk · Gemt';
  stjerneStatusEl.classList.toggle('stjerne-status-error', state === 'error');
}

const stjerneAutosave = siteCreateAutosave({
  save: stjerneSave,
  delayMs: 600,
  onStatus: stjernePaintStatus,
});

// ── Cells ────────────────────────────────────────────────────
// A priority cell: the four 0-3 circles when the scene has that picker,
// otherwise (editing) a small "+" that adds it, starting at 3. Right-click
// on an added picker offers to remove it again; the defaults can't be
// removed. stjerne-prio-N is a permanent per-value class (so :hover can
// preview that value's colour via CSS alone); stjerne-prio-active marks
// the selected one.
function stjernePrioCell(row, field, label, editable) {
  const td = document.createElement('td');
  td.className = 'stjerne-prio-cell';
  const scene = row.scene;
  const values = row.values;
  const isDefault = stjerneDefaultFields(scene).includes(field);
  const save = () => stjerneAutosave.schedule();

  function render() {
    td.textContent = '';
    if (!stjernePickerShown(scene, values, field)) {
      if (!editable) return;
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'stjerne-add';
      add.textContent = '+';
      add.title = `Tilføj ${label}`;
      add.setAttribute('aria-label', `Tilføj ${label}`);
      add.addEventListener('click', () => {
        values.stjerneExtra = STJERNE_PRIO_KEYS.filter(k => k === field || values.stjerneExtra.includes(k));
        values[field] = STJERNE_START;
        render();
        save();
        const first = td.querySelector('.stjerne-prio-circle');
        if (first) first.focus();
      });
      td.appendChild(add);
      return;
    }
    const group = document.createElement('div');
    group.className = 'stjerne-prio';
    group.setAttribute('role', 'group');
    group.setAttribute('aria-label', label);
    if (!editable) group.classList.add('stjerne-prio-readonly');
    const btns = STJERNE_PRIO_VALUES.map((v) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `stjerne-prio-circle stjerne-prio-${v}`;
      btn.textContent = v;
      if (!editable) {
        btn.disabled = true;
        btn.title = `${label}: ${v}`;
      } else {
        btn.title = isDefault ? `${label}: ${v}` : `${label}: ${v} (højreklik for at fjerne)`;
        // Clicking the selected value unselects it. The hover colour stays
        // off until the pointer moves, so the circle visibly clears.
        btn.addEventListener('click', (e) => {
          values[field] = stjerneEffective(values[field]) === v ? null : v;
          paint();
          save();
          group.classList.add('stjerne-prio-hover-off');
          const { clientX: x, clientY: y } = e;
          const onMove = (m) => {
            if (m.clientX === x && m.clientY === y) return;
            group.classList.remove('stjerne-prio-hover-off');
            document.removeEventListener('pointermove', onMove);
          };
          document.addEventListener('pointermove', onMove);
        });
      }
      group.appendChild(btn);
      return btn;
    });
    function paint() {
      const active = stjerneEffective(values[field]);
      btns.forEach((btn, v) => {
        btn.classList.toggle('stjerne-prio-active', v === active);
        btn.setAttribute('aria-pressed', String(v === active));
      });
    }
    paint();
    if (editable && !isDefault) {
      group.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const pop = document.createElement('div');
        pop.className = 'site-field-pop';
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'site-list-row';
        remove.textContent = `Fjern ${label}`;
        remove.addEventListener('click', () => {
          siteCloseFieldPopup();
          values[field] = undefined;
          values.stjerneExtra = values.stjerneExtra.filter(k => k !== field);
          render();
          save();
        });
        pop.appendChild(remove);
        siteOpenFieldPopup(group, pop);
      });
    }
    td.appendChild(group);
  }
  render();
  return td;
}

function stjerneCheckCell(row, field, label, editable) {
  const td = document.createElement('td');
  td.className = 'stjerne-check-cell';
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.className = 'stjerne-check';
  box.checked = !!row.values[field];
  box.disabled = !editable;
  box.setAttribute('aria-label', label);
  box.addEventListener('change', () => {
    row.values[field] = box.checked;
    stjerneAutosave.schedule();
  });
  td.appendChild(box);
  return td;
}

// One line that grows sideways: the input shares a grid cell with an
// invisible copy of its text (::after, from data-value), which sets the
// width, so a long comment widens the column instead of wrapping.
function stjerneNoteCell(row, editable) {
  const td = document.createElement('td');
  td.className = 'stjerne-note-cell';
  if (!editable) {
    const text = document.createElement('span');
    text.className = 'stjerne-note-text';
    text.textContent = row.values.stjerneNote || '';
    td.appendChild(text);
    return td;
  }
  const sizer = document.createElement('div');
  sizer.className = 'stjerne-note-sizer';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'stjerne-note';
  input.maxLength = STJERNE_NOTE_MAX;
  input.value = row.values.stjerneNote || '';
  input.setAttribute('aria-label', 'Kommentar');
  sizer.dataset.value = input.value;
  input.addEventListener('input', () => {
    row.values.stjerneNote = input.value;
    sizer.dataset.value = input.value;
    stjerneAutosave.schedule();
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) input.blur();
  });
  sizer.appendChild(input);
  td.appendChild(sizer);
  return td;
}

// ── Render ───────────────────────────────────────────────────
function stjerneRender() {
  const root = document.getElementById('stjerne-root');
  root.textContent = '';
  stjerneStatusEl = null;
  const card = document.createElement('section');
  card.className = 'card stjerne-card';
  root.appendChild(card);

  const empty = (text) => {
    const p = document.createElement('p');
    p.className = 'stjerne-empty';
    p.textContent = text;
    card.appendChild(p);
  };

  const hidden = stjerneHiddenMessage();
  if (hidden) { empty(hidden); return; }
  if (!stjerneGroups.length) { empty('Der er ingen scener i Manus endnu.'); return; }

  const editable = stjerneCanEdit();
  if (editable) {
    stjerneStatusEl = document.createElement('p');
    stjerneStatusEl.className = 'stjerne-status';
    card.appendChild(stjerneStatusEl);
    stjernePaintStatus('saved');
  }

  const columnCount = 1 + STJERNE_PRIO_FIELDS.length + STJERNE_CHECK_FIELDS.length + 1;
  const wrap = document.createElement('div');
  wrap.className = 'stjerne-scroll';
  const table = document.createElement('table');
  table.className = 'stjerne-table';

  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const addHead = (text, className) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = className;
    th.textContent = text;
    headRow.appendChild(th);
  };
  addHead('Titel', 'stjerne-col-title');
  for (const f of STJERNE_PRIO_FIELDS) addHead(f.label, 'stjerne-col-prio');
  for (const f of STJERNE_CHECK_FIELDS) addHead(f.label, 'stjerne-col-check');
  addHead('Kommentar', 'stjerne-col-note');
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const g of stjerneGroups) {
    const actTr = document.createElement('tr');
    actTr.className = 'stjerne-act-row';
    const actTd = document.createElement('td');
    actTd.colSpan = columnCount;
    const actLabel = document.createElement('span');
    actLabel.className = 'stjerne-act-label';
    actLabel.textContent = g.label;
    actTd.appendChild(actLabel);
    actTr.appendChild(actTd);
    tbody.appendChild(actTr);

    for (const row of g.rows) {
      const tr = document.createElement('tr');
      const title = document.createElement('th');
      title.scope = 'row';
      title.className = 'stjerne-col-title';
      const name = row.scene.name || row.scene.title || 'Unavngivet scene';
      // One line, cut with "..." (CSS); the full title on hover when cut.
      const titleText = document.createElement('span');
      titleText.className = 'stjerne-title-text';
      titleText.textContent = name;
      titleText.addEventListener('mouseenter', () => {
        if (titleText.scrollWidth > titleText.clientWidth) titleText.title = name;
        else titleText.removeAttribute('title');
      });
      title.appendChild(titleText);
      tr.appendChild(title);
      for (const f of STJERNE_PRIO_FIELDS) tr.appendChild(stjernePrioCell(row, f.key, f.label, editable));
      for (const f of STJERNE_CHECK_FIELDS) tr.appendChild(stjerneCheckCell(row, f.key, f.label, editable));
      tr.appendChild(stjerneNoteCell(row, editable));
      tbody.appendChild(tr);
    }
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  card.appendChild(wrap);
}

document.addEventListener('DOMContentLoaded', () => {
  stjerneGroups = stjerneBuildGroups();
  stjerneRender();
});
