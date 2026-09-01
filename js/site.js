/* =========================================================
   Matematikrevyen – Shared site shell: nav + login
   Renders the header nav on every page from one central page
   registry, and handles the shared-password login (revyst/boss/admin).

   Access model (deliberate trade-off, see CLAUDE.md):
   - Reads are gated client-side only — the repo is public, so
     nothing here is secret; the gate is usability, not security.
   - Writes are genuinely validated server-side by
     server/update-data.php against the same stored password.
   ========================================================= */

'use strict';

// ── Configuration ────────────────────────────────────────────
const SITE_API_ENDPOINT = 'https://manus.matematikrevy.dk/update-data.php';
const SITE_AUTH_KEY = 'matrevy-auth';

// The one place a page is registered. level:
//   'public' — always visible
//   'revyst' — greyed-out in nav until revyst+ login
//   'boss'/'admin' — omitted from nav entirely until that level or above
// `group` (optional) folds a page into a single nav tab shared with every
// other page carrying the same group key — see SITE_NAV_GROUP_LABELS and
// buildSiteNavLinks(). A future tool just adds another entry with the same
// group; no nav/CSS changes needed per tool.
const SITE_PAGES = [
  { href: 'index.html',       label: 'Forside',     level: 'public' },
  { href: 'kalender.html',    label: 'Kalender',    level: 'public' },
  { href: 'arkiv.html',       label: 'Arkiv',       level: 'revyst' },
  { href: 'wiki.html',        label: 'Wiki',        level: 'revyst' },
  { href: 'manus.html',       label: 'Manus',       level: 'revyst' },
  { href: 'budget.html',      label: 'Budget',      level: 'revyst' },
  { href: 'forms.html',       label: 'Formularer',  level: 'revyst' },
  { href: 'faellesspisning.html', label: 'Fællesspisning', level: 'revyst' },
  { href: 'schedule.html',    label: 'Øveplan',     level: 'revyst', group: 'redskaber' },
  { href: 'koordinator.html', label: 'Koordinator', level: 'admin' },
];

// Tab label for each `group` key used above.
const SITE_NAV_GROUP_LABELS = { redskaber: 'Redskaber' };

const SITE_LEVEL_RANK = { public: 0, revyst: 1, boss: 2, admin: 3 };

// ── Auth state ───────────────────────────────────────────────
// Over file:// the login endpoint is unreachable (CORS) and
// localStorage is a different origin, so the gate is bypassed
// entirely — preserves the schedule tool's offline use case.
// Writes still require the real password (import.js prompts).
function siteIsFileProtocol() {
  return location.protocol === 'file:';
}

function getSiteAuth() {
  if (siteIsFileProtocol()) return { level: 'admin', password: '' };
  try {
    const raw = localStorage.getItem(SITE_AUTH_KEY);
    if (!raw) return null;
    const auth = JSON.parse(raw);
    if (auth && (auth.level === 'revyst' || auth.level === 'boss' || auth.level === 'admin')) return auth;
  } catch (e) { /* ignore */ }
  return null;
}

function siteHasLevel(required) {
  const auth = getSiteAuth();
  const have = auth ? SITE_LEVEL_RANK[auth.level] : 0;
  return have >= SITE_LEVEL_RANK[required];
}

function siteLogout() {
  try { localStorage.removeItem(SITE_AUTH_KEY); } catch (e) { /* ignore */ }
  location.reload();
}

// ── Header / nav rendering ───────────────────────────────────
// z-index ladder: header 100 → mobile menu overlay 150 → login/edit modals 200.
function siteCurrentPage() {
  return location.pathname.split('/').pop() || 'index.html';
}

// One page's nav visibility: 'link' (visitor can use it), 'locked'
// (shown greyed so visitors know it exists), or 'hidden' (omitted
// entirely) — see the level comment on SITE_PAGES above.
function siteNavItemVisibility(page) {
  if (siteHasLevel(page.level)) return 'link';
  if (SITE_LEVEL_RANK[page.level] <= SITE_LEVEL_RANK.revyst) return 'locked';
  return 'hidden';
}

function siteNavLockedSpan(label) {
  const span = document.createElement('span');
  span.className = 'site-nav-locked';
  span.textContent = label;
  span.title = 'Log ind for at se denne side';
  return span;
}

// Fills `nav` with the page links and group tabs — shared by the
// desktop header nav (`mobile` false) and the mobile menu overlay
// (`mobile` true, renders a grouped tab as an accordion instead of a
// dropdown).
function buildSiteNavLinks(nav, opts) {
  const mobile = !!(opts && opts.mobile);
  const current = siteCurrentPage();
  const renderedGroups = new Set();
  for (const page of SITE_PAGES) {
    if (page.group) {
      if (renderedGroups.has(page.group)) continue;
      renderedGroups.add(page.group);
      renderNavGroup(nav, page.group, current, mobile);
      continue;
    }
    renderNavItem(nav, page, current);
  }
}

