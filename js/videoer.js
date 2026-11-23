/* =========================================================
   Matematikrevyen – Videoer (the Videoer tab on arkiv.html)

   The recorded revyer as a members-only video player with a chapter per
   scene: one entry per Arkiv year (made by a boss; name and cover come
   from archive.json), holding the one long video of the whole revy.
   Revyster watch; boss uploads the video, sets the scenes' start times
   and adds subtitles; admin also imports a video rsynced to the server's
   incoming/ folder and removes a revy (✕ on its video, in two steps). (The store allows more videos per year;
   the page shows and manages the first.)

   The server runs Teknikken's store code on VIDEOER_DATA_DIR (its own
   Hetzner Volume) via the videoer_* actions (teknik_stores()['videoer'] in
   update-data.php): a year is a top-level folder + `archiveFolder`, a
   video a file + `order`, `durationSec`, `faststart`, `codecs`,
   `chapters` ([{t, uid, label}], t null = not marked yet),
   `chaptersVersion` and `subtitleFileId` (a .vtt file, `subtitleFor`).

   Playback: one native <video controls> (fullscreen, AirPlay and
   picture-in-picture for free; on the iPhone native fullscreen is the only
   kind there is), reused across re-renders so a re-render never stops it.
   Under it a scene strip (one segment per chapter, placed by time, the
   scene's name on hover) and previous/next scene buttons; beside it (below
   on phones) the scene list. Subtitles are
   a <track> with the signed .vtt URL. Stream links come with videoer_read
   and last 12-36 h; an expired one is refetched on error. The subtitles
   on/off choice is kept in localStorage.

   Routing: a tab on Arkiv (archive.js shows the tab): the overview at
   /arkiv#videoer, a year at #videoer/<archiveFolder>, a scene at
   #videoer/<archiveFolder>/<sceneUid> (for links from elsewhere later).

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helpers ────────────────────────────────────────
function vidEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// First-level (inline) button.
function vidBtn(label, extraClass) {
  const btn = vidEl('button', 'btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  btn.type = 'button';
  return btn;
}

// Second-level button, for buttons inside a modal overlay only.
function vidPillBtn(label, variant) {
  const btn = vidEl('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

// 24×24 icons. `fill` = solid shapes, else strokes.
const VID_ICONS = {
  play: { fill: true, paths: ['M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z'] },
  prev: { fill: true, paths: ['M6 5h2.2v14H6z', 'M19 5.9v12.2a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-6.1a.8.8 0 0 1 1.2.7z'] },
  next: { fill: true, paths: ['M15.8 5H18v14h-2.2z', 'M5 5.9v12.2a.8.8 0 0 0 1.2.7l8.2-6.1a.8.8 0 0 0 0-1.4L6.2 5.2A.8.8 0 0 0 5 5.9z'] },
  back: { paths: ['M15 5l-7 7 7 7'] },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  download: { paths: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'] },
  cc: { paths: ['M3 6h18v12H3z', 'M10 10.2a2.2 2.2 0 1 0 0 3.6', 'M17 10.2a2.2 2.2 0 1 0 0 3.6'] },
};

function vidIcon(name, size) {
  const spec = VID_ICONS[name];
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size || 20));
  svg.setAttribute('height', String(size || 20));
  svg.setAttribute('aria-hidden', 'true');
  if (spec.fill) {
    svg.setAttribute('fill', 'currentColor');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (const d of spec.paths) {
    const path = document.createElementNS(ns, 'path');
    path.setAttribute('d', d);
    svg.appendChild(path);
  }
  return svg;
}

function vidIconBtn(icon, title, extraClass, size) {
  const btn = vidEl('button', 'site-icon-btn' + (extraClass ? ' ' + extraClass : ''));
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(vidIcon(icon, size));
  return btn;
}

function vidRemoveBtn(title) {
  const btn = vidEl('button', 'site-icon-btn site-icon-btn-danger site-icon-btn-sm', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

// ── Authenticated API (mirrors albums.js's albApi) ───────────
const VID_CHUNK_BYTES = 8 * 1024 * 1024; // mirrors teknik_max_chunk_bytes()
const VID_CHUNK_ATTEMPTS = 4;
const VID_VIDEO_EXTS = ['mp4', 'm4v']; // mirrors videoer_video_exts()
const VID_FASTSTART_FIX = 'ffmpeg -i ind.mp4 -c copy -movflags +faststart ud.mp4';

function vidResolvePassword() {
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

function vidMapError(status, detail) {
  if (detail === 'quota_exceeded') return 'Der er ikke plads nok til videoen på serveren.';
  if (detail === 'album_exists') return 'Den revy er allerede tilføjet.';
  if (detail === 'stale') return 'Videoerne er lige blevet ændret af en anden. Siden er genindlæst.';
  if (detail === 'unsupported_type') return 'Kun MP4-videoer (.mp4 eller .m4v) kan uploades.';
  if (detail === 'invalid_subtitles') return 'Filen ligner ikke undertekster (WebVTT).';
  if (detail === 'videoer_volume_missing') return 'Videodisken på serveren er ikke tilgængelig. Sig det til Carl.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. En anden har måske lige slettet det. Genindlæs siden.';
  if (status === 507 || detail === 'disk_full') return 'Serveren er ved at løbe tør for plads. Sig det til Carl.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, status, message, data } —
// message '' = cancelled password prompt (silent no-op).
async function vidApi(action, body) {
  const password = vidResolvePassword();
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
  // Require a real {ok:true} JSON body — a PHP fatal or proxy page can come
  // back as HTTP 200 + HTML and must not be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  const detail = data && typeof data.error === 'string' ? data.error : '';
  if (!res.ok) return { ok: false, status: res.status, message: vidMapError(res.status, detail), data };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.', data };
  }
  return { ok: true, data };
}

function vidShowError(message) {
  if (message) siteShowToast(message);
}

// ── State ────────────────────────────────────────────────────
let vidState = null; // { folders (years), files (videos + subtitles) } once loaded
let vidFreeBytes = null; // free space on the video disk (null = unknown)
let vidEditing = false; // the open year's edit mode (boss)
// fileId → stream query ('teknik_dl=…'), and when those links expire (ms).
let vidStreamUrls = {};
let vidStreamExpires = 0;

function vidRoot() {
  return document.getElementById('videoer-root');
}

function vidIsBoss() {
  return typeof siteHasLevel === 'function' && siteHasLevel('boss');
}

function vidIsAdmin() {
  return typeof siteHasLevel === 'function' && siteHasLevel('admin');
}

// ── Lookups ──────────────────────────────────────────────────
function vidArchiveYears() {
  const override = siteLoadOverride('archive');
  return (override || (typeof ARCHIVE_DATA !== 'undefined' ? ARCHIVE_DATA : [])).filter((y) => y && y.folder);
}

function vidArchiveEntry(folder) {
  return vidArchiveYears().find((y) => y.folder === folder) || null;
}

function vidYearName(year) {
  if (!year) return '';
  const entry = vidArchiveEntry(year.archiveFolder);
  return (entry && entry.name) || year.name || year.archiveFolder;
}

function vidYearCover(year) {
  const entry = year ? vidArchiveEntry(year.archiveFolder) : null;
  return (entry && entry.coverImage) || '';
}

function vidYearNumber(year) {
  const entry = vidArchiveEntry(year.archiveFolder);
  if (entry && entry.year) return entry.year;
  const m = /\d{4}/.exec(year.archiveFolder || '');
  return m ? Number(m[0]) : 0;
}

function vidYearById(id) {
  return (vidState && vidState.folders.find((f) => f.id === id)) || null;
}

function vidYearByArchiveFolder(folder) {
  return (vidState && vidState.folders.find((f) => f.archiveFolder === folder)) || null;
}

function vidFileById(id) {
  return (vidState && vidState.files.find((f) => f.id === id)) || null;
}

function vidVideos(yearId) {
  return vidState.files
    .filter((f) => f.folderId === yearId && !f.subtitleFor)
    .sort((a, b) => ((a.order || 0) - (b.order || 0)) || String(a.uploadedAt || '').localeCompare(String(b.uploadedAt || '')));
}

function vidSubtitle(video) {
  return video && video.subtitleFileId ? vidFileById(video.subtitleFileId) : null;
}

// Newest first, in Arkiv's order within a year. Revyster only see years
// with videos in them.
function vidYears() {
  const years = vidArchiveYears();
  const rank = (year) => {
    const i = years.findIndex((y) => y.folder === year.archiveFolder);
    return i === -1 ? years.length : i;
  };
  const list = vidState.folders.filter((year) => year.archiveFolder && (vidIsBoss() || vidVideos(year.id).length));
  return list.sort((a, b) => (vidYearNumber(b) - vidYearNumber(a)) || (rank(a) - rank(b)));
}

function vidTitle(file) {
  if (!file) return '';
  return file.ext ? file.name.replace(new RegExp('\\.' + file.ext + '$', 'i'), '') || file.name : file.name;
}

// The chapters revyster see: marked ones only, by time.
function vidChapters(video) {
  const list = (video && Array.isArray(video.chapters)) ? video.chapters : [];
  return list.filter((c) => c && Number.isFinite(c.t)).slice().sort((a, b) => a.t - b.t);
}

function vidChapterLabel(chapter) {
  return (chapter && chapter.label) || 'Uden navn';
}

// ── Formatting ───────────────────────────────────────────────
function vidFormatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function vidFormatTotal(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} t ${min % 60} min`;
}

function vidFormatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return value.toLocaleString('da-DK', { maximumFractionDigits: digits }) + ' ' + units[unit];
}

// "1:02:03", "62:03", "3723", "1.02.03" and "62:03,5" → seconds (null if
// it isn't a time).
function vidParseTimestamp(text) {
  const s = String(text || '').trim().replace(/,/g, '.');
  if (!s) return null;
  let parts;
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  if (/^\d+[:.]\d{1,2}([:.]\d{1,2})?(\.\d+)?$/.test(s)) {
    // "1.02.03" (dots as separators) or "1:02:03.5" (a decimal at the end).
    const m = /^(.*?)(\.\d+)?$/.exec(s.includes(':') ? s : s.replace(/\./g, ':'));
    parts = m[1].split(':').map(Number);
    const frac = m[2] ? Number(m[2]) : 0;
    if (parts.slice(1).some((p) => p >= 60)) return null;
    const sec = parts.reduce((sum, p) => sum * 60 + p, 0) + frac;
    return Number.isFinite(sec) ? sec : null;
  }
  return null;
}

function vidPlural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// "2 t 41 min · 34 scener" (what's known of the year's video).
function vidYearMeta(year) {
  const video = vidVideos(year.id)[0];
  if (!video) return 'Ingen video endnu';
  const parts = [];
  if (video.durationSec > 0) parts.push(vidFormatTotal(video.durationSec));
  const scenes = vidChapters(video).length;
  if (scenes) parts.push(vidPlural(scenes, 'scene', 'scener'));
  return parts.join(' · ') || 'Video';
}

// ── Load ─────────────────────────────────────────────────────
async function vidLoad() {
  const root = vidRoot();
  if (!vidState) root.replaceChildren(vidEl('p', 'site-muted', 'Indlæser…'));
  const result = await vidApi('videoer_read', {});
  if (!result.ok) {
    const card = vidEl('section', 'card');
    card.appendChild(vidEl('p', 'vid-error', result.message || 'Kunne ikke indlæse videoerne.'));
    root.replaceChildren(card);
    return;
  }
  vidApplyRead(result.data);
  vidRender();
}

function vidApplyRead(data) {
  vidState = { folders: data.folders || [], files: data.files || [] };
  vidFreeBytes = Number.isFinite(data.freeBytes) ? data.freeBytes : null;
  vidSetStreamUrls(data.streamUrls, data.streamExpiresAt);
}

function vidSetStreamUrls(urls, expiresAt) {
  vidStreamUrls = (urls && typeof urls === 'object' && !Array.isArray(urls)) ? urls : {};
  const t = Date.parse(expiresAt || '');
  vidStreamExpires = Number.isFinite(t) ? t : 0;
}

let vidStreamRefresh = null;
// Fresh links for every video (one request, shared by concurrent callers).
function vidRefreshStreamUrls() {
  if (!vidStreamRefresh) {
    vidStreamRefresh = vidApi('videoer_stream_urls', {}).then((result) => {
      vidStreamRefresh = null;
      if (!result.ok) return false;
      vidSetStreamUrls(result.data.urls, result.data.expiresAt);
      return true;
    });
  }
  return vidStreamRefresh;
}

function vidStreamUrl(file) {
  const query = file && vidStreamUrls[file.id];
  if (!query) return '';
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  return SITE_API_ENDPOINT + sep + query;
}

// ── Routing ──────────────────────────────────────────────────
// #videoer = the overview, #videoer/<folder> a year, and a third part
// (a chapter's uid) jumps to that scene.
function vidRouteParts() {
  const m = /^#videoer\/([^/]+)(?:\/(.+))?$/.exec(location.hash);
  if (!m) return { folder: '', target: '' };
  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch (e) { return ''; } };
  return { folder: dec(m[1]), target: dec(m[2]) };
}

function vidTabShowing() {
  const panel = document.getElementById('arkiv-tab-videoer');
  return !!panel && !panel.hidden;
}

function vidCurrentYear() {
  const { folder } = vidRouteParts();
  const year = folder ? vidYearByArchiveFolder(folder) : null;
  if (!year || (!vidIsBoss() && !vidVideos(year.id).length)) return null;
  return year;
}

function vidGoToYear(year) {
  location.hash = 'videoer/' + encodeURIComponent(year.archiveFolder);
}

function vidGoToOverview() {
  location.hash = 'videoer';
}

// A scene link (#videoer/<folder>/<uid>): queues the jump for when the
// video has loaded, and drops the uid from the URL (so a re-render doesn't
// jump again).
function vidApplyRouteTarget(year) {
  const { target } = vidRouteParts();
  if (!target) return;
  history.replaceState(null, '', '#videoer/' + encodeURIComponent(year.archiveFolder));
  const video = vidCurrentVideo(year);
  const ch = video ? vidChapters(video).find((c) => c.uid === target) : null;
  if (ch) vidPlayer.pendingSeek = { fileId: video.id, t: ch.t };
}

function vidOnRoute() {
  if (!vidState) return;
  if (!vidTabShowing() || !vidCurrentYear()) vidPausePlayer();
  vidEditing = false;
  vidRender();
  if (vidTabShowing()) window.scrollTo(0, 0);
}

// ── Render ───────────────────────────────────────────────────
function vidRender() {
  const root = vidRoot();
  if (!root || !vidState) return;
  vidHideStripTip(); // its strip is about to be replaced
  const year = vidCurrentYear();
  if (vidTabShowing()) document.title = (year ? vidYearName(year) + ' · ' : '') + 'Videoer · Matematikrevyen';
  if (year) vidApplyRouteTarget(year);
  root.replaceChildren(year ? vidBuildYearView(year) : vidBuildOverview(), vidUploadPanel());
  vidRenderUploads();
  vidPaintNow();
}

// A cover image, or a ▶ placeholder when the year has none (or it fails).
function vidCoverEl(year, className) {
  const wrap = vidEl('div', 'vid-cover' + (className ? ' ' + className : ''));
  const placeholder = () => {
    wrap.classList.add('vid-cover-empty');
    wrap.appendChild(vidIcon('play', 40));
  };
  const src = vidYearCover(year);
  if (!src) { placeholder(); return wrap; }
  const img = document.createElement('img');
  img.alt = '';
  img.loading = 'lazy';
  img.decoding = 'async';
  img.addEventListener('error', () => { img.remove(); placeholder(); });
  img.src = src;
  wrap.appendChild(img);
  return wrap;
}

// ── Overview: a grid of year covers ──────────────────────────
function vidBuildOverview() {
  const wrap = vidEl('div', 'vid-overview');
  const years = vidYears();
  if (!years.length && !vidIsBoss()) {
    const card = vidEl('section', 'card');
    card.appendChild(vidEl('p', 'site-empty', 'Der er ingen videoer endnu.'));
    wrap.appendChild(card);
    return wrap;
  }
  const grid = vidEl('div', 'vid-grid');
  for (const year of years) {
    const tile = vidEl('button', 'vid-tile');
    tile.type = 'button';
    const cover = vidCoverEl(year, 'vid-tile-cover');
    const badge = vidEl('span', 'vid-tile-badge');
    badge.appendChild(vidIcon('play', 18));
    cover.appendChild(badge);
    tile.appendChild(cover);
    tile.appendChild(vidEl('span', 'vid-tile-name', vidYearName(year)));
    tile.appendChild(vidEl('span', 'vid-tile-meta', vidYearMeta(year)));
    tile.addEventListener('click', () => vidGoToYear(year));
    grid.appendChild(tile);
  }
  if (vidIsBoss()) {
    const add = vidEl('div', 'vid-tile vid-tile-add');
    const addBtn = vidEl('button', 'vid-round-btn');
    addBtn.type = 'button';
    addBtn.title = 'Tilføj en revy';
    addBtn.setAttribute('aria-label', 'Tilføj en revy');
    addBtn.appendChild(vidIcon('plus', 24));
    addBtn.addEventListener('click', () => vidOpenNewYearModal());
    add.appendChild(addBtn);
    grid.appendChild(add);
  }
  wrap.appendChild(grid);
  if (!years.length) wrap.appendChild(vidEl('p', 'site-hint vid-empty-hint', 'Der er ingen videoer endnu. Tilføj en revy med "+" og vælg den fra Arkivet.'));
  return wrap;
}

// "+": pick an Arkiv year that has no videos yet.
function vidOpenNewYearModal() {
  const used = new Set(vidState.folders.map((f) => f.archiveFolder));
  const options = vidArchiveYears()
    .filter((y) => !used.has(y.folder))
    .map((y) => ({ value: y.folder, label: y.name || y.folder }));
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj revy');
  modal.classList.add('site-modal-sm');
  if (!options.length) {
    form.appendChild(vidEl('p', 'site-muted', 'Alle revyer i Arkivet er allerede tilføjet.'));
    return;
  }
  form.appendChild(vidEl('p', 'site-hint vid-modal-hint', 'Navn og forside kommer fra revyen i Arkivet. Bagefter kan du uploade videoen.'));
  const field = siteCreateDropdownField(options, '', 'Vælg revy');
  form.appendChild(siteEditField('Revy', field));
  const createBtn = vidPillBtn('Opret', 'site-btn-success');
  createBtn.addEventListener('click', async () => {
    if (!field.value) { error.textContent = 'Vælg en revy.'; return; }
    createBtn.disabled = true;
    error.textContent = '';
    const result = await vidApi('videoer_create', { archiveFolder: field.value });
    createBtn.disabled = false;
    if (!result.ok) { if (result.message) error.textContent = result.message; return; }
    vidState.folders.push(result.data.folder);
    close();
    vidGoToYear(result.data.folder);
  });
  actions.appendChild(createBtn);
}

// ── Year view ────────────────────────────────────────────────
// The year's video (the first, if a year ever got more).
function vidCurrentVideo(year) {
  return vidVideos(year.id)[0] || null;
}

function vidBuildYearView(year) {
  const videos = vidVideos(year.id);
  const video = vidCurrentVideo(year);
  const boss = vidIsBoss();
  const card = vidEl('section', 'card vid-year' + (vidEditing ? ' vid-editing' : ''));

  const top = vidEl('div', 'vid-year-top');
  const back = vidEl('button', 'vid-back');
  back.type = 'button';
  back.appendChild(vidIcon('back', 16));
  back.appendChild(document.createTextNode('Alle videoer'));
  back.addEventListener('click', () => vidGoToOverview());
  top.appendChild(back);
  if (boss) {
    top.appendChild(siteEditToggle(vidEditing, async () => {
      if (vidEditing && vidChapterSaver) await vidChapterSaver.flush();
      vidEditing = !vidEditing;
      vidChapterDraft = null;
      vidRender();
    }, { editLabel: 'Rediger videoen', doneLabel: 'Færdig' }));
  }
  card.appendChild(top);

  const head = vidEl('div', 'vid-year-head');
  head.appendChild(vidEl('h2', 'vid-year-name', vidYearName(year)));
  head.appendChild(vidEl('p', 'vid-year-meta', vidYearMeta(year)));
  card.appendChild(head);

  if (vidEditing) card.appendChild(vidBuildVideoEditor(year, videos));

  if (video) {
    const stage = vidEl('div', 'vid-stage' + (vidChapters(video).length && !vidEditing ? ' vid-stage-side' : ''));
    const main = vidEl('div', 'vid-main');
    main.appendChild(vidEnsurePlayer(video, year));
    main.appendChild(vidBuildStrip());
    main.appendChild(vidBuildControls());
    stage.appendChild(main);
    if (vidEditing) stage.appendChild(vidBuildChapterEditor(year, video));
    else if (vidChapters(video).length) stage.appendChild(vidBuildChapterList(video));
    card.appendChild(stage);
  } else {
    vidPausePlayer();
    card.appendChild(vidEl('p', 'site-empty vid-no-videos', 'Ingen video endnu.'));
  }

  if (boss && !videos.length) card.appendChild(vidBuildEditBar(year));
  if (boss && !videos.length) vidWireDesktopDrop(card, year);
  return card;
}

// ── Player ───────────────────────────────────────────────────
// One <video>, created once and moved into each re-render (a media element
// re-inserted in the same task keeps playing).
const VID_STATE_KEY = 'matrevy-videoer';
const vidPlayer = {
  video: null,
  fileId: null,
  yearId: null,
  subtitleId: null,
  pendingSeek: null, // {fileId, t} to apply once the video has loaded
  retried: false,    // one stream-link refresh per error
};

function vidLoadStored() {
  try {
    const raw = JSON.parse(localStorage.getItem(VID_STATE_KEY) || '{}');
    return raw && typeof raw === 'object' ? raw : {};
  } catch (e) { return {}; }
}

function vidStore(update) {
  try {
    const stored = vidLoadStored();
    update(stored);
    localStorage.setItem(VID_STATE_KEY, JSON.stringify(stored));
  } catch (e) { /* private mode: nothing remembered */ }
}

