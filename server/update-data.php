<?php
// Manus-tool global save proxy.
// Receives { pin, scenes, cast } from import.js's applyImport(), validates
// the PIN and payload shape, then commits data/scenes.json + data/cast.json
// to GitHub via the Contents API using a server-side-only PAT.
//
// Deploy this file + a real config.php (see config.example.php) to the
// Simply.com PHP hosting. Never commit config.php.

require __DIR__ . '/config.php';

// CORS: only the live site is allowed to call this endpoint.
$allowedOrigin = 'https://matematikrevy.dk';
header("Access-Control-Allow-Origin: $allowedOrigin");
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

function respond($code, $data) {
  http_response_code($code);
  echo json_encode($data);
  exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
  respond(405, ['error' => 'method_not_allowed']);
}

$body = json_decode(file_get_contents('php://input'), true);
if (!is_array($body)) {
  respond(400, ['error' => 'invalid_json']);
}

$pin = $body['pin'] ?? '';
if (!is_string($pin) || $pin === '' || !hash_equals(SHARED_PIN, $pin)) {
  respond(401, ['error' => 'invalid_pin']);
}

$scenesActs = $body['scenes'] ?? null;
$castList = $body['cast'] ?? null;
if (!is_array($scenesActs) || !is_array($castList)) {
  respond(400, ['error' => 'invalid_shape']);
}
foreach ($scenesActs as $act) {
  if (!is_array($act) || !isset($act['act'], $act['label'], $act['scenes']) || !is_array($act['scenes'])) {
    respond(400, ['error' => 'invalid_scenes_shape']);
  }
}
foreach ($castList as $c) {
  if (!is_array($c) || !isset($c['name'], $c['index'])) {
    respond(400, ['error' => 'invalid_cast_shape']);
  }
}

function github_api($method, $path, $payload = null) {
  $ch = curl_init('https://api.github.com/repos/' . GITHUB_OWNER . '/' . GITHUB_REPO . '/' . $path);
  curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER => [
      'Authorization: Bearer ' . GITHUB_TOKEN,
      'Accept: application/vnd.github+json',
      'User-Agent: matrevy-update-data',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => $method,
  ]);
  if ($payload !== null) {
    curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
  }
  $response = curl_exec($ch);
  if ($response === false) {
    respond(502, ['error' => 'github_unreachable', 'detail' => curl_error($ch)]);
  }
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  curl_close($ch);
  return [$status, json_decode($response, true)];
}

// Fetches the current file, applies $mutate to its decoded JSON, and writes
// it back with the sha it was read at (so a stale write 409s instead of
// silently clobbering a concurrent edit).
function update_file($filePath, $mutate, $commitMessage) {
  [$getStatus, $current] = github_api('GET', 'contents/' . $filePath);
  if ($getStatus !== 200) {
    respond(502, ['error' => 'github_read_failed', 'file' => $filePath, 'status' => $getStatus]);
  }

  $decoded = base64_decode($current['content']);
  $json = json_decode($decoded, true);
  if ($json === null) {
    respond(500, ['error' => 'existing_file_unparseable', 'file' => $filePath]);
  }

  $json = $mutate($json);

  [$putStatus, $putResult] = github_api('PUT', 'contents/' . $filePath, [
    'message' => $commitMessage,
    'content' => base64_encode(json_encode($json, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n"),
    'sha' => $current['sha'],
  ]);

  if ($putStatus === 409) {
    respond(409, ['error' => 'conflict', 'file' => $filePath]);
  }
  if ($putStatus < 200 || $putStatus >= 300) {
    respond(502, ['error' => 'github_write_failed', 'file' => $filePath, 'status' => $putStatus]);
  }
}

$today = date('Y-m-d');

update_file('data/scenes.json', function ($json) use ($scenesActs, $today) {
  $json['acts'] = $scenesActs;
  $json['version'] = $today;
  return $json;
}, 'Opdater scenes.json via manus-værktøj');

update_file('data/cast.json', function ($json) use ($castList) {
  $json['cast'] = $castList;
  return $json;
}, 'Opdater cast.json via manus-værktøj');

respond(200, ['ok' => true]);