function renderNavItem(nav, page, current) {
  const visibility = siteNavItemVisibility(page);
  if (visibility === 'hidden') return;
  if (visibility === 'locked') {
    nav.appendChild(siteNavLockedSpan(page.label));
    return;
  }
  const a = document.createElement('a');
  a.href = page.href;
  a.textContent = page.label;
  if (page.href === current) a.className = 'active';
  nav.appendChild(a);
}

// Renders every SITE_PAGES entry sharing `groupKey` as one nav tab:
// nothing if none are visible to this visitor (mirrors a hidden
// boss/admin item), a plain locked span if visible-but-all-locked
// (mirrors a locked item), or an interactive dropdown/accordion once
// at least one sub-item is unlocked.
function renderNavGroup(nav, groupKey, current, mobile) {
  const items = SITE_PAGES.filter(p => p.group === groupKey);
  const visible = items.filter(p => siteNavItemVisibility(p) !== 'hidden');
  if (visible.length === 0) return;

  const label = SITE_NAV_GROUP_LABELS[groupKey] || groupKey;
  const hasUnlocked = visible.some(p => siteNavItemVisibility(p) === 'link');
  if (!hasUnlocked) {
    nav.appendChild(siteNavLockedSpan(label));
    return;
  }

  const isCurrent = items.some(p => p.href === current);
  if (mobile) renderMobileNavGroup(nav, label, visible, current, isCurrent);
  else renderDesktopNavGroup(nav, label, visible, current, isCurrent);
}

function renderDesktopNavGroup(nav, label, visible, current, isCurrent) {
  const wrap = document.createElement('div');
  wrap.className = 'site-nav-group';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-nav-group-btn' + (isCurrent ? ' active' : '');
  btn.textContent = label + ' ▾';
  btn.setAttribute('aria-expanded', 'false');
  wrap.appendChild(btn);

  const dropdown = document.createElement('div');
  dropdown.className = 'site-field-pop site-nav-dropdown';
  dropdown.hidden = true;
  for (const page of visible) {
    if (siteNavItemVisibility(page) === 'locked') {
      dropdown.appendChild(siteNavLockedSpan(page.label));
      continue;
    }
    const a = document.createElement('a');
    a.className = 'site-list-row' + (page.href === current ? ' site-list-selected' : '');
    a.href = page.href;
    a.textContent = page.label;
    dropdown.appendChild(a);
  }
  wrap.appendChild(dropdown);
  nav.appendChild(wrap);

  // Self-contained open/close/outside-click/Escape handling — this
  // page may not have loaded site-utils.js (schedule.html doesn't),
  // so it can't reuse that file's shared popup helpers.
  let onDocClick = null;
  let onKeydown = null;
  function closeDropdown() {
    dropdown.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (onDocClick) document.removeEventListener('click', onDocClick);
    if (onKeydown) document.removeEventListener('keydown', onKeydown);
    onDocClick = null;
    onKeydown = null;
  }
  btn.addEventListener('click', () => {
    if (!dropdown.hidden) { closeDropdown(); return; }
    dropdown.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    onDocClick = (e) => { if (!wrap.contains(e.target)) closeDropdown(); };
    onKeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); closeDropdown(); btn.focus(); } };
    // Deferred so this opening click doesn't also trigger onDocClick.
    setTimeout(() => document.addEventListener('click', onDocClick), 0);
    document.addEventListener('keydown', onKeydown);
  });
}

function renderMobileNavGroup(nav, label, visible, current, isCurrent) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'site-menu-nav-group-btn' + (isCurrent ? ' active' : '');
  btn.setAttribute('aria-expanded', isCurrent ? 'true' : 'false');
  nav.appendChild(btn);

  const sub = document.createElement('div');
  sub.className = 'site-menu-nav-sub';
  sub.hidden = !isCurrent;
  for (const page of visible) {
    if (siteNavItemVisibility(page) === 'locked') {
      sub.appendChild(siteNavLockedSpan(page.label));
      continue;
    }
    const a = document.createElement('a');
    a.href = page.href;
    a.textContent = page.label;
    if (page.href === current) a.className = 'active';
    sub.appendChild(a);
  }
  nav.appendChild(sub);

  function setChevron() { btn.textContent = (sub.hidden ? '▸ ' : '▾ ') + label; }
  setChevron();
  btn.addEventListener('click', () => {
    sub.hidden = !sub.hidden;
    btn.setAttribute('aria-expanded', sub.hidden ? 'false' : 'true');
    setChevron();
  });
}

