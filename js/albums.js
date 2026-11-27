/* =========================================================
   Matematikrevyen – Albums (the Albums tab on arkiv.html)

   The revy songs as a members-only music player: one album per Arkiv
   year, made by a boss ("+ Nyt album" picks the year; name and cover come
   from archive.json), songs uploaded into it. Revyster listen; boss
   creates albums, uploads, renames, reorders, deletes and downloads.

   The server runs Teknikken's store code on ALBUMS_DATA_DIR via the
   albums_* actions (teknik_stores()['albums'] in update-data.php): an
   album is a top-level folder + `archiveFolder`, a track a file +
   `order` + `durationSec`. Permanent (never emptied by "Afslut revyen").

   Playback: one <audio> element, so it keeps playing with the screen
   locked, with lock screen controls via navigator.mediaSession. albums_read
   hands out a signed stream URL for every track up front, because iOS only
   starts audio when play() runs inside the tap itself (no request first),
   and the next song must start while the phone is locked. The URLs last
   12-36 h; an expired one is refetched (albums_stream_urls) on error.
   A queue ("Næste i køen", via ⋯ on a song) plays before the album or
   shuffle continues; the "Kø" panel in the player bar shows and edits it.
   The queue, position, shuffle, repeat and volume are kept in localStorage.

   Routing: a tab on Arkiv (arkiv.html; archive.js shows the tab): the
   overview at /arkiv#albums, an album at /arkiv#albums/<archiveFolder>.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Small DOM helpers ────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// First-level (inline) button.
function albBtn(label, extraClass) {
  const btn = el('button', 'btn-small' + (extraClass ? ' ' + extraClass : ''), label);
  btn.type = 'button';
  return btn;
}

// Second-level button, for buttons inside a modal overlay only.
function albPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

// 24×24 icons. `fill` = solid shapes (transport buttons), else strokes.
const ALB_ICONS = {
  play: { fill: true, paths: ['M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z'] },
  pause: { fill: true, paths: ['M7 5h3.5v14H7z', 'M13.5 5H17v14h-3.5z'] },
  prev: { fill: true, paths: ['M6 5h2.2v14H6z', 'M19 5.9v12.2a.8.8 0 0 1-1.2.7L9.6 12.7a.8.8 0 0 1 0-1.4l8.2-6.1a.8.8 0 0 1 1.2.7z'] },
  next: { fill: true, paths: ['M15.8 5H18v14h-2.2z', 'M5 5.9v12.2a.8.8 0 0 0 1.2.7l8.2-6.1a.8.8 0 0 0 0-1.4L6.2 5.2A.8.8 0 0 0 5 5.9z'] },
  shuffle: { paths: ['M16 4h4v4', 'M4 20L20 4', 'M20 16v4h-4', 'M14.5 14.5L20 20', 'M4 4l5 5'] },
  repeat: { paths: ['M17 2l4 4-4 4', 'M3 11v-1a4 4 0 0 1 4-4h14', 'M7 22l-4-4 4-4', 'M21 13v1a4 4 0 0 1-4 4H3'] },
  download: { paths: ['M12 4v11', 'M7 10l5 5 5-5', 'M5 20h14'] },
  back: { paths: ['M15 5l-7 7 7 7'] },
  plus: { paths: ['M12 5v14', 'M5 12h14'] },
  more: { fill: true, paths: ['M4.2 12a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0z', 'M10.2 12a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0z', 'M16.2 12a1.8 1.8 0 1 0 3.6 0a1.8 1.8 0 1 0-3.6 0z'] },
  queue: { paths: ['M3 6h14', 'M3 12h9', 'M3 18h9', 'M16 11.5v8l5.5-4z'] },
  volume: { paths: ['M4 9.5h3.5L12 6v12l-4.5-3.5H4z', 'M15.5 9a4.2 4.2 0 0 1 0 6', 'M18.2 6.3a8 8 0 0 1 0 11.4'] },
  volumeLow: { paths: ['M4 9.5h3.5L12 6v12l-4.5-3.5H4z', 'M15.5 9a4.2 4.2 0 0 1 0 6'] },
  volumeMuted: { paths: ['M4 9.5h3.5L12 6v12l-4.5-3.5H4z', 'M16 9.5l5 5', 'M21 9.5l-5 5'] },
};

function albIcon(name, size) {
  const spec = ALB_ICONS[name];
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

function albIconBtn(icon, title, extraClass, size) {
  const btn = el('button', 'site-icon-btn' + (extraClass ? ' ' + extraClass : ''));
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.appendChild(albIcon(icon, size));
  return btn;
}

function albRemoveBtn(title) {
  const btn = el('button', 'site-icon-btn site-icon-btn-danger', '✕');
  btn.type = 'button';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  return btn;
}

// ── Authenticated API (mirrors sangere.js's sangApi) ─────────
const ALB_DEFAULT_QUOTA_BYTES = 12 * 1024 * 1024 * 1024; // mirrors teknik_stores()['albums'] in update-data.php
const ALB_CHUNK_BYTES = 8 * 1024 * 1024; // mirrors teknik_max_chunk_bytes()
const ALB_CHUNK_ATTEMPTS = 4;

function albResolvePassword() {
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

function albMapError(status, detail) {
  if (detail === 'quota_exceeded') {
    return `Der er ikke plads nok. Albummerne må højst fylde ${albFormatBytes(albQuotaBytes)} i alt.`;
  }
  if (detail === 'album_exists') return 'Det år har allerede et album.';
  if (detail === 'stale') return 'Albummet er lige blevet ændret af en anden. Siden er genindlæst.';
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. En anden har måske lige slettet det. Genindlæs siden.';
  if (status === 507 || detail === 'disk_full') return 'Serveren er ved at løbe tør for plads. Sig det til Carl.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, status, message, data } —
// message '' = cancelled password prompt (silent no-op).
async function albApi(action, body) {
  const password = albResolvePassword();
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
  if (!res.ok) return { ok: false, status: res.status, message: albMapError(res.status, detail), data };
  if (!data || data.ok !== true) {
    return { ok: false, status: res.status, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.', data };
  }
  return { ok: true, data };
}

function albShowError(message) {
  if (message) siteShowToast(message);
}

// ── State ────────────────────────────────────────────────────
let albState = null; // { folders (albums), files (tracks) } once loaded
let albQuotaBytes = ALB_DEFAULT_QUOTA_BYTES;
let albEditing = false; // the open album's edit mode (boss)
// fileId → stream query ('teknik_dl=…'), and when those links expire (ms).
let albStreamUrls = {};
let albStreamExpires = 0;

// Playable here (must be in teknik_inline_types(), or it can't stream).
const ALB_AUDIO_EXTS = ['flac', 'mp3', 'm4a', 'wav', 'aac', 'ogg'];

function albRoot() {
  return document.getElementById('albums-root');
}

function albIsBoss() {
  return typeof siteHasLevel === 'function' && siteHasLevel('boss');
}

// ── Lookups ──────────────────────────────────────────────────
function albArchiveYears() {
  const override = siteLoadOverride('archive');
  return (override || (typeof ARCHIVE_DATA !== 'undefined' ? ARCHIVE_DATA : [])).filter((y) => y && y.folder);
}

function albArchiveEntry(folder) {
  return albArchiveYears().find((y) => y.folder === folder) || null;
}

function albAlbumName(album) {
  if (!album) return '';
  const entry = albArchiveEntry(album.archiveFolder);
  return (entry && entry.name) || album.name || album.archiveFolder;
}

function albAlbumCover(album) {
  const entry = album ? albArchiveEntry(album.archiveFolder) : null;
  return (entry && entry.coverImage) || '';
}

function albAlbumYear(album) {
  const entry = albArchiveEntry(album.archiveFolder);
  if (entry && entry.year) return entry.year;
  const m = /\d{4}/.exec(album.archiveFolder || '');
  return m ? Number(m[0]) : 0;
}

function albAlbumById(id) {
  return (albState && albState.folders.find((f) => f.id === id)) || null;
}

function albAlbumByArchiveFolder(folder) {
  return (albState && albState.folders.find((f) => f.archiveFolder === folder)) || null;
}

function albTrackById(id) {
  return (albState && albState.files.find((f) => f.id === id)) || null;
}

function albCompareTracks(a, b) {
  return ((a.order || 0) - (b.order || 0)) || String(a.uploadedAt || '').localeCompare(String(b.uploadedAt || ''));
}

function albTracks(albumId) {
  return albState.files.filter((f) => f.folderId === albumId).sort(albCompareTracks);
}

// Newest first, in Arkiv's order within a year. Revyster only see albums
// with songs in them.
function albAlbums() {
  const years = albArchiveYears();
  const rank = (album) => {
    const i = years.findIndex((y) => y.folder === album.archiveFolder);
    return i === -1 ? years.length : i;
  };
  const list = albState.folders.filter((album) => album.archiveFolder && (albIsBoss() || albTracks(album.id).length));
  return list.sort((a, b) => (albAlbumYear(b) - albAlbumYear(a)) || (rank(a) - rank(b)));
}

function albTrackTitle(file) {
  if (!file) return '';
  return file.ext ? file.name.replace(new RegExp('\\.' + file.ext + '$', 'i'), '') || file.name : file.name;
}

// ── Formatting ───────────────────────────────────────────────
function albFormatTime(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-';
  const s = Math.floor(sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function albFormatTotal(sec) {
  const min = Math.round(sec / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} t ${min % 60} min`;
}

function albFormatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit++; }
  const digits = unit === 0 || value >= 100 ? 0 : 1;
  return value.toLocaleString('da-DK', { maximumFractionDigits: digits }) + ' ' + units[unit];
}

function albPlural(n, one, many) {
  return `${n} ${n === 1 ? one : many}`;
}

// "17 sange · 58 min" (the length only once every song has one).
function albAlbumMeta(album) {
  const tracks = albTracks(album.id);
  if (!tracks.length) return 'Ingen sange endnu';
  const parts = [albPlural(tracks.length, 'sang', 'sange')];
  if (tracks.every((t) => t.durationSec > 0)) {
    parts.push(albFormatTotal(tracks.reduce((sum, t) => sum + t.durationSec, 0)));
  }
  return parts.join(' · ');
}

// ── Load ─────────────────────────────────────────────────────
async function albLoad() {
  const root = albRoot();
  if (!albState) root.replaceChildren(el('p', 'site-muted', 'Indlæser…'));
  const result = await albApi('albums_read', {});
  if (!result.ok) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'alb-error', result.message || 'Kunne ikke indlæse albummerne.'));
    root.replaceChildren(card);
    return;
  }
  albState = { folders: result.data.folders || [], files: result.data.files || [] };
  if (Number.isInteger(result.data.quotaBytes)) albQuotaBytes = result.data.quotaBytes;
  albSetStreamUrls(result.data.streamUrls, result.data.streamExpiresAt);
  albPlayerReconcile();
  albRender();
}

function albSetStreamUrls(urls, expiresAt) {
  albStreamUrls = (urls && typeof urls === 'object' && !Array.isArray(urls)) ? urls : {};
  const t = Date.parse(expiresAt || '');
  albStreamExpires = Number.isFinite(t) ? t : 0;
}

let albStreamRefresh = null;
// Fresh links for every track (one request, shared by concurrent callers).
function albRefreshStreamUrls() {
  if (!albStreamRefresh) {
    albStreamRefresh = albApi('albums_stream_urls', {}).then((result) => {
      albStreamRefresh = null;
      if (!result.ok) return false;
      albSetStreamUrls(result.data.urls, result.data.expiresAt);
      return true;
    });
  }
  return albStreamRefresh;
}

function albStreamUrl(file) {
  const query = file && albStreamUrls[file.id];
  if (!query) return '';
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  return SITE_API_ENDPOINT + sep + query;
}

// ── Routing ──────────────────────────────────────────────────
// Albums is a tab on Arkiv: #albums is the overview, #albums/<folder> an
// album (archive.js's arkivRoute shows the tab).
function albRouteFolder() {
  const m = /^#albums\/(.+)$/.exec(location.hash);
  if (!m) return '';
  try { return decodeURIComponent(m[1]); } catch (e) { return ''; }
}

// True while the Albums tab is the one showing.
function albTabShowing() {
  const panel = document.getElementById('arkiv-tab-albums');
  return !panel || !panel.hidden;
}

function albCurrentAlbum() {
  const folder = albRouteFolder();
  const album = folder ? albAlbumByArchiveFolder(folder) : null;
  if (!album || (!albIsBoss() && !albTracks(album.id).length)) return null;
  return album;
}

function albGoToAlbum(album) {
  if (albRouteFolder() === album.archiveFolder && albTabShowing()) return;
  location.hash = 'albums/' + encodeURIComponent(album.archiveFolder);
}

function albGoToOverview() {
  location.hash = 'albums';
}

function albOnRoute() {
  albEditing = false;
  albRender();
  window.scrollTo(0, 0);
}

// ── Render ───────────────────────────────────────────────────
function albRender() {
  const root = albRoot();
  if (!root || !albState) return;
  const album = albCurrentAlbum();
  if (albTabShowing()) document.title = (album ? albAlbumName(album) + ' · ' : '') + 'Albums · Matematikrevyen';
  root.replaceChildren(album ? albBuildAlbumView(album) : albBuildOverview(), albUploadPanel());
  albRenderUploads();
  albMarkPlaying();
  albPositionQueue();
}

// A cover image, or a ♪ placeholder when the year has none (or it fails).
function albCoverEl(album, className) {
  const wrap = el('div', 'alb-cover' + (className ? ' ' + className : ''));
  const placeholder = () => {
    wrap.classList.add('alb-cover-empty');
    wrap.appendChild(el('span', 'alb-cover-note', '♪'));
  };
  const src = albAlbumCover(album);
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

// ── Overview: a grid of album covers ─────────────────────────
// After the last album, an empty card holds the round buttons: "Bland
// alle" (when there are songs) above "Nyt album" (boss). Only with the "+"
// does it get a dashed border.
function albBuildOverview() {
  const wrap = el('div', 'alb-overview');
  const albums = albAlbums();
  const anyTracks = albums.some((album) => albTracks(album.id).length);

  if (!albums.length && !albIsBoss()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'site-empty', 'Der er ingen albums endnu.'));
    wrap.appendChild(card);
    return wrap;
  }

  const grid = el('div', 'alb-grid');
  for (const album of albums) {
    const tile = el('button', 'alb-tile');
    tile.type = 'button';
    tile.appendChild(albCoverEl(album, 'alb-tile-cover'));
    tile.appendChild(el('span', 'alb-tile-name', albAlbumName(album)));
    tile.appendChild(el('span', 'alb-tile-meta', albAlbumMeta(album)));
    tile.addEventListener('click', () => albGoToAlbum(album));
    grid.appendChild(tile);
  }

  const actions = el('div', 'alb-tile alb-tile-actions');
  if (anyTracks) {
    // The same round button as "Bland" inside an album.
    const shuffleBtn = el('button', 'alb-big-play alb-shuffle-all');
    shuffleBtn.type = 'button';
    shuffleBtn.title = 'Bland alle sange fra alle albums';
    shuffleBtn.setAttribute('aria-label', 'Bland alle sange fra alle albums');
    shuffleBtn.appendChild(albIcon('shuffle', 22));
    shuffleBtn.addEventListener('click', () => albShuffleAll());
    actions.appendChild(shuffleBtn);
  }
  if (albIsBoss()) {
    const newBtn = el('button', 'alb-big-play alb-new-album');
    newBtn.type = 'button';
    newBtn.title = 'Nyt album';
    newBtn.setAttribute('aria-label', 'Nyt album');
    newBtn.appendChild(albIcon('plus', 24));
    newBtn.addEventListener('click', () => albOpenNewAlbumModal());
    actions.appendChild(newBtn);
  }
  // The dashed border only frames the "+" (boss); a revyst's "Bland alle"
  // just sits centred in the empty spot.
  if (albIsBoss()) actions.classList.add('alb-tile-actions-framed');
  if (actions.childNodes.length) grid.appendChild(actions);
  wrap.appendChild(grid);
  if (!albums.length) wrap.appendChild(el('p', 'site-hint alb-empty-hint', 'Der er ingen albums endnu. Opret et med "+" og vælg revyen fra Arkivet.'));
  return wrap;
}

// ── Album view ───────────────────────────────────────────────
function albBuildAlbumView(album) {
  const tracks = albTracks(album.id);
  const boss = albIsBoss();
  const card = el('section', 'card alb-album' + (albEditing ? ' alb-editing' : ''));

  const top = el('div', 'alb-album-top');
  const back = el('button', 'alb-back');
  back.type = 'button';
  back.appendChild(albIcon('back', 16));
  back.appendChild(document.createTextNode('Alle albums'));
  back.addEventListener('click', () => albGoToOverview());
  top.appendChild(back);
  // Boss: the album as a .zip, left of the pencil.
  if (boss) {
    const tools = el('div', 'alb-album-tools');
    if (tracks.length) {
      const zipBtn = albIconBtn('download', 'Download albummet (.zip)', null, 16);
      zipBtn.addEventListener('click', () => albDownloadAlbum(album));
      tools.appendChild(zipBtn);
    }
    tools.appendChild(siteEditToggle(albEditing, () => {
      albEditing = !albEditing;
      albRender();
    }, { editLabel: 'Rediger albummet', doneLabel: 'Færdig' }));
    top.appendChild(tools);
  }
  card.appendChild(top);

  const head = el('div', 'alb-album-head');
  head.appendChild(albCoverEl(album, 'alb-album-cover'));
  const info = el('div', 'alb-album-info');
  info.appendChild(el('h2', 'alb-album-name', albAlbumName(album)));
  info.appendChild(el('p', 'alb-album-meta', albAlbumMeta(album)));
  if (tracks.length) {
    const actions = el('div', 'alb-album-actions');
    const playBtn = el('button', 'alb-big-play alb-big-play-main');
    playBtn.type = 'button';
    const playingThis = albPlayer.ctxFolder === album.id && albIsPlaying();
    playBtn.title = 'Afspil albummet';
    playBtn.setAttribute('aria-label', 'Afspil albummet');
    playBtn.appendChild(albIcon(playingThis ? 'pause' : 'play', 26));
    playBtn.addEventListener('click', () => {
      if (albPlayer.ctxFolder === album.id && albCurrentTrack()) { albTogglePlay(); return; }
      albPlayAlbum(album, null, false);
    });
    actions.appendChild(playBtn);
    const shuffleBtn = el('button', 'alb-big-play');
    shuffleBtn.type = 'button';
    shuffleBtn.title = 'Bland albummet';
    shuffleBtn.setAttribute('aria-label', 'Bland albummet');
    shuffleBtn.appendChild(albIcon('shuffle', 22));
    shuffleBtn.addEventListener('click', () => albPlayAlbum(album, null, true));
    actions.appendChild(shuffleBtn);
    const queueBtn = el('button', 'alb-big-play');
    queueBtn.type = 'button';
    queueBtn.title = 'Tilføj albummet til køen';
    queueBtn.setAttribute('aria-label', 'Tilføj albummet til køen');
    queueBtn.appendChild(albIcon('queue', 22));
    queueBtn.addEventListener('click', () => albQueueAddAlbum(album));
    actions.appendChild(queueBtn);
    info.appendChild(actions);
  }
  head.appendChild(info);
  card.appendChild(head);

  if (tracks.length) {
    if (albEditing) {
      card.appendChild(el('p', 'site-hint alb-edit-hint',
        'Tallet ved ▶ er afspilninger fra Spotify og SoundCloud. Afspilninger her på siden lægges oveni.'));
    }
    const list = el('ol', 'alb-tracks');
    tracks.forEach((file, i) => list.appendChild(albEditing ? albBuildEditRow(album, file, i, tracks) : albBuildTrackRow(album, file, i)));
    if (albEditing) albFinishReorderList(list, 'album', (drag, before) => albMoveTrackByIndex(album, drag.index, before));
    card.appendChild(list);
  } else {
    card.appendChild(el('p', 'site-empty alb-no-tracks', 'Ingen sange endnu.'));
  }

  // Boss: upload while editing (or straight away on an empty album).
  if (boss && (albEditing || !tracks.length)) {
    const bar = el('div', 'alb-edit-bar');
    const deleteBtn = albBtn('Slet album', 'btn-small-danger');
    deleteBtn.addEventListener('click', () => albConfirmDeleteAlbum(album));
    bar.appendChild(deleteBtn);
    const uploadBtn = albBtn('Upload sange');
    uploadBtn.addEventListener('click', () => albPickFiles(album));
    bar.appendChild(uploadBtn);
    card.appendChild(bar);
    if (!tracks.length) bar.classList.add('alb-edit-bar-empty');
  }
  if (boss) albWireDesktopDrop(card, album);
  return card;
}

function albBuildTrackRow(album, file, i) {
  const row = el('li', 'alb-track');
  row.dataset.fileId = file.id;
  const main = el('button', 'alb-track-main');
  main.type = 'button';
  main.title = 'Afspil';
  const num = el('span', 'alb-track-num');
  num.appendChild(el('span', 'alb-track-index', String(i + 1)));
  const eq = el('span', 'alb-track-eq');
  eq.setAttribute('aria-hidden', 'true');
  for (let b = 0; b < 3; b++) eq.appendChild(el('span'));
  num.appendChild(eq);
  main.appendChild(num);
  main.appendChild(el('span', 'alb-track-title', albTrackTitle(file)));
  const plays = el('span', 'alb-track-plays');
  albPaintPlays(plays, file);
  main.appendChild(plays);
  main.appendChild(el('span', 'alb-track-time', file.durationSec > 0 ? albFormatTime(file.durationSec) : ''));
  main.addEventListener('click', () => {
    if (albCurrentTrack() && albCurrentTrack().id === file.id) { albTogglePlay(); return; }
    albPlayAlbum(album, file.id, albPlayer.shuffle);
  });
  row.appendChild(main);
  const more = albIconBtn('more', 'Flere valg', 'alb-track-more', 18);
  more.setAttribute('aria-haspopup', 'menu');
  more.addEventListener('click', () => albOpenTrackMenu(more, file));
  row.appendChild(more);
  return row;
}

// Edit mode: the row drags to reorder (held on touch screens), title in
// place, ✕.
function albBuildEditRow(album, file, i, tracks) {
  const row = el('li', 'alb-track alb-track-edit');
  row.dataset.fileId = file.id;
  albWireReorderRow(row, 'album', i, albTrackTitle(file));
  row.appendChild(el('span', 'alb-track-num alb-track-index', String(i + 1)));

  const input = el('input', 'site-inline-field alb-title-input');
  input.type = 'text';
  input.maxLength = 180;
  input.value = albTrackTitle(file);
  input.setAttribute('aria-label', 'Titel');
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = albTrackTitle(file); input.blur(); }
  });
  input.addEventListener('blur', () => albRenameTrack(file, input));
  row.appendChild(input);
  row.appendChild(albImportedPlaysField(file));
  row.appendChild(el('span', 'alb-track-time', file.durationSec > 0 ? albFormatTime(file.durationSec) : ''));
  const remove = albRemoveBtn('Slet sangen');
  remove.addEventListener('click', () => albConfirmDeleteTrack(file));
  row.appendChild(remove);
  return row;
}

// Edit mode: the plays imported from Spotify/SoundCloud, typed in place
// ("12.408", "12408" and "12 408" all work), saved on blur/Enter.
function albImportedPlaysField(file) {
  const wrap = el('span', 'alb-plays-edit');
  wrap.title = 'Afspilninger fra Spotify og SoundCloud';
  wrap.appendChild(albIcon('play', 10));
  const input = el('input', 'site-inline-field alb-plays-input');
  input.type = 'text';
  input.inputMode = 'numeric';
  input.maxLength = 13;
  input.placeholder = '0';
  input.setAttribute('aria-label', `Afspilninger fra Spotify og SoundCloud for ${albTrackTitle(file)}`);
  const show = () => { input.value = file.playsImported ? file.playsImported.toLocaleString('da-DK') : ''; };
  show();
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { show(); input.blur(); }
  });
  input.addEventListener('blur', async () => {
    const raw = input.value.replace(/[\s.,]/g, '');
    if (raw !== '' && !/^\d{1,9}$/.test(raw)) {
      albShowError('Skriv et helt tal, fx 12.408.');
      show();
      return;
    }
    const value = raw === '' ? 0 : Number(raw);
    if (value === (file.playsImported || 0)) { show(); return; }
    const result = await albApi('albums_set_imported_plays', { fileId: file.id, plays: value });
    if (!result.ok) { albShowError(result.message); show(); return; }
    file.playsImported = result.data.playsImported;
    show();
  });
  wrap.appendChild(input);
  return wrap;
}

// The playing track's row gets the amber highlight and the bars.
function albMarkPlaying() {
  const current = albCurrentTrack();
  const playing = albIsPlaying();
  document.querySelectorAll('.alb-track[data-file-id]').forEach((row) => {
    const isCurrent = !!current && row.dataset.fileId === current.id;
    row.classList.toggle('alb-track-current', isCurrent);
    row.classList.toggle('alb-track-playing', isCurrent && playing);
  });
  const big = document.querySelector('.alb-big-play-main');
  const album = albCurrentAlbum();
  if (big && album) {
    const playingThis = albPlayer.ctxFolder === album.id && playing;
    big.replaceChildren(albIcon(playingThis ? 'pause' : 'play', 26));
    big.title = playingThis ? 'Pause' : 'Afspil albummet';
    big.setAttribute('aria-label', big.title);
  }
}

// ── Editing (boss) ───────────────────────────────────────────
async function albRenameTrack(file, input) {
  const oldTitle = albTrackTitle(file);
  const value = input.value.trim().replace(/[\\/]/g, '-');
  if (!value) { input.value = oldTitle; return; }
  if (value === oldTitle) return;
  const result = await albApi('albums_rename_file', { fileId: file.id, name: value });
  if (!result.ok) {
    albShowError(result.message);
    input.value = oldTitle;
    return;
  }
  file.name = result.data.file.name;
  albPaintPlayer();
  albUpdateMediaSession();
}

function albConfirm(title, description, confirmLabel, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal(title);
  modal.classList.add('site-confirm-modal');
  if (description) form.appendChild(el('p', 'site-confirm-sub', description));
  const cancelBtn = albPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = albPillBtn(confirmLabel, 'site-btn-danger');
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

function albConfirmDeleteTrack(file) {
  albConfirm(`Slet "${albTrackTitle(file)}"?`, 'Dette kan ikke fortrydes.', 'Slet', async () => {
    const result = await albApi('albums_delete_file', { fileId: file.id });
    if (!result.ok) { albShowError(result.message); return false; }
    albState.files = albState.files.filter((f) => f.id !== file.id);
    albPlayerReconcile();
    albRender();
    return true;
  });
}

function albConfirmDeleteAlbum(album) {
  const count = albTracks(album.id).length;
  const description = (count
    ? `Albummet og ${count === 1 ? 'sangen' : `alle ${count} sange`} i det slettes. `
    : 'Albummet er tomt. ') + 'Dette kan ikke fortrydes.';
  albConfirm(`Er du sikker på, at du vil slette "${albAlbumName(album)}"?`, description, 'Slet', async () => {
    const result = await albApi('albums_delete', { folderId: album.id });
    if (!result.ok) { albShowError(result.message); return false; }
    albState.folders = albState.folders.filter((f) => f.id !== album.id);
    albState.files = albState.files.filter((f) => f.folderId !== album.id);
    albPlayerReconcile();
    albGoToOverview();
    albRender();
    return true;
  });
}

// "+ Nyt album": pick an Arkiv year that has no album yet.
function albOpenNewAlbumModal() {
  const used = new Set(albState.folders.map((f) => f.archiveFolder));
  const options = albArchiveYears()
    .filter((y) => !used.has(y.folder))
    .map((y) => ({ value: y.folder, label: y.name || y.folder }));
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Nyt album');
  modal.classList.add('site-modal-sm');
  if (!options.length) {
    form.appendChild(el('p', 'site-muted', 'Alle revyer i Arkivet har allerede et album.'));
    return;
  }
  form.appendChild(el('p', 'site-hint alb-modal-hint', 'Navn og forside kommer fra revyen i Arkivet.'));
  const field = siteCreateDropdownField(options, '', 'Vælg revy');
  form.appendChild(siteEditField('Revy', field));
  const createBtn = albPillBtn('Opret', 'site-btn-success');
  createBtn.addEventListener('click', async () => {
    if (!field.value) { error.textContent = 'Vælg en revy.'; return; }
    createBtn.disabled = true;
    error.textContent = '';
    const result = await albApi('albums_create', { archiveFolder: field.value });
    createBtn.disabled = false;
    if (!result.ok) { if (result.message) error.textContent = result.message; return; }
    albState.folders.push(result.data.folder);
    close();
    albGoToAlbum(result.data.folder);
  });
  actions.appendChild(createBtn);
}

// ── Reordering rows (album edit mode and the Kø panel) ───────
// Like Teknikken: the whole row drags (HTML5 drag and drop) where there is
// a mouse; on touch screens, where that doesn't work, a row is picked up
// by holding it ALB_HOLD_MS without moving (moving sooner is a scroll),
// follows the finger and drops where it is let go.
// Rows belong to a `group` (album, upnext, context); each list (an <ol>
// set up by albFinishReorderList) takes the groups in ALB_DROP_ACCEPTS, so
// a song from the album/"Bland alle" part can also go into "Næste i køen".
// While a row is dragged the Kø panel never re-renders (albRowDrag is set).
const ALB_HOLD_MS = 350;
const ALB_DROP_ACCEPTS = { album: ['album'], upnext: ['upnext', 'context'], context: ['context'] };
let albRowDrag = null; // {group, index} while a row is being dragged
let albTouchDropped = false; // swallows the tap a touch drop would cause
let albDragGhost = null;

// Shared off-screen drag image (the site-wide recipe; never display:none).
function albGetDragImageEl() {
  if (!albDragGhost) {
    albDragGhost = el('div', 'alb-drag-ghost');
    document.body.appendChild(albDragGhost);
  }
  return albDragGhost;
}

function albClearDropHighlight() {
  document.querySelectorAll('.alb-drop-target').forEach((n) => n.classList.remove('alb-drop-target'));
}

function albListAccepts(list, group) {
  return (ALB_DROP_ACCEPTS[list.dataset.dropGroup] || []).includes(group);
}

// A drag from the album/"Bland alle" part shows "Næste i køen" as a drop
// area even while it is empty.
function albSetDragging(group, on) {
  if (albQueuePanel) albQueuePanel.classList.toggle('alb-q-dragging-context', on && group === 'context');
}

// After a drag (dropped or not): back to normal, re-render the panel.
function albEndRowDrag() {
  albRowDrag = null;
  albClearDropHighlight();
  albSetDragging(null, false);
  albRenderQueue();
}

// Drops `drag` into `list` before row `before` (the row count = last).
function albDropInto(list, drag, before) {
  albRowDrag = null;
  albClearDropHighlight();
  albSetDragging(null, false);
  const sameGroup = list.dataset.dropGroup === drag.group;
  if (sameGroup && (before === drag.index || before === drag.index + 1)) { albRenderQueue(); return; }
  list._albOnDrop(drag, before);
  albRenderQueue();
}

// A drag source. `label` is the drag image's text.
function albWireReorderRow(row, group, index, label) {
  row.dataset.reorderGroup = group;
  row.dataset.reorderIndex = String(index);
  row.classList.add('alb-reorder-row');
  if (window.matchMedia('(hover: hover)').matches) {
    row.draggable = true;
    // Not while selecting text in a title field.
    row.addEventListener('mousedown', (e) => { row.draggable = !e.target.closest('input'); });
    row.addEventListener('dragstart', (e) => {
      if (e.target !== row) return;
      albRowDrag = { group, index };
      const ghost = albGetDragImageEl();
      ghost.textContent = label;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', label);
      e.dataTransfer.setDragImage(ghost, 12, 16);
      row.classList.add('alb-dragging');
      // Changing the layout inside dragstart can cancel the drag: next frame.
      requestAnimationFrame(() => { if (albRowDrag) albSetDragging(group, true); });
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('alb-dragging');
      albEndRowDrag();
    });
  }
  albWireTouchHold(row, group, index);
}

// Makes `list` (rows already added) a drop list for `group`: appends its
// trailing .alb-drop-tail and wires every row and the tail as targets.
// `onDrop(drag, before)` gets {group, index} of the dragged row.
function albFinishReorderList(list, group, onDrop) {
  list.dataset.dropGroup = group;
  list._albOnDrop = onDrop;
  const tail = el('li', 'alb-drop-tail');
  list.appendChild(tail);
  const rows = Array.from(list.children).filter((n) => n.dataset.reorderGroup === group);
  const targets = [...rows.map((row, i) => [row, i]), [tail, rows.length]];
  for (const [node, before] of targets) {
    node.addEventListener('dragover', (e) => {
      if (!albRowDrag || !albListAccepts(list, albRowDrag.group)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (!node.classList.contains('alb-drop-target')) {
        albClearDropHighlight();
        node.classList.add('alb-drop-target');
      }
    });
    node.addEventListener('dragleave', (e) => {
      if (!node.contains(e.relatedTarget)) node.classList.remove('alb-drop-target');
    });
    node.addEventListener('drop', (e) => {
      if (!albRowDrag || !albListAccepts(list, albRowDrag.group)) return;
      e.preventDefault();
      e.stopPropagation();
      albDropInto(list, albRowDrag, before);
    });
  }
  return tail;
}

// Where a finger at clientY would drop: [list, before, highlighted node].
function albTouchTarget(lists, self, y) {
  let list = null;
  let best = Infinity;
  for (const l of lists) {
    const r = l.getBoundingClientRect();
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < best) { best = d; list = l; }
  }
  if (!list) return [null, 0, null];
  const group = list.dataset.dropGroup;
  const rows = Array.from(list.children).filter((n) => n.dataset.reorderGroup === group);
  for (let i = 0; i < rows.length; i++) {
    if (rows[i] === self) continue;
    const r = rows[i].getBoundingClientRect();
    if (y < r.top + r.height / 2) return [list, i, rows[i]];
  }
  return [list, rows.length, list.querySelector(':scope > .alb-drop-tail')];
}

function albWireTouchHold(row, group, index) {
  let timer = null;
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let startScroll = 0;
  let lists = [];
  let target = [null, 0, null];
  const scroller = () => row.closest('.alb-queue');
  const scrollPos = () => (scroller() ? scroller().scrollTop : window.scrollY);
  const cancelHold = () => { clearTimeout(timer); timer = null; };

  row.addEventListener('touchstart', (e) => {
    if (e.touches.length !== 1 || e.target.closest('.site-icon-btn, input')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    cancelHold();
    timer = setTimeout(() => {
      timer = null;
      dragging = true;
      albRowDrag = { group, index };
      // Showing an empty "Næste i køen" moves the row: follow it.
      const top0 = row.getBoundingClientRect().top;
      albSetDragging(group, true);
      startY += row.getBoundingClientRect().top - top0;
      startScroll = scrollPos();
      lists = Array.from(document.querySelectorAll('[data-drop-group]')).filter((l) => albListAccepts(l, group));
      target = [row.parentElement, index, null];
      row.classList.add('alb-lifted');
      if (navigator.vibrate) navigator.vibrate(10);
    }, ALB_HOLD_MS);
  }, { passive: true });

  row.addEventListener('touchmove', (e) => {
    const t = e.touches[0];
    if (!dragging) {
      if (timer && (Math.abs(t.clientX - startX) > 8 || Math.abs(t.clientY - startY) > 8)) cancelHold();
      return;
    }
    e.preventDefault(); // no scrolling while a row is held
    // Near the top or bottom edge: scroll along (the panel, or the page).
    const box = scroller() ? scroller().getBoundingClientRect() : { top: 56, bottom: window.innerHeight - 100 };
    const step = t.clientY < box.top + 48 ? -8 : t.clientY > box.bottom - 48 ? 8 : 0;
    if (step) { if (scroller()) scroller().scrollTop += step; else window.scrollBy(0, step); }
    row.style.transform = `translateY(${t.clientY - startY + scrollPos() - startScroll}px)`;
    target = albTouchTarget(lists, row, t.clientY);
    albClearDropHighlight();
    if (target[2]) target[2].classList.add('alb-drop-target');
  }, { passive: false });

  const end = (commit) => {
    cancelHold();
    if (!dragging) return;
    dragging = false;
    row.classList.remove('alb-lifted');
    row.style.transform = '';
    albTouchDropped = true;
    setTimeout(() => { albTouchDropped = false; }, 400);
    const drag = albRowDrag;
    if (commit && target[0] && drag) albDropInto(target[0], drag, target[1]);
    else albEndRowDrag();
  };
  row.addEventListener('touchend', () => end(true));
  row.addEventListener('touchcancel', () => end(false));
  // Android opens a context menu on a long press.
  row.addEventListener('contextmenu', (e) => { if (!e.target.closest('input')) e.preventDefault(); });
}

// Edit mode: track `from` goes before track `before` (the count = last).
function albMoveTrackByIndex(album, from, before) {
  const tracks = albTracks(album.id);
  if (!tracks[from]) return;
  albMoveTrack(album, tracks[from], tracks[before] || null);
}

// Moves `file` to just before `beforeFile` (null = last) and saves the order.
async function albMoveTrack(album, file, beforeFile) {
  if (beforeFile && beforeFile.id === file.id) return;
  const ids = albTracks(album.id).map((t) => t.id).filter((id) => id !== file.id);
  const at = beforeFile ? ids.indexOf(beforeFile.id) : -1;
  if (at === -1) ids.push(file.id);
  else ids.splice(at, 0, file.id);
  const before = albTracks(album.id).map((t) => t.id);
  if (before.join() === ids.join()) return;
  ids.forEach((id, i) => { const t = albTrackById(id); if (t) t.order = i; });
  albRender();
  const result = await albApi('albums_reorder', { folderId: album.id, fileIds: ids });
  if (!result.ok) {
    albShowError(result.message);
    albLoad();
    return;
  }
  for (const saved of result.data.files || []) {
    const t = albTrackById(saved.id);
    if (t) t.order = saved.order;
  }
  albPlayerReconcile();
}

// ── Downloads ────────────────────────────────────────────────
// A hidden iframe starts the download without leaving the page (leaving
// would stop the music). iOS gets a new tab instead, opened inside the
// click so it isn't blocked, then pointed at the file.
let albDownloadFrame = null;

async function albSignedDownload(action, body) {
  const win = siteIsIos() ? window.open('', '_blank') : null;
  const result = await albApi(action, body);
  if (!result.ok) {
    if (win) win.close();
    albShowError(result.message);
    return false;
  }
  const sep = SITE_API_ENDPOINT.includes('?') ? '&' : '?';
  const url = SITE_API_ENDPOINT + sep + result.data.query;
  if (siteIsIos()) {
    if (win) win.location.replace(url);
    else siteShowToast('Tillad pop op-vinduer for at downloade.');
    return true;
  }
  if (!albDownloadFrame) {
    albDownloadFrame = document.createElement('iframe');
    albDownloadFrame.hidden = true;
    albDownloadFrame.setAttribute('aria-hidden', 'true');
    document.body.appendChild(albDownloadFrame);
  }
  albDownloadFrame.src = url;
  return true;
}

async function albDownloadAlbum(album) {
  const tracks = albTracks(album.id);
  if (!tracks.length) return;
  const ok = await albSignedDownload('albums_folder_download_url', { folderId: album.id });
  if (!ok) return;
  const total = tracks.reduce((sum, f) => sum + (f.size || 0), 0);
  siteShowToast(`Downloader ${albPlural(tracks.length, 'sang', 'sange')} (${albFormatBytes(total)}) som .zip …`);
}

// ── Upload (boss) ────────────────────────────────────────────
function albPickFiles(album) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = 'audio/*,' + ALB_AUDIO_EXTS.map((ext) => '.' + ext).join(',');
  input.addEventListener('change', () => {
    const picked = Array.from(input.files || []);
    if (picked.length) albOpenUploadModal(picked, album);
  });
  input.click();
}

// Desktop files dropped anywhere on the album card upload into it.
function albWireDesktopDrop(card, album) {
  const isDesktopFiles = (e) => !albRowDrag && e.dataTransfer
    && Array.from(e.dataTransfer.types || []).includes('Files');
  card.addEventListener('dragover', (e) => {
    if (!isDesktopFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    card.classList.add('alb-file-dragover');
  });
  card.addEventListener('dragleave', (e) => {
    if (!card.contains(e.relatedTarget)) card.classList.remove('alb-file-dragover');
  });
  card.addEventListener('drop', (e) => {
    card.classList.remove('alb-file-dragover');
    if (albRowDrag || !e.dataTransfer || !e.dataTransfer.files.length) return;
    e.preventDefault();
    albOpenUploadModal(Array.from(e.dataTransfer.files), album);
  });
}

function albFileExt(name) {
  return (name.includes('.') ? name.split('.').pop() : '').toLowerCase();
}

// "03 - Hej_med_dig.flac" → {track: 3, title: 'Hej med dig'}.
function albParseFileName(name) {
  let base = name.replace(/\.[^.]+$/, '').replace(/_/g, ' ').trim();
  let track = null;
  const m = /^(\d{1,3})(?:\s*[-.)]\s*|\s+)(.+)$/.exec(base);
  if (m) {
    track = Number(m[1]);
    base = m[2].trim();
  }
  return { track, title: base.replace(/\s+/g, ' ') };
}

function albUsedBytes() {
  return albState.files.reduce((sum, f) => sum + (f.size || 0), 0);
}

function albFreeBytes() {
  const queued = albQueue.reduce((sum, item) => sum + (item.state === 'failed' ? 0 : item.file.size), 0);
  return Math.max(0, albQuotaBytes - albUsedBytes() - queued);
}

// One title per song (prefilled from the file name, without a leading
// track number), in track-number order. New songs go last in the album.
function albOpenUploadModal(files, album) {
  const valid = files.filter((file) => {
    if (!ALB_AUDIO_EXTS.includes(albFileExt(file.name))) {
      siteShowToast(`"${file.name}" blev sprunget over (kun ${ALB_AUDIO_EXTS.join(', ')}).`);
      return false;
    }
    if (file.size) return true;
    siteShowToast(`"${file.name}" blev sprunget over (tom fil).`);
    return false;
  });
  if (!valid.length) return;
  const parsed = valid.map((file) => ({ file, ...albParseFileName(file.name) }));
  parsed.sort((a, b) => {
    if (a.track != null && b.track != null && a.track !== b.track) return a.track - b.track;
    return a.file.name.localeCompare(b.file.name, 'da', { numeric: true, sensitivity: 'base' });
  });
  const total = valid.reduce((sum, f) => sum + f.size, 0);

  const { modal, form, error, actions, close } = siteOpenModalWithClose(
    valid.length === 1 ? 'Upload sang' : `Upload ${valid.length} sange`
  );
  modal.classList.add('site-modal-md', 'alb-upload-modal');
  form.appendChild(el('p', 'alb-upload-hint',
    `Til ${albAlbumName(album)}. Ret titlerne, hvis de ikke passer. Sangene kommer sidst i albummet i denne rækkefølge.`));
  const list = el('ol', 'alb-upload-list');
  const entries = parsed.map(({ file, title }) => {
    const item = el('li', 'edit-field alb-upload-item'); // .edit-field = site input styling
    const head = el('div', 'alb-upload-item-head');
    head.appendChild(el('span', 'alb-upload-item-name', file.name));
    head.appendChild(el('span', 'alb-upload-item-size', albFormatBytes(file.size)));
    item.appendChild(head);
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 180;
    input.value = title;
    input.placeholder = 'Titel';
    input.setAttribute('aria-label', `Titel til ${file.name}`);
    item.appendChild(input);
    list.appendChild(item);
    return { file, input };
  });
  form.appendChild(list);
  const free = albFreeBytes();
  form.appendChild(el('p', 'alb-upload-space', `I alt ${albFormatBytes(total)} · ${albFormatBytes(free)} ledigt`));

  const uploadBtn = albPillBtn('Upload', 'site-btn-success');
  if (total > free) {
    error.textContent = `Der er ikke plads: sangene fylder ${albFormatBytes(total)}, men der er kun ${albFormatBytes(free)} ledigt.`;
    uploadBtn.disabled = true;
  }
  function submit() {
    if (uploadBtn.disabled) return;
    const missing = entries.find((entry) => !entry.input.value.trim());
    if (missing) {
      error.textContent = 'Giv hver sang en titel.';
      missing.input.focus();
      return;
    }
    close();
    albEnqueue(entries.map(({ file, input }) => ({
      file, name: `${input.value.trim().replace(/[\\/]/g, '-')}.${albFileExt(file.name)}`,
    })), album.id);
  }
  uploadBtn.addEventListener('click', submit);
  entries.forEach(({ input }, i) => {
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      if (i + 1 < entries.length) entries[i + 1].input.focus();
      else submit();
    });
  });
  actions.appendChild(uploadBtn);
  entries[0].input.focus();
}

// ── Upload queue (a page-scoped copy of sangere.js's) ────────
// [{key, file, name, folderId, sent, state: 'waiting'|'uploading'|'failed', message, cancelled, uploadId}]
const albQueue = [];
let albQueueRunning = false;
let albUploadKey = 0;
let albPanelEl = null;

function albUploadsPending() {
  return albQueue.some((item) => item.state !== 'failed');
}

function albUploadPanel() {
  if (!albPanelEl) albPanelEl = el('section', 'card alb-uploads');
  return albPanelEl;
}

function albEnqueue(items, folderId) {
  for (const { file, name } of items) {
    albQueue.push({ key: ++albUploadKey, file, name, folderId, sent: 0, state: 'waiting', message: '', cancelled: false, uploadId: null });
  }
  albRenderUploads();
  albRunQueue();
}

function albRenderUploads() {
  const panel = albUploadPanel();
  panel.hidden = !albQueue.length;
  if (!albQueue.length) { panel.replaceChildren(); return; }
  const head = el('div', 'card-head alb-uploads-head');
  head.appendChild(el('h2', null, 'Uploads'));
  if (albQueue.some((item) => item.state === 'failed')) {
    const clearBtn = albBtn('Ryd fejlede');
    clearBtn.addEventListener('click', () => {
      for (let i = albQueue.length - 1; i >= 0; i--) {
        if (albQueue[i].state === 'failed') albQueue.splice(i, 1);
      }
      albRenderUploads();
    });
    head.appendChild(clearBtn);
  }
  panel.replaceChildren(head);
  for (const item of albQueue) panel.appendChild(albBuildUploadRow(item));
}

function albBuildUploadRow(item) {
  const row = el('div', 'alb-upload');
  const top = el('div', 'alb-upload-top');
  top.appendChild(el('span', 'alb-upload-name', item.name));
  const album = albAlbumById(item.folderId);
  top.appendChild(el('span', 'alb-upload-where', '→ ' + (album ? albAlbumName(album) : 'slettet album')));
  const status = el('span', 'alb-upload-status');
  item.statusEl = status;
  top.appendChild(status);
  const cancelBtn = albRemoveBtn(item.state === 'failed' ? 'Fjern' : 'Annuller upload');
  cancelBtn.addEventListener('click', () => albCancelUpload(item));
  top.appendChild(cancelBtn);
  row.appendChild(top);
  const bar = el('div', 'alb-progress');
  const fill = el('div', 'alb-progress-fill');
  item.fillEl = fill;
  bar.appendChild(fill);
  row.appendChild(bar);
  if (item.state === 'failed') row.classList.add('alb-upload-failed');
  albPaintUpload(item);
  return row;
}

function albPaintUpload(item) {
  if (!item.statusEl) return;
  const pct = item.file.size ? Math.floor((item.sent / item.file.size) * 100) : 0;
  item.fillEl.style.width = pct + '%';
  if (item.state === 'failed') item.statusEl.textContent = item.message || 'Fejlede';
  else if (item.state === 'waiting') item.statusEl.textContent = 'Venter';
  else if (item.cancelled) item.statusEl.textContent = 'Annullerer…';
  else item.statusEl.textContent = `${pct} % af ${albFormatBytes(item.file.size)}`;
}

function albRemoveFromQueue(item) {
  const idx = albQueue.indexOf(item);
  if (idx >= 0) albQueue.splice(idx, 1);
  albRenderUploads();
}

function albCancelUpload(item) {
  if (item.state === 'uploading') {
    item.cancelled = true; // the running loop aborts after its current chunk
    albPaintUpload(item);
    return;
  }
  albRemoveFromQueue(item);
}

async function albRunQueue() {
  if (albQueueRunning) return;
  albQueueRunning = true;
  for (;;) {
    const item = albQueue.find((i) => i.state === 'waiting');
    if (!item) break;
    item.state = 'uploading';
    albPaintUpload(item);
    const outcome = await albUploadOne(item);
    if (outcome.ok) {
      albQueue.splice(albQueue.indexOf(item), 1);
      albState.files.push(outcome.file);
      // The new song needs a stream link before it can play.
      await albRefreshStreamUrls();
      albRender();
      siteShowToast(`"${albTrackTitle(outcome.file)}" er uploadet.`);
    } else if (outcome.cancelled) {
      albRemoveFromQueue(item);
    } else {
      item.state = 'failed';
      item.message = outcome.message || 'Fejlede';
      albRenderUploads();
    }
  }
  albQueueRunning = false;
}

// The song's length, read in the browser before upload (null if it can't).
function albMeasureDuration(file) {
  return new Promise((resolve) => {
    const audio = document.createElement('audio');
    audio.preload = 'metadata';
    const url = URL.createObjectURL(file);
    let done = false;
    const finish = (value) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      audio.removeAttribute('src');
      audio.load();
      URL.revokeObjectURL(url);
      resolve(value);
    };
    const timer = setTimeout(() => finish(null), 10000);
    audio.addEventListener('loadedmetadata', () => {
      finish(Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : null);
    });
    audio.addEventListener('error', () => finish(null));
    audio.src = url;
  });
}

function albReadChunkBase64(blob) {
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

function albDelay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Returns {ok, file} | {cancelled} | {message}.
async function albUploadOne(item) {
  const { file } = item;
  const durationSec = await albMeasureDuration(file);
  const start = await albApi('albums_upload_start', {
    folderId: item.folderId, name: item.name, size: file.size,
    ...(durationSec ? { durationSec: Math.round(durationSec * 10) / 10 } : {}),
  });
  if (!start.ok) return { message: start.message || 'Annulleret' };
  item.uploadId = start.data.uploadId;
  const chunkBytes = Math.min(ALB_CHUNK_BYTES, start.data.chunkBytes || ALB_CHUNK_BYTES);
  let offset = 0;
  while (offset < file.size) {
    if (item.cancelled) {
      await albApi('albums_upload_abort', { uploadId: item.uploadId });
      return { cancelled: true };
    }
    let contentBase64;
    try {
      contentBase64 = await albReadChunkBase64(file.slice(offset, offset + chunkBytes));
    } catch (e) {
      await albApi('albums_upload_abort', { uploadId: item.uploadId });
      return { message: 'Kunne ikke læse filen.' };
    }
    let result = null;
    for (let attempt = 1; attempt <= ALB_CHUNK_ATTEMPTS; attempt++) {
      result = await albApi('albums_upload_chunk', { uploadId: item.uploadId, offset, contentBase64 });
      // Network errors and 5xx are worth retrying; 4xx won't change.
      if (result.ok || (result.status >= 400 && result.status < 500)) break;
      if (attempt < ALB_CHUNK_ATTEMPTS) await albDelay(1000 * 2 ** attempt);
    }
    if (!result.ok) {
      // The server holds a different amount than we think: carry on from there.
      if (result.status === 409 && result.data && Number.isInteger(result.data.received)) {
        offset = result.data.received;
        continue;
      }
      await albApi('albums_upload_abort', { uploadId: item.uploadId });
      return { message: result.message };
    }
    offset = Math.max(offset, result.data.received);
    item.sent = offset;
    albPaintUpload(item);
  }
  const finish = await albApi('albums_upload_finish', { uploadId: item.uploadId });
  if (!finish.ok) {
    if (finish.status === 404) return { message: 'Albummet blev slettet under uploaden.' };
    return { message: finish.message };
  }
  return { ok: true, file: finish.data.file };
}

// ── Player ───────────────────────────────────────────────────
// Two parts, like most music players:
//   * the context: what was started (an album, or every song for "Bland
//     alle"). `ctxIds` is its album order, `ctxOrder` the order it plays in
//     (the same unless shuffled: then the current song first, the rest
//     mixed), `ctxPos` the context song playing now, or the last one played
//     before a queued song. `ctxFolder` = the album (null = "Bland alle").
//   * `upNext` ("Næste i køen"): songs added by hand ("Spil som næste",
//     "Tilføj til køen"), played before the context continues.
// `nowId` is the song in the player; `nowQueued` = it came from upNext.
const ALB_PLAYER_KEY = 'matrevy-albums-player';
const albPlayer = {
  audio: null,
  ctxIds: [],
  ctxOrder: [],
  ctxPos: -1,
  ctxFolder: null,
  upNext: [],
  nowId: null,
  nowQueued: false,
  shuffle: false,
  repeat: 'off', // 'off' | 'all' | 'one'
  loadedId: null, // the track whose src is in the audio element
  pendingSeek: 0, // where to start once its metadata has loaded
  resumeAt: 0, // a restored position, used by the next play
  retriedId: null, // a track already retried once after an error
  seeking: false, // the seek bar is being dragged
  spare: null, // a second <audio> holding the preloaded next song (Android)
  spareId: null, // the song in `spare`
};
let albPlayerEls = null;

// Only the element in albPlayer.audio reports to the player; the spare's
// events (loading the next song) are ignored until it's swapped in.
function albCreateAudioEl() {
  const audio = document.createElement('audio');
  audio.preload = 'metadata';
  const on = (type, handler) => audio.addEventListener(type, (e) => {
    if (audio === albPlayer.audio) handler(e);
  });
  on('play', albOnPlayState);
  on('pause', albOnPlayState);
  on('playing', albOnPlayState);
  on('waiting', albOnPlayState);
  on('timeupdate', albOnTimeUpdate);
  on('loadedmetadata', albOnMetadata);
  on('ended', () => albNext(true));
  on('error', albOnAudioError);
  document.body.appendChild(audio);
  return audio;
}

function albAudio() {
  if (!albPlayer.audio) {
    albPlayer.audio = albCreateAudioEl();
    albApplyVolume();
  }
  return albPlayer.audio;
}

// ── Preloading the next song (Android) ───────────────────────
// With the screen off, Chrome on Android doesn't reliably start the next
// song: between `ended` and the new FLAC's first bytes the hidden tab plays
// nothing, and Android may throttle it, cut its network or refuse the
// play(). So the next song is loaded into a second <audio> the last
// ALB_PRELOAD_SEC of a song, and `ended` swaps it in and plays it at once.
// Not on iOS (an element only plays locked once a tap started it, and the
// single element already works there) or desktop.
const ALB_PRELOAD = /Android/i.test(navigator.userAgent);
const ALB_PRELOAD_SEC = 30;

// The song albNext() would play, without changing anything. Null for repeat
// one (the same element replays) and for a shuffled repeat-all wrap (the new
// order isn't drawn yet).
function albPeekNextId() {
  if (albPlayer.repeat === 'one') return null;
  if (albPlayer.upNext.length) return albPlayer.upNext[0];
  const next = albPlayer.ctxPos + 1;
  if (next < albPlayer.ctxOrder.length) return albPlayer.ctxOrder[next];
  if (albPlayer.repeat === 'all' && !albPlayer.shuffle) return albPlayer.ctxOrder[0] || null;
  return null;
}

// Runs on every timeupdate; a changed queue preloads the new next song.
function albMaybePreload() {
  if (!ALB_PRELOAD) return;
  const audio = albPlayer.audio;
  if (!audio || audio.paused || !albPlayer.loadedId || !Number.isFinite(audio.duration)) return;
  if (audio.duration - audio.currentTime > ALB_PRELOAD_SEC) return;
  const id = albPeekNextId();
  if (!id || id === albPlayer.loadedId || id === albPlayer.spareId) return;
  const url = albStreamUrl(albTrackById(id));
  if (!url) return;
  if (!albPlayer.spare) albPlayer.spare = albCreateAudioEl();
  const spare = albPlayer.spare;
  spare.preload = 'auto';
  spare.volume = albVolume.level;
  spare.muted = albVolume.muted;
  spare.src = url;
  albPlayer.spareId = id;
}

function albClearSpare() {
  const spare = albPlayer.spare;
  albPlayer.spareId = null;
  if (!spare || !spare.getAttribute('src')) return;
  spare.pause();
  spare.removeAttribute('src');
  spare.load();
}

// The preloaded element, if it holds this song from its start: it becomes
// the player's element and the old one the (emptied) spare.
function albTakeSpare(id, startAt) {
  const spare = albPlayer.spare;
  if (!spare || albPlayer.spareId !== id || startAt || spare.error) return null;
  albPlayer.spare = albPlayer.audio;
  albPlayer.audio = spare;
  albClearSpare();
  return spare;
}

function albCurrentTrack() {
  return albPlayer.nowId ? albTrackById(albPlayer.nowId) : null;
}

function albIsPlaying() {
  return !!albPlayer.audio && !albPlayer.audio.paused && !!albPlayer.loadedId;
}

function albShuffled(ids) {
  const list = ids.slice();
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

// Starts a context. `startId` null = the first song (a random one when
// shuffling). Songs queued by hand stay queued.
function albStartContext(ids, startId, shuffle, folder) {
  if (!ids.length) return;
  albPlayer.ctxIds = ids.slice();
  albPlayer.ctxFolder = folder;
  albPlayer.shuffle = shuffle;
  if (shuffle) {
    const first = startId || ids[Math.floor(Math.random() * ids.length)];
    albPlayer.ctxOrder = [first, ...albShuffled(ids.filter((id) => id !== first))];
    albPlayer.ctxPos = 0;
  } else {
    albPlayer.ctxOrder = ids.slice();
    albPlayer.ctxPos = Math.max(0, startId ? ids.indexOf(startId) : 0);
  }
  albPlayer.nowQueued = false;
  albLoadTrack(albPlayer.ctxOrder[albPlayer.ctxPos], 0);
}

function albPlayAlbum(album, startId, shuffle) {
  albStartContext(albTracks(album.id).map((t) => t.id), startId, shuffle, album.id);
}

function albShuffleAll() {
  const ids = albAlbums().flatMap((album) => albTracks(album.id).map((t) => t.id));
  albStartContext(ids, null, true, null);
}

// Loads a song and plays it. Runs synchronously inside the tap (the stream
// URL is already known), which is what lets iOS start the audio.
function albLoadTrack(id, startAt) {
  const file = albTrackById(id);
  if (!file) return;
  albPlayer.nowId = file.id;
  const url = albStreamUrl(file);
  if (!url) {
    // Uploaded after this page loaded its links: fetch them and try again.
    albPaintPlayer();
    albRefreshStreamUrls().then((ok) => {
      if (ok && albStreamUrl(file) && albPlayer.nowId === file.id) albLoadTrack(file.id, startAt);
      else if (!ok || !albStreamUrl(file)) albShowError('Sangen kan ikke afspilles lige nu. Genindlæs siden.');
    });
    return;
  }
  // A new listen, unless this resumes the same song (a renewed link).
  if (albListen.id !== file.id || !startAt) albResetListen(file.id);
  albPlayer.loadedId = file.id;
  albPlayer.pendingSeek = startAt || 0;
  albPlayer.resumeAt = 0;
  if (albPlayer.retriedId !== file.id) albPlayer.retriedId = null;
  const preloaded = albTakeSpare(file.id, startAt);
  if (preloaded) {
    albTryPlay();
    // Its metadata arrived while it was the spare (ignored then).
    if (preloaded.readyState >= 1) albOnMetadata();
  } else {
    albClearSpare(); // a different song: stop fetching the preloaded one
    albAudio().src = url;
    albTryPlay();
  }
  albUpdateMediaSession();
  albPaintPlayer();
  albMarkPlaying();
  albSaveState();
  // Links expiring within the hour: renew them in the background.
  if (albStreamExpires && albStreamExpires - Date.now() < 3600 * 1000) albRefreshStreamUrls();
}

function albTryPlay() {
  const p = albAudio().play();
  if (p && typeof p.catch === 'function') {
    p.catch((e) => {
      if (e && e.name === 'NotAllowedError') albPaintPlayer();
    });
  }
}

function albTogglePlay() {
  const file = albCurrentTrack();
  if (!file) return;
  const audio = albAudio();
  if (albPlayer.loadedId !== file.id) {
    // A restored player: nothing loaded yet, so load it at the saved spot.
    albLoadTrack(file.id, albPlayer.resumeAt);
    return;
  }
  if (audio.paused) albTryPlay();
  else audio.pause();
}

function albHasNext() {
  return albPlayer.upNext.length > 0 || albPlayer.ctxPos < albPlayer.ctxOrder.length - 1
    || (albPlayer.repeat === 'all' && albPlayer.ctxOrder.length > 0);
}

// `auto` = the song ended by itself (repeat one replays it then).
function albNext(auto) {
  if (!albCurrentTrack()) return;
  const audio = albAudio();
  if (auto && albPlayer.repeat === 'one') {
    audio.currentTime = 0;
    albResetListen(albPlayer.nowId); // each round is a play of its own
    albTryPlay();
    return;
  }
  if (albPlayer.upNext.length) {
    albPlayer.nowQueued = true;
    albLoadTrack(albPlayer.upNext.shift(), 0);
    return;
  }
  let next = albPlayer.ctxPos + 1;
  if (next >= albPlayer.ctxOrder.length) {
    if (albPlayer.repeat !== 'all' || !albPlayer.ctxOrder.length) {
      // The end: stop on the last song, back at its start.
      if (auto) {
        audio.pause();
        audio.currentTime = 0;
        albSaveState();
      }
      return;
    }
    if (albPlayer.shuffle) albPlayer.ctxOrder = albShuffled(albPlayer.ctxOrder);
    next = 0;
  }
  albPlayer.ctxPos = next;
  albPlayer.nowQueued = false;
  albLoadTrack(albPlayer.ctxOrder[next], 0);
}

// After 3 s it restarts the song; from a queued song it goes back to the
// context song played before it.
function albPrev() {
  if (!albCurrentTrack()) return;
  const audio = albAudio();
  const restart = () => { if (albPlayer.loadedId) audio.currentTime = 0; };
  if (albPlayer.loadedId && audio.currentTime > 3) { restart(); return; }
  if (albPlayer.nowQueued) {
    if (albPlayer.ctxPos < 0) { restart(); return; }
    albPlayer.nowQueued = false;
    albLoadTrack(albPlayer.ctxOrder[albPlayer.ctxPos], 0);
    return;
  }
  let prev = albPlayer.ctxPos - 1;
  if (prev < 0) {
    if (albPlayer.repeat !== 'all') { restart(); return; }
    prev = albPlayer.ctxOrder.length - 1;
  }
  albPlayer.ctxPos = prev;
  albLoadTrack(albPlayer.ctxOrder[prev], 0);
}

function albToggleShuffle() {
  const anchor = albPlayer.ctxOrder[albPlayer.ctxPos];
  albPlayer.shuffle = !albPlayer.shuffle;
  if (albPlayer.shuffle) {
    albPlayer.ctxOrder = anchor
      ? [anchor, ...albShuffled(albPlayer.ctxIds.filter((id) => id !== anchor))]
      : albShuffled(albPlayer.ctxIds);
    albPlayer.ctxPos = anchor ? 0 : -1;
  } else {
    albPlayer.ctxOrder = albPlayer.ctxIds.slice();
    albPlayer.ctxPos = anchor ? albPlayer.ctxOrder.indexOf(anchor) : -1;
  }
  albPaintPlayer();
  albSaveState();
}

function albCycleRepeat() {
  albPlayer.repeat = albPlayer.repeat === 'off' ? 'all' : albPlayer.repeat === 'all' ? 'one' : 'off';
  albPaintPlayer();
  albSaveState();
}

// ── Queue ("Næste i køen") ───────────────────────────────────
// "Spil som næste" puts the song first in the queue, "Tilføj til køen"
// last. With nothing in the player, the song just starts playing.
function albQueueAdd(file, playNext) {
  if (!albCurrentTrack()) {
    Object.assign(albPlayer, { ctxIds: [], ctxOrder: [], ctxPos: -1, ctxFolder: null, nowQueued: true });
    albLoadTrack(file.id, 0);
    return;
  }
  if (playNext) albPlayer.upNext.unshift(file.id);
  else albPlayer.upNext.push(file.id);
  albPaintPlayer();
  albSaveState();
  siteShowToast(playNext ? `"${albTrackTitle(file)}" spilles som det næste.` : `"${albTrackTitle(file)}" er tilføjet til køen.`);
}

// The whole album, in album order, last in the queue. With nothing in the
// player, its first song starts and the rest are queued behind it.
function albQueueAddAlbum(album) {
  const ids = albTracks(album.id).map((t) => t.id);
  if (!ids.length) return;
  if (!albCurrentTrack()) {
    Object.assign(albPlayer, { ctxIds: [], ctxOrder: [], ctxPos: -1, ctxFolder: null, nowQueued: true });
    albPlayer.upNext.push(...ids.slice(1));
    albLoadTrack(ids[0], 0);
    return;
  }
  albPlayer.upNext.push(...ids);
  albPaintPlayer();
  albSaveState();
  const count = ids.length === 1 ? '1 sang' : `${ids.length} sange`;
  siteShowToast(`${count} fra ${albAlbumName(album)} er tilføjet til køen.`);
}

// Plays the queued song at `index`, dropping the ones before it.
function albQueueJump(index) {
  const id = albPlayer.upNext[index];
  if (!id) return;
  albPlayer.upNext.splice(0, index + 1);
  albPlayer.nowQueued = true;
  albLoadTrack(id, 0);
}

// Plays the context song at ctxOrder[`pos`] (skipping straight to it).
function albContextJump(pos) {
  if (!albPlayer.ctxOrder[pos]) return;
  albPlayer.ctxPos = pos;
  albPlayer.nowQueued = false;
  albLoadTrack(albPlayer.ctxOrder[pos], 0);
}

function albQueueRemove(index) {
  albPlayer.upNext.splice(index, 1);
  albPaintPlayer();
  albSaveState();
}

// Removes an upcoming context song (it won't come back on unshuffle either).
function albContextRemove(pos) {
  if (pos <= albPlayer.ctxPos) return;
  const [id] = albPlayer.ctxOrder.splice(pos, 1);
  const i = albPlayer.ctxIds.indexOf(id);
  if (i !== -1) albPlayer.ctxIds.splice(i, 1);
  albPaintPlayer();
  albSaveState();
}

// Moves context song ctxOrder[`from`] to just before ctxOrder[`before`]
// (both upcoming). Unshuffled, the album order follows it.
function albContextMove(from, before) {
  const list = albPlayer.ctxOrder;
  if (from <= albPlayer.ctxPos || before <= albPlayer.ctxPos || from >= list.length) return;
  if (before === from || before === from + 1) return;
  const [id] = list.splice(from, 1);
  list.splice(before > from ? before - 1 : before, 0, id);
  if (!albPlayer.shuffle) albPlayer.ctxIds = list.slice();
  albPaintPlayer();
  albSaveState();
}

// Moves context song ctxOrder[`pos`] into "Næste i køen" before `before`.
function albContextToQueue(pos, before) {
  if (pos <= albPlayer.ctxPos || pos >= albPlayer.ctxOrder.length) return;
  const [id] = albPlayer.ctxOrder.splice(pos, 1);
  const i = albPlayer.ctxIds.indexOf(id);
  if (i !== -1) albPlayer.ctxIds.splice(i, 1);
  albPlayer.upNext.splice(Math.min(before, albPlayer.upNext.length), 0, id);
  albPaintPlayer();
  albSaveState();
}

function albQueueClear() {
  albPlayer.upNext = [];
  albPaintPlayer();
  albSaveState();
}

// Moves queued song `from` to just before `before` (upNext.length = last).
function albQueueMove(from, before) {
  const list = albPlayer.upNext;
  if (from < 0 || from >= list.length || before === from || before === from + 1) return;
  const [id] = list.splice(from, 1);
  list.splice(before > from ? before - 1 : before, 0, id);
  albPaintPlayer();
  albSaveState();
}

// After tracks were deleted or reloaded: drop the ones that are gone (the
// queue keeps its order). Stops if the current one is gone.
function albPlayerReconcile() {
  if (!albState || !albPlayer.nowId) { albPaintPlayer(); return; }
  const exists = (id) => !!albTrackById(id);
  if (!exists(albPlayer.nowId)) {
    albStopPlayer();
    return;
  }
  const anchor = albPlayer.ctxOrder[albPlayer.ctxPos];
  const oldPos = albPlayer.ctxPos;
  // Keeps the queue's own order (it may have been rearranged by hand).
  albPlayer.ctxIds = albPlayer.ctxIds.filter(exists);
  albPlayer.ctxOrder = albPlayer.ctxOrder.filter(exists);
  const at = anchor ? albPlayer.ctxOrder.indexOf(anchor) : -1;
  albPlayer.ctxPos = at !== -1 ? at : Math.min(oldPos, albPlayer.ctxOrder.length) - 1;
  albPlayer.upNext = albPlayer.upNext.filter(exists);
  albPaintPlayer();
  albSaveState();
}

function albStopPlayer() {
  if (albPlayer.audio) {
    albPlayer.audio.pause();
    albPlayer.audio.removeAttribute('src');
    albPlayer.audio.load();
  }
  albClearSpare();
  Object.assign(albPlayer, {
    ctxIds: [], ctxOrder: [], ctxPos: -1, ctxFolder: null, upNext: [],
    nowId: null, nowQueued: false, loadedId: null, resumeAt: 0,
  });
  albSaveState();
  albPaintPlayer();
  albMarkPlaying();
  albUpdateMediaSession();
}

// ── Audio events ─────────────────────────────────────────────
// Only one thing plays at a time on Arkiv: a player that starts says so
// with 'arkiv-media-play' ({source}), and the others pause.
document.addEventListener('arkiv-media-play', (e) => {
  if (e.detail && e.detail.source !== 'albums' && albIsPlaying()) albPlayer.audio.pause();
});

function albOnPlayState(e) {
  if (e && e.type === 'play') {
    document.dispatchEvent(new CustomEvent('arkiv-media-play', { detail: { source: 'albums' } }));
    // Videoer sets its own lock screen handlers while a video plays.
    albInitMediaSession();
    albUpdateMediaSession();
  }
  albPaintPlayer();
  albMarkPlaying();
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = albIsPlaying() ? 'playing' : 'paused';
  }
  if (albPlayer.audio && albPlayer.audio.paused) albSaveState();
}

let albLastSave = 0;
function albOnTimeUpdate() {
  albPaintProgress();
  albTrackListening();
  albMaybePreload();
  if (Date.now() - albLastSave > 5000) albSaveState();
}

// ── Play counts ──────────────────────────────────────────────
// Like Spotify: a play counts once a song has actually been listened to
// for 30 s (half of it, if it's shorter than a minute). Only time that
// passes while playing adds up; seeking doesn't (a jump > 1.5 s between two
// timeupdates is ignored). One count per start; repeat one counts again.
const ALB_PLAY_COUNT_SEC = 30;
const albListen = { id: null, secs: 0, last: 0, counted: false };

function albResetListen(id) {
  Object.assign(albListen, { id, secs: 0, last: 0, counted: false });
}

function albTrackListening() {
  const audio = albPlayer.audio;
  if (!audio || albListen.id !== albPlayer.loadedId) return;
  const t = audio.currentTime || 0;
  const step = t - albListen.last;
  albListen.last = t;
  if (audio.paused || albListen.counted || step <= 0 || step > 1.5) return;
  albListen.secs += step;
  const file = albTrackById(albListen.id);
  const length = Number.isFinite(audio.duration) ? audio.duration : (file && file.durationSec) || 0;
  const needed = length ? Math.min(ALB_PLAY_COUNT_SEC, length / 2) : ALB_PLAY_COUNT_SEC;
  if (albListen.secs < needed) return;
  albListen.counted = true;
  if (file) albCountPlay(file);
}

// Quietly, in the background: no password prompt (a stored login only)
// and no error toast; a lost count just isn't counted.
async function albCountPlay(file) {
  const auth = (typeof getSiteAuth === 'function') ? getSiteAuth() : null;
  if (!auth || !auth.password) return;
  try {
    const res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'albums_count_play', password: auth.password, fileId: file.id }),
    });
    const data = await res.json();
    if (!res.ok || !data || data.ok !== true || !Number.isInteger(data.plays)) return;
    file.plays = data.plays;
    document.querySelectorAll(`.alb-track[data-file-id="${file.id}"] .alb-track-plays`).forEach((n) => albPaintPlays(n, file));
  } catch (e) { /* offline: not counted */ }
}

