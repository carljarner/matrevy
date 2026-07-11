<?php
// Copy this file to config.php (gitignored, never commit it) and fill in real values.
// config.php lives only on the Simply.com server.

// Fine-grained GitHub PAT scoped to just this repo, Contents: read & write only.
define('GITHUB_TOKEN', 'github_pat_XXXXXXXXXXXXXXXXXXXXXXXX');

define('GITHUB_OWNER', 'carljarner');
define('GITHUB_REPO', 'matrevy');

// The two shared site passwords, handed out verbally.
// - REVYST_PASSWORD unlocks the revyst-level pages and (later) revyst-level writes.
// - ADMIN_PASSWORD unlocks everything, including all saves.
define('REVYST_PASSWORD', 'skift-mig-revyst');
define('ADMIN_PASSWORD', 'skift-mig-admin');

// Legacy: the original manus-tool PIN. If still defined, it is accepted as an
// admin credential (for old cached clients). Delete this line once everyone
// uses the new login.
// define('SHARED_PIN', 'gammel-pin');
