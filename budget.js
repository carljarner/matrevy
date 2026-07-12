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
  { key: 'manus',        label: 'Manuskript' },
  { key: 'tshirts',      label: 'T-shirts' },
  { key: 'stregnskab',   label: 'Stregnskab' },
];

function budgetCategoryLabel(key) {
  const c = BUDGET_CATEGORIES.find((x) => x.key === key);
  return c ? c.label : key;
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
  if (!res.ok) return { ok: false, message: budgetMapError(res.status) };
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  return { ok: true, data };
}

// Fetches a receipt image (private, password-gated) as an object URL.
async function budgetFetchReceipt(file) {
  const password = budgetResolvePassword();
  if (!password) return null;
  try {
    const res = await fetch(SITE_API_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'budget_receipt', password, file }),
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
    + 'Oplysningerne gemmes privat og kan kun ses af kassereren.');
  card.appendChild(intro);

  // Category
  const categorySelect = el('select');
  categorySelect.appendChild(new Option('Vælg kategori …', ''));
  BUDGET_CATEGORIES.forEach((c) => categorySelect.appendChild(new Option(c.label, c.key)));
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

  const receiptInput = el('input');
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
  const loading = el('span', 'budget-thumb-empty', 'Henter …');
  wrap.appendChild(loading);
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
let budgetState = { requests: [], expenses: [] };
let budgetPaidFilter = 'alle';

async function loadAndRenderAdmin(root) {
  root.replaceChildren();
  const loading = el('p', 'budget-intro', 'Henter budgetdata …');
  root.appendChild(loading);

  const result = await budgetApi('budget_read', {});
  root.replaceChildren();
  if (!result.ok) {
    if (result.message) root.appendChild(el('p', 'budget-msg error', result.message));
    return;
  }
  const data = result.data || {};
  budgetState.requests = (data.requests && data.requests.requests) || [];
  budgetState.expenses = (data.expenses && data.expenses.expenses) || [];

  renderPendingSection(root);
  renderPaidSection(root);
}

function renderPendingSection(root) {
  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Afventende udlæg'));
  head.appendChild(el('span', 'budget-count', String(budgetState.requests.length)));
  card.appendChild(head);

  if (budgetState.requests.length === 0) {
    card.appendChild(el('p', 'budget-intro', 'Ingen afventende udlæg lige nu.'));
    root.appendChild(card);
    return;
  }

  const list = el('div', 'budget-list');
  budgetState.requests
    .slice()
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .forEach((req) => list.appendChild(buildPendingCard(root, req)));
  card.appendChild(list);
  root.appendChild(card);
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
  const approveBtn = el('button', 'btn-small', 'Godkend (betalt)');
  approveBtn.addEventListener('click', () => openApproveModal(root, req));
  const rejectBtn = el('button', 'btn-small btn-small-danger', 'Afvis');
  rejectBtn.addEventListener('click', () => rejectRequest(root, req));
  actions.appendChild(approveBtn);
  actions.appendChild(rejectBtn);
  main.appendChild(actions);

  item.appendChild(main);
  item.appendChild(budgetReceiptThumb(req.receiptFile));
  return item;
}

function openApproveModal(root, req) {
  const { modal, form, error, actions, close } = siteOpenEditModal('Godkend udlæg');
  modal.classList.add('budget-approve-modal');

  form.appendChild(el('p', 'budget-intro',
    `${budgetCategoryLabel(req.category)} · ${formatKr(req.amount)} · ${req.name}`));

  const paidByInput = el('input');
  paidByInput.type = 'text';
  paidByInput.value = req.name;
  form.appendChild(siteEditField('Udlægsholder (hvem lagde ud)', paidByInput));

  const transferInput = el('input');
  transferInput.type = 'text';
  transferInput.inputMode = 'decimal';
  transferInput.value = String(req.amount).replace('.', ',');
  form.appendChild(siteEditField('Overførsel (kr tilbage til personen)', transferInput));

  const dateInput = el('input');
  dateInput.type = 'date';
  dateInput.value = todayIso();
  form.appendChild(siteEditField('Dato', dateInput));

  const settledWrap = el('label', 'budget-check');
  const settledInput = el('input');
  settledInput.type = 'checkbox';
  settledInput.checked = true;
  settledWrap.appendChild(settledInput);
  settledWrap.appendChild(el('span', null, 'Beløbet er overført (afregnet)'));
  form.appendChild(settledWrap);

  const cancelBtn = el('button', 'site-btn-secondary', 'Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = el('button', 'site-btn-primary', 'Godkend');
  confirmBtn.addEventListener('click', async () => {
    const transfer = parseAmount(transferInput.value);
    if (!(transfer >= 0)) { error.textContent = 'Angiv et gyldigt overførselsbeløb.'; return; }
    if (!paidByInput.value.trim()) { error.textContent = 'Angiv udlægsholder.'; return; }
    confirmBtn.disabled = true;
    error.textContent = '';
    const result = await budgetApi('budget_approve', {
      id: req.id,
      paidBy: paidByInput.value.trim(),
      transfer,
      settled: settledInput.checked,
      date: dateInput.value || todayIso(),
    });
    if (result.ok) {
      close();
      loadAndRenderAdmin(document.getElementById('budget-root'));
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

async function rejectRequest(root, req) {
  if (!confirm(`Afvis udlægget fra ${req.name} (${formatKr(req.amount)})? Kvitteringen slettes.`)) return;
  const result = await budgetApi('budget_request_reject', { id: req.id });
  if (result.ok) {
    loadAndRenderAdmin(root);
  } else if (result.message) {
    alert(result.message);
  }
}

function renderPaidSection(root) {
  const card = el('section', 'card');
  const head = el('div', 'card-head');
  head.appendChild(el('h2', null, 'Betalte udgifter'));
  const total = budgetState.expenses.reduce((sum, e) => sum + (Number(e.amount) || 0), 0);
  head.appendChild(el('span', 'budget-amount', formatKr(total)));
  card.appendChild(head);

  // Category filter ("shuffle through categories").
  const filterWrap = el('div', 'budget-filter');
  const filterSelect = el('select');
  filterSelect.appendChild(new Option('Alle kategorier', 'alle'));
  BUDGET_CATEGORIES.forEach((c) => filterSelect.appendChild(new Option(c.label, c.key)));
  filterSelect.value = budgetPaidFilter;
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
  ['Bilag', 'Dato', 'Beløb', 'Udlægsholder', 'Overførsel', 'Afregnet', 'Kommentar', 'Kvittering']
    .forEach((h) => htr.appendChild(el('th', null, h)));
  thead.appendChild(htr);
  table.appendChild(thead);

  const tbody = el('tbody');
  rows.forEach((e) => {
    const tr = el('tr');
    tr.appendChild(el('td', null, e.bilag || '—'));
    tr.appendChild(el('td', null, e.date || '—'));
    tr.appendChild(el('td', 'budget-td-num', formatKr(e.amount)));
    tr.appendChild(el('td', null, e.paidBy || '—'));
    tr.appendChild(el('td', 'budget-td-num', formatKr(e.transfer)));
    tr.appendChild(el('td', null, e.settled ? 'Ja' : 'Nej'));
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
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
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