// Returns a configured login/logout button, or null over file://
// (no login UI offline). Both actions end in a page reload, so the
// mobile menu never needs to close around them.
function buildAuthButton() {
  if (siteIsFileProtocol()) return null;
  const btn = document.createElement('button');
  btn.className = 'site-login-btn';
  const auth = getSiteAuth();
  if (auth) {
    btn.textContent = `Log ud (${auth.level})`;
    btn.addEventListener('click', siteLogout);
  } else {
    btn.textContent = 'Log ind';
    btn.addEventListener('click', openLoginModal);
  }
  return btn;
}

function renderSiteHeader() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  header.textContent = '';

  const title = document.createElement('div');
  title.className = 'site-title';
  title.textContent = 'Matematikrevyen';
  header.appendChild(title);

  const nav = document.createElement('nav');
  nav.className = 'site-nav';
  buildSiteNavLinks(nav, { mobile: false });
  header.appendChild(nav);

  const authBtn = buildAuthButton();
  if (authBtn) {
    const authBox = document.createElement('div');
    authBox.className = 'site-auth';
    authBox.appendChild(authBtn);
    header.appendChild(authBox);
  }

  // Hamburger — hidden on desktop via CSS, opens the mobile menu.
  const menuBtn = document.createElement('button');
  menuBtn.type = 'button';
  menuBtn.className = 'site-menu-btn';
  menuBtn.setAttribute('aria-label', 'Menu');
  menuBtn.setAttribute('aria-expanded', 'false');
  for (let i = 0; i < 3; i++) {
    const bar = document.createElement('span');
    bar.className = 'site-menu-bar';
    menuBtn.appendChild(bar);
  }
  menuBtn.addEventListener('click', () => openSiteMenu(menuBtn));
  header.appendChild(menuBtn);

  siteUpdateHeaderFit();
}

// Switches the header between inline nav and hamburger based on
// whether the nav+login actually fit — not a fixed viewport
// breakpoint, since SITE_PAGES can grow past what a wide-but-not-huge
// window can fit well before the ≤719px mobile breakpoint kicks in.
function siteUpdateHeaderFit() {
  const header = document.querySelector('.site-header');
  if (!header) return;
  // Un-collapse first so the measurement reflects the full inline
  // nav+login, not whatever the last measurement decided.
  header.classList.remove('site-header-collapsed');
  const overflowing = header.scrollWidth > header.clientWidth + 1;
  header.classList.toggle('site-header-collapsed', overflowing);
}

let siteHeaderFitRaf = null;
window.addEventListener('resize', () => {
  if (siteHeaderFitRaf) cancelAnimationFrame(siteHeaderFitRaf);
  siteHeaderFitRaf = requestAnimationFrame(() => {
    siteHeaderFitRaf = null;
    siteUpdateHeaderFit();
  });
});
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(siteUpdateHeaderFit);
}

