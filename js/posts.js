/* =========================================================
   Matematikrevyen – Facebook-style post feed on Forside
   Renders POSTS_DATA (embedded from data/posts.json) as a single
   scrolling feed (revyst+ can create; boss/admin edit/delete/pin).
   Pinning is a SORT KEY, not a separate column: getEffectivePosts()
   is sorted pinned-first then date-desc, and boss/admin flip a post's
   `pinned` flag via a pin-icon button on each card (togglePinned, not
   the edit modal) — toggling just re-sorts the single feed, it never
   moves a post into/out of a structurally separate list.

   Each post has a title (repurposed as a small category tag in the
   card's meta line, alongside the date with no time-of-day) + optional
   picture and a comments thread. The feed shows every post as a full
   card (avatar initials, author, category/date, full text, image); a
   "Kommentér" button opens a detail modal with the full text, image,
   comments and (for boss/admin) the Rediger/Slet buttons for the post
   itself — unchanged from before this redesign.

   The feed only shows posts from the last POSTS_INITIAL_MONTHS months by
   default (pinned posts are exempt — they always show); "Indlæs en måned
   mere" at the bottom widens the window by one calendar month and
   re-renders. Since every post is already in memory (POSTS_DATA/
   postsOverride), this is a date-cutoff filter, not count-based pagination
   — there's no server round-trip involved.

   Unlike calendar.js/archive.js's siteSaveResource-only flow, creating a
   post (or a comment) needs an ANY-level authenticated call (revyst
   included) — postsApi()/postsResolvePassword() below mirror
   budget.js's budgetApi()/budgetResolvePassword() for exactly that
   reason. Editing/deleting a post, toggling pinned, and deleting an
   individual comment are boss/admin only and reuse siteSaveResource
   (a full posts-array replace) exactly like today.

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

const POSTS_MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const POSTS_INITIAL_MONTHS = 6;
// Persists across re-renders within the page's lifetime (mutations like
// pinning/commenting call renderPosts() again) — only resets to the
// 6-month default on a fresh page load, not on every re-render.
let postsMonthsBack = POSTS_INITIAL_MONTHS;

// ── Data (with a localStorage-backed shadow after a create/save) ──
// Same idea as calendar.js/archive.js: the embed regeneration takes ~1-2
// min, so a successful create/save shows immediately, and survives a
// refresh during that window too (see site-utils.js's siteSaveOverride).
let postsOverride = siteLoadOverride('posts');

function getEffectivePosts() {
  return postsOverride || POSTS_DATA;
}

// A handful of live posts predate the title/image/comments fields (created
// before this schema landed) — fall back gracefully rather than rendering
// the literal string "undefined".
function postTitle(post) {
  return post.title || 'Opslag';
}

// ── Any-level authenticated API (for revyst-level post/comment creation) ──
function postsResolvePassword() {
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

function postsMapError(status) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 413) return 'Billedet er for stort. Maks. 5 MB.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, message }.
async function postsApi(action, body) {
  const password = postsResolvePassword();
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
  // Require a real {ok:true} JSON body — a PHP fatal (or a WAF challenge)
  // can come back as HTTP 200 with an HTML body and must not be mistaken
  // for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    return { ok: false, message: postsMapError(res.status) };
  }
  if (!data || data.ok !== true) {
    return { ok: false, message: 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── Post image → JPEG base64 ──────────────────────────────────
// Self-contained (archive.js/budget.js's own copies aren't loaded on this
// page). Re-encodes to JPEG via <canvas> so the stored file is always a
// .jpg regardless of what the phone hands us (HEIC/PNG/JPEG). Two decode
// paths for cross-browser robustness — createImageBitmap where it works,
// an <img> element (which iOS Safari can decode HEIC through) as fallback
// — then a last-resort fallback to the original bytes so a submit never
// hard-fails on an odd image. Mirrors budget.js's compressReceiptImage
// chain rather than archive.js's simpler version, since posts are likely
// to come from phone-camera photos too.
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      const i = s.indexOf(',');
      resolve(i === -1 ? s : s.slice(i + 1));
    };
    reader.onerror = () => reject(new Error('read_failed'));
    reader.readAsDataURL(blob);
  });
}

function loadImageElement(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode_failed')); };
    img.src = url;
  });
}

async function compressPostImage(file, { maxWidth = 1600, quality = 0.8 } = {}) {
  let source, width, height;
  try {
    const bitmap = await createImageBitmap(file);
    source = bitmap; width = bitmap.width; height = bitmap.height;
  } catch (e) {
    const img = await loadImageElement(file); // e.g. iOS Safari / HEIC
    source = img; width = img.naturalWidth || img.width; height = img.naturalHeight || img.height;
  }
  if (!width || !height) throw new Error('empty_image');
  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
  if (!blob) throw new Error('encode_failed');
  return blob;
}

// Returns raw base64 JPEG bytes for upload. Prefers a re-encoded/
// downscaled JPEG; falls back to the original file bytes if the
// browser can't process the image at all (better a big-but-working
// picture than a blocked submit).
async function postImageToBase64(file) {
  let blob;
  try {
    blob = await compressPostImage(file);
  } catch (e) {
    blob = file;
  }
  return { base64: await blobToBase64(blob), size: blob.size };
}

// A straight sewing-pin (round head + a plain straight stem below it),
// not a thumbtack with a triangular metal point — outline when a post is
// unpinned, filled amber when pinned, so the same button reads as "pin
// this" / "unpin this" in either column. createElementNS, like
// site-utils.js's clock icon.
function postsPinIcon(filled) {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '16');
  svg.setAttribute('height', '16');

  const head = document.createElementNS(svgNS, 'circle');
  head.setAttribute('cx', '8');
  head.setAttribute('cy', '5');
  head.setAttribute('r', '3.3');
  head.setAttribute('fill', filled ? 'currentColor' : 'none');
  head.setAttribute('stroke', 'currentColor');
  head.setAttribute('stroke-width', filled ? '0' : '1.3');
  svg.appendChild(head);

  const stem = document.createElementNS(svgNS, 'line');
  stem.setAttribute('x1', '8');
  stem.setAttribute('y1', '8.3');
  stem.setAttribute('x2', '8');
  stem.setAttribute('y2', '14.3');
  stem.setAttribute('stroke', 'currentColor');
  stem.setAttribute('stroke-width', '1.4');
  stem.setAttribute('stroke-linecap', 'round');
  svg.appendChild(stem);

  return svg;
}

// Boss/admin-only quick toggle from the list row — not routed through the
// edit modal. Applies the flip and re-sorts the feed immediately (optimistic
// update) so the card jumps to its new section right away instead of waiting
// on the save round-trip; rolled back (card snaps back, alert() shown) only
// if the save actually fails. No modal error slot to show a failure in, so
// alert() is the fallback, same as archive.js's deleteYear.
async function togglePinned(post) {
  const previousOverride = postsOverride;
  const next = getEffectivePosts().map(p =>
    p.id === post.id ? { ...p, pinned: !p.pinned } : p
  );
  siteShowToast(post.pinned ? 'Opslag er ikke længere fastgjort' : 'Opslag er fastgjort');
  postsOverride = next;
  siteSaveOverride('posts', next);
  renderPosts();
  const result = await siteSaveResource('posts', { posts: next });
  if (!result.ok) {
    postsOverride = previousOverride;
    siteSaveOverride('posts', previousOverride);
    renderPosts();
    if (result.message) alert(result.message);
  }
}

// Deterministically picks one of 5 warm avatar colours (css/style.css's
// .message-avatar-1..5) keyed on a stable id, so the palette doesn't
// reshuffle on re-render — shared by comment avatars and post avatars.
function avatarVariantForKey(key) {
  let hash = 0;
  for (let i = 0; i < key.length; i++) hash = (hash * 31 + key.charCodeAt(i)) | 0;
  return `message-avatar-${(Math.abs(hash) % 5) + 1}`;
}

function commentAvatarVariant(comment) {
  return avatarVariantForKey(String(comment.id || comment.author || ''));
}

function postAvatarVariant(post) {
  return avatarVariantForKey(String(post.id || post.author || ''));
}

// "1. august 2026, 13:15" — date + time, distinct from site-utils.js's
// shared formatDaDateTime ("... kl. HH:MM"), which other pages may already
// rely on for that exact wording.
function formatPostDateTime(iso) {
  const [datePart, timePart] = iso.split('T');
  return `${formatDaDate(datePart)}, ${(timePart || '00:00:00').slice(0, 5)}`;
}

// ── Shared header (avatar + name + category/date) ────────────
// Used by both the feed card and the detail overlay so the two show an
// identical top section — `showPin` only applies in the card, never the
// overlay (which has no pin control of its own).
function createPostHeaderElement(post, { showPin = false } = {}) {
  const header = document.createElement('div');
  header.className = 'post-card-header';

  const avatar = document.createElement('div');
  avatar.className = `message-avatar ${postAvatarVariant(post)}`;
  avatar.textContent = (post.author || '?').trim().charAt(0).toUpperCase();
  header.appendChild(avatar);

  const headtext = document.createElement('div');
  headtext.className = 'post-card-headtext';

  const author = document.createElement('div');
  author.className = 'post-card-author';
  author.textContent = post.author;
  headtext.appendChild(author);

  const meta = document.createElement('div');
  meta.className = 'post-card-meta';
  if (post.title) {
    const category = document.createElement('span');
    category.className = 'post-card-category';
    category.textContent = post.title;
    meta.appendChild(category);
  }
  meta.appendChild(document.createTextNode(formatPostDateTime(post.date)));
  headtext.appendChild(meta);

  header.appendChild(headtext);

  if (showPin && siteHasLevel('boss')) {
    const pinBtn = document.createElement('button');
    pinBtn.type = 'button';
    pinBtn.className = 'post-pin-btn' + (post.pinned ? ' pinned' : '');
    const label = post.pinned ? 'Frigør opslag' : 'Fastgør opslag';
    pinBtn.setAttribute('aria-label', label);
    pinBtn.title = label;
    pinBtn.appendChild(postsPinIcon(post.pinned));
    pinBtn.addEventListener('click', () => togglePinned(post));
    header.appendChild(pinBtn);
  }

  return header;
}

// ── Shared body text (paragraph-per-line, URLs auto-linked) ──
const POST_URL_RE = /(https?:\/\/\S+|www\.\S+)/g;

// Appends `line`'s text into `p`, turning any http(s)/www URL into a real
// <a> — built via createElement/textContent, never innerHTML, so this is
// exactly as safe as the plain-text rendering it replaces.
function appendLineWithLinks(p, line) {
  POST_URL_RE.lastIndex = 0;
  let lastIndex = 0;
  let match;
  while ((match = POST_URL_RE.exec(line)) !== null) {
    let url = match[0];
    // Trailing punctuation (a sentence's period/comma/etc.) is usually not
    // part of the URL itself — trim it back out of the link.
    const trailing = url.match(/[).,;:!?\]}'"]+$/);
    const trail = trailing ? trailing[0] : '';
    if (trail) url = url.slice(0, url.length - trail.length);

    if (match.index > lastIndex) p.appendChild(document.createTextNode(line.slice(lastIndex, match.index)));
    const a = document.createElement('a');
    a.href = url.startsWith('www.') ? `https://${url}` : url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    p.appendChild(a);
    if (trail) p.appendChild(document.createTextNode(trail));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < line.length) p.appendChild(document.createTextNode(line.slice(lastIndex)));
}

// ── Rich text (bold/italic/underline/lists/headings) ──────────
// Duplicated from wiki.js's identical system (buildWikiToolbar/
// renderSanitizedBody/appendSanitizedChildren/sanitizeHtmlString) rather
// than shared — wiki.js isn't loaded on this page, and each page keeps its
// own copy per the site's one-feature-per-file convention. See wiki.js for
// the full rationale for why storing/rendering HTML here is still safe
// despite the site-wide "never innerHTML on a live node" rule.
const POST_ALLOWED_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'UL', 'OL', 'LI', 'P', 'BR', 'H2', 'H3']);
const POST_TAG_MAP = { B: 'strong', STRONG: 'strong', I: 'em', EM: 'em', U: 'u', UL: 'ul', OL: 'ol', LI: 'li', P: 'p', BR: 'br', H2: 'h2', H3: 'h3' };

// A stored/typed post body only "looks like HTML" if it actually contains a
// tag-like `<letter...>` sequence — legacy posts.json entries are plain
// strings with literal \n line breaks and never match this, so they keep
// rendering via the old line-split path below (a stray "<3" in plain text
// doesn't match either, since `<` isn't followed by a letter). This is what
// lets old and new posts coexist with no data migration: only a post
// actually edited/created through the new rich-text editor ever gets HTML.
function postLooksLikeHtml(text) {
  return /<[a-z][\s\S]*>/i.test(text);
}

// Same URL-auto-linking rules as appendLineWithLinks, but appends into an
// arbitrary `target` rather than always a single <p> — needed once text
// nodes can live inside <li>/<h2>/etc., not just one paragraph.
function appendPostRichTextWithLinks(target, text) {
  POST_URL_RE.lastIndex = 0;
  let lastIndex = 0;
  let match;
  while ((match = POST_URL_RE.exec(text)) !== null) {
    let url = match[0];
    const trailing = url.match(/[).,;:!?\]}'"]+$/);
    const trail = trailing ? trailing[0] : '';
    if (trail) url = url.slice(0, url.length - trail.length);

    if (match.index > lastIndex) target.appendChild(document.createTextNode(text.slice(lastIndex, match.index)));
    const a = document.createElement('a');
    a.href = url.startsWith('www.') ? `https://${url}` : url;
    a.textContent = url;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    target.appendChild(a);
    if (trail) target.appendChild(document.createTextNode(trail));
    lastIndex = match.index + match[0].length;
  }
  if (lastIndex < text.length) target.appendChild(document.createTextNode(text.slice(lastIndex)));
}

// Renders a stored/typed HTML string into `container` by parsing it into a
// fully detached document (DOMParser never executes scripts, and the result
// is never attached to the live document) and rebuilding only the
// allow-listed tags as real DOM nodes — `.innerHTML` is never assigned on a
// live node.
function renderSanitizedPostBody(container, html, { linkify = true } = {}) {
  container.textContent = '';
  const doc = new DOMParser().parseFromString(html || '', 'text/html');
  appendSanitizedPostChildren(container, doc.body, linkify);
}

function appendSanitizedPostChildren(target, sourceNode, linkify) {
  for (const node of sourceNode.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) {
      if (linkify) appendPostRichTextWithLinks(target, node.textContent);
      else target.appendChild(document.createTextNode(node.textContent));
    } else if (node.nodeType === Node.ELEMENT_NODE && POST_ALLOWED_TAGS.has(node.tagName)) {
      const el = document.createElement(POST_TAG_MAP[node.tagName]);
      appendSanitizedPostChildren(el, node, linkify);
      target.appendChild(el);
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      // Disallowed wrapper (e.g. a stray <div>/<span style=...> from
      // execCommand or a paste) — drop the wrapper, keep its children.
      appendSanitizedPostChildren(target, node, linkify);
    }
  }
}

// Canonicalizes whatever execCommand produced in the live contenteditable
// region down to the allow-listed subset before it's ever sent to the
// server. `scratch` is a detached <div> built entirely from the allow-list
// with zero attributes ever copied from the source, so reading `.innerHTML`
// back off it is safe.
function sanitizePostHtmlString(rawHtml) {
  const doc = new DOMParser().parseFromString(rawHtml, 'text/html');
  const scratch = document.createElement('div');
  appendSanitizedPostChildren(scratch, doc.body, false); // linkify:false — links are render-time only, never stored
  return scratch.innerHTML;
}

// Seeds a contenteditable region for editing: HTML-looking text renders via
// the sanitized rebuild (linkify:false, so URLs stay plain text and
// editable rather than becoming inert <a> nodes); legacy plain text is
// converted to one <p> per non-blank line so its line breaks survive into
// the editor (and get upgraded to real HTML the next time it's saved).
function seedPostEditableBody(bodyEl, text) {
  if (postLooksLikeHtml(text)) {
    renderSanitizedPostBody(bodyEl, text, { linkify: false });
    return;
  }
  bodyEl.textContent = '';
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const p = document.createElement('p');
    p.textContent = line;
    bodyEl.appendChild(p);
  }
  if (!bodyEl.childNodes.length) bodyEl.appendChild(document.createElement('p'));
}

// Google-Docs-style layout: block-style dropdown first, then B/I/U toggle
// buttons (highlighted when the caret/selection has that formatting, also
// bound to Cmd/Ctrl+B/I/U), then list buttons last. Call toolbar.destroy()
// when the editor unmounts to remove the document-level selectionchange
// listener. Duplicated from wiki.js's buildWikiToolbar — see its comments
// for the execCommand/list-authoring gotchas, unchanged here.
function buildPostToolbar(bodyEl) {
  const toolbar = document.createElement('div');
  toolbar.className = 'post-toolbar';

  let savedRange = null;
  const styleDropdown = siteCreateDropdownField([
    { value: 'p', label: 'Normal' },
    { value: 'h3', label: 'Overskrift 2' },
    { value: 'h2', label: 'Overskrift 1' },
  ], 'p');
  styleDropdown.classList.add('post-toolbar-style');
  styleDropdown.addEventListener('mousedown', () => {
    const sel = window.getSelection();
    if (sel.rangeCount > 0 && bodyEl.contains(sel.anchorNode)) {
      savedRange = sel.getRangeAt(0).cloneRange();
    }
  });
  styleDropdown.addEventListener('change', () => {
    bodyEl.focus();
    if (savedRange) {
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(savedRange);
    }
    document.execCommand('formatBlock', false, `<${styleDropdown.value}>`);
    updateToolbarState();
  });
  toolbar.appendChild(styleDropdown);

  function addFormatBtn(label, title, command, extraClass) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `btn-small post-toolbar-btn${extraClass ? ' ' + extraClass : ''}`;
    btn.textContent = label;
    btn.title = title;
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      document.execCommand(command);
      updateToolbarState();
    });
    toolbar.appendChild(btn);
    return btn;
  }

  const boldBtn = addFormatBtn('B', 'Fed', 'bold', 'post-toolbar-btn-bold');
  const italicBtn = addFormatBtn('I', 'Kursiv', 'italic', 'post-toolbar-btn-italic');
  const underlineBtn = addFormatBtn('U', 'Understreget', 'underline', 'post-toolbar-btn-underline');
  const bulletBtn = addFormatBtn('•', 'Punktopstilling', 'insertUnorderedList');
  const orderedBtn = addFormatBtn('1.', 'Nummereret liste', 'insertOrderedList');

  function detectBlockTag() {
    const sel = window.getSelection();
    if (!sel.rangeCount || !bodyEl.contains(sel.anchorNode)) return null;
    const node = sel.anchorNode;
    const startEl = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    const block = startEl && startEl.closest ? startEl.closest('h2, h3, p') : null;
    return block && bodyEl.contains(block) ? block.tagName.toLowerCase() : 'p';
  }

  function updateToolbarState() {
    const sel = window.getSelection();
    const focused = document.activeElement === bodyEl || (sel.rangeCount > 0 && bodyEl.contains(sel.anchorNode));
    if (!focused) return;
    boldBtn.classList.toggle('post-toolbar-btn-active', document.queryCommandState('bold'));
    italicBtn.classList.toggle('post-toolbar-btn-active', document.queryCommandState('italic'));
    underlineBtn.classList.toggle('post-toolbar-btn-active', document.queryCommandState('underline'));
    bulletBtn.classList.toggle('post-toolbar-btn-active', document.queryCommandState('insertUnorderedList'));
    orderedBtn.classList.toggle('post-toolbar-btn-active', document.queryCommandState('insertOrderedList'));
    const tag = detectBlockTag();
    if (tag) styleDropdown.value = tag;
  }

  function onSelectionChange() { updateToolbarState(); }
  bodyEl.addEventListener('keyup', updateToolbarState);
  bodyEl.addEventListener('mouseup', updateToolbarState);
  document.addEventListener('selectionchange', onSelectionChange);

  bodyEl.addEventListener('keydown', (e) => {
    if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey) return;
    const command = { b: 'bold', i: 'italic', u: 'underline' }[e.key.toLowerCase()];
    if (!command) return;
    e.preventDefault();
    document.execCommand(command);
    updateToolbarState();
  });

  // Markdown-style list autocorrect: typing "* ", "- ", or "1. " converts
  // the current, still-empty line into a bullet/numbered list. Only fires
  // when the marker is the block's entire content so far — never
  // mid-sentence.
  const BULLET_MARKERS = new Set(['*', '-']);
  const ORDERED_MARKER = '1.';

  function getCaretBlock(node) {
    const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    if (!el || !bodyEl.contains(el)) return null;
    return el.closest('p, h2, h3, li') || bodyEl;
  }

  function textBeforeCaret(block, range) {
    const pre = document.createRange();
    pre.selectNodeContents(block);
    pre.setEnd(range.startContainer, range.startOffset);
    return pre.toString();
  }

  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== ' ') return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !sel.isCollapsed || !bodyEl.contains(sel.anchorNode)) return;
    const range = sel.getRangeAt(0);
    if (range.startContainer.nodeType !== Node.TEXT_NODE) return;
    const block = getCaretBlock(range.startContainer);
    if (!block) return;
    const before = textBeforeCaret(block, range);
    const isBullet = BULLET_MARKERS.has(before);
    const isOrdered = before === ORDERED_MARKER;
    if ((!isBullet && !isOrdered) || range.startOffset !== before.length) return;
    e.preventDefault();
    for (let i = 0; i < before.length; i++) {
      document.execCommand('delete');
    }
    document.execCommand(isBullet ? 'insertUnorderedList' : 'insertOrderedList');
    updateToolbarState();
  });

  // Chrome's execCommand('indent') nests a sub-list as a sibling of the
  // preceding <li> rather than inside it (invalid HTML) — re-parent any
  // list that ends up as a direct child of another list into the end of
  // its immediately preceding <li>. The flip side: outdent can leave an
  // <li> as a direct child of another <li> — hoist it to be a sibling.
  function normalizeNestedLists() {
    bodyEl.querySelectorAll('ul, ol').forEach((list) => {
      const parent = list.parentElement;
      if (!parent || (parent.tagName !== 'UL' && parent.tagName !== 'OL')) return;
      const prevLi = list.previousElementSibling;
      if (prevLi && prevLi.tagName === 'LI') prevLi.appendChild(list);
    });
    bodyEl.querySelectorAll('li').forEach((li) => {
      const parent = li.parentElement;
      if (parent && parent.tagName === 'LI') parent.after(li);
    });
  }

  // Tab/Shift+Tab nests/un-nests the current list item — only intercepted
  // inside a list item, Tab anywhere else keeps its normal behaviour.
  bodyEl.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const sel = window.getSelection();
    if (!sel.rangeCount || !bodyEl.contains(sel.anchorNode)) return;
    const el = sel.anchorNode.nodeType === Node.ELEMENT_NODE ? sel.anchorNode : sel.anchorNode.parentElement;
    const li = el && el.closest ? el.closest('li') : null;
    if (!li || !bodyEl.contains(li)) return;
    e.preventDefault();
    document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    normalizeNestedLists();
    updateToolbarState();
  });

  updateToolbarState();
  toolbar.destroy = () => document.removeEventListener('selectionchange', onSelectionChange);

  return toolbar;
}

// Builds the Besked field's label + toolbar + contenteditable body, shared
// by the create and edit modals.
function createPostRichEditorField() {
  const field = document.createElement('div');
  field.className = 'edit-field';
  const label = document.createElement('label');
  label.textContent = 'Besked';
  field.appendChild(label);

  const bodyEl = document.createElement('div');
  bodyEl.className = 'post-edit-body';
  bodyEl.contentEditable = 'true';
  bodyEl.spellcheck = false;
  // Chrome's default is to wrap each new line in a <div> on Enter, which
  // falls outside POST_ALLOWED_TAGS (no DIV) — asking for 'p' keeps typed
  // paragraphs matching what's actually stored.
  bodyEl.addEventListener('focus', () => {
    document.execCommand('defaultParagraphSeparator', false, 'p');
  });

  const toolbar = buildPostToolbar(bodyEl);
  field.appendChild(toolbar);
  field.appendChild(bodyEl);

  return { field, bodyEl, toolbar };
}

function createPostTextElement(text) {
  const box = document.createElement('div');
  box.className = 'post-detail-text';
  if (postLooksLikeHtml(text)) {
    renderSanitizedPostBody(box, text);
    return box;
  }
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    const p = document.createElement('p');
    appendLineWithLinks(p, line);
    box.appendChild(p);
  }
  return box;
}

// ── Rendering: Facebook-style feed card ───────────────────────
function createPostCardElement(post) {
  const article = document.createElement('article');
  article.className = 'post-card';

  article.appendChild(createPostHeaderElement(post, { showPin: true }));
  article.appendChild(createPostTextElement(post.text));

  if (post.image) {
    const cover = document.createElement('div');
    cover.className = 'post-detail-cover';
    const img = document.createElement('img');
    img.src = post.image;
    img.alt = postTitle(post);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('click', () => window.open(post.image, '_blank'));
    cover.appendChild(img);
    article.appendChild(cover);
  }

  const footer = document.createElement('div');
  footer.className = 'post-card-footer';

  const commentCount = document.createElement('span');
  commentCount.className = 'post-card-comment-count';
  const n = (post.comments || []).length;
  commentCount.textContent = `${n} kommentar${n === 1 ? '' : 'er'}`;
  footer.appendChild(commentCount);

  const commentBtn = document.createElement('button');
  commentBtn.className = 'btn-small post-comment-trigger';
  commentBtn.textContent = 'Se';
  commentBtn.addEventListener('click', () => openPostDetail(post));
  footer.appendChild(commentBtn);

  article.appendChild(footer);

  return article;
}

// ── Feed section dividers (pinned "Fastgjorte posts" vs. plain "Opslag") ──
// A plain rule opens the pinned section (only if it's non-empty), and a
// labeled "Opslag" rule marks the start of the regular posts that follow —
// renderPostFeed's `posts` array is always pinned-first (see renderPosts'
// sort), so the boundary between the two is exactly its own pinned count.
function createPostFeedDivider() {
  const div = document.createElement('div');
  div.className = 'post-feed-divider';
  return div;
}

function createPostFeedSectionLabel(text) {
  const div = document.createElement('div');
  div.className = 'post-feed-section-label';
  div.textContent = text;
  return div;
}

function createPostFeedEmptyPinnedNotice() {
  const p = document.createElement('p');
  p.className = 'post-feed-empty-pinned';
  p.textContent = 'Ingen fastgjorte opslag';
  return p;
}

// ── Time-window cutoff (default 6 months, widened by the load-more button) ──
// Returns a YYYY-MM-DD date string `monthsBack` calendar months before
// today — compared lexically against a post's `date.split('T')[0]`, which
// works since both are the same zero-padded ISO date format.
function postsCutoffDateIso(monthsBack) {
  const d = new Date();
  d.setMonth(d.getMonth() - monthsBack);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// ── Rendering: the feed (single merged, pinned-first, sorted list) ──
// `posts` is already filtered to the current time window and sorted by
// renderPosts(); `hasMore` says whether any older unpinned post exists
// beyond that window, controlling the "Indlæs en måned mere" button.
function renderPostFeed(posts, listId, adminId, canCreate, emptyMessage, hasMore) {
  const list = document.getElementById(listId);
  if (!list) return;

  if (adminId) {
    const adminSlot = document.getElementById(adminId);
    if (adminSlot) {
      adminSlot.textContent = '';
      if (canCreate) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-small';
        addBtn.textContent = '+ Opslag';
        addBtn.addEventListener('click', () => openPostCreateModal());
        adminSlot.appendChild(addBtn);
      }
    }
  }

  list.textContent = '';
  const loadMoreSlot = document.getElementById('posts-load-more');
  if (loadMoreSlot) loadMoreSlot.textContent = '';

  if (posts.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = emptyMessage || 'Ingen opslag endnu.';
    list.appendChild(empty);
    return;
  }

  const pinnedCount = posts.filter(p => p.pinned).length;
  posts.forEach((post, i) => {
    if (i === 0) {
      list.appendChild(createPostFeedDivider());
      if (pinnedCount === 0) list.appendChild(createPostFeedEmptyPinnedNotice());
    }
    if (i === pinnedCount && posts.length > pinnedCount) {
      list.appendChild(createPostFeedSectionLabel('Opslag'));
      list.appendChild(createPostFeedDivider());
    }
    list.appendChild(createPostCardElement(post));
  });

  if (hasMore && loadMoreSlot) {
    const moreBtn = document.createElement('button');
    moreBtn.className = 'btn-small posts-load-more-btn';
    moreBtn.textContent = 'Indlæs en måned mere';
    moreBtn.addEventListener('click', () => {
      postsMonthsBack += 1;
      renderPosts();
    });
    loadMoreSlot.appendChild(moreBtn);
  }
}

function renderPosts() {
  // Public (not-logged-in) visitors see an empty board — posts are for
  // logged-in revyster and up, not anonymous readers.
  const all = siteHasLevel('revyst') ? getEffectivePosts().slice() : [];
  const cutoff = postsCutoffDateIso(postsMonthsBack);
  const visible = all
    .filter(p => p.pinned || p.date.split('T')[0] >= cutoff)
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    });
  const hasMore = all.some(p => !p.pinned && p.date.split('T')[0] < cutoff);
  renderPostFeed(visible, 'posts-list', 'posts-admin', siteHasLevel('revyst'),
    siteHasLevel('revyst') ? undefined : 'Log ind for at se opslag', hasMore);
}

// ── Detail modal: image, full text, comments, admin actions ──
function openPostDetail(post) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('');
  // The plain text heading is replaced by the same avatar/name/category-date
  // header the feed card uses (see createPostHeaderElement) — remove it
  // rather than show a redundant second title above that header.
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();
  // Unused here (Rediger/Slet/comment-form live directly in `form` instead)
  // — remove rather than leave empty, since their own top-margin/min-height
  // would otherwise pad out extra space below the actual content.
  error.remove();
  actions.remove();

  form.appendChild(createPostHeaderElement(post));
  form.appendChild(createPostTextElement(post.text));

  if (post.image) {
    const cover = document.createElement('div');
    cover.className = 'post-detail-cover';
    const img = document.createElement('img');
    img.src = post.image;
    img.alt = postTitle(post);
    img.loading = 'lazy';
    img.decoding = 'async';
    img.addEventListener('click', () => window.open(post.image, '_blank'));
    cover.appendChild(img);
    form.appendChild(cover);
  }

  // ── Comments (oldest first — a thread reads top-to-bottom) ──
  const commentsWrap = document.createElement('div');
  commentsWrap.className = 'post-comments';
  const comments = post.comments || [];
  if (comments.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Ingen kommentarer endnu.';
    commentsWrap.appendChild(empty);
  } else {
    for (const c of comments) {
      const article = document.createElement('article');
      article.className = 'message';

      const avatar = document.createElement('div');
      avatar.className = `message-avatar ${commentAvatarVariant(c)}`;
      avatar.textContent = (c.author || '?').trim().charAt(0).toUpperCase();
      article.appendChild(avatar);

      const body = document.createElement('div');
      body.className = 'message-body';

      const bubble = document.createElement('div');
      bubble.className = 'message-bubble';
      const cauthor = document.createElement('div');
      cauthor.className = 'message-author';
      cauthor.textContent = c.author;
      bubble.appendChild(cauthor);
      const ctext = document.createElement('div');
      ctext.className = 'message-text';
      ctext.textContent = c.text;
      bubble.appendChild(ctext);
      body.appendChild(bubble);

      article.appendChild(body);

      if (siteHasLevel('boss')) {
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'message-delete';
        delBtn.textContent = '×';
        delBtn.setAttribute('aria-label', 'Slet kommentar');
        delBtn.title = 'Slet kommentar';
        delBtn.addEventListener('click', () => deleteComment(post, c, close));
        article.appendChild(delBtn);
      }

      commentsWrap.appendChild(article);
    }
  }
  form.appendChild(commentsWrap);

  // Comment input: collapsed to a small trigger button by default; clicking
  // it swaps itself out for the real Afsender/Kommentar form in place.
  if (siteHasLevel('revyst')) {
    const commentSlot = document.createElement('div');
    commentSlot.className = 'post-comment-form';

    const trigger = document.createElement('button');
    trigger.className = 'btn-small post-comment-trigger';
    trigger.textContent = '+ Kommenter';
    trigger.addEventListener('click', () => {
      commentSlot.textContent = '';
      renderCommentForm(commentSlot, post, close);
    });
    commentSlot.appendChild(trigger);

    form.appendChild(commentSlot);
  }

  // Boss/admin manage the post itself from the bottom of the overlay.
  if (siteHasLevel('boss')) {
    const actionsRow = document.createElement('div');
    actionsRow.className = 'post-detail-actions';

    const delBtn = document.createElement('button');
    delBtn.className = 'site-btn-danger';
    delBtn.textContent = 'Slet';
    delBtn.addEventListener('click', () => deletePost(post, close));
    actionsRow.appendChild(delBtn);

    const editBtn = document.createElement('button');
    editBtn.className = 'site-btn-warm';
    editBtn.textContent = 'Rediger';
    editBtn.addEventListener('click', () => { close(); openPostEditModal(post); });
    actionsRow.appendChild(editBtn);

    form.appendChild(actionsRow);
  }
}

// Expands the collapsed comment trigger into the actual Afsender/Kommentar
// inputs, in place, inside `container`.
function renderCommentForm(container, post, closeDetailModal) {
  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  container.appendChild(siteEditField('Afsender', authorInput));

  const textArea = document.createElement('textarea');
  container.appendChild(siteEditField('Kommentar', textArea));

  const commentError = document.createElement('div');
  commentError.className = 'login-error';
  container.appendChild(commentError);

  const submitBtn = document.createElement('button');
  submitBtn.className = 'site-btn-success post-comment-submit';
  submitBtn.textContent = 'Tilføj';
  submitBtn.addEventListener('click', async () => {
    const author = authorInput.value.trim();
    const text = textArea.value.trim();
    if (!author || !text) {
      commentError.textContent = 'Udfyld både afsender og kommentar.';
      return;
    }
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sender…';
    commentError.textContent = '';
    const result = await postComment(post, author, text);
    submitBtn.disabled = false;
    submitBtn.textContent = 'Tilføj';
    if (result.ok) {
      closeDetailModal();
      const updated = getEffectivePosts().find(p => p.id === post.id);
      if (updated) openPostDetail(updated);
    } else {
      commentError.textContent = result.message;
    }
  });
  container.appendChild(submitBtn);

  authorInput.focus();
}

// ── Comments: create (revyst+) / delete (boss/admin) ──────────
async function postComment(post, author, text) {
  const result = await postsApi('comments_create', { postId: post.id, author, text });
  if (result.ok) {
    const localComment = { id: result.data.comment.id, author, text, date: nowIso() };
    const next = getEffectivePosts().map(p =>
      p.id === post.id ? { ...p, comments: (p.comments || []).concat([localComment]) } : p
    );
    postsOverride = next;
    siteSaveOverride('posts', next);
    renderPosts();
  }
  return result;
}

// Opens on top of the still-open detail modal without closing it first
// (matching deletePost/calendar.js's openDeleteConfirm). Since the comment
// list changed, the detail modal underneath still needs replacing with a
// fresh one on success — `closeDetailModal` closes that stale copy first,
// so only the new detail modal ends up on screen (leaving it open would
// otherwise stack a second, out-of-date detail overlay on top of it).
function deleteComment(post, comment, closeDetailModal) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('post-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'post-confirm-text';
  info.textContent = 'Slet denne kommentar?';
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-btn-warm';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-btn-danger';
  confirmBtn.textContent = 'Slet';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectivePosts().map(p =>
      p.id === post.id ? { ...p, comments: (p.comments || []).filter(c => c.id !== comment.id) } : p
    );
    const result = await savePosts(next);
    if (result.ok) {
      close();
      closeDetailModal();
      const updated = getEffectivePosts().find(p => p.id === post.id);
      if (updated) openPostDetail(updated);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Save (boss/admin edit/delete — full next-array replace) ──
async function savePosts(next) {
  const result = await siteSaveResource('posts', { posts: next });
  if (result.ok) {
    postsOverride = next;
    siteSaveOverride('posts', next);
    renderPosts();
  }
  return result;
}

// ── Create (revyst+) ──────────────────────────────────────────
// A dedicated append-only server action (posts_create), not siteSaveResource
// — see the file header for why. New posts are always unpinned; boss/admin
// pin a post afterwards via the edit modal.
function openPostCreateModal() {
  const { form, error, actions, close: closeModal } = siteOpenModalWithClose('Nyt opslag');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  form.appendChild(siteEditField('Titel (valgfrit)', titleInput));

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  form.appendChild(siteEditField('Afsender', authorInput));

  const { field: bodyField, bodyEl, toolbar } = createPostRichEditorField();
  form.appendChild(bodyField);
  const close = () => { toolbar.destroy(); closeModal(); };

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  fileInput.className = 'site-file-input';
  form.appendChild(siteEditField('Billede (valgfrit)', fileInput));

  const save = document.createElement('button');
  save.className = 'site-btn-success';
  save.textContent = 'Gem';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const author = authorInput.value.trim();
    const textPlain = bodyEl.textContent.trim();
    if (!author || !textPlain) {
      error.textContent = 'Udfyld afsender og besked.';
      return;
    }
    const text = sanitizePostHtmlString(bodyEl.innerHTML);

    const file = fileInput.files[0] || null;
    save.disabled = true;
    error.textContent = '';

    let imageBase64 = null;
    if (file) {
      save.textContent = 'Komprimerer billede…';
      const { base64, size } = await postImageToBase64(file);
      if (size > POSTS_MAX_UPLOAD_BYTES) {
        save.disabled = false;
        save.textContent = 'Gem';
        error.textContent = 'Billedet er for stort. Maks. 5 MB.';
        return;
      }
      imageBase64 = base64;
    }

    save.textContent = 'Gem';
    const body = { title, author, text };
    if (imageBase64) body.imageBase64 = imageBase64;
    const result = await postsApi('posts_create', body);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) {
      const localPost = {
        id: result.data.id,
        pinned: false,
        date: nowIso(),
        author,
        title,
        text,
        image: result.data.image || '',
        comments: [],
      };
      postsOverride = getEffectivePosts().concat([localPost]);
      siteSaveOverride('posts', postsOverride);
      renderPosts();
      close();
    } else {
      error.textContent = result.message;
    }
  });

  titleInput.focus();
}

// ── Edit/Delete (boss/admin only) ─────────────────────────────
function openPostEditModal(existing) {
  const { form, error, actions, close: closeModal } = siteOpenModalWithClose('Rediger opslag');

  const [existingDate, existingTime] = existing.date.split('T');
  const dateInput = siteCreateDateField(existingDate);
  const timeInput = siteCreateTimeField((existingTime || '00:00:00').slice(0, 5));
  const dateTimeRow = document.createElement('div');
  dateTimeRow.className = 'edit-field-row';
  dateTimeRow.appendChild(siteEditField('Dato', dateInput));
  dateTimeRow.appendChild(siteEditField('Tidspunkt', timeInput));
  form.appendChild(dateTimeRow);

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing.title || '';
  form.appendChild(siteEditField('Titel (valgfrit)', titleInput));

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  authorInput.value = existing.author;
  form.appendChild(siteEditField('Afsender', authorInput));

  const { field: bodyField, bodyEl, toolbar } = createPostRichEditorField();
  seedPostEditableBody(bodyEl, existing.text);
  form.appendChild(bodyField);
  const close = () => { toolbar.destroy(); closeModal(); };

  const save = document.createElement('button');
  save.className = 'site-btn-success';
  save.textContent = 'Gem';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const date = dateInput.value;
    const time = timeInput.value;
    const title = titleInput.value.trim();
    const textPlain = bodyEl.textContent.trim();
    if (!date || !time || !textPlain) {
      error.textContent = 'Udfyld dato, tidspunkt og besked.';
      return;
    }
    const text = sanitizePostHtmlString(bodyEl.innerHTML);
    const item = {
      id: existing.id,
      // Not exposed by this form — carry over unchanged. Pinning is now a
      // one-click toggle on the list row (see togglePinned above), not an
      // edit-modal field, and image/comments changing here means delete-
      // and-recreate the post.
      pinned: existing.pinned,
      date: `${date}T${time}:00`,
      author: authorInput.value.trim() || existing.author,
      title,
      text,
      image: existing.image || '',
      comments: existing.comments || [],
    };
    const next = getEffectivePosts().map(p => (p.id === existing.id ? item : p));

    save.disabled = true;
    error.textContent = '';
    const result = await savePosts(next);
    save.disabled = false;
    if (result.ok) close();
    else error.textContent = result.message;
  });

  bodyEl.focus();
}

// Opens on top of the still-open detail modal (the caller no longer closes
// it first) rather than replacing it, so `onDeleted` — the detail modal's
// own `close` — only runs once the delete actually succeeds, closing both
// together; Annuller or a failed save leaves just this overlay closed and
// the detail modal still open beneath it. Mirrors calendar.js's
// openDeleteConfirm(ev, onDeleted).
function deletePost(post, onDeleted) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('post-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  const info = document.createElement('p');
  info.className = 'post-confirm-text';
  info.textContent = 'Slet dette opslag?';
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-btn-warm';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-btn-danger';
  confirmBtn.textContent = 'Slet';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectivePosts().filter(p => p.id !== post.id);
    const result = await savePosts(next);
    if (result.ok) {
      close();
      if (onDeleted) onDeleted();
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', renderPosts);