// A track's plays: imported from Spotify/SoundCloud (`playsImported`, set
// by boss) plus the ones counted here (`plays`).
function albTotalPlays(file) {
  return (file.playsImported || 0) + (file.plays || 0);
}

// "▶ 1.234" in a track row (empty until a song has been played).
function albPaintPlays(node, file) {
  const n = albTotalPlays(file);
  node.replaceChildren();
  node.title = (n === 1 ? 'Afspillet 1 gang' : `Afspillet ${n.toLocaleString('da-DK')} gange`)
    + (file.playsImported ? ` (heraf ${file.playsImported.toLocaleString('da-DK')} fra Spotify og SoundCloud)` : '');
  if (!n) return;
  node.appendChild(albIcon('play', 10));
  node.appendChild(document.createTextNode(n.toLocaleString('da-DK')));
}

function albOnMetadata() {
  const audio = albAudio();
  if (albPlayer.pendingSeek > 0 && albPlayer.pendingSeek < audio.duration - 1) {
    audio.currentTime = albPlayer.pendingSeek;
  }
  albPlayer.pendingSeek = 0;
  // A song uploaded without a measured length gets one now (this tab only).
  const file = albCurrentTrack();
  if (file && !(file.durationSec > 0) && Number.isFinite(audio.duration)) {
    file.durationSec = audio.duration;
  }
  albPaintProgress();
  albUpdatePositionState();
}

