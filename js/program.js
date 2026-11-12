'use strict';

// Program (Redskaber): a scratch copy of the programme's Medvirkende and
// Ordliste that every revyst can edit, so bosses can collect additions and
// copy them into Manus's Program tab by hand. Coupled to nothing: not
// program.json, not the PDFs, not Afslut revyen. Private store on the
// server (programkladde_read/programkladde_save, PROGRAMKLADDE_DATA_DIR).
//
// Many people type in the same two boxes, so saves are merged per line:
// every save names the sha it built on, a 409 re-reads, and their changes
// are merged into the draft (progMerge3) before saving again. A refresh
// every 15 s pulls in what others saved, so everyone sees each other's
// additions without reloading.

// ── API ─────────────────────────────────────────────────────
// Like ninjasApi, but never prompts: the page gate guarantees a login,
// and the refresh timer must never pop up a password box.
const PROG_MAX_CHARS = 50000; // ↔ programkladde_max_chars()

function progMapError(status, detail) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (detail === 'invalid_shape') return `Teksten er for lang (højst ${PROG_MAX_CHARS.toLocaleString('da-DK')} tegn pr. felt).`;
  return detail ? `Serverfejl: ${detail}` : `Serverfejl (${status}). Prøv igen senere.`;
}

async function progApi(action, body) {
  const auth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  const password = auth && auth.password;
  if (!password) return { ok: false, status: 0, message: 'Log ind for at bruge siden.' };
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
  // Require a real {ok:true} JSON body: a PHP fatal or proxy page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (res.status === 409 && detail === 'stale') {
    return { ok: false, status: 409, conflict: true, message: 'En anden har lige gemt.' };
  }
  if (!res.ok) return { ok: false, status: res.status, detail, message: progMapError(res.status, detail) };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, detail, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── State ────────────────────────────────────────────────────
const PROG_SECTIONS = [
  {
    key: 'medvirkende',
    label: 'Medvirkende',
    placeholder: '\\arb{Koordinatorer}\nFornavn Efternavn \\\\\nFornavn Efternavn \\\\\n\n\\arb{Instruktører}\nFornavn Efternavn \\\\',
  },
  {
    key: 'ordliste',
    label: 'Ordliste',
    placeholder: '\\textbf{Ord:} Forklaring \\\\\n\\textbf{Andet ord:} Forklaring \\\\',
  },
];
const PROG_SAVE_ATTEMPTS = 3;
const PROG_REFRESH_MS = 15 * 1000;

let progDraft = null;   // {medvirkende, ordliste}: what the boxes show
let progBase = null;    // the server version the draft is built on
let progServer = null;  // {sha, data} last read or written; null = read first
let progLoaded = false;
let progLoading = false;
let progRefreshing = false;
let progSaveGen = 0;    // bumped by every save, so a refresh that raced one is dropped
const progTextareas = {};

function progFields(data) {
  const out = {};
  for (const { key } of PROG_SECTIONS) out[key] = (data && typeof data[key] === 'string') ? data[key] : '';
  return out;
}

function progServerFromRead(data) {
  return { sha: (data && typeof data.sha === 'string') ? data.sha : null, data: progFields(data) };
}

function progSame(a, b) {
  return PROG_SECTIONS.every(({ key }) => a[key] === b[key]);
}

// ── Line merge ───────────────────────────────────────────────
// Three-way merge of one text field by lines. Changes on different lines
// both apply; lines both sides added at the same spot (typically both
// appending at the end) are all kept, theirs first. Only where both sides
// changed the same base lines is it an `overlap`: both versions are kept
// (theirs, then the lines of mine that aren't in theirs), so nothing is
// lost and a deletion loses to an edit.
const PROG_DIFF_MAX_CELLS = 1000000;

function progLines(text) {
  return text === '' ? [] : text.split('\n');
}

// The hunks turning `base` into `side`, in base order: base[start:end] is
// replaced by `lines`. An LCS between the common prefix and suffix; past
// PROG_DIFF_MAX_CELLS the whole middle is one hunk.
function progDiffHunks(base, side) {
  let pre = 0;
  while (pre < base.length && pre < side.length && base[pre] === side[pre]) pre++;
  let suf = 0;
  while (suf < base.length - pre && suf < side.length - pre
      && base[base.length - 1 - suf] === side[side.length - 1 - suf]) suf++;
  const b = base.slice(pre, base.length - suf);
  const s = side.slice(pre, side.length - suf);
  if (!b.length && !s.length) return [];
  if (!b.length || !s.length || b.length * s.length > PROG_DIFF_MAX_CELLS) {
    return [{ start: pre, end: pre + b.length, lines: s }];
  }
  const n = b.length;
  const m = s.length;
  // lcs[i][j] = LCS length of b[i:] and s[j:].
  const lcs = [];
  for (let i = 0; i <= n; i++) lcs.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = b[i] === s[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const hunks = [];
  let cur = null;
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && b[i] === s[j]) {
      if (cur) { hunks.push(cur); cur = null; }
      i++; j++;
    } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      if (!cur) cur = { start: pre + i, end: pre + i, lines: [] };
      cur.lines.push(s[j]);
      j++;
    } else {
      if (!cur) cur = { start: pre + i, end: pre + i, lines: [] };
      cur.end = pre + i + 1;
      i++;
    }
  }
  if (cur) hunks.push(cur);
  return hunks;
}

