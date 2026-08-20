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
// Each production year gets its own subdirectory here (`<year>/budget.json`,
// `requests.json`, `expenses.json`, `receipts/`), created on first use of
// that year. A `years.json` manifest ({activeYear, years:[...]}) lives at
// this same root, listing every year and which one is currently active
// (where new revyst submissions/receipts land). There is no year to start
// from on a brand-new deploy — bootstrap the first one via the admin
// actions `budget_create_year` then `budget_set_active_year` (e.g. from
// Budget's own "Start nyt budgetår" button) before anything else here will
// work; budget_read/budget_submit both 500 with "no_active_year" until then.
define('BUDGET_DATA_DIR', '/absolute/path/to/matrevy-budget-data');