function vidSubtitlesWanted() {
  return vidLoadStored().subtitles === true;
}

function vidVideoEl() {
  if (vidPlayer.video) return vidPlayer.video;
  const v = document.createElement('video');
  v.className = 'vid-video';
  v.controls = true;
  v.preload = 'metadata';
  v.playsInline = true;
  v.setAttribute('playsinline', '');
  v.addEventListener('play', () => {
    document.dispatchEvent(new CustomEvent('arkiv-media-play', { detail: { source: 'videoer' } }));
    vidInitMediaSession();
    vidPaintNow();
  });
  v.addEventListener('pause', () => vidPaintNow());
  v.addEventListener('ended', () => vidPaintNow());
  v.addEventListener('timeupdate', () => vidPaintNow());
  v.addEventListener('loadedmetadata', vidOnMetadata);
  v.addEventListener('error', vidOnVideoError);
  v.textTracks.addEventListener('change', () => vidPaintSubtitleBtn());
  vidPlayer.video = v;
  return v;
}

// The <video> for `video`, loading it if another one was showing.
function vidEnsurePlayer(video, year) {
  const v = vidVideoEl();
  if (vidPlayer.fileId !== video.id) {
    if (vidPlayer.fileId) v.pause();
    vidPlayer.fileId = video.id;
    vidPlayer.yearId = year.id;
    vidPlayer.retried = false;
    vidPlayer.subtitleId = undefined;
    v.src = vidStreamUrl(video);
  }
  vidSyncTrack(video);
  if (vidPlayer.pendingSeek && vidPlayer.pendingSeek.fileId === video.id && v.readyState >= 1) vidApplyPendingSeek();
  return v;
}

