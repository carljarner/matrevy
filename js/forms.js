/* =========================================================
   Matematikrevyen – Formularer (forms.html)

   Self-hosted replacement for the Google Forms coordinators build every
   year (cast/crew sign-up, rehearsal availability, ...).

   Two audiences, one page:
   - Revyster see the list of currently open forms and can fill one in.
   - Boss/admin build/edit forms (from scratch or from a reusable
     template), view/export submitted responses, and manage templates.

   Like Budget, this data is PRIVATE: form definitions, templates, and
   responses never touch the public repo / embed pipeline. Everything is
   read/written through authenticated actions on the same PHP endpoint
   (site.js's SITE_API_ENDPOINT), backed by files on the Simply.com host
   under FORMS_DATA_DIR — a submitted answer may contain a name, phone
   number, or other personal information.

   Two field types ("select"/"checkboxes" with optionsSource "scenes" or
   "rehearsals") source their option list LIVE from this site's own public
   data (SCENES_DATA/CALENDAR_DATA, embedded via scenes-data.js/
   calendar-data.js) at render time — never baked into the stored
   FieldSpec, so a form always offers whatever scenes/rehearsals exist
   right now.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Calendar categories (duplicated from calendar.js — that file isn't
// loaded on this page; per this codebase's established convention, small
// shared lookups get copied per-feature rather than imported). Only used
// here to label the "rehearsals" live-options source's category filter;
// the actual keys must stay in sync with CAL_CATEGORIES in calendar.js. ─
const FORMS_CAL_CATEGORIES = {
  deadline:     { label: 'Deadline' },
  manus:        { label: 'Manus' },
  ove:          { label: 'Øvning' },
  forestilling: { label: 'Forestilling' },
  andet:        { label: 'Andet' },
};

// ── Field type palette ───────────────────────────────────────
const FORMS_FIELD_TYPES = [
  { value: 'text',       label: 'Kort tekst' },
  { value: 'textarea',   label: 'Lang tekst' },
  { value: 'select',     label: 'Vælg én' },
  { value: 'checkboxes', label: 'Vælg flere' },
  { value: 'yesno',      label: 'Ja/nej' },
];

// ── Small DOM helper (mirrors budget.js's el()) ──────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formsPillBtn(label, variant) {
  const btn = el('button', 'site-pill-btn' + (variant ? ' ' + variant : ''), label);
  btn.type = 'button';
  return btn;
}

// ── Authenticated API (mirrors budget.js's budgetResolvePassword/budgetApi) ──
// Works for revyst AND boss/admin: the password is whichever level the
// visitor logged in with.
function formsResolvePassword() {
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

function formsMapError(status) {
  if (status === 401 || status === 403) return 'Forkert eller utilstrækkelig adgangskode. Log ind igen.';
  if (status === 404) return 'Ikke fundet. Genindlæs siden og prøv igen.';
  if (status === 409) return 'Formularen er ikke længere åben.';
  return 'Der opstod en serverfejl. Prøv igen senere.';
}

// Returns { ok: true, data } or { ok: false, message }.
async function formsApi(action, body) {
  const password = formsResolvePassword();
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
  // challenge) can come back as HTTP 200 with an HTML body, and must NOT
  // be mistaken for success.
  let data = null;
  try { data = await res.json(); } catch (e) { data = null; }
  if (!res.ok) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    const base = formsMapError(res.status);
    return { ok: false, message: detail ? `${base} (${detail})` : base };
  }
  if (!data || data.ok !== true) {
    const detail = data && typeof data.error === 'string' ? data.error : '';
    return { ok: false, message: detail ? `Serverfejl: ${detail}` : 'Uventet svar fra serveren. Prøv igen senere.' };
  }
  return { ok: true, data };
}

// ── Live option sources (scenes.json / calendar.json) ────────
// Options are resolved fresh every time these are called — never stored on
// the FieldSpec — so a form always reflects the current scene/rehearsal
// list. Used both by the fill-in renderer and the admin builder's preview.
function formsOptionsFromScenes(sourceFilter) {
  // SCENES_DATA (embedded via scenes-data.js) is already a FLAT array of
  // scenes — unlike data/scenes.json's own acts[].scenes[] nesting, the
  // embed step flattens it (see js/schedule.js's identical consumption).
  if (typeof SCENES_DATA === 'undefined' || !Array.isArray(SCENES_DATA)) return [];
  const onlySchedulable = !!(sourceFilter && sourceFilter.schedulableOnly);
  const out = [];
  for (const scene of SCENES_DATA) {
    if (onlySchedulable && scene.schedulable === false) continue;
    out.push({ value: scene.id, label: scene.name });
  }
  return out;
}

function formsOptionsFromRehearsals(sourceFilter) {
  if (typeof CALENDAR_DATA === 'undefined' || !Array.isArray(CALENDAR_DATA)) return [];
  const onlyCategory = sourceFilter && sourceFilter.category ? sourceFilter.category : null;
  const events = CALENDAR_DATA
    .filter((ev) => !onlyCategory || ev.category === onlyCategory)
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return events.map((ev) => ({
    value: ev.id,
    label: `${ev.title} — ${typeof formatDaDateShort === 'function' ? formatDaDateShort(ev.date) : ev.date}`,
  }));
}

function formsResolveOptions(field) {
  if (field.optionsSource === 'scenes') return formsOptionsFromScenes(field.sourceFilter);
  if (field.optionsSource === 'rehearsals') return formsOptionsFromRehearsals(field.sourceFilter);
  return Array.isArray(field.options) ? field.options : [];
}

// ── Field id generator (client-side only; validated server-side too) ─
let formsFieldIdCounter = 0;
function formsNewFieldId() {
  formsFieldIdCounter += 1;
  return 'f' + Date.now().toString(36) + formsFieldIdCounter.toString(36);
}

// ── Shared field-answer renderer ─────────────────────────────
// Builds the input control for one FieldSpec — used both by the revyst
// fill-in view and (read-only-ish, for a live options preview) nowhere
// else; the admin builder edits FieldSpecs directly, not answers.
// Returns an element with a `.formsValue` getter matching the shape
// forms_submit expects (string / string[] / boolean).
function formsRenderAnswerInput(field) {
  if (field.type === 'textarea') {
    const input = el('textarea');
    input.rows = 4;
    input.formsValue = () => input.value.trim();
    return input;
  }
  if (field.type === 'select') {
    const options = [{ value: '', label: 'Vælg …' }, ...formsResolveOptions(field)];
    const dd = siteCreateDropdownField(options, '');
    dd.formsValue = () => dd.value || '';
    return dd;
  }
  if (field.type === 'checkboxes') {
    const wrap = el('div', 'forms-checkbox-list');
    const options = formsResolveOptions(field);
    const boxes = [];
    for (const opt of options) {
      const row = el('label', 'forms-checkbox-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.value = opt.value;
      row.appendChild(cb);
      row.appendChild(document.createTextNode(opt.label));
      wrap.appendChild(row);
      boxes.push(cb);
    }
    wrap.formsValue = () => boxes.filter((b) => b.checked).map((b) => b.value);
    return wrap;
  }
  if (field.type === 'yesno') {
    const dd = siteCreateDropdownField([{ value: true, label: 'Ja' }, { value: false, label: 'Nej' }], '');
    dd.formsValue = () => (dd.value === true || dd.value === false ? dd.value : null);
    return dd;
  }
  // text (default)
  const input = el('input');
  input.type = 'text';
  input.formsValue = () => input.value.trim();
  return input;
}

// ── Revyst: list of open forms ────────────────────────────────
async function renderFormsList(root) {
  root.replaceChildren();
  const card = el('section', 'card forms-form');
  card.appendChild(el('h2', null, 'Åbne formularer'));
  const listWrap = el('div', 'forms-open-list', 'Henter formularer …');
  card.appendChild(listWrap);
  root.appendChild(card);

  const result = await formsApi('forms_list_open', {});
  listWrap.replaceChildren();
  if (!result.ok) {
    if (result.message) listWrap.appendChild(el('p', 'forms-msg error', result.message));
    return;
  }
  const forms = Array.isArray(result.data.forms) ? result.data.forms : [];
  if (forms.length === 0) {
    listWrap.appendChild(el('p', 'forms-intro', 'Der er ingen åbne formularer lige nu.'));
    return;
  }
  for (const f of forms) {
    const row = el('div', 'forms-open-row');
    const info = el('div', 'forms-open-info');
    info.appendChild(el('div', 'forms-open-title', f.title));
    if (f.description) info.appendChild(el('div', 'forms-open-desc', f.description));
    if (f.deadline) info.appendChild(el('div', 'forms-open-deadline',
      'Frist: ' + (typeof formatDaDate === 'function' ? formatDaDate(f.deadline) : f.deadline)));
    row.appendChild(info);
    const fillBtn = el('button', 'site-btn-primary', 'Udfyld');
    fillBtn.type = 'button';
    fillBtn.addEventListener('click', () => renderFormFillIn(root, f.id));
    row.appendChild(fillBtn);
    listWrap.appendChild(row);
  }
}

// ── Revyst: fill in + submit one form ────────────────────────
async function renderFormFillIn(root, formId) {
  root.replaceChildren();
  const card = el('section', 'card forms-form');
  const backBtn = el('button', 'btn-small', '← Tilbage til formularer');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => renderFormsList(root));
  card.appendChild(backBtn);

  const body = el('div', null, 'Henter formular …');
  card.appendChild(body);
  root.appendChild(card);

  const result = await formsApi('forms_get', { formId });
  body.replaceChildren();
  if (!result.ok) {
    body.appendChild(el('p', 'forms-msg error', result.message || 'Kunne ikke hente formularen.'));
    return;
  }
  const form = result.data;
  body.appendChild(el('h2', null, form.title));
  if (form.description) body.appendChild(el('p', 'forms-intro', form.description));

  // One "page" per section — the form's own top-level fields count as page
  // 1 (its Titel/Beskrivelse are already the fixed header above, so it
  // carries no extra heading of its own); each further section is its own
  // page with the same shape (title, description, fields). Multi-page forms
  // are paged with prev/next arrows at the bottom, same idea as Manus's
  // point-entry modal (openPointEntryModal) paging between sheets — except
  // this lives inline on the page, not in a modal, so it uses .btn-small
  // rather than that modal's .site-pill-btn (see the site-wide button-tier
  // convention). All pages render up front and are just hidden/shown, so
  // native input values survive navigating back and forth for free.
  const pageDefs = [{ title: null, description: null, fields: Array.isArray(form.fields) ? form.fields : [] }];
  for (const section of (Array.isArray(form.sections) ? form.sections : [])) {
    pageDefs.push({
      title: section.title || null, description: section.description || null,
      fields: Array.isArray(section.fields) ? section.fields : [],
    });
  }

  const inputs = []; // { field, input, page }
  const pageEls = pageDefs.map((pageDef, pageIdx) => {
    const pageEl = el('div', 'forms-fillin-page');
    if (pageDef.title) pageEl.appendChild(el('h3', 'forms-fillin-section-title', pageDef.title));
    if (pageDef.description) pageEl.appendChild(el('p', 'forms-intro', pageDef.description));
    for (const field of pageDef.fields) {
      const input = formsRenderAnswerInput(field);
      const labelText = field.label + (field.required ? ' *' : '');
      pageEl.appendChild(siteEditField(labelText, input));
      inputs.push({ field, input, page: pageIdx });
    }
    body.appendChild(pageEl);
    return pageEl;
  });

  const msg = el('div', 'forms-msg');
  body.appendChild(msg);
  function setMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'forms-msg' + (kind ? ' ' + kind : '');
  }

  const submitBtn = el('button', 'site-btn-primary', 'Send svar');
  submitBtn.type = 'button';
  submitBtn.addEventListener('click', async () => {
    const answers = {};
    for (const { field, input, page } of inputs) {
      const value = input.formsValue();
      if (field.required) {
        const empty = value == null || value === '' || (Array.isArray(value) && value.length === 0);
        if (empty) {
          showPage(page);
          return setMsg(`Udfyld "${field.label}".`, 'error');
        }
      }
      answers[field.id] = value;
    }
    submitBtn.disabled = true;
    setMsg('Sender …', null);
    const res = await formsApi('forms_submit', { formId, answers });
    submitBtn.disabled = false;
    if (res.ok) {
      setMsg('Tak! Dit svar er sendt.', 'ok');
      for (const { input } of inputs) {
        if (input.tagName === 'TEXTAREA' || input.tagName === 'INPUT') input.value = '';
        else if ('value' in input) input.value = '';
        else if (input.classList && input.classList.contains('forms-checkbox-list')) {
          input.querySelectorAll('input[type=checkbox]').forEach((cb) => { cb.checked = false; });
        }
      }
      submitBtn.disabled = true;
      showPage(0);
    } else if (res.message) {
      setMsg(res.message, 'error');
    } else {
      setMsg('', null); // cancelled password prompt
    }
  });

  let currentPage = 0;
  let nav = null;
  function renderNav() {
    if (nav) nav.remove();
    if (pageEls.length <= 1) {
      body.appendChild(submitBtn);
      nav = null;
      return;
    }
    nav = el('div', 'forms-fillin-nav-row');
    const navGroup = el('div', 'forms-fillin-nav-group');
    const prevBtn = el('button', 'btn-small', '‹ Forrige');
    prevBtn.type = 'button';
    prevBtn.disabled = currentPage === 0;
    prevBtn.addEventListener('click', () => showPage(currentPage - 1));
    navGroup.appendChild(prevBtn);
    navGroup.appendChild(el('span', 'forms-fillin-page-label', `Sektion ${currentPage + 1}/${pageEls.length}`));
    if (currentPage === pageEls.length - 1) {
      navGroup.appendChild(submitBtn);
    } else {
      const nextBtn = el('button', 'btn-small', 'Næste ›');
      nextBtn.type = 'button';
      nextBtn.addEventListener('click', () => showPage(currentPage + 1));
      navGroup.appendChild(nextBtn);
    }
    nav.appendChild(navGroup);
    body.appendChild(nav);
  }
  function showPage(idx) {
    currentPage = idx;
    pageEls.forEach((pageEl, i) => { pageEl.style.display = i === currentPage ? '' : 'none'; });
    renderNav();
  }
  showPage(0);
}

// ── Boss/admin: management view ──────────────────────────────
// Three screens, all rendered directly into `root` (never a modal) so the
// whole admin flow reads as one page: 'overview' (dashboard table),
// 'builder' (create/edit a form, folding in the old template picker/
// manager modals), 'responses' (one form's answers + CSV export). Only
// 'overview'/'builder' sit behind the tab bar — 'responses' is entered from
// a row action and left via its own back button, mirroring the revyst-side
// renderFormFillIn's in-page back pattern.
function renderAdminView(root, screen) {
  screen = screen || { name: 'overview' };
  if (screen.name === 'responses') {
    formsRenderResponsesScreen(root, screen.formId);
    return;
  }

  root.replaceChildren();
  const tabs = el('div', 'forms-admin-tabs');
  const overviewTab = el('button', 'forms-admin-tab' + (screen.name === 'overview' ? ' active' : ''), 'Oversigt');
  overviewTab.type = 'button';
  overviewTab.addEventListener('click', () => renderAdminView(root, { name: 'overview' }));
  const builderTab = el('button', 'forms-admin-tab' + (screen.name === 'builder' ? ' active' : ''),
    screen.name === 'builder' && screen.existingDefinition ? 'Rediger formular' : 'Ny formular');
  builderTab.type = 'button';
  builderTab.addEventListener('click', () => renderAdminView(root, { name: 'builder' }));
  tabs.appendChild(overviewTab);
  tabs.appendChild(builderTab);
  root.appendChild(tabs);

  if (screen.name === 'builder') {
    formsRenderBuilderScreen(root, screen.existingDefinition || null);
  } else {
    formsRenderOverviewScreen(root);
  }
}

async function formsRenderOverviewScreen(root) {
  const card = el('section', 'card');
  card.appendChild(el('h2', null, 'Formularer'));
  const tableWrap = el('div', null, 'Henter formularer …');
  card.appendChild(tableWrap);
  root.appendChild(card);

  const result = await formsApi('forms_admin_list', {});
  tableWrap.replaceChildren();
  if (!result.ok) {
    if (result.message) tableWrap.appendChild(el('p', 'forms-msg error', result.message));
    return;
  }
  const forms = Array.isArray(result.data.forms) ? result.data.forms : [];
  if (forms.length === 0) {
    tableWrap.appendChild(el('p', 'forms-intro', 'Ingen formularer endnu. Opret den første under fanen "Ny formular".'));
    return;
  }

  const table = el('table', 'forms-dashboard-table');
  const thead = el('thead');
  const headRow = el('tr');
  ['Titel', 'Status', 'Frist', 'Svar', ''].forEach((h) => headRow.appendChild(el('th', null, h)));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const f of forms) {
    const row = el('tr');
    row.appendChild(el('td', null, f.title));

    const statusCell = el('td');
    const statusChip = el('button', 'forms-status-chip forms-status-' + f.status,
      f.status === 'open' ? 'Åben' : 'Lukket');
    statusChip.type = 'button';
    statusChip.title = 'Klik for at ' + (f.status === 'open' ? 'lukke' : 'åbne') + ' formularen';
    statusChip.addEventListener('click', async () => {
      statusChip.disabled = true;
      const full = await formsApi('forms_admin_read', { formId: f.id });
      if (full.ok) {
        const def = full.data.definition;
        await formsApi('forms_save', {
          id: f.id, title: def.title, description: def.description,
          status: f.status === 'open' ? 'closed' : 'open', deadline: def.deadline,
          productionYear: def.productionYear, fromTemplateId: def.fromTemplateId,
          fields: def.fields, sections: def.sections || [],
        });
      }
      renderAdminView(root, { name: 'overview' });
    });
    statusCell.appendChild(statusChip);
    row.appendChild(statusCell);

    row.appendChild(el('td', null, f.deadline
      ? (typeof formatDaDate === 'function' ? formatDaDate(f.deadline) : f.deadline) : '—'));
    row.appendChild(el('td', null, String(f.responseCount)));

    const actionsCell = el('td', 'forms-row-actions');
    const editBtn = el('button', 'btn-small', 'Rediger');
    editBtn.type = 'button';
    editBtn.addEventListener('click', async () => {
      const full = await formsApi('forms_admin_read', { formId: f.id });
      if (full.ok) renderAdminView(root, { name: 'builder', existingDefinition: full.data.definition });
    });
    const respBtn = el('button', 'btn-small', 'Se svar');
    respBtn.type = 'button';
    respBtn.addEventListener('click', () => renderAdminView(root, { name: 'responses', formId: f.id }));
    const delBtn = el('button', 'btn-small btn-small-danger', 'Slet');
    delBtn.type = 'button';
    delBtn.addEventListener('click', () => formsOpenDeleteConfirm(root, f));
    actionsCell.appendChild(editBtn);
    actionsCell.appendChild(respBtn);
    actionsCell.appendChild(delBtn);
    row.appendChild(actionsCell);

    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  tableWrap.appendChild(table);
}

function formsOpenDeleteConfirm(root, f) {
  const { form, error, actions, close } = siteOpenModalWithClose('Slet formular');
  form.appendChild(el('p', 'forms-intro',
    `Slet "${f.title}" permanent, inklusive alle ${f.responseCount} indsendte svar? Dette kan ikke fortrydes.`));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const result = await formsApi('forms_delete', { formId: f.id });
    if (result.ok) {
      close();
      renderAdminView(root, { name: 'overview' });
    } else {
      confirmBtn.disabled = false;
      if (result.message) error.textContent = result.message;
    }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Field-list editor (shared by the form builder and template editor) ──
// Renders into `listEl` an editable list of FieldSpec-shaped draft objects
// (`draftFields`, mutated in place) with add/remove/reorder controls. No
// drag-and-drop in v1 — plain up/down buttons are simpler and much lower
// implementation risk for a handful of fields per form.
function formsRenderFieldEditor(listEl, draftFields, onChange) {
  listEl.replaceChildren();
  draftFields.forEach((field, idx) => {
    listEl.appendChild(formsRenderFieldRow(field, idx, draftFields, listEl, onChange));
  });
  const addBtn = el('button', 'btn-small', '+ Tilføj felt');
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    draftFields.push({ id: formsNewFieldId(), type: 'text', label: '', required: false });
    formsRenderFieldEditor(listEl, draftFields, onChange);
    onChange();
  });
  listEl.appendChild(addBtn);
}

function formsRenderFieldRow(field, idx, draftFields, listEl, onChange) {
  const row = el('div', 'forms-field-row');

  const topRow = el('div', 'forms-field-row-top');
  const typeDd = siteCreateDropdownField(FORMS_FIELD_TYPES, field.type);
  typeDd.addEventListener('change', () => {
    field.type = typeDd.value;
    if (field.type !== 'select' && field.type !== 'checkboxes') {
      delete field.optionsSource; delete field.options; delete field.sourceFilter;
    } else if (!field.optionsSource) {
      field.optionsSource = 'manual'; field.options = [];
    }
    formsRenderFieldEditor(listEl, draftFields, onChange);
    onChange();
  });
  topRow.appendChild(typeDd);

  const labelInput = el('input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Spørgsmål';
  labelInput.value = field.label || '';
  labelInput.addEventListener('input', () => { field.label = labelInput.value; onChange(); });
  topRow.appendChild(labelInput);

  const reqLabel = el('label', 'forms-required-label');
  const reqBox = document.createElement('input');
  reqBox.type = 'checkbox';
  reqBox.checked = !!field.required;
  reqBox.addEventListener('change', () => { field.required = reqBox.checked; onChange(); });
  reqLabel.appendChild(reqBox);
  reqLabel.appendChild(document.createTextNode('Påkrævet'));
  topRow.appendChild(reqLabel);

  const upBtn = el('button', 'btn-small', '↑');
  upBtn.type = 'button';
  upBtn.disabled = idx === 0;
  upBtn.addEventListener('click', () => {
    [draftFields[idx - 1], draftFields[idx]] = [draftFields[idx], draftFields[idx - 1]];
    formsRenderFieldEditor(listEl, draftFields, onChange);
    onChange();
  });
  const downBtn = el('button', 'btn-small', '↓');
  downBtn.type = 'button';
  downBtn.disabled = idx === draftFields.length - 1;
  downBtn.addEventListener('click', () => {
    [draftFields[idx + 1], draftFields[idx]] = [draftFields[idx], draftFields[idx + 1]];
    formsRenderFieldEditor(listEl, draftFields, onChange);
    onChange();
  });
  const removeBtn = el('button', 'btn-small btn-small-danger', '✕');
  removeBtn.type = 'button';
  removeBtn.addEventListener('click', () => {
    draftFields.splice(idx, 1);
    formsRenderFieldEditor(listEl, draftFields, onChange);
    onChange();
  });
  topRow.appendChild(upBtn);
  topRow.appendChild(downBtn);
  topRow.appendChild(removeBtn);
  row.appendChild(topRow);

  if (field.type === 'select' || field.type === 'checkboxes') {
    row.appendChild(formsRenderOptionsEditor(field, onChange));
  }

  return row;
}

function formsRenderOptionsEditor(field, onChange) {
  const wrap = el('div', 'forms-options-editor');
  const sourceDd = siteCreateDropdownField([
    { value: 'manual', label: 'Skriv selv' },
    { value: 'scenes', label: 'Scener (live)' },
    { value: 'rehearsals', label: 'Prøver/kalender (live)' },
  ], field.optionsSource || 'manual');
  wrap.appendChild(siteEditField('Valgmuligheder fra', sourceDd));

  const bodyWrap = el('div');
  wrap.appendChild(bodyWrap);

  function renderBody() {
    bodyWrap.replaceChildren();
    if (field.optionsSource === 'manual') {
      const options = Array.isArray(field.options) ? field.options : (field.options = []);
      const optList = el('div', 'forms-option-list');
      options.forEach((opt, i) => {
        const optRow = el('div', 'forms-option-row');
        const valInput = el('input');
        valInput.type = 'text';
        valInput.placeholder = 'Værdi';
        valInput.value = opt.value || '';
        valInput.addEventListener('input', () => { opt.value = valInput.value; onChange(); });
        const labelInput = el('input');
        labelInput.type = 'text';
        labelInput.placeholder = 'Vist tekst';
        labelInput.value = opt.label || '';
        labelInput.addEventListener('input', () => { opt.label = labelInput.value; onChange(); });
        const rm = el('button', 'btn-small btn-small-danger', '✕');
        rm.type = 'button';
        rm.addEventListener('click', () => { options.splice(i, 1); renderBody(); onChange(); });
        optRow.appendChild(valInput);
        optRow.appendChild(labelInput);
        optRow.appendChild(rm);
        optList.appendChild(optRow);
      });
      bodyWrap.appendChild(optList);
      const addOpt = el('button', 'btn-small', '+ Tilføj valgmulighed');
      addOpt.type = 'button';
      addOpt.addEventListener('click', () => {
        options.push({ value: '', label: '' });
        renderBody();
        onChange();
      });
      bodyWrap.appendChild(addOpt);
    } else {
      // Live-sourced — show a read-only preview of what will be offered.
      if (field.optionsSource === 'scenes') {
        const onlyRow = el('label', 'forms-required-label');
        const onlyBox = document.createElement('input');
        onlyBox.type = 'checkbox';
        onlyBox.checked = !!(field.sourceFilter && field.sourceFilter.schedulableOnly);
        onlyBox.addEventListener('change', () => {
          field.sourceFilter = { schedulableOnly: onlyBox.checked };
          onChange();
          renderPreview();
        });
        onlyRow.appendChild(onlyBox);
        onlyRow.appendChild(document.createTextNode('Kun scener der kan øves'));
        bodyWrap.appendChild(onlyRow);
      } else if (field.optionsSource === 'rehearsals') {
        const catOptions = [{ value: '', label: 'Alle kategorier' },
          ...Object.entries(FORMS_CAL_CATEGORIES).map(([key, def]) => ({ value: key, label: def.label }))];
        const catDd = siteCreateDropdownField(catOptions, (field.sourceFilter && field.sourceFilter.category) || '');
        catDd.addEventListener('change', () => {
          field.sourceFilter = catDd.value ? { category: catDd.value } : null;
          onChange();
          renderPreview();
        });
        bodyWrap.appendChild(siteEditField('Kun kategori', catDd));
      }
      const preview = el('div', 'forms-options-preview');
      bodyWrap.appendChild(preview);
      function renderPreview() {
        const opts = formsResolveOptions(field);
        preview.textContent = opts.length
          ? 'Viser lige nu: ' + opts.map((o) => o.label).join(', ')
          : 'Ingen muligheder fundet lige nu.';
      }
      renderPreview();
    }
  }
  renderBody();

  sourceDd.addEventListener('change', () => {
    field.optionsSource = sourceDd.value;
    if (field.optionsSource === 'manual' && !Array.isArray(field.options)) field.options = [];
    if (field.optionsSource !== 'manual') delete field.options;
    if (field.optionsSource === 'manual') delete field.sourceFilter;
    renderBody();
    onChange();
  });

  return wrap;
}

// Shared by both save paths in the builder modal: trims labels and drops
// half-filled manual option rows before anything is sent to the server, so
// "Gem som skabelon" validates identically to "Gem formular" instead of
// surfacing the raw server-side invalid_field error.
function formsValidateAndCleanFields(draftFields) {
  for (const f of draftFields) {
    if (!f.label || !f.label.trim()) return { error: 'Alle felter skal have et spørgsmål.' };
    if ((f.type === 'select' || f.type === 'checkboxes') && f.optionsSource === 'manual'
        && (!f.options || f.options.filter((o) => o.value && o.label).length === 0)) {
      return { error: `Tilføj mindst én valgmulighed til "${f.label}".` };
    }
  }
  return {
    fields: draftFields.map((f) => ({
      id: f.id, type: f.type, label: f.label.trim(), required: !!f.required,
      ...(f.optionsSource ? { optionsSource: f.optionsSource } : {}),
      ...(f.options ? { options: f.options.filter((o) => o.value && o.label) } : {}),
      ...(f.sourceFilter !== undefined ? { sourceFilter: f.sourceFilter } : {}),
    })),
  };
}

// Same idea as formsValidateAndCleanFields, one level up: each extra
// section (beyond the form's own Titel/Beskrivelse/Felter, which reads as
// "section 1") needs its own non-empty title before it's worth saving, and
// its fields go through the exact same cleanup as the top-level list.
function formsValidateAndCleanSections(draftSections) {
  const sections = [];
  for (const s of draftSections) {
    const title = (s.title || '').trim();
    if (!title) return { error: 'Alle sektioner skal have en titel.' };
    const cleanedFields = formsValidateAndCleanFields(Array.isArray(s.fields) ? s.fields : []);
    if (cleanedFields.error) return { error: cleanedFields.error };
    sections.push({ id: s.id, title, description: (s.description || '').trim(), fields: cleanedFields.fields });
  }
  return { sections };
}

// ── Builder screen (Ny formular / Rediger formular tab) ──────
// Renders directly into `root` — no modal — so the whole create/edit flow
// lives in the page. Folds in what used to be two separate modals (start
// from / manage templates) into one dropdown menu, and supports extra
// "sections" beyond the form's own Titel/Beskrivelse/Felter (which reads as
// section 1) — each with its own title/description/fields.
function formsRenderBuilderScreen(root, existingDefinition) {
  const isEdit = !!(existingDefinition && existingDefinition.id);
  const card = el('section', 'card forms-builder-card');
  root.appendChild(card);

  const head = el('div', 'forms-builder-head');
  head.appendChild(el('h2', null, isEdit ? 'Rediger formular' : 'Ny formular'));
  card.appendChild(head);

  const draftFields = existingDefinition
    ? JSON.parse(JSON.stringify(existingDefinition.fields || []))
    : [];
  const draftSections = existingDefinition
    ? JSON.parse(JSON.stringify(existingDefinition.sections || []))
    : [];
  // A from-scratch form gets one starting field so the editor isn't empty.
  if (draftFields.length === 0 && draftSections.length === 0 && !existingDefinition) {
    draftFields.push({ id: formsNewFieldId(), type: 'text', label: 'Navn', required: true });
  }

  let fieldListEl; // top-level field editor, assigned below
  let sectionsListEl; // extra-sections container, assigned below
  const error = el('p', 'forms-msg error');

  function renderSectionsList() {
    sectionsListEl.replaceChildren();
    draftSections.forEach((section, idx) => {
      sectionsListEl.appendChild(formsRenderSectionBlock(section, idx, draftSections,
        () => { error.textContent = ''; }, renderSectionsList));
    });
  }

  if (!existingDefinition) {
    head.appendChild(formsRenderTemplateMenu((template) => {
      draftFields.splice(0, draftFields.length, ...JSON.parse(JSON.stringify(template.fields || [])));
      draftSections.splice(0, draftSections.length, ...JSON.parse(JSON.stringify(template.sections || [])));
      if (template.description) descInput.value = template.description;
      formsRenderFieldEditor(fieldListEl, draftFields, () => { error.textContent = ''; });
      renderSectionsList();
      error.textContent = '';
    }));
  }

  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.value = existingDefinition ? existingDefinition.title : '';
  card.appendChild(siteEditField('Titel', titleInput));

  const descInput = el('textarea');
  descInput.rows = 2;
  descInput.value = existingDefinition ? existingDefinition.description || '' : '';
  card.appendChild(siteEditField('Beskrivelse', descInput));

  // Status/Frist/Produktionsår are form-level metadata, not per-section —
  // shown once, in one row, alongside the form's own (= "section 1"'s)
  // Titel/Beskrivelse/Felter.
  const metaRow = el('div', 'edit-field-row');
  const statusDd = siteCreateDropdownField(
    [{ value: 'closed', label: 'Lukket' }, { value: 'open', label: 'Åben' }],
    existingDefinition ? existingDefinition.status : 'closed');
  metaRow.appendChild(siteEditField('Status', statusDd));

  const deadlineField = siteCreateDateField(existingDefinition ? existingDefinition.deadline : '');
  metaRow.appendChild(siteEditField('Frist (valgfri)', deadlineField));

  const yearInput = el('input');
  yearInput.type = 'text';
  yearInput.inputMode = 'numeric';
  yearInput.placeholder = 'fx 2026';
  yearInput.value = existingDefinition && existingDefinition.productionYear != null
    ? String(existingDefinition.productionYear) : '';
  metaRow.appendChild(siteEditField('Produktionsår (valgfri)', yearInput));
  card.appendChild(metaRow);

  card.appendChild(el('h3', null, 'Felter'));
  fieldListEl = el('div', 'forms-field-list');
  card.appendChild(fieldListEl);
  formsRenderFieldEditor(fieldListEl, draftFields, () => { error.textContent = ''; });

  sectionsListEl = el('div', 'forms-sections-list');
  card.appendChild(sectionsListEl);
  renderSectionsList();

  const addSectionBtn = el('button', 'btn-small', '+ Tilføj sektion');
  addSectionBtn.type = 'button';
  addSectionBtn.addEventListener('click', () => {
    draftSections.push({
      id: formsNewFieldId(), title: '', description: '',
      fields: [{ id: formsNewFieldId(), type: 'text', label: '', required: false }],
    });
    renderSectionsList();
    error.textContent = '';
  });
  card.appendChild(addSectionBtn);

  card.appendChild(error);

  const actionsRow = el('div', 'forms-builder-actions');

  const saveAsTemplateBtn = el('button', 'btn-small', 'Gem som skabelon');
  saveAsTemplateBtn.type = 'button';
  saveAsTemplateBtn.addEventListener('click', () => {
    error.textContent = '';
    const cleanedFields = formsValidateAndCleanFields(draftFields);
    if (cleanedFields.error) { error.textContent = cleanedFields.error; return; }
    const cleanedSections = formsValidateAndCleanSections(draftSections);
    if (cleanedSections.error) { error.textContent = cleanedSections.error; return; }
    formsOpenSaveAsTemplateModal(titleInput.value, descInput.value, cleanedFields.fields, cleanedSections.sections);
  });

  const cancelBtn = el('button', 'btn-small', 'Annuller');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => renderAdminView(root, { name: 'overview' }));

  const saveBtn = el('button', 'site-btn-primary', 'Gem formular');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    error.textContent = '';
    const title = titleInput.value.trim();
    if (!title) { error.textContent = 'Skriv en titel.'; return; }
    const cleanedFields = formsValidateAndCleanFields(draftFields);
    if (cleanedFields.error) { error.textContent = cleanedFields.error; return; }
    const cleanedSections = formsValidateAndCleanSections(draftSections);
    if (cleanedSections.error) { error.textContent = cleanedSections.error; return; }
    const productionYear = yearInput.value.trim() ? parseInt(yearInput.value.trim(), 10) : null;
    saveBtn.disabled = true;
    const payload = {
      title, description: descInput.value.trim(), status: statusDd.value,
      deadline: deadlineField.value || null, productionYear,
      fromTemplateId: existingDefinition ? (existingDefinition.fromTemplateId || null) : null,
      fields: cleanedFields.fields, sections: cleanedSections.sections,
    };
    if (isEdit) payload.id = existingDefinition.id;
    const result = await formsApi('forms_save', payload);
    saveBtn.disabled = false;
    if (result.ok) {
      renderAdminView(root, { name: 'overview' });
    } else if (result.message) {
      error.textContent = result.message;
    }
  });

  actionsRow.appendChild(saveAsTemplateBtn);
  actionsRow.appendChild(cancelBtn);
  actionsRow.appendChild(saveBtn);
  card.appendChild(actionsRow);
}

// One extra section's editor block: its own Titel/Beskrivelse, a Felter
// list built on the exact same formsRenderFieldEditor as the top-level
// list (it's already generic over whatever array it's handed), and a
// "Slet sektion" that removes it and re-renders the whole sections list
// (so later sections re-number correctly).
function formsRenderSectionBlock(section, idx, draftSections, onChange, rerenderAll) {
  const block = el('div', 'forms-section-block');

  const head = el('div', 'forms-section-head');
  head.appendChild(el('h4', null, 'Sektion ' + (idx + 2)));
  const removeBtn = el('button', 'btn-small btn-small-danger', 'Slet sektion');
  removeBtn.type = 'button';
  removeBtn.addEventListener('click', () => {
    draftSections.splice(idx, 1);
    rerenderAll();
    onChange();
  });
  head.appendChild(removeBtn);
  block.appendChild(head);

  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Sektionstitel';
  titleInput.value = section.title || '';
  titleInput.addEventListener('input', () => { section.title = titleInput.value; onChange(); });
  block.appendChild(siteEditField('Titel', titleInput));

  const descInput = el('textarea');
  descInput.rows = 2;
  descInput.value = section.description || '';
  descInput.addEventListener('input', () => { section.description = descInput.value; onChange(); });
  block.appendChild(siteEditField('Beskrivelse', descInput));

  block.appendChild(el('h4', null, 'Felter'));
  const fieldListEl = el('div', 'forms-field-list');
  block.appendChild(fieldListEl);
  if (!Array.isArray(section.fields)) section.fields = [];
  formsRenderFieldEditor(fieldListEl, section.fields, onChange);

  return block;
}

// ── Template menu ("Skabelon" dropdown, top-right of a new form) ─────
// Replaces the old separate "Opret fra skabelon"/"Skabeloner" modals with
// one dropdown: each row applies the template (fields + sections +
// description) to the current draft; a grey ✕ opens a small delete-confirm
// instead, mirroring formsOpenDeleteConfirm's own pattern for forms.
function formsRenderTemplateMenu(onUse) {
  const btn = el('button', 'btn-small forms-template-menu-btn', 'Skabelon ▾');
  btn.type = 'button';
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const result = await formsApi('templates_list', {});
    btn.disabled = false;
    const templates = result.ok && Array.isArray(result.data.templates) ? result.data.templates : [];
    formsOpenTemplateMenuPopup(btn, templates, result, onUse);
  });
  return btn;
}

function formsOpenTemplateMenuPopup(anchor, templates, result, onUse) {
  const pop = el('div', 'site-field-pop forms-template-menu-pop');
  if (!result.ok) {
    pop.appendChild(el('p', 'forms-msg error', result.message || 'Kunne ikke hente skabeloner.'));
  } else if (templates.length === 0) {
    pop.appendChild(el('p', 'forms-intro', 'Ingen skabeloner endnu.'));
  } else {
    for (const t of templates) {
      const row = el('div', 'forms-template-menu-row');
      const useBtn = el('button', 'site-list-row forms-template-menu-use');
      useBtn.type = 'button';
      useBtn.appendChild(el('div', 'forms-template-menu-title', t.title));
      if (t.description) useBtn.appendChild(el('div', 'forms-template-menu-desc', t.description));
      useBtn.addEventListener('click', () => { close(); onUse(t); });
      const delBtn = el('button', 'boss-edit-remove', '✕');
      delBtn.type = 'button';
      delBtn.title = 'Slet skabelon';
      delBtn.addEventListener('click', () => { close(); formsOpenDeleteTemplateConfirm(t); });
      row.appendChild(useBtn);
      row.appendChild(delBtn);
      pop.appendChild(row);
    }
  }
  const close = siteOpenFieldPopup(anchor, pop);
}

function formsOpenDeleteTemplateConfirm(t) {
  const { form, error, actions, close } = siteOpenModalWithClose('Slet skabelon');
  form.appendChild(el('p', 'forms-intro', `Slet skabelonen "${t.title}" permanent? Dette kan ikke fortrydes.`));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-pill-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const result = await formsApi('templates_delete', { id: t.id });
    if (result.ok) { close(); siteShowToast('Skabelon slettet.'); }
    else { confirmBtn.disabled = false; if (result.message) error.textContent = result.message; }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// Small modal just for naming (and now describing) a new template —
// replaces a bare window.prompt() (previously the only non-password
// prompt() on the site) with the same styled edit-field/pill-button chrome
// every other confirm dialog uses.
function formsOpenSaveAsTemplateModal(suggestedTitle, suggestedDescription, fields, sections) {
  const { form, error, actions, close } = siteOpenModalWithClose('Gem som skabelon');
  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = suggestedTitle || '';
  form.appendChild(siteEditField('Navn på skabelon', nameInput));

  const descInput = el('textarea');
  descInput.rows = 2;
  descInput.value = suggestedDescription || '';
  form.appendChild(siteEditField('Beskrivelse', descInput));

  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Gem', 'site-pill-primary');
  confirmBtn.addEventListener('click', async () => {
    const title = nameInput.value.trim();
    if (!title) { error.textContent = 'Skriv et navn.'; return; }
    confirmBtn.disabled = true;
    const result = await formsApi('templates_save',
      { title, description: descInput.value.trim(), fields, sections });
    confirmBtn.disabled = false;
    if (result.ok) { close(); siteShowToast('Skabelon gemt.'); }
    else if (result.message) error.textContent = result.message;
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  nameInput.focus();
}

// ── Responses screen ("Se svar" row action) + CSV export ─────
// Rendered directly into `root`, mirroring renderFormFillIn's in-page
// back-button pattern rather than opening a modal — a response table can
// get wide/long, which a small modal never suited well.
async function formsRenderResponsesScreen(root, formId) {
  root.replaceChildren();
  const card = el('section', 'card');
  const backBtn = el('button', 'btn-small', '← Tilbage til oversigt');
  backBtn.type = 'button';
  backBtn.addEventListener('click', () => renderAdminView(root, { name: 'overview' }));
  card.appendChild(backBtn);

  const body = el('div', null, 'Henter svar …');
  card.appendChild(body);
  root.appendChild(card);

  const result = await formsApi('forms_admin_read', { formId });
  body.replaceChildren();
  if (!result.ok) {
    body.appendChild(el('p', 'forms-msg error', result.message || 'Kunne ikke hente svar.'));
    return;
  }
  const definition = result.data.definition;
  const responses = Array.isArray(result.data.responses) ? result.data.responses : [];
  body.appendChild(el('h2', null, definition.title));

  if (responses.length === 0) {
    body.appendChild(el('p', 'forms-intro', 'Ingen svar endnu.'));
    return;
  }

  const fields = formsAllFields(definition);
  const wrap = el('div', 'forms-responses-wrap');
  const table = el('table', 'forms-responses-table');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th', null, 'Sendt'));
  fields.forEach((f) => headRow.appendChild(el('th', null, f.label)));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const r of responses) {
    const row = el('tr');
    row.appendChild(el('td', null,
      typeof formatDaDateTime === 'function' ? formatDaDateTime(r.submittedAt) : r.submittedAt));
    for (const f of fields) {
      const v = r.answers ? r.answers[f.id] : undefined;
      row.appendChild(el('td', null, formsFormatAnswerForDisplay(v)));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);

  const exportBtn = el('button', 'btn-small', 'Eksportér CSV');
  exportBtn.type = 'button';
  exportBtn.addEventListener('click', () => formsExportCsv(definition, responses));
  body.appendChild(exportBtn);
}

// One flat, ordered field list — top-level fields first, then each
// section's in turn — for anything that needs a column per question
// regardless of which section asked it (the responses table, CSV export).
// A submitted answer is still one flat {fieldId: value} map either way.
function formsAllFields(definition) {
  const fields = Array.isArray(definition.fields) ? definition.fields.slice() : [];
  for (const section of (Array.isArray(definition.sections) ? definition.sections : [])) {
    if (Array.isArray(section.fields)) fields.push(...section.fields);
  }
  return fields;
}

function formsFormatAnswerForDisplay(v) {
  if (v === undefined || v === null) return '—';
  if (Array.isArray(v)) return v.join(', ');
  if (v === true) return 'Ja';
  if (v === false) return 'Nej';
  return String(v);
}

function formsCsvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function formsExportCsv(definition, responses) {
  const fields = formsAllFields(definition);
  const headers = ['Sendt', ...fields.map((f) => f.label)];
  const lines = [headers.map(formsCsvEscape).join(',')];
  for (const r of responses) {
    const row = [r.submittedAt, ...fields.map((f) => formsFormatAnswerForDisplay(r.answers ? r.answers[f.id] : undefined))];
    lines.push(row.map(formsCsvEscape).join(','));
  }
  const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = (definition.title || 'formular').replace(/[^a-z0-9æøå_-]+/gi, '_') + '.csv';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// ── Init ─────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  const root = document.getElementById('forms-root');
  if (!root) return;
  // The page gate (site.js) already hides <main> for public visitors.
  if (typeof siteHasLevel === 'function' && siteHasLevel('boss')) {
    renderAdminView(root);
  } else if (typeof siteHasLevel === 'function' && siteHasLevel('revyst')) {
    renderFormsList(root);
  }
});
