<?php
// Container config for the Coolify deployment: every value comes from an
// environment variable set in Coolify, so no secret lives in the repo.
// The Dockerfile copies this file to config.php next to update-data.php.
// (config.example.php documents what each value means.)

function matrevy_env($name, $default = null) {
  $value = getenv($name);
  if ($value === false || $value === '') {
    if ($default !== null) return $default;
    http_response_code(500);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['ok' => false, 'error' => 'missing_config', 'name' => $name]);
    exit;
  }
  return $value;
}

define('REVYST_PASSWORD', matrevy_env('REVYST_PASSWORD'));
define('BOSS_PASSWORD', matrevy_env('BOSS_PASSWORD'));
define('ADMIN_PASSWORD', matrevy_env('ADMIN_PASSWORD'));

// Satyr (below revyst: Budget's submit form + Fællesspisning's summary).
// Leave the env var unset to disable the satyr login.
if (getenv('SATYR_PASSWORD') !== false && getenv('SATYR_PASSWORD') !== '') {
  define('SATYR_PASSWORD', getenv('SATYR_PASSWORD'));
}

// Legacy manus-tool PIN, accepted as an admin credential when set.
// Leave the env var unset to disable it.
if (getenv('SHARED_PIN') !== false && getenv('SHARED_PIN') !== '') {
  define('SHARED_PIN', getenv('SHARED_PIN'));
}

define('BUDGET_DATA_DIR', matrevy_env('BUDGET_DATA_DIR', '/data/budget'));
define('FORMS_DATA_DIR', matrevy_env('FORMS_DATA_DIR', '/data/forms'));
define('FAELLESSPISNING_DATA_DIR', matrevy_env('FAELLESSPISNING_DATA_DIR', '/data/faellesspisning'));
define('BAND_DATA_DIR', matrevy_env('BAND_DATA_DIR', '/data/band'));
define('KOSTUME_DATA_DIR', matrevy_env('KOSTUME_DATA_DIR', '/data/kostumetinder'));
define('NINJAS_DATA_DIR', matrevy_env('NINJAS_DATA_DIR', '/data/ninjas'));
define('LOKALER_DATA_DIR', matrevy_env('LOKALER_DATA_DIR', '/data/lokaler'));
define('REKVISIT_DATA_DIR', matrevy_env('REKVISIT_DATA_DIR', '/data/rekvisitten'));
define('TEKNIK_DATA_DIR', matrevy_env('TEKNIK_DATA_DIR', '/data/teknikken'));
define('KOORD_DATA_DIR', matrevy_env('KOORD_DATA_DIR', '/data/koordinator'));

// Writable public site files (data/, archive/, posts/, wiki/, plus the
// worker's generated/ output). Served by Apache via the
// aliases in apache-site.conf; github_api() writes here instead of GitHub.
define('SITE_DATA_DIR', matrevy_env('SITE_DATA_DIR', '/data/site'));