// An expired or broken link: fetch fresh ones and resume once; then give up.
function albOnAudioError() {
  const file = albCurrentTrack();
  const audio = albAudio();
  if (!file || !albPlayer.loadedId || !audio.getAttribute('src')) return;
  if (albPlayer.retriedId === file.id) {
    albShowError('Sangen kunne ikke afspilles.');
    albPaintPlayer();
    return;
  }
  albPlayer.retriedId = file.id;
  const at = audio.currentTime || 0;
  albRefreshStreamUrls().then((ok) => {
    if (!ok || albPlayer.nowId !== file.id) return;
    albLoadTrack(file.id, at);
  });
}

// ── Lock screen / Control Center (Media Session) ─────────────
function albUpdateMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const file = albCurrentTrack();
  if (!file || typeof MediaMetadata === 'undefined') {
    navigator.mediaSession.metadata = null;
    return;
  }
  const album = albAlbumById(file.folderId);
  const cover = albAlbumCover(album);
  navigator.mediaSession.metadata = new MediaMetadata({
    title: albTrackTitle(file),
    artist: albAlbumName(album),
    album: 'Matematikrevyen',
    artwork: cover ? [{ src: new URL(cover, location.href).href, sizes: '512x512', type: 'image/jpeg' }] : [],
  });
}