// The <track> follows the video's subtitles (replaced when they change).
function vidSyncTrack(video) {
  const v = vidPlayer.video;
  const sub = vidSubtitle(video);
  const subId = sub ? sub.id : null;
  if (vidPlayer.subtitleId === subId) return;
  vidPlayer.subtitleId = subId;
  v.querySelectorAll('track').forEach((t) => t.remove());
  if (!sub) { vidPaintSubtitleBtn(); return; }
  const track = document.createElement('track');
  track.kind = 'subtitles';
  track.srclang = 'da';
  track.label = 'Dansk';
  track.src = vidStreamUrl(sub);
  v.appendChild(track);
  track.track.mode = vidSubtitlesWanted() ? 'showing' : 'hidden';
  vidPaintSubtitleBtn();
}

function vidTextTrack() {
  const v = vidPlayer.video;
  const t = v ? v.querySelector('track') : null;
  return t ? t.track : null;
}

function vidToggleSubtitles() {
  const track = vidTextTrack();
  if (!track) return;
  const on = track.mode !== 'showing';
  track.mode = on ? 'showing' : 'hidden';
  vidStore((s) => { s.subtitles = on; });
  vidPaintSubtitleBtn();
}

function vidApplyPendingSeek() {
  const p = vidPlayer.pendingSeek;
  const v = vidPlayer.video;
  if (!p || !v || p.fileId !== vidPlayer.fileId) return;
  vidPlayer.pendingSeek = null;
  if (Number.isFinite(p.t)) v.currentTime = p.t;
  if (p.play) vidTryPlay();
}

function vidTryPlay() {
  const v = vidPlayer.video;
  if (!v) return;
  const p = v.play();
  if (p && p.catch) p.catch(() => { /* blocked or interrupted: the controls are there */ });
}

function vidPausePlayer() {
  if (vidPlayer.video && !vidPlayer.video.paused) vidPlayer.video.pause();
}

function vidOnMetadata() {
  const v = vidPlayer.video;
  const file = vidFileById(vidPlayer.fileId);
  vidApplyPendingSeek();
  vidPaintNow();
  // An import whose header gave no length: a boss's first play fills it in.
  if (file && !(file.durationSec > 0) && Number.isFinite(v.duration) && v.duration > 0) {
    file.durationSec = Math.round(v.duration * 10) / 10;
    if (vidIsBoss()) vidApi('videoer_set_duration', { fileId: file.id, durationSec: file.durationSec });
  }
}

// An expired link (a page left open, or a long pause): fetch fresh ones
// and go on from the same spot, once.
async function vidOnVideoError() {
  const v = vidPlayer.video;
  const file = vidFileById(vidPlayer.fileId);
  if (!file || vidPlayer.retried) return;
  vidPlayer.retried = true;
  const at = v.currentTime || 0;
  const wasPlaying = !v.paused || v.autoplay;
  if (!(await vidRefreshStreamUrls())) return;
  vidPlayer.pendingSeek = { fileId: file.id, t: at, play: wasPlaying };
  v.src = vidStreamUrl(file);
  vidPlayer.subtitleId = undefined;
  vidSyncTrack(file);
}

// Jump to `t` and play (a scene row, the strip, previous/next).
function vidSeek(t, play) {
  const v = vidPlayer.video;
  if (!v || !Number.isFinite(t)) return;
  if (v.readyState >= 1) {
    v.currentTime = t;
    if (play) vidTryPlay();
  } else {
    vidPlayer.pendingSeek = { fileId: vidPlayer.fileId, t, play };
    if (play) vidTryPlay();
  }
  vidPaintNow();
}

function vidPlayingVideo() {
  return vidFileById(vidPlayer.fileId);
}

function vidDuration() {
  const v = vidPlayer.video;
  if (v && Number.isFinite(v.duration) && v.duration > 0) return v.duration;
  const file = vidPlayingVideo();
  return file && file.durationSec > 0 ? file.durationSec : 0;
}

// The chapters on show: the editor's draft while editing.
function vidShownChapters() {
  const file = vidPlayingVideo();
  if (vidEditing && vidChapterDraft && file && vidChapterDraft.fileId === file.id) {
    return vidChapterDraft.chapters.filter((c) => Number.isFinite(c.t)).slice().sort((a, b) => a.t - b.t);
  }
  return vidChapters(file);
}

// The index (in vidShownChapters) of the scene playing at `time`, or -1.
function vidChapterIndexAt(chapters, time) {
  let idx = -1;
  for (let i = 0; i < chapters.length; i++) {
    if (chapters[i].t <= time + 0.25) idx = i;
    else break;
  }
  return idx;
}

function vidPrevScene() {
  const v = vidPlayer.video;
  if (!v) return;
  const chapters = vidShownChapters();
  const i = vidChapterIndexAt(chapters, v.currentTime);
  // More than 3 s into a scene: back to its start; else the one before.
  if (i >= 0 && v.currentTime - chapters[i].t > 3) vidSeek(chapters[i].t, !v.paused);
  else if (i > 0) vidSeek(chapters[i - 1].t, !v.paused);
  else vidSeek(0, !v.paused);
}

function vidNextScene() {
  const v = vidPlayer.video;
  if (!v) return;
  const chapters = vidShownChapters();
  const i = vidChapterIndexAt(chapters, v.currentTime);
  if (i + 1 < chapters.length) vidSeek(chapters[i + 1].t, !v.paused);
}

// ── Scene strip, controls and the scene list ─────────────────
function vidBuildStrip() {
  const strip = vidEl('div', 'vid-strip');
  strip.setAttribute('aria-hidden', 'true'); // the scene list is the accessible way
  // A mouse only: the scene under the pointer in a label above it. (A tap
  // on a touch screen sends a fake mousemove but never a mouseleave, which
  // would leave the label standing.)
  strip.addEventListener('pointermove', (e) => {
    if (e.pointerType === 'mouse') vidShowStripTip(strip, e.clientX);
    else vidHideStripTip();
  });
  strip.addEventListener('pointerleave', () => vidHideStripTip());
  return strip;
}

