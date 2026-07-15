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
const SITE_PAGES = [
  { href: 'index.html',       label: 'Forside',     level: 'public' },
  { href: 'kalender.html',    label: 'Kalender',    level: 'public' },
  { href: 'arkiv.html',       label: 'Arkiv',       level: 'revyst' },
  { href: 'wiki.html',        label: 'Wiki',        level: 'revyst' },
  { href: 'budget.html',      label: 'Budget',      level: 'revyst' },
  { href: 'manus.html',       label: 'Manus',       level: 'revyst' },
  { href: 'schedule.html',    label: 'Øveplan',     level: 'boss' },
  { href: 'koordinator.html', label: 'Koordinator', level: 'admin' },
];

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

// Fills `nav` with the page links — shared by the desktop header
// nav and the mobile menu overlay.
function buildSiteNavLinks(nav) {
  const current = siteCurrentPage();
  for (const page of SITE_PAGES) {
    if (siteHasLevel(page.level)) {
      // falls through to the real link below
    } else if (SITE_LEVEL_RANK[page.level] <= SITE_LEVEL_RANK.revyst) {
      // revyst-level pages: greyed-out but visible, so visitors know they exist
      const locked = document.createElement('span');
      locked.className = 'site-nav-locked';
      locked.textContent = page.label;
      locked.title = 'Log ind for at se denne side';
      nav.appendChild(locked);
      continue;
    } else {
      // boss/admin-level pages: hidden entirely below that level
      continue;
    }
    const a = document.createElement('a');
    a.href = page.href;
    a.textContent = page.label;
    if (page.href === current) a.className = 'active';
    nav.appendChild(a);
  }
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
  buildSiteNavLinks(nav);
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
  buildSiteNavLinks(nav);
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
  modal.className = 'login-modal';

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
  actions.className = 'login-actions';
  const submit = document.createElement('button');
  submit.className = 'site-btn-primary';
  submit.textContent = 'Log ind';
  const cancel = document.createElement('button');
  cancel.className = 'site-pill-btn';
  cancel.textContent = 'Annuller';
  actions.appendChild(cancel);
  actions.appendChild(submit);
  modal.appendChild(actions);

  overlay.appendChild(modal);
  document.body.appendChild(overlay);

  function close() { overlay.remove(); }
  cancel.addEventListener('click', close);
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit.click(); });

  submit.addEventListener('click', async () => {
    const password = input.value.trim();
    if (!password) return;
    submit.disabled = true;
    submit.textContent = 'Logger ind…';
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
      submit.textContent = 'Log ind';
    }
  });

  input.focus();
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
  const p = document.createElement('p');
  p.textContent = 'Denne side er for revyens medlemmer. Tryk på "Log ind" og indtast den fælles adgangskode.';
  const btn = document.createElement('button');
  btn.className = 'site-login-btn site-gate-login';
  btn.textContent = 'Log ind';
  btn.addEventListener('click', openLoginModal);
  card.appendChild(h);
  card.appendChild(p);
  card.appendChild(btn);
  gate.appendChild(card);

  const footer = document.querySelector('.site-footer');
  if (footer) document.body.insertBefore(gate, footer);
  else document.body.appendChild(gate);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  renderSiteHeader();
  applyPageGate();
});