function albUpdatePositionState() {
  const audio = albPlayer.audio;
  if (!audio || !('mediaSession' in navigator) || !navigator.mediaSession.setPositionState) return;
  if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
  try {
    navigator.mediaSession.setPositionState({
      duration: audio.duration,
      playbackRate: audio.playbackRate || 1,
      position: Math.min(audio.currentTime, audio.duration),
    });
  } catch (e) { /* ignore */ }
}

// No seekbackward/seekforward: iOS shows ±10 s buttons instead of
// previous/next while those are offered, and Safari offers them by default.
// Clearing one only drops it once the page has set it, hence set, then clear.
function albInitMediaSession() {
  if (!('mediaSession' in navigator)) return;
  const set = (action, handler) => {
    try { navigator.mediaSession.setActionHandler(action, handler); } catch (e) { /* unsupported */ }
  };
  for (const action of ['seekbackward', 'seekforward']) {
    set(action, () => {});
    set(action, null);
  }
  set('play', () => albTogglePlayTo(true));
  set('pause', () => albTogglePlayTo(false));
  set('previoustrack', () => albPrev());
  set('nexttrack', () => albNext(false));
  set('seekto', (details) => {
    const audio = albPlayer.audio;
    if (!audio || !albPlayer.loadedId || !Number.isFinite(details.seekTime)) return;
    audio.currentTime = details.seekTime;
    albUpdatePositionState();
  });
}

