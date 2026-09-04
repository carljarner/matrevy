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

   select/checkboxes options are always manually typed in the builder now
   — but a field's optionsSource can still be "scenes"/"rehearsals" if it
   was created before that picker was removed, in which case its options
   still resolve LIVE from this site's own public data (SCENES_DATA/
   CALENDAR_DATA, embedded via scenes-data.js/calendar-data.js) at render
   time, same as always; only the ability to create a new one that way
   is gone.

   Rendering rule (as elsewhere): createElement/textContent only, never
   innerHTML.
   ========================================================= */

'use strict';

// ── Field type palette ───────────────────────────────────────
// "yesno" is deliberately gone from this picker (no longer offered for a
// new question) but formsRenderAnswerInput/forms_validate_answer still
// support it server- and client-side, so any already-saved yesno field
// keeps working — only the ability to create a new one is removed.
const FORMS_FIELD_TYPES = [
  { value: 'text',        label: 'Kort svar' },
  { value: 'textarea',    label: 'Langt svar' },
  { value: 'select',      label: 'Vælg én' },
  { value: 'checkboxes',  label: 'Vælg flere' },
  { value: 'scale',       label: 'Skala' },
  { value: 'grid_single', label: 'Gitter (vælg én)' },
  { value: 'grid_multi',  label: 'Gitter (vælg flere)' },
];

// ── Statistik: categorical palette for the "Vælg én" pie/donut chart ──
// The only chart in this view that needs multiple hues — bar charts (Vælg
// flere/Skala/Gitter) show one question's own magnitude, not a comparison
// between distinct series, so they stay in the single site --accent hue
// instead. This 8-hue order is validated (CVD + normal-vision + lightness
// band all PASS) against this site's actual warm-cream card surface
// (#f1e6cf, not a generic white) via the dataviz skill's palette
// validator; the contrast-vs-surface WARN it carries is why option labels
// are always plain text next to a swatch, never colored text themselves.
const FORMS_STATS_PALETTE = [
  '#2a78d6', '#eb6834', '#1baf7a', '#eda100',
  '#e87ba4', '#008300', '#4a3aa7', '#e34948',
];

// ── Dynamic templates ────────────────────────────────────────
// Unlike a real (stored) template, a "dynamic" one isn't a frozen field
// snapshot — clicking it runs `generate()` fresh against the site's own
// current public data and hands the result straight into the same
// apply-a-template path a stored template goes through (see
// formsOpenTemplateMenuPopup below). This is what keeps e.g. Rolleønsker
// from going stale when scenes.json changes production to production.
const FORMS_DYNAMIC_TEMPLATES = [
  {
    id: 'rolleonsker',
    title: 'Rolleønsker',
    description: 'Genereres ud fra aktfordeling',
    generate: formsGenerateRolleonskerSections,
  },
  {
    id: 'fravaer',
    title: 'Fravær',
    description: 'Genereres ud fra øvere i kalenderen',
    generate: formsGenerateFravaerSections,
  },
];

// ── Revy helpers (the form's Revy field, Oversigt year filter) ──────
// CONFIG_DATA (config-data.js, the same embed manus.js/koordinator.js read
// currentProductionFolder from) names the year currently in production,
// e.g. "MatRevy_2026" → 2026 — used as the default selection for a brand
// new form (below), not as the floor of what's selectable (see
// FORMS_MIN_PRODUCTION_YEAR).
function formsCurrentProductionYear() {
  const folder = (typeof CONFIG_DATA !== 'undefined' && CONFIG_DATA.currentProductionFolder) || '';
  const m = folder.match(/\d{4}/);
  return m ? parseInt(m[0], 10) : new Date().getFullYear();
}

// Earliest year a form can target. Fixed at 2025 (MatRevy 2025) rather than
// derived from the current production year — Arkiv actually goes back to
// MatRevy 2004, but Formularer only exists to hold 2025 onward: 2025's own
// old Google Forms/responses get imported in retroactively, years before
// that don't.
const FORMS_MIN_PRODUCTION_YEAR = 2025;

// localStorage key for the Oversigt screen's own year filter (see
// formsRenderOverviewScreen) — mirrors calendar.js's CAL_VIEW_KEY.
const FORMS_YEAR_FILTER_KEY = 'matrevy-forms-year-filter';

// A form's Revy field picks from ARCHIVE_DATA (archive-data.js's embed of
// data/archive.json) — Arkiv already lists the current, not-yet-closed
// production ("MatRevy 2026" exists there today), so this is genuinely
// live: once Koordinator adds a new Arkiv entry for the next production,
// it shows up here too, with no code change. `existingYear` (an
// already-saved form's productionYear) is folded in even if Arkiv doesn't
// list it, so opening an old form for editing never shows a value the
// dropdown can't display.
function formsRevyOptions(existingYear) {
  const start = FORMS_MIN_PRODUCTION_YEAR;
  const entries = (typeof ARCHIVE_DATA !== 'undefined' && Array.isArray(ARCHIVE_DATA)) ? ARCHIVE_DATA : [];
  const opts = entries
    .filter((e) => typeof e.year === 'number' && e.year >= start)
    .sort((a, b) => b.year - a.year)
    .map((e) => ({ value: String(e.year), label: e.name || String(e.year) }));
  if (existingYear != null && !opts.some((o) => o.value === String(existingYear))) {
    opts.push({ value: String(existingYear), label: String(existingYear) });
    opts.sort((a, b) => parseInt(b.value, 10) - parseInt(a.value, 10));
  }
  return opts;
}

// Labels a plain year with its Revy name (e.g. 2026 → "MatRevy 2026") for
// the Oversigt year filter, which only has a bare year number to work
// with (a form's productionYear). Falls back to the year itself if Arkiv
// has no matching entry (a legacy form's year, or Arkiv not loaded).
function formsRevyNameForYear(year) {
  const entries = (typeof ARCHIVE_DATA !== 'undefined' && Array.isArray(ARCHIVE_DATA)) ? ARCHIVE_DATA : [];
  const match = entries.find((e) => e.year === year);
  return match && match.name ? match.name : String(year);
}

