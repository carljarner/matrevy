/* =========================================================
   Matematikrevyen – Budget page (budget.html)

   Two audiences, one page:
   - Revyster get a submit form to request reimbursement for an
     expense they paid (category, amount, name, phone, receipt
     photo, comment).
   - Admins (kasserer) review pending requests and approve them
     (paid) — which assigns the next bilagsnummer, renames the
     receipt to "<kategori>_<n>.<ext>" and moves it into the ledger —
     plus a read-only browser of paid expenses by category.

   Unlike the other data-driven pages, the budget data is PRIVATE:
   it never touches the public repo / embed pipeline. Everything
   is read/written through authenticated actions on the same PHP
   endpoint (site.js's SITE_API_ENDPOINT), backed by files on the
   Simply.com host — names, phone numbers and receipts stay off
   GitHub.

   Rendering rule (as elsewhere): createElement/textContent only,
   never innerHTML.
   ========================================================= */

'use strict';

// ── Categories (per-year data, loaded from the server — see budgetState.categories
// below; no longer a fixed client-side list. update-data.php's
// budget_default_categories()/budget_load_categories() are the server-side
// counterpart, one categories.json per budget year.) ─

function budgetCategoryLabel(key, categories) {
  const c = (categories || []).find((x) => x.key === key);
  return c ? c.label : key;
}

// Option list for siteCreateDropdownField (site-utils.js), optionally
// prefixed with an empty "not yet chosen" placeholder row.
function budgetCategoryOptions(categories, placeholder) {
  const opts = (categories || []).map((c) => ({ value: c.key, label: c.label }));
  return placeholder ? [{ value: '', label: 'Vælg kategori …' }, ...opts] : opts;
}

// True if `key` matches a category currently in `categories` — used to gate
// approval and flag "orphaned" pending requests whose category was deleted
// after submission (see budget_submit's server-side comment for why that's
// accepted rather than rejected).
function budgetCategoryIsValid(key, categories) {
  return (categories || []).some((c) => c.key === key);
}

// ── Small DOM helper ─────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

// The page's shared <h1> (budget.html) is static markup used by both the
// admin view and the revyst/boss submit form — this is the one place either
// updates it to track whichever year is actually relevant.
function budgetSetPageTitle(year) {
  const h1 = document.getElementById('budget-page-title');
  if (h1) h1.textContent = 'Budget for MatRevy' + (year != null ? ' ' + year : '');
}

