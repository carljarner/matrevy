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

define('GITHUB_TOKEN', matrevy_env('GITHUB_TOKEN'));
define('GITHUB_OWNER', matrevy_env('GITHUB_OWNER', 'carljarner'));
define('GITHUB_REPO', matrevy_env('GITHUB_REPO', 'matrevy'));

define('REVYST_PASSWORD', matrevy_env('REVYST_PASSWORD'));
define('BOSS_PASSWORD', matrevy_env('BOSS_PASSWORD'));
define('ADMIN_PASSWORD', matrevy_env('ADMIN_PASSWORD'));

// Legacy manus-tool PIN, accepted as an admin credential when set.
// Leave the env var unset to disable it.
if (getenv('SHARED_PIN') !== false && getenv('SHARED_PIN') !== '') {
  define('SHARED_PIN', getenv('SHARED_PIN'));
}

define('BUDGET_DATA_DIR', matrevy_env('BUDGET_DATA_DIR', '/data/budget'));
define('FORMS_DATA_DIR', matrevy_env('FORMS_DATA_DIR', '/data/forms'));
define('FAELLESSPISNING_DATA_DIR', matrevy_env('FAELLESSPISNING_DATA_DIR', '/data/faellesspisning'));
