/* =========================================================
   Matematikrevyen – Two-board forum on Forside
   Renders POSTS_DATA (embedded from data/posts.json), split into
   a general board (revyst+ can create; boss/admin edit/delete)
   and a boss board (boss/admin create/edit/delete, read-only for
   revyst, hidden below revyst).

   Unlike announcements.js's siteSaveResource-only flow, creating a
   post needs an ANY-level authenticated call (revyst included) —
   postsApi()/postsResolvePassword() below mirror budget.js's
   budgetApi()/budgetResolvePassword() for exactly that reason.
   Editing/deleting (boss/admin only) reuses siteSaveResource, same
   as announcements.js, since only boss/admin can reach those buttons.

   DOM is built via createElement/textContent only — no innerHTML.
   ========================================================= */

'use strict';

// ── Data (with in-memory shadow after a create/save) ─────────
// Same idea as announcements.js: the embed regeneration takes ~1-2
// min, so a successful create/save shows immediately in this tab only.
let postsOverride = null;

function getEffectivePosts() {
  return postsOverride || POSTS_DATA;
}

// ── Any-level authenticated API (for revyst-level post creation) ──
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

// ── Rendering ────────────────────────────────────────────────
function renderBoard(board, listId, adminId, canCreate) {
  const list = document.getElementById(listId);
  const adminSlot = document.getElementById(adminId);
  if (!list || !adminSlot) return;

  const canManage = siteHasLevel('boss');

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
    article.className = 'message';

    const meta = document.createElement('div');
    meta.className = 'message-meta';
    const metaText = document.createElement('span');
    metaText.textContent = `${formatDaDate(post.date)} · ${post.author}`;
    meta.appendChild(metaText);
    if (canManage) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn-small';
      editBtn.textContent = 'Rediger';
      editBtn.addEventListener('click', () => openPostEditModal(post));
      meta.appendChild(editBtn);
      const delBtn = document.createElement('button');
      delBtn.className = 'btn-small btn-small-danger';
      delBtn.textContent = 'Slet';
      delBtn.addEventListener('click', () => deletePost(post));
      meta.appendChild(delBtn);
    }
    article.appendChild(meta);

    for (const line of String(post.text).split('\n')) {
      if (!line.trim()) continue;
      const p = document.createElement('p');
      p.textContent = line;
      article.appendChild(p);
    }

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
  const title = board === 'boss' ? 'Nyt bosse-opslag' : 'Nyt opslag';
  const { form, error, actions, close } = siteOpenModalWithClose(title);

  const authorInput = document.createElement('input');
  authorInput.type = 'text';
  form.appendChild(siteEditField('Afsender', authorInput));

  const textArea = document.createElement('textarea');
  form.appendChild(siteEditField('Besked', textArea));

  const save = document.createElement('button');
  save.className = 'site-pill-btn site-pill-primary';
  save.textContent = 'Gem';
  actions.appendChild(save);

  save.addEventListener('click', async () => {
    const author = authorInput.value.trim();
    const text = textArea.value.trim();
    if (!author || !text) {
      error.textContent = 'Udfyld både afsender og besked.';
      return;
    }
    save.disabled = true;
    save.textContent = 'Gemmer…';
    error.textContent = '';
    const result = await postsApi('posts_create', { board, author, text });
    save.disabled = false;
    save.textContent = 'Gem';
    if (result.ok) {
      const localPost = { id: result.data.id, board, date: todayIso(), author, text };
      postsOverride = getEffectivePosts().concat([localPost]);
      renderPosts();
      close();
    } else {
      error.textContent = result.message;
    }
  });

  authorInput.focus();
}

// ── Edit/Delete (boss/admin only) ─────────────────────────────
function openPostEditModal(existing) {
  const { form, error, actions, close } = siteOpenModalWithClose('Rediger opslag');

  const dateInput = siteCreateDateField(existing.date);
  form.appendChild(siteEditField('Dato', dateInput));

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
    const text = textArea.value.trim();
    if (!date || !text) {
      error.textContent = 'Udfyld både dato og besked.';
      return;
    }
    const item = {
      id: existing.id,
      board: existing.board,
      date,
      author: authorInput.value.trim() || existing.author,
      text,
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