function progLinesEqual(a, b) {
  return a.length === b.length && a.every((line, i) => line === b[i]);
}

// One side's version of base[start:end] with its hunks (inside it) applied.
function progSideVersion(base, start, end, hunks) {
  const out = [];
  let pos = start;
  for (const h of hunks) {
    out.push(...base.slice(pos, h.start), ...h.lines);
    pos = h.end;
  }
  out.push(...base.slice(pos, end));
  return out;
}

function progMerge3(base, mine, theirs) {
  if (mine === theirs || theirs === base) return { text: mine, overlap: false };
  if (mine === base) return { text: theirs, overlap: false };
  const b = progLines(base);
  const tag = (side) => (h) => ({ ...h, side });
  // Sorted by start; at the same start insertions come first, theirs
  // before mine (the order lines added at the same spot end up in).
  const hunks = progDiffHunks(b, progLines(theirs)).map(tag('theirs'))
    .concat(progDiffHunks(b, progLines(mine)).map(tag('mine')))
    .sort((x, y) => x.start - y.start
      || Number(x.end > x.start) - Number(y.end > y.start)
      || Number(x.side === 'mine') - Number(y.side === 'mine'));
  const out = [];
  let overlap = false;
  let pos = 0;
  let i = 0;
  while (i < hunks.length) {
    const first = hunks[i];
    if (first.start === first.end) {
      // Insertions at one spot: from one side, or both sides' (theirs first).
      out.push(...b.slice(pos, first.start));
      pos = first.start;
      const added = [];
      while (i < hunks.length && hunks[i].start === first.start && hunks[i].end === first.start) {
        if (!(hunks[i].side === 'mine' && added.length && progLinesEqual(added, hunks[i].lines))) {
          added.push(...hunks[i].lines);
        }
        i++;
      }
      out.push(...added);
      continue;
    }
    // A changed range plus every hunk (either side) overlapping it.
    let end = first.end;
    const group = [first];
    i++;
    while (i < hunks.length && hunks[i].start < end) {
      group.push(hunks[i]);
      end = Math.max(end, hunks[i].end);
      i++;
    }
    out.push(...b.slice(pos, first.start));
    pos = end;
    const theirsHunks = group.filter((h) => h.side === 'theirs');
    const mineHunks = group.filter((h) => h.side === 'mine');
    if (!theirsHunks.length || !mineHunks.length) {
      out.push(...progSideVersion(b, first.start, end, group));
      continue;
    }
    const vt = progSideVersion(b, first.start, end, theirsHunks);
    const vm = progSideVersion(b, first.start, end, mineHunks);
    out.push(...vt);
    if (!progLinesEqual(vt, vm)) {
      overlap = true;
      const inTheirs = new Set(vt);
      out.push(...vm.filter((line) => !inTheirs.has(line)));
    }
  }
  out.push(...b.slice(pos));
  return { text: out.join('\n'), overlap };
}

// ── Draft ↔ boxes ────────────────────────────────────────────
// Puts a merged value in a box without moving the caret: the old and new
// text share a prefix and a suffix, and a caret in either keeps its place.
function progSetFieldValue(key, next) {
  progDraft[key] = next;
  const textarea = progTextareas[key];
  if (!textarea || textarea.value === next) return;
  const old = textarea.value;
  const focused = document.activeElement === textarea;
  const { selectionStart, selectionEnd, scrollTop } = textarea;
  let pre = 0;
  while (pre < old.length && pre < next.length && old[pre] === next[pre]) pre++;
  let suf = 0;
  while (suf < old.length - pre && suf < next.length - pre
      && old[old.length - 1 - suf] === next[next.length - 1 - suf]) suf++;
  const map = (p) => {
    if (p <= pre) return p;
    if (p >= old.length - suf) return p + next.length - old.length;
    return Math.min(p, next.length - suf);
  };
  textarea.value = next;
  if (focused) textarea.setSelectionRange(map(selectionStart), map(selectionEnd));
  textarea.scrollTop = scrollTop;
}

function progSnapshot() {
  return { ...progDraft };
}