function albTogglePlayTo(play) {
  const audio = albPlayer.audio;
  const loaded = audio && albPlayer.loadedId && albPlayer.loadedId === albPlayer.nowId;
  if (play) {
    if (loaded) albTryPlay();
    else albTogglePlay();
  } else if (loaded) {
    audio.pause();
  }
}

// ── Remembered between visits (localStorage) ─────────────────
function albSaveState() {
  albLastSave = Date.now();
  const audio = albPlayer.audio;
  const position = albPlayer.loadedId && audio ? audio.currentTime || 0 : albPlayer.resumeAt;
  const state = {
    ctxIds: albPlayer.ctxIds,
    ctxOrder: albPlayer.ctxOrder,
    ctxPos: albPlayer.ctxPos,
    ctxFolder: albPlayer.ctxFolder,
    upNext: albPlayer.upNext,
    nowId: albPlayer.nowId,
    nowQueued: albPlayer.nowQueued,
    shuffle: albPlayer.shuffle,
    repeat: albPlayer.repeat,
    position: Math.round(position),
  };
  try { localStorage.setItem(ALB_PLAYER_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
}

function albRestoreState() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem(ALB_PLAYER_KEY) || 'null'); } catch (e) { state = null; }
  if (!state || typeof state !== 'object' || typeof state.nowId !== 'string') return;
  const ids = (v) => (Array.isArray(v) ? v.filter((id) => typeof id === 'string') : []);
  albPlayer.ctxIds = ids(state.ctxIds);
  albPlayer.ctxOrder = ids(state.ctxOrder);
  albPlayer.ctxPos = Number.isInteger(state.ctxPos) && state.ctxPos < albPlayer.ctxOrder.length ? state.ctxPos : -1;
  albPlayer.ctxFolder = typeof state.ctxFolder === 'string' ? state.ctxFolder : null;
  albPlayer.upNext = ids(state.upNext);
  albPlayer.nowId = state.nowId;
  albPlayer.nowQueued = state.nowQueued === true;
  albPlayer.shuffle = state.shuffle === true;
  albPlayer.repeat = ['off', 'all', 'one'].includes(state.repeat) ? state.repeat : 'off';
  albPlayer.resumeAt = Number.isFinite(state.position) && state.position > 0 ? state.position : 0;
}

