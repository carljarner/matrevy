/* =========================================================
   Matematikrevyen – Two-board forum on Forside
   Renders POSTS_DATA (embedded from data/posts.json), split into
   a general board (revyst+ can create; boss/admin edit/delete)
   and a boss board (boss/admin create/edit/delete, read-only for
   revyst, hidden below revyst).

   Each post has a title + optional picture and a comments thread.
   The list view shows only date/title/author; clicking a post opens
   a detail modal with the full text, image, comments and (for
   boss/admin) the Rediger/Slet buttons for the post itself.

   Unlike calendar.js/archive.js's siteSaveResource-only flow, creating a
   post (or a comment) needs an ANY-level authenticated call (revyst
   included) — postsApi()/postsResolvePassword() below mirror
   budget.js's budgetApi()/budgetResolvePassword() for exactly that
   reason. Editing/deleting a post, and deleting an individual
   comment, are boss/admin only and reuse siteSaveResource (a full
   posts-array replace) exactly like today.

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

// ── Rendering: list view (date/title/author only) ────────────
function renderBoard(board, listId, adminId, canCreate) {
  const list = document.getElementById(listId);
  const adminSlot = document.getElementById(adminId);
  if (!list || !adminSlot) return;

  adminSlot.textContent = '';
  if (canCreate) {
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-small';
    addBtn.textContent = '+ Ny post';
    addBtn.addEventListener('click', () => openPostCreateModal(board));
    adminSlot.appendChild(addBtn);
  }

  const visible = getEffectivePosts()
    .filter(p => p.board === board)
    .slice()
    .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));

  list.textContent = '';
  if (visible.length === 0) {
    const empty = document.createElement('p');
    empty.textContent = 'Ingen opslag endnu.';
    list.appendChild(empty);
    return;
  }

  for (const post of visible) {
    const article = document.createElement('article');
    article.className = 'post-summary';
    article.setAttribute('role', 'button');
    article.tabIndex = 0;
    article.setAttribute('aria-label', postTitle(post));

    const title = document.createElement('h3');
    title.className = 'post-summary-title';
    title.textContent = postTitle(post);
    article.appendChild(title);

    const meta = document.createElement('div');
    meta.className = 'post-summary-meta';
    meta.textContent = `${formatDaDate(post.date)} · ${post.author}`;
    article.appendChild(meta);

    const open = () => openPostDetail(post);
    article.addEventListener('click', open);
    article.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
    });

    list.appendChild(article);
  }
}

function renderPosts() {
  renderBoard('general', 'posts-general-list', 'posts-general-admin', siteHasLevel('revyst'));

  // The boss board is entirely absent for public/logged-out visitors —
  // only revyst+ ever see it exists (read-only below boss level).
  const bossSection = document.getElementById('posts-boss-section');
  if (!bossSection) return;
  if (siteHasLevel('revyst')) {
    bossSection.style.display = '';
    renderBoard('boss', 'posts-boss-list', 'posts-boss-admin', siteHasLevel('boss'));
  } else {
    bossSection.style.display = 'none';
  }
}

// ── Detail modal: image, full text, comments, admin actions ──
function openPostDetail(post) {
  const { form, actions, close } = siteOpenModalWithClose(postTitle(post));

  if (post.image) {
    const cover = document.createElement('div');
    cover.className = 'post-detail-cover';
    const img = document.createElement('img');
    img.src = post.image;
    img.alt = postTitle(post);
    img.loading = 'lazy';
    img.decoding = 'async';
    cover.appendChild(img);
    form.appendChild(cover);
  }

  const meta = document.createElement('div');
  meta.className = 'post-detail-meta';
  meta.textContent = `${formatDaDate(post.date)} · ${post.author}`;
  form.appendChild(meta);

  // Boss/admin manage the post itself from here, not from the list view.
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

  for (const line of String(post.text).split('\n')) {
    if (!line.trim()) continue;
    const p = document.createElement('p');
    p.textContent = line;
    form.appendChild(p);
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
      cmetaText.textContent = `${formatDaDate(c.date)} · ${c.author}`;
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

  // Comment form: revyst+ on a general post, boss+ on a boss post — mirrors
  // the same board-gating renderBoard's canCreate uses for new posts.
  const canComment = post.board === 'boss' ? siteHasLevel('boss') : siteHasLevel('revyst');
  if (canComment) {
    const commentForm = document.createElement('div');
    commentForm.className = 'post-comment-form';

    const authorInput = document.createElement('input');
    authorInput.type = 'text';
    commentForm.appendChild(siteEditField('Afsender', authorInput));

    const textArea = document.createElement('textarea');
    commentForm.appendChild(siteEditField('Kommentar', textArea));

    const commentError = document.createElement('div');
    commentError.className = 'login-error';
    commentForm.appendChild(commentError);

    const submitBtn = document.createElement('button');
    submitBtn.className = 'site-pill-btn site-pill-primary';
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
        close();
        const updated = getEffectivePosts().find(p => p.id === post.id);
        if (updated) openPostDetail(updated);
      } else {
        commentError.textContent = result.message;
      }
    });
    commentForm.appendChild(submitBtn);

    form.appendChild(commentForm);
  }
}

// ── Comments: create (any level, board-gated) / delete (boss/admin) ──
async function postComment(post, author, text) {
  const result = await postsApi('comments_create', { postId: post.id, author, text });
  if (result.ok) {
    const localComment = { id: result.data.comment.id, author, text, date: todayIso() };
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

// ── Create (revyst+ on the general board, boss+ on the boss board) ──
// A dedicated append-only server action (posts_create), not siteSaveResource
// — see the file header for why.
function openPostCreateModal(board) {
  const modalTitle = board === 'boss' ? 'Nyt bosse-opslag' : 'Nyt opslag';
  const { form, error, actions, close } = siteOpenModalWithClose(modalTitle);

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
    const body = { board, title, author, text };
    if (imageBase64) body.imageBase64 = imageBase64;
    const result = await postsApi('posts_create', body);
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) {
      const localPost = {
        id: result.data.id,
        board,
        date: todayIso(),
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

  const dateInput = siteCreateDateField(existing.date);
  form.appendChild(siteEditField('Dato', dateInput));

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
    const title = titleInput.value.trim();
    const text = textArea.value.trim();
    if (!date || !title || !text) {
      error.textContent = 'Udfyld dato, titel og besked.';
      return;
    }
    const item = {
      id: existing.id,
      board: existing.board,
      date,
      author: authorInput.value.trim() || existing.author,
      title,
      text,
      // Not exposed by this form — carry over unchanged so a save never
      // silently wipes the post's picture or comment thread. Changing the
      // picture in this pass means delete-and-recreate the post.
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
