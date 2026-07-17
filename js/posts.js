/* =========================================================
   Matematikrevyen – Post board with pinning, on Forside
   Renders POSTS_DATA (embedded from data/posts.json) as two
   columns: a normal list (revyst+ can create; boss/admin
   edit/delete/pin) and a pinned column fed purely by boss/admin
   flipping a post's `pinned` flag via a pin-icon button on the list
   row (togglePinned, not the edit modal) — pinning MOVES a post out
   of the normal list, it never duplicates it. Both columns share the
   same audience: public read, revyst+ write/comment.

   Each post has a title + optional picture and a comments thread.
   The list view shows only date/title/author (plus, for boss/admin,
   the pin toggle); clicking a post opens a detail modal with the full
   text, image, comments and (for boss/admin) the Rediger/Slet buttons
   for the post itself.

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

// ── Data (with in-memory shadow after a create/save) ─────────
// Same idea as calendar.js/archive.js: the embed regeneration takes ~1-2
// min, so a successful create/save shows immediately in this tab only.
let postsOverride = null;

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

// A bulletin-board thumbtack (round flat head + a sharp triangular metal
// point below it), not a map-pin teardrop — outline when a post is
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

  const needle = document.createElementNS(svgNS, 'path');
  needle.setAttribute('d', 'M6.1 7.4L9.9 7.4L8 14.3Z');
  needle.setAttribute('fill', filled ? 'currentColor' : 'none');
  needle.setAttribute('stroke', 'currentColor');
  needle.setAttribute('stroke-width', filled ? '0' : '1.1');
  needle.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(needle);

  return svg;
}

// Boss/admin-only quick toggle from the list row — not routed through the
// edit modal. Mirrors archive.js's deleteYear: mutate, save, alert() on
// failure (no modal error slot to show it in for a one-click action).
async function togglePinned(post) {
  const next = getEffectivePosts().map(p =>
    p.id === post.id ? { ...p, pinned: !p.pinned } : p
  );
  const result = await savePosts(next);
  if (!result.ok && result.message) alert(result.message);
}

// ── Rendering: list view (date/title/author only) ────────────
// `posts` is an already-filtered/sorted array; `adminId` may be null for
// the pinned column, which never gets its own create button.
function renderPostList(posts, listId, adminId, canCreate) {
  const list = document.getElementById(listId);
  if (!list) return;

  if (adminId) {
    const adminSlot = document.getElementById(adminId);
    if (adminSlot) {
      adminSlot.textContent = '';
      if (canCreate) {
        const addBtn = document.createElement('button');
        addBtn.className = 'btn-small';
        addBtn.textContent = '+ Ny post';
        addBtn.addEventListener('click', () => openPostCreateModal());
        adminSlot.appendChild(addBtn);
      }
    }
  }

  list.textContent = '';
  if (posts.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Ingen opslag endnu.';
    list.appendChild(empty);
    return;
  }

  for (const post of posts) {
    const article = document.createElement('article');
    article.className = 'post-summary';
    article.setAttribute('role', 'button');
    article.tabIndex = 0;
    article.setAttribute('aria-label', postTitle(post));

    const main = document.createElement('div');
    main.className = 'post-summary-main';

    const title = document.createElement('h3');
    title.className = 'post-summary-title';
    title.textContent = postTitle(post);
    main.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'post-summary-meta';
    meta.textContent = `${formatDaDateTime(post.date)} · ${post.author}`;
    main.appendChild(meta);

    article.appendChild(main);

    if (siteHasLevel('boss')) {
      const pinBtn = document.createElement('button');
      pinBtn.type = 'button';
      pinBtn.className = 'post-pin-btn' + (post.pinned ? ' pinned' : '');
      const label = post.pinned ? 'Frigør opslag' : 'Fastgør opslag';
      pinBtn.setAttribute('aria-label', label);
      pinBtn.title = label;
      pinBtn.appendChild(postsPinIcon(post.pinned));
      pinBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePinned(post);
      });
      article.appendChild(pinBtn);
    }

    const open = () => openPostDetail(post);
    article.addEventListener('click', open);
    article.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    list.appendChild(article);
  }
}

function renderPosts() {
  const all = getEffectivePosts()
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const pinned = all.filter(p => p.pinned);
  const unpinned = all.filter(p => !p.pinned);

  renderPostList(unpinned, 'posts-list', 'posts-admin', siteHasLevel('revyst'));
  renderPostList(pinned, 'posts-pinned-list', null, false);
}

// ── Detail modal: image, full text, comments, admin actions ──
function openPostDetail(post) {
  const { form, error, actions, close } = siteOpenModalWithClose(postTitle(post));
  // Unused here (Rediger/Slet/comment-form live directly in `form` instead)
  // — remove rather than leave empty, since their own top-margin/min-height
  // would otherwise pad out extra space below the actual content.
  error.remove();
  actions.remove();

  const meta = document.createElement('div');
  meta.className = 'post-detail-meta';
  meta.textContent = `${formatDaDateTime(post.date)} · ${post.author}`;
  form.appendChild(meta);

  const textBox = document.createElement('div');
  textBox.className = 'post-detail-text';
  for (const line of String(post.text).split('\n')) {
    if (!line.trim()) continue;
    const p = document.createElement('p');
    p.textContent = line;
    textBox.appendChild(p);
  }
  form.appendChild(textBox);

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

      const cmeta = document.createElement('div');
      cmeta.className = 'message-meta';
      const cmetaText = document.createElement('span');
      cmetaText.textContent = `${formatDaDateTime(c.date)} · ${c.author}`;
      cmeta.appendChild(cmetaText);
      if (siteHasLevel('boss')) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn-small btn-small-danger';
        delBtn.textContent = 'Slet';
        delBtn.addEventListener('click', () => deleteComment(post, c));
        cmeta.appendChild(delBtn);
      }
      article.appendChild(cmeta);

      const ctext = document.createElement('p');
      ctext.textContent = c.text;
      article.appendChild(ctext);

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
    trigger.textContent = '+ Kommentér';
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

    const editBtn = document.createElement('button');
    editBtn.className = 'site-pill-btn site-pill-warm';
    editBtn.textContent = 'Rediger';
    editBtn.addEventListener('click', () => { close(); openPostEditModal(post); });
    actionsRow.appendChild(editBtn);

    const delBtn = document.createElement('button');
    delBtn.className = 'site-pill-btn site-pill-danger';
    delBtn.textContent = 'Slet';
    delBtn.addEventListener('click', () => { close(); deletePost(post); });
    actionsRow.appendChild(delBtn);

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
  submitBtn.className = 'site-pill-btn site-pill-primary post-comment-submit';
  submitBtn.textContent = 'Kommentér';
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
    submitBtn.textContent = 'Kommentér';
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
    renderPosts();
  }
  return result;
}

function deleteComment(post, comment) {
  const { form, error, actions, close } = siteOpenEditModal('Slet kommentar');

  const info = document.createElement('p');
  info.textContent = 'Slet denne kommentar?';
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-pill-btn site-pill-danger';
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
    renderPosts();
  }
  return result;
}

// ── Create (revyst+) ──────────────────────────────────────────
// A dedicated append-only server action (posts_create), not siteSaveResource
// — see the file header for why. New posts are always unpinned; boss/admin
// pin a post afterwards via the edit modal.
function openPostCreateModal() {
  const { form, error, actions, close } = siteOpenModalWithClose('Nyt opslag');

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  form.appendChild(siteEditField('Titel', titleInput));

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  form.appendChild(siteEditField('Afsender', authorInput));

  const textArea = document.createElement('textarea');
  form.appendChild(siteEditField('Besked', textArea));

  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = 'image/*';
  form.appendChild(siteEditField('Billede (valgfrit)', fileInput));

  const save = document.createElement('button');
  save.className = 'site-pill-btn site-pill-primary';
  save.textContent = 'Gem';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const title = titleInput.value.trim();
    const author = authorInput.value.trim();
    const text = textArea.value.trim();
    if (!title || !author || !text) {
      error.textContent = 'Udfyld titel, afsender og besked.';
      return;
    }

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

    save.textContent = 'Gemmer…';
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
  const { form, error, actions, close } = siteOpenModalWithClose('Rediger opslag');

  const [existingDate, existingTime] = existing.date.split('T');
  const dateInput = siteCreateDateField(existingDate);
  form.appendChild(siteEditField('Dato', dateInput));

  const timeInput = siteCreateTimeField((existingTime || '00:00:00').slice(0, 5));
  form.appendChild(siteEditField('Tidspunkt', timeInput));

  const titleInput = document.createElement('input');
  titleInput.type = 'text';
  titleInput.value = existing.title || '';
  form.appendChild(siteEditField('Titel', titleInput));

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  authorInput.value = existing.author;
  form.appendChild(siteEditField('Afsender', authorInput));

  const textArea = document.createElement('textarea');
  textArea.value = existing.text;
  form.appendChild(siteEditField('Besked', textArea));

  const save = document.createElement('button');
  save.className = 'site-pill-btn site-pill-primary';
  save.textContent = 'Gem';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const date = dateInput.value;
    const time = timeInput.value;
    const title = titleInput.value.trim();
    const text = textArea.value.trim();
    if (!date || !time || !title || !text) {
      error.textContent = 'Udfyld dato, tidspunkt, titel og besked.';
      return;
    }
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
    save.textContent = 'Gemmer…';
    error.textContent = '';
    const result = await savePosts(next);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) close();
    else error.textContent = result.message;
  });

  textArea.focus();
}

function deletePost(post) {
  const { form, error, actions, close } = siteOpenEditModal('Slet opslag');

  const info = document.createElement('p');
  info.textContent = 'Slet dette opslag?';
  form.appendChild(info);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'site-pill-btn';
  cancelBtn.textContent = 'Annuller';
  cancelBtn.addEventListener('click', close);

  const confirmBtn = document.createElement('button');
  confirmBtn.className = 'site-pill-btn site-pill-danger';
  confirmBtn.textContent = 'Slet';
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const next = getEffectivePosts().filter(p => p.id !== post.id);
    const result = await savePosts(next);
    if (result.ok) {
      close();
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