// ── Song menu (⋯ on a track row) ─────────────────────────────
function albOpenTrackMenu(anchor, file) {
  siteToggleFieldPopup(anchor, () => {
    const pop = el('div', 'site-field-pop site-dd-pop alb-menu-pop');
    const item = (label, onClick) => {
      const row = el('button', 'site-list-row', label);
      row.type = 'button';
      row.addEventListener('click', () => { close(); onClick(); });
      pop.appendChild(row);
    };
    item('Spil som næste', () => albQueueAdd(file, true));
    item('Tilføj til køen', () => albQueueAdd(file, false));
    const close = siteOpenFieldPopup(anchor, pop);
  });
}

// ── Queue panel ("Kø", opened from the player bar) ───────────
let albQueueOpen = false;
let albQueuePanel = null;

function albToggleQueue(open) {
  albQueueOpen = open === undefined ? !albQueueOpen : open;
  albRenderQueue();
  if (albPlayerEls) {
    albPlayerEls.queueBtn.classList.toggle('alb-ctl-on', albQueueOpen);
    albPlayerEls.queueBtn.setAttribute('aria-expanded', albQueueOpen ? 'true' : 'false');
  }
}

function albQueueRowEl(file, { label, onPlay, onRemove, current }) {
  const row = el('li', 'alb-q-row' + (current ? ' alb-q-current' : ''));
  const main = el('button', 'alb-q-main');
  main.type = 'button';
  main.title = current ? '' : 'Afspil nu';
  main.appendChild(el('span', 'alb-q-title', albTrackTitle(file)));
  // `label` '' = no second line (every song is from the same album).
  const sub = label !== undefined ? label : albAlbumName(albAlbumById(file.folderId));
  if (sub) main.appendChild(el('span', 'alb-q-album', sub));
  if (onPlay) main.addEventListener('click', onPlay);
  else main.disabled = true;
  row.appendChild(main);
  if (onRemove) {
    const remove = albRemoveBtn('Fjern fra køen');
    remove.classList.add('site-icon-btn-sm');
    remove.addEventListener('click', onRemove);
    row.appendChild(remove);
  }
  return row;
}