// The strip is rebuilt when the chapters or the length change, and only
// repainted (current scene, playhead) on timeupdate. Each segment sits at
// its exact place on the timeline (left/width in % of the length), so the
// boundaries and the playhead line up with the times; the gap between two
// segments is drawn inside the earlier one.
function vidPaintStrip(chapters, current, time, duration) {
  const strip = document.querySelector('.vid-strip');
  if (!strip) return;
  const key = duration ? chapters.map((c) => c.t + '|' + c.label).join('/') + '#' + Math.round(duration) : '';
  strip.hidden = !chapters.length || !duration;
  if (strip.hidden) return;
  const pct = (t) => `${Math.max(0, Math.min(100, (t / duration) * 100))}%`;
  if (strip.dataset.key !== key) {
    strip.dataset.key = key;
    strip._vidChapters = chapters;
    strip._vidDuration = duration;
    strip.replaceChildren();
    chapters.forEach((c, i) => {
      const end = i + 1 < chapters.length ? chapters[i + 1].t : duration;
      if (end <= c.t) return;
      const seg = vidEl('button', 'vid-strip-seg' + (i + 1 === chapters.length ? ' vid-strip-last' : ''));
      seg.type = 'button';
      seg.tabIndex = -1;
      seg.style.left = pct(c.t);
      seg.style.width = `calc(${pct(end)} - ${pct(c.t)})`;
      seg.dataset.index = String(i);
      seg.addEventListener('click', () => vidSeek(c.t, true));
      strip.appendChild(seg);
    });
    strip.appendChild(vidEl('span', 'vid-strip-head'));
  }
  strip.querySelectorAll('.vid-strip-seg').forEach((seg) => {
    seg.classList.toggle('vid-strip-current', seg.dataset.index === String(current));
  });
  strip.style.setProperty('--vid-pos', pct(time));
}

// The hover label (fixed on <body>, like the site's other tooltips): the
// scene's name and start time, centred over the pointer, clamped on-screen.
let vidStripTip = null;

function vidShowStripTip(strip, clientX) {
  const chapters = strip._vidChapters || [];
  const duration = strip._vidDuration || 0;
  if (!chapters.length || !duration || strip.hidden) return;
  const rect = strip.getBoundingClientRect();
  const t = ((clientX - rect.left) / rect.width) * duration;
  const i = vidChapterIndexAt(chapters, t);
  if (i < 0) { vidHideStripTip(); return; }
  if (!vidStripTip) {
    vidStripTip = vidEl('div', 'vid-strip-tip');
    vidStripTip.setAttribute('role', 'tooltip');
    document.body.appendChild(vidStripTip);
  }
  const tip = vidStripTip;
  if (tip._vidIndex !== i) {
    tip._vidIndex = i;
    tip.replaceChildren(
      vidEl('span', 'vid-strip-tip-label', vidChapterLabel(chapters[i])),
      vidEl('span', 'vid-strip-tip-time', vidFormatTime(chapters[i].t)),
    );
  }
  tip.hidden = false;
  const w = tip.offsetWidth;
  const left = Math.max(8, Math.min(window.innerWidth - w - 8, clientX - w / 2));
  tip.style.left = `${left}px`;
  tip.style.top = `${rect.top - tip.offsetHeight - 8}px`;
}

function vidHideStripTip() {
  if (vidStripTip) vidStripTip.hidden = true;
}

// Belt and braces: the label also goes as soon as the pointer is anywhere
// but the strip (a strip replaced under the pointer never sends a leave),
// leaves the window, or the window loses focus.
document.addEventListener('pointermove', (e) => {
  if (vidStripTip && !vidStripTip.hidden && !(e.target instanceof Element && e.target.closest('.vid-strip'))) vidHideStripTip();
}, true);
document.documentElement.addEventListener('mouseleave', () => vidHideStripTip());
window.addEventListener('blur', () => vidHideStripTip());

function vidBuildControls() {
  const row = vidEl('div', 'vid-controls');
  const prev = vidIconBtn('prev', 'Forrige scene (,)', 'vid-ctl-prev', 18);
  prev.addEventListener('click', () => vidPrevScene());
  const next = vidIconBtn('next', 'Næste scene (.)', 'vid-ctl-next', 18);
  next.addEventListener('click', () => vidNextScene());
  const now = vidEl('div', 'vid-now');
  now.appendChild(vidEl('span', 'vid-now-label'));
  // Previous scene, the scene's name, subtitles, next scene (rightmost).
  const tools = vidEl('div', 'vid-tools');
  const cc = vidIconBtn('cc', 'Undertekster', 'vid-ctl-cc', 20);
  cc.addEventListener('click', () => vidToggleSubtitles());
  tools.appendChild(cc);
  row.appendChild(prev);
  row.appendChild(now);
  row.appendChild(tools);
  row.appendChild(next);
  return row;
}

function vidPaintSubtitleBtn() {
  const btn = document.querySelector('.vid-ctl-cc');
  if (!btn) return;
  const track = vidTextTrack();
  btn.hidden = !track;
  const on = !!track && track.mode === 'showing';
  btn.classList.toggle('site-icon-on', on);
  btn.setAttribute('aria-pressed', on ? 'true' : 'false');
  btn.title = on ? 'Slå undertekster fra' : 'Slå undertekster til';
  btn.setAttribute('aria-label', btn.title);
}

function vidBuildChapterList(video) {
  const side = vidEl('div', 'vid-side');
  side.appendChild(vidEl('h3', 'vid-side-title', 'Scener'));
  const list = vidEl('ol', 'vid-chapters');
  vidChapters(video).forEach((ch, i) => {
    const row = vidEl('li', 'vid-chapter');
    row.dataset.index = String(i);
    const main = vidEl('button', 'vid-chapter-main');
    main.type = 'button';
    main.appendChild(vidEl('span', 'vid-chapter-time', vidFormatTime(ch.t)));
    main.appendChild(vidEl('span', 'vid-chapter-label', vidChapterLabel(ch)));
    main.addEventListener('click', () => vidSeek(ch.t, true));
    row.appendChild(main);
    list.appendChild(row);
  });
  side.appendChild(list);
  return side;
}

let vidLastCurrent = null;
// Everything that follows the playhead: the strip, the scene label, the
// highlighted row and the lock screen title.
function vidPaintNow() {
  const v = vidPlayer.video;
  if (!v || !document.contains(v)) return;
  const chapters = vidShownChapters();
  const time = v.currentTime || 0;
  const duration = vidDuration();
  const i = vidChapterIndexAt(chapters, time);
  vidPaintStrip(chapters, i, time, duration);

  const label = document.querySelector('.vid-now-label');
  if (label) label.textContent = i >= 0 ? vidChapterLabel(chapters[i]) : (chapters.length ? 'Før første scene' : '');
  const prev = document.querySelector('.vid-ctl-prev');
  const next = document.querySelector('.vid-ctl-next');
  if (prev) prev.hidden = !chapters.length;
  if (next) {
    next.hidden = !chapters.length;
    next.disabled = i + 1 >= chapters.length;
  }

  const key = vidPlayer.fileId + ':' + i;
  if (key !== vidLastCurrent) {
    vidLastCurrent = key;
    document.querySelectorAll('.vid-chapter').forEach((row) => {
      const on = row.dataset.index === String(i);
      row.classList.toggle('vid-chapter-current', on);
      if (on && !v.paused) vidScrollIntoList(row);
    });
    vidUpdateMediaSession(i >= 0 ? chapters[i] : null);
  }
  vidPaintSubtitleBtn();
}

// Keeps the current scene visible inside the list (not the page).
function vidScrollIntoList(row, listSelector) {
  const list = row.closest(listSelector || '.vid-chapters');
  if (!list || list.scrollHeight <= list.clientHeight) return;
  const top = row.offsetTop - list.offsetTop;
  if (top < list.scrollTop || top + row.offsetHeight > list.scrollTop + list.clientHeight) {
    list.scrollTop = Math.max(0, top - list.clientHeight / 3);
  }
}

// ── Lock screen / Control Center (Media Session) ─────────────
function vidUpdateMediaSession(chapter) {
  if (!('mediaSession' in navigator) || typeof MediaMetadata === 'undefined') return;
  const v = vidPlayer.video;
  if (!v || v.paused) return; // Albums owns it while the music plays
  const file = vidPlayingVideo();
  const year = file ? vidYearById(file.folderId) : null;
  const cover = vidYearCover(year);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: chapter ? vidChapterLabel(chapter) : vidTitle(file),
    artist: vidYearName(year),
    album: 'Matematikrevyen',
    artwork: cover ? [{ src: new URL(cover, location.href).href, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
}

// Set on every play (Albums sets its own when the music starts).
function vidInitMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) { /* unsupported */ }
  };
  const v = vidPlayer.video;
  set('play', () => vidTryPlay());
  set('pause', () => v.pause());
  set('previoustrack', () => vidPrevScene());
  set('nexttrack', () => vidNextScene());
  set('seekbackward', null);
  set('seekforward', null);
  set('seekto', (details) => { if (Number.isFinite(details.seekTime)) v.currentTime = details.seekTime; });
  vidLastCurrent = null;
  vidPaintNow();
}

// ── Editing (boss): the year's video ─────────────────────────
// One row per video (normally just the one): length · size, subtitles,
// download, delete, and the probe's warnings.
function vidBuildVideoEditor(year, videos) {
  const box = vidEl('div', 'vid-edit-videos');
  const list = vidEl('ol', 'vid-edit-list');
  // A revy without a video yet: admin can still remove it (✕).
  if (!videos.length) {
    if (!vidIsAdmin()) return box;
    const row = vidEl('li', 'vid-edit-row');
    row.appendChild(vidEl('span', 'vid-edit-name', 'Ingen video endnu'));
    const tools = vidEl('span', 'vid-edit-tools');
    const remove = vidRemoveBtn('Fjern revyen fra Videoer');
    remove.addEventListener('click', () => vidConfirmRemoveRevy(year));
    tools.appendChild(remove);
    row.appendChild(tools);
    list.appendChild(row);
    box.appendChild(list);
    return box;
  }
  for (const video of videos) {
    const row = vidEl('li', 'vid-edit-row');
    row.appendChild(vidEl('span', 'vid-edit-name', 'Video'));
    const info = vidEl('span', 'vid-edit-info');
    info.textContent = [video.durationSec > 0 ? vidFormatTime(video.durationSec) : '', vidFormatBytes(video.size || 0)]
      .filter(Boolean).join(' · ');
    row.appendChild(info);

    const tools = vidEl('span', 'vid-edit-tools');
    // Subtitles: the CC icon, amber when the video has them. Without: it
    // uploads; with: a menu to download (to correct them), replace or remove.
    const sub = vidSubtitle(video);
    const subBtn = vidIconBtn('cc', sub ? 'Undertekster' : 'Upload undertekster (.srt, .sbv eller .vtt)',
      'site-icon-btn-sm vid-sub-btn' + (sub ? ' site-icon-on' : ''), 18);
    if (sub) subBtn.setAttribute('aria-haspopup', 'menu');
    subBtn.addEventListener('click', () => (sub ? vidOpenSubtitleMenu(subBtn, video, sub) : vidPickSubtitles(video)));
    tools.appendChild(subBtn);
    const dl = vidIconBtn('download', 'Download videoen', 'site-icon-btn-sm', 14);
    dl.addEventListener('click', () => vidDownload(video));
    tools.appendChild(dl);
    // Admin only: removes the whole revy (video, scenes, subtitles).
    if (vidIsAdmin()) {
      const remove = vidRemoveBtn('Slet videoen og fjern revyen fra Videoer');
      remove.addEventListener('click', () => vidConfirmRemoveRevy(year));
      tools.appendChild(remove);
    }
    row.appendChild(tools);

    const warnings = vidVideoWarnings(video);
    if (warnings.length) {
      const warn = vidEl('p', 'vid-warn');
      warn.textContent = warnings.join(' ');
      row.appendChild(warn);
    }
    list.appendChild(row);
  }
  box.appendChild(list);
  return box;
}

