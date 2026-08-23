<?php
// Copy this file to config.php (gitignored, never commit it) and fill in real values.
// config.php lives only on the Simply.com server.

// Fine-grained GitHub PAT scoped to just this repo, Contents: read & write only.
define('GITHUB_TOKEN', 'github_pat_XXXXXXXXXXXXXXXXXXXXXXXX');

define('GITHUB_OWNER', 'carljarner');
define('GITHUB_REPO', 'matrevy');

// The three shared site passwords, handed out verbally.
// - REVYST_PASSWORD unlocks the revyst-level pages and (later) revyst-level writes.
// - BOSS_PASSWORD additionally unlocks Øveplan/Koordinator and editing Manus/Kalender.
// - ADMIN_PASSWORD unlocks everything, including all saves.
define('REVYST_PASSWORD', 'skift-mig-revyst');
define('BOSS_PASSWORD', 'skift-mig-boss');
define('ADMIN_PASSWORD', 'skift-mig-admin');

// Legacy: the original manus-tool PIN. If still defined, it is accepted as an
// admin credential (for old cached clients). Delete this line once everyone
// uses the new login.
// define('SHARED_PIN', 'gammel-pin');

// Absolute path on the Simply.com host for the PRIVATE budget datastore
// (expense requests, paid ledger, receipt images). This data is deliberately
// kept OUT of the public GitHub repo — it holds names, phone numbers and
// receipt photos. The directory must be writable by PHP, and ideally sit
// OUTSIDE the public web root; if it must live under the web root, drop an
// `.htaccess` with `Require all denied` (Apache 2.4) / `Deny from all` in it.
// Each budget gets its own subdirectory here, named by its stable
// `budgetId` (`<budgetId>/budget.json`, `requests.json`, `expenses.json`,
// `receipts/`), created on first use. A `years.json` manifest
// ({activeBudgetId, years:[{budgetId, year, label, createdAt}, ...]}) lives
// at this same root, listing every budget and which one is currently
// active (where new revyst submissions/receipts land) — `year` is just a
// display/grouping field, not unique, so multiple budgets can share a
// calendar year (distinguished by `label`, which IS kept unique). There is
// no budget to start from on a brand-new deploy — bootstrap the first one
// via the admin actions `budget_create_year` then `budget_set_active_year`
// (e.g. from Budget's own "Start nyt budgetår" button) before anything else
// here will work; budget_submit responds 409 with "no_active_year" until then.
define('BUDGET_DATA_DIR', '/absolute/path/to/matrevy-budget-data');

// Absolute path on the Simply.com host for the PRIVATE forms datastore
// ("Formularer" page — self-hosted sign-up forms replacing the Google
// Forms coordinators built each year). Holds form/template definitions
// and every submitted response, which may contain names, phone numbers,
// and other personal answers — kept OUT of the public GitHub repo, same
// posture as BUDGET_DATA_DIR above. Must exist and be PHP-writable,
// ideally outside the public web root (or behind an .htaccess deny).
// Layout: templates.json at this root, plus forms/<formId>/{definition,
// responses}.json per form, created on first use — no bootstrap step
// needed (unlike Budget, there's no "active year" to seed first).
define('FORMS_DATA_DIR', '/absolute/path/to/matrevy-forms-data');