function formatKr(amount) {
  const n = Number(amount) || 0;
  return n.toLocaleString('da-DK', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr';
}

// ISO date (YYYY-MM-DD) → dd/mm/yyyy; '—' when missing/invalid.
function formatDaNumeric(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${m[3]}/${m[2]}/${m[1]}` : '—';
}

// Accepts Danish comma decimals too.
function parseAmount(str) {
  const n = parseFloat(String(str).replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(n) ? n : NaN;
}

// ── Receipt image → JPEG base64 ──────────────────────────────
// Self-contained (archive.js's helpers are NOT loaded on this page).
// Re-encodes to JPEG via <canvas> so the stored file is always a .jpg,
// regardless of what the phone hands us (HEIC/PNG/JPEG). Two decode
// paths for cross-browser robustness — createImageBitmap where it
// works, an <img> element (which iOS Safari can decode HEIC through)
// as fallback — then a last-resort fallback to the original bytes so
// a submit never hard-fails on an odd image.
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

async function compressReceiptImage(file, { maxWidth = 1600, quality = 0.8 } = {}) {
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

function isPdfFile(file) {
  return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || '');
}

// Returns { base64, size, ext } for upload. A PDF is sent through
// unchanged (there's nothing to re-encode/downscale) with ext:'pdf';
// an image prefers a re-encoded/downscaled JPEG, falling back to the
// original file bytes if the browser can't process it at all (better
// a big-but-working receipt than a blocked submit) — always ext:'jpg'.
async function receiptToBase64(file) {
  if (isPdfFile(file)) {
    return { base64: await blobToBase64(file), size: file.size, ext: 'pdf' };
  }
  let blob;
  try {
    blob = await compressReceiptImage(file);
  } catch (e) {
    blob = file;
  }
  return { base64: await blobToBase64(blob), size: blob.size, ext: 'jpg' };
}

// ── Authenticated API ────────────────────────────────────────
// Works for revyst AND admin: the password is whichever level the
// visitor logged in with (getSiteAuth().password), unlike
// site-utils' siteResolvePassword which only returns the admin
// login password. Falls back to the shared sessionStorage pin /
// prompt (same key as the manus tool) for parity.
function budgetResolvePassword() {
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

function budgetMapError(status) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 413) return 'Filen er for stor. Maks. 5 MB.';
  if (status === 404) return 'Ikke fundet. Genindlæs siden og prøv igen.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, message }.
async function budgetApi(action, body) {
  const password = budgetResolvePassword();
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
  // Require a real {ok:true} JSON body — a PHP fatal error (or a WAF
  // challenge) can come back as HTTP 200 with an HTML body, and must
  // NOT be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    // Surface the server's own error code (e.g. "unknown_action" when the
    // deployed PHP predates a handler) instead of a generic message, so a
    // deploy gap is diagnosable rather than silent.
    const detail = data && typeof data.error === 'string' ? data.error : '';
    const base = budgetMapError(res.status);
    return { ok: false, message: detail ? `${base} (${detail})` : base };
  }
  if (!data || data.ok !== true) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    return { ok: false, message: detail
      ? `Serverfejl: ${detail}`
      : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// Fetches a receipt image (private, password-gated) as an object URL. Reads
// the module-level budgetViewId directly (rather than taking an id
// parameter) since every call site is already inside the admin view, where
// that's always the right budget to target.
async function budgetFetchReceipt(file) {
  const password = budgetResolvePassword();
  if (!password) return null;
  try {
    const res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'budget_receipt', password, file, budgetId: budgetViewId }),
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch (e) {
    return null;
  }
}

// ── Revyst: reimbursement submit form ────────────────────────
function renderRevystForm(root) {
  // Non-blocking: a revyst/boss login already resolved to render this form
  // at all, so this never prompts — it just fills in the year once known.
  budgetApi('budget_active_year_info', {}).then((result) => {
    if (result.ok && result.data) budgetSetPageTitle(result.data.year);
  });

  const card = el('section', 'card budget-form');
  card.appendChild(el('h2', null, 'Indsend et udlæg'));

  const intro = el('p', 'budget-intro',
    'Har du lagt penge ud for revyen? Udfyld formularen, så sender vi pengene retur. '
    + 'Oplysningerne gemmes privat og kan kun ses af koordinatorerne.');
  card.appendChild(intro);

  // Category — loaded async from the server (categories are per-year data
  // now, not a fixed client-side list), same non-blocking pattern as the
  // budget_active_year_info call above. The options array is mutated in
  // place and the dropdown's own value re-set to force a re-render against
  // it, rather than rebuilding the field once the real list arrives.
  const categoryOptions = [{ value: '', label: 'Henter kategorier …' }];
  const categorySelect = siteCreateDropdownField(categoryOptions, '');
  categorySelect.disabled = true;
  card.appendChild(siteEditField('Kategori', categorySelect));
  budgetApi('budget_active_categories', {}).then((result) => {
    categoryOptions.length = 0;
    if (result.ok && result.data && result.data.year == null) {
      // A real, expected state (see budget_set_active_year's "Intet valgt"
      // option) — not a fetch failure, so it gets its own honest message
      // instead of "kunne ikke hente kategorier".
      categoryOptions.push({ value: '', label: 'Intet aktivt budgetår' });
      setMsg('Der er i øjeblikket intet aktivt budgetår — der kan ikke indsendes udlæg lige nu.', 'error');
      submitBtn.disabled = true;
    } else if (result.ok && result.data && Array.isArray(result.data.expense)) {
      categoryOptions.push(
        { value: '', label: 'Vælg kategori …' },
        ...result.data.expense.map((c) => ({ value: c.key, label: c.label }))
      );
      categorySelect.disabled = false;
    } else {
      categoryOptions.push({ value: '', label: 'Kunne ikke hente kategorier' });
      setMsg('Kunne ikke hente kategorier. Genindlæs siden.', 'error');
    }
    categorySelect.value = categorySelect.value; // re-render against the now-real list
  });

  // Amount + date row-ish (amount only for now)
  const amountInput = el('input');
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.placeholder = 'fx 249,50';
  card.appendChild(siteEditField('Beløb (kr)', amountInput));

  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.autocomplete = 'name';
  card.appendChild(siteEditField('Dit navn', nameInput));

  const phoneInput = el('input');
  phoneInput.type = 'tel';
  phoneInput.autocomplete = 'tel';
  phoneInput.placeholder = 'til MobilePay';
  card.appendChild(siteEditField('Telefonnummer', phoneInput));

  const receiptInput = el('input', 'site-file-input');
  receiptInput.type = 'file';
  receiptInput.accept = 'image/*,application/pdf';
  card.appendChild(siteEditField('Kvittering (billede eller PDF)', receiptInput));

  const commentInput = el('textarea');
  commentInput.placeholder = 'valgfrit';
  card.appendChild(siteEditField('Kommentar', commentInput));

  const msg = el('div', 'budget-msg');
  card.appendChild(msg);

  const submitBtn = el('button', 'site-btn-success', 'Send udlæg');
  submitBtn.type = 'button';
  card.appendChild(submitBtn);

  function setMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'budget-msg' + (kind ? ' ' + kind : '');
  }

  submitBtn.addEventListener('click', async () => {
    const category = categorySelect.value;
    const amount = parseAmount(amountInput.value);
    const name = nameInput.value.trim();
    const phone = phoneInput.value.trim();
    const comment = commentInput.value.trim();
    const file = receiptInput.files && receiptInput.files[0];

    if (!category) return setMsg('Vælg en kategori.', 'error');
    if (!(amount > 0)) return setMsg('Angiv et gyldigt beløb.', 'error');
    if (!name) return setMsg('Skriv dit navn.', 'error');
    if (!phone) return setMsg('Skriv dit telefonnummer.', 'error');
    if (!file) return setMsg('Vedhæft en kvittering (billede eller PDF).', 'error');

    submitBtn.disabled = true;
    setMsg('Sender …', null);
    try {
      const { base64: receiptBase64, size, ext: receiptExt } = await receiptToBase64(file);
      if (size > 5 * 1024 * 1024) {
        submitBtn.disabled = false;
        return setMsg('Filen er for stor (maks. 5 MB). Prøv en mindre fil.', 'error');
      }
      const result = await budgetApi('budget_submit', {
        category, amount, name, phone, comment, receiptBase64, receiptExt,
      });
      if (result.ok) {
        categorySelect.value = '';
        amountInput.value = '';
        commentInput.value = '';
        receiptInput.value = '';
        setMsg('Tak! Dit udlæg er sendt til kassereren.', 'ok');
      } else if (result.message) {
        setMsg(result.message, 'error');
      } else {
        setMsg('', null); // cancelled password prompt
      }
    } catch (e) {
      setMsg('Kunne ikke behandle filen. Prøv en anden fil.', 'error');
    }
    submitBtn.disabled = false;
  });

  root.appendChild(card);
}

// Small icon button that fetches a receipt (private, password-gated) lazily
// on click and opens it in a new tab — the same convention as the paid
// ledger's own "Se kvittering" button (.budget-icon-btn/budgetPictureIcon),
// reused here for pending requests too. Works identically for an image or a
// PDF receipt (window.open just displays whatever the browser gets), so
// there's no image-vs-PDF branching needed here unlike the old inline
// thumbnail this replaces.
function budgetReceiptIconBtn(file) {
  const btn = el('button', 'budget-icon-btn');
  btn.type = 'button';
  btn.setAttribute('aria-label', 'Se kvittering');
  btn.appendChild(budgetPictureIcon());
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    const url = await budgetFetchReceipt(file);
    btn.disabled = false;
    if (url) window.open(url, '_blank');
  });
  return btn;
}

// ── Admin: management view ───────────────────────────────────
let budgetState = { requests: [], expenses: [], budget: { planned: {}, income: [] }, categories: { expense: [], income: [] } };
let budgetPaidFilter = 'alle';
let budgetPaidExpanded = false;
const BUDGET_PAID_PAGE_SIZE = 10;

// Which budget the admin view is currently displaying/editing — decoupled
// from which budget is "active" (where new revyst submissions/receipts
// land, see budgetActiveId below): viewing a past budget for corrections
// (e.g. via "Tilføj udgift") must never change where new uploads go. Keyed
// by budgetId (a stable string, e.g. "2026" for a legacy budget or
// "2026_jubilaeum" for one created after multiple budgets per year became
// possible — see server/update-data.php's budget_slugify_budget_id), NOT
// by the plain year number, which is no longer unique. Persisted in
// localStorage so a page refresh keeps showing whatever budget the admin
// last picked in the "Viser budget for" toggle, instead of always
// resetting to the active one — budgetSetViewId() is the only thing that
// should ever assign budgetViewId, so every change stays persisted. Both
// start from whatever's persisted (null if nothing/invalid — the server
// resolves budgetViewId=null to "the active budget", see
// budget_resolve_budget_id in update-data.php — so a first-ever visit
// still shows the active budget without this client needing to already
// know it).
const BUDGET_VIEW_ID_KEY = 'matrevy-budget-view-id';

function budgetLoadPersistedViewId() {
  try {
    const raw = localStorage.getItem(BUDGET_VIEW_ID_KEY);
    return raw ? raw : null;
  } catch (e) {
    return null;
  }
}

function budgetSetViewId(id) {
  budgetViewId = id;
  try {
    if (id == null) localStorage.removeItem(BUDGET_VIEW_ID_KEY);
    else localStorage.setItem(BUDGET_VIEW_ID_KEY, id);
  } catch (e) { /* ignore (private browsing, storage disabled, ...) */ }
}

let budgetViewId = budgetLoadPersistedViewId();
let budgetActiveId = null;
let budgetYearsList = []; // [{budgetId, year, label, createdAt}], from years.json

// ── Stregregnskab (bar tally accounting) — view-mode state ──
// A persisted view-mode flag (mirrors Kalender's own view-toggle
// persistence via localStorage) so a refresh mid-bar-shift doesn't
// silently drop back to the ordinary budget sheet. stregState/
// stregLoadedForBudgetId are the module-level cache for whichever
// budget's tally sheet was last fetched — lazy, only loaded once streg
// mode is actually entered (see loadAndRenderAdmin below), and re-fetched
// whenever budgetViewId has moved on since the last fetch.
const BUDGET_STREG_MODE_KEY = 'matrevy-budget-streg-mode';

function budgetLoadStregMode() {
  try { return localStorage.getItem(BUDGET_STREG_MODE_KEY) === '1'; } catch (e) { return false; }
}

function budgetSetStregMode(on) {
  budgetStregMode = on;
  try {
    if (on) localStorage.setItem(BUDGET_STREG_MODE_KEY, '1');
    else localStorage.removeItem(BUDGET_STREG_MODE_KEY);
  } catch (e) { /* ignore (private browsing, storage disabled, ...) */ }
}

let budgetStregMode = budgetLoadStregMode();
let stregState = null; // {categories, prices, rows, connection, updatedAt, error?}
let stregLoadedForBudgetId; // budgetId stregState was last fetched for

async function stregEnsureLoaded() {
  if (stregLoadedForBudgetId === budgetViewId && stregState) return;
  const result = await budgetApi('streg_read', { budgetId: budgetViewId });
  if (!result.ok) {
    stregState = { categories: [], prices: {}, rows: [], connection: null, error: result.message || 'Kunne ikke hente stregregnskabet.' };
  } else {
    stregState = {
      categories: result.data.categories || [],
      prices: result.data.prices || {},
      rows: result.data.rows || [],
      connection: result.data.connection || null,
      updatedAt: result.data.updatedAt || null,
    };
  }
  stregLoadedForBudgetId = budgetViewId;
}

async function loadAndRenderAdmin(root, { showLoading = true } = {}) {
  // A full reload (year switch, post-save refresh, ...) always lands back
  // in the normal sheet view, never mid-category-edit.
  budgetCategoriesEditMode = false;
  // Same for the stregregnskab grid's own Rediger toggle — a fresh load
  // never opens mid-edit, and any unsaved draft is discarded with it.
  stregSheetEditMode = false;
  stregSheetDraft = null;
  if (showLoading) {
    root.replaceChildren();
    const loading = el('p', 'budget-intro', 'Henter budgetdata …');
    root.appendChild(loading);
  }

  let result = await budgetApi('budget_read', { budgetId: budgetViewId });
  root.replaceChildren();
  if (!result.ok) {
    if (result.message) root.appendChild(el('p', 'budget-msg error', result.message));
    return;
  }
  let data = result.data || {};

  // budget_read's own bootstrap branch (update-data.php) returns
  // budgetId:null whenever there's no active budget and no explicit one
  // was requested — that's ambiguous client-side: it's either a genuinely
  // brand-new deploy (data.years is empty) or the previously-active budget
  // was just deleted while other budgets still exist. In the latter case,
  // re-resolve explicitly against the most recent remaining budget so the
  // admin still lands on real data instead of the empty bootstrap screen.
  if (data.budgetId == null && Array.isArray(data.years) && data.years.length > 0) {
    const fallback = data.years.slice()
      .sort((a, b) => b.year - a.year || String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    result = await budgetApi('budget_read', { budgetId: fallback.budgetId });
    if (!result.ok) {
      if (result.message) root.appendChild(el('p', 'budget-msg error', result.message));
      return;
    }
    data = result.data || {};
  }

  budgetSetViewId(data.budgetId != null ? data.budgetId : budgetViewId);
  // Always trust the server's activeBudgetId, including null — the old
  // "keep the previous value" fallback meant a just-deleted active budget
  // stayed shown as active until the next unrelated reload.
  budgetActiveId = data.activeBudgetId;
  budgetYearsList = Array.isArray(data.years) ? data.years : budgetYearsList;
  budgetSetPageTitle(data.year);

  // True bootstrap: no budget could be resolved at all (data.years empty
  // too — a brand-new deploy). The year toolbar renders full-width,
  // standing in for the whole page, until the admin creates + activates
  // the first budget via it.
  if (data.budgetId == null) {
    renderYearToolbar(root);
    root.appendChild(el('p', 'budget-intro', 'Der er endnu ikke oprettet et budget. Opret det første ovenfor.'));
    return;
  }

  budgetState.requests = (data.requests && data.requests.requests) || [];
  budgetState.expenses = (data.expenses && data.expenses.expenses) || [];
  const b = data.budget || {};
  budgetState.budget = {
    planned: (b.planned && typeof b.planned === 'object') ? b.planned : {},
    income: Array.isArray(b.income) ? b.income : [],
  };
  const cats = data.categories || {};
  budgetState.categories = {
    expense: Array.isArray(cats.expense) ? cats.expense : [],
    income: Array.isArray(cats.income) ? cats.income : [],
  };

  if (budgetStregMode) await stregEnsureLoaded();

  // Budget + right column (the year toolbar above Afventende udlæg) sit
  // side by side (Betalte udgifter is full-width below). In streg mode the
  // Budget card is replaced by the stregregnskab grid, and Afventende
  // udlæg is replaced by the per-category price card — the year toolbar,
  // the Stregregnskab toggle card, and Betalte udgifter never change.
  const cols = el('div', 'budget-columns');
  root.appendChild(cols);
  if (budgetStregMode) renderStregSheetCard(cols);
  else renderBudgetSheet(cols);
  const rightCol = el('div', 'budget-col-right');
  cols.appendChild(rightCol);
  renderYearToolbar(rightCol);
  renderStregToggleCard(rightCol);
  if (budgetStregMode) renderStregPricesCard(rightCol);
  else renderPendingSection(rightCol);
  renderPaidSection(root);
  budgetSyncPendingColumnHeight();
}

// CSS Grid's align-items:stretch only stretches the *shorter* row item up to
// the row's own height — it doesn't cap the *taller* one, so an unbounded
// list on either side would otherwise dictate the whole row's height,
// growing past (and dragging along) the other column instead of scrolling
// internally within it. In normal mode, Budget (bounded by its own category
// count) is the reference and Afventende udlæg's own request list is capped
// to match it via max-height + overflow-y:auto (css/budget.css), since that
// list can be arbitrarily long.
//
// Streg mode doesn't render Budget at all, so it can't use the same
// live reference — and its own content shape (a handful of price rows vs. a
// names list that can run long) naturally sizes to something else entirely,
// which made switching modes visibly resize the whole row. Instead the two
// boxes there "remember" the row height last measured in normal mode
// (budgetCachedRowHeight, persisted so it survives a reload straight into
// streg mode too) and both pin to that fixed value: the grid's own row area
// is capped to it exactly like Afventende udlæg is in normal mode, and
// .budget-col-right gets an explicit min-height so its own (usually
// shorter) content doesn't shrink the row instead. Falls back to the old
// content-derived height only on a brand new browser that has never
// rendered normal mode this budget.
//
// Skipped below the mobile breakpoint, where .budget-columns collapses to
// one stacked column and every card sizes to its own content instead
// (css/budget.css's own mobile block already resets these elements' own
// max-height there, but the inline style set here at a wider viewport would
// otherwise outrank it).
let budgetCachedRowHeight = null;
const BUDGET_ROW_HEIGHT_KEY = 'matrevy-budget-row-height';
try {
  const storedRowHeight = Number(localStorage.getItem(BUDGET_ROW_HEIGHT_KEY));
  if (storedRowHeight > 0) budgetCachedRowHeight = storedRowHeight;
} catch (e) { /* ignore (private browsing, storage disabled, ...) */ }

function budgetSyncPendingColumnHeight() {
  const colRight = document.querySelector('.budget-col-right');
  const sheetCard = document.querySelector('.budget-sheet-card'); // Budget, or the streg grid card
  if (!colRight || !sheetCard) return;
  const mobile = window.innerWidth <= 719;

  if (budgetStregMode) {
    const stregWrap = document.querySelector('.streg-table-wrap');
    if (!stregWrap) return;
    if (mobile) { stregWrap.style.maxHeight = ''; colRight.style.minHeight = ''; return; }
    const cachedHeight = budgetCachedRowHeight != null ? budgetCachedRowHeight : colRight.getBoundingClientRect().height;
    colRight.style.minHeight = cachedHeight + 'px';
    // The cached height is a floor, not a hard pin: colRight's own natural
    // content (year toolbar + toggle + Priser's own category list)
    // can genuinely need more room than a normal-mode budget with few
    // categories ever did — min-height can only stretch colRight up to the
    // cached value, never shrink it back down. Re-measuring after applying
    // it picks up whichever is actually taller, so the grid is always
    // capped to match colRight's real rendered height, not a stale number
    // that would otherwise leave the two boxes visibly mismatched.
    const refHeight = colRight.getBoundingClientRect().height;
    const consumedAbove = stregWrap.getBoundingClientRect().top - sheetCard.getBoundingClientRect().top;
    // Everything below stregWrap within the same card — its own bottom
    // padding, plus the Nulstil/Rediger/Gem bar the grid renders after it
    // (which the main Budget sheet's own scrollWrap never has to account
    // for, since nothing trails Afventende udlæg's list). Measured
    // directly off stregWrap's own current (pre-cap) height rather than
    // just reading padding-bottom, which was an earlier version's bug —
    // that undercounted by exactly the action bar's own height once it was
    // added, consistently overshooting the target.
    const belowWrap = Math.max(
      sheetCard.getBoundingClientRect().height - consumedAbove - stregWrap.getBoundingClientRect().height, 0);
    stregWrap.style.maxHeight = Math.max(refHeight - consumedAbove - belowWrap, 0) + 'px';
    return;
  }

  // Budget (bounded) is the reference; Afventende udlæg's own request list
  // is capped to match it, since that list can be arbitrarily long.
  const scrollWrap = colRight.querySelector(':scope > .card > .budget-scroll-wrap');
  if (!scrollWrap) return;
  if (mobile) { scrollWrap.style.maxHeight = ''; return; }
  const sheetHeight = sheetCard.getBoundingClientRect().height;
  const consumedAbove = scrollWrap.getBoundingClientRect().top - colRight.getBoundingClientRect().top;
  // Same fix as above: the card containing scrollWrap (.budget-col-pending)
  // has its own bottom padding after it, which colRight's total height
  // includes but consumedAbove doesn't capture.
  const parentCard = scrollWrap.parentElement;
  const bottomPadding = parentCard ? (parseFloat(getComputedStyle(parentCard).paddingBottom) || 0) : 0;
  scrollWrap.style.maxHeight = Math.max(sheetHeight - consumedAbove - bottomPadding, 0) + 'px';

  // Remember this for streg mode (see above) — always the last real
  // measurement of normal mode's own natural row height, across budgets.
  budgetCachedRowHeight = sheetHeight;
  try { localStorage.setItem(BUDGET_ROW_HEIGHT_KEY, String(sheetHeight)); } catch (e) { /* ignore */ }
}

window.addEventListener('resize', budgetSyncPendingColumnHeight);
// A first synchronous measurement, taken right after the admin view's DOM is
// built, can land before the browser's text/form-control layout has fully
// settled — even with no custom @font-face, document.fonts.ready still only
// resolves once that has happened, and re-running the sync then is what
// site.js's own siteUpdateHeaderFit relies on for the exact same reason.
// Without this, Afventende udlæg's cap could freeze ~10-20px short of
// Budget's real height until something else (e.g. a window resize)
// happened to recompute it.
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(() => budgetSyncPendingColumnHeight());
}

// ── Admin: year toolbar (switch/rename which budget is shown) ──
function budgetYearLabel(budgetId) {
  const entry = budgetYearsList.find((y) => y.budgetId === budgetId);
  return entry ? entry.label : String(budgetId);
}

function renderYearToolbar(container) {
  const card = el('section', 'card budget-year-toolbar');

  // No budget exists yet at all (brand-new deploy) — nothing to view/switch
  // between; "Skift" below still works, it just opens straight into
  // "create a budget" since budgetYearsList is empty. Deliberately keyed off
  // budgetYearsList, not budgetActiveId — the latter can legitimately be
  // null while budgets still exist (the active one was just deleted), in
  // which case the full toolbar below should render, just showing "Intet
  // valgt" for Aktivt budget rather than collapsing to this reduced view.
  if (budgetYearsList.length === 0) {
    const row = el('div', 'budget-year-btn-row');
    const switchBtn = el('button', 'btn-small', 'Skift');
    switchBtn.type = 'button';
    switchBtn.addEventListener('click', () => openSwitchActiveYearModal(document.getElementById('budget-root')));
    row.appendChild(switchBtn);
    card.appendChild(row);
    container.appendChild(card);
    return;
  }

  const row = el('div', 'budget-year-row');

  const viewWrap = el('div', 'budget-year-field');
  viewWrap.appendChild(el('label', null, 'Viser budget for:'));
  const yearOptions = budgetYearsList
    .slice()
    .sort((a, b) => b.year - a.year || String(b.createdAt).localeCompare(String(a.createdAt)))
    .map((y) => ({ value: y.budgetId, label: y.label }));
  const yearSelect = siteCreateDropdownField(yearOptions, budgetViewId);
  yearSelect.addEventListener('change', () => {
    const id = yearSelect.value;
    if (id && id !== budgetViewId) {
      budgetSetViewId(id);
      loadAndRenderAdmin(document.getElementById('budget-root'));
    }
  });
  viewWrap.appendChild(yearSelect);
  row.appendChild(viewWrap);

  const activeWrap = el('div', 'budget-year-field');
  activeWrap.appendChild(el('span', 'budget-year-active-label', 'Aktivt budget:'));
  const activeLabel = budgetActiveId != null ? budgetYearLabel(budgetActiveId) : 'Intet valgt';
  activeWrap.appendChild(el('span', 'budget-year-active-value', activeLabel));
  row.appendChild(activeWrap);

  card.appendChild(row);

  const btnRow = el('div', 'budget-year-btn-row');
  const renameBtn = el('button', 'btn-small', 'Omdøb');
  renameBtn.type = 'button';
  renameBtn.addEventListener('click', () => openRenameYearModal(document.getElementById('budget-root')));
  btnRow.appendChild(renameBtn);

  const switchBtn = el('button', 'btn-small', 'Skift');
  switchBtn.type = 'button';
  switchBtn.addEventListener('click', () => openSwitchActiveYearModal(document.getElementById('budget-root')));
  btnRow.appendChild(switchBtn);
  card.appendChild(btnRow);

  container.appendChild(card);
}

// Changes which budget is active (where new revyst uploads/receipts land) —
// either by picking an existing budget (budget_set_active_year), creating
// and immediately activating a brand new one (budget_create_year then
// budget_set_active_year, the same two-call sequence the old standalone
// "Start nyt budgetår" modal used), or deliberately clearing it (also
// budget_set_active_year, with budgetId:null) via the dropdown's own
// trailing "Intet valgt" option — blocks revyst submissions without
// deleting or hiding anything; every budget, including whichever was just
// cleared, stays fully browsable via the "Viser budget for" dropdown. The
// confirm button reads "Vælg" or "Opret" depending on which path is
// currently shown; the dropdown's own "+ Tilføj" option (listed first)
// switches the modal into the create path, and when no budget exists yet
// at all the create fields are the only thing shown (there's nothing to
// clear either, in that case).
function openSwitchActiveYearModal(root) {
  const hasYears = budgetYearsList.length > 0;
  const NEW_YEAR_VALUE = '__new__';
  const NONE_YEAR_VALUE = '__none__';
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Skift aktivt budget');
  modal.classList.add('budget-approve-modal');

  let yearSelect = null;
  const newYearFields = el('div');
  const yearInput = el('input');
  yearInput.type = 'number';
  yearInput.min = '2000';
  yearInput.max = '2100';
  const activeEntry = budgetActiveId != null ? budgetYearsList.find((y) => y.budgetId === budgetActiveId) : null;
  yearInput.value = String(activeEntry ? activeEntry.year + 1 : new Date().getFullYear());

  const labelInput = el('input');
  labelInput.type = 'text';
  labelInput.value = `MatRevy ${yearInput.value}`;

  const newYearFieldRow = el('div');
  newYearFieldRow.className = 'edit-field-row';
  newYearFieldRow.appendChild(siteEditField('Label', labelInput));
  newYearFieldRow.appendChild(siteEditField('Årstal', yearInput));
  newYearFields.appendChild(newYearFieldRow);

  function isCreatingNew() {
    return !hasYears || yearSelect.value === NEW_YEAR_VALUE;
  }

  function updateNewYearFieldsVisibility() {
    const showNewFields = isCreatingNew();
    newYearFields.style.display = showNewFields ? '' : 'none';
    confirmBtn.textContent = showNewFields ? 'Opret' : 'Vælg';
  }

  if (hasYears) {
    form.appendChild(el('p', 'budget-intro',
      'Vælg et eksisterende budget, eller opret et nyt.'));
    const yearOptions = [{ value: NEW_YEAR_VALUE, label: '+ Tilføj' }];
    yearOptions.push(...budgetYearsList
      .slice()
      .sort((a, b) => b.year - a.year || String(b.createdAt).localeCompare(String(a.createdAt)))
      .map((y) => ({ value: y.budgetId, label: y.label })));
    yearOptions.push({ value: NONE_YEAR_VALUE, label: 'Intet valgt' });
    const defaultValue = budgetActiveId != null ? budgetActiveId : NONE_YEAR_VALUE;
    yearSelect = siteCreateDropdownField(yearOptions, defaultValue);
    yearSelect.addEventListener('change', updateNewYearFieldsVisibility);
    form.appendChild(siteEditField('Aktivt budget', yearSelect));
  } else {
    form.appendChild(el('p', 'budget-intro',
      'Opretter et nyt, tomt budget og gør det til det aktive år, som nye udlæg fra revyster sendes ind til.'));
  }

  form.appendChild(newYearFields);

  const confirmBtn = budgetPillBtn('Vælg', 'site-btn-success');
  updateNewYearFieldsVisibility();
  confirmBtn.addEventListener('click', async () => {
    const creatingNew = isCreatingNew();
    error.textContent = '';

    if (creatingNew) {
      const year = Number(yearInput.value);
      const label = labelInput.value.trim();
      if (!Number.isInteger(year) || year < 2000 || year > 2100) { error.textContent = 'Angiv et gyldigt årstal.'; return; }
      if (!label) { error.textContent = 'Angiv en label.'; return; }
      confirmBtn.disabled = true;
      const createResult = await budgetApi('budget_create_year', { year, label });
      if (!createResult.ok) {
        confirmBtn.disabled = false;
        if (createResult.message) error.textContent = createResult.message;
        return;
      }
      const newBudgetId = createResult.data.budgetId;
      const activateResult = await budgetApi('budget_set_active_year', { budgetId: newBudgetId });
      if (!activateResult.ok) {
        confirmBtn.disabled = false;
        if (activateResult.message) error.textContent = activateResult.message;
        return;
      }
      budgetSetViewId(newBudgetId);
      close();
      loadAndRenderAdmin(root);
      return;
    }

    if (yearSelect.value === NONE_YEAR_VALUE) {
      confirmBtn.disabled = true;
      // If the view was only ever implicitly tracking "whatever's active"
      // (budgetViewId null), pin it to that budget explicitly before
      // clearing active — otherwise the next load re-resolves budgetId:null
      // against the now-inactive state and loadAndRenderAdmin's
      // deleted-budget fallback silently jumps the view to the newest
      // budget instead of staying put.
      if (budgetViewId == null && budgetActiveId != null) budgetSetViewId(budgetActiveId);
      const result = await budgetApi('budget_set_active_year', { budgetId: null });
      if (result.ok) {
        close();
        loadAndRenderAdmin(root);
      } else {
        confirmBtn.disabled = false;
        if (result.message) error.textContent = result.message;
      }
      return;
    }

    const id = yearSelect.value;
    if (!id) { error.textContent = 'Vælg et budget.'; return; }
    confirmBtn.disabled = true;
    const result = await budgetApi('budget_set_active_year', { budgetId: id });
    if (result.ok) {
      budgetSetViewId(id);
      close();
      loadAndRenderAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(confirmBtn);
}

// Renames/relabels the currently-*viewed* budget (budgetViewId) — every
// existing request/expense/receipt for that budget carries over unchanged,
// since renaming is now a pure metadata edit (budgetId is the stable
// storage key, fully decoupled from year/label), not a directory move.
// Useful for correcting a mistaken year number/label without losing real
// data (e.g. test data accidentally created under the wrong year).
function openRenameYearModal(root) {
  const id = budgetViewId;
  const entry = budgetYearsList.find((y) => y.budgetId === id);
  const currentYear = entry ? entry.year : null;
  const { modal, form, error, actions, close } = siteOpenModalWithClose(
    `Omdøb det viste budget ("${budgetYearLabel(id)}", ${currentYear})`);
  modal.classList.add('budget-approve-modal');

  form.appendChild(el('p', 'budget-intro',
    'Alle data (planlagte beløb, udlæg, kvitteringer) følger med uændret.'));

  const yearInput = el('input');
  yearInput.type = 'number';
  yearInput.min = '2000';
  yearInput.max = '2100';
  yearInput.value = String(currentYear);

  const labelInput = el('input');
  labelInput.type = 'text';
  labelInput.value = budgetYearLabel(id);

  const fieldRow = el('div');
  fieldRow.className = 'edit-field-row';
  fieldRow.appendChild(siteEditField('Ny label', labelInput));
  fieldRow.appendChild(siteEditField('Nyt årstal', yearInput));
  form.appendChild(fieldRow);

  const confirmBtn = budgetPillBtn('Omdøb', 'site-btn-warm');
  confirmBtn.addEventListener('click', async () => {
    const newYear = Number(yearInput.value);
    const newLabel = labelInput.value.trim();
    if (!Number.isInteger(newYear) || newYear < 2000 || newYear > 2100) { error.textContent = 'Angiv et gyldigt årstal.'; return; }
    if (!newLabel) { error.textContent = 'Angiv en label.'; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_rename_year', { budgetId: id, year: newYear, label: newLabel });
    if (result.ok) {
      // budgetId never changes on rename, so budgetViewId is already
      // correct — no need to reassign it.
      close();
      loadAndRenderAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(confirmBtn);
}

// ── Admin: delete an entire budget (irreversible) ────────
// Two-step confirmation per explicit request: step 1 spells out exactly
// what's about to be lost (and flags it more strongly if it's the active
// budget), step 2 is a plain final "are you sure?" — mirrors the shared
// narrow-confirm style already used for openExpenseDeleteConfirm/
// openExpenseRemoveConfirm, just chained twice.
function openDeleteYearWarning(root) {
  const id = budgetViewId;
  const entry = budgetYearsList.find((y) => y.budgetId === id);
  const year = entry ? entry.year : null;
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Slet budget');
  modal.classList.add('budget-confirm-modal');

  let text = `Dette sletter budgettet "${budgetYearLabel(id)}" (${year}) permanent: alle planlagte beløb, ` +
    'afventende udlæg, betalte udgifter og kvitteringsbilleder for dette budget går tabt og kan ikke gendannes.';
  if (id === budgetActiveId) {
    text += ' Dette er det AKTIVE budget; slettes det, kan revyster ikke indsende udlæg, før et nyt budget oprettes og aktiveres.';
  }
  form.appendChild(el('p', 'budget-intro', text));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const continueBtn = budgetPillBtn('Fortsæt', 'site-btn-danger');
  continueBtn.addEventListener('click', () => {
    close();
    openDeleteYearConfirm(root, id);
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(continueBtn);
}

function openDeleteYearConfirm(root, id) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('budget-confirm-narrow');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  form.appendChild(el('p', 'budget-confirm-text', 'Er du sikker?'));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = budgetPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_delete_year', { budgetId: id });
    if (result.ok) {
      close();
      // Let the next load resolve to whatever's active — or, if the budget
      // just deleted was itself active, loadAndRenderAdmin's own fallback
      // picks the most recent remaining budget (or the bootstrap state, if
      // that was the last one left).
      budgetSetViewId(null);
      loadAndRenderAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Re-read + re-render after a mutation. Any unsaved budget-sheet edits are
// flushed first so a reload triggered by an expense/request action doesn't
// discard the planned/income numbers the admin was in the middle of typing.
async function reloadAdmin(root) {
  await saveBudgetSheetIfDirty();
  // Skip the "Henter budgetdata …" loading placeholder here: showing it would
  // briefly empty #budget-root while the re-fetch is in flight, shrinking the
  // page and making the browser scroll back to the top, then jump back down
  // once the real content lands — a visible flash on every gendan/slet.
  // Leaving the (still-current) old content in place until the new content
  // is ready to swap in synchronously avoids that entirely; the scrollTo
  // below is just a defensive fallback in case the new content is shorter.
  const scrollY = window.scrollY;
  await loadAndRenderAdmin(root, { showLoading: false });
  window.scrollTo(0, scrollY);
}

// ── Budget sheet (planned per category + income; spent/balance derived) ──
// `budgetSheet` holds live references to the current sheet's DOM so autosave
// and the totals recompute can read/update it without a full re-render.
let budgetSheet = null;
let budgetSheetSnapshot = null;
let budgetSheetTimersReady = false;
// Toggled by the sheet's own Rediger/Annuller button — see buildBudgetSheetCard.
let budgetCategoriesEditMode = false;

function computeSpentByCategory() {
  const map = {};
  budgetState.expenses.forEach((e) => {
    if (e.deleted) return;
    const k = e.category;
    map[k] = (map[k] || 0) + (Number(e.amount) || 0);
  });
  return map;
}

// Snapshot-diff dirty check (mirrors manus.js's manusIsDirty/manusLastSavedSnapshot
// pattern) rather than a one-way flag, so manually reverting a typed value back to
// its last-saved amount flips the status back to "Gemt" instead of staying dirty.
function budgetIsSheetDirty() {
  // No live planned/income-amount inputs exist while structurally editing
  // categories (Planlagt is replaced by Bilagskode, income amounts go
  // read-only) — autosave/beforeunload simply have nothing to track then.
  if (budgetCategoriesEditMode) return false;
  return !!budgetSheet && JSON.stringify(collectSheetPayload()) !== budgetSheetSnapshot;
}

function budgetRefreshSheetStatus() {
  if (!budgetSheet) return;
  const dirty = budgetIsSheetDirty();
  budgetSheet.status.textContent = dirty ? 'Ikke gemt' : 'Gemt';
  budgetSheet.status.className = dirty ? 'budget-save-status dirty' : 'budget-save-status';
}

function nowHhmm() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function renderBudgetSheet(container) {
  const card = buildBudgetSheetCard();
  container.appendChild(card);
  ensureBudgetSheetTimers(container);
}

// Builds the whole Budget card, in one of two modes:
// - Normal: Kategori (static) / Planlagt (editable) / Brugt / Rest, income
//   rows with an editable amount — the routine day-to-day sheet.
// - budgetCategoriesEditMode: Kategori (editable) / Bilagskode (editable,
//   locked once a paid expense exists under that key) / Brugt / delete "✕",
//   draggable rows, plus an add-row; income rows go name-editable + a
//   read-only amount + delete. Toggled by the Rediger/Annuller button — a
//   pure client-side re-render (card.replaceWith), no server round trip
//   just to flip the mode. "Gem" is dual-purpose: it saves the sheet
//   (budget_save_sheet) in normal mode, or the category draft
//   (budget_categories_save) in edit mode.
function buildBudgetSheetCard() {
  const card = el('section', 'card budget-sheet-card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Budget'));
  const status = el('span', 'budget-save-status', 'Gemt');
  head.appendChild(status);
  card.appendChild(head);

  let categoryDrafts = null;
  if (budgetCategoriesEditMode) {
    budgetSheet = null;
    categoryDrafts = buildCategoryEditSection(card, status);
  } else {
    const refs = buildNormalSheetSection(card);
    budgetSheet = { ...refs, status };
  }

  const saveBar = el('div', 'budget-save-bar');
  const deleteYearBtn = el('button', 'site-btn-danger', 'Slet');
  deleteYearBtn.type = 'button';
  deleteYearBtn.addEventListener('click', () => openDeleteYearWarning(document.getElementById('budget-root')));
  saveBar.appendChild(deleteYearBtn);

  const editBudgetBtn = el('button', 'site-btn-warm budget-edit-btn', budgetCategoriesEditMode ? 'Annuller' : 'Rediger');
  editBudgetBtn.type = 'button';
  editBudgetBtn.addEventListener('click', () => {
    // Toggling off with unsaved edits simply discards them — the draft
    // lives only inside this card's closure, so a fresh render pulls
    // straight from budgetState.categories again.
    budgetCategoriesEditMode = !budgetCategoriesEditMode;
    const newCard = buildBudgetSheetCard();
    card.replaceWith(newCard);
    // The card's own height just changed (Rediger mode's row count/shape
    // differs from the normal sheet's) — resync Afventende udlæg's capped
    // height (see budgetSyncPendingColumnHeight) so it doesn't keep
    // whatever height matched the pre-toggle card.
    budgetSyncPendingColumnHeight();
  });
  saveBar.appendChild(editBudgetBtn);

  const saveBtn = el('button', 'site-btn-success', 'Gem');
  saveBtn.type = 'button';
  if (budgetCategoriesEditMode) {
    saveBtn.addEventListener('click', () => saveCategoryEdits(saveBtn, status, categoryDrafts));
  } else {
    budgetSheet.saveBtn = saveBtn;
    saveBtn.addEventListener('click', () => saveBudgetSheet());
  }
  saveBar.appendChild(saveBtn);
  card.appendChild(saveBar);

  if (!budgetCategoriesEditMode) {
    budgetSheetSnapshot = JSON.stringify(collectSheetPayload());
    updateSheetTotals();
  }

  return card;
}

// Normal-mode content (table + income list + net row). Returns the DOM refs
// budgetSheet needs for live totals/dirty-tracking.
function buildNormalSheetSection(card) {
  const spent = computeSpentByCategory();
  const plannedInputs = {};
  const restCells = {};

  const tableWrap = el('div', 'budget-table-wrap');
  const table = el('table', 'budget-table budget-sheet-table');
  const thead = el('thead');
  const htr = el('tr');
  ['Kategori', 'Planlagt', 'Brugt', 'Rest'].forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  budgetState.categories.expense.forEach((c) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, c.label));

    const pTd = el('td', 'budget-td-num');
    const inp = el('input', 'budget-plan-input');
    inp.type = 'text';
    inp.inputMode = 'decimal';
    inp.placeholder = '0';
    const pv = budgetState.budget.planned[c.key];
    if (pv != null && pv !== '') inp.value = String(pv).replace('.', ',');
    inp.addEventListener('input', () => { budgetRefreshSheetStatus(); updateSheetTotals(); });
    plannedInputs[c.key] = inp;
    pTd.appendChild(inp);
    tr.appendChild(pTd);

    tr.appendChild(el('td', 'budget-td-num budget-brugt-cell', formatKr(spent[c.key] || 0)));

    const rTd = el('td', 'budget-td-num budget-rest-cell');
    restCells[c.key] = rTd;
    tr.appendChild(rTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);

  const tfoot = el('tfoot');
  const ftr = el('tr', 'budget-sheet-total');
  ftr.appendChild(el('td', null, 'I alt'));
  const totalPlannedCell = el('td', 'budget-td-num');
  const totalBrugtCell = el('td', 'budget-td-num');
  const totalRestCell = el('td', 'budget-td-num');
  ftr.appendChild(totalPlannedCell);
  ftr.appendChild(totalBrugtCell);
  ftr.appendChild(totalRestCell);
  tfoot.appendChild(ftr);
  table.appendChild(tfoot);

  tableWrap.appendChild(table);
  card.appendChild(tableWrap);

  const incomeHead = el('div', 'budget-subhead');
  incomeHead.appendChild(el('h3', null, 'Indtægter'));
  const incomeTotalCell = el('span', 'budget-amount', formatKr(0));
  incomeHead.appendChild(incomeTotalCell);
  card.appendChild(incomeHead);

  const incomeList = el('div', 'budget-income-list');
  card.appendChild(incomeList);

  const incomeRows = [];
  const storedIncome = budgetState.budget.income || [];
  budgetState.categories.income.forEach((def) => {
    // `x.id` fallback: pre-existing stored rows from before categories
    // became per-year data used `id` (always 'billetsalg'/'andet') with no
    // `key` — the lazy-seeded default categories reuse those exact strings
    // as their keys, so this always resolves correctly with no migration.
    const stored = storedIncome.find((x) => x && (x.key === def.key || x.id === def.key)) || {};
    incomeList.appendChild(buildIncomeRow(def, stored, incomeRows));
  });

  const netRow = el('div', 'budget-net-row');
  netRow.appendChild(el('span', null, 'Resultat (indtægter − brugt)'));
  const netCell = el('span', 'budget-net-value');
  netRow.appendChild(netCell);
  card.appendChild(netRow);

  return {
    plannedInputs, restCells, spent, incomeList, incomeRows,
    totalPlannedCell, totalBrugtCell, totalRestCell, incomeTotalCell, netCell,
  };
}

function buildIncomeRow(def, stored, incomeRows) {
  const row = el('div', 'budget-income-row');
  row.appendChild(el('span', 'budget-income-name', def.label));

  const amountInput = el('input', 'budget-income-amount');
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.placeholder = '0';
  const amt = stored.amount;
  if (amt != null && amt !== '') amountInput.value = String(amt).replace('.', ',');
  amountInput.addEventListener('input', () => { budgetRefreshSheetStatus(); updateSheetTotals(); });
  row.appendChild(amountInput);

  incomeRows.push({ key: def.key, amountInput });
  return row;
}

function updateSheetTotals() {
  if (!budgetSheet) return;
  let totalPlanned = 0;
  let totalBrugt = 0;
  budgetState.categories.expense.forEach((c) => {
    const planned = parseAmount(budgetSheet.plannedInputs[c.key].value) || 0;
    const brugt = budgetSheet.spent[c.key] || 0;
    const rest = planned - brugt;
    totalPlanned += planned;
    totalBrugt += brugt;
    const cell = budgetSheet.restCells[c.key];
    cell.textContent = formatKr(rest);
    cell.classList.toggle('budget-negative', rest < 0);
  });
  budgetSheet.totalPlannedCell.textContent = formatKr(totalPlanned);
  budgetSheet.totalBrugtCell.textContent = formatKr(totalBrugt);
  budgetSheet.totalRestCell.textContent = formatKr(totalPlanned - totalBrugt);
  budgetSheet.totalRestCell.classList.toggle('budget-negative', totalPlanned - totalBrugt < 0);

  let totalIncome = 0;
  budgetSheet.incomeRows.forEach((r) => { totalIncome += parseAmount(r.amountInput.value) || 0; });
  budgetSheet.incomeTotalCell.textContent = formatKr(totalIncome);
  const net = totalIncome - totalBrugt;
  budgetSheet.netCell.textContent = formatKr(net);
  budgetSheet.netCell.classList.toggle('budget-negative', net < 0);
}

// Collect the current sheet values into the payload shape.
function collectSheetPayload() {
  const planned = {};
  budgetState.categories.expense.forEach((c) => {
    const raw = budgetSheet.plannedInputs[c.key].value.trim();
    if (raw !== '') {
      const v = parseAmount(raw);
      if (Number.isFinite(v) && v >= 0) planned[c.key] = v;
    }
  });
  const income = budgetSheet.incomeRows.map((r) => {
    const amount = parseAmount(r.amountInput.value);
    return { key: r.key, amount: Number.isFinite(amount) && amount >= 0 ? amount : 0 };
  });
  return { planned, income, budgetId: budgetViewId };
}

async function saveBudgetSheet() {
  if (!budgetSheet) return { ok: false };
  const payload = collectSheetPayload();
  // Disable immediately so the click reads as registered right away — same
  // instant feedback as Manus's Gem button (manusSaveMain) disabling itself
  // for the duration of its own save.
  if (budgetSheet.saveBtn) budgetSheet.saveBtn.disabled = true;
  budgetSheet.status.textContent = 'Gemmer …';
  budgetSheet.status.className = 'budget-save-status';
  const result = await budgetApi('budget_save_sheet', payload);
  if (budgetSheet.saveBtn) budgetSheet.saveBtn.disabled = false;
  if (result.ok) {
    budgetSheetSnapshot = JSON.stringify(payload);
    budgetState.budget = { planned: payload.planned, income: payload.income };
    budgetSheet.status.textContent = 'Gemt kl. ' + nowHhmm();
    budgetSheet.status.className = 'budget-save-status';
    // Same bottom-of-page confirmation banner as Manus's "Manus gemt" toast.
    siteShowToast('Budget gemt');
  } else if (result.message) {
    budgetSheet.status.textContent = result.message;
    budgetSheet.status.className = 'budget-save-status error';
  } else {
    // Cancelled password prompt — leave dirty, no scary message.
    budgetSheet.status.textContent = 'Ikke gemt';
    budgetSheet.status.className = 'budget-save-status dirty';
  }
  return result;
}

async function saveBudgetSheetIfDirty() {
  if (budgetSheet && budgetIsSheetDirty()) await saveBudgetSheet();
}

// Register the 15-minute autosave interval and the unsaved-changes guard once.
function ensureBudgetSheetTimers(root) {
  if (budgetSheetTimersReady) return;
  budgetSheetTimersReady = true;
  setInterval(() => { if (budgetIsSheetDirty()) saveBudgetSheet(); }, 15 * 60 * 1000);
  window.addEventListener('beforeunload', (e) => {
    if (budgetIsSheetDirty()) { e.preventDefault(); e.returnValue = ''; }
  });
}

// Mirrors wiki.js's wikiWireDropHighlight / manus.js's wireDropHighlight —
// duplicated here per the site's per-page convention (see CLAUDE.md):
// counting dragenter/dragleave pairs (rather than toggling straight off
// dragover/dragleave) avoids the highlight flickering as the pointer
// crosses child element boundaries.
function budgetWireDropHighlight(rowEl, onDrop) {
  let depth = 0;
  rowEl.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    rowEl.classList.add('budget-drop-target');
  });
  rowEl.addEventListener('dragover', (e) => { e.preventDefault(); }); // required for 'drop' to fire
  rowEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (depth === 0) rowEl.classList.remove('budget-drop-target');
  });
  rowEl.addEventListener('drop', (e) => {
    e.preventDefault();
    depth = 0;
    rowEl.classList.remove('budget-drop-target');
    onDrop();
  });
}

// Splices `item` out of `draft` and reinserts it just before `beforeItem`
// (or at the end if `beforeItem` is falsy) — mirrors wiki.js's
// moveDraftItem/manus.js's manusMoveRow, adapted to array-of-objects
// identity instead of an id lookup since a brand-new draft row has no key
// yet to look up by.
function budgetMoveDraftItem(draft, item, beforeItem, rerender) {
  const idx = draft.indexOf(item);
  if (idx === -1) return;
  draft.splice(idx, 1);
  const beforeIdx = beforeItem ? draft.indexOf(beforeItem) : -1;
  if (beforeIdx === -1) draft.push(item);
  else draft.splice(beforeIdx, 0, item);
  rerender();
}

// ── Admin: category structure editing (Rediger toggle on the sheet) ──────
// Turns the Budget card into an editable form in place, deliberately kept as
// close to the normal-mode layout as possible — the same Kategori/
// Bilagslabel(/Planlagt)/Brugt/Rest columns, at the same widths, text edited
// in place rather than via a separate form. Kategori becomes name-editable,
// Planlagt is replaced by an editable Bilagslabel (receipt-shortening)
// column locked once a paid expense exists under that key, Rest is shown
// read-only (against the last-saved Planlagt figure, since Planlagt itself
// isn't editable here), and a trailing 5th column holds a "✕" that deletes
// a row — blocked (via the same bottom banner used site-wide,
// siteShowToast) under the identical "already in use" condition as the
// Bilagslabel lock. Rows are draggable to reorder (mirrors Aktfordeling's
// drag-and-drop in manus.js) via the row itself, not a dedicated handle
// column. Indtægter rows get the same name-editable + delete treatment, with
// amount shown read-only (structure editing only — amounts stay editable in
// the normal view) and deletion blocked whenever an amount is already on
// record. Both lists grow via a small "+" below the last row rather than a
// separate add-row form, seeding a fresh row with placeholder-ish default
// text ("name"/"bilag") ready to be typed over.
function buildCategoryEditSection(card, status) {
  const draftExpense = budgetState.categories.expense.map((c) => ({ ...c }));
  const draftIncome = budgetState.categories.income.map((c) => ({ ...c }));
  const spent = computeSpentByCategory();
  const planned = budgetState.budget.planned || {};
  const storedIncome = budgetState.budget.income || [];

  // Keys with ≥1 non-deleted paid expense in this year — the single
  // condition shared by both the Bilagslabel lock and the delete block.
  const paidCategoryKeys = new Set(
    budgetState.expenses.filter((e) => !e.deleted).map((e) => e.category)
  );

  // Lowercase, not uppercase — this is what actually ends up written on a
  // receipt, per explicit design feedback.
  function sanitizeAbbrev(raw) {
    return String(raw || '').toLowerCase().replace(/[^a-z0-9_]/g, '').slice(0, 20);
  }

  // Focuses and selects the name field of the just-added last row, so typing
  // immediately overwrites the "name"/"bilag" default text.
  function focusLastRowInput(container, selector) {
    const input = container.lastElementChild && container.lastElementChild.querySelector(selector);
    if (input) { input.focus(); input.select(); }
  }

  // Snapshot-diff dirty check against the categories as they were when this
  // section was opened (mirrors budgetIsSheetDirty's approach for the
  // normal-mode sheet) — called after every draft mutation (typing,
  // add/remove, drag reorder) so the Gemt/Ikke-gemt flag in the card head
  // actually tracks category edits instead of just sitting on whatever it
  // said before Rediger was opened.
  const categorySnapshot = JSON.stringify({
    expense: budgetState.categories.expense,
    income: budgetState.categories.income,
  });
  function refreshCategoryDirtyStatus() {
    const dirty = JSON.stringify({ expense: draftExpense, income: draftIncome }) !== categorySnapshot;
    status.textContent = dirty ? 'Ikke gemt' : 'Gemt';
    status.className = dirty ? 'budget-save-status dirty' : 'budget-save-status';
  }

  const tableWrap = el('div', 'budget-table-wrap');
  const table = el('table', 'budget-table budget-sheet-table-editing');
  const thead = el('thead');
  const htr = el('tr');
  ['Kategori', 'Bilagslabel', 'Brugt', 'Rest', ''].forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr);
  table.appendChild(thead);
  const tbody = el('tbody');
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  card.appendChild(tableWrap);

  let dragItem = null;

  function renderExpenseRows() {
    tbody.textContent = '';
    draftExpense.forEach((item) => {
      const tr = el('tr', 'budget-manage-tr');
      tr.draggable = true;
      tr.addEventListener('dragstart', (e) => {
        dragItem = item;
        e.dataTransfer.effectAllowed = 'move';
      });
      tr.addEventListener('dragend', () => tr.classList.remove('budget-drop-target'));
      budgetWireDropHighlight(tr, () => {
        if (dragItem && dragItem !== item) {
          budgetMoveDraftItem(draftExpense, dragItem, item, renderExpenseRows);
          refreshCategoryDirtyStatus();
          budgetSyncPendingColumnHeight();
        }
      });

      const nameTd = el('td');
      const nameInput = el('input', 'budget-manage-text-input');
      nameInput.type = 'text';
      nameInput.value = item.label;
      nameInput.addEventListener('input', () => { item.label = nameInput.value; refreshCategoryDirtyStatus(); });
      nameTd.appendChild(nameInput);
      tr.appendChild(nameTd);

      const bilagTd = el('td');
      const bilagInput = el('input', 'budget-manage-text-input budget-manage-bilag-input');
      bilagInput.type = 'text';
      bilagInput.maxLength = 20;
      bilagInput.value = item.abbrev;
      const locked = !!item.key && paidCategoryKeys.has(item.key);
      if (locked) {
        bilagInput.readOnly = true;
        bilagInput.classList.add('budget-manage-input-locked');
        bilagInput.title = 'Låst — der findes allerede en betalt udgift i denne kategori';
        bilagInput.addEventListener('click', () => {
          siteShowToast('Kan ikke ændre bilagslabel — der findes allerede en betalt udgift i denne kategori.');
        });
      } else {
        bilagInput.addEventListener('input', () => {
          bilagInput.value = sanitizeAbbrev(bilagInput.value);
          item.abbrev = bilagInput.value;
          refreshCategoryDirtyStatus();
        });
      }
      bilagTd.appendChild(bilagInput);
      tr.appendChild(bilagTd);

      const brugtVal = (item.key && spent[item.key]) || 0;
      tr.appendChild(el('td', 'budget-td-num budget-brugt-cell', formatKr(brugtVal)));

      const plannedVal = (item.key && planned[item.key]) || 0;
      const restVal = plannedVal - brugtVal;
      const restTd = el('td', 'budget-td-num', formatKr(restVal));
      restTd.classList.toggle('budget-negative', restVal < 0);
      tr.appendChild(restTd);

      const removeTd = el('td', 'budget-td-remove');
      const removeBtn = el('button', 'budget-manage-remove-btn', '✕');
      removeBtn.type = 'button';
      removeBtn.title = 'Fjern kategori';
      removeBtn.addEventListener('click', () => {
        if (item.key && paidCategoryKeys.has(item.key)) {
          siteShowToast('Kan ikke slette kategori — der findes allerede en betalt udgift i denne kategori.');
          return;
        }
        const idx = draftExpense.indexOf(item);
        if (idx !== -1) draftExpense.splice(idx, 1);
        renderExpenseRows();
        refreshCategoryDirtyStatus();
        budgetSyncPendingColumnHeight();
      });
      removeTd.appendChild(removeBtn);
      tr.appendChild(removeTd);

      tbody.appendChild(tr);
    });
  }
  renderExpenseRows();

  const expenseAddBtn = el('button', 'budget-manage-add-plus', '+');
  expenseAddBtn.type = 'button';
  expenseAddBtn.title = 'Tilføj kategori';
  expenseAddBtn.addEventListener('click', () => {
    draftExpense.push({ key: null, label: 'name', abbrev: sanitizeAbbrev('bilag') });
    renderExpenseRows();
    refreshCategoryDirtyStatus();
    budgetSyncPendingColumnHeight();
    focusLastRowInput(tbody, '.budget-manage-text-input');
  });
  card.appendChild(expenseAddBtn);

  const incomeHead = el('div', 'budget-subhead');
  incomeHead.appendChild(el('h3', null, 'Indtægter'));
  card.appendChild(incomeHead);

  const incomeList = el('div', 'budget-income-list');
  card.appendChild(incomeList);

  function renderIncomeRows() {
    incomeList.textContent = '';
    draftIncome.forEach((item) => {
      const row = el('div', 'budget-manage-row');

      const nameInput = el('input', 'budget-manage-text-input');
      nameInput.type = 'text';
      nameInput.value = item.label;
      nameInput.addEventListener('input', () => { item.label = nameInput.value; refreshCategoryDirtyStatus(); });
      row.appendChild(nameInput);

      const stored = item.key ? storedIncome.find((x) => x && (x.key === item.key || x.id === item.key)) : null;
      const amount = stored && stored.amount != null ? Number(stored.amount) || 0 : 0;
      row.appendChild(el('span', 'budget-income-amount-readonly', formatKr(amount)));

      const removeBtn = el('button', 'budget-manage-remove-btn', '✕');
      removeBtn.type = 'button';
      removeBtn.title = 'Fjern indtægt';
      removeBtn.addEventListener('click', () => {
        if (amount) {
          siteShowToast('Kan ikke slette indtægt — der er allerede angivet et beløb.');
          return;
        }
        const idx = draftIncome.indexOf(item);
        if (idx !== -1) draftIncome.splice(idx, 1);
        renderIncomeRows();
        refreshCategoryDirtyStatus();
        budgetSyncPendingColumnHeight();
      });
      row.appendChild(removeBtn);

      incomeList.appendChild(row);
    });
  }
  renderIncomeRows();

  const incomeAddBtn = el('button', 'budget-manage-add-plus', '+');
  incomeAddBtn.type = 'button';
  incomeAddBtn.title = 'Tilføj indtægt';
  incomeAddBtn.addEventListener('click', () => {
    draftIncome.push({ key: null, label: 'name' });
    renderIncomeRows();
    refreshCategoryDirtyStatus();
    budgetSyncPendingColumnHeight();
    focusLastRowInput(incomeList, '.budget-manage-text-input');
  });
  card.appendChild(incomeAddBtn);

  refreshCategoryDirtyStatus();
  return { draftExpense, draftIncome };
}

async function saveCategoryEdits(saveBtn, status, categoryDrafts) {
  const { draftExpense, draftIncome } = categoryDrafts;
  if (draftExpense.length === 0) {
    status.textContent = 'Der skal være mindst én udgiftskategori.';
    status.className = 'budget-save-status error';
    return;
  }
  if (draftIncome.length === 0) {
    status.textContent = 'Der skal være mindst én indtægt.';
    status.className = 'budget-save-status error';
    return;
  }
  if (draftExpense.some((c) => !c.label.trim() || !c.abbrev.trim())) {
    status.textContent = 'Udfyld navn og bilagskode for hver kategori.';
    status.className = 'budget-save-status error';
    return;
  }
  if (draftIncome.some((c) => !c.label.trim())) {
    status.textContent = 'Udfyld navn for hver indtægt.';
    status.className = 'budget-save-status error';
    return;
  }
  saveBtn.disabled = true;
  status.textContent = 'Gemmer …';
  status.className = 'budget-save-status';
  const result = await budgetApi('budget_categories_save', {
    budgetId: budgetViewId,
    expense: draftExpense.map((c) => ({ key: c.key || undefined, label: c.label.trim(), abbrev: c.abbrev.trim() })),
    income: draftIncome.map((c) => ({ key: c.key || undefined, label: c.label.trim() })),
  });
  if (result.ok) {
    budgetCategoriesEditMode = false;
    siteShowToast('Kategorier gemt');
    reloadAdmin(document.getElementById('budget-root'));
  } else {
    saveBtn.disabled = false;
    status.textContent = result.message || 'Kunne ikke gemme kategorierne.';
    status.className = 'budget-save-status error';
  }
}

// Base order is time-of-upload, oldest first — but requests are first
// grouped by phone number (the stable per-person key; a name can vary in
// spelling — e.g. "Carl" vs "Carl J" — so the phone number, not the name,
// is what actually identifies the group) so a later request from someone
// who already has one pending collapses into the same section entry as
// their earlier one instead of being scattered far below it, since these
// get paid back together in one transfer. A group's position in the list
// follows its OLDEST member's createdAt (keeping the original
// queue-fairness ordering), which is what "moves up" a later same-phone
// request — it jumps out of its own chronological slot to join its group
// earlier in the list; members within a group stay oldest-first. Returns
// the groups themselves — renderPendingSection renders every group (even a
// lone request) as one collapsible section via buildPendingGroup, so the
// list is uniformly "one section per phone number" rather than special-
// casing the single-request case.
function budgetGroupRequestsByPhone(requests) {
  const groups = new Map();
  requests.forEach((req) => {
    const key = req.phone || '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(req);
  });
  const byCreatedAt = (a, b) => String(a.createdAt).localeCompare(String(b.createdAt));
  const groupList = [];
  groups.forEach((members) => {
    members.sort(byCreatedAt);
    groupList.push({ anchor: members[0].createdAt, members });
  });
  groupList.sort((a, b) => String(a.anchor).localeCompare(String(b.anchor)));
  return groupList;
}

function renderPendingSection(container) {
  const card = el('section', 'card budget-col-pending');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Afventende udlæg'));
  head.appendChild(el('span', 'budget-count', String(budgetState.requests.length)));
  card.appendChild(head);

  if (budgetState.requests.length === 0) {
    card.appendChild(el('p', 'budget-intro', 'Ingen afventende udlæg lige nu.'));
    container.appendChild(card);
    return;
  }

  // The list scrolls internally so the column never grows past the Budget card.
  const root = document.getElementById('budget-root');
  const scrollWrap = el('div', 'budget-scroll-wrap');
  const list = el('div', 'budget-list');
  budgetGroupRequestsByPhone(budgetState.requests).forEach((group, index) => {
    list.appendChild(buildPendingGroup(root, group.members, { defaultOpen: index === 0 }));
  });
  scrollWrap.appendChild(list);
  card.appendChild(scrollWrap);
  container.appendChild(card);
}

// The shared inner content of one request — its category/amount/receipt-icon
// top line, optional comment, and its own Godkend/Rediger/Afvis row — one
// row inside a phone-number group (buildPendingGroup), so a single request
// is always approvable/editable/rejectable on its own regardless of how
// many others share its phone number. Name/phone are never repeated per row
// — the group header above already states them once.
function buildPendingRowContent(root, req) {
  const wrap = el('div', 'budget-item-content');
  const isOrphan = !budgetCategoryIsValid(req.category, budgetState.categories.expense);

  const top = el('div', 'budget-item-top');
  const topLeft = el('span', 'budget-item-top-left');
  topLeft.appendChild(el('span', 'budget-badge' + (isOrphan ? ' budget-badge-orphan' : ''),
    isOrphan ? '⚠ Ingen kategori' : budgetCategoryLabel(req.category, budgetState.categories.expense)));
  topLeft.appendChild(el('span', 'budget-amount', formatKr(req.amount)));
  top.appendChild(topLeft);
  if (req.receiptFile) top.appendChild(budgetReceiptIconBtn(req.receiptFile));
  wrap.appendChild(top);

  if (req.comment) wrap.appendChild(el('div', 'budget-item-note', req.comment));
  if (isOrphan) {
    wrap.appendChild(el('div', 'budget-item-note budget-orphan-note',
      'Kategorien findes ikke længere. Vælg en ny under "Rediger" før dette udlæg kan godkendes.'));
  }

  const actions = el('div', 'budget-item-actions');
  const approveBtn = el('button', 'btn-small budget-act-approve', 'Godkend');
  approveBtn.disabled = isOrphan;
  approveBtn.addEventListener('click', () => openApproveModal(root, req));
  const editBtn = el('button', 'btn-small budget-act-edit', 'Rediger');
  editBtn.addEventListener('click', () => openRequestEditModal(root, req));
  const rejectBtn = el('button', 'btn-small budget-act-reject', 'Afvis');
  rejectBtn.addEventListener('click', () => rejectRequest(root, req));
  actions.appendChild(approveBtn);
  actions.appendChild(editBtn);
  actions.appendChild(rejectBtn);
  wrap.appendChild(actions);

  return wrap;
}

// One collapsible section per phone number — every pending request is shown
// this way, even a lone one, so the list is uniformly "one section per
// person" (a group of one still gets the same header + "Godkend alle",
// which is just a one-item batch there). The header's name is always the
// GROUP's oldest member's — the phone number is the real identity, and
// picking one consistent name (rather than e.g. showing whichever request
// happens to render) sidesteps spelling drift like "Carl" vs "Carl J."
// Only the first section in the list (index 0, the site-wide oldest-anchor
// convention) opens expanded; every other section starts collapsed.
function buildPendingGroup(root, members, { defaultOpen = false } = {}) {
  const group = el('div', 'budget-group' + (defaultOpen ? '' : ' budget-group-collapsed'));

  const header = el('div', 'budget-group-header');
  const summary = el('button', 'budget-group-summary');
  summary.type = 'button';
  summary.appendChild(el('span', 'budget-group-chevron', '▾'));
  summary.appendChild(el('span', 'budget-group-title', `${members[0].name} · ${members[0].phone}`));
  summary.addEventListener('click', () => group.classList.toggle('budget-group-collapsed'));
  header.appendChild(summary);

  const approveAllBtn = el('button', 'btn-small budget-act-approve', 'Godkend alle');
  // Disabled if any member's category has since been deleted — approving
  // the group would otherwise partially succeed and leave an orphaned
  // request behind, same as clicking Godkend on it individually would.
  approveAllBtn.disabled = members.some(
    (req) => !budgetCategoryIsValid(req.category, budgetState.categories.expense)
  );
  approveAllBtn.addEventListener('click', () => openApproveAllModal(root, members));
  header.appendChild(approveAllBtn);
  group.appendChild(header);

  const rows = el('div', 'budget-group-rows');
  members.forEach((req) => {
    const row = el('div', 'budget-group-row');
    row.appendChild(buildPendingRowContent(root, req));
    rows.appendChild(row);
  });
  group.appendChild(rows);

  return group;
}

// A square colored button for modal actions — see style.css's shared
// .site-btn-success/-danger/-warm for the styling (blue .site-btn-primary is reserved for Login/Archive; also used by every other
// page's modals). variant defaults to 'site-btn-warm' (e.g. Annuller).
function budgetPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
  btn.type = 'button';
  return btn;
}

// Godkend is a confirmation, not an edit form (editing is what "Rediger" is
// for): just the request's details + Annuller/Betalt. The paid-out person is
// the submitter, and the expense date is the submission date.
function openApproveModal(root, req) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Godkend udlæg');
  modal.classList.add('budget-confirm-modal');

  form.appendChild(el('p', 'budget-intro',
    `${budgetCategoryLabel(req.category, budgetState.categories.expense)} · ${formatKr(req.amount)} · ${req.name} · ${req.phone}`));

  if (req.comment && req.comment.trim()) {
    form.appendChild(el('p', 'budget-intro', `Kommentar: ${req.comment.trim()}`));
  }

  const confirmBtn = budgetPillBtn('Betalt', 'site-btn-success');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_approve', {
      id: req.id,
      paidBy: req.name,
      settled: true,
      date: String(req.createdAt || '').slice(0, 10) || todayIso(),
      budgetId: budgetViewId,
    });
    if (result.ok) {
      close();
      reloadAdmin(document.getElementById('budget-root'));
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(confirmBtn);
}

// Batch version of openApproveModal for one phone-number group: one line per
// request (category · amount only — no comments, this is meant as a quick
// recap before a single bank transfer, not a full review) plus the total
// amount actually being transferred to that person. Confirming approves
// every member sequentially against the existing single-request
// budget_approve action (each call's own date/paidBy still comes from that
// request, exactly as a normal one-by-one approval would) — there's no
// separate batch endpoint. A failure partway through stops there (whatever
// already succeeded stays approved, per this endpoint's usual re-run-safe
// posture) and reloads the view so the list reflects the true state rather
// than the stale pre-batch one.
function openApproveAllModal(root, members) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Godkend alle udlæg');
  modal.classList.add('budget-confirm-modal');

  form.appendChild(el('p', 'budget-intro', `${members[0].name} · ${members[0].phone}`));

  const list = el('div', 'budget-approve-all-list');
  members.forEach((req) => {
    list.appendChild(el('div', 'budget-approve-all-line',
      `${budgetCategoryLabel(req.category, budgetState.categories.expense)} · ${formatKr(req.amount)}`));
  });
  form.appendChild(list);

  const total = members.reduce((sum, req) => sum + (Number(req.amount) || 0), 0);
  form.appendChild(el('p', 'budget-approve-all-total', `I alt at overføre: ${formatKr(total)}`));

  const confirmBtn = budgetPillBtn('Betalt', 'site-btn-success');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    for (const req of members) {
      const result = await budgetApi('budget_approve', {
        id: req.id,
        paidBy: req.name,
        settled: true,
        date: String(req.createdAt || '').slice(0, 10) || todayIso(),
        budgetId: budgetViewId,
      });
      if (!result.ok) {
        confirmBtn.disabled = false;
        if (result.message) error.textContent = result.message;
        // Whatever already succeeded in this loop is real and approved —
        // reflect that in the list behind the still-open modal, same as
        // the rest of the page would after any other successful save.
        reloadAdmin(root);
        return;
      }
    }
    close();
    reloadAdmin(root);
  });
  actions.appendChild(confirmBtn);
}

// Admin: edit a pending request (category may change; receipt stays put).
function openRequestEditModal(root, req) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Rediger udlæg');
  modal.classList.add('budget-approve-modal', 'budget-confirm-modal');

  // placeholder=true: if req.category was deleted since submission, it won't
  // match any option, so siteCreateDropdownField's own fallback renders it
  // as unselected ("Vælg") rather than silently matching nothing — forcing
  // the admin to explicitly pick a real category before Gem is enabled.
  const categorySelect = siteCreateDropdownField(
    budgetCategoryOptions(budgetState.categories.expense, true), req.category
  );
  form.appendChild(siteEditField('Kategori', categorySelect));

  const amountInput = el('input');
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.value = String(req.amount).replace('.', ',');
  form.appendChild(siteEditField('Beløb (kr)', amountInput));

  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = req.name;
  form.appendChild(siteEditField('Navn', nameInput));

  const phoneInput = el('input');
  phoneInput.type = 'tel';
  phoneInput.value = req.phone;
  form.appendChild(siteEditField('Telefonnummer', phoneInput));

  const commentInput = el('textarea');
  commentInput.value = req.comment || '';
  form.appendChild(siteEditField('Kommentar', commentInput));

  const confirmBtn = budgetPillBtn('Gem', 'site-btn-warm');
  confirmBtn.addEventListener('click', async () => {
    const amount = parseAmount(amountInput.value);
    if (!categorySelect.value) { error.textContent = 'Vælg en kategori.'; return; }
    if (!(amount > 0)) { error.textContent = 'Angiv et gyldigt beløb.'; return; }
    if (!nameInput.value.trim()) { error.textContent = 'Angiv navn.'; return; }
    if (!phoneInput.value.trim()) { error.textContent = 'Angiv telefonnummer.'; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_request_update', {
      id: req.id,
      category: categorySelect.value,
      amount,
      name: nameInput.value.trim(),
      phone: phoneInput.value.trim(),
      comment: commentInput.value.trim(),
      budgetId: budgetViewId,
    });
    if (result.ok) {
      close();
      reloadAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(confirmBtn);
}

function rejectRequest(root, req) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Afvis udlæg');
  modal.classList.add('budget-confirm-modal');

  form.appendChild(el('p', 'budget-intro',
    `Afvis udlægget fra ${req.name} (${formatKr(req.amount)})? Kvitteringen slettes.`));

  const confirmBtn = budgetPillBtn('Afvis', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_request_reject', { id: req.id, budgetId: budgetViewId });
    if (result.ok) {
      close();
      reloadAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(confirmBtn);
}

function renderPaidSection(root) {
  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Betalte udgifter'));
  const addBtn = el('button', 'btn-small', '＋ Tilføj udgift');
  addBtn.addEventListener('click', () => openExpenseAddModal(root));
  head.appendChild(addBtn);
  card.appendChild(head);

  // Category filter ("shuffle through categories").
  const filterWrap = el('div', 'budget-filter');
  const filterSelect = siteCreateDropdownField(
    [{ value: 'alle', label: 'Alle kategorier' }, ...budgetCategoryOptions(budgetState.categories.expense, false)],
    budgetPaidFilter
  );
  filterSelect.addEventListener('change', () => {
    budgetPaidFilter = filterSelect.value;
    budgetPaidExpanded = false;
    renderPaidTable(tableWrap);
  });
  filterWrap.appendChild(el('label', null, 'Vis:'));
  filterWrap.appendChild(filterSelect);
  card.appendChild(filterWrap);

  const tableWrap = el('div', 'budget-table-wrap');
  card.appendChild(tableWrap);
  renderPaidTable(tableWrap);

  root.appendChild(card);
}

function renderPaidTable(wrap) {
  wrap.replaceChildren();
  const rows = budgetState.expenses
    .filter((e) => budgetPaidFilter === 'alle' || e.category === budgetPaidFilter)
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));

  const visibleRows = budgetPaidExpanded ? rows : rows.slice(0, BUDGET_PAID_PAGE_SIZE);

  const table = el('table', 'budget-table budget-table-fixed');

  // A <colgroup> is the only reliable way to force N columns to genuinely
  // equal widths regardless of how long each one's own content happens to
  // be (a per-cell width:1% just shrinks each column to its own content,
  // which is the opposite of "equal") — paired with table-layout:fixed
  // (below) so these declared widths are authoritative rather than a mere
  // auto-layout hint content can still override.
  const colgroup = el('colgroup');
  for (let i = 0; i < 5; i++) colgroup.appendChild(el('col', 'budget-col-eq'));
  colgroup.appendChild(el('col'));
  colgroup.appendChild(el('col', 'budget-col-actions'));
  table.appendChild(colgroup);

  const thead = el('thead');
  const htr = el('tr');
  ['Bilag', 'Dato', 'Betalt', 'Beløb', 'Udlægsholder', 'Kommentar', '']
    .forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  visibleRows.forEach((e) => {
    const tr = el('tr', e.deleted ? 'budget-row-deleted' : null);
    tr.appendChild(el('td', 'budget-td-narrow', e.bilag || '—'));
    tr.appendChild(el('td', 'budget-td-narrow', formatDaNumeric(String(e.date || '').slice(0, 10))));
    tr.appendChild(el('td', 'budget-td-narrow', formatDaNumeric(String(e.approvedAt || '').slice(0, 10))));
    tr.appendChild(el('td', 'budget-td-amount', formatKr(e.amount)));
    tr.appendChild(el('td', 'budget-td-narrow', e.paidBy || '—'));
    tr.appendChild(el('td', null, e.comment || ''));

    const actionsTd = el('td', 'budget-td-actions');
    const actionsWrap = el('span', 'budget-action-icons');
    if (e.receiptFile) {
      const viewBtn = el('button', 'budget-icon-btn');
      viewBtn.type = 'button';
      viewBtn.setAttribute('aria-label', 'Se kvittering');
      viewBtn.appendChild(budgetPictureIcon());
      viewBtn.addEventListener('click', async () => {
        viewBtn.disabled = true;
        const url = await budgetFetchReceipt(e.receiptFile);
        viewBtn.disabled = false;
        if (url) window.open(url, '_blank');
      });
      actionsWrap.appendChild(viewBtn);
    }
    const editBtn = el('button', 'budget-icon-btn');
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', 'Rediger udgift');
    editBtn.appendChild(budgetPencilIcon());
    editBtn.addEventListener('click', () => openExpenseEditModal(document.getElementById('budget-root'), e));
    actionsWrap.appendChild(editBtn);
    actionsTd.appendChild(actionsWrap);
    tr.appendChild(actionsTd);

    tbody.appendChild(tr);
  });

  // Keep the section at its "10 entries" height even when a filter (or a
  // near-empty ledger) leaves fewer rows to show, so switching categories
  // doesn't make the card visibly collapse/grow — pad out with blank filler
  // rows rather than reserving height via a measured min-height, since the
  // real per-row height varies with wrapped Kommentar text anyway.
  if (!budgetPaidExpanded) {
    if (visibleRows.length === 0) {
      // Not .budget-intro (font-size 0.9rem vs. the table's own 0.85rem) —
      // that mismatch alone was enough to make this row noticeably taller
      // than the plain filler rows padding out the rest of the height.
      const emptyTr = el('tr');
      const emptyTd = el('td', 'budget-empty-msg', 'Ingen betalte udgifter i denne kategori endnu.');
      emptyTd.colSpan = 7;
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    }
    const shown = Math.max(visibleRows.length, 1);
    for (let i = shown; i < BUDGET_PAID_PAGE_SIZE; i++) {
      const fillerTr = el('tr', 'budget-row-filler');
      for (let c = 0; c < 6; c++) fillerTr.appendChild(el('td', null, ' '));
      // A real row's height actually comes from its 1.8rem Se/Rediger icon
      // buttons, not from any of the text columns — a hidden same-size
      // placeholder here reproduces that height exactly, tracking
      // .budget-icon-btn automatically instead of hardcoding a pixel value.
      const actionsTd = el('td');
      const actionsWrap = el('span', 'budget-action-icons');
      const placeholder = el('span', 'budget-icon-btn');
      placeholder.style.visibility = 'hidden';
      actionsWrap.appendChild(placeholder);
      actionsTd.appendChild(actionsWrap);
      fillerTr.appendChild(actionsTd);
      tbody.appendChild(fillerTr);
    }
  }

  table.appendChild(tbody);
  wrap.appendChild(table);

  if (rows.length > BUDGET_PAID_PAGE_SIZE) {
    const toggleWrap = el('div', 'budget-paid-toggle');
    const toggleBtn = el('button', 'btn-small',
      budgetPaidExpanded ? 'Vis færre' : `Vis alle (${rows.length})`);
    toggleBtn.type = 'button';
    toggleBtn.addEventListener('click', () => {
      budgetPaidExpanded = !budgetPaidExpanded;
      renderPaidTable(wrap);
    });
    toggleWrap.appendChild(toggleBtn);
    wrap.appendChild(toggleWrap);
  }
}

// Icon-only action buttons for the paid-ledger table (Se/Rediger), matching
// calendar.js's cal-list-edit-btn pencil convention — see budget.css's
// .budget-icon-btn for the shared button chrome.
function budgetPencilIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const body = document.createElementNS(svgNS, 'path');
  body.setAttribute('d', 'M10.5 2.5l3 3-8 8-3.4 0.9 0.9-3.4z');
  svg.appendChild(body);
  const tip = document.createElementNS(svgNS, 'path');
  tip.setAttribute('d', 'M9 4l3 3');
  svg.appendChild(tip);
  return svg;
}

function budgetPictureIcon() {
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('width', '15');
  svg.setAttribute('height', '15');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.3');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  const frame = document.createElementNS(svgNS, 'rect');
  frame.setAttribute('x', '2');
  frame.setAttribute('y', '3');
  frame.setAttribute('width', '12');
  frame.setAttribute('height', '10');
  frame.setAttribute('rx', '1.3');
  svg.appendChild(frame);
  const sun = document.createElementNS(svgNS, 'circle');
  sun.setAttribute('cx', '5.7');
  sun.setAttribute('cy', '6.7');
  sun.setAttribute('r', '0.9');
  sun.setAttribute('fill', 'currentColor');
  sun.setAttribute('stroke', 'none');
  svg.appendChild(sun);
  const mountains = document.createElementNS(svgNS, 'path');
  mountains.setAttribute('d', 'M2.7 12l3.4-3.6 2.3 2.2 2-2.4 2.9 3.3');
  svg.appendChild(mountains);
  return svg;
}

// ── Admin: add a direct expense (no revyst request) ──────────
function openExpenseAddModal(root) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj udgift');
  modal.classList.add('budget-approve-modal');

  const categorySelect = siteCreateDropdownField(
    budgetCategoryOptions(budgetState.categories.expense, true), ''
  );
  form.appendChild(siteEditField('Kategori', categorySelect));

  const amountInput = el('input');
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.placeholder = 'fx 249,50';
  form.appendChild(siteEditField('Beløb (kr)', amountInput));

  const dateInput = siteCreateDateField(todayIso());
  form.appendChild(siteEditField('Dato', dateInput));

  const paidByInput = el('input');
  paidByInput.type = 'text';
  form.appendChild(siteEditField('Udlægsholder', paidByInput));

  const commentInput = el('textarea');
  commentInput.placeholder = 'valgfrit';
  form.appendChild(siteEditField('Kommentar', commentInput));

  const receiptInput = el('input', 'site-file-input');
  receiptInput.type = 'file';
  receiptInput.accept = 'image/*,application/pdf';
  form.appendChild(siteEditField('Kvittering (billede eller PDF, valgfrit)', receiptInput));

  const confirmBtn = budgetPillBtn('Tilføj', 'site-btn-success');
  confirmBtn.addEventListener('click', async () => {
    const amount = parseAmount(amountInput.value);
    if (!categorySelect.value) { error.textContent = 'Vælg en kategori.'; return; }
    if (!(amount > 0)) { error.textContent = 'Angiv et gyldigt beløb.'; return; }
    if (!paidByInput.value.trim()) { error.textContent = 'Angiv udlægsholder.'; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    let receiptBase64 = '';
    let receiptExt = '';
    const file = receiptInput.files && receiptInput.files[0];
    if (file) {
      try {
        const result = await receiptToBase64(file);
        if (result.size > 5 * 1024 * 1024) {
          confirmBtn.disabled = false;
          error.textContent = 'Filen er for stor (maks. 5 MB).';
          return;
        }
        receiptBase64 = result.base64;
        receiptExt = result.ext;
      } catch (e) {
        confirmBtn.disabled = false;
        error.textContent = 'Kunne ikke behandle filen. Prøv en anden.';
        return;
      }
    }
    const result = await budgetApi('budget_expense_add', {
      category: categorySelect.value,
      amount,
      date: dateInput.value || todayIso(),
      paidBy: paidByInput.value.trim(),
      settled: true,
      comment: commentInput.value.trim(),
      receiptBase64,
      receiptExt,
      budgetId: budgetViewId,
    });
    if (result.ok) {
      close();
      reloadAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(confirmBtn);
}

// ── Admin: edit a paid expense (category locked) ─────────────
function openExpenseEditModal(root, exp) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Rediger udgift');
  modal.classList.add('budget-approve-modal', 'budget-confirm-modal');
  actions.classList.add('budget-expense-edit-actions');

  const summaryParts = [budgetCategoryLabel(exp.category, budgetState.categories.expense), formatKr(exp.amount), exp.paidBy || '—'];
  if (exp.phone) summaryParts.push(exp.phone);
  form.appendChild(el('p', 'budget-intro', summaryParts.join(' · ')));
  form.appendChild(el('p', 'budget-intro',
    `Bilag ${exp.bilag || '—'}`
    + ` · Indsendt ${formatDaNumeric(String(exp.date || '').slice(0, 10))}`
    + ` · Betalt ${formatDaNumeric(String(exp.approvedAt || '').slice(0, 10))}`));

  // A soft-deleted expense shows no editable fields — just its status and
  // Gendan/Fjern permanent, so restoring can never accidentally carry a
  // half-typed edit along with it.
  if (exp.deleted) {
    form.appendChild(el('p', 'budget-intro', 'Denne udgift er slettet og tæller ikke med i budgettet.'));

    const restoreBtn = budgetPillBtn('Gendan', 'site-btn-success');
    restoreBtn.addEventListener('click', async () => {
      restoreBtn.disabled = true;
      error.textContent = '';
      const result = await budgetApi('budget_expense_update', {
        id: exp.id,
        amount: exp.amount,
        date: String(exp.date || '').slice(0, 10) || todayIso(),
        paidBy: exp.paidBy || '',
        settled: true,
        comment: exp.comment || '',
        name: exp.name || '',
        phone: exp.phone || '',
        deleted: false,
        budgetId: budgetViewId,
      });
      if (result.ok) {
        close();
        reloadAdmin(root);
      } else {
        restoreBtn.disabled = false;
        if (result.message) error.textContent = result.message;
      }
    });

    const removeBtn = budgetPillBtn('Fjern', 'site-btn-danger');
    removeBtn.addEventListener('click', () => openExpenseRemoveConfirm(root, exp, close));

    actions.appendChild(removeBtn);
    actions.appendChild(restoreBtn);
    return;
  }

  const amountInput = el('input');
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.value = String(exp.amount).replace('.', ',');
  form.appendChild(siteEditField('Beløb (kr)', amountInput));

  const paidByInput = el('input');
  paidByInput.type = 'text';
  paidByInput.value = exp.paidBy || '';
  form.appendChild(siteEditField('Udlægsholder', paidByInput));

  const commentInput = el('textarea');
  commentInput.value = exp.comment || '';
  form.appendChild(siteEditField('Kommentar', commentInput));

  function validate() {
    if (!(parseAmount(amountInput.value) > 0)) return 'Angiv et gyldigt beløb.';
    if (!paidByInput.value.trim()) return 'Angiv udlægsholder.';
    return '';
  }

  function buildPayload(deleted) {
    return {
      id: exp.id,
      amount: parseAmount(amountInput.value),
      date: String(exp.date || '').slice(0, 10) || todayIso(),
      paidBy: paidByInput.value.trim(),
      settled: true,
      comment: commentInput.value.trim(),
      name: exp.name || '',
      phone: exp.phone || '',
      deleted,
      budgetId: budgetViewId,
    };
  }

  const confirmBtn = budgetPillBtn('Gem', 'site-btn-warm');
  confirmBtn.addEventListener('click', async () => {
    const msg = validate();
    if (msg) { error.textContent = msg; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_expense_update', buildPayload(false));
    if (result.ok) {
      close();
      reloadAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });

  const deleteBtn = budgetPillBtn('Slet', 'site-btn-danger');
  deleteBtn.addEventListener('click', () => {
    const msg = validate();
    if (msg) { error.textContent = msg; return; }
    openExpenseDeleteConfirm(root, exp, buildPayload(true), close);
  });

  actions.appendChild(deleteBtn);
  actions.appendChild(confirmBtn);
}

// Confirm soft-deleting a paid expense — hides it from the budget totals
// and crosses it out in the table, but keeps the record and receipt so it
// can be restored (or permanently removed) later from the same edit modal.
function openExpenseDeleteConfirm(root, exp, payload, closeParent) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('budget-confirm-narrow');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  form.appendChild(el('p', 'budget-confirm-text', 'Slet udgiften?'));
  form.appendChild(el('p', 'budget-intro',
    'Kvitteringen bevares, og udgiften kan gendannes.'));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = budgetPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_expense_update', payload);
    if (result.ok) {
      close();
      closeParent();
      reloadAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Confirm permanently removing an already soft-deleted expense — this is
// the only path that actually deletes the ledger record and its receipt
// file. No renumbering of other receipts in the category: budget_next_n()
// already picks max-existing-n + 1 specifically so deletions never reuse
// a bilag number, so a gap in the sequence is expected, not a bug.
function openExpenseRemoveConfirm(root, exp, closeParent) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('budget-confirm-narrow');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  form.appendChild(el('p', 'budget-confirm-text', 'Fjern udgiften permanent?'));
  form.appendChild(el('p', 'budget-intro',
    'Kvitteringen slettes, og dette kan ikke fortrydes.'));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);

  const confirmBtn = budgetPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_expense_remove', { id: exp.id, budgetId: budgetViewId });
    if (result.ok) {
      close();
      closeParent();
      reloadAdmin(root);
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Admin: Stregregnskab (bar tally accounting) ──────────────
// Two areas, deliberately different edit models:
// - The grid (buildStregSheetCard/stregBuildTable) is read-only by
//   default; its own bottom bar mirrors the main Budget sheet's own
//   Slet/Rediger/Gem exactly (Nulstil/Rediger/Gem — see stregSheetEditMode
//   below). "Forbind" (sync names from a Formularer form) is disabled
//   while editing, since it overwrites stregState.rows outright and would
//   otherwise silently stomp an in-progress draft. Column set/order/
//   labels/prices are entirely managed from the Priser card; the grid
//   just follows whatever stregState.categories currently is.
// - The Priser card (buildStregPricesCard) is live-save, no batching at
//   all (mirrors budgetWireDropHighlight/budgetMoveDraftItem's generic
//   drag helpers from buildCategoryEditSection above, but not its
//   Gem-batched draft model) — label/price commit on blur, reorder commits
//   on drop, each resending the whole category list via streg_save_categories
//   immediately, then refreshing the grid card (stregRefreshSheetCard) so
//   its columns/Betaling never go stale. Safe now that the grid itself no
//   longer live-saves either (see its own Gem above) — nothing here can
//   race an in-flight grid save any more.

function renderStregToggleCard(container) {
  const card = el('section', 'card budget-streg-toggle');
  card.appendChild(el('h2', null, 'Stregregnskab'));
  card.appendChild(el('p', 'budget-intro',
    'Hold styr på bardrikkeri: navne, antal streger pr. drik, og hvad hver enkelt skylder.'));
  const btn = el('button', 'btn-small', budgetStregMode ? 'Tilbage til budget' : 'Åbn stregregnskab');
  btn.type = 'button';
  btn.addEventListener('click', () => budgetToggleStregMode());
  card.appendChild(btn);
  container.appendChild(card);
}

async function budgetToggleStregMode() {
  budgetSetStregMode(!budgetStregMode);
  const root = document.getElementById('budget-root');
  const scrollY = window.scrollY;
  await loadAndRenderAdmin(root, { showLoading: false });
  window.scrollTo(0, scrollY);
}

// Toggled by the grid's own Nulstil/Rediger/Gem bar — mirrors
// budgetCategoriesEditMode. stregSheetDraft is a deep clone of
// stregState.rows (each row's own counts object cloned too, so editing a
// draft cell never mutates the last-saved stregState in place) taken the
// moment edit mode is entered; discarded on Annuller/Gem/a fresh page load.
let stregSheetEditMode = false;
let stregSheetDraft = null;

// Set by buildStregPricesCard() to its own local refreshComputed closure —
// lets a grid save/reset (the only two things that change stregState.rows)
// refresh the Priser card's own per-unit preview against the new saved
// tally totals, without either card needing to know the other's internals.
let stregPriceRefreshComputed = null;

// Total tally count recorded for one category across every row of the
// given rows list — the shared denominator behind both
// stregComputePricePerUnit() and the Priser card's own live preview of an
// as-yet-uncommitted price. Defaults to the last-saved
// stregState.rows; the grid's own edit-mode table passes its in-progress
// draft instead, so Betaling recomputes instantly against what's actually
// being typed rather than stale saved counts.
function stregCategoryTallyTotal(key, rows) {
  return (rows || stregState.rows).reduce((sum, r) => sum + (Number((r.counts || {})[key]) || 0), 0);
}

// STREGPRIS PR STYK per category — INDKØBSPRIS divided by the total tally
// count recorded for that category across every row; null (rendered as
// "—") while either side of that division is zero, so a category with no
// price yet or no tallies sold yet never divides by zero.
function stregComputePricePerUnit(rows) {
  const perUnit = {};
  stregState.categories.forEach((c) => {
    const price = Number(stregState.prices[c.key]) || 0;
    const total = stregCategoryTallyTotal(c.key, rows);
    perUnit[c.key] = (price > 0 && total > 0) ? price / total : null;
  });
  return perUnit;
}

function stregRowBetaling(row, perUnit) {
  const counts = row.counts || {};
  return stregState.categories.reduce((sum, c) => {
    const count = Number(counts[c.key]) || 0;
    const p = perUnit[c.key];
    return sum + (p ? count * p : 0);
  }, 0);
}

// Structural change (category add/remove/reorder, form connected/
// disconnected) — rebuilds both cards outright.
function stregRefreshCards() {
  const oldSheet = document.querySelector('.streg-sheet-card');
  if (oldSheet) oldSheet.replaceWith(buildStregSheetCard());
  const oldPrices = document.querySelector('.streg-prices-card');
  if (oldPrices) oldPrices.replaceWith(buildStregPricesCard());
  budgetSyncPendingColumnHeight();
}

// Rebuilds only the grid card — used by its own Rediger/Annuller/Gem/
// Nulstil actions, and by Priser's own live commitAll() (whose column/price
// changes the grid needs to reflect immediately) — either way, leaving the
// other card's own DOM alone means neither ever loses focus/gets torn down
// by the other's edits.
function stregRefreshSheetCard() {
  const oldSheet = document.querySelector('.streg-sheet-card');
  if (oldSheet) oldSheet.replaceWith(buildStregSheetCard());
  budgetSyncPendingColumnHeight();
}

function renderStregSheetCard(container) {
  container.appendChild(buildStregSheetCard());
}

// Read-only by default; "Rediger" swaps the grid into an editable draft
// (stregSheetDraft) and reveals the add-row "+"/per-row "✕" controls, with
// every derived Betaling recomputing instantly (on every keystroke, not
// just on blur) against that draft — nothing touches the server until
// "Gem" commits the whole rows array in one atomic streg_save_rows call, at
// which point edit mode closes back to the read-only view. "Nulstil" is a
// separate, immediately-confirmed destructive action (mirrors the main
// Budget sheet's own "Slet") that clears every row outright, in or out of
// edit mode.
function buildStregSheetCard() {
  const card = el('section', 'card budget-sheet-card streg-sheet-card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Stregregnskab'));
  const status = el('span', 'budget-save-status', 'Gemt');
  head.appendChild(status);
  head.appendChild(el('span', 'budget-count', String(stregState.rows.length)));
  card.appendChild(head);

  if (stregState.error) {
    card.appendChild(el('p', 'budget-msg error', stregState.error));
    return card;
  }

  const toolbar = el('div', 'streg-toolbar');
  const connectLabel = stregState.connection
    ? `Forbindelse: ${stregState.connection.formTitle || 'formular'}`
    : 'Forbind';
  const connectBtn = el('button', 'btn-small', connectLabel);
  connectBtn.type = 'button';
  connectBtn.disabled = stregSheetEditMode;
  if (stregSheetEditMode) connectBtn.title = 'Afslut redigeringen af skemaet først';
  connectBtn.addEventListener('click', () => stregOpenConnectModal());
  toolbar.appendChild(connectBtn);
  card.appendChild(toolbar);

  card.appendChild(el('div', 'streg-error'));

  let draft = null;
  let refreshDirtyStatus = null;
  if (stregSheetEditMode) {
    if (!stregSheetDraft) {
      stregSheetDraft = stregState.rows.map((r) => ({ id: r.id, navn: r.navn || '', counts: { ...(r.counts || {}) } }));
    }
    draft = stregSheetDraft;
    const snapshot = JSON.stringify(draft);
    refreshDirtyStatus = () => {
      const dirty = JSON.stringify(draft) !== snapshot;
      status.textContent = dirty ? 'Ikke gemt' : 'Gemt';
      status.className = dirty ? 'budget-save-status dirty' : 'budget-save-status';
    };
  }

  const wrap = el('div', 'streg-table-wrap');
  wrap.appendChild(stregBuildTable(draft || stregState.rows, stregSheetEditMode, refreshDirtyStatus));
  card.appendChild(wrap);

  const actions = el('div', 'budget-save-bar');

  const resetBtn = el('button', 'site-btn-danger', 'Nulstil');
  resetBtn.type = 'button';
  resetBtn.addEventListener('click', () => stregOpenResetConfirm());
  actions.appendChild(resetBtn);

  const editBtn = el('button', 'site-btn-warm budget-edit-btn', stregSheetEditMode ? 'Annuller' : 'Rediger');
  editBtn.type = 'button';
  editBtn.addEventListener('click', () => {
    // Toggling off (Annuller) simply discards the draft — nothing was
    // ever sent to the server until Gem.
    stregSheetEditMode = !stregSheetEditMode;
    if (!stregSheetEditMode) stregSheetDraft = null;
    stregRefreshSheetCard();
  });
  actions.appendChild(editBtn);

  const saveBtn = el('button', 'site-btn-success', 'Gem');
  saveBtn.type = 'button';
  saveBtn.disabled = !stregSheetEditMode;
  if (stregSheetEditMode) saveBtn.addEventListener('click', () => stregSaveRows(saveBtn, status, draft));
  actions.appendChild(saveBtn);

  card.appendChild(actions);

  return card;
}

function stregAddPlusBtn(title, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'boss-manage-add-plus';
  btn.title = title;
  btn.setAttribute('aria-label', title);
  btn.textContent = '+';
  btn.addEventListener('click', onClick);
  return btn;
}

// Columns are driven entirely by stregState.categories, in its current
// order — adding/removing/reordering a column happens exclusively in the
// Priser card (buildStregPricesCard), never from the grid itself; this
// table just follows along. `rows` is either the last-saved stregState.rows
// (view mode) or the in-progress stregSheetDraft (edit mode);
// `onDirtyChange` is only passed in edit mode.
function stregBuildTable(rows, editable, onDirtyChange) {
  const betalingCells = new Map(); // draft/saved row object -> its Betaling <td>, scoped to this one render

  function recomputeAll() {
    const perUnit = stregComputePricePerUnit(rows);
    betalingCells.forEach((cell, row) => {
      cell.textContent = formatKr(stregRowBetaling(row, perUnit));
    });
  }

  const table = el('table', 'streg-table');

  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', 'streg-col-navn', 'Navn'));
  stregState.categories.forEach((c) => {
    headRow.appendChild(el('th', 'streg-col-count', c.label));
  });
  headRow.appendChild(el('th', 'streg-col-betaling', 'Betaling'));
  if (editable) headRow.appendChild(el('th', '', ''));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  const sortedRows = rows.slice()
    .sort((a, b) => (a.navn || '').localeCompare(b.navn || '', 'da', { sensitivity: 'base' }));
  sortedRows.forEach((row) => tbody.appendChild(
    stregRenderRow(row, editable, betalingCells, recomputeAll, rows, onDirtyChange)));

  if (editable) {
    const addRow = el('tr', 'streg-add-row');
    const addCell = el('td', 'streg-add-row-plus-cell');
    addCell.colSpan = 2 + stregState.categories.length;
    addCell.appendChild(stregAddPlusBtn('Tilføj række', () => {
      const draftRow = { id: null, navn: '', counts: {} };
      rows.push(draftRow);
      const tr = stregRenderRow(draftRow, editable, betalingCells, recomputeAll, rows, onDirtyChange);
      tbody.insertBefore(tr, addRow);
      recomputeAll();
      if (onDirtyChange) onDirtyChange();
      const firstInput = tr.querySelector('input[type="text"]');
      if (firstInput) firstInput.focus();
    }));
    addRow.appendChild(addCell);
    addRow.appendChild(el('td')); // filler under the trailing per-row remove column
    tbody.appendChild(addRow);
  }
  table.appendChild(tbody);
  recomputeAll();
  return table;
}

function stregRenderRow(row, editable, betalingCells, recomputeAll, rows, onDirtyChange) {
  const tr = el('tr');

  const navnTd = el('td', 'streg-col-navn');
  if (editable) {
    const navnInput = document.createElement('input');
    navnInput.type = 'text';
    navnInput.value = row.navn || '';
    navnInput.placeholder = 'Påkrævet';
    navnInput.addEventListener('input', () => {
      row.navn = navnInput.value;
      if (onDirtyChange) onDirtyChange();
    });
    navnTd.appendChild(navnInput);
  } else {
    navnTd.textContent = row.navn || '';
  }
  tr.appendChild(navnTd);

  stregState.categories.forEach((c) => {
    const td = el('td', 'streg-col-count');
    const val = (row.counts || {})[c.key];
    if (editable) {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.step = '1';
      input.inputMode = 'numeric';
      input.value = val ? String(val) : '';
      // Recomputes on every keystroke (instant Betaling/STREGPRIS feedback)
      // without reformatting the field's own live value — only 'blur'
      // normalizes what's displayed, so typing "10" doesn't get clobbered
      // mid-entry by a premature round-trip through Math.round.
      input.addEventListener('input', () => {
        const n = Math.max(0, Math.round(Number(input.value) || 0));
        if (!row.counts) row.counts = {};
        if (n) row.counts[c.key] = n;
        else delete row.counts[c.key];
        recomputeAll();
        if (onDirtyChange) onDirtyChange();
      });
      input.addEventListener('blur', () => {
        const n = (row.counts || {})[c.key] || 0;
        input.value = n ? String(n) : '';
      });
      td.appendChild(input);
    } else {
      td.textContent = val ? String(val) : '';
    }
    tr.appendChild(td);
  });

  const betalingTd = el('td', 'streg-col-betaling');
  betalingCells.set(row, betalingTd);
  tr.appendChild(betalingTd);

  if (editable) {
    const removeTd = el('td');
    const removeBtn = el('button', 'streg-remove-btn', '✕');
    removeBtn.type = 'button';
    removeBtn.title = 'Fjern række';
    removeBtn.addEventListener('click', () => {
      const idx = rows.indexOf(row);
      if (idx !== -1) rows.splice(idx, 1);
      betalingCells.delete(row);
      tr.remove();
      recomputeAll();
      if (onDirtyChange) onDirtyChange();
    });
    removeTd.appendChild(removeBtn);
    tr.appendChild(removeTd);
  }

  return tr;
}

// Commits the whole edit-mode draft in one atomic streg_save_rows call —
// a draft row with a still-blank Navn (an abandoned "+" click) is silently
// dropped rather than blocking the save, same posture as the old per-row
// auto-commit's "a brand new row with an empty Navn is a no-op."
async function stregSaveRows(saveBtn, status, draft) {
  const cleaned = draft.filter((r) => (r.navn || '').trim() !== '');
  saveBtn.disabled = true;
  status.textContent = 'Gemmer …';
  status.className = 'budget-save-status';
  const result = await budgetApi('streg_save_rows', {
    budgetId: budgetViewId,
    rows: cleaned.map((r) => ({ id: r.id || undefined, navn: r.navn.trim(), counts: r.counts || {} })),
  });
  if (!result.ok) {
    saveBtn.disabled = false;
    status.textContent = result.message || 'Kunne ikke gemme.';
    status.className = 'budget-save-status error';
    return;
  }
  stregState.rows = result.data.rows || [];
  stregSheetEditMode = false;
  stregSheetDraft = null;
  stregRefreshSheetCard();
  if (stregPriceRefreshComputed) stregPriceRefreshComputed();
}

// Immediate destructive action (its own "Er du sikker?" confirm, mirrors
// the main Budget sheet's own "Slet") — clears every row in this budget's
// stregregnskab in one call, whether or not the grid is currently mid-edit.
function stregOpenResetConfirm() {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('streg-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  form.appendChild(el('p', 'streg-confirm-text',
    'Nulstil stregregnskabet? Alle navne og streger for dette budget slettes permanent.'));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = budgetPillBtn('Nulstil', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('streg_save_rows', { budgetId: budgetViewId, rows: [] });
    if (!result.ok) {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
      return;
    }
    stregState.rows = result.data.rows || [];
    stregSheetEditMode = false;
    stregSheetDraft = null;
    close();
    stregRefreshSheetCard();
    if (stregPriceRefreshComputed) stregPriceRefreshComputed();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Boss: connect the names list to a Formularer form ────────
// Mirrors faellesOpenConnectModal almost exactly, but with only a single
// Navn-field mapping — tally counts have no form-field equivalent, they're
// always typed in directly at the bar. Reuses Forms' own boss-level
// actions (forms_admin_list/forms_admin_read) via budgetApi the same way
// faellesApi does — the shared password/level model doesn't care which
// page a request came from.
async function stregOpenConnectModal() {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Forbind til formular');
  modal.classList.add('streg-connect-modal');

  const status = el('p', 'budget-intro', 'Indlæser formularer…');
  form.appendChild(status);

  const listResult = await budgetApi('forms_admin_list', {});
  status.remove();
  if (!listResult.ok) {
    error.textContent = listResult.message || 'Kunne ikke hente formularer.';
    return;
  }
  const forms = listResult.data.forms || [];
  if (forms.length === 0) {
    form.appendChild(el('p', 'budget-intro', 'Ingen formularer fundet.'));
    return;
  }

  const currentConnection = stregState.connection;
  const formOptions = forms.map((f) => ({
    value: f.id,
    label: `${f.title || '(uden titel)'} (${f.responseCount} svar)`,
  }));
  const initialFormId = (currentConnection && forms.some((f) => f.id === currentConnection.formId))
    ? currentConnection.formId : formOptions[0].value;
  const formPicker = siteCreateDropdownField(formOptions, initialFormId);
  form.appendChild(siteEditField('Formular', formPicker));

  const fieldsContainer = el('div');
  form.appendChild(fieldsContainer);

  let currentFormId = null;
  let navnPicker = null;

  async function loadFormFields(formId) {
    currentFormId = formId;
    navnPicker = null;
    fieldsContainer.replaceChildren();
    fieldsContainer.appendChild(el('p', 'budget-intro', 'Indlæser felter…'));
    const readResult = await budgetApi('forms_admin_read', { formId });
    fieldsContainer.replaceChildren();
    if (!readResult.ok) {
      error.textContent = readResult.message || 'Kunne ikke hente formularen.';
      return;
    }
    const fieldOpts = stregFormFieldOptions(readResult.data.definition);
    if (fieldOpts.length === 0) {
      fieldsContainer.appendChild(el('p', 'budget-intro', 'Formularen har ingen felter at vælge imellem.'));
      return;
    }
    const sameAsConnected = currentConnection && currentConnection.formId === formId;
    const initialNavn = (sameAsConnected && fieldOpts.some((o) => o.value === currentConnection.navnFieldId))
      ? currentConnection.navnFieldId : fieldOpts[0].value;
    navnPicker = siteCreateDropdownField(fieldOpts, initialNavn);
    fieldsContainer.appendChild(siteEditField('Navn-felt', navnPicker));
    fieldsContainer.appendChild(el('p', 'budget-intro',
      'Alle nuværende og fremtidige navne bliver automatisk tilføjet til stregregnskabet — antal streger indtastes altid manuelt.'));
  }

  formPicker.addEventListener('change', () => loadFormFields(formPicker.value));
  await loadFormFields(initialFormId);

  if (currentConnection) {
    const disconnectBtn = budgetPillBtn('Fjern', 'site-btn-danger');
    disconnectBtn.addEventListener('click', () => stregOpenDisconnectConfirm(close));
    actions.appendChild(disconnectBtn);
  }

  const connectBtn = budgetPillBtn('Forbind', 'site-btn-success');
  connectBtn.addEventListener('click', async () => {
    if (!currentFormId || !navnPicker) return;
    const formTitle = (forms.find((f) => f.id === currentFormId) || {}).title || '';
    connectBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('streg_save_connection', {
      formId: currentFormId,
      navnFieldId: navnPicker.value,
      formTitle,
      budgetId: budgetViewId,
    });
    connectBtn.disabled = false;
    if (!result.ok) {
      error.textContent = result.message || 'Kunne ikke forbinde.';
      return;
    }
    stregState.connection = result.data.connection;
    stregState.rows = result.data.rows;
    close();
    stregRefreshCards();
  });
  actions.appendChild(connectBtn);
}

// A form's fields can live either directly on the definition or inside its
// sections — mirrors faellesFormFieldOptions.
function stregFormFieldOptions(definition) {
  const fields = (definition.fields || []).concat(
    (definition.sections || []).flatMap((s) => s.fields || [])
  );
  return fields
    .filter((f) => f && f.id && f.label)
    .map((f) => ({ value: f.id, label: f.label }));
}

function stregOpenDisconnectConfirm(closeParent) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('streg-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  form.appendChild(el('p', 'streg-confirm-text', 'Fjern forbindelsen til formularen?'));
  form.appendChild(el('p', 'budget-intro', 'Rækker der allerede er hentet ind, bliver ikke slettet.'));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = budgetPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('streg_save_connection', { formId: null, budgetId: budgetViewId });
    if (!result.ok) {
      confirmBtn.disabled = false;
      error.textContent = result.message || 'Kunne ikke fjerne forbindelsen.';
      return;
    }
    stregState.connection = null;
    stregState.rows = result.data.rows;
    close();
    closeParent();
    stregRefreshCards();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

function renderStregPricesCard(container) {
  container.appendChild(buildStregPricesCard());
}

// Replaces Afventende udlæg while in streg mode — this is where the whole
// category list is managed (add/rename/reorder/remove + price). Live-save,
// same posture as Fællesspisning's own grid: label/price commit on blur,
// reordering commits on drop, no separate Gem/Gemt status here at all — a
// commit resends the *whole* ordered list in one atomic streg_save_categories
// call regardless of which single field changed (mirrors
// budget_categories_save's own shape), then refreshes the grid card
// (stregRefreshSheetCard) so its columns/Betaling stay in sync with the
// change immediately. This was unsafe back when the grid itself also
// live-saved every tally keystroke (see the git history) — now that the
// grid is its own Rediger/Gem-batched draft, nothing here can race it, so
// there's no reason to make the admin remember to click a second Gem.
// Removing a category asks first (stregOpenDeleteCategoryConfirm, styled
// like the grid's own Nulstil confirm) since it's otherwise irreversible
// with no undo. A brand-new local row (key:null) is never sent until its
// Navn is actually filled in and blurred — an abandoned "+" click leaves
// nothing behind, same posture as the grid's own abandoned-row handling.
// Deliberately no .budget-scroll-wrap here (unlike Afventende udlæg): the
// category list is small and bounded (a handful of drink types, never the
// dozens Afventende udlæg's pending-request list can reach), so it isn't
// worth capping/scrolling — it just sizes to its own content, and
// budgetSyncPendingColumnHeight() below no-ops when it finds no scroll-wrap
// to cap.
function buildStregPricesCard() {
  const card = el('section', 'card budget-col-pending streg-prices-card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Priser'));
  card.appendChild(head);

  // Local to this card — nothing outside needs these directly; a grid
  // save/reset reaches this card only via stregPriceRefreshComputed below.
  let stregPriceUnitCells = new Map();
  let stregPriceTotalEl = null;

  if (stregState.error) {
    stregPriceRefreshComputed = null;
    card.appendChild(el('p', 'budget-msg error', stregState.error));
    return card;
  }

  const items = stregState.categories.map((c) => ({
    key: c.key, label: c.label, price: Number(stregState.prices[c.key]) || 0,
  }));

  const errorEl = el('div', 'streg-error');
  card.appendChild(errorEl);

  const header = el('div', 'streg-price-row streg-price-header');
  header.appendChild(el('span', 'streg-price-label-input'));
  header.appendChild(el('span', 'streg-price-col-buy', 'Indkøb'));
  header.appendChild(el('span', 'streg-price-per-unit', 'Pr. streg'));
  header.appendChild(el('span', 'streg-price-header-spacer')); // matches each row's own trailing remove-button column
  card.appendChild(header);

  const list = el('div', 'streg-price-list');
  card.appendChild(list);

  let dragItem = null;

  function refreshComputed() {
    let total = 0;
    items.forEach((item) => {
      total += item.price;
      const tallyTotal = stregCategoryTallyTotal(item.key);
      const perUnitVal = (item.price > 0 && tallyTotal > 0) ? item.price / tallyTotal : null;
      const span = stregPriceUnitCells.get(item);
      if (span) span.textContent = perUnitVal != null ? formatKr(perUnitVal) : '—';
    });
    if (stregPriceTotalEl) stregPriceTotalEl.textContent = formatKr(total);
  }
  stregPriceRefreshComputed = refreshComputed;

  // Resends the whole current items list (minus any still-blank brand-new
  // row — see this section's own header comment). On success, re-syncs
  // each sent item's key/label/price from the server's own cleaned-up
  // response (a brand-new item's real key in particular) and refreshes the
  // grid card, whose columns/Betaling may now be stale.
  async function commitAll() {
    const ready = items.filter((d) => !(d.key === null && d.label.trim() === ''));
    if (ready.length === 0) {
      errorEl.textContent = 'Der skal være mindst én kategori.';
      return { ok: false };
    }
    if (ready.some((d) => !d.label.trim())) {
      errorEl.textContent = 'Udfyld navn for hver kategori.';
      return { ok: false };
    }
    const result = await budgetApi('streg_save_categories', {
      budgetId: budgetViewId,
      categories: ready.map((d) => ({ key: d.key || undefined, label: d.label.trim(), price: d.price })),
    });
    if (!result.ok) {
      errorEl.textContent = result.message || 'Kunne ikke gemme.';
      return result;
    }
    errorEl.textContent = '';
    (result.data.categories || []).forEach((c, i) => {
      if (!ready[i]) return;
      ready[i].key = c.key;
      ready[i].label = c.label;
      ready[i].price = Number((result.data.prices || {})[c.key]) || 0;
    });
    stregState.categories = result.data.categories || [];
    stregState.prices = result.data.prices || {};
    refreshComputed();
    stregRefreshSheetCard();
    return { ok: true };
  }

  function renderList() {
    list.textContent = '';
    stregPriceUnitCells = new Map();
    items.forEach((item) => {
      const row = el('div', 'streg-price-row');
      row.draggable = true;
      row.addEventListener('dragstart', (e) => {
        dragItem = item;
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => row.classList.remove('budget-drop-target'));
      budgetWireDropHighlight(row, () => {
        if (dragItem && dragItem !== item) {
          budgetMoveDraftItem(items, dragItem, item, renderList);
          commitAll();
        }
      });

      const labelInput = el('input', 'budget-manage-text-input streg-price-label-input');
      labelInput.type = 'text';
      labelInput.value = item.label;
      labelInput.placeholder = 'Navn';
      labelInput.addEventListener('blur', () => {
        if (labelInput.value === item.label) return;
        item.label = labelInput.value;
        commitAll();
      });
      row.appendChild(labelInput);

      const priceInput = document.createElement('input');
      priceInput.type = 'text';
      priceInput.inputMode = 'decimal';
      priceInput.className = 'streg-price-input';
      priceInput.placeholder = '0,00';
      priceInput.value = item.price ? String(item.price).replace('.', ',') : '';
      // Recomputes the per-unit preview instantly on every keystroke (an
      // in-memory-only update — see refreshComputed) but only actually
      // saves on blur, same convention as every other text field on this
      // site (mirrors Fællesspisning's own grid).
      priceInput.addEventListener('input', () => {
        item.price = parseAmount(priceInput.value) || 0;
        refreshComputed();
      });
      priceInput.addEventListener('blur', () => commitAll());
      row.appendChild(priceInput);

      const perUnitSpan = el('span', 'streg-price-per-unit', '—');
      stregPriceUnitCells.set(item, perUnitSpan);
      row.appendChild(perUnitSpan);

      const removeBtn = el('button', 'budget-manage-remove-btn', '✕');
      removeBtn.type = 'button';
      removeBtn.title = 'Fjern kategori';
      removeBtn.addEventListener('click', () => {
        if (item.key === null) {
          // Never actually saved — just drop it locally, no confirm needed.
          const idx = items.indexOf(item);
          if (idx !== -1) items.splice(idx, 1);
          renderList();
          return;
        }
        if (items.length <= 1) {
          errorEl.textContent = 'Der skal være mindst én kategori.';
          return;
        }
        stregOpenDeleteCategoryConfirm(item, async () => {
          const idx = items.indexOf(item);
          if (idx !== -1) items.splice(idx, 1);
          const result = await commitAll();
          if (result.ok) renderList();
          else if (idx !== -1) items.splice(idx, 0, item); // roll back on failure
          return result;
        });
      });
      row.appendChild(removeBtn);

      list.appendChild(row);
    });
    refreshComputed();
  }
  renderList();

  const addBtn = el('button', 'budget-manage-add-plus', '+');
  addBtn.type = 'button';
  addBtn.title = 'Tilføj kategori';
  addBtn.addEventListener('click', () => {
    items.push({ key: null, label: '', price: 0 });
    renderList();
    const lastLabel = list.lastElementChild && list.lastElementChild.querySelector('.streg-price-label-input');
    if (lastLabel) lastLabel.focus();
  });
  card.appendChild(addBtn);

  const totalRow = el('div', 'streg-price-total');
  totalRow.appendChild(el('span', null, 'I alt'));
  const totalValueEl = el('span');
  stregPriceTotalEl = totalValueEl;
  totalRow.appendChild(totalValueEl);
  card.appendChild(totalRow);
  refreshComputed();

  return card;
}

// Styled "Er du sikker?" overlay, mirrors stregOpenResetConfirm — removing
// a category is otherwise irreversible with no undo (unlike every other
// field here, which just resends the whole list on the next edit).
// `onConfirm` performs the actual removal + commitAll() and returns the
// commit's own {ok, message} result, so a failure (e.g. network) keeps the
// modal open with an inline error instead of silently losing the action.
function stregOpenDeleteCategoryConfirm(item, onConfirm) {
  const { modal, form, error, actions, close } = siteOpenEditModal('');
  modal.classList.add('streg-confirm-modal');
  const heading = modal.querySelector('h2');
  if (heading) heading.remove();

  form.appendChild(el('p', 'streg-confirm-text',
    item.label ? `Fjern "${item.label}" permanent?` : 'Fjern denne kategori permanent?'));

  const cancelBtn = budgetPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = budgetPillBtn('Fjern', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await onConfirm();
    if (!result.ok) {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
      return;
    }
    close();
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('budget-root');
  if (!root) return;
  // The page gate (site.js) already hides <main> for public visitors.
  if (typeof siteHasLevel === 'function' && siteHasLevel('admin')) {
    loadAndRenderAdmin(root);
  } else if (typeof siteHasLevel === 'function' && siteHasLevel('revyst')) {
    renderRevystForm(root);
  }
});