// What the server read from the file (videoer_mp4_probe) that will hurt.
function vidVideoWarnings(video) {
  const out = [];
  const codecs = Array.isArray(video.codecs) ? video.codecs : [];
  if (codecs.some((c) => c === 'hvc1' || c === 'hev1')) {
    out.push('Videoen er HEVC (H.265), som ikke alle browsere kan afspille. Konverter den til H.264.');
  } else if (codecs.length && !codecs.includes('avc1')) {
    out.push(`Videoen er ikke H.264 (${codecs.join(', ')}). Den virker måske ikke i alle browsere.`);
  }
  if (video.faststart === false) {
    out.push(`Videoen er ikke optimeret til streaming, så den starter langsomt. Ret den med: ${VID_FASTSTART_FIX}`);
  }
  return out;
}

function vidConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('site-confirm-modal');
  if (description) form.appendChild(vidEl('p', 'site-confirm-sub', description));
  const cancelBtn = vidPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = vidPillBtn(confirmLabel, 'site-btn-danger');
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

// Admin: ✕ removes the revy from Videoer, video, scenes and subtitles
// with it. Two steps (Fortsæt, then Slet), since a 1-2 GB upload and an
// evening of marking scenes are gone for good.
function vidConfirmRemoveRevy(year) {
  const hasVideo = vidVideos(year.id).length > 0;
  const first = siteOpenEditModal(hasVideo ? 'Slet videoen?' : 'Fjern revyen?');
  first.modal.classList.add('site-confirm-modal');
  first.form.appendChild(vidEl('p', 'site-confirm-sub', hasVideo
    ? `Videoen til ${vidYearName(year)} slettes fra serveren, med alle scener og undertekster, og revyen fjernes fra Videoer.`
    : `${vidYearName(year)} fjernes fra Videoer.`));
  const cancel1 = vidPillBtn('Annuller');
  cancel1.addEventListener('click', first.close);
  const next = vidPillBtn('Fortsæt', 'site-btn-danger');
  next.addEventListener('click', () => {
    first.close();
    vidConfirm('Er du sikker?', 'Dette kan ikke fortrydes.', 'Slet', async () => {
      const result = await vidApi('videoer_delete', { folderId: year.id });
      if (!result.ok) { vidShowError(result.message); return false; }
      vidState.folders = vidState.folders.filter((f) => f.id !== year.id);
      vidState.files = vidState.files.filter((f) => f.folderId !== year.id);
      if (vidPlayer.yearId === year.id) vidResetPlayer();
      vidChapterDraft = null;
      vidEditing = false;
      vidGoToOverview();
      siteShowToast(`${vidYearName(year)} er fjernet fra Videoer.`);
      return true;
    });
  });
  first.actions.appendChild(cancel1);
  first.actions.appendChild(next);
}

// Forget the loaded video (it was deleted).
function vidResetPlayer() {
  const v = vidPlayer.video;
  if (v) {
    v.pause();
    v.removeAttribute('src');
    v.querySelectorAll('track').forEach((t) => t.remove());
    v.load();
  }
  vidPlayer.fileId = null;
  vidPlayer.yearId = null;
  vidPlayer.subtitleId = null;
}

// A revy without a video: upload it (or, admin, import it).
function vidBuildEditBar(year) {
  const bar = vidEl('div', 'vid-edit-bar');
  const uploadBtn = vidBtn('Upload video');
  uploadBtn.addEventListener('click', () => vidPickVideos(year));
  bar.appendChild(uploadBtn);
  if (vidIsAdmin()) {
    const importBtn = vidBtn('Importér fra serveren');
    importBtn.addEventListener('click', () => vidOpenImportModal(year));
    bar.appendChild(importBtn);
  }
  return bar;
}

// ── Downloads (boss) ─────────────────────────────────────────
// A hidden iframe starts the download without leaving the page; iOS gets a
// new tab instead, opened inside the click so it isn't blocked.
let vidDownloadFrame = null;

// `file` is the video or its subtitles (both are files in the store).
async function vidDownload(file, toast) {
  const win = siteIsIos() ? window.open('', '_blank') : null;
  const result = await vidApi('videoer_download_url', { fileId: file.id });
  if (!result.ok) {
    if (win) win.close();
    vidShowError(result.message);
    return;
  }
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  const url = SITE_API_ENDPOINT + sep + result.data.query;
  if (siteIsIos()) {
    if (win) win.location.replace(url);
    else siteShowToast('Tillad pop op-vinduer for at downloade.');
    return;
  }
  if (!vidDownloadFrame) {
    vidDownloadFrame = document.createElement('iframe');
    vidDownloadFrame.hidden = true;
    vidDownloadFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(vidDownloadFrame);
  }
  vidDownloadFrame.src = url;
  siteShowToast(toast || `Downloader videoen (${vidFormatBytes(file.size || 0)}) …`);
}

// ── Chapter editor (boss) ────────────────────────────────────
// The rows as the boss has them: [{t, uid, label}], t null = not marked
// yet. Saved whole (videoer_set_chapters, with the version it started
// from) by an autosave; marked rows are kept in time order, unmarked ones
// stay where they are.
let vidChapterDraft = null; // {fileId, chapters, version}
let vidChapterSaver = null;
let vidChapterStatusEl = null;

function vidDraftFor(video) {
  if (!vidChapterDraft || vidChapterDraft.fileId !== video.id) {
    vidChapterDraft = {
      fileId: video.id,
      chapters: (video.chapters || []).map((c) => ({ t: Number.isFinite(c.t) ? c.t : null, uid: c.uid || null, label: c.label || '' })),
      version: video.chaptersVersion || 0,
    };
  }
  return vidChapterDraft;
}

// Marked rows sorted by time into the marked rows' places; unmarked rows
// keep theirs (so "Marker næste" keeps working down the manus order).
function vidSortDraft(rows) {
  const slots = [];
  rows.forEach((r, i) => { if (Number.isFinite(r.t)) slots.push(i); });
  const timed = slots.map((i) => rows[i]).sort((a, b) => a.t - b.t);
  const out = rows.slice();
  slots.forEach((slot, k) => { out[slot] = timed[k]; });
  return out;
}

function vidChapterSaverFor() {
  if (vidChapterSaver) return vidChapterSaver;
  vidChapterSaver = siteCreateAutosave({
    save: async () => {
      const draft = vidChapterDraft;
      if (!draft) return { ok: true };
      const fileId = draft.fileId;
      const sent = vidSortDraft(draft.chapters).map((c) => ({ t: c.t, uid: c.uid, label: c.label.trim() }));
      const result = await vidApi('videoer_set_chapters', { fileId, chapters: sent, baseVersion: draft.version });
      const file = vidFileById(fileId);
      if (!result.ok) {
        if (result.status === 409 && result.data && file) {
          // Someone else saved meanwhile: show theirs (after this save).
          file.chapters = result.data.chapters || [];
          file.chaptersVersion = result.data.chaptersVersion || 0;
          if (vidChapterDraft && vidChapterDraft.fileId === fileId) vidChapterDraft = null;
          setTimeout(() => vidRender(), 0);
          return { ok: false, message: 'en anden har lige ændret scenerne. Siden viser nu deres.' };
        }
        return { ok: false, message: result.message || 'kunne ikke gemme.' };
      }
      if (file) {
        file.chapters = result.data.chapters;
        file.chaptersVersion = result.data.chaptersVersion;
      }
      if (vidChapterDraft && vidChapterDraft.fileId === fileId) vidChapterDraft.version = result.data.chaptersVersion;
      return { ok: true };
    },
    onStatus: (state, message) => {
      const node = vidChapterStatusEl;
      if (!node) return;
      node.classList.toggle('dirty', state === 'saving');
      node.classList.toggle('error', state === 'error');
      node.textContent = state === 'saving' ? 'Gemmer…'
        : state === 'error' ? `Ikke gemt: ${message}` : 'Gemmes automatisk · Gemt';
    },
  });
  return vidChapterSaver;
}

function vidChaptersChanged() {
  vidChapterSaverFor().schedule();
  vidPaintNow();
}

function vidCurrentTime() {
  const v = vidPlayer.video;
  return v && Number.isFinite(v.currentTime) ? Math.round(v.currentTime * 10) / 10 : 0;
}

function vidBuildChapterEditor(year, video) {
  const draft = vidDraftFor(video);
  draft.chapters = vidSortDraft(draft.chapters);
  const box = vidEl('div', 'vid-chapter-editor');

  const head = vidEl('div', 'vid-ce-head');
  head.appendChild(vidEl('h3', 'vid-edit-title', 'Scener'));
  vidChapterStatusEl = vidEl('span', 'site-save-status vid-ce-status', 'Gemmes automatisk');
  head.appendChild(vidChapterStatusEl);
  box.appendChild(head);

  const bar = vidEl('div', 'vid-ce-bar');
  const insertBtn = vidBtn('Indsæt scener fra manus');
  insertBtn.hidden = true;
  insertBtn.addEventListener('click', () => vidOpenInsertScenes(year));
  vidLoadSnapshot(year.archiveFolder).then((snap) => { if (snap && snap.acts.length) insertBtn.hidden = false; });
  bar.appendChild(insertBtn);
  box.appendChild(bar);

  const list = vidEl('ol', 'vid-ce-list');
  if (!draft.chapters.length) list.appendChild(vidEl('li', 'site-empty vid-ce-empty', 'Ingen scener endnu.'));
  draft.chapters.forEach((ch, i) => list.appendChild(vidBuildChapterRow(ch, i)));
  box.appendChild(list);
  const addBtn = vidEl('button', 'site-icon-btn site-add-plus site-add-center', '+');
  addBtn.type = 'button';
  addBtn.title = 'Tilføj et kapitel ved den nuværende tid (fx Pause eller Takkesang)';
  addBtn.setAttribute('aria-label', 'Tilføj et kapitel');
  addBtn.addEventListener('click', () => vidAddChapter());
  box.appendChild(addBtn);
  return box;
}