const ALB_QUEUE_MAX_ROWS = 100;

function albRenderQueue() {
  if (!albQueuePanel) {
    albQueuePanel = el('section', 'alb-queue');
    albQueuePanel.setAttribute('aria-label', 'Kø');
    document.body.appendChild(albQueuePanel);
  }
  const panel = albQueuePanel;
  const current = albCurrentTrack();
  panel.hidden = !albQueueOpen || !current;
  if (panel.hidden) { albPositionQueue(); return; }
  if (albRowDrag) return;
  const scroll = panel.scrollTop;

  const head = el('div', 'alb-q-head');
  head.appendChild(el('h2', null, 'Kø'));
  const closeBtn = albRemoveBtn('Luk køen');
  closeBtn.classList.remove('site-icon-btn-danger');
  closeBtn.addEventListener('click', () => albToggleQueue(false));
  head.appendChild(closeBtn);
  const parts = [head];

  parts.push(el('h3', 'alb-q-heading', 'Spiller nu'));
  const nowList = el('ol', 'alb-q-list');
  nowList.appendChild(albQueueRowEl(current, { current: true }));
  parts.push(nowList);

  const upNext = albPlayer.upNext.map(albTrackById).filter(Boolean);
  const start = albPlayer.ctxPos + 1;
  // "Næste i køen". Empty, it only shows while a song from the part below
  // is dragged, as somewhere to drop it.
  const upSection = el('div', 'alb-q-upnext' + (upNext.length ? '' : ' alb-q-upnext-empty'));
  const h = el('div', 'alb-q-heading-row');
  h.appendChild(el('h3', 'alb-q-heading', 'Næste i køen'));
  if (upNext.length) {
    const clearBtn = albBtn('Ryd');
    clearBtn.title = 'Fjern alle sange fra køen';
    clearBtn.addEventListener('click', albQueueClear);
    h.appendChild(clearBtn);
  }
  upSection.appendChild(h);
  const upList = el('ol', 'alb-q-list');
  upNext.forEach((file, i) => {
    const row = albQueueRowEl(file, {
      onPlay: () => { if (!albTouchDropped) albQueueJump(i); },
      onRemove: () => albQueueRemove(i),
    });
    albWireReorderRow(row, 'upnext', i, albTrackTitle(file));
    upList.appendChild(row);
  });
  const upTail = albFinishReorderList(upList, 'upnext', (drag, before) => {
    if (drag.group === 'upnext') albQueueMove(drag.index, before);
    else albContextToQueue(start + drag.index, before);
  });
  if (!upNext.length) upTail.textContent = 'Slip sangen her';
  upSection.appendChild(upList);
  parts.push(upSection);

  const rest = albPlayer.ctxOrder.slice(start);
  if (rest.length) {
    const ctxAlbum = albPlayer.ctxFolder ? albAlbumById(albPlayer.ctxFolder) : null;
    parts.push(el('h3', 'alb-q-heading', ctxAlbum ? `Næste fra ${albAlbumName(ctxAlbum)}` : 'Næste fra Bland alle'));
    const list = el('ol', 'alb-q-list');
    const shown = rest.slice(0, ALB_QUEUE_MAX_ROWS);
    shown.forEach((id, i) => {
      const file = albTrackById(id) || { id, name: '', ext: '' };
      const row = albQueueRowEl(file, {
        label: ctxAlbum ? '' : undefined,
        onPlay: () => { if (!albTouchDropped) albContextJump(start + i); },
        onRemove: () => albContextRemove(start + i),
      });
      albWireReorderRow(row, 'context', i, albTrackTitle(file));
      list.appendChild(row);
    });
    albFinishReorderList(list, 'context', (drag, before) => albContextMove(start + drag.index, start + before));
    parts.push(list);
    if (rest.length > ALB_QUEUE_MAX_ROWS) {
      parts.push(el('p', 'site-hint alb-q-more', `og ${rest.length - ALB_QUEUE_MAX_ROWS} sange mere`));
    }
  }
  if (!upNext.length && !rest.length) {
    parts.push(el('p', 'site-empty alb-q-empty', albPlayer.repeat === 'all' && albPlayer.ctxOrder.length
      ? 'Albummet starter forfra bagefter.'
      : 'Der er ikke flere sange i køen.'));
  }
  if (upNext.length > 1 || rest.length > 1) {
    parts.push(el('p', 'site-hint alb-q-hint', window.matchMedia('(hover: none)').matches
      ? 'Hold en sang nede for at flytte den.'
      : 'Træk i en sang for at flytte den.'));
  }
  panel.replaceChildren(...parts);
  panel.scrollTop = scroll;
  albPositionQueue();
}

// From 900px the open panel makes room for itself: the showing Arkiv tab's
// content (the year grid, Videoer, or the album card / grid) keeps its
// left edge and ends 16px before the panel, while the page title and the
// tabs stay where they are. The panel's top lines up with that content,
// and stays just below the site header once that scrolls away. Narrower,
// or closed, albums.css places it and nothing moves.
function albQueueHost() {
  return document.querySelector('.arkiv-tab-panel:not([hidden])') || albRoot();
}

function albPositionQueue() {
  const panel = albQueuePanel;
  document.querySelectorAll('.arkiv-tab-panel, #albums-root').forEach((n) => { n.style.marginRight = ''; });
  const root = albQueueHost();
  if (!root) return;
  const anchor = root.firstElementChild;
  if (!panel || panel.hidden || !anchor || !window.matchMedia('(min-width: 900px)').matches) {
    if (panel) {
      panel.style.top = '';
      panel.style.bottom = '';
      panel.style.height = '';
    }
    return;
  }
  const room = root.getBoundingClientRect().right - (panel.getBoundingClientRect().left - 16);
  if (room > 0) root.style.marginRight = Math.ceil(room) + 'px';
  const header = document.querySelector('.site-header');
  const minTop = (header ? header.getBoundingClientRect().bottom : 0) + 16;
  const top = Math.round(Math.max(minTop, anchor.getBoundingClientRect().top));
  panel.style.top = top + 'px';
  panel.style.bottom = 'auto';
  // Full height down to just above the player bar, even with an empty queue.
  panel.style.height = `calc(100vh - ${top}px - var(--alb-player-h, 5rem) - 1rem)`;
}

window.addEventListener('scroll', albPositionQueue, { passive: true });
window.addEventListener('resize', albPositionQueue);