// ── Mobile menu overlay ──────────────────────────────────────
function openSiteMenu(menuBtn) {
  if (document.getElementById('site-menu-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'site-menu-overlay';
  overlay.id = 'site-menu-overlay';

  const top = document.createElement('div');
  top.className = 'site-menu-top';
  const title = document.createElement('div');
  title.className = 'site-title';
  title.textContent = 'Matematikrevyen';
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.className = 'site-menu-close';
  closeBtn.textContent = '✕';
  closeBtn.setAttribute('aria-label', 'Luk menu');
  top.appendChild(title);
  top.appendChild(closeBtn);
  overlay.appendChild(top);

  const nav = document.createElement('nav');
  nav.className = 'site-menu-nav';
  buildSiteNavLinks(nav, { mobile: true });
  overlay.appendChild(nav);

  const authBtn = buildAuthButton();
  if (authBtn) {
    const authBox = document.createElement('div');
    authBox.className = 'site-menu-auth';
    authBox.appendChild(authBtn);
    overlay.appendChild(authBox);
  }

  document.body.appendChild(overlay);
  document.body.classList.add('site-menu-open');
  if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true');

  function close() {
    document.removeEventListener('keydown', onKeydown);
    document.body.classList.remove('site-menu-open');
    overlay.remove();
    if (menuBtn) {
      menuBtn.setAttribute('aria-expanded', 'false');
      menuBtn.focus();
    }
  }
  function onKeydown(e) {
    // Leave Escape to the login modal while it's stacked on top.
    if (e.key === 'Escape' && !document.getElementById('login-overlay')) close();
  }
  document.addEventListener('keydown', onKeydown);
  closeBtn.addEventListener('click', close);
  // Close when a nav link is tapped — covers the current page's
  // link, where no navigation (and thus no fresh header) happens.
  nav.addEventListener('click', (e) => {
    if (e.target.closest('a')) close();
  });
  // "Log ind" opens the login modal on top of the menu (z-index 200
  // > 150); cancel returns to the menu, success reloads the page.

  closeBtn.focus();
}

// ── Login modal ──────────────────────────────────────────────
function openLoginModal() {
  if (document.getElementById('login-overlay')) return;

  const overlay = document.createElement('div');
  overlay.className = 'login-overlay';
  overlay.id = 'login-overlay';

  const modal = document.createElement('div');
  modal.className = 'login-modal site-modal';

  function close() { document.removeEventListener('keydown', onKeydown); overlay.remove(); }
  function onKeydown(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', onKeydown);

  const closeX = document.createElement('button');
  closeX.type = 'button';
  closeX.className = 'site-modal-close';
  closeX.textContent = '✕';
  closeX.setAttribute('aria-label', 'Luk');
  closeX.addEventListener('click', close);
  modal.appendChild(closeX);

  const heading = document.createElement('h2');
  heading.textContent = 'Log ind';
  modal.appendChild(heading);

  const input = document.createElement('input');
  input.type = 'password';
  input.id = 'login-password';
  input.autocomplete = 'current-password';
  modal.appendChild(input);

  const error = document.createElement('div');
  error.className = 'login-error';
  modal.appendChild(error);

  const actions = document.createElement('div');
  actions.className = 'login-actions login-actions-end';
  const submit = document.createElement('button');
  submit.className = 'site-btn-primary';
  submit.textContent = 'Log ind';
  actions.appendChild(submit);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  // Same mousedown-must-also-be-on-the-backdrop guard as
  // siteOpenModalWithClose — a resize-drag release over the backdrop
  // shouldn't count as a genuine backdrop click.
  let backdropMousedown = false;
  overlay.addEventListener('mousedown', (e) => { backdropMousedown = e.target === overlay; });
  overlay.addEventListener('click', (e) => { if (e.target === overlay && backdropMousedown) close(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });

  submit.addEventListener('click', async () => {
    const password = input.value.trim();
    if (!password) return;
    submit.disabled = true;
    error.textContent = '';
    try {
      const res = await fetch(SITE_API_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'login', password }),
      });
      if (res.status === 401) {
        error.textContent = 'Forkert adgangskode. Prøv igen.';
        return;
      }
      if (!res.ok) {
        error.textContent = 'Serverfejl. Prøv igen senere.';
        return;
      }
      const data = await res.json();
      if (!data || (data.level !== 'revyst' && data.level !== 'boss' && data.level !== 'admin')) {
        error.textContent = 'Uventet svar fra serveren.';
        return;
      }
      try {
        localStorage.setItem(SITE_AUTH_KEY, JSON.stringify({ level: data.level, password }));
      } catch (e) { /* ignore */ }
      location.reload();
    } catch (e) {
      error.textContent = 'Kunne ikke kontakte serveren. Tjek din internetforbindelse.';
    } finally {
      submit.disabled = false;
    }
  });

  input.focus();
}

// ── Nav prefetch ─────────────────────────────────────────────
// Hints the browser to fetch every other reachable page's HTML at
// idle priority, so a later nav click is a cache hit instead of a
// fresh request. Skipped over file:// (nothing to prefetch from).
// Only the page's HTML is hinted — its own JS/data bundles are
// small and get cached the first time it's actually visited.
function injectSitePrefetchLinks() {
  if (siteIsFileProtocol()) return;
  const current = siteCurrentPage();
  for (const page of SITE_PAGES) {
    if (page.href === current || !siteHasLevel(page.level)) continue;
    const link = document.createElement('link');
    link.rel = 'prefetch';
    link.href = page.href;
    document.head.appendChild(link);
  }
}

// ── Page-level gate ──────────────────────────────────────────
// Hides the page's <main> and shows a login prompt instead when
// the visitor's level is insufficient. Cosmetic only (the data is
// in the public repo anyway) — writes are validated server-side.
function applyPageGate() {
  const current = siteCurrentPage();
  const page = SITE_PAGES.find(p => p.href === current);
  if (!page || siteHasLevel(page.level)) return;

  const main = document.querySelector('main');
  if (main) main.style.display = 'none';

  const gate = document.createElement('main');
  gate.className = 'page-content';
  const card = document.createElement('section');
  card.className = 'card site-gate-card';
  const h = document.createElement('h2');
  h.textContent = 'Log ind for at se denne side';
  const actions = document.createElement('div');
  actions.className = 'site-gate-actions';
  const btn = document.createElement('button');
  btn.className = 'site-login-btn site-gate-login';
  btn.textContent = 'Log ind';
  btn.addEventListener('click', openLoginModal);
  actions.appendChild(btn);
  card.appendChild(h);
  card.appendChild(actions);
  gate.appendChild(card);

  const footer = document.querySelector('.site-footer');
  if (footer) document.body.insertBefore(gate, footer);
  else document.body.appendChild(gate);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderSiteHeader();
  applyPageGate();
  injectSitePrefetchLinks();
});