function vidBuildChapterRow(ch) {
  const row = vidEl('li', 'vid-ce-row' + (Number.isFinite(ch.t) ? '' : ' vid-ce-unmarked'));
  const time = vidEl('input', 'site-inline-field vid-ce-time');
  time.type = 'text';
  time.inputMode = 'decimal';
  time.placeholder = '-:--';
  time.setAttribute('aria-label', 'Tid');
  const show = () => { time.value = Number.isFinite(ch.t) ? vidFormatTime(ch.t) : ''; };
  show();
  time.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); time.blur(); }
    if (e.key === 'Escape') { show(); time.blur(); }
  });
  time.addEventListener('change', () => {
    const raw = time.value.trim();
    const t = raw === '' ? null : vidParseTimestamp(raw);
    if (raw !== '' && t === null) { vidShowError('Skriv tiden som fx 1:02:03.'); show(); return; }
    ch.t = t;
    row.classList.toggle('vid-ce-unmarked', !Number.isFinite(t));
    show();
    vidChaptersChanged();
  });
  row.appendChild(time);

  const go = vidIconBtn('play', 'Gå hertil i videoen', 'site-icon-btn-sm vid-ce-go', 12);
  go.disabled = !Number.isFinite(ch.t);
  go.addEventListener('click', () => vidSeek(ch.t, true));
  row.appendChild(go);

  const label = vidEl('input', 'site-inline-field vid-ce-label');
  label.type = 'text';
  label.maxLength = 200;
  label.value = ch.label;
  label.placeholder = 'Navn på scenen';
  label.setAttribute('aria-label', 'Navn');
  label.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); label.blur(); } });
  label.addEventListener('input', () => {
    ch.label = label.value;
    vidChaptersChanged();
  });
  row.appendChild(label);

  const remove = vidRemoveBtn('Fjern scenen');
  remove.addEventListener('click', () => {
    const draft = vidChapterDraft;
    if (!draft) return;
    draft.chapters = draft.chapters.filter((c) => c !== ch);
    vidChaptersChanged();
    vidRender();
  });
  row.appendChild(remove);
  return row;
}

function vidAddChapter() {
  const file = vidPlayingVideo();
  if (!file) return;
  const draft = vidDraftFor(file);
  const ch = { t: vidCurrentTime(), uid: null, label: '' };
  draft.chapters.push(ch);
  vidChaptersChanged();
  vidRender();
  const rows = Array.from(document.querySelectorAll('.vid-ce-row'));
  const idx = vidChapterDraft.chapters.indexOf(ch);
  const input = rows[idx] && rows[idx].querySelector('.vid-ce-label');
  if (input) {
    vidScrollIntoList(rows[idx], '.vid-ce-list');
    input.focus({ preventScroll: true });
  }
}

// The year's scene list from Arkiv (archive/<folder>/snapshot/scenes.json,
// public). Cached per folder; null when the year has none.
const vidSnapshotCache = {};
function vidLoadSnapshot(folder) {
  if (!vidSnapshotCache[folder]) {
    vidSnapshotCache[folder] = fetch(`archive/${encodeURIComponent(folder)}/snapshot/scenes.json`, { cache: 'no-cache' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => {
        if (!data || !Array.isArray(data.acts)) return null;
        const acts = data.acts
          .map((act) => ({
            label: act.label || `Akt ${act.act}`,
            scenes: (Array.isArray(act.scenes) ? act.scenes : [])
              .filter((s) => s && s.uid)
              .map((s) => ({ uid: String(s.uid), label: [s.id, s.name].filter(Boolean).join(' ') })),
          }))
          .filter((act) => act.scenes.length);
        return { acts };
      })
      .catch(() => null);
  }
  return vidSnapshotCache[folder];
}

async function vidOpenInsertScenes(year) {
  const file = vidPlayingVideo();
  const snap = await vidLoadSnapshot(year.archiveFolder);
  if (!file || !snap) return;
  const draft = vidDraftFor(file);
  const have = new Set(draft.chapters.map((c) => c.uid).filter(Boolean));
  const { modal, form, actions, close } = siteOpenModalWithClose('Indsæt scener fra manus');
  modal.classList.add('site-modal-sm');
  form.appendChild(vidEl('p', 'site-hint vid-modal-hint',
    `Scenerne fra ${vidYearName(year)}s manus kommer i rækkefølge uden tid, klar til at blive markeret. Scener der allerede er med, springes over.`));
  const checks = snap.acts.map((act) => {
    const fresh = act.scenes.filter((s) => !have.has(s.uid));
    const label = vidEl('label', 'vid-act-check');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = fresh.length > 0;
    box.disabled = !fresh.length;
    label.appendChild(box);
    label.appendChild(document.createTextNode(` ${act.label} (${fresh.length ? vidPlural(fresh.length, 'scene', 'scener') : 'alle er med'})`));
    form.appendChild(label);
    return { box, fresh };
  });
  const insertBtn = vidPillBtn('Indsæt', 'site-btn-success');
  insertBtn.addEventListener('click', () => {
    let added = 0;
    for (const { box, fresh } of checks) {
      if (!box.checked) continue;
      for (const s of fresh) { draft.chapters.push({ t: null, uid: s.uid, label: s.label }); added++; }
    }
    close();
    if (!added) return;
    vidChaptersChanged();
    vidRender();
    siteShowToast(`${vidPlural(added, 'scene', 'scener')} indsat.`);
  });
  actions.appendChild(insertBtn);
}

// ── Subtitles (boss) ─────────────────────────────────────────
function vidPickSubtitles(video) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.srt,.sbv,.vtt,text/vtt,application/x-subrip';
  input.addEventListener('change', async () => {
    const file = input.files && input.files[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { vidShowError('Filen er for stor til at være undertekster (højst 2 MB).'); return; }
    let text;
    try { text = vidDecodeText(await file.arrayBuffer()); } catch (e) { vidShowError('Kunne ikke læse filen.'); return; }
    const vtt = vidToVtt(text);
    if (!vtt) { vidShowError('Filen ligner ikke undertekster (.srt, .sbv eller .vtt).'); return; }
    vidOpenSubtitlePreview(video, file.name, vtt);
  });
  input.click();
}

// UTF-8, or Windows-1252 for old Danish .srt files (æøå would be garbled).
function vidDecodeText(buffer) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch (e) {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

// SRT, SBV (YouTube's format) or WebVTT text → WebVTT ('' if there are no
// cues). SRT's cue numbers go, its "00:00:01,000" becomes "00:00:01.000",
// and {\an8}-style tags are dropped. SBV's timing line
// "0:00:01.000,0:00:05.500" becomes "00:00:01.000 --> 00:00:05.500", and
// its [br] a line break.
function vidToVtt(text) {
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (/^WEBVTT(?:[ \t\n]|$)/.test(src)) return src.includes('-->') ? src + '\n' : '';
  const stamp = (s) => s.replace(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/g,
    (m, h, mm, ss, ms) => `${h.padStart(2, '0')}:${mm}:${ss}.${ms.padEnd(3, '0')}`);
  const cues = [];
  for (const block of src.split(/\n{2,}/)) {
    const lines = block.split('\n').map((l) => l.replace(/\{\\[^}]*\}/g, ''));
    if (lines.length > 1 && /^\d+$/.test(lines[0].trim()) && lines[1].includes('-->')) lines.shift();
    const sbv = lines.length ? /^\s*(\d+:\d{2}:\d{2}\.\d{1,3}),(\d+:\d{2}:\d{2}\.\d{1,3})\s*$/.exec(lines[0]) : null;
    if (sbv) lines[0] = `${sbv[1]} --> ${sbv[2]}`;
    if (!lines.length || !lines[0].includes('-->')) continue;
    lines[0] = stamp(lines[0]);
    const body = lines.slice(1)
      .flatMap((l) => l.split(/\[br\]/i))
      .filter((l) => l.trim() !== '');
    if (body.length) cues.push([lines[0], ...body].join('\n'));
  }
  return cues.length ? 'WEBVTT\n\n' + cues.join('\n\n') + '\n' : '';
}

function vidOpenSubtitlePreview(video, fileName, vtt) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Undertekster');
  modal.classList.add('site-modal-md');
  const cues = vtt.split(/\n{2,}/).filter((b) => b.includes('-->'));
  form.appendChild(vidEl('p', 'site-hint vid-modal-hint',
    `${fileName}: ${vidPlural(cues.length, 'replik', 'replikker')}. De første:`));
  const preview = vidEl('div', 'vid-sub-preview');
  for (const cue of cues.slice(0, 3)) {
    const [timing, ...lines] = cue.split('\n');
    const item = vidEl('div', 'vid-sub-cue');
    item.appendChild(vidEl('span', 'vid-sub-time', timing.replace(/\.\d+/g, '').split(' ')[0]));
    item.appendChild(vidEl('span', 'vid-sub-text', lines.filter((l) => l.trim()).join(' / ')));
    preview.appendChild(item);
  }
  form.appendChild(preview);
  form.appendChild(vidEl('p', 'site-hint vid-modal-hint', 'Ser æ, ø og å forkerte ud? Gem filen som UTF-8 og prøv igen.'));
  const saveBtn = vidPillBtn('Gem', 'site-btn-success');
  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    error.textContent = '';
    const ok = await vidSaveSubtitles(video, vtt);
    saveBtn.disabled = false;
    if (ok) close();
    else error.textContent = 'Underteksterne blev ikke gemt.';
  });
  actions.appendChild(saveBtn);
}