// ── Player bar (fixed to the bottom of the screen) ───────────
function albBuildPlayer() {
  const bar = el('div', 'alb-player');
  bar.hidden = true;
  bar.setAttribute('role', 'region');
  bar.setAttribute('aria-label', 'Afspiller');
  const inner = el('div', 'alb-player-inner');

  const now = el('div', 'alb-player-now');
  // The cover goes to the album too (on phones it's all there is).
  const thumb = el('button', 'alb-player-thumb');
  thumb.type = 'button';
  thumb.title = 'Gå til albummet';
  thumb.setAttribute('aria-label', 'Gå til albummet');
  thumb.addEventListener('click', () => {
    const file = albCurrentTrack();
    const album = file && albAlbumById(file.folderId);
    if (album) albGoToAlbum(album);
  });
  now.appendChild(thumb);
  const titles = el('button', 'alb-player-titles');
  titles.type = 'button';
  titles.title = 'Gå til albummet';
  const title = el('span', 'alb-player-title');
  const albumName = el('span', 'alb-player-album');
  titles.appendChild(title);
  titles.appendChild(albumName);
  titles.addEventListener('click', () => {
    const file = albCurrentTrack();
    const album = file && albAlbumById(file.folderId);
    if (album) albGoToAlbum(album);
  });
  now.appendChild(titles);
  inner.appendChild(now);

  // Phones only: "Titel · Revy" on one line above the seek bar.
  const line = el('button', 'alb-player-line');
  line.type = 'button';
  line.title = 'Gå til albummet';
  const lineTitle = el('span', 'alb-player-line-title');
  const lineAlbum = el('span', 'alb-player-line-album');
  line.appendChild(lineTitle);
  line.appendChild(lineAlbum);
  line.addEventListener('click', () => {
    const file = albCurrentTrack();
    const album = file && albAlbumById(file.folderId);
    if (album) albGoToAlbum(album);
  });
  inner.appendChild(line);

  const controls = el('div', 'alb-player-controls');
  const shuffleBtn = albIconBtn('shuffle', 'Bland', 'alb-ctl alb-ctl-mode', 18);
  shuffleBtn.addEventListener('click', albToggleShuffle);
  const prevBtn = albIconBtn('prev', 'Forrige', 'alb-ctl', 22);
  prevBtn.addEventListener('click', albPrev);
  const playBtn = el('button', 'alb-ctl-play');
  playBtn.type = 'button';
  playBtn.addEventListener('click', albTogglePlay);
  const nextBtn = albIconBtn('next', 'Næste', 'alb-ctl', 22);
  nextBtn.addEventListener('click', () => albNext(false));
  const repeatBtn = albIconBtn('repeat', 'Gentag', 'alb-ctl alb-ctl-mode alb-ctl-repeat', 18);
  const repeatOne = el('span', 'alb-repeat-one', '1');
  repeatOne.setAttribute('aria-hidden', 'true');
  repeatBtn.appendChild(repeatOne);
  repeatBtn.addEventListener('click', albCycleRepeat);
  for (const b of [shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn]) controls.appendChild(b);
  inner.appendChild(controls);

  const tools = el('div', 'alb-player-tools');
  // Volume (not on phones, where the device's buttons set it, nor where
  // the browser ignores it, like iOS).
  const volumeWrap = el('div', 'alb-volume');
  volumeWrap.hidden = !albVolumeSettable();
  const muteBtn = albIconBtn('volume', 'Slå lyden fra', 'alb-ctl alb-ctl-mute', 20);
  muteBtn.addEventListener('click', albToggleMute);
  const volumeRange = el('input', 'alb-seek alb-volume-range');
  volumeRange.type = 'range';
  volumeRange.min = '0';
  volumeRange.max = '1';
  volumeRange.step = '0.01';
  volumeRange.setAttribute('aria-label', 'Lydstyrke');
  volumeRange.addEventListener('input', () => {
    albVolume.level = Number(volumeRange.value);
    albVolume.muted = false;
    albApplyVolume();
  });
  volumeRange.addEventListener('change', albSaveVolume);
  volumeWrap.appendChild(muteBtn);
  volumeWrap.appendChild(volumeRange);
  tools.appendChild(volumeWrap);
  const queueBtn = albIconBtn('queue', 'Kø', 'alb-ctl alb-ctl-mode alb-ctl-queue', 20);
  queueBtn.setAttribute('aria-expanded', 'false');
  queueBtn.addEventListener('click', () => albToggleQueue());
  tools.appendChild(queueBtn);
  inner.appendChild(tools);

  const seek = el('div', 'alb-player-seek');
  const elapsed = el('span', 'alb-player-time', '0:00');
  const range = el('input', 'alb-seek');
  range.type = 'range';
  range.min = '0';
  range.max = '0';
  range.step = '0.1';
  range.value = '0';
  range.setAttribute('aria-label', 'Spoling');
  range.addEventListener('input', () => {
    albPlayer.seeking = true;
    elapsed.textContent = albFormatTime(Number(range.value));
    albPaintRange();
  });
  range.addEventListener('change', () => {
    albPlayer.seeking = false;
    const at = Number(range.value);
    if (albPlayer.loadedId && albPlayer.audio) {
      albPlayer.audio.currentTime = at;
      albUpdatePositionState();
    } else {
      albPlayer.resumeAt = at;
    }
    albSaveState();
  });
  const duration = el('span', 'alb-player-time alb-player-duration', '-');
  seek.appendChild(elapsed);
  seek.appendChild(range);
  seek.appendChild(duration);
  inner.appendChild(seek);

  bar.appendChild(inner);
  // ✕ in the top-right corner (a tab above it on phones): stops the music and empties
  // the player and the queue, which hides the bar.
  const closeBtn = el('button', 'site-icon-btn alb-player-close', '✕');
  closeBtn.type = 'button';
  closeBtn.title = 'Luk afspilleren';
  closeBtn.setAttribute('aria-label', 'Luk afspilleren');
  closeBtn.addEventListener('click', () => {
    albToggleQueue(false);
    albStopPlayer();
  });
  bar.appendChild(closeBtn);
  document.body.appendChild(bar);
  // The queue panel sits right above the bar, whatever its height.
  if (typeof ResizeObserver === 'function') {
    new ResizeObserver(() => {
      document.body.style.setProperty('--alb-player-h', bar.offsetHeight + 'px');
    }).observe(bar);
  }
  albPlayerEls = { bar, thumb, title, albumName, lineTitle, lineAlbum, shuffleBtn, prevBtn, playBtn, nextBtn, repeatBtn, queueBtn, muteBtn, volumeRange, elapsed, range, duration, thumbFor: null };
  albApplyVolume();
}

// ── Volume (remembered per browser) ──────────────────────────
const ALB_VOLUME_KEY = 'matrevy-albums-volume';
const albVolume = { level: 1, muted: false };

function albLoadVolume() {
  let state = null;
  try { state = JSON.parse(localStorage.getItem(ALB_VOLUME_KEY) || 'null'); } catch (e) { state = null; }
  if (!state || typeof state !== 'object') return;
  if (Number.isFinite(state.level)) albVolume.level = Math.min(1, Math.max(0, state.level));
  albVolume.muted = state.muted === true;
}

function albSaveVolume() {
  try { localStorage.setItem(ALB_VOLUME_KEY, JSON.stringify(albVolume)); } catch (e) { /* ignore */ }
}

// iOS keeps an audio element's volume at 1 whatever is set.
function albVolumeSettable() {
  try {
    const probe = document.createElement('audio');
    probe.volume = 0.5;
    return probe.volume === 0.5;
  } catch (e) {
    return false;
  }
}

function albToggleMute() {
  if (albVolume.muted || albVolume.level === 0) {
    albVolume.muted = false;
    if (albVolume.level === 0) albVolume.level = 0.5;
  } else {
    albVolume.muted = true;
  }
  albApplyVolume();
  albSaveVolume();
}

// Sets the audio element and paints the slider and the speaker icon.
function albApplyVolume() {
  for (const audio of [albPlayer.audio, albPlayer.spare]) {
    if (!audio) continue;
    audio.volume = albVolume.level;
    audio.muted = albVolume.muted;
  }
  if (!albPlayerEls) return;
  const { muteBtn, volumeRange } = albPlayerEls;
  const shown = albVolume.muted ? 0 : albVolume.level;
  volumeRange.value = String(shown);
  volumeRange.style.setProperty('--alb-seek-pct', (shown * 100) + '%');
  const silent = shown === 0;
  muteBtn.replaceChildren(albIcon(silent ? 'volumeMuted' : shown < 0.5 ? 'volumeLow' : 'volume', 20));
  muteBtn.title = silent ? 'Slå lyden til' : 'Slå lyden fra';
  muteBtn.setAttribute('aria-label', muteBtn.title);
}

function albPaintPlayer() {
  if (!albPlayerEls) return;
  const e = albPlayerEls;
  const file = albCurrentTrack();
  e.bar.hidden = !file;
  document.body.classList.toggle('alb-has-player', !!file);
  albRenderQueue();
  if (!file) return;
  const album = albAlbumById(file.folderId);
  e.title.textContent = albTrackTitle(file);
  e.albumName.textContent = albAlbumName(album);
  e.lineTitle.textContent = albTrackTitle(file);
  e.lineAlbum.textContent = ' · ' + albAlbumName(album);
  if (e.thumbFor !== file.folderId) {
    e.thumb.replaceChildren(albCoverEl(album, 'alb-player-cover'));
    e.thumbFor = file.folderId;
  }
  const playing = albIsPlaying();
  e.playBtn.replaceChildren(albIcon(playing ? 'pause' : 'play', 22));
  e.playBtn.title = playing ? 'Pause' : 'Afspil';
  e.playBtn.setAttribute('aria-label', e.playBtn.title);
  e.shuffleBtn.classList.toggle('alb-ctl-on', albPlayer.shuffle);
  e.shuffleBtn.setAttribute('aria-pressed', albPlayer.shuffle ? 'true' : 'false');
  e.repeatBtn.classList.toggle('alb-ctl-on', albPlayer.repeat !== 'off');
  e.repeatBtn.classList.toggle('alb-ctl-repeat-one', albPlayer.repeat === 'one');
  e.repeatBtn.setAttribute('aria-pressed', albPlayer.repeat !== 'off' ? 'true' : 'false');
  const repeatLabel = albPlayer.repeat === 'off' ? 'Gentag (fra)' : albPlayer.repeat === 'all' ? 'Gentag alle' : 'Gentag sangen';
  e.repeatBtn.title = repeatLabel;
  e.repeatBtn.setAttribute('aria-label', repeatLabel);
  e.nextBtn.disabled = !albHasNext();
  e.queueBtn.classList.toggle('alb-ctl-has-queue', albPlayer.upNext.length > 0);
  albPaintProgress();
}

function albPaintProgress() {
  if (!albPlayerEls || albPlayer.seeking) return;
  const e = albPlayerEls;
  const file = albCurrentTrack();
  if (!file) return;
  const audio = albPlayer.audio;
  const loaded = audio && albPlayer.loadedId === file.id;
  const duration = loaded && Number.isFinite(audio.duration) ? audio.duration : (file.durationSec || 0);
  const position = loaded ? audio.currentTime || 0 : albPlayer.resumeAt;
  e.range.max = String(duration || 0);
  e.range.value = String(Math.min(position, duration || 0));
  e.range.disabled = !duration;
  e.elapsed.textContent = albFormatTime(position);
  e.duration.textContent = duration ? albFormatTime(duration) : '-';
  albPaintRange();
}

// The played part of the seek bar in amber (a CSS gradient stop).
function albPaintRange() {
  const r = albPlayerEls.range;
  const max = Number(r.max) || 0;
  const pct = max ? (Number(r.value) / max) * 100 : 0;
  r.style.setProperty('--alb-seek-pct', pct + '%');
}

// ── Init ─────────────────────────────────────────────────────
window.addEventListener('beforeunload', (e) => {
  if (!albUploadsPending()) return;
  e.preventDefault();
  e.returnValue = '';
});

window.addEventListener('pagehide', () => { if (albState) albSaveState(); });

// Space always plays/pauses, also with a button focused (it would press
// that button again otherwise), except while typing in a field or with a
// modal open. Caught in the capture phase, and the keyup too, since a
// button fires its click on the keyup.
function albSpaceIsOurs(e) {
  if (e.key !== ' ' || e.ctrlKey || e.metaKey || e.altKey || !albCurrentTrack() || !albTabShowing()) return false;
  const t = e.target;
  if (t && t.closest && t.closest('input:not([type="range"]), textarea, select, [contenteditable="true"], .login-overlay')) return false;
  return true;
}

document.addEventListener('keydown', (e) => {
  if (!albSpaceIsOurs(e)) return;
  e.preventDefault();
  e.stopPropagation();
  if (!e.repeat) albTogglePlay();
}, true);

document.addEventListener('keyup', (e) => {
  if (!albSpaceIsOurs(e)) return;
  e.preventDefault();
  e.stopPropagation();
}, true);

// Below 900px, where the panel covers the page, a click outside it closes
// it (wider, the page makes room for it and it stays open). Not on the Kø button (its own toggle), a popup or
// a modal.
document.addEventListener('mousedown', (e) => {
  if (!albQueueOpen || !albQueuePanel || window.matchMedia('(min-width: 900px)').matches) return;
  const t = e.target;
  if (!t || !t.closest || t.closest('.alb-queue, .alb-ctl-queue, .site-field-pop, .login-overlay')) return;
  albToggleQueue(false);
}, true);

// Escape closes the queue panel (a modal or popup handles its own first).
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || !albQueueOpen || document.querySelector('.login-overlay')) return;
  albToggleQueue(false);
});

window.addEventListener('hashchange', albOnRoute);

// A page left open for a day: renew the links before they run out.
setInterval(() => {
  if (albState && albStreamExpires && albStreamExpires - Date.now() < 2 * 3600 * 1000) albRefreshStreamUrls();
}, 15 * 60 * 1000);

document.addEventListener('DOMContentLoaded', () => {
  const root = albRoot();
  if (!root) return;
  if (typeof siteIsFileProtocol === 'function' && siteIsFileProtocol()) {
    const card = el('section', 'card');
    card.appendChild(el('p', 'site-muted', 'Albums kræver forbindelse til serveren og virker ikke offline.'));
    root.replaceChildren(card);
    return;
  }
  // The page gate (site.js) already hides <main> below revyst level.
  if (typeof siteHasLevel !== 'function' || !siteHasLevel('revyst')) return;
  if (typeof siteRegisterUnsavedCheck === 'function') siteRegisterUnsavedCheck(albUploadsPending);
  albLoadVolume();
  albRestoreState();
  albBuildPlayer();
  albInitMediaSession();
  albLoad();
});