// Merges a server version into the draft (only sections that changed
// since progBase), which then becomes the new base.
function progAbsorb(theirs) {
  const overlaps = [];
  for (const { key, label } of PROG_SECTIONS) {
    if (theirs[key] === progBase[key]) continue;
    const merged = progMerge3(progBase[key], progDraft[key], theirs[key]);
    if (merged.overlap) overlaps.push(label);
    progSetFieldValue(key, merged.text);
    progBase[key] = theirs[key];
  }
  if (overlaps.length) {
    siteShowToast(`Du og en anden ændrede de samme linjer i ${overlaps.join(' og ')}. Begge udgaver er bevaret, så ret selv til.`);
  }
}

// ── Auto-save ────────────────────────────────────────────────
async function progSaveNow() {
  if (!progLoaded) return { ok: true };
  progSaveGen++;
  for (let attempt = 1; attempt <= PROG_SAVE_ATTEMPTS; attempt++) {
    if (!progServer) {
      const read = await progApi('programkladde_read', {});
      if (!read.ok) return read;
      progServer = progServerFromRead(read.data);
    }
    progAbsorb(progServer.data);
    const sent = progSnapshot();
    if (progSame(sent, progServer.data)) return { ok: true };
    const result = await progApi('programkladde_save', { ...sent, baseSha: progServer.sha });
    if (!result.ok) {
      if (result.conflict) { progServer = null; continue; }
      return result;
    }
    progServer = { sha: result.data.sha, data: sent };
    progBase = { ...sent };
    return { ok: true };
  }
  return { ok: false, message: 'En anden gemmer samtidig. Prøv igen om lidt.' };
}

function progPaintStatus(state, message) {
  const el = document.getElementById('prog-status');
  if (!el) return;
  if (state === 'saving') el.textContent = 'Gemmer…';
  else if (state === 'error') el.textContent = message ? `Ikke gemt: ${message}` : 'Ikke gemt';
  else el.textContent = 'Gemmes automatisk · Gemt';
  el.classList.toggle('error', state === 'error');
}

const progAutosave = siteCreateAutosave({ save: progSaveNow, onStatus: progPaintStatus });

// ── Refresh (others' changes) ────────────────────────────────
// Skipped while a save is pending or running (that save merges anyway),
// and dropped if one started while the read was out.
async function progRefresh() {
  if (document.visibilityState !== 'visible') return;
  if (!progLoaded) { progLoad(); return; }
  if (progRefreshing || progAutosave.isBusy()) return;
  progRefreshing = true;
  const gen = progSaveGen;
  try {
    const read = await progApi('programkladde_read', {});
    if (!read.ok || gen !== progSaveGen || progAutosave.isBusy()) return;
    const server = progServerFromRead(read.data);
    if (progServer && server.sha === progServer.sha) return;
    progServer = server;
    progAbsorb(server.data);
    // Mine still differs (a save failed earlier): save it on top.
    if (!progSame(progSnapshot(), server.data)) progAutosave.schedule();
  } finally {
    progRefreshing = false;
  }
}

// ── Rendering ────────────────────────────────────────────────
function progRenderMessage(text) {
  const root = document.getElementById('prog-root');
  root.textContent = '';
  const p = document.createElement('p');
  p.className = 'site-empty';
  p.textContent = text;
  root.appendChild(p);
}

function progRenderSection({ key, label, placeholder }) {
  const section = document.createElement('section');
  section.className = 'card prog-section';
  const h2 = document.createElement('h2');
  h2.textContent = label;
  section.appendChild(h2);

  const textarea = document.createElement('textarea');
  textarea.className = 'prog-textarea';
  textarea.rows = 20;
  textarea.spellcheck = false;
  textarea.maxLength = PROG_MAX_CHARS;
  textarea.placeholder = placeholder;
  textarea.setAttribute('aria-label', label);
  textarea.value = progDraft[key];
  textarea.addEventListener('input', () => {
    progDraft[key] = textarea.value;
    progAutosave.schedule();
  });
  progTextareas[key] = textarea;
  section.appendChild(textarea);
  return section;
}

function progRender() {
  const root = document.getElementById('prog-root');
  root.textContent = '';
  const status = document.createElement('p');
  status.id = 'prog-status';
  status.className = 'site-save-status prog-status';
  root.appendChild(status);
  progPaintStatus('saved', '');
  for (const section of PROG_SECTIONS) root.appendChild(progRenderSection(section));
}

async function progLoad() {
  if (progLoading || progLoaded) return;
  progLoading = true;
  const read = await progApi('programkladde_read', {});
  progLoading = false;
  if (!read.ok) {
    progRenderMessage(`Kunne ikke hente programkladden. ${read.message}`);
    return;
  }
  progServer = progServerFromRead(read.data);
  progBase = { ...progServer.data };
  progDraft = { ...progServer.data };
  progLoaded = true;
  progRender();
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  progRenderMessage('Henter…');
  progLoad();
  setInterval(progRefresh, PROG_REFRESH_MS);
  document.addEventListener('visibilitychange', progRefresh);
});