async function vidSaveSubtitles(video, vtt) {
  const result = await vidApi('videoer_set_subtitles', { fileId: video.id, vtt });
  if (!result.ok) { vidShowError(result.message); return false; }
  vidState.files = vidState.files.filter((f) => f.subtitleFor !== video.id);
  if (result.data.subtitle) vidState.files.push(result.data.subtitle);
  Object.assign(video, result.data.file);
  if (result.data.urls) Object.assign(vidStreamUrls, result.data.urls);
  vidRender();
  siteShowToast(vtt ? 'Underteksterne er gemt.' : 'Underteksterne er fjernet.');
  return true;
}

function vidOpenSubtitleMenu(anchor, video, sub) {
  siteToggleFieldPopup(anchor, () => {
    const pop = vidEl('div', 'site-field-pop site-dd-pop vid-menu-pop');
    const item = (label, onClick) => {
      const row = vidEl('button', 'site-list-row', label);
      row.type = 'button';
      row.addEventListener('click', () => { close(); onClick(); });
      pop.appendChild(row);
    };
    item('Download undertekster (.vtt)', () => vidDownload(sub, 'Downloader underteksterne …'));
    item('Upload nye undertekster', () => vidPickSubtitles(video));
    item('Fjern underteksterne', () => vidConfirm('Fjern underteksterne?', 'Dette kan ikke fortrydes.', 'Fjern', () => vidSaveSubtitles(video, '')));
    const close = siteOpenFieldPopup(anchor, pop);
  });
}

// ── Upload (boss) ────────────────────────────────────────────
function vidPickVideos(year) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/mp4,' + VID_VIDEO_EXTS.map((ext) => '.' + ext).join(',');
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    if (picked.length) vidOpenUploadModal(picked, year);
  });
  input.click();
}

// A desktop file dropped on the card of a revy without a video uploads it.
function vidWireDesktopDrop(card, year) {
  const isFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');
  card.addEventListener('dragover', (e) => {
    if (!isFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('vid-file-dragover');
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('vid-file-dragover');
  });
  card.addEventListener('drop', (e) => {
    card.classList.remove('vid-file-dragover');
    if (!e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    vidOpenUploadModal(Array.from(e.dataTransfer.files), year);
  });
}

function vidFileExt(name) {
  return (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
}

// Reads the MP4's own index before uploading (the same as the server's
// videoer_mp4_probe): length, faststart and the track formats. Walks the
// top-level boxes with File.slice, so only a few small reads plus `moov`.
async function vidProbeMp4(file) {
  const out = { durationSec: null, faststart: null, codecs: [] };
  const read = async (start, len) => new DataView(await file.slice(start, start + len).arrayBuffer());
  try {
    let pos = 0;
    let mdatAt = null;
    let moov = null;
    for (let i = 0; i < 1000 && pos + 8 <= file.size; i++) {
      const head = await read(pos, 16);
      if (head.byteLength < 8) break;
      let size = head.getUint32(0);
      const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
      let headLen = 8;
      if (size === 1) {
        if (head.byteLength < 16) break;
        size = Number(head.getBigUint64(8));
        headLen = 16;
      } else if (size === 0) {
        size = file.size - pos;
      }
      if (size < headLen) break;
      if (type === 'mdat' && mdatAt === null) mdatAt = pos;
      if (type === 'moov' && !moov && size - headLen <= 64 * 1024 * 1024) {
        moov = new Uint8Array(await file.slice(pos + headLen, pos + size).arrayBuffer());
        out.faststart = mdatAt === null;
      }
      pos += size;
    }
    if (!moov) return out;
    const find = (needle, from) => {
      const n = [...needle].map((c) => c.charCodeAt(0));
      for (let i = from; i + 4 <= moov.length; i++) {
        if (moov[i] === n[0] && moov[i + 1] === n[1] && moov[i + 2] === n[2] && moov[i + 3] === n[3]) return i;
      }
      return -1;
    };
    const dv = new DataView(moov.buffer);
    const at = find('mvhd', 0);
    if (at >= 0 && at + 36 <= moov.length) {
      const b = at + 4;
      const v1 = moov[b] === 1;
      const scale = dv.getUint32(b + (v1 ? 20 : 12));
      const dur = v1 ? Number(dv.getBigUint64(b + 24)) : dv.getUint32(b + 16);
      if (scale > 0 && dur > 0) out.durationSec = Math.round((dur / scale) * 10) / 10;
    }
    let from = 0;
    let s;
    while ((s = find('stsd', from)) >= 0 && out.codecs.length < 10) {
      if (s + 20 <= moov.length) {
        const f = String.fromCharCode(moov[s + 16], moov[s + 17], moov[s + 18], moov[s + 19]);
        if (/^[A-Za-z0-9 .]{4}$/.test(f) && !out.codecs.includes(f)) out.codecs.push(f);
      }
      from = s + 4;
    }
  } catch (e) { /* not an MP4 we can read: the playable check decides */ }
  return out;
}

// Can this browser play it at all? (A hidden <video> on a local URL.)
function vidCheckPlayable(file) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    // A background tab can take long: don't call that unplayable.
    const timer = setTimeout(() => finish(null), 15000);
    v.addEventListener('loadedmetadata', () => finish(v.videoWidth > 0));
    v.addEventListener('error', () => finish(false));
    v.src = url;
  });
}

function vidUsedBytesQueued() {
  return vidQueue.reduce((sum, item) => sum + (item.state === 'failed' ? 0 : item.file.size), 0);
}

// The stored name of the year's video (shown nowhere; downloads use it).
const VID_VIDEO_NAME = 'Hele revyen';

// One video, checked before any bytes go: playable here, H.264, faststart.
function vidOpenUploadModal(files, year) {
  if (files.length > 1) siteShowToast('Kun én video pr. revy: den første fil bruges.');
  const file = files[0];
  if (!VID_VIDEO_EXTS.includes(vidFileExt(file.name))) {
    siteShowToast(`"${file.name}" kan ikke uploades (kun .mp4 og .m4v).`);
    return;
  }
  if (!file.size) { siteShowToast(`"${file.name}" er tom.`); return; }

  const { modal, form, error, actions, close } = siteOpenModalWithClose('Upload video');
  modal.classList.add('site-modal-md', 'vid-upload-modal');
  form.appendChild(vidEl('p', 'vid-upload-hint', `Hele revyen til ${vidYearName(year)}.`));
  const item = vidEl('div', 'edit-field vid-upload-item');
  const head = vidEl('div', 'vid-upload-item-head');
  head.appendChild(vidEl('span', 'vid-upload-item-name', file.name));
  head.appendChild(vidEl('span', 'vid-upload-item-size', vidFormatBytes(file.size)));
  item.appendChild(head);
  const check = vidEl('p', 'vid-upload-check', 'Tjekker videoen…');
  item.appendChild(check);
  form.appendChild(item);
  let probe = null;
  const ready = Promise.all([vidProbeMp4(file), vidCheckPlayable(file)]).then(([p, playable]) => {
    probe = p;
    const notes = [];
    if (playable === false) notes.push('Browseren kan ikke afspille filen. Den skal være MP4 med H.264.');
    notes.push(...vidVideoWarnings(p));
    const ok = !notes.length;
    check.classList.toggle('vid-upload-check-ok', ok);
    check.classList.toggle('vid-warn', !ok);
    check.textContent = ok
      ? ['Klar', p.durationSec ? vidFormatTime(p.durationSec) : '', 'H.264'].filter(Boolean).join(' · ')
      : notes.join(' ');
  });
  const free = vidFreeBytes === null ? null : Math.max(0, vidFreeBytes - vidUsedBytesQueued());
  if (free !== null) form.appendChild(vidEl('p', 'vid-upload-space', `${vidFormatBytes(free)} ledigt på serveren`));

  const uploadBtn = vidPillBtn('Upload', 'site-btn-success');
  if (free !== null && file.size > free) {
    error.textContent = `Der er ikke plads: videoen fylder ${vidFormatBytes(file.size)}, men der er kun ${vidFormatBytes(free)} ledigt.`;
    uploadBtn.disabled = true;
  }
  uploadBtn.addEventListener('click', async () => {
    uploadBtn.disabled = true;
    await ready;
    close();
    vidEnqueue([{ file, name: `${VID_VIDEO_NAME}.${vidFileExt(file.name)}`, durationSec: probe && probe.durationSec }], year.id);
  });
  actions.appendChild(uploadBtn);
}

// ── Import from the server (admin) ───────────────────────────
// Videos copied to the volume's incoming/ folder (rsync -P film.mp4
// web-1:/mnt/videoer/store/incoming/) are moved into the store here.
async function vidOpenImportModal(year) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Importér fra serveren');
  modal.classList.add('site-modal-md');
  form.appendChild(vidEl('p', 'site-hint vid-modal-hint',
    `Vælg revyens video blandt filerne kopieret til serveren (rsync -P film.mp4 web-1:/mnt/videoer/store/incoming/).`));
  const list = vidEl('div', 'vid-import-list');
  list.appendChild(vidEl('p', 'site-muted', 'Henter listen…'));
  form.appendChild(list);
  const doneBtn = vidPillBtn('Luk');
  doneBtn.addEventListener('click', close);
  actions.appendChild(doneBtn);

  const result = await vidApi('videoer_list_incoming', {});
  if (!result.ok) { list.replaceChildren(); error.textContent = result.message; return; }
  const files = result.data.files || [];
  list.replaceChildren();
  if (!files.length) {
    list.appendChild(vidEl('p', 'site-empty', 'Der ligger ingen videoer i incoming/.'));
    return;
  }
  for (const f of files) {
    const row = vidEl('div', 'vid-import-row');
    const head = vidEl('div', 'vid-upload-item-head');
    head.appendChild(vidEl('span', 'vid-upload-item-name', f.name));
    head.appendChild(vidEl('span', 'vid-upload-item-size', vidFormatBytes(f.size || 0)));
    const go = vidBtn('Importér');
    go.addEventListener('click', async () => {
      list.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      const res = await vidApi('videoer_import', { name: f.name, folderId: year.id, title: VID_VIDEO_NAME });
      if (!res.ok) {
        list.querySelectorAll('button').forEach((b) => { b.disabled = false; });
        vidShowError(res.message);
        return;
      }
      vidState.files.push(res.data.file);
      await vidRefreshStreamUrls();
      close();
      vidRender();
      const warnings = vidVideoWarnings(res.data.file);
      siteShowToast(warnings.length ? 'Videoen er importeret, men se advarslen ved den.' : 'Videoen er importeret.');
    });
    head.appendChild(go);
    row.appendChild(head);
    list.appendChild(row);
  }
}

