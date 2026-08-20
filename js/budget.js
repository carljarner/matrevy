/* =========================================================
   Matematikrevyen – Budget page (budget.html)

   Two audiences, one page:
   - Revyster get a submit form to request reimbursement for an
     expense they paid (category, amount, name, phone, receipt
     photo, comment).
   - Admins (kasserer) review pending requests and approve them
     (paid) — which assigns the next bilagsnummer, renames the
     receipt to "<kategori>_<n>.jpg" and moves it into the ledger —
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

// ── Categories (fixed; mirrors BUDGET_CATEGORY_KEYS in update-data.php) ─
const BUDGET_CATEGORIES = [
  { key: 'rekvisitter',  label: 'Rekvisitter og kostumer' },
  { key: 'makeup',       label: 'Makeup' },
  { key: 'texnik',       label: 'TeXnik' },
  { key: 'snacks',       label: 'Snacks' },
  { key: 'kage',         label: 'Kage' },
  { key: 'mad',          label: 'Mad' },
  { key: 'sammenholdet', label: 'Sammenholdet' },
  { key: 'fest',         label: 'Efterfest' },
  { key: 'diverse',      label: 'Diverse' },
  { key: 'rengoring',    label: 'Rengøring' },
  { key: 'tur',          label: 'Revyttetur' },
  { key: 'manus',        label: 'Manusmøder' },
  { key: 'tshirts',      label: 'T-shirts' },
  { key: 'stregnskab',   label: 'Stregnskab' },
];

function budgetCategoryLabel(key) {
  const c = BUDGET_CATEGORIES.find((x) => x.key === key);
  return c ? c.label : key;
}

// Option list for siteCreateDropdownField (site-utils.js), optionally
// prefixed with an empty "not yet chosen" placeholder row.
function budgetCategoryOptions(placeholder) {
  const opts = BUDGET_CATEGORIES.map((c) => ({ value: c.key, label: c.label }));
  return placeholder ? [{ value: '', label: 'Vælg kategori …' }, ...opts] : opts;
}

// ── Small DOM helper ─────────────────────────────────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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

// Returns raw base64 JPEG bytes for upload. Prefers a re-encoded/
// downscaled JPEG; falls back to the original file bytes if the
// browser can't process the image at all (better a big-but-working
// receipt than a blocked submit).
async function receiptToBase64(file) {
  let blob;
  try {
    blob = await compressReceiptImage(file);
  } catch (e) {
    blob = file;
  }
  return { base64: await blobToBase64(blob), size: blob.size };
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
// the module-level budgetViewYear directly (rather than taking a year
// parameter) since every call site is already inside the admin view, where
// that's always the right year to target.
async function budgetFetchReceipt(file) {
  const password = budgetResolvePassword();
  if (!password) return null;
  try {
    const res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'budget_receipt', password, file, year: budgetViewYear }),
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
  const card = el('section', 'card budget-form');
  card.appendChild(el('h2', null, 'Indsend et udlæg'));

  const intro = el('p', 'budget-intro',
    'Har du lagt penge ud for revyen? Udfyld formularen, så sender vi pengene retur. '
    + 'Oplysningerne gemmes privat og kan kun ses af koordinatorerne.');
  card.appendChild(intro);

  // Category
  const categorySelect = siteCreateDropdownField(budgetCategoryOptions(true), '');
  card.appendChild(siteEditField('Kategori', categorySelect));

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
  receiptInput.accept = 'image/*';
  card.appendChild(siteEditField('Billede af kvittering', receiptInput));

  const commentInput = el('textarea');
  commentInput.placeholder = 'valgfrit';
  card.appendChild(siteEditField('Kommentar', commentInput));

  const msg = el('div', 'budget-msg');
  card.appendChild(msg);

  const submitBtn = el('button', 'site-btn-primary', 'Send udlæg');
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
    if (!file) return setMsg('Vedhæft et billede af kvitteringen.', 'error');

    submitBtn.disabled = true;
    setMsg('Sender …', null);
    try {
      const { base64: receiptBase64, size } = await receiptToBase64(file);
      if (size > 5 * 1024 * 1024) {
        submitBtn.disabled = false;
        return setMsg('Billedet er for stort (maks. 5 MB). Prøv et mindre billede.', 'error');
      }
      const result = await budgetApi('budget_submit', {
        category, amount, name, phone, comment, receiptBase64,
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
      setMsg('Kunne ikke behandle billedet. Prøv et andet billede.', 'error');
    }
    submitBtn.disabled = false;
  });

  root.appendChild(card);
}

// ── Receipt thumbnail (lazy, private) ────────────────────────
function budgetReceiptThumb(file) {
  const wrap = el('div', 'budget-thumb');
  if (!file) {
    wrap.appendChild(el('span', 'budget-thumb-empty', 'Ingen kvittering'));
    return wrap;
  }
  wrap.appendChild(el('span', 'budget-thumb-empty', 'Henter …'));
  budgetFetchReceipt(file).then((url) => {
    wrap.replaceChildren();
    if (!url) {
      wrap.appendChild(el('span', 'budget-thumb-empty', 'Kvittering utilgængelig'));
      return;
    }
    const img = el('img');
    img.src = url;
    img.alt = 'Kvittering';
    img.addEventListener('click', () => window.open(url, '_blank'));
    wrap.appendChild(img);
  });
  return wrap;
}

// ── Admin: management view ───────────────────────────────────
let budgetState = { requests: [], expenses: [], budget: { planned: {}, income: [] } };
let budgetPaidFilter = 'alle';

// Which year the admin view is currently displaying/editing — decoupled
// from which year is "active" (where new revyst submissions/receipts
// land, see budgetActiveYear below): viewing a past year for corrections
// (e.g. via "Tilføj udgift") must never change where new uploads go. Both
// start null and are set from budget_read's own response on first load
// (the server resolves budgetViewYear=null to "the active year" — see
// budget_resolve_year in update-data.php — so the very first load always
// shows the active year without this client needing to already know it).
let budgetViewYear = null;
let budgetActiveYear = null;
let budgetYearsList = []; // [{year, label, createdAt}], from years.json

async function loadAndRenderAdmin(root, { showLoading = true } = {}) {
  if (showLoading) {
    root.replaceChildren();
    const loading = el('p', 'budget-intro', 'Henter budgetdata …');
    root.appendChild(loading);
  }

  const result = await budgetApi('budget_read', { year: budgetViewYear });
  root.replaceChildren();
  if (!result.ok) {
    if (result.message) root.appendChild(el('p', 'budget-msg error', result.message));
    return;
  }
  const data = result.data || {};
  budgetViewYear = data.year != null ? data.year : budgetViewYear;
  budgetActiveYear = data.activeYear != null ? data.activeYear : budgetActiveYear;
  budgetYearsList = Array.isArray(data.years) ? data.years : budgetYearsList;

  renderYearToolbar(root);

  // Bootstrap case: a brand-new deploy has no budget year at all yet (see
  // budget_read's own bootstrap branch in update-data.php) — nothing to
  // show/edit until the admin creates + activates the first year above.
  if (data.activeYear == null) {
    root.appendChild(el('p', 'budget-intro', 'Der er endnu ikke oprettet et budgetår. Opret det første ovenfor.'));
    return;
  }

  budgetState.requests = (data.requests && data.requests.requests) || [];
  budgetState.expenses = (data.expenses && data.expenses.expenses) || [];
  const b = data.budget || {};
  budgetState.budget = {
    planned: (b.planned && typeof b.planned === 'object') ? b.planned : {},
    income: Array.isArray(b.income) ? b.income : [],
  };

  // Budget + Afventende udlæg sit side by side (Betalte udgifter is full-width below).
  const cols = el('div', 'budget-columns');
  root.appendChild(cols);
  renderBudgetSheet(cols);
  renderPendingSection(cols);
  renderPaidSection(root);
}

// ── Admin: year toolbar (viewing vs. active year, start a new year) ──
function budgetYearLabel(year) {
  const entry = budgetYearsList.find((y) => y.year === year);
  return entry ? entry.label : String(year);
}

function renderYearToolbar(root) {
  const card = el('section', 'card budget-year-toolbar');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Budgetår'));
  card.appendChild(head);

  const row = el('div', 'budget-year-row');

  // No year exists yet (brand-new deploy) — nothing to view/switch between,
  // only "Start nyt budgetår" (below) makes sense.
  if (budgetActiveYear != null) {
    const viewWrap = el('div', 'budget-year-field');
    viewWrap.appendChild(el('label', null, 'Ser:'));
    const yearOptions = budgetYearsList
      .slice()
      .sort((a, b) => b.year - a.year)
      .map((y) => ({ value: String(y.year), label: y.label }));
    const yearSelect = siteCreateDropdownField(yearOptions, String(budgetViewYear));
    yearSelect.addEventListener('change', () => {
      const year = Number(yearSelect.value);
      if (Number.isInteger(year) && year !== budgetViewYear) {
        budgetViewYear = year;
        loadAndRenderAdmin(document.getElementById('budget-root'));
      }
    });
    viewWrap.appendChild(yearSelect);
    row.appendChild(viewWrap);

    const activeWrap = el('div', 'budget-year-field');
    activeWrap.appendChild(el('span', 'budget-year-active-label', 'Aktivt år:'));
    activeWrap.appendChild(el('span', 'budget-year-active-value', budgetYearLabel(budgetActiveYear)));
    row.appendChild(activeWrap);
  }

  const newYearBtn = el('button', 'btn-small', 'Start nyt budgetår');
  newYearBtn.type = 'button';
  newYearBtn.addEventListener('click', () => openNewBudgetYearModal(document.getElementById('budget-root')));
  row.appendChild(newYearBtn);

  card.appendChild(row);
  root.appendChild(card);
}

// Creates a new (inactive) budget year seeded from the currently active
// year's planned amounts, then immediately activates it — "Start nyt
// budgetår" is these two server actions run back to back client-side (see
// budget_create_year/budget_set_active_year in update-data.php, each kept
// single-purpose so re-activating an already-existing past year later is
// just the second call on its own).
function openNewBudgetYearModal(root) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Start nyt budgetår');
  modal.classList.add('budget-approve-modal');

  form.appendChild(el('p', 'budget-intro',
    'Opretter et nyt, tomt budgetår (planlagte beløb kopieres fra det nuværende aktive år) og gør det til det aktive år, ' +
    'som nye udlæg fra revyster sendes ind til.'));

  const yearInput = el('input');
  yearInput.type = 'number';
  yearInput.min = '2000';
  yearInput.max = '2100';
  yearInput.value = String(budgetActiveYear != null ? budgetActiveYear + 1 : new Date().getFullYear());
  form.appendChild(siteEditField('Årstal', yearInput));

  const labelInput = el('input');
  labelInput.type = 'text';
  labelInput.value = `MatRevy ${yearInput.value}`;
  form.appendChild(siteEditField('Label', labelInput));

  const confirmBtn = budgetPillBtn('Start', 'site-pill-primary');
  confirmBtn.addEventListener('click', async () => {
    const year = Number(yearInput.value);
    const label = labelInput.value.trim();
    if (!Number.isInteger(year) || year < 2000 || year > 2100) { error.textContent = 'Angiv et gyldigt årstal.'; return; }
    if (!label) { error.textContent = 'Angiv en label.'; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    const createResult = await budgetApi('budget_create_year', { year, label });
    if (!createResult.ok) {
      confirmBtn.disabled = false;
      if (createResult.message) error.textContent = createResult.message;
      return;
    }
    const activateResult = await budgetApi('budget_set_active_year', { year });
    if (!activateResult.ok) {
      confirmBtn.disabled = false;
      if (activateResult.message) error.textContent = activateResult.message;
      return;
    }
    budgetViewYear = year;
    close();
    loadAndRenderAdmin(root);
  });
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
let budgetSheetDirty = false;
let budgetSheetTimersReady = false;

function computeSpentByCategory() {
  const map = {};
  budgetState.expenses.forEach((e) => {
    if (e.deleted) return;
    const k = e.category;
    map[k] = (map[k] || 0) + (Number(e.amount) || 0);
  });
  return map;
}

function markSheetDirty() {
  budgetSheetDirty = true;
  if (budgetSheet) {
    budgetSheet.status.textContent = 'Ikke gemt';
    budgetSheet.status.className = 'budget-save-status dirty';
  }
}

function nowHhmm() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Income is a fixed two-row list (labels hardcoded, non-removable) — the only
// real income is ticket sales; "Andet" is a catch-all.
const BUDGET_INCOME_ROWS = [
  { id: 'billetsalg', label: 'Billetsalg (efter kontingent)' },
  { id: 'andet',      label: 'Andet' },
];

function renderBudgetSheet(container) {
  const card = el('section', 'card budget-sheet-card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Budget'));
  const status = el('span', 'budget-save-status', 'Gemt');
  head.appendChild(status);
  card.appendChild(head);

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
  BUDGET_CATEGORIES.forEach((c) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, c.label));

    const pTd = el('td', 'budget-td-num');
    const inp = el('input', 'budget-plan-input');
    inp.type = 'text';
    inp.inputMode = 'decimal';
    inp.placeholder = '0';
    const pv = budgetState.budget.planned[c.key];
    if (pv != null && pv !== '') inp.value = String(pv).replace('.', ',');
    inp.addEventListener('input', () => { markSheetDirty(); updateSheetTotals(); });
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

  // Income section — two fixed rows.
  const incomeHead = el('div', 'budget-subhead');
  incomeHead.appendChild(el('h3', null, 'Indtægter'));
  const incomeTotalCell = el('span', 'budget-amount', formatKr(0));
  incomeHead.appendChild(incomeTotalCell);
  card.appendChild(incomeHead);

  const incomeList = el('div', 'budget-income-list');
  card.appendChild(incomeList);

  const incomeRows = [];
  const storedIncome = budgetState.budget.income || [];
  BUDGET_INCOME_ROWS.forEach((def) => {
    const stored = storedIncome.find((x) => x && x.id === def.id) || {};
    incomeList.appendChild(buildIncomeRow(def, stored, incomeRows));
  });

  // Net result.
  const netRow = el('div', 'budget-net-row');
  netRow.appendChild(el('span', null, 'Resultat (indtægter − brugt)'));
  const netCell = el('span', 'budget-net-value');
  netRow.appendChild(netCell);
  card.appendChild(netRow);

  // Save bar.
  const saveBar = el('div', 'budget-save-bar');
  const saveBtn = el('button', 'site-btn-primary', 'Gem budget');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', () => saveBudgetSheet());
  saveBar.appendChild(saveBtn);
  card.appendChild(saveBar);

  budgetSheet = {
    plannedInputs, restCells, spent, incomeList,
    incomeRows,
    totalPlannedCell, totalBrugtCell, totalRestCell,
    incomeTotalCell, netCell, status,
  };
  budgetSheetDirty = false;

  updateSheetTotals();

  container.appendChild(card);
  ensureBudgetSheetTimers(container);
}

function buildIncomeRow(def, stored, incomeRows) {
  // Wrapper so the optional description (Andet) can sit under the amount row.
  const wrap = el('div', 'budget-income-group');

  const row = el('div', 'budget-income-row');
  row.appendChild(el('span', 'budget-income-name', def.label));

  const amountInput = el('input', 'budget-income-amount');
  amountInput.type = 'text';
  amountInput.inputMode = 'decimal';
  amountInput.placeholder = '0';
  const amt = stored.amount;
  if (amt != null && amt !== '') amountInput.value = String(amt).replace('.', ',');
  amountInput.addEventListener('input', () => { markSheetDirty(); updateSheetTotals(); });
  row.appendChild(amountInput);
  wrap.appendChild(row);

  const entry = { id: def.id, label: def.label, amountInput };

  // "Andet" is a catch-all — let the kasserer describe what it covers.
  if (def.id === 'andet') {
    const noteInput = el('input', 'budget-income-note-input');
    noteInput.type = 'text';
    noteInput.placeholder = 'Beskriv hvad "Andet" dækker …';
    if (stored.note != null) noteInput.value = String(stored.note);
    noteInput.addEventListener('input', () => { markSheetDirty(); });
    wrap.appendChild(noteInput);
    entry.noteInput = noteInput;
  }

  incomeRows.push(entry);
  return wrap;
}

function updateSheetTotals() {
  if (!budgetSheet) return;
  let totalPlanned = 0;
  let totalBrugt = 0;
  BUDGET_CATEGORIES.forEach((c) => {
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
  BUDGET_CATEGORIES.forEach((c) => {
    const raw = budgetSheet.plannedInputs[c.key].value.trim();
    if (raw !== '') {
      const v = parseAmount(raw);
      if (Number.isFinite(v) && v >= 0) planned[c.key] = v;
    }
  });
  const income = budgetSheet.incomeRows.map((r) => {
    const amount = parseAmount(r.amountInput.value);
    const line = {
      id: r.id,
      label: r.label,
      amount: Number.isFinite(amount) && amount >= 0 ? amount : 0,
    };
    if (r.noteInput) line.note = r.noteInput.value.trim();
    return line;
  });
  return { planned, income, year: budgetViewYear };
}

async function saveBudgetSheet() {
  if (!budgetSheet) return { ok: false };
  const payload = collectSheetPayload();
  budgetSheet.status.textContent = 'Gemmer …';
  budgetSheet.status.className = 'budget-save-status';
  const result = await budgetApi('budget_save_sheet', payload);
  if (result.ok) {
    budgetSheetDirty = false;
    budgetState.budget = { planned: payload.planned, income: payload.income };
    budgetSheet.status.textContent = 'Gemt kl. ' + nowHhmm();
    budgetSheet.status.className = 'budget-save-status';
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
  if (budgetSheet && budgetSheetDirty) await saveBudgetSheet();
}

// Register the 15-minute autosave interval and the unsaved-changes guard once.
function ensureBudgetSheetTimers(root) {
  if (budgetSheetTimersReady) return;
  budgetSheetTimersReady = true;
  setInterval(() => { if (budgetSheetDirty) saveBudgetSheet(); }, 15 * 60 * 1000);
  window.addEventListener('beforeunload', (e) => {
    if (budgetSheetDirty) { e.preventDefault(); e.returnValue = ''; }
  });
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
  budgetState.requests
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .forEach((req) => list.appendChild(buildPendingCard(root, req)));
  scrollWrap.appendChild(list);
  card.appendChild(scrollWrap);
  container.appendChild(card);
}

function buildPendingCard(root, req) {
  const item = el('div', 'budget-item');

  const main = el('div', 'budget-item-main');
  const top = el('div', 'budget-item-top');
  top.appendChild(el('span', 'budget-badge', budgetCategoryLabel(req.category)));
  top.appendChild(el('span', 'budget-amount', formatKr(req.amount)));
  main.appendChild(top);

  main.appendChild(el('div', 'budget-item-line', req.name + ' · ' + req.phone));
  if (req.comment) main.appendChild(el('div', 'budget-item-note', req.comment));

  const actions = el('div', 'budget-item-actions');
  const approveBtn = el('button', 'btn-small budget-act-approve', 'Godkend');
  approveBtn.addEventListener('click', () => openApproveModal(root, req));
  const editBtn = el('button', 'btn-small budget-act-edit', 'Rediger');
  editBtn.addEventListener('click', () => openRequestEditModal(root, req));
  const rejectBtn = el('button', 'btn-small budget-act-reject', 'Afvis');
  rejectBtn.addEventListener('click', () => rejectRequest(root, req));
  actions.appendChild(approveBtn);
  actions.appendChild(editBtn);
  actions.appendChild(rejectBtn);
  main.appendChild(actions);

  item.appendChild(main);
  item.appendChild(budgetReceiptThumb(req.receiptFile));
  return item;
}

// A rounded "pill" button — see style.css's shared .site-pill-btn for the
// styling (also used by every other page's modals).
function budgetPillBtn(label, variant) {
  const btn = el('button', 'site-pill-btn' + (variant ? ' ' + variant : ''), label);
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
    `${budgetCategoryLabel(req.category)} · ${formatKr(req.amount)} · ${req.name} · ${req.phone}`));

  if (req.comment && req.comment.trim()) {
    form.appendChild(el('p', 'budget-intro', `Kommentar: ${req.comment.trim()}`));
  }

  const confirmBtn = budgetPillBtn('Betalt', 'site-pill-primary');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_approve', {
      id: req.id,
      paidBy: req.name,
      settled: true,
      date: String(req.createdAt || '').slice(0, 10) || todayIso(),
      year: budgetViewYear,
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

// Admin: edit a pending request (category may change; receipt stays put).
function openRequestEditModal(root, req) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Rediger udlæg');
  modal.classList.add('budget-approve-modal', 'budget-confirm-modal');

  const categorySelect = siteCreateDropdownField(budgetCategoryOptions(false), req.category);
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

  const confirmBtn = budgetPillBtn('Gem', 'site-pill-warm');
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
      year: budgetViewYear,
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

  const confirmBtn = budgetPillBtn('Afvis', 'site-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_request_reject', { id: req.id, year: budgetViewYear });
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
    [{ value: 'alle', label: 'Alle kategorier' }, ...budgetCategoryOptions(false)],
    budgetPaidFilter
  );
  filterSelect.addEventListener('change', () => {
    budgetPaidFilter = filterSelect.value;
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

  if (rows.length === 0) {
    wrap.appendChild(el('p', 'budget-intro', 'Ingen betalte udgifter i denne kategori endnu.'));
    return;
  }

  const table = el('table', 'budget-table');
  const thead = el('thead');
  const htr = el('tr');
  ['Bilag', 'Dato', 'Betalt', 'Beløb', 'Udlægsholder', 'Kommentar', 'Kvittering', '']
    .forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((e) => {
    const tr = el('tr', e.deleted ? 'budget-row-deleted' : null);
    tr.appendChild(el('td', null, e.bilag || '—'));
    tr.appendChild(el('td', null, formatDaNumeric(String(e.date || '').slice(0, 10))));
    tr.appendChild(el('td', null, formatDaNumeric(String(e.approvedAt || '').slice(0, 10))));
    tr.appendChild(el('td', 'budget-td-num', formatKr(e.amount)));
    tr.appendChild(el('td', null, e.paidBy || '—'));
    tr.appendChild(el('td', null, e.comment || ''));
    const receiptTd = el('td');
    if (e.receiptFile) {
      const link = el('button', 'btn-small', 'Se');
      link.addEventListener('click', async () => {
        link.disabled = true;
        const url = await budgetFetchReceipt(e.receiptFile);
        link.disabled = false;
        if (url) window.open(url, '_blank');
      });
      receiptTd.appendChild(link);
    } else {
      receiptTd.appendChild(el('span', 'budget-thumb-empty', '—'));
    }
    tr.appendChild(receiptTd);

    const editTd = el('td');
    const editBtn = el('button', 'btn-small', 'Rediger');
    editBtn.addEventListener('click', () => openExpenseEditModal(document.getElementById('budget-root'), e));
    editTd.appendChild(editBtn);
    tr.appendChild(editTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
}

// ── Admin: add a direct expense (no revyst request) ──────────
function openExpenseAddModal(root) {
  const { modal, form, error, actions, close } = siteOpenModalWithClose('Tilføj udgift');
  modal.classList.add('budget-approve-modal');

  const categorySelect = siteCreateDropdownField(budgetCategoryOptions(true), '');
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
  receiptInput.accept = 'image/*';
  form.appendChild(siteEditField('Billede af kvittering (valgfrit)', receiptInput));

  const confirmBtn = budgetPillBtn('Tilføj', 'site-pill-primary');
  confirmBtn.addEventListener('click', async () => {
    const amount = parseAmount(amountInput.value);
    if (!categorySelect.value) { error.textContent = 'Vælg en kategori.'; return; }
    if (!(amount > 0)) { error.textContent = 'Angiv et gyldigt beløb.'; return; }
    if (!paidByInput.value.trim()) { error.textContent = 'Angiv udlægsholder.'; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    let receiptBase64 = '';
    const file = receiptInput.files && receiptInput.files[0];
    if (file) {
      try {
        const { base64, size } = await receiptToBase64(file);
        if (size > 5 * 1024 * 1024) {
          confirmBtn.disabled = false;
          error.textContent = 'Billedet er for stort (maks. 5 MB).';
          return;
        }
        receiptBase64 = base64;
      } catch (e) {
        confirmBtn.disabled = false;
        error.textContent = 'Kunne ikke behandle billedet. Prøv et andet.';
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
      year: budgetViewYear,
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

  form.appendChild(el('p', 'budget-intro',
    `${budgetCategoryLabel(exp.category)} · bilag ${exp.bilag || '—'}`));
  form.appendChild(el('p', 'budget-intro',
    `Indsendt ${formatDaNumeric(String(exp.date || '').slice(0, 10))}`
    + ` · Betalt ${formatDaNumeric(String(exp.approvedAt || '').slice(0, 10))}`));

  // A soft-deleted expense shows no editable fields — just its status and
  // Gendan/Fjern permanent, so restoring can never accidentally carry a
  // half-typed edit along with it.
  if (exp.deleted) {
    form.appendChild(el('p', 'budget-intro', 'Denne udgift er slettet og tæller ikke med i budgettet.'));

    const restoreBtn = budgetPillBtn('Gendan', 'site-pill-primary');
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
        year: budgetViewYear,
      });
      if (result.ok) {
        close();
        reloadAdmin(root);
      } else {
        restoreBtn.disabled = false;
        if (result.message) error.textContent = result.message;
      }
    });

    const removeBtn = budgetPillBtn('Fjern', 'site-pill-danger');
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
      year: budgetViewYear,
    };
  }

  const confirmBtn = budgetPillBtn('Gem', 'site-pill-warm');
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

  const deleteBtn = budgetPillBtn('Slet', 'site-pill-danger');
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

  const confirmBtn = budgetPillBtn('Slet', 'site-pill-danger');
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

  const confirmBtn = budgetPillBtn('Fjern', 'site-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_expense_remove', { id: exp.id, year: budgetViewYear });
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