// ── Small DOM helper (mirrors budget.js's el()) ──────────────
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function formsPillBtn(label, variant) {
  const btn = el('button', variant || 'site-btn-warm', label);
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

// ── "Rolleønsker" dynamic template ────────────────────────────
// A bespoke 5-section layout (not a generic "one section per act" loop):
// a static intro section, one section per act with a hardcoded intro text
// (Akt 3's also folds in Ekstranumre — same fixed 4-act assumption
// js/manus.js's manusBuildActSkeleton makes), and a static closing
// section. Only the per-scene "Skala 1-5" questions inside the act
// sections are actually generated from SCENES_DATA; everything else
// (section text, the extra comment/checkbox/select fields) is fixed
// copy the boss asked for, so it comes back exactly the same way every
// time "Rolleønsker" is clicked. schedulable:false scenes (videos,
// bandsang — no rehearsable cast) are skipped entirely.
function formsGenerateRolleonskerSections() {
  const byAct = formsRolleonskerScenesByAct();
  const year = formsCurrentProductionYear();

  return [
    {
      id: formsNewFieldId(),
      title: `Rolleønsker MatRevy ${year}`,
      description: `Velkommen til Matrevy ${year}. Hvis du vil være på scenen, skal du svare på dette spørgeskema.`,
      fields: [
        { id: formsNewFieldId(), type: 'text', label: 'Fulde navn', required: true,
          placeholder: 'Der sker ikke noget, hvis du dropper et mellemnavn eller to' },
        { id: formsNewFieldId(), type: 'checkboxes', label: 'Jeg vil gerne', required: true,
          options: [
            { value: 'Danse', label: 'Danse' },
            { value: 'Synge (solo/kor)', label: 'Synge (solo/kor)' },
            { value: 'Skuespil', label: 'Skuespil' },
          ] },
      ],
    },
    {
      id: formsNewFieldId(),
      title: 'Akt 1',
      description: [
        'Denne skal du udfylde, hvis og kun hvis du er sceneperson.',
        'Ved hvert spørgsmål skal du vælge et tal mellem 1 og 5, som beskriver hvor meget du har lyst til at være med i det nummer. Hvis der er flere ting at lave i nummeret (forsanger/kor/danser/skuespiller/statist), vil der være flere spørgsmål til det.',
        'Rollefordelingen bliver lavet på baggrund af dine ønsker, men vi kan ikke trylle. Forvent derfor ikke at få alle de ting, du har givet mange point.',
        'Derudover anbefaler vi, at du bruger hele skalaen. Hvis du kun giver 1 og 5, så har vi ikke nogen ide om, hvad du allerhelst vil have, eller allermindst vil have.',
        'Endeligt kommer der en kommentar, hvor du i fritekst kan angive de numre, som du allerhelst vil være med i.',
      ].join('\n'),
      fields: [
        ...formsRolleonskerSceneFields(byAct['Akt 1'] || []),
        formsRolleonskerTextareaField('Kommentarer til dine ønsker i akt 1?', 'For eksempel roller du vil eller ikke vil have'),
      ],
    },
    {
      id: formsNewFieldId(),
      title: 'Akt 2',
      description: '',
      fields: [
        ...formsRolleonskerSceneFields(byAct['Akt 2'] || []),
        formsRolleonskerTextareaField('Kommentarer til dine ønsker i akt 2?', 'For eksempel roller du vil eller ikke vil have'),
      ],
    },
    {
      id: formsNewFieldId(),
      title: 'Akt 3',
      description: '',
      fields: [
        ...formsRolleonskerSceneFields(byAct['Akt 3'] || []),
        ...formsRolleonskerSceneFields(byAct['Ekstranumre'] || []),
        formsRolleonskerTextareaField('Kommentarer til dine ønsker i akt 3?', 'For eksempel roller du vil eller ikke vil have'),
        formsRolleonskerTextareaField('Hvad vil du aller helst lave?', 'Vælg fra alle akter, angiv 2-4 ting'),
      ],
    },
    {
      id: formsNewFieldId(),
      title: 'Tilmelding',
      description: '',
      fields: [
        { id: formsNewFieldId(), type: 'select', label: 'Har du husket at svare på tilmeldingsarket?', required: true,
          options: [
            { value: 'Ja da!', label: 'Ja da!' },
            { value: 'Nej, men jeg skynder mig at gøre det nu!', label: 'Nej, men jeg skynder mig at gøre det nu!' },
          ] },
      ],
    },
  ];
}

// scene.actLabel -> that act's schedulable scenes, in SCENES_DATA's own
// order (act-then-scene). schedulable:false (video/bandsang) scenes are
// dropped here so every call site downstream never sees them.
function formsRolleonskerScenesByAct() {
  const byAct = {};
  if (typeof SCENES_DATA === 'undefined' || !Array.isArray(SCENES_DATA)) return byAct;
  for (const scene of SCENES_DATA) {
    if (scene.schedulable === false) continue;
    const label = scene.actLabel || '';
    if (!byAct[label]) byAct[label] = [];
    byAct[label].push(scene);
  }
  return byAct;
}

// One Skala field per scene, two (Sanger/rapper + Danser) for a
// sang-typed scene.
function formsRolleonskerSceneFields(scenes) {
  const fields = [];
  for (const scene of scenes) {
    const isSong = Array.isArray(scene.types) && scene.types.includes('sang');
    if (isSong) {
      fields.push(formsRolleonskerScaleField(`${scene.name} (Sanger/rapper)`));
      fields.push(formsRolleonskerScaleField(`${scene.name} (Danser)`));
    } else {
      fields.push(formsRolleonskerScaleField(scene.name));
    }
  }
  return fields;
}

function formsRolleonskerScaleField(label) {
  return {
    id: formsNewFieldId(), type: 'scale', label, required: false,
    scaleMin: 1, scaleMax: 5, scaleMinLabel: 'Virkelig ikke', scaleMaxLabel: 'Virkelig gerne',
  };
}

function formsRolleonskerTextareaField(label, placeholder) {
  return { id: formsNewFieldId(), type: 'textarea', label, required: false, placeholder };
}

// ── "Fravær" dynamic template ─────────────────────────────────
// One "Navn" field plus one short-answer field per "øvning"-category
// calendar event in October/November of the current year, so a revyst can
// note the time window they're absent for each rehearsal. Regenerated fresh
// from CALENDAR_DATA every time the template is clicked, same reasoning as
// Rolleønsker above — never a frozen snapshot.
function formsGenerateFravaerSections() {
  const events = formsFravaerRehearsalEvents();
  const fields = [
    { id: formsNewFieldId(), type: 'text', label: 'Fulde navn', required: true, placeholder: "Der sker ikke noget, hvis du dropper et mellemnavn eller to" },
  ];
  for (const ev of events) {
    fields.push({
      id: formsNewFieldId(), type: 'text', required: false,
      label: `${ev.title}: ${formatDaDate(ev.date)} (${formsFravaerTimeRange(ev)})`,
      placeholder: 'tt:mm - tt:mm',
    });
  }
  return [
    { id: formsNewFieldId(), title: 'Anmeld fravær', description: 'Skriv herunder det tidsinterval du IKKE kan være til stede til en øver', fields },
  ];
}

// "ove" is CAL_CATEGORIES's "Øvning" key (js/calendar.js) — kept as a bare
// literal here since forms.html doesn't load calendar.js, same convention
// formsOptionsFromRehearsals's own sourceFilter.category usage follows.
function formsFravaerRehearsalEvents() {
  if (typeof CALENDAR_DATA === 'undefined' || !Array.isArray(CALENDAR_DATA)) return [];
  const year = new Date().getFullYear();
  return CALENDAR_DATA
    .filter((ev) => ev.category === 'ove')
    .filter((ev) => {
      const [y, m] = String(ev.date).split('-').map(Number);
      return y === year && (m === 10 || m === 11);
    })
    .slice()
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
}

// Duplicate of calendar.js's calTimeRange — forms.html doesn't load that file.
function formsFravaerTimeRange(ev) {
  if (!ev.start) return '';
  return ev.end ? `${ev.start}–${ev.end}` : ev.start;
}

function formsResolveOptions(field) {
  if (field.optionsSource === 'scenes') return formsOptionsFromScenes(field.sourceFilter);
  if (field.optionsSource === 'rehearsals') return formsOptionsFromRehearsals(field.sourceFilter);
  return Array.isArray(field.options) ? field.options : [];
}

// ── Field dependencies ("Tilføj afhængighed") ────────────────
// A field's optional `dependsOn: {fieldId, values}` hides it (both in the
// fill-in view and — see forms_dependency_hidden server-side — for
// required-answer enforcement on submit) unless an EARLIER field's answer
// is one of `values`. Only select/checkboxes/scale/yesno can be the
// controlling field: their answers are a fixed, matchable set of tokens;
// Kort/langt svar (free text) and Gitter (a per-row map, not one answer)
// don't fit the same "answer is one of these values" check. A legacy
// scenes/rehearsals-sourced select/checkboxes field is also excluded —
// its options only ever resolve live client-side (see formsResolveOptions
// above), so the server has no stored option list to validate a
// dependsOn.values entry against.
const FORMS_DEPENDENCY_CONTROL_TYPES = ['select', 'checkboxes', 'scale', 'yesno'];

// The set of raw answer tokens `field` can actually produce, i.e. the
// choices offered when picking dependsOn.values for something that
// depends on it — mirrors forms_dependency_allowed_values server-side.
function formsDependencyOptionsForField(field) {
  if (field.type === 'yesno') return [{ value: true, label: 'Ja' }, { value: false, label: 'Nej' }];
  if (field.type === 'scale') {
    const min = typeof field.scaleMin === 'number' ? field.scaleMin : 1;
    const max = typeof field.scaleMax === 'number' ? field.scaleMax : 5;
    const out = [];
    for (let n = min; n <= max; n++) out.push({ value: n, label: String(n) });
    return out;
  }
  return formsResolveOptions(field);
}

function formsFieldCanControlDependency(field) {
  if (!FORMS_DEPENDENCY_CONTROL_TYPES.includes(field.type)) return false;
  if ((field.type === 'select' || field.type === 'checkboxes')
      && field.optionsSource && field.optionsSource !== 'manual') return false;
  return formsDependencyOptionsForField(field).length > 0;
}

// Every field strictly before (sectionIdx, fieldIdx) in the form's own
// section/field order, eligible to control a dependency — the picker only
// offers questions the respondent will already have answered by the time
// this one would render. Recomputed fresh whenever the picker opens
// rather than cached, since earlier fields can be added/edited/removed
// while this row sits on the page.
function formsEarlierDependencyCandidates(draftSections, sectionIdx, fieldIdx) {
  return formsDependencySectionCandidates(draftSections, sectionIdx, fieldIdx)
    .reduce((acc, g) => acc.concat(g.fields), []);
}

// Same eligible-earlier-fields set as formsEarlierDependencyCandidates, but
// grouped per section (one entry per section from the first up to and
// including this field's own) — feeds the picker modal's two cascading
// dropdowns (Sektion, then Spørgsmål within it).
function formsDependencySectionCandidates(draftSections, sectionIdx, fieldIdx) {
  const out = [];
  for (let s = 0; s <= sectionIdx; s++) {
    const fields = Array.isArray(draftSections[s].fields) ? draftSections[s].fields : [];
    const limit = s === sectionIdx ? fieldIdx : fields.length;
    const eligible = [];
    for (let f = 0; f < limit; f++) {
      if (formsFieldCanControlDependency(fields[f])) eligible.push(fields[f]);
    }
    out.push({ sectionIdx: s, section: draftSections[s], fields: eligible });
  }
  return out;
}

// Clears `dependsOn` on any field across the whole form that points at
// `fieldId` — called whenever that field is deleted or its type changes,
// since a stored value set only makes sense against the field's original
// type (e.g. Skala's numbers vs. Vælg én's option strings).
function formsPruneDanglingDependencies(draftSections, fieldId) {
  for (const section of draftSections) {
    for (const f of (Array.isArray(section.fields) ? section.fields : [])) {
      if (f.dependsOn && f.dependsOn.fieldId === fieldId) delete f.dependsOn;
    }
  }
}

// True when `dep`'s condition is met by `value` (the controlling field's
// current/submitted answer) — mirrors forms_dependency_hidden server-side
// (inverted: that one answers "should this be hidden"). checkboxes answers
// are arrays — matches if ANY selected option is one of the trigger values.
function formsDependencyMatches(dep, value) {
  if (!dep || !Array.isArray(dep.values) || dep.values.length === 0) return true;
  if (value === undefined || value === null || value === '') return false;
  if (Array.isArray(value)) return value.some((v) => dep.values.includes(v));
  return dep.values.includes(value);
}

// ── Field id generator (client-side only; validated server-side too) ─
let formsFieldIdCounter = 0;
function formsNewFieldId() {
  formsFieldIdCounter += 1;
  return 'f' + Date.now().toString(36) + formsFieldIdCounter.toString(36);
}

// Every section (including the first) is now a real {id, title,
// description, fields} object — there's no longer a separate "the form's
// own fields" concept. A form saved before sections existed only has a
// top-level `fields` array and no `sections` at all; reading it through
// here migrates that array into a single implicit Section 1 (blank title/
// description) purely for display, so nothing already saved goes missing.
// Used by both the builder (editing an existing form or template) and the
// revyst fill-in view.
function formsSectionsFromDefinition(def) {
  const sections = Array.isArray(def && def.sections) ? JSON.parse(JSON.stringify(def.sections)) : [];
  if (sections.length === 0 && Array.isArray(def && def.fields) && def.fields.length > 0) {
    sections.push({ id: formsNewFieldId(), title: '', description: '', fields: JSON.parse(JSON.stringify(def.fields)) });
  }
  return sections;
}

// Measures the widest row label (via a detached, invisible probe matching
// the grid table's own font) so a Gitter's row-label column can be given
// exactly the pixel width it needs — see the cornerTh.style.width call
// below, and forms.css's .forms-grid-table comment for why this can't
// just be a CSS-only shrink-to-fit trick.
function formsGridLabelColumnWidth(rows) {
  const probe = document.createElement('span');
  probe.style.position = 'absolute';
  probe.style.visibility = 'hidden';
  probe.style.whiteSpace = 'nowrap';
  probe.style.fontSize = '0.85rem';
  probe.style.fontFamily = 'inherit';
  document.body.appendChild(probe);
  let max = 0;
  for (const r of rows) {
    probe.textContent = r.label || '';
    max = Math.max(max, probe.getBoundingClientRect().width);
  }
  probe.remove();
  return Math.ceil(max) + 24; // + the cell's own left/right padding
}

// Horizontal row of native radio circles, one per option — shared by
// "Vælg én" (select) and Skala, whose only real difference is where the
// option list comes from (live-resolved options vs. a synthesized numeric
// range). `name` scopes the radios into one exclusive group. `variant`:
// 'inline' puts the caption beside its circle ("Vælg én"); 'scale' keeps
// the caption centered below (a digit reads better under its own circle)
// but spreads the circles edge-to-edge across the full width instead of
// clustering at a fixed gap.
function formsRenderRadioRow(options, name, variant) {
  const wrap = el('div', 'forms-radio-row' + (variant ? ' forms-radio-row-' + variant : ''));
  const radios = [];
  for (const opt of options) {
    const optEl = el('label', 'forms-radio-option');
    const radio = document.createElement('input');
    radio.type = 'radio';
    radio.name = name;
    radio.value = opt.value;
    optEl.appendChild(radio);
    optEl.appendChild(el('span', 'forms-radio-caption', opt.label));
    wrap.appendChild(optEl);
    radios.push(radio);
  }
  wrap.formsValue = () => {
    const r = radios.find((r) => r.checked);
    return r ? r.value : '';
  };
  return wrap;
}

// ── Shared field-answer renderer ─────────────────────────────
// Builds the input control for one FieldSpec — used both by the revyst
// fill-in view and (read-only-ish, for a live options preview) nowhere
// else; the admin builder edits FieldSpecs directly, not answers.
// Returns an element with a `.formsValue` getter matching the shape
// forms_submit expects (string / string[] / boolean / number / a
// {rowId: value} map for the grid types).
function formsRenderAnswerInput(field) {
  if (field.type === 'textarea') {
    const input = el('textarea');
    input.rows = 4;
    input.placeholder = field.placeholder || '';
    input.formsValue = () => input.value.trim();
    return input;
  }
  if (field.type === 'select') {
    // A row of clickable circles, not a dropdown — same idea as Skala,
    // just fed live-resolved options instead of a numeric range.
    return formsRenderRadioRow(formsResolveOptions(field), 'sel_' + field.id, 'inline');
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
  if (field.type === 'scale') {
    const min = typeof field.scaleMin === 'number' ? field.scaleMin : 1;
    const max = typeof field.scaleMax === 'number' ? field.scaleMax : 5;
    const options = [];
    for (let n = min; n <= max; n++) options.push({ value: String(n), label: String(n) });
    const wrap = el('div');
    // Read by forms.css to cap how far the circles/captions are allowed
    // to spread on a wide form — without this a short range (e.g. 0-5)
    // stretched with justify-content:space-between across a wide card
    // reads as oddly spaced-out, since the row otherwise always fills
    // 100% of the available width regardless of how few circles it has.
    wrap.style.setProperty('--forms-scale-count', String(options.length));
    if (field.scaleMinLabel || field.scaleMaxLabel) {
      const capRow = el('div', 'forms-scale-captions');
      capRow.appendChild(el('span', null, field.scaleMinLabel || ''));
      capRow.appendChild(el('span', null, field.scaleMaxLabel || ''));
      wrap.appendChild(capRow);
    }
    const radioRow = formsRenderRadioRow(options, 'scale_' + field.id, 'scale');
    wrap.appendChild(radioRow);
    wrap.formsValue = () => {
      const v = radioRow.formsValue();
      return v === '' ? null : parseInt(v, 10);
    };
    return wrap;
  }
  if (field.type === 'grid_single' || field.type === 'grid_multi') {
    const rows = Array.isArray(field.rows) ? field.rows : [];
    const cols = formsResolveOptions(field);
    const wrap = el('div', 'forms-grid-wrap');
    const table = el('table', 'forms-grid-table');
    const thead = el('thead');
    const headRow = el('tr');
    // table-layout:fixed (forms.css) reliably splits the value columns
    // evenly, but can't shrink-to-fit the row-label column on its own —
    // an explicit pixel width computed from the actual longest row label
    // does that instead. Auto-layout's own shrink-to-fit hints (a small
    // width on this column) turned out unreliable in practice: with no
    // matching hint on this empty corner cell too, the browser gave the
    // WHOLE column all the table's leftover space instead of shrinking it.
    const cornerTh = el('th');
    cornerTh.style.width = formsGridLabelColumnWidth(rows) + 'px';
    headRow.appendChild(cornerTh);
    for (const c of cols) headRow.appendChild(el('th', null, c.label));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    const controlsByRow = {};
    for (const r of rows) {
      const tr = el('tr');
      tr.appendChild(el('td', 'forms-grid-row-label', r.label));
      const controls = [];
      for (const c of cols) {
        const td = el('td', 'forms-grid-cell');
        // Read by the mobile stacked layout (forms.css) as the column
        // name next to each option, once the table itself switches from
        // a horizontally-scrolled grid to a vertically-scrolled list of
        // rows — the header row (where that name would otherwise live)
        // is hidden there.
        td.setAttribute('data-col-label', c.label);
        const input = document.createElement('input');
        input.type = field.type === 'grid_single' ? 'radio' : 'checkbox';
        if (field.type === 'grid_single') input.name = 'grid_' + field.id + '_' + r.id;
        input.value = c.value;
        td.appendChild(input);
        tr.appendChild(td);
        controls.push(input);
      }
      controlsByRow[r.id] = controls;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    wrap.formsValue = () => {
      const out = {};
      for (const r of rows) {
        const controls = controlsByRow[r.id];
        if (field.type === 'grid_single') {
          const chosen = controls.find((c) => c.checked);
          if (chosen) out[r.id] = chosen.value;
        } else {
          const chosen = controls.filter((c) => c.checked).map((c) => c.value);
          if (chosen.length) out[r.id] = chosen;
        }
      }
      return out;
    };
    return wrap;
  }
  // text (default)
  const input = el('input');
  input.type = 'text';
  input.placeholder = field.placeholder || '';
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
    // The whole row opens the form now, not just the arrow — a <button>
    // (not a styled <div>) so it's natively keyboard/focus accessible
    // without extra ARIA wiring. The arrow stays as a purely decorative
    // affordance (aria-hidden — the row itself already carries the
    // accessible name via its own text content).
    const row = el('button', 'forms-open-row');
    row.type = 'button';
    const info = el('div', 'forms-open-info');
    info.appendChild(el('div', 'forms-open-title', f.title));
    if (f.deadline) info.appendChild(el('div', 'forms-open-deadline',
      'Frist: ' + (typeof formatDaDateMaybeTime === 'function' ? formatDaDateMaybeTime(f.deadline) : f.deadline)));
    row.appendChild(info);
    const arrow = el('span', 'forms-open-arrow', '→');
    arrow.setAttribute('aria-hidden', 'true');
    row.appendChild(arrow);
    row.addEventListener('click', () => renderFormFillIn(root, f.id));
    listWrap.appendChild(row);
  }
}

// True once the visitor has typed/checked/selected anything anywhere on
// the form — gates the back arrow's "Forlad siden?" warning below so it
// only interrupts when there's actually something of theirs to lose.
function formsFillInHasAnyAnswer(inputs) {
  return inputs.some(({ field, input, visible }) => {
    if (visible === false) return false; // hidden by a dependency — not something to lose
    const v = input.formsValue();
    if (field.type === 'grid_single' || field.type === 'grid_multi') {
      return v && Object.keys(v).length > 0;
    }
    return v != null && v !== '' && !(Array.isArray(v) && v.length === 0);
  });
}

// Warm/amber styled — not danger-red, since leaving mid-form only costs
// the visitor their own unsaved answers, nothing destructive elsewhere —
// same modal chrome as every other confirm dialog on the site.
function formsOpenLeaveWarning(onLeave) {
  const { modal, form, actions, close } = siteOpenModalWithClose('Forlad siden?');
  modal.classList.add('forms-center-modal', 'forms-leave-modal');
  form.appendChild(el('p', 'forms-intro', 'Dine ændringer gemmes ikke.'));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const leaveBtn = formsPillBtn('Forlad', 'site-btn-warm');
  leaveBtn.addEventListener('click', () => { close(); onLeave(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(leaveBtn);
}

// ── Revyst: fill in + submit one form ────────────────────────
async function renderFormFillIn(root, formId) {
  root.replaceChildren();
  // Declared up front (empty) rather than after the fetch below, so the
  // back button's dirty-check is always safe to read even while the form
  // is still loading — it just reads as "nothing entered yet" then.
  const inputs = []; // { field, input, page }
  const card = el('section', 'card forms-form forms-fillin-wide');
  const backBtn = el('button', 'forms-back-btn', '←');
  backBtn.type = 'button';
  backBtn.title = 'Tilbage til formularer';
  backBtn.setAttribute('aria-label', 'Tilbage til formularer');
  backBtn.addEventListener('click', () => {
    if (formsFillInHasAnyAnswer(inputs)) formsOpenLeaveWarning(() => renderFormsList(root));
    else renderFormsList(root);
  });
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
  // The form's own title only identifies it in the "choose a form" list
  // (renderFormsList) — filling it in opens straight onto Section 1's own
  // title/description, exactly like every later section, with no separate
  // form-level heading here. Multi-page forms are paged with prev/next
  // arrows at the bottom, same idea as Manus's point-entry modal
  // (openPointEntryModal) paging between sheets — except this lives inline
  // on the page, not in a modal, so it uses .btn-small rather than that
  // modal's .site-btn-warm (see the site-wide button-tier convention). All
  // pages render up front and are just hidden/shown, so native input values
  // survive navigating back and forth for free.
  const pageDefs = formsSectionsFromDefinition(form);
  if (pageDefs.length === 0) pageDefs.push({ id: null, title: form.title, description: '', fields: [] });

  const pageEls = pageDefs.map((pageDef, pageIdx) => {
    const pageEl = el('div', 'forms-fillin-page');
    if (pageDef.title) pageEl.appendChild(el('h3', 'forms-fillin-section-title', pageDef.title));
    if (pageDef.description) pageEl.appendChild(el('p', 'forms-intro', pageDef.description));
    for (const field of pageDef.fields) {
      const input = formsRenderAnswerInput(field);
      const labelText = field.label + (field.required ? ' *' : '');
      const wrap = siteEditField(labelText, input);
      pageEl.appendChild(wrap);
      inputs.push({ field, input, wrap, page: pageIdx });
    }
    body.appendChild(pageEl);
    return pageEl;
  });

  // Conditional visibility ("Tilføj afhængighed" in the builder): walked
  // in field order — the same order a dependsOn can only ever point
  // backwards through — building up an `answers` snapshot as it goes, so
  // a field whose OWN controller is currently hidden naturally reads as
  // unanswered too (it's simply never added to `answers`), cascading
  // correctly through a chain of dependencies with no extra bookkeeping.
  // Mirrors forms_submit's own per-field loop server-side.
  function updateDependentVisibility() {
    const answers = {};
    for (const item of inputs) {
      const { field, input, wrap } = item;
      const visible = !field.dependsOn || formsDependencyMatches(field.dependsOn, answers[field.dependsOn.fieldId]);
      item.visible = visible;
      wrap.style.display = visible ? '' : 'none';
      if (visible) answers[field.id] = input.formsValue();
    }
  }
  updateDependentVisibility();
  // Delegated rather than per-widget: every answer control (native inputs,
  // and the radio/checkbox-based custom widgets formsRenderAnswerInput
  // builds for select/checkboxes/scale/grid) dispatches a real bubbling
  // input/change event on its own native control, so one listener here
  // catches all of them without formsRenderAnswerInput needing to know
  // anything about dependencies.
  body.addEventListener('input', updateDependentVisibility);
  body.addEventListener('change', updateDependentVisibility);

  const msg = el('div', 'forms-msg');
  body.appendChild(msg);
  function setMsg(text, kind) {
    msg.textContent = text;
    msg.className = 'forms-msg' + (kind ? ' ' + kind : '');
  }

  const submitBtn = el('button', 'site-btn-success forms-fillin-submit-btn', 'Indsend');
  submitBtn.type = 'button';
  submitBtn.addEventListener('click', async () => {
    updateDependentVisibility();
    const answers = {};
    for (const { field, input, page, visible } of inputs) {
      if (!visible) continue; // hidden by a dependency — never required, never submitted
      const value = input.formsValue();
      if (field.required) {
        // Grid types answer with a {rowId: value} map — required means
        // every row needs an answer, mirroring forms_submit's own check.
        const empty = (field.type === 'grid_single' || field.type === 'grid_multi')
          ? (Array.isArray(field.rows) ? field.rows : []).some((r) => {
              const v = value ? value[r.id] : undefined;
              return v === undefined || (Array.isArray(v) && v.length === 0);
            })
          : value == null || value === '' || (Array.isArray(value) && value.length === 0);
        if (empty) {
          showPage(page);
          return setMsg(`Udfyld "${field.label}".`, 'error');
        }
      }
      answers[field.id] = value;
    }
    if (!formsFillInHasAnyAnswer(inputs)) {
      return setMsg('Udfyld mindst ét felt.', 'error');
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
        // Everything else is a custom widget built on native checkboxes/
        // radios (checkbox lists, select/skala's radio rows, grids).
        else input.querySelectorAll('input[type=checkbox], input[type=radio]').forEach((cb) => { cb.checked = false; });
      }
      submitBtn.disabled = true;
      // Stays on whichever page Indsend was clicked from (always the last
      // one) rather than jumping back to page 1 — a multi-page form
      // shouldn't dump the visitor back at the top after they've just
      // finished it.
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
      // No prev/next to center, but Indsend still belongs bottom-right,
      // same as the multi-page .forms-fillin-submit-slot below.
      nav = el('div', 'forms-fillin-submit-row');
      nav.appendChild(submitBtn);
      body.appendChild(nav);
      return;
    }
    // Grid layout (1fr auto 1fr), same idea as Manus's point-entry modal's
    // .manus-points-grid-row: prev/label/next always sits truly centered
    // regardless of what's in the right-hand slot, rather than shifting
    // left once Indsend appears there on the last page.
    nav = el('div', 'forms-fillin-nav-row');
    const navGroup = el('div', 'forms-fillin-nav-group');
    const isLast = currentPage === pageEls.length - 1;

    const prevBtn = el('button', 'btn-small', '‹ Forrige');
    prevBtn.type = 'button';
    prevBtn.disabled = currentPage === 0;
    prevBtn.addEventListener('click', () => showPage(currentPage - 1));
    navGroup.appendChild(prevBtn);

    navGroup.appendChild(el('span', 'forms-fillin-page-label', `${currentPage + 1}/${pageEls.length}`));

    // Næste stays visible on the last page too, just disabled — it never
    // gets replaced by Indsend, which has its own slot to the right.
    const nextBtn = el('button', 'btn-small', 'Næste ›');
    nextBtn.type = 'button';
    nextBtn.disabled = isLast;
    nextBtn.addEventListener('click', () => showPage(currentPage + 1));
    navGroup.appendChild(nextBtn);
    nav.appendChild(navGroup);

    const submitSlot = el('div', 'forms-fillin-submit-slot');
    if (isLast) submitSlot.appendChild(submitBtn);
    nav.appendChild(submitSlot);

    body.appendChild(nav);
  }
  function showPage(idx) {
    currentPage = idx;
    pageEls.forEach((pageEl, i) => { pageEl.style.display = i === currentPage ? '' : 'none'; });
    renderNav();
  }
  showPage(0);
}

// ── Builder dirty-tracking (snapshot-diff, mirrors manus.js's
// manusIsDirty/manusLastSavedSnapshot and budget.js's budgetIsSheetDirty) ──
// Set only while the builder screen (Ny/Rediger formular) is mounted; null
// on every other screen, since only the builder has anything unsaved to
// lose. A live comparison against a snapshot taken right after the screen
// mounts, not a flag set at every mutation site — this catches every edit
// path (title/status/deadline/revy inputs, section/field edits, applying a
// template) for free, the same reasoning as manus.js's own comment on why
// it polls a diff instead. `collapsed` is UI-only bookkeeping (a section's
// disclosure state) and excluded from both sides of the diff, exactly like
// manus.js's `_`-prefixed-key exclusion, so toggling a section open/closed
// never itself counts as an edit.
let formsBuilderDraft = null; // { titleInput, statusDd, visibilityDd, deadlineField, revyDd, draftSections }
let formsBuilderSnapshot = null;

function formsBuilderPayloadForDiff() {
  if (!formsBuilderDraft) return null;
  const { titleInput, statusDd, visibilityDd, deadlineField, revyDd, draftSections } = formsBuilderDraft;
  return {
    title: titleInput.value, status: statusDd.value, visibility: visibilityDd.value,
    deadline: deadlineField.value || null, productionYear: revyDd.value,
    sections: draftSections,
  };
}

function formsBuilderSerializeForDiff(payload) {
  return JSON.stringify(payload, (key, value) => (key === 'collapsed' ? undefined : value));
}

function formsBuilderIsDirty() {
  if (!formsBuilderDraft) return false;
  return formsBuilderSerializeForDiff(formsBuilderPayloadForDiff()) !== formsBuilderSnapshot;
}

// Guards any navigation away from a modified, unsaved builder screen with
// the same styled confirm modal the revyst fill-in view's back arrow uses
// (formsOpenLeaveWarning) — used by the tab bar, the builder's own
// Annuller, and (for header/mobile-menu nav links) the DOMContentLoaded
// click interceptor below. A plain pass-through once the builder isn't
// dirty (or isn't even mounted, e.g. from the overview/responses screens).
function formsGuardedNavigate(action) {
  if (formsBuilderIsDirty()) formsOpenLeaveWarning(action);
  else action();
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
  // The builder is the only screen with anything to lose — dropping the
  // dirty-tracking draft whenever we render anything else keeps a stale
  // reference from outliving its own screen (formsRenderBuilderScreen sets
  // a fresh one itself when screen.name IS 'builder').
  if (screen.name !== 'builder') { formsBuilderDraft = null; formsBuilderSnapshot = null; }
  root.replaceChildren();
  const tabs = el('div', 'forms-admin-tabs');
  // "Se svar"/"Se statistik" are views onto one form from within Oversigt,
  // not separate tabs — the Oversigt tab stays active and visible while
  // viewing them, so there's always a way back to the list without a
  // dedicated back button.
  const overviewActive = screen.name === 'overview' || screen.name === 'responses' || screen.name === 'stats';
  const overviewTab = el('button', 'forms-admin-tab' + (overviewActive ? ' active' : ''), 'Oversigt');
  overviewTab.type = 'button';
  overviewTab.addEventListener('click', () => formsGuardedNavigate(() => renderAdminView(root, { name: 'overview' })));
  const builderTab = el('button', 'forms-admin-tab' + (screen.name === 'builder' ? ' active' : ''),
    screen.name === 'builder' && screen.existingDefinition ? 'Rediger formular' : 'Ny formular');
  builderTab.type = 'button';
  builderTab.addEventListener('click', () => formsGuardedNavigate(() => renderAdminView(root, { name: 'builder' })));
  tabs.appendChild(overviewTab);
  tabs.appendChild(builderTab);
  root.appendChild(tabs);

  if (screen.name === 'builder') {
    formsRenderBuilderScreen(root, screen.existingDefinition || null);
  } else if (screen.name === 'responses') {
    formsRenderResponsesScreen(root, screen.formId);
  } else if (screen.name === 'stats') {
    formsRenderStatsScreen(root, screen.formId);
  } else {
    formsRenderOverviewScreen(root);
  }
}

// Icon-only row actions (Oversigt's "Rediger"/"Se svar") — same SVG pencil
// convention as calendar.js's calPencilIcon/budget.js's budgetPencilIcon,
// duplicated here since forms.html doesn't load either of those scripts
// (the established per-feature duplication convention). formsPaperIcon has
// no existing sibling elsewhere on the site (budget's own "Se" icon is a
// photo, since it views a receipt image, not a document).
function formsPencilIcon() {
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

function formsPaperIcon() {
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
  const outline = document.createElementNS(svgNS, 'path');
  outline.setAttribute('d', 'M4.2 1.7h4.6l2.5 2.5v9.1a1 1 0 0 1-1 1h-6.1a1 1 0 0 1-1-1v-10.6a1 1 0 0 1 1-1z');
  svg.appendChild(outline);
  const fold = document.createElementNS(svgNS, 'path');
  fold.setAttribute('d', 'M8.8 1.7v2.5h2.5');
  svg.appendChild(fold);
  const line1 = document.createElementNS(svgNS, 'path');
  line1.setAttribute('d', 'M5.5 8h5');
  svg.appendChild(line1);
  const line2 = document.createElementNS(svgNS, 'path');
  line2.setAttribute('d', 'M5.5 10.4h5');
  svg.appendChild(line2);
  return svg;
}

// "Se statistik" row action icon — three ascending bars, same 16x16/
// currentColor-stroke recipe as formsPencilIcon/formsPaperIcon above.
function formsChartIcon() {
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
  const bar1 = document.createElementNS(svgNS, 'path');
  bar1.setAttribute('d', 'M3.3 13.5v-4');
  svg.appendChild(bar1);
  const bar2 = document.createElementNS(svgNS, 'path');
  bar2.setAttribute('d', 'M8 13.5v-8');
  svg.appendChild(bar2);
  const bar3 = document.createElementNS(svgNS, 'path');
  bar3.setAttribute('d', 'M12.7 13.5V4.3');
  svg.appendChild(bar3);
  const baseline = document.createElementNS(svgNS, 'path');
  baseline.setAttribute('d', 'M1.7 13.5h12.6');
  svg.appendChild(baseline);
  return svg;
}

async function formsRenderOverviewScreen(root) {
  const card = el('section', 'card forms-overview-card');
  const head = el('div', 'forms-builder-head');
  head.appendChild(el('h2', null, 'Formularer'));
  card.appendChild(head);
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

  // Year filter, top-right of the heading — ties each form to a specific
  // Revy. Options are every year some form actually carries, plus the
  // current production year (so there's always at least one option, e.g.
  // just "MatRevy 2026" today), labeled with that Revy's own name (same
  // Arkiv lookup as the builder's Revy field) rather than a bare year. A
  // form saved before productionYear existed has none at all; treat it as
  // belonging to the current year rather than hiding it under every
  // other filter. Newest year first, same convention as Arkiv/Budget/
  // Koordinator's own year sorts. The chosen year persists in localStorage
  // (mirrors calendar.js's CAL_VIEW_KEY) so it survives both a page reload
  // and this whole screen re-rendering after an in-place action like the
  // status chip below — without persistence, either would silently reset
  // the filter back to the current production year.
  const currentYear = formsCurrentProductionYear();
  const formYear = (f) => (f.productionYear != null ? f.productionYear : currentYear);
  const years = Array.from(new Set([currentYear, ...forms.map(formYear)])).sort((a, b) => b - a);
  let storedYear = null;
  try { storedYear = localStorage.getItem(FORMS_YEAR_FILTER_KEY); } catch (e) { /* ignore */ }
  const initialYear = (storedYear != null && years.some((y) => String(y) === storedYear))
    ? storedYear : String(currentYear);
  const yearDd = siteCreateDropdownField(
    years.map((y) => ({ value: String(y), label: formsRevyNameForYear(y) })), initialYear);
  yearDd.classList.add('forms-year-filter');
  // Same label + compact site-field-btn look as budget.css's own
  // "Viser budget for:"/koordinator.css's "Viser plan for:" — one shared
  // convention for every "which one am I viewing" dropdown site-wide.
  const yearFilterWrap = el('div', 'forms-year-filter-wrap');
  yearFilterWrap.appendChild(el('span', 'forms-year-filter-label', 'Viser for:'));
  yearFilterWrap.appendChild(yearDd);
  head.appendChild(yearFilterWrap);

  function renderTable() {
    const filterYear = parseInt(yearDd.value, 10);
    try { localStorage.setItem(FORMS_YEAR_FILTER_KEY, yearDd.value); } catch (e) { /* ignore */ }
    const filtered = forms.filter((f) => formYear(f) === filterYear);
    tableWrap.replaceChildren();
    if (filtered.length === 0) {
      tableWrap.appendChild(el('p', 'forms-intro', 'Ingen formularer for dette år.'));
      return;
    }

    const table = el('table', 'forms-dashboard-table');
    const thead = el('thead');
    const headRow = el('tr');
    ['Titel', 'Status', 'Frist', 'Svar', ''].forEach((h) => headRow.appendChild(el('th', null, h)));
    thead.appendChild(headRow);
    table.appendChild(thead);
    const tbody = el('tbody');
    for (const f of filtered) {
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
            status: f.status === 'open' ? 'closed' : 'open', visibility: def.visibility,
            deadline: def.deadline, productionYear: def.productionYear,
            fromTemplateId: def.fromTemplateId,
            fields: def.fields, sections: def.sections || [],
          });
        }
        renderAdminView(root, { name: 'overview' });
      });
      statusCell.appendChild(statusChip);
      row.appendChild(statusCell);

      row.appendChild(el('td', null, f.deadline
        ? (typeof formatDaDateMaybeTime === 'function' ? formatDaDateMaybeTime(f.deadline) : f.deadline) : '—'));
      row.appendChild(el('td', null, String(f.responseCount)));

      // Three row actions: "Se statistik" (bars), "Se svar" (paper) and
      // "Rediger" (pencil, same icon convention as calendar.js/budget.js's
      // own edit buttons), far right, edit last. Deleting a form moved into
      // its own edit view (top-right X) — see formsRenderBuilderScreen.
      // Statistik/Svar are greyed out (not hidden — Titel/Status/Rediger
      // stay boss-editable regardless) whenever this form's own Synlighed
      // restricts them to Koordinatorer; forms_admin_read enforces the
      // same restriction server-side, this is just so a boss doesn't click
      // through to a screen that then has to refuse them.
      const restricted = f.visibility === 'admin' && !siteHasLevel('admin');
      const actionsCell = el('td', 'forms-row-actions');
      const statsBtn = el('button', 'forms-row-icon-btn');
      statsBtn.type = 'button';
      statsBtn.setAttribute('aria-label', restricted ? 'Statistik (kun koordinatorer)' : 'Statistik');
      statsBtn.setAttribute('data-tooltip', restricted ? 'Kun koordinatorer' : 'Statistik');
      statsBtn.appendChild(formsChartIcon());
      if (restricted) statsBtn.disabled = true;
      else statsBtn.addEventListener('click', () => renderAdminView(root, { name: 'stats', formId: f.id }));
      const respBtn = el('button', 'forms-row-icon-btn');
      respBtn.type = 'button';
      respBtn.setAttribute('aria-label', restricted ? 'Svar (kun koordinatorer)' : 'Svar');
      respBtn.setAttribute('data-tooltip', restricted ? 'Kun koordinatorer' : 'Svar');
      respBtn.appendChild(formsPaperIcon());
      if (restricted) respBtn.disabled = true;
      else respBtn.addEventListener('click', () => renderAdminView(root, { name: 'responses', formId: f.id }));
      const editBtn = el('button', 'forms-row-icon-btn');
      editBtn.type = 'button';
      editBtn.setAttribute('aria-label', 'Rediger');
      editBtn.setAttribute('data-tooltip', 'Rediger');
      editBtn.appendChild(formsPencilIcon());
      editBtn.addEventListener('click', async () => {
        const full = await formsApi('forms_admin_read', { formId: f.id });
        if (full.ok) {
          // responseCount isn't part of a definition — fold in the summary
          // row's own count so the edit view's delete confirm can still
          // warn how many responses would be lost.
          renderAdminView(root, {
            name: 'builder',
            existingDefinition: Object.assign({}, full.data.definition, { responseCount: f.responseCount }),
          });
        }
      });
      actionsCell.appendChild(statsBtn);
      actionsCell.appendChild(respBtn);
      actionsCell.appendChild(editBtn);
      row.appendChild(actionsCell);

      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    tableWrap.appendChild(table);
  }

  yearDd.addEventListener('change', renderTable);
  renderTable();
}

function formsOpenDeleteConfirm(root, f) {
  const { modal, form, error, actions, close } = siteOpenEditModal(`Slet "${f.title}"?`);
  modal.classList.add('forms-center-modal', 'forms-narrow-modal');
  form.appendChild(el('p', 'forms-intro', f.responseCount > 0
    ? `Inklusiv alle ${f.responseCount} svar? Dette kan ikke fortrydes.`
    : 'Dette kan ikke fortrydes.'));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-btn-danger');
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
// draftSections/sectionIdx (the WHOLE form + which section this is) are
// threaded through purely so formsRenderFieldRow's dependency picker can
// see fields from EARLIER sections, not just this section's own
// draftFields — nothing else here reads them.
function formsRenderFieldEditor(listEl, draftFields, onChange, draftSections, sectionIdx) {
  listEl.replaceChildren();
  draftFields.forEach((field, idx) => {
    if (idx > 0) listEl.appendChild(formsRenderFieldInsertBtn(idx, draftFields, listEl, onChange, draftSections, sectionIdx));
    listEl.appendChild(formsRenderFieldRow(field, idx, draftFields, listEl, onChange, draftSections, sectionIdx));
  });
  const addBtn = el('button', 'btn-small', '+ Tilføj felt');
  addBtn.type = 'button';
  addBtn.addEventListener('click', () => {
    draftFields.push({ id: formsNewFieldId(), type: 'text', label: '', required: false });
    formsRenderFieldEditor(listEl, draftFields, onChange, draftSections, sectionIdx);
    onChange();
  });
  listEl.appendChild(addBtn);
}

// A small "+" divider between two existing field rows, inserting a fresh
// blank field at that exact position (splice at `idx`, i.e. before the
// field currently at `idx`) rather than only ever appending at the end.
function formsRenderFieldInsertBtn(idx, draftFields, listEl, onChange, draftSections, sectionIdx) {
  const wrap = el('div', 'forms-field-insert');
  const btn = el('button', 'forms-field-insert-btn', '+');
  btn.type = 'button';
  btn.title = 'Indsæt spørgsmål her';
  btn.addEventListener('click', () => {
    draftFields.splice(idx, 0, { id: formsNewFieldId(), type: 'text', label: '', required: false });
    formsRenderFieldEditor(listEl, draftFields, onChange, draftSections, sectionIdx);
    onChange();
  });
  wrap.appendChild(btn);
  return wrap;
}

// Clears any previous type's extra props and seeds sensible defaults for
// the new one — called whenever a field's type dropdown changes.
function formsResetFieldTypeExtras(field) {
  delete field.optionsSource; delete field.options; delete field.sourceFilter;
  delete field.rows; delete field.scaleMin; delete field.scaleMax;
  delete field.scaleMinLabel; delete field.scaleMaxLabel; delete field.placeholder;
  if (field.type === 'text' || field.type === 'textarea') {
    field.placeholder = '';
  } else if (field.type === 'select' || field.type === 'checkboxes') {
    field.optionsSource = 'manual';
    field.options = [];
  } else if (field.type === 'scale') {
    field.scaleMin = 1;
    field.scaleMax = 5;
    field.scaleMinLabel = '';
    field.scaleMaxLabel = '';
  } else if (field.type === 'grid_single' || field.type === 'grid_multi') {
    field.rows = [{ id: formsNewFieldId(), label: '' }];
    field.options = [];
  }
}

function formsRenderFieldRow(field, idx, draftFields, listEl, onChange, draftSections, sectionIdx) {
  const row = el('div', 'forms-field-row');

  // Spørgsmål (~75%) + type dropdown + ✕, all on one row — no up/down
  // reordering (removed; drag-and-drop would be the next step, not this).
  const topRow = el('div', 'forms-field-row-top');

  const labelInput = el('input', 'forms-field-label-input');
  labelInput.type = 'text';
  labelInput.placeholder = 'Spørgsmål';
  labelInput.value = field.label || '';
  labelInput.addEventListener('input', () => { field.label = labelInput.value; onChange(); });
  topRow.appendChild(labelInput);

  const typeDd = siteCreateDropdownField(FORMS_FIELD_TYPES, field.type);
  typeDd.classList.add('forms-field-type-dd');
  typeDd.addEventListener('change', () => {
    field.type = typeDd.value;
    formsResetFieldTypeExtras(field);
    // A type change invalidates any dependsOn.values another field stored
    // against this one's OLD type (e.g. Skala's numbers vs. Vælg én's
    // option strings) — drop them rather than leave a silently-broken
    // dependency behind.
    formsPruneDanglingDependencies(draftSections, field.id);
    formsRenderFieldEditor(listEl, draftFields, onChange, draftSections, sectionIdx);
    onChange();
  });
  topRow.appendChild(typeDd);

  const removeBtn = el('button', 'boss-edit-remove', '✕');
  removeBtn.type = 'button';
  removeBtn.title = 'Slet spørgsmål';
  removeBtn.setAttribute('aria-label', 'Slet spørgsmål');
  removeBtn.addEventListener('click', () => {
    const doRemove = () => {
      draftFields.splice(idx, 1);
      formsPruneDanglingDependencies(draftSections, field.id);
      formsRenderFieldEditor(listEl, draftFields, onChange, draftSections, sectionIdx);
      onChange();
    };
    // A blank, never-filled-in field deletes instantly — anything with an
    // actual question typed in confirms first, same as a section/form.
    if (formsFieldIsEmpty(field)) doRemove();
    else formsOpenDeleteFieldConfirm(field.label, doRemove);
  });
  topRow.appendChild(removeBtn);
  row.appendChild(topRow);

  const configEl = formsRenderFieldTypeConfig(field, onChange);
  if (configEl) row.appendChild(configEl);

  // Afhængighed (left) / Påkrævet (right) share their own row, under
  // whatever type-specific config rendered above.
  const bottomRow = el('div', 'forms-field-row-bottom');
  bottomRow.appendChild(formsRenderFieldDependencyControl(field, draftSections, sectionIdx, idx, onChange));

  const reqLabel = el('label', 'forms-required-label');
  const reqBox = document.createElement('input');
  reqBox.type = 'checkbox';
  reqBox.checked = !!field.required;
  reqBox.addEventListener('change', () => { field.required = reqBox.checked; onChange(); });
  reqLabel.appendChild(reqBox);
  reqLabel.appendChild(document.createTextNode('Påkrævet'));
  bottomRow.appendChild(reqLabel);
  row.appendChild(bottomRow);

  return row;
}

// The bottom-left "Tilføj afhængighed" control: no dependency yet renders
// a plain .btn-small (same "+ Tilføj X" chrome as Tilføj felt/Tilføj
// mulighed elsewhere on this page); a dependency set renders a live
// summary (resolved fresh from the controlling field's CURRENT options
// each time, never a frozen label snapshot — same reasoning as the stats
// screen's own formsResolveOptions lookups) plus a Rediger icon button —
// editing AND removing both live in the modal now, so there's no separate
// ✕ out here. Re-renders itself in place on every change, same
// self-contained pattern as formsRenderOptionsEditor.
function formsRenderFieldDependencyControl(field, draftSections, sectionIdx, fieldIdx, onChange) {
  const wrap = el('div', 'forms-field-dependency');

  function openPicker() {
    formsOpenDependencyModal(field, draftSections, sectionIdx, fieldIdx,
      (dep) => { field.dependsOn = dep; render(); onChange(); },
      () => { delete field.dependsOn; render(); onChange(); });
  }

  function render() {
    wrap.replaceChildren();
    if (!field.dependsOn) {
      const addBtn = el('button', 'btn-small', '+ Tilføj afhængighed');
      addBtn.type = 'button';
      addBtn.addEventListener('click', openPicker);
      wrap.appendChild(addBtn);
      return;
    }
    const candidates = formsEarlierDependencyCandidates(draftSections, sectionIdx, fieldIdx);
    const controlling = candidates.find((f) => f.id === field.dependsOn.fieldId);
    const summary = el('span', 'forms-dependency-summary');
    if (controlling) {
      const labels = formsDependencyOptionsForField(controlling)
        .filter((o) => field.dependsOn.values.includes(o.value))
        .map((o) => o.label);
      summary.textContent = `Vises hvis: ${controlling.label || '(uden titel)'} (${labels.join(', ') || '—'})`;
    } else {
      summary.textContent = 'Afhængighed peger på et spørgsmål, der ikke længere findes.';
      summary.classList.add('forms-dependency-broken');
    }
    wrap.appendChild(summary);

    // Same icon-button chrome as Oversigt's own Rediger row action
    // (.forms-row-icon-btn, formsPencilIcon) rather than a bespoke text
    // link — "in style with the rest of the page".
    const editBtn = el('button', 'forms-row-icon-btn');
    editBtn.type = 'button';
    editBtn.setAttribute('aria-label', 'Rediger afhængighed');
    editBtn.setAttribute('data-tooltip', 'Rediger afhængighed');
    editBtn.appendChild(formsPencilIcon());
    editBtn.addEventListener('click', openPicker);
    wrap.appendChild(editBtn);
  }
  render();
  return wrap;
}

// The "Tilføj afhængighed" modal: Sektion (defaults to this field's own
// section) → Spørgsmål (defaults to the closest eligible field above,
// within that section) → which of ITS answers should reveal `field`.
// `onSave` receives a clean {fieldId, values} on Gem; `onRemove` fires on
// the modal's own "Fjern afhængighed" (only offered when editing an
// existing one) — neither is called on Annuller.
function formsOpenDependencyModal(field, draftSections, sectionIdx, fieldIdx, onSave, onRemove) {
  const groups = formsDependencySectionCandidates(draftSections, sectionIdx, fieldIdx);
  const nonEmptyGroups = groups.filter((g) => g.fields.length > 0);
  const { modal, form, actions, close } = siteOpenModalWithClose('Afhængighed');
  modal.classList.add('forms-center-modal');
  form.appendChild(el('p', 'forms-intro',
    'Vælg et tidligere spørgsmål, og hvilke af dets svar der skal vise dette felt.'));

  if (nonEmptyGroups.length === 0) {
    form.appendChild(el('p', 'forms-intro',
      'Der er endnu ingen tidligere Vælg én/Vælg flere/Skala/Ja-Nej-spørgsmål i formularen, som dette ' +
      'felt kan afhænge af.'));
    const okBtn = formsPillBtn('OK');
    okBtn.addEventListener('click', close);
    actions.appendChild(okBtn);
    return;
  }

  const existing = field.dependsOn;
  const existingGroup = existing && groups.find((g) => g.fields.some((f) => f.id === existing.fieldId));
  // Defaults to this field's own section — unless it has no eligible
  // fields of its own (e.g. it's the first field in it), in which case the
  // closest earlier section that does have any stands in instead.
  let defaultSectionIdx = existingGroup ? existingGroup.sectionIdx : sectionIdx;
  if (!nonEmptyGroups.some((g) => g.sectionIdx === defaultSectionIdx)) {
    defaultSectionIdx = nonEmptyGroups[nonEmptyGroups.length - 1].sectionIdx;
  }

  const sectionDd = siteCreateDropdownField(
    nonEmptyGroups.map((g) => ({ value: String(g.sectionIdx), label: formsSectionHeaderLabel(g.section, g.sectionIdx) })),
    String(defaultSectionIdx));
  form.appendChild(siteEditField('Sektion', sectionDd));

  // A plain .edit-field built by hand (not siteEditField) since its own
  // dropdown is rebuilt from scratch on every section change below —
  // siteEditField only ever wraps one fixed element.
  const fieldFieldWrap = el('div', 'edit-field');
  fieldFieldWrap.appendChild(el('label', null, 'Spørgsmål'));
  const fieldDdSlot = el('div');
  fieldFieldWrap.appendChild(fieldDdSlot);
  form.appendChild(fieldFieldWrap);

  const valuesWrap = el('div', 'forms-checkbox-list');
  form.appendChild(valuesWrap);

  let fieldDd = null;

  function defaultFieldIdFor(secIdx) {
    const g = groups.find((gg) => gg.sectionIdx === secIdx);
    if (!g || g.fields.length === 0) return null;
    if (existing && g.fields.some((f) => f.id === existing.fieldId)) return existing.fieldId;
    return g.fields[g.fields.length - 1].id; // closest field above
  }

  function renderValueOptions() {
    valuesWrap.replaceChildren();
    const g = groups.find((gg) => gg.sectionIdx === Number(sectionDd.value));
    const controlling = g && g.fields.find((f) => f.id === fieldDd.value);
    if (!controlling) return;
    const options = formsDependencyOptionsForField(controlling);
    const currentValues = (existing && existing.fieldId === fieldDd.value) ? existing.values : [];
    const boxes = [];
    for (const opt of options) {
      const optRow = el('label', 'forms-checkbox-row');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = currentValues.includes(opt.value);
      optRow.appendChild(cb);
      optRow.appendChild(document.createTextNode(opt.label));
      valuesWrap.appendChild(optRow);
      boxes.push({ cb, value: opt.value });
    }
    valuesWrap.formsSelectedValues = () => boxes.filter((b) => b.cb.checked).map((b) => b.value);
  }

  function renderFieldDropdown() {
    const secIdx = Number(sectionDd.value);
    const g = groups.find((gg) => gg.sectionIdx === secIdx);
    const fields = g ? g.fields : [];
    const defaultId = defaultFieldIdFor(secIdx) || (fields[0] && fields[0].id) || '';
    fieldDd = siteCreateDropdownField(
      fields.map((f) => ({ value: f.id, label: f.label || '(uden titel)' })), defaultId);
    fieldDd.addEventListener('change', renderValueOptions);
    fieldDdSlot.replaceChildren(fieldDd);
    renderValueOptions();
  }
  renderFieldDropdown();
  sectionDd.addEventListener('change', renderFieldDropdown);

  const depError = el('p', 'forms-msg error');
  form.appendChild(depError);

  // No Annuller here — the modal's own X (siteOpenModalWithClose) already
  // covers that, so only real actions sit in the button row.
  if (existing) {
    const removeBtn = formsPillBtn('Fjern', 'site-btn-danger');
    removeBtn.addEventListener('click', () => { close(); onRemove(); });
    actions.appendChild(removeBtn);
  }
  const saveBtn = formsPillBtn('Gem', 'site-btn-success');
  saveBtn.addEventListener('click', () => {
    const values = valuesWrap.formsSelectedValues ? valuesWrap.formsSelectedValues() : [];
    if (!fieldDd || !fieldDd.value) { depError.textContent = 'Vælg et spørgsmål.'; return; }
    if (values.length === 0) { depError.textContent = 'Vælg mindst ét svar.'; return; }
    onSave({ fieldId: fieldDd.value, values });
    close();
  });
  actions.appendChild(saveBtn);
}

function formsRenderFieldTypeConfig(field, onChange) {
  if (field.type === 'text' || field.type === 'textarea') return formsRenderPlaceholderConfig(field, onChange);
  if (field.type === 'select' || field.type === 'checkboxes') return formsRenderOptionsEditor(field, onChange);
  if (field.type === 'scale') return formsRenderScaleConfig(field, onChange);
  if (field.type === 'grid_single' || field.type === 'grid_multi') return formsRenderGridConfig(field, onChange);
  return null;
}

// Kort svar/Langt svar's only config: the placeholder text shown inside
// the empty input when a revyst visitor fills the form in.
function formsRenderPlaceholderConfig(field, onChange) {
  const wrap = el('div', 'forms-options-editor');
  const input = el('input');
  input.type = 'text';
  input.placeholder = 'fx Skriv dit svar her';
  input.value = field.placeholder || '';
  input.addEventListener('input', () => { field.placeholder = input.value; onChange(); });
  wrap.appendChild(siteEditField('Pladsholder (valgfri)', input));
  return wrap;
}

// Flat "one input per option + remove" editor operating on `options` in
// place — shared by select/checkboxes' manual source and grid columns
// (always manual). Each option is a single line of text: its value and
// label are kept identical, since nothing downstream (fill-in view,
// responses table, CSV export) ever showed a separate machine value to
// anyone — the second input just asked the admin to fill in an internal
// detail nobody could see the point of.
function formsRenderManualOptionsList(options, onChange, rerender) {
  const wrap = el('div');
  const optList = el('div', 'forms-option-list');
  options.forEach((opt, i) => {
    const optRow = el('div', 'forms-option-row');
    const textInput = el('input');
    textInput.type = 'text';
    textInput.placeholder = 'Valgmulighed';
    textInput.value = opt.label || opt.value || '';
    textInput.addEventListener('input', () => {
      opt.label = textInput.value;
      opt.value = textInput.value;
      onChange();
    });
    const rm = el('button', 'boss-edit-remove', '✕');
    rm.type = 'button';
    rm.addEventListener('click', () => { options.splice(i, 1); rerender(); onChange(); });
    optRow.appendChild(textInput);
    optRow.appendChild(rm);
    optList.appendChild(optRow);
  });
  wrap.appendChild(optList);
  const addOpt = el('button', 'btn-small', '+ Tilføj valgmulighed');
  addOpt.type = 'button';
  addOpt.addEventListener('click', () => {
    options.push({ value: '', label: '' });
    rerender();
    onChange();
  });
  wrap.appendChild(addOpt);
  return wrap;
}

// Skala's config: an integer range (0-10) plus optional end labels (e.g.
// "Lavt"/"Højt"), rendered on the fill-in side as a horizontal row of
// numbered radio circles (formsRenderRadioRow).
function formsRenderScaleConfig(field, onChange) {
  const wrap = el('div', 'forms-options-editor');
  if (typeof field.scaleMin !== 'number') field.scaleMin = 1;
  if (typeof field.scaleMax !== 'number') field.scaleMax = 5;

  const rangeRow = el('div', 'edit-field-row');
  const minInput = el('input');
  minInput.type = 'number';
  minInput.min = '0'; minInput.max = '10';
  minInput.value = String(field.scaleMin);
  minInput.addEventListener('input', () => {
    const v = parseInt(minInput.value, 10);
    field.scaleMin = Number.isFinite(v) ? v : 0;
    onChange();
  });
  rangeRow.appendChild(siteEditField('Fra', minInput));

  const maxInput = el('input');
  maxInput.type = 'number';
  maxInput.min = '1'; maxInput.max = '10';
  maxInput.value = String(field.scaleMax);
  maxInput.addEventListener('input', () => {
    const v = parseInt(maxInput.value, 10);
    field.scaleMax = Number.isFinite(v) ? v : 5;
    onChange();
  });
  rangeRow.appendChild(siteEditField('Til', maxInput));
  wrap.appendChild(rangeRow);

  const labelsRow = el('div', 'edit-field-row');
  const minLabelInput = el('input');
  minLabelInput.type = 'text';
  minLabelInput.placeholder = 'fx Lavt';
  minLabelInput.value = field.scaleMinLabel || '';
  minLabelInput.addEventListener('input', () => { field.scaleMinLabel = minLabelInput.value; onChange(); });
  labelsRow.appendChild(siteEditField('Label ved start (valgfri)', minLabelInput));

  const maxLabelInput = el('input');
  maxLabelInput.type = 'text';
  maxLabelInput.placeholder = 'fx Højt';
  maxLabelInput.value = field.scaleMaxLabel || '';
  maxLabelInput.addEventListener('input', () => { field.scaleMaxLabel = maxLabelInput.value; onChange(); });
  labelsRow.appendChild(siteEditField('Label ved slut (valgfri)', maxLabelInput));
  wrap.appendChild(labelsRow);

  return wrap;
}

// Grid's config: a list of Rækker (rows, each just a label — {id, label}
// so a later rename doesn't disturb already-submitted answers keyed by
// id) and a list of Kolonner (columns), the latter built on the same
// manual-options editor as select/checkboxes since grid columns are
// always manual (no live-sourced scenes/rehearsals option here).
function formsRenderGridConfig(field, onChange) {
  const wrap = el('div', 'forms-options-editor');
  if (!Array.isArray(field.rows) || field.rows.length === 0) field.rows = [{ id: formsNewFieldId(), label: '' }];
  if (!Array.isArray(field.options)) field.options = [];

  wrap.appendChild(el('div', 'forms-felter-label', 'Rækker'));
  const rowsWrap = el('div');
  wrap.appendChild(rowsWrap);
  function renderRows() {
    rowsWrap.replaceChildren();
    const list = el('div', 'forms-option-list');
    field.rows.forEach((r, i) => {
      const rRow = el('div', 'forms-option-row');
      const input = el('input');
      input.type = 'text';
      input.placeholder = 'Række';
      input.value = r.label || '';
      input.addEventListener('input', () => { r.label = input.value; onChange(); });
      const rm = el('button', 'boss-edit-remove', '✕');
      rm.type = 'button';
      rm.addEventListener('click', () => { field.rows.splice(i, 1); renderRows(); onChange(); });
      rRow.appendChild(input);
      rRow.appendChild(rm);
      list.appendChild(rRow);
    });
    rowsWrap.appendChild(list);
    const addBtn = el('button', 'btn-small', '+ Tilføj række');
    addBtn.type = 'button';
    addBtn.addEventListener('click', () => {
      field.rows.push({ id: formsNewFieldId(), label: '' });
      renderRows();
      onChange();
    });
    rowsWrap.appendChild(addBtn);
  }
  renderRows();

  wrap.appendChild(el('div', 'forms-felter-label', 'Kolonner'));
  const colsWrap = el('div');
  wrap.appendChild(colsWrap);
  function renderCols() {
    colsWrap.replaceChildren();
    colsWrap.appendChild(formsRenderManualOptionsList(field.options, onChange, renderCols));
  }
  renderCols();

  return wrap;
}

// Select/checkboxes' options are always manually typed now — the earlier
// "Valgmuligheder fra" (Skriv selv / Scener / Prøver-kalender) picker is
// gone, since manual was the only source anyone actually used. A field
// from before this change that still has a live source gets silently
// normalized back to manual the first time it's opened here; the live-
// resolution code (formsOptionsFromScenes/Rehearsals, formsResolveOptions)
// stays in place so any such already-saved field still renders correctly
// in the fill-in view until it's next edited and re-saved.
function formsRenderOptionsEditor(field, onChange) {
  if (field.optionsSource !== 'manual') {
    field.optionsSource = 'manual';
    delete field.sourceFilter;
  }
  if (!Array.isArray(field.options)) field.options = [];

  const wrap = el('div', 'forms-options-editor');
  function renderBody() {
    wrap.replaceChildren();
    wrap.appendChild(formsRenderManualOptionsList(field.options, onChange, renderBody));
  }
  renderBody();
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
    if (f.type === 'scale') {
      const min = Number(f.scaleMin), max = Number(f.scaleMax);
      if (!Number.isInteger(min) || !Number.isInteger(max) || min < 0 || max > 10 || min >= max) {
        return { error: `Angiv et gyldigt interval (0-10) for "${f.label}".` };
      }
    }
    if (f.type === 'grid_single' || f.type === 'grid_multi') {
      const rows = Array.isArray(f.rows) ? f.rows.filter((r) => r.label && r.label.trim()) : [];
      if (rows.length === 0) return { error: `Tilføj mindst én række til "${f.label}".` };
      const cols = Array.isArray(f.options) ? f.options.filter((o) => o.value && o.label) : [];
      if (cols.length === 0) return { error: `Tilføj mindst én kolonne til "${f.label}".` };
    }
  }
  return {
    fields: draftFields.map((f) => {
      const clean = { id: f.id, type: f.type, label: f.label.trim(), required: !!f.required };
      if (f.optionsSource) clean.optionsSource = f.optionsSource;
      if (f.sourceFilter !== undefined) clean.sourceFilter = f.sourceFilter;
      if (f.type === 'text' || f.type === 'textarea') {
        clean.placeholder = (f.placeholder || '').trim();
      } else if (f.type === 'select' || f.type === 'checkboxes') {
        if (f.options) clean.options = f.options.filter((o) => o.value && o.label);
      } else if (f.type === 'scale') {
        clean.scaleMin = Number(f.scaleMin);
        clean.scaleMax = Number(f.scaleMax);
        clean.scaleMinLabel = (f.scaleMinLabel || '').trim();
        clean.scaleMaxLabel = (f.scaleMaxLabel || '').trim();
      } else if (f.type === 'grid_single' || f.type === 'grid_multi') {
        clean.rows = (Array.isArray(f.rows) ? f.rows : [])
          .filter((r) => r.label && r.label.trim())
          .map((r) => ({ id: r.id, label: r.label.trim() }));
        clean.options = (Array.isArray(f.options) ? f.options : []).filter((o) => o.value && o.label);
      }
      // Shape-only here (does the field/its controller actually exist and
      // line up in order?) — the server is the authoritative check, same
      // division of labor as everywhere else on this page (see
      // forms_validate_field_spec's own dependsOn block).
      if (f.dependsOn && typeof f.dependsOn.fieldId === 'string' && f.dependsOn.fieldId
          && Array.isArray(f.dependsOn.values) && f.dependsOn.values.length > 0) {
        clean.dependsOn = { fieldId: f.dependsOn.fieldId, values: f.dependsOn.values.slice() };
      }
      return clean;
    }),
  };
}

// Same idea as formsValidateAndCleanFields, one level up: every section
// needs its own non-empty title before it's worth saving, and its fields go
// through the exact same per-field cleanup.
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
// from / manage templates) into one dropdown menu. Titel/Status/Frist/
// Revy are the form's only settings; every question lives in one
// or more uniform sections (title, description, fields) below, added via
// "+ Tilføj sektion" and always at least one.
function formsRenderBuilderScreen(root, existingDefinition) {
  const isEdit = !!(existingDefinition && existingDefinition.id);
  // Editing questions/sections on a form that already has responses would
  // silently orphan old answers (they're keyed by field id — see
  // formsAnswerColumns) — locked below, once the sections list has rendered.
  // Metadata (title/status/deadline/Revy) stays editable regardless.
  const locked = isEdit && (existingDefinition.responseCount || 0) > 0;
  const card = el('section', 'card forms-builder-card');
  root.appendChild(card);

  const head = el('div', 'forms-builder-head');
  head.appendChild(el('h2', null, isEdit ? 'Rediger formular' : 'Ny formular'));
  card.appendChild(head);

  // Every section (including the first) is a uniform {id, title,
  // description, fields} block, rendered by the same formsRenderSectionBlock
  // — there's no separate "the form's own fields" list any more. Title/
  // Status/Frist/Revy below are the form's only remaining
  // settings, since the fill-in view no longer shows a form-level
  // description (see renderFormFillIn) and it never had one after this).
  const draftSections = formsSectionsFromDefinition(existingDefinition);
  if (draftSections.length === 0 && !existingDefinition) {
    draftSections.push({
      id: formsNewFieldId(), title: '', description: '',
      fields: [{ id: formsNewFieldId(), type: 'text', label: 'Navn', required: true }],
    });
  }
  // Editing an existing form starts with every section collapsed (there's
  // already content to skim via the "Sektion N: <title>" header) — a brand
  // new form's sections stay open, since there's nothing yet to hide.
  if (isEdit) draftSections.forEach((s) => { s.collapsed = true; });

  let sectionsListEl; // assigned below
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
      // Same as opening an existing form for editing — start every
      // section collapsed rather than dumping the whole template open.
      const templateSections = formsSectionsFromDefinition(template);
      templateSections.forEach((s) => { s.collapsed = true; });
      draftSections.splice(0, draftSections.length, ...templateSections);
      renderSectionsList();
      error.textContent = '';
    }));
  } else {
    // Deleting the whole form now lives here (top-right of its own edit
    // view) rather than as a row action in Oversigt — an X in the same
    // style as every other remove control on the page.
    const deleteBtn = el('button', 'boss-edit-remove forms-builder-delete', '✕');
    deleteBtn.type = 'button';
    deleteBtn.title = 'Slet formular';
    deleteBtn.setAttribute('aria-label', 'Slet formular');
    deleteBtn.addEventListener('click', () => formsOpenDeleteConfirm(root, existingDefinition));
    head.appendChild(deleteBtn);
  }

  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.value = existingDefinition ? existingDefinition.title : '';
  card.appendChild(siteEditField('Titel', titleInput));

  // Status/Synlighed/Frist/Revy are form-level metadata, shown once
  // regardless of how many sections the form has.
  const metaRow = el('div', 'edit-field-row');
  const statusDd = siteCreateDropdownField(
    [{ value: 'closed', label: 'Lukket' }, { value: 'open', label: 'Åben' }],
    existingDefinition ? existingDefinition.status : 'closed');
  metaRow.appendChild(siteEditField('Status', statusDd));

  // Gates access to this form's own responses (statistik + svar) server-side
  // (see forms_admin_read's visibility check) — 'admin' hides both from a
  // boss-level visitor, while the form itself (this builder, status toggle)
  // stays boss-editable regardless, same as every other Formularer action.
  const visibilityDd = siteCreateDropdownField(
    [{ value: 'boss', label: 'Bosser' }, { value: 'admin', label: 'Koordinatorer' }],
    existingDefinition && existingDefinition.visibility === 'admin' ? 'admin' : 'boss');
  metaRow.appendChild(siteEditField('Synlighed', visibilityDd));

  // Deadline is a single field: picking a day re-opens the same popup as a
  // time picker (see siteCreateDateTimeField) instead of a separate field.
  const deadlineField = siteCreateDateTimeField(existingDefinition ? existingDefinition.deadline : '');
  metaRow.appendChild(siteEditField('Frist (valgfri)', deadlineField));

  const existingYear = existingDefinition && existingDefinition.productionYear != null
    ? existingDefinition.productionYear : null;
  const revyDd = siteCreateDropdownField(formsRevyOptions(existingYear),
    String(existingYear != null ? existingYear : formsCurrentProductionYear()));
  metaRow.appendChild(siteEditField('Revy', revyDd));
  card.appendChild(metaRow);

  if (locked) {
    card.appendChild(el('p', 'forms-lock-banner',
      `Denne formular har allerede modtaget ${existingDefinition.responseCount} svar. ` +
      'Slet svarene for at redigere.'));
  }

  sectionsListEl = el('div', 'forms-sections-list');
  card.appendChild(sectionsListEl);
  renderSectionsList();
  if (locked) formsLockSectionsEditor(sectionsListEl);

  const addSectionBtn = el('button', 'btn-small', '+ Tilføj sektion');
  addSectionBtn.type = 'button';
  if (locked) formsLockClickIntercept(addSectionBtn);
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

  // Same far-left/true-centered/far-right layout as Budget's own
  // .budget-save-bar (Slet/Rediger/Gem), just with different colors/
  // actions: blue Skabelon, warm Annuller, green Gem.
  const actionsRow = el('div', 'forms-builder-actions');

  const saveAsTemplateBtn = el('button', 'site-btn-primary', 'Skabelon');
  saveAsTemplateBtn.type = 'button';
  saveAsTemplateBtn.addEventListener('click', async () => {
    error.textContent = '';
    const cleanedSections = formsValidateAndCleanSections(draftSections);
    if (cleanedSections.error) { error.textContent = cleanedSections.error; return; }
    saveAsTemplateBtn.disabled = true;
    const result = await formsApi('templates_list', {});
    saveAsTemplateBtn.disabled = false;
    if (!result.ok) { error.textContent = result.message || 'Kunne ikke hente skabeloner.'; return; }
    const templates = Array.isArray(result.data.templates) ? result.data.templates : [];
    formsOpenSaveAsTemplateModal(templates, titleInput.value, cleanedSections.sections);
  });

  const cancelBtn = el('button', 'site-btn-warm forms-builder-cancel', 'Annuller');
  cancelBtn.type = 'button';
  cancelBtn.addEventListener('click', () => formsGuardedNavigate(() => renderAdminView(root, { name: 'overview' })));

  const saveBtn = el('button', 'site-btn-success', 'Gem');
  saveBtn.type = 'button';
  saveBtn.addEventListener('click', async () => {
    error.textContent = '';
    const title = titleInput.value.trim();
    if (!title) { error.textContent = 'Skriv en titel.'; return; }
    const cleanedSections = formsValidateAndCleanSections(draftSections);
    if (cleanedSections.error) { error.textContent = cleanedSections.error; return; }
    const productionYear = parseInt(revyDd.value, 10);
    saveBtn.disabled = true;
    const payload = {
      title, status: statusDd.value, visibility: visibilityDd.value,
      deadline: deadlineField.value || null, productionYear,
      fromTemplateId: existingDefinition ? (existingDefinition.fromTemplateId || null) : null,
      fields: [], sections: cleanedSections.sections,
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

  // Baseline snapshot for the dirty-tracking above — taken once, right here
  // at the end of setup, so the initial scaffold (a brand new form's default
  // "Navn" field, or an existing form's just-loaded sections) never itself
  // reads as unsaved; only a real edit after this point does.
  formsBuilderDraft = { titleInput, statusDd, visibilityDd, deadlineField, revyDd, draftSections };
  formsBuilderSnapshot = formsBuilderSerializeForDiff(formsBuilderPayloadForDiff());
}

// Intercepts a click on `elm` — in the CAPTURE phase, before any of its
// own listeners run — and shows the lock toast instead of letting the
// click do anything. Deliberately not the native `disabled` attribute: a
// genuinely disabled control never dispatches a click at all (not even to
// an ancestor), so there'd be no way to catch an attempted edit and warn
// about it. e.preventDefault() cancels the click's own default action
// (e.g. a checkbox's toggle); e.stopImmediatePropagation() stops every
// other listener on the same dispatch (e.g. a delete-field button's own
// handler, or — via delegation, since capture travels down through
// ancestors first — a descendant's handler reached through containerEl)
// from ever running. The one exception is each section's own collapse/
// expand toggle, which should keep working even while locked.
function formsLockClickIntercept(elm) {
  elm.addEventListener('click', (e) => {
    if (e.target.closest('.forms-section-toggle')) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    formsShowLockToast();
  }, true);
}

// Locks an already-rendered sections list so a form's questions stay
// viewable but not editable once it has responses (see
// formsRenderBuilderScreen's own `locked` comment for why) — every
// input/textarea goes read-only (blocks typing while still dispatching
// events normally, unlike `disabled`) and every click within the
// container (buttons, checkboxes, the field-type picker) is caught by one
// delegated formsLockClickIntercept on the container itself.
function formsLockSectionsEditor(containerEl) {
  containerEl.querySelectorAll('input, textarea').forEach((elm) => { elm.readOnly = true; });
  formsLockClickIntercept(containerEl);
}

// A transient dark banner pinned to the bottom of the viewport — shown
// whenever a locked (already-answered) form's editor is clicked, since the
// read-only/click-swallowed controls above otherwise give no feedback for
// why nothing happened. Re-triggers its own auto-dismiss timer on repeat
// clicks rather than stacking multiple banners.
let formsLockToastEl = null;
let formsLockToastTimer = null;
function formsShowLockToast() {
  if (!formsLockToastEl) {
    formsLockToastEl = el('div', 'forms-lock-toast',
      'Denne formular har allerede modtaget svar og kan ikke redigeres, før alle svar er slettet under "Se svar".');
    document.body.appendChild(formsLockToastEl);
  }
  formsLockToastEl.classList.add('visible');
  clearTimeout(formsLockToastTimer);
  formsLockToastTimer = setTimeout(() => {
    if (formsLockToastEl) formsLockToastEl.classList.remove('visible');
  }, 3200);
}

// One section's editor block — every section, including the first, is the
// same shape and uses this same renderer: its own Titel/Beskrivelse, a
// Felter list built on formsRenderFieldEditor (generic over whatever fields
// array it's handed), and a "Slet sektion" that removes it and re-renders
// the whole sections list (so later sections re-number correctly; disabled
// when it's the only section left, since a form always needs at least one).
// "Sektion N" once a title is typed in becomes "Sektion N: <title>", so the
// collapsed header is actually identifying rather than just numbering.
function formsSectionHeaderLabel(section, idx) {
  const title = (section.title || '').trim();
  return 'Sektion ' + (idx + 1) + (title ? ': ' + title : '');
}

function formsRenderSectionBlock(section, idx, draftSections, onChange, rerenderAll) {
  const block = el('div', 'forms-section-block');

  // Collapsible, open by default — a disclosure button (chevron + "Sektion
  // N") toggles a body wrapper holding everything else. Collapse state
  // lives on `section.collapsed` (a client-only field the clean/save path
  // never copies out) rather than a local variable, since adding/removing
  // a section rebuilds every block from scratch — a plain local `let`
  // would silently re-open every other section whenever one changed.
  const head = el('div', 'forms-section-head');
  const toggleBtn = el('button', 'forms-section-toggle');
  toggleBtn.type = 'button';
  const chevron = el('span', 'forms-section-chevron', '▾');
  toggleBtn.appendChild(chevron);
  const labelSpan = el('span', null, formsSectionHeaderLabel(section, idx));
  toggleBtn.appendChild(labelSpan);
  head.appendChild(toggleBtn);

  const removeBtn = el('button', 'boss-edit-remove', '✕');
  removeBtn.type = 'button';
  removeBtn.title = 'Slet sektion';
  removeBtn.setAttribute('aria-label', 'Slet sektion');
  // A form always needs at least one section — can't delete the last one.
  removeBtn.disabled = draftSections.length <= 1;
  // Deleting a whole section can remove several fields at once — prune any
  // dependency elsewhere in the form pointing at one of them, same as a
  // single field's own removeBtn does.
  function pruneSectionFields() {
    for (const f of (Array.isArray(section.fields) ? section.fields : [])) {
      formsPruneDanglingDependencies(draftSections, f.id);
    }
  }
  removeBtn.addEventListener('click', () => {
    if (formsSectionIsEmpty(section)) {
      draftSections.splice(idx, 1);
      pruneSectionFields();
      rerenderAll();
      onChange();
    } else {
      formsOpenDeleteSectionConfirm(formsSectionHeaderLabel(section, idx), () => {
        draftSections.splice(idx, 1);
        pruneSectionFields();
        rerenderAll();
        onChange();
      });
    }
  });
  head.appendChild(removeBtn);
  block.appendChild(head);

  const bodyEl = el('div', 'forms-section-body');
  bodyEl.style.display = section.collapsed ? 'none' : '';
  block.appendChild(bodyEl);

  chevron.textContent = section.collapsed ? '▸' : '▾';
  toggleBtn.addEventListener('click', () => {
    section.collapsed = !section.collapsed;
    bodyEl.style.display = section.collapsed ? 'none' : '';
    chevron.textContent = section.collapsed ? '▸' : '▾';
  });

  const titleInput = el('input');
  titleInput.type = 'text';
  titleInput.placeholder = 'Sektionstitel';
  titleInput.value = section.title || '';
  titleInput.addEventListener('input', () => {
    section.title = titleInput.value;
    labelSpan.textContent = formsSectionHeaderLabel(section, idx);
    onChange();
  });
  bodyEl.appendChild(siteEditField('Titel', titleInput));

  const descInput = el('textarea');
  descInput.rows = 2;
  descInput.value = section.description || '';
  descInput.addEventListener('input', () => { section.description = descInput.value; onChange(); });
  bodyEl.appendChild(siteEditField('Beskrivelse', descInput));

  bodyEl.appendChild(el('div', 'forms-felter-label', 'Felter'));
  const fieldListEl = el('div', 'forms-field-list');
  bodyEl.appendChild(fieldListEl);
  if (!Array.isArray(section.fields)) section.fields = [];
  formsRenderFieldEditor(fieldListEl, section.fields, onChange, draftSections, idx);

  return block;
}

// A freshly added blank section (no title, no description, no field with
// an actual question typed in yet) deletes instantly — there's nothing to
// lose. Anything else confirms first, same as deleting a whole form.
function formsSectionIsEmpty(section) {
  if ((section.title || '').trim()) return false;
  if ((section.description || '').trim()) return false;
  const fields = Array.isArray(section.fields) ? section.fields : [];
  return !fields.some((f) => (f.label || '').trim());
}

function formsOpenDeleteSectionConfirm(sectionLabel, onConfirm) {
  const { modal, form, actions, close } = siteOpenEditModal(`Slet ${sectionLabel}`);
  modal.classList.add('forms-center-modal', 'forms-narrow-modal');
  form.appendChild(el('p', 'forms-intro', 'Dette kan ikke fortrydes.'));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

function formsOpenDeleteResponseConfirm(submittedAtLabel, onConfirm) {
  const { modal, form, actions, close } = siteOpenEditModal('Slet svar');
  modal.classList.add('forms-center-modal');
  form.appendChild(el('p', 'forms-intro', `Slet dette svar (indsendt ${submittedAtLabel})? Dette kan ikke fortrydes.`));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// A never-filled-in field (blank question text — the only thing that
// actually distinguishes "nothing to lose" here, same idea as
// formsSectionIsEmpty) deletes instantly; anything else confirms first.
function formsFieldIsEmpty(field) {
  return !((field.label || '').trim());
}

function formsOpenDeleteFieldConfirm(fieldLabel, onConfirm) {
  const { modal, form, actions, close } = siteOpenEditModal('Slet spørgsmål');
  modal.classList.add('forms-center-modal');
  const label = (fieldLabel || '').trim();
  form.appendChild(el('p', 'forms-intro',
    (label ? `Slet spørgsmålet "${label}"` : 'Slet dette spørgsmål') + '? Dette kan ikke fortrydes.'));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', () => { close(); onConfirm(); });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// ── Template menu ("Skabelon" dropdown, top-right of a new form) ─────
// Replaces the old separate "Opret fra skabelon"/"Skabeloner" modals with
// one dropdown: each row applies the template's sections to the current
// draft (via formsSectionsFromDefinition, so an old fields-only template
// still migrates cleanly); a grey ✕ opens a small delete-confirm instead,
// mirroring formsOpenDeleteConfirm's own pattern for forms.
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
  // Dynamic templates (FORMS_DYNAMIC_TEMPLATES) are always shown, above any
  // stored templates and independent of whether templates_list succeeded —
  // they need no network call, just SCENES_DATA/CALENDAR_DATA already
  // loaded on this page. No delete button: there's nothing stored to delete.
  for (const t of FORMS_DYNAMIC_TEMPLATES) {
    const row = el('div', 'forms-template-menu-row');
    const useBtn = el('button', 'site-list-row forms-template-menu-use');
    useBtn.type = 'button';
    useBtn.appendChild(el('div', 'forms-template-menu-title', t.title));
    useBtn.appendChild(el('div', 'forms-template-menu-desc', t.description));
    useBtn.addEventListener('click', () => { close(); onUse({ sections: t.generate() }); });
    row.appendChild(useBtn);
    pop.appendChild(row);
  }
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
  const { modal, form, error, actions, close } = siteOpenEditModal('Slet skabelon');
  modal.classList.add('forms-center-modal');
  form.appendChild(el('p', 'forms-intro', `Slet skabelonen "${t.title}" permanent? Dette kan ikke fortrydes.`));
  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Slet', 'site-btn-danger');
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    const result = await formsApi('templates_delete', { id: t.id });
    if (result.ok) { close(); siteShowToast('Skabelon slettet.'); }
    else { confirmBtn.disabled = false; if (result.message) error.textContent = result.message; }
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
}

// "Skabelon" button modal — a dropdown picks either an existing template
// (to overwrite with the current draft's sections, keeping that template's
// own title/description untouched) or "+ Tilføj ny skabelon", which is the
// only case that still asks for a title (no description field any more —
// nothing on this page ever showed a template's description besides the
// old "Skabelon ▾" menu, and typing one here was one more thing to fill in
// for a field that mostly stayed blank).
const FORMS_NEW_TEMPLATE_VALUE = '__new__';
function formsOpenSaveAsTemplateModal(templates, suggestedTitle, sections) {
  const { form, error, actions, close } = siteOpenModalWithClose('Gem som skabelon');

  const pickerOptions = [
    { value: FORMS_NEW_TEMPLATE_VALUE, label: '+ Tilføj ny skabelon' },
    ...templates.map((t) => ({ value: t.id, label: t.title })),
  ];
  const pickerDd = siteCreateDropdownField(pickerOptions, FORMS_NEW_TEMPLATE_VALUE);
  form.appendChild(siteEditField('Skabelon', pickerDd));

  const nameInput = el('input');
  nameInput.type = 'text';
  nameInput.value = suggestedTitle || '';
  const nameField = siteEditField('Navn på skabelon', nameInput);
  form.appendChild(nameField);

  const cancelBtn = formsPillBtn('Annuller');
  cancelBtn.addEventListener('click', close);
  const confirmBtn = formsPillBtn('Opret', 'site-btn-success');

  function syncForSelection() {
    const isNew = pickerDd.value === FORMS_NEW_TEMPLATE_VALUE;
    nameField.style.display = isNew ? '' : 'none';
    confirmBtn.textContent = isNew ? 'Opret' : 'Opdater';
  }
  syncForSelection();
  pickerDd.addEventListener('change', syncForSelection);

  confirmBtn.addEventListener('click', async () => {
    error.textContent = '';
    const isNew = pickerDd.value === FORMS_NEW_TEMPLATE_VALUE;
    let payload;
    if (isNew) {
      const title = nameInput.value.trim();
      if (!title) { error.textContent = 'Skriv et navn.'; return; }
      payload = { title, description: '', fields: [], sections };
    } else {
      const existing = templates.find((t) => t.id === pickerDd.value);
      payload = { id: existing.id, title: existing.title, description: existing.description || '', fields: [], sections };
    }
    confirmBtn.disabled = true;
    const result = await formsApi('templates_save', payload);
    confirmBtn.disabled = false;
    if (result.ok) { close(); siteShowToast(isNew ? 'Skabelon gemt.' : 'Skabelon opdateret.'); }
    else if (result.message) error.textContent = result.message;
  });
  actions.appendChild(cancelBtn);
  actions.appendChild(confirmBtn);
  if (pickerDd.value === FORMS_NEW_TEMPLATE_VALUE) nameInput.focus();
}

// dd/mm/yyyy kl. hh:mm — deliberately the compact numeric style rather
// than site-utils.js's formatDaDateTime ("5. august 2026 kl. 10:00"),
// since the Sendt column is capped to 200px (see .forms-responses-table
// th/td) and needs to stay short. Reuses site-utils.js's parseIsoDateTime
// so a floating local timestamp is still built from its own parts, not
// re-parsed as UTC.
function formsFormatSubmittedAt(iso) {
  const d = parseIsoDateTime(iso);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} kl. ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Full-text hover tooltip for a truncated response cell. A plain CSS
// ::after (the .forms-row-icon-btn convention) doesn't work here: it'd be
// clipped by .forms-responses-wrap's own overflow-x:auto, which per the
// CSS overflow spec forces overflow-y to 'auto' too, cutting the tooltip
// off for any row near the table's top/bottom edge. A native `title`
// attribute avoids the clipping but is sluggish and inconsistent, and
// (worse) pops up over every cell, even ones that already show their
// full text unclipped. This instead builds a single position:fixed
// element on <body> — outside any clipping ancestor, like the shared
// field-popup chrome in site-utils.js — shown only while genuinely
// truncated (scrollWidth > clientWidth).
let formsResponseTooltipEl = null;
function formsShowResponseTooltip(anchor, text) {
  formsHideResponseTooltip();
  const tip = el('div', 'forms-response-tooltip', text);
  document.body.appendChild(tip);
  const anchorRect = anchor.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  let top = anchorRect.top - tipRect.height - 6;
  if (top < 4) top = anchorRect.bottom + 6;
  let left = anchorRect.left;
  if (left + tipRect.width > window.innerWidth - 4) left = window.innerWidth - tipRect.width - 4;
  if (left < 4) left = 4;
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  formsResponseTooltipEl = tip;
}
function formsHideResponseTooltip() {
  if (formsResponseTooltipEl) { formsResponseTooltipEl.remove(); formsResponseTooltipEl = null; }
}

// A responses-table cell whose text is wrapped in an inner span capped to
// 200px with an ellipsis (see .forms-response-cell-text in forms.css —
// the cap has to live on this inner wrapper, not the <td>/<th> itself, to
// actually be respected under the table's auto layout).
function formsResponseCell(tag, text) {
  const cell = el(tag);
  const inner = el('span', 'forms-response-cell-text', text);
  inner.addEventListener('mouseenter', () => {
    if (inner.scrollWidth > inner.clientWidth) formsShowResponseTooltip(inner, text);
  });
  inner.addEventListener('mouseleave', formsHideResponseTooltip);
  cell.appendChild(inner);
  return cell;
}

// ── Responses screen ("Se svar" row action) + CSV export ─────
// Appended below the tab bar renderAdminView already rendered (Oversigt
// stays the active tab — this is a view onto one form from within
// Oversigt, not a separate tab, so there's no dedicated back button; the
// Oversigt tab itself goes back). Deliberately full-width rather than the
// 720px Oversigt/builder column — a response table can get wide, and a
// horizontal scrollbar reads better than every column being squeezed
// to fit.
async function formsRenderResponsesScreen(root, formId) {
  const card = el('section', 'card');
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
  body.appendChild(el('h2', null, definition.title));
  // forms_admin_read withholds responses (never the definition) for a
  // boss-level visitor when Synlighed is "Koordinatorer" — the row's own
  // disabled Svar-button already keeps a boss from reaching this screen
  // normally, this is the server-enforced backstop.
  if (result.data.responsesRestricted) {
    body.appendChild(el('p', 'forms-msg error',
      'Svarene for denne formular er kun tilgængelige for koordinatorer.'));
    return;
  }
  const responses = Array.isArray(result.data.responses) ? result.data.responses : [];

  if (responses.length === 0) {
    body.appendChild(el('p', 'forms-intro', 'Ingen svar endnu.'));
    return;
  }

  const columns = formsAnswerColumns(definition);
  const wrap = el('div', 'forms-responses-wrap');
  // A stray mouseenter can leave the fixed tooltip anchored to a cell that
  // has since scrolled out from under it (the horizontal scrollbar moves
  // cells without necessarily firing mouseleave) — drop it on any scroll.
  wrap.addEventListener('scroll', formsHideResponseTooltip);
  const table = el('table', 'forms-responses-table');
  const thead = el('thead');
  const headRow = el('tr');
  headRow.appendChild(el('th')); // delete-button column, no label
  headRow.appendChild(formsResponseCell('th', 'Sendt'));
  columns.forEach((c) => headRow.appendChild(formsResponseCell('th', c.label)));
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = el('tbody');
  for (const r of responses) {
    const row = el('tr');
    const deleteCell = el('td');
    const deleteBtn = el('button', 'boss-edit-remove', '✕');
    deleteBtn.type = 'button';
    deleteBtn.title = 'Slet svar';
    deleteBtn.setAttribute('aria-label', 'Slet svar');
    deleteBtn.addEventListener('click', () => {
      formsOpenDeleteResponseConfirm(formsFormatSubmittedAt(r.submittedAt), async () => {
        const del = await formsApi('forms_delete_response', { formId, responseId: r.id });
        if (del.ok) renderAdminView(root, { name: 'responses', formId });
      });
    });
    deleteCell.appendChild(deleteBtn);
    row.appendChild(deleteCell);
    row.appendChild(formsResponseCell('td', formsFormatSubmittedAt(r.submittedAt)));
    for (const c of columns) {
      row.appendChild(formsResponseCell('td', c.get(r.answers)));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  body.appendChild(wrap);

  const exportBtn = el('button', 'btn-small forms-export-btn', 'Eksportér CSV');
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

// Same ordering as formsAllFields, but a grid question expands into one
// column per row (its answer is a {rowId: value} map, not a single value)
// — everything else still maps to exactly one column. Used by both the
// responses table and CSV export so they always agree on shape.
function formsAnswerColumns(definition) {
  const columns = [];
  for (const field of formsAllFields(definition)) {
    if (field.type === 'grid_single' || field.type === 'grid_multi') {
      for (const row of (Array.isArray(field.rows) ? field.rows : [])) {
        columns.push({
          label: `${field.label} — ${row.label}`,
          get: (answers) => {
            const cell = answers ? answers[field.id] : undefined;
            const v = cell && typeof cell === 'object' ? cell[row.id] : undefined;
            return formsFormatAnswerForDisplay(v);
          },
        });
      }
    } else {
      columns.push({
        label: field.label,
        get: (answers) => formsFormatAnswerForDisplay(answers ? answers[field.id] : undefined),
      });
    }
  }
  return columns;
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
  const columns = formsAnswerColumns(definition);
  const headers = ['Sendt', ...columns.map((c) => c.label)];
  const lines = [headers.map(formsCsvEscape).join(',')];
  for (const r of responses) {
    const row = [r.submittedAt, ...columns.map((c) => c.get(r.answers))];
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

// ── Statistik screen ("Se statistik" row action) ───────────────
// Appended below the tab bar renderAdminView already rendered (Oversigt
// stays the active tab, same in-page-view convention as
// formsRenderResponsesScreen above — no dedicated back button). Structured
// like the revyst fill-in view (one block per section, via the same
// formsSectionsFromDefinition helper renderFormFillIn uses) but every
// field renders an aggregate of its answers instead of an input, and every
// section shows on one scrollable page at once — read-only, so there's
// nothing to lose by seeing it all, unlike the fill-in view there's no
// prev/next paging here.
async function formsRenderStatsScreen(root, formId) {
  const card = el('section', 'card forms-form forms-fillin-wide');
  const body = el('div', null, 'Henter statistik …');
  card.appendChild(body);
  root.appendChild(card);

  const result = await formsApi('forms_admin_read', { formId });
  body.replaceChildren();
  if (!result.ok) {
    body.appendChild(el('p', 'forms-msg error', result.message || 'Kunne ikke hente statistik.'));
    return;
  }
  const definition = result.data.definition;
  body.appendChild(el('h2', null, definition.title));
  // See formsRenderResponsesScreen's own comment — same server-enforced
  // Synlighed backstop, here for the aggregated stats instead of raw svar.
  if (result.data.responsesRestricted) {
    body.appendChild(el('p', 'forms-msg error',
      'Statistikken for denne formular er kun tilgængelig for koordinatorer.'));
    return;
  }
  const responses = Array.isArray(result.data.responses) ? result.data.responses : [];
  body.appendChild(el('p', 'forms-stats-summary',
    responses.length === 1 ? '1 svar indsendt' : `${responses.length} svar indsendt`));

  if (responses.length === 0) {
    body.appendChild(el('p', 'forms-intro', 'Ingen svar endnu.'));
    return;
  }

  for (const pageDef of formsSectionsFromDefinition(definition)) {
    const pageEl = el('div', 'forms-fillin-page');
    if (pageDef.title) pageEl.appendChild(el('h3', 'forms-fillin-section-title', pageDef.title));
    if (pageDef.description) pageEl.appendChild(el('p', 'forms-intro', pageDef.description));
    for (const field of pageDef.fields) {
      pageEl.appendChild(siteEditField(field.label, formsRenderFieldStatsWidget(field, responses)));
    }
    body.appendChild(pageEl);
  }
}

// Dispatches by field.type, mirroring formsRenderAnswerInput's own
// type-switch above — but every branch here aggregates responses[]
// instead of building an interactive input.
function formsRenderFieldStatsWidget(field, responses) {
  if (field.type === 'select') {
    const agg = formsCountAnswers(field, responses);
    return formsStatsFieldWrap(agg.answeredCount, () => formsStatsDonut(formsStatsItems(agg)));
  }
  if (field.type === 'yesno') {
    // No FieldSpec.options to resolve — a synthetic two-option list stands
    // in so this reuses the exact same tally/pie widget as "Vælg én".
    const agg = formsCountAnswers(field, responses, [{ value: true, label: 'Ja' }, { value: false, label: 'Nej' }]);
    return formsStatsFieldWrap(agg.answeredCount, () => formsStatsDonut(formsStatsItems(agg)));
  }
  if (field.type === 'checkboxes') {
    const agg = formsCountAnswers(field, responses);
    return formsStatsFieldWrap(agg.answeredCount, () => formsStatsBarList(formsStatsItems(agg)));
  }
  if (field.type === 'scale') {
    const stats = formsScaleStats(field, responses);
    return formsStatsFieldWrap(stats.answeredCount, () => formsStatsScale(stats));
  }
  if (field.type === 'grid_single' || field.type === 'grid_multi') {
    const rowStats = formsGridStats(field, responses);
    const answered = rowStats.reduce((sum, r) => sum + r.answeredCount, 0);
    return formsStatsFieldWrap(answered, () => formsStatsGridChart(field, rowStats));
  }
  // text / textarea
  const values = formsTextAnswers(field, responses);
  return formsStatsFieldWrap(values.length, () => formsStatsComments(values));
}

// Shared "Ingen svar for dette spørgsmål" empty state — every field type
// above goes through this rather than rendering a chart with nothing in it.
function formsStatsFieldWrap(answeredCount, buildWidget) {
  if (answeredCount === 0) return el('p', 'forms-stats-empty', 'Ingen svar for dette spørgsmål.');
  return buildWidget();
}

// Tallies one select/checkboxes/yesno field's answers against its option
// list (resolved live via formsResolveOptions, the same helper the fill-in
// view uses — so a legacy scenes/rehearsals-sourced field still resolves
// to real labels here, not raw ids). overrideOptions lets yesno reuse this
// without a fake FieldSpec.options array. A raw stored value with no
// matching option (e.g. a since-deleted scene) still gets counted, just
// labeled with its own raw value instead of losing the response entirely.
function formsCountAnswers(field, responses, overrideOptions) {
  const options = overrideOptions || formsResolveOptions(field);
  const counts = new Map(options.map((o) => [String(o.value), 0]));
  const unknown = new Map();
  let answeredCount = 0;
  for (const r of responses) {
    const v = r.answers ? r.answers[field.id] : undefined;
    if (v === undefined || v === null || (Array.isArray(v) && v.length === 0)) continue;
    answeredCount++;
    for (const val of (Array.isArray(v) ? v : [v])) {
      const key = String(val);
      if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      else unknown.set(key, (unknown.get(key) || 0) + 1);
    }
  }
  const out = options.map((o) => ({ label: o.label, count: counts.get(String(o.value)) || 0 }));
  for (const [label, count] of unknown) out.push({ label, count });
  return { options: out, answeredCount };
}

// Turns a formsCountAnswers() result into {label, count, percent}[] against
// the number of respondents who actually answered this question (not the
// form's total submission count) — matches Google Forms' own convention
// and keeps an optional field from reading as artificially low.
function formsStatsItems(agg) {
  return agg.options.map((o) => ({
    label: o.label,
    count: o.count,
    percent: agg.answeredCount > 0 ? Math.round((o.count / agg.answeredCount) * 100) : 0,
  }));
}

// Buckets a Skala field's integer answers across its own [scaleMin,
// scaleMax] range (unlike formsCountAnswers, the "option list" here is a
// synthesized numeric range, not something formsResolveOptions produces)
// and computes the average of all answered values.
function formsScaleStats(field, responses) {
  const min = typeof field.scaleMin === 'number' ? field.scaleMin : 1;
  const max = typeof field.scaleMax === 'number' ? field.scaleMax : 5;
  const counts = new Map();
  for (let n = min; n <= max; n++) counts.set(n, 0);
  let answeredCount = 0;
  let sum = 0;
  for (const r of responses) {
    const v = r.answers ? r.answers[field.id] : undefined;
    if (typeof v !== 'number') continue;
    answeredCount++;
    sum += v;
    if (counts.has(v)) counts.set(v, counts.get(v) + 1);
  }
  const buckets = [];
  for (let n = min; n <= max; n++) buckets.push({ value: n, count: counts.get(n) || 0 });
  return { buckets, answeredCount, average: answeredCount > 0 ? sum / answeredCount : 0 };
}

// One formsCountAnswers-style tally per Gitter row, reading
// answers[field.id][row.id] instead of answers[field.id] directly (a
// grid_single/grid_multi answer is a {rowId: value} map — see
// forms_validate_answer server-side). Columns are formsResolveOptions(field)
// same as any select/checkboxes field, since a grid's "options" ARE its
// columns.
function formsGridStats(field, responses) {
  const options = formsResolveOptions(field);
  const rows = Array.isArray(field.rows) ? field.rows : [];
  return rows.map((row) => {
    const counts = new Map(options.map((o) => [String(o.value), 0]));
    let answeredCount = 0;
    for (const r of responses) {
      const cell = r.answers ? r.answers[field.id] : undefined;
      const v = cell && typeof cell === 'object' ? cell[row.id] : undefined;
      if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
      answeredCount++;
      for (const val of (Array.isArray(v) ? v : [v])) {
        const key = String(val);
        if (counts.has(key)) counts.set(key, counts.get(key) + 1);
      }
    }
    const items = options.map((o) => {
      const count = counts.get(String(o.value)) || 0;
      return { label: o.label, count, percent: answeredCount > 0 ? Math.round((count / answeredCount) * 100) : 0 };
    });
    return { row, items, answeredCount };
  });
}

// Non-empty, trimmed text/textarea answers in submission order — same
// "unanswered = key omitted or empty string" convention forms_submit
// stores server-side.
function formsTextAnswers(field, responses) {
  const out = [];
  for (const r of responses) {
    const v = r.answers ? r.answers[field.id] : undefined;
    if (typeof v === 'string' && v.trim() !== '') out.push(v.trim());
  }
  return out;
}

// Single-hue horizontal bar list — one row per option, used for Vælg
// flere and Skala's value histogram. Both share the site's own --accent
// blue rather than a categorical palette: these bars compare one
// question's own answer magnitudes, not distinct series identities (see
// FORMS_STATS_PALETTE's own comment above, and formsStatsGridChart below,
// for the one case — Gitter's grouped columns — that IS an identity
// comparison and does use that palette).
function formsStatsBarList(items) {
  const wrap = el('div', 'forms-stats-bar-list');
  for (const item of items) {
    const row = el('div', 'forms-stats-bar-row');
    row.appendChild(el('span', 'forms-stats-bar-label', item.label));
    const track = el('div', 'forms-stats-bar-track');
    const fill = el('div', 'forms-stats-bar-fill');
    fill.style.width = item.percent + '%';
    track.appendChild(fill);
    row.appendChild(track);
    row.appendChild(el('span', 'forms-stats-bar-value', `${item.count} (${item.percent}%)`));
    wrap.appendChild(row);
  }
  return wrap;
}

// Skala: the same bar-list primitive as formsStatsBarList, one row per
// scale value, plus the average prominently displayed above it.
function formsStatsScale(stats) {
  const wrap = el('div', 'forms-stats-scale');
  wrap.appendChild(el('div', 'forms-stats-scale-avg', `Gennemsnit: ${stats.average.toFixed(1)}`));
  const items = stats.buckets.map((b) => ({
    label: String(b.value),
    count: b.count,
    percent: stats.answeredCount > 0 ? Math.round((b.count / stats.answeredCount) * 100) : 0,
  }));
  wrap.appendChild(formsStatsBarList(items));
  return wrap;
}

// "Nice" axis max/step for the Gitter combined chart's shared y-axis —
// standard nice-number rounding (1/2/5 × 10^n, clamped to whole numbers
// since these are answer counts) so ticks land on round values (0, 5, 10,
// 15, 20, ...) instead of the raw max count.
function formsNiceAxis(rawMax) {
  if (rawMax <= 0) return { max: 1, step: 1 };
  const roughStep = rawMax / 4;
  const mag = Math.max(1, Math.pow(10, Math.floor(Math.log10(roughStep))));
  const norm = roughStep / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  return { max: Math.ceil(rawMax / step) * step, step };
}

// Gitter: one combined grouped column chart, not a separate chart per row
// — every row shares the same y-axis (answer count), so a comparison
// across rows (e.g. one rehearsal date vs. another) reads directly, the
// way a Google Sheets grouped bar chart would. Each row is one x-axis
// group; each column option is one bar within it, colored by
// FORMS_STATS_PALETTE (this IS an identity comparison — which option per
// row — unlike the single-hue bars above) with a shared legend up top.
function formsStatsGridChart(field, rowStatsList) {
  const columns = formsResolveOptions(field);
  const wrap = el('div', 'forms-stats-gridchart');

  const legend = el('div', 'forms-stats-gridchart-legend');
  columns.forEach((c, i) => {
    const item = el('span', 'forms-stats-gridchart-legend-item');
    const swatch = el('span', 'forms-stats-gridchart-legend-swatch');
    swatch.style.background = FORMS_STATS_PALETTE[i % FORMS_STATS_PALETTE.length];
    item.appendChild(swatch);
    item.appendChild(document.createTextNode(c.label));
    legend.appendChild(item);
  });
  wrap.appendChild(legend);

  const rawMax = rowStatsList.reduce(
    (m, r) => r.items.reduce((rm, it) => Math.max(rm, it.count), m), 0);
  const axis = formsNiceAxis(rawMax);

  const plotRow = el('div', 'forms-stats-gridchart-plot-row');

  const yAxis = el('div', 'forms-stats-gridchart-yaxis');
  for (let v = axis.max; v >= 0; v -= axis.step) {
    const tick = el('span', 'forms-stats-gridchart-tick', String(v));
    tick.style.bottom = (v / axis.max) * 100 + '%';
    yAxis.appendChild(tick);
  }
  plotRow.appendChild(yAxis);

  // The plot (gridlines + bars) and the row labels below it scroll
  // together as one block, same overflow-x:auto convention as
  // .forms-grid-wrap/.forms-responses-wrap — only the y-axis stays fixed.
  const scroller = el('div', 'forms-stats-gridchart-scroller');
  const inner = el('div', 'forms-stats-gridchart-inner');
  const plot = el('div', 'forms-stats-gridchart-plot');
  for (let v = axis.step; v <= axis.max; v += axis.step) {
    const line = el('div', 'forms-stats-gridchart-gridline');
    line.style.bottom = (v / axis.max) * 100 + '%';
    plot.appendChild(line);
  }
  const groups = el('div', 'forms-stats-gridchart-groups');
  for (const { items } of rowStatsList) {
    const bars = el('div', 'forms-stats-gridchart-bars');
    items.forEach((item, i) => {
      const bar = el('div', 'forms-stats-gridchart-bar');
      bar.style.height = (item.count / axis.max) * 100 + '%';
      bar.style.background = FORMS_STATS_PALETTE[i % FORMS_STATS_PALETTE.length];
      bar.title = `${item.label}: ${item.count}`;
      bars.appendChild(bar);
    });
    groups.appendChild(bars);
  }
  plot.appendChild(groups);
  inner.appendChild(plot);
  const labels = el('div', 'forms-stats-gridchart-labels');
  for (const { row } of rowStatsList) {
    labels.appendChild(el('span', 'forms-stats-gridchart-group-label', row.label));
  }
  inner.appendChild(labels);
  scroller.appendChild(inner);
  plotRow.appendChild(scroller);
  wrap.appendChild(plotRow);

  return wrap;
}

// Vælg én / legacy yesno: a CSS conic-gradient pie built from cumulative
// percentages against FORMS_STATS_PALETTE, plus a legend (swatch + label +
// count + percent) — the legend, not the slice, carries the text, per the
// "text never wears the data color" rule (a light palette slot reads as
// illegible text on this site's own warm surface).
function formsStatsDonut(items) {
  const wrap = el('div', 'forms-stats-donut-wrap');
  const total = items.reduce((sum, i) => sum + i.count, 0);
  const circle = el('div', 'forms-stats-donut');
  if (total > 0) {
    let acc = 0;
    const stops = [];
    items.forEach((item, i) => {
      if (item.count === 0) return;
      const color = FORMS_STATS_PALETTE[i % FORMS_STATS_PALETTE.length];
      const start = (acc / total) * 360;
      acc += item.count;
      const end = (acc / total) * 360;
      stops.push(`${color} ${start}deg ${end}deg`);
    });
    circle.style.background = `conic-gradient(${stops.join(', ')})`;
  }
  wrap.appendChild(circle);
  const legend = el('div', 'forms-stats-legend');
  items.forEach((item, i) => {
    const row = el('div', 'forms-stats-legend-row');
    const swatch = el('span', 'forms-stats-legend-swatch');
    swatch.style.background = FORMS_STATS_PALETTE[i % FORMS_STATS_PALETTE.length];
    row.appendChild(swatch);
    row.appendChild(el('span', 'forms-stats-legend-label', item.label));
    row.appendChild(el('span', 'forms-stats-legend-value', `${item.count} (${item.percent}%)`));
    legend.appendChild(row);
  });
  wrap.appendChild(legend);
  return wrap;
}

// Kort svar / Langt svar: a scrollable list of the raw submitted text,
// same overflow-y:auto convention as .forms-responses-wrap's horizontal
// scroll container above — here vertical, since a comment list can run
// long but each entry doesn't need its own row width.
function formsStatsComments(values) {
  const wrap = el('div', 'forms-stats-comments');
  for (const v of values) wrap.appendChild(el('p', 'forms-stats-comment-row', v));
  return wrap;
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

  // Native beforeunload dialog — the one case a page can't restyle, but the
  // only mechanism that actually covers tab close/refresh/typed-URL/back
  // (mirrors manus.js's identical manusIsDirty/beforeunload pairing).
  window.addEventListener('beforeunload', (e) => {
    if (formsBuilderIsDirty()) { e.preventDefault(); e.returnValue = ''; }
  });

  // Site-styled stand-in for that native dialog, for the one case that CAN
  // be intercepted before the page unloads: clicking one of this page's own
  // in-page links (header nav, mobile menu nav, or any other outbound <a>).
  // Same gating as manus.js's own click interceptor — a new-tab/modified
  // click, a hash-only/javascript: link, or a click while nothing is
  // unsaved all pass through untouched.
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const link = e.target.closest('a[href]');
    if (!link || link.target === '_blank') return;
    const href = link.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) return;
    if (!formsBuilderIsDirty()) return;
    e.preventDefault();
    formsOpenLeaveWarning(() => { window.location.href = link.href; });
  }, true);
});