// ── Upload queue (a page-scoped copy of albums.js's) ─────────
// [{key, file, name, durationSec, folderId, sent, state: 'waiting'|'uploading'|'failed', message, cancelled, uploadId}]
const vidQueue = [];
let vidQueueRunning = false;
let vidUploadKey = 0;
let vidPanelEl = null;

function vidUploadsPending() {
  return vidQueue.some((item) => item.state !== 'failed');
}

function vidUploadPanel() {
  if (!vidPanelEl) vidPanelEl = vidEl('section', 'card vid-uploads');
  return vidPanelEl;
}

function vidEnqueue(items, folderId) {
  for (const { file, name, durationSec } of items) {
    vidQueue.push({ key: ++vidUploadKey, file, name, durationSec, folderId, sent: 0, state: 'waiting', message: '', cancelled: false, uploadId: null });
  }
  vidRenderUploads();
  vidRunQueue();
}

function vidRenderUploads() {
  const panel = vidUploadPanel();
  panel.hidden = !vidQueue.length;
  if (!vidQueue.length) { panel.replaceChildren(); return; }
  const head = vidEl('div', 'card-head vid-uploads-head');
  head.appendChild(vidEl('h2', null, 'Uploads'));
  if (vidQueue.some((item) => item.state === 'failed')) {
    const clearBtn = vidBtn('Ryd fejlede');
    clearBtn.addEventListener('click', () => {
      for (let i = vidQueue.length - 1; i >= 0; i--) {
        if (vidQueue[i].state === 'failed') vidQueue.splice(i, 1);
      }
      vidRenderUploads();
    });
    head.appendChild(clearBtn);
  }
  panel.replaceChildren(head);
  panel.appendChild(vidEl('p', 'site-hint vid-uploads-hint', 'Lad siden være åben, til videoen er uploadet.'));
  for (const item of vidQueue) panel.appendChild(vidBuildUploadRow(item));
}

function vidBuildUploadRow(item) {
  const row = vidEl('div', 'vid-upload');
  const top = vidEl('div', 'vid-upload-top');
  top.appendChild(vidEl('span', 'vid-upload-name', item.file.name));
  const year = vidYearById(item.folderId);
  top.appendChild(vidEl('span', 'vid-upload-where', '→ ' + (year ? vidYearName(year) : 'slettet revy')));
  const status = vidEl('span', 'vid-upload-status');
  item.statusEl = status;
  top.appendChild(status);
  const cancelBtn = vidRemoveBtn(item.state === 'failed' ? 'Fjern' : 'Annuller upload');
  cancelBtn.addEventListener('click', () => vidCancelUpload(item));
  top.appendChild(cancelBtn);
  row.appendChild(top);
  const bar = vidEl('div', 'vid-progress');
  const fill = vidEl('div', 'vid-progress-fill');
  item.fillEl = fill;
  bar.appendChild(fill);
  row.appendChild(bar);
  if (item.state === 'failed') row.classList.add('vid-upload-failed');
  vidPaintUpload(item);
  return row;
}

function vidPaintUpload(item) {
  if (!item.statusEl) return;
  const pct = item.file.size ? Math.floor((item.sent / item.file.size) * 100) : 0;
  item.fillEl.style.width = pct + '%';
  if (item.state === 'failed') item.statusEl.textContent = item.message || 'Fejlede';
  else if (item.state === 'waiting') item.statusEl.textContent = 'Venter';
  else if (item.cancelled) item.statusEl.textContent = 'Annullerer…';
  else if (item.sent >= item.file.size) item.statusEl.textContent = 'Gemmer…';
  else item.statusEl.textContent = `${pct} % af ${vidFormatBytes(item.file.size)}`;
}

function vidRemoveFromQueue(item) {
  const idx = vidQueue.indexOf(item);
  if (idx >= 0) vidQueue.splice(idx, 1);
  vidRenderUploads();
}

function vidCancelUpload(item) {
  if (item.state === 'uploading') {
    item.cancelled = true; // the running loop aborts after its current chunk
    vidPaintUpload(item);
    return;
  }
  vidRemoveFromQueue(item);
}

async function vidRunQueue() {
  if (vidQueueRunning) return;
  vidQueueRunning = true;
  for (;;) {
    const item = vidQueue.find((i) => i.state === 'waiting');
    if (!item) break;
    item.state = 'uploading';
    vidPaintUpload(item);
    const outcome = await vidUploadOne(item);
    if (outcome.ok) {
      vidQueue.splice(vidQueue.indexOf(item), 1);
      vidState.files.push(outcome.file);
      if (vidFreeBytes !== null) vidFreeBytes = Math.max(0, vidFreeBytes - item.file.size);
      // The new video needs a stream link before it can play.
      await vidRefreshStreamUrls();
      vidRender();
      siteShowToast('Videoen er uploadet.');
    } else if (outcome.cancelled) {
      vidRemoveFromQueue(item);
    } else {
      item.state = 'failed';
      item.message = outcome.message || 'Fejlede';
      vidRenderUploads();
    }
  }
  vidQueueRunning = false;
}

function vidReadChunkBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result || '');
      resolve(s.slice(s.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function vidDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns {ok, file} | {cancelled} | {message}.
async function vidUploadOne(item) {
  const { file } = item;
  const start = await vidApi('videoer_upload_start', {
    folderId: item.folderId, name: item.name, size: file.size,
    ...(item.durationSec ? { durationSec: item.durationSec } : {}),
  });
  if (!start.ok) return { message: start.message || 'Annulleret' };
  item.uploadId = start.data.uploadId;
  const chunkBytes = Math.min(VID_CHUNK_BYTES, start.data.chunkBytes || VID_CHUNK_BYTES);
  let offset = 0;
  while (offset < file.size) {
    if (item.cancelled) {
      await vidApi('videoer_upload_abort', { uploadId: item.uploadId });
      return { cancelled: true };
    }
    let contentBase64;
    try {
      contentBase64 = await vidReadChunkBase64(file.slice(offset, offset + chunkBytes));
    } catch (e) {
      await vidApi('videoer_upload_abort', { uploadId: item.uploadId });
      return { message: 'Kunne ikke læse filen.' };
    }
    let result = null;
    for (let attempt = 1; attempt <= VID_CHUNK_ATTEMPTS; attempt++) {
      result = await vidApi('videoer_upload_chunk', { uploadId: item.uploadId, offset, contentBase64 });
      // Network errors and 5xx are worth retrying; 4xx won't change.
      if (result.ok || (result.status >= 400 && result.status < 500)) break;
      if (attempt < VID_CHUNK_ATTEMPTS) await vidDelay(1000 * 2 ** attempt);
    }
    if (!result.ok) {
      // The server holds a different amount than we think: carry on from there.
      if (result.status === 409 && result.data && Number.isInteger(result.data.received)) {
        offset = result.data.received;
        continue;
      }
      await vidApi('videoer_upload_abort', { uploadId: item.uploadId });
      return { message: result.message };
    }
    offset = Math.max(offset, result.data.received);
    item.sent = offset;
    vidPaintUpload(item);
  }
  const finish = await vidApi('videoer_upload_finish', { uploadId: item.uploadId });
  if (!finish.ok) {
    if (finish.status === 404) return { message: 'Revyen blev fjernet under uploaden.' };
    return { message: finish.message };
  }
  return { ok: true, file: finish.data.file };
}

// ── Init ─────────────────────────────────────────────────────
// Only one thing plays at a time on Arkiv: Albums starting pauses the video.
document.addEventListener('arkiv-media-play', (e) => {
  if (e.detail && e.detail.source !== 'videoer') vidPausePlayer();
});

window.addEventListener('beforeunload', (e) => {
  if (!vidUploadsPending()) return;
  e.preventDefault();
  e.returnValue = '';
});


// Keys on the Videoer tab (not while typing or with a modal open): Space
// plays/pauses, "," and "." jump a scene.
function vidKeyIsOurs(e) {
  if (e.ctrlKey || e.metaKey || e.altKey || !vidTabShowing() || !vidPlayer.video || !document.contains(vidPlayer.video)) return false;
  const t = e.target;
  if (t && t.closest && t.closest('input, textarea, select, [contenteditable="true"], .login-overlay, .site-field-pop')) return false;
  return [' ', ',', '.'].includes(e.key);
}

document.addEventListener('keydown', (e) => {
  if (!vidKeyIsOurs(e)) return;
  const v = vidPlayer.video;
  if (e.key === ' ') {
    // Space only plays/pauses, like in Albums: never presses the button
    // clicked last, and never lights up its focus ring (a key press on a
    // mouse-focused element turns :focus-visible on), so focus is dropped.
    // The same when the video itself has focus (handled here, not by its
    // own controls, so it can't toggle twice).
    e.preventDefault();
    e.stopPropagation();
    const focused = document.activeElement;
    if (focused && focused !== document.body && typeof focused.blur === 'function') focused.blur();
    if (!e.repeat) { if (v.paused) vidTryPlay(); else v.pause(); }
  } else if (e.key === ',') {
    e.preventDefault();
    vidPrevScene();
  } else if (e.key === '.') {
    e.preventDefault();
    vidNextScene();
  }
}, true);

// A button keeps focus after a click, and Space would press it again on
// keyup (the keydown above already dropped focus; this is the backstop).
document.addEventListener('keyup', (e) => {
  if (e.key === ' ' && vidKeyIsOurs(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

window.addEventListener('hashchange', vidOnRoute);
window.addEventListener('scroll', () => vidHideStripTip(), { passive: true });

// A page left open for a day: renew the links before they run out.
setInterval(() => {
  if (vidState && vidStreamExpires && vidStreamExpires - Date.now() < 2 * 3600 * 1000) vidRefreshStreamUrls();
}, 15 * 60 * 1000);

document.addEventListener('DOMContentLoaded', () => {
  const root = vidRoot();
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = vidEl('section', 'card');
    card.appendChild(vidEl('p', 'site-muted', 'Videoer kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  if (typeof siteRegisterUnsavedCheck === 'function') {
    siteRegisterUnsavedCheck(() => vidUploadsPending() || (vidChapterSaver ? vidChapterSaver.hasUnsaved() : false));
  }
  vidLoad();
});
