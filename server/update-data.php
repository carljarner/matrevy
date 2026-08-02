<?php
// Matematikrevyen API: login check + resource saves.
//
// Request shape (POST JSON):
//   { "action": "login", "password": "..." }
//     -> { "ok": true, "level": "revyst" | "admin" }
//   { "action": "save", "password": "...", "resource": "manus",
//     "payload": { ... resource-specific ... } }
//     -> { "ok": true }
//
// Passwords are the two shared site passwords (REVYST_PASSWORD /
// ADMIN_PASSWORD in config.php). Saves commit JSON files in data/
// to GitHub via the Contents API using a server-side-only PAT; a
// push to main triggers the embed-scenes.yml Action which
// regenerates the embedded *-data.js globals.
//
// Legacy shape { pin, scenes, cast } (the original manus-tool save)
// is still accepted and mapped onto action=save/resource=manus.
//
// Deploy this file + a real config.php (see config.example.php) to
// the Simply.com PHP hosting. Never commit config.php.

require __DIR__ . '/config.php';

// Every stored/returned timestamp (posts, comments) is a floating local
// Danish time, no UTC offset — same convention as the calendar .ics feed.
date_default_timezone_set('Europe/Copenhagen');

// CORS: only the live site is allowed to call this endpoint.
$allowedOrigin = 'https://matematikrevy.dk';
header("Access-Control-Allow-Origin: $allowedOrigin");
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');
header('Content-Type: application/json; charset=utf-8');

// A PHP fatal error partway through a request (as opposed to one of our own
// respond() calls) would otherwise produce a raw, header-less error page —
// which a cross-origin fetch() can't distinguish from a network outage
// (browsers report "Failed to fetch" for any response missing the CORS
// header, masking the real status/body). The headers above are only queued,
// not yet flushed, so as long as nothing has been echoed yet we can still
// turn a fatal error into a clean JSON response that carries them.
register_shutdown_function(function () {
  $err = error_get_last();
  if ($err && in_array($err['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true) && !headers_sent()) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'server_fatal_error']);
  }
});

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

// Legacy manus-tool shape -> new shape.
if (isset($body['pin']) && !isset($body['action'])) {
  $body = [
    'action' => 'save',
    'password' => $body['pin'],
    'resource' => 'manus',
    'payload' => ['scenes' => $body['scenes'] ?? null, 'cast' => $body['cast'] ?? null],
  ];
}

// ── Authentication: shared password -> level ────────────────
function password_level($pw) {
  if (!is_string($pw) || $pw === '') return null;
  if (defined('ADMIN_PASSWORD') && hash_equals(ADMIN_PASSWORD, $pw)) return 'admin';
  // Legacy: the old manus PIN keeps working as an admin credential
  // until it's removed from config.php.
  if (defined('SHARED_PIN') && hash_equals(SHARED_PIN, $pw)) return 'admin';
  if (defined('BOSS_PASSWORD') && hash_equals(BOSS_PASSWORD, $pw)) return 'boss';
  if (defined('REVYST_PASSWORD') && hash_equals(REVYST_PASSWORD, $pw)) return 'revyst';
  return null;
}

$level = password_level($body['password'] ?? '');
if ($level === null) {
  respond(401, ['error' => 'invalid_password']);
}

$LEVEL_RANK = ['revyst' => 1, 'boss' => 2, 'admin' => 3];

// Constants referenced by handlers dispatched below (upload/delete, and the
// archive save validator). They MUST be declared above the dispatch: PHP
// registers top-level `const` in execution order, not at compile time, so a
// declaration placed lower in the file is undefined when an early-dispatched
// handler runs. (Budget handlers avoid consts entirely — see budget_*() fns.)
const ARCHIVE_PATH_RE = '#^archive/[A-Za-z0-9_-]+/(cover\.jpg|manus\.pdf)$#';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// Posts images are written inline from posts_create (revyst-level), not via
// the admin-gated upload action — this is the only guard on that path, so it
// must live above the dispatch same as ARCHIVE_PATH_RE (see comment above).
const POST_IMAGE_PATH_RE = '#^posts/[0-9a-f]+/image\.jpg$#';
// Manuscript pdf/tex are written inline from manuscripts_create (revyst-level),
// same posture as POST_IMAGE_PATH_RE — the path is server-built from a
// server-slugified title, but is still checked unconditionally.
const MANUS_PDF_PATH_RE = '#^manus/(sketch|sang)/[^/]+\.pdf$#';
const MANUS_TEX_PATH_RE = '#^manus/(sketch|sang)/[^/]+\.tex$#';
// Manuscripts discarded via the Manus page's "Vælg scener" tab are moved
// here from manus/<type>/ — same posture as the two regexes above, the
// destination is server-built from data/config.json's currentProductionFolder
// (never a client-supplied path) but still checked unconditionally.
const ARCHIVE_NOT_SELECTED_RE = '#^archive/[A-Za-z0-9_-]+/not_selected/[^/]+\.(pdf|tex)$#';

$action = $body['action'] ?? '';

if ($action === 'login') {
  respond(200, ['ok' => true, 'level' => $level]);
}
if ($action === 'upload' || $action === 'delete') {
  // The required level depends on which allow-listed prefix the path matches
  // — see upload_path_level() and assert_allowed_upload_path() below. A path
  // matching no allow-listed prefix is a 400 here, before any level check,
  // same as an unknown resource elsewhere.
  $requiredLevel = upload_path_level($body['path'] ?? '');
  if ($requiredLevel === null) {
    respond(400, ['error' => 'bad_path']);
  }
  if ($LEVEL_RANK[$level] < $LEVEL_RANK[$requiredLevel]) {
    respond(403, ['error' => 'insufficient_level']);
  }
  if ($action === 'upload') handle_upload($body);
  else handle_delete($body);
}

// ── Budget actions (private Simply.com datastore) ────────────
// These read/write local files under BUDGET_DATA_DIR (never the
// public repo). Each handler validates + responds/exits.
$BUDGET_ACTIONS = [
  'budget_submit'         => 'revyst', // revyster submit reimbursement requests
  'budget_read'           => 'admin',
  'budget_receipt'        => 'admin',
  'budget_approve'        => 'admin',
  'budget_request_reject' => 'admin',
  'budget_save_sheet'     => 'admin', // editable planned/income budget sheet
  'budget_expense_add'    => 'admin', // admin-entered direct expense
  'budget_expense_update' => 'admin', // edit a paid expense (category locked)
  'budget_request_update' => 'admin', // edit a pending request
];
if (isset($BUDGET_ACTIONS[$action])) {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK[$BUDGET_ACTIONS[$action]]) {
    respond(403, ['error' => 'insufficient_level']);
  }
  handle_budget($action, $body);
}

// ── Posts actions (public, git-backed dashboard forum on Forside) ──
// posts_create is revyst-level append-only (mirrors budget_submit's shape,
// against the public data/posts.json instead of the private budget store)
// — deliberately NOT in $RESOURCES below, since that table always trusts
// the caller with a full-array replace, which a revyst-level client must
// never be given (they could edit/delete anyone's post by omission).
$POST_ACTIONS = [
  'posts_create'       => 'revyst',
  'comments_create'    => 'revyst',
  'manuscripts_create' => 'revyst',
];
if (isset($POST_ACTIONS[$action])) {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK[$POST_ACTIONS[$action]]) {
    respond(403, ['error' => 'insufficient_level']);
  }
  if ($action === 'posts_create') posts_create($body);
  else if ($action === 'comments_create') comments_create($body);
  else manuscripts_create($body);
}

// manuscripts_discard is boss-level (not revyst, unlike the actions above) —
// it moves/deletes files, so it isn't safely append-only-trustable at revyst.
// Not in $RESOURCES either, since it never accepts a full-array replace.
if ($action === 'manuscripts_discard') {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK['boss']) {
    respond(403, ['error' => 'insufficient_level']);
  }
  manuscripts_discard($body);
}

if ($action !== 'save') {
  respond(400, ['error' => 'unknown_action']);
}

// ── GitHub Contents API helpers ──────────────────────────────
function github_api($method, $path, $payload = null) {
  // $path is always 'contents/<file-path>' — a file path can contain
  // non-ASCII characters (e.g. a manuscript title with æ/ø/å, left as
  // real UTF-8 by manus_slugify() on purpose), which must be percent-encoded
  // per path segment to form a valid request line; encode only here, at the
  // point of building the URL, so the raw UTF-8 path is still what's
  // validated, stored in JSON, and returned to the client everywhere else.
  $encodedPath = implode('/', array_map('rawurlencode', explode('/', $path)));
  $ch = curl_init('https://api.github.com/repos/' . GITHUB_OWNER . '/' . GITHUB_REPO . '/' . $encodedPath);
  curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER => [
      'Authorization: Bearer ' . GITHUB_TOKEN,
      'Accept: application/vnd.github+json',
      'User-Agent: matrevy-update-data',
    ],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_CUSTOMREQUEST => $method,
    // Without an explicit timeout, a stalled connection to GitHub's API can
    // run long enough to hit the host's own gateway timeout, which kills the
    // PHP process outright — losing the CORS header along with it (see the
    // shutdown handler above). Failing fast here keeps us inside our own
    // respond()-based error handling instead.
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 20,
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

// ── File uploads (binary content at boss/admin-chosen paths) ────
// GITHUB_TOKEN has whole-repo write access, so matching against an allow-listed
// path regex is the only thing standing between an arbitrary "path" in the
// request body and overwriting any file in the repo. Keep both regexes strict.
// A function, not a `const` array, so it's safely callable from the early
// upload/delete dispatch regardless of where in the file it's defined (PHP
// hoists function declarations, unlike top-level `const` — see the
// const-ordering note above ARCHIVE_PATH_RE).
function upload_path_level($path) {
  if (!is_string($path)) return null;
  if (preg_match(ARCHIVE_PATH_RE, $path)) return 'admin';
  return null;
}

// Re-validated inside handle_upload/handle_delete themselves — never trust the
// path format just because upload_path_level() already looked at it once.
function assert_allowed_upload_path($path) {
  if (upload_path_level($path) === null) {
    respond(400, ['error' => 'bad_path']);
  }
}

// Creates $filePath if absent, otherwise overwrites it in place.
function put_file($filePath, $contentBase64, $commitMessage) {
  [$getStatus, $current] = github_api('GET', 'contents/' . $filePath);
  if ($getStatus !== 200 && $getStatus !== 404) {
    respond(502, ['error' => 'github_read_failed', 'file' => $filePath, 'status' => $getStatus]);
  }
  $payload = ['message' => $commitMessage, 'content' => $contentBase64];
  if ($getStatus === 200) {
    $payload['sha'] = $current['sha']; // update existing file
  }
  [$putStatus, ] = github_api('PUT', 'contents/' . $filePath, $payload);
  if ($putStatus === 409) {
    respond(409, ['error' => 'conflict', 'file' => $filePath]);
  }
  if ($putStatus < 200 || $putStatus >= 300) {
    respond(502, ['error' => 'github_write_failed', 'file' => $filePath, 'status' => $putStatus]);
  }
}

function delete_file($filePath, $commitMessage) {
  [$getStatus, $current] = github_api('GET', 'contents/' . $filePath);
  if ($getStatus === 404) return; // already gone, treat as success
  if ($getStatus !== 200) {
    respond(502, ['error' => 'github_read_failed', 'file' => $filePath, 'status' => $getStatus]);
  }
  [$delStatus, ] = github_api('DELETE', 'contents/' . $filePath, [
    'message' => $commitMessage,
    'sha' => $current['sha'],
  ]);
  if ($delStatus < 200 || $delStatus >= 300) {
    respond(502, ['error' => 'github_delete_failed', 'file' => $filePath, 'status' => $delStatus]);
  }
}

function handle_upload($body) {
  $path = $body['path'] ?? '';
  assert_allowed_upload_path($path);
  $contentBase64 = $body['contentBase64'] ?? '';
  if (!is_string($contentBase64) || $contentBase64 === '') {
    respond(400, ['error' => 'invalid_shape']);
  }
  $raw = base64_decode($contentBase64, true);
  if ($raw === false) {
    respond(400, ['error' => 'bad_base64']);
  }
  if (strlen($raw) > MAX_UPLOAD_BYTES) {
    respond(413, ['error' => 'too_large']);
  }
  put_file($path, $contentBase64, 'Upload ' . $path);
  respond(200, ['ok' => true, 'path' => $path]);
}

function handle_delete($body) {
  $path = $body['path'] ?? '';
  assert_allowed_upload_path($path);
  delete_file($path, 'Slet ' . $path);
  respond(200, ['ok' => true, 'path' => $path]);
}

// ── Budget datastore (private, local files under BUDGET_DATA_DIR) ─
// Unlike the resource savers below (which commit JSON to the public
// GitHub repo), the budget feature stores expense requests, the paid
// ledger and receipt photos as plain files on the Simply.com host —
// names, phone numbers and receipts must NOT be public. No sha/409
// dance: concurrency is handled with flock around each read-modify-write.

// The fixed category keys (mirrors BUDGET_CATEGORIES in budget.js).
// A function, not a `const` array: the budget-action dispatch near the
// top of this file calls budget_submit() before execution reaches a
// top-level `const` array declaration (which — unlike a scalar const —
// is only defined once its line runs), so a const here would be
// undefined at call time. Functions are hoisted, so this always works.
function budget_category_keys() {
  return [
    'rekvisitter', 'makeup', 'texnik', 'snacks', 'kage', 'mad', 'sammenholdet',
    'fest', 'diverse', 'rengoring', 'tur', 'manus', 'tshirts', 'stregnskab',
  ];
}

// The ONLY guard between a request's "file" field and reading an arbitrary
// file off the host. Receipts are always JPEGs named "<key>_<n>.jpg" (paid)
// or "pending/<id>.jpg" (submitted). Keep it strict.
// A function, not a `const`: the budget-action dispatch runs before any
// top-level `const` line in this file has executed (PHP registers const
// declarations in execution order), so a const here would be undefined at
// call time — see budget_category_keys() for the same reason.
function budget_receipt_re() {
  return '#^(pending/)?[A-Za-z0-9_]+\.jpg$#';
}

// ~5 MB cap on a decoded receipt (mirrors MAX_UPLOAD_BYTES, inlined for the
// same const-ordering reason).
function budget_max_upload_bytes() {
  return 5 * 1024 * 1024;
}

function budget_dir() {
  if (!defined('BUDGET_DATA_DIR') || !is_string(BUDGET_DATA_DIR) || BUDGET_DATA_DIR === '') {
    respond(500, ['error' => 'budget_not_configured']);
  }
  return rtrim(BUDGET_DATA_DIR, '/');
}

function budget_ensure_dir($dir) {
  if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
    respond(500, ['error' => 'budget_storage_unavailable']);
  }
}

// Read-only load of one of the JSON files; returns $default if missing/empty.
function budget_load($name, $default) {
  $path = budget_dir() . '/' . $name;
  if (!is_file($path)) return $default;
  $json = json_decode((string) file_get_contents($path), true);
  return is_array($json) ? $json : $default;
}

// Locked read-modify-write of one JSON file. $mutate receives the decoded
// array (or $default) and returns the array to persist.
function budget_mutate($name, $default, $mutate) {
  budget_ensure_dir(budget_dir());
  $path = budget_dir() . '/' . $name;
  $fh = @fopen($path, 'c+');
  if ($fh === false) respond(500, ['error' => 'budget_storage_unavailable']);
  if (!flock($fh, LOCK_EX)) { fclose($fh); respond(500, ['error' => 'budget_lock_failed']); }
  $raw = stream_get_contents($fh);
  $json = ($raw === '' || $raw === false) ? $default : json_decode($raw, true);
  if (!is_array($json)) $json = $default;
  $json = $mutate($json);
  rewind($fh);
  ftruncate($fh, 0);
  fwrite($fh, json_encode($json, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $json;
}

function budget_receipts_dir() {
  $dir = budget_dir() . '/receipts';
  budget_ensure_dir($dir);
  budget_ensure_dir($dir . '/pending');
  return $dir;
}

// Decode + size-check a base64 receipt, returning the raw bytes.
function budget_decode_receipt($contentBase64) {
  if (!is_string($contentBase64) || $contentBase64 === '') {
    respond(400, ['error' => 'invalid_shape']);
  }
  $raw = base64_decode($contentBase64, true);
  if ($raw === false) respond(400, ['error' => 'bad_base64']);
  if (strlen($raw) > budget_max_upload_bytes()) respond(413, ['error' => 'too_large']);
  return $raw;
}

function handle_budget($action, $body) {
  switch ($action) {
    case 'budget_submit':         return budget_submit($body);
    case 'budget_read':           return budget_read();
    case 'budget_receipt':        return budget_receipt($body);
    case 'budget_approve':        return budget_approve($body);
    case 'budget_request_reject': return budget_request_reject($body);
    case 'budget_save_sheet':     return budget_save_sheet($body);
    case 'budget_expense_add':    return budget_expense_add($body);
    case 'budget_expense_update': return budget_expense_update($body);
    case 'budget_request_update': return budget_request_update($body);
  }
  respond(400, ['error' => 'unknown_action']);
}

// Next bilag number for a category = max existing n + 1 (so deletions never
// reuse a number). Shared by budget_approve and budget_expense_add.
function budget_next_n($category) {
  $existing = budget_load('expenses.json', ['expenses' => []])['expenses'] ?? [];
  $maxN = 0;
  foreach ($existing as $e) {
    if (($e['category'] ?? null) === $category && isset($e['n']) && (int) $e['n'] > $maxN) {
      $maxN = (int) $e['n'];
    }
  }
  return $maxN + 1;
}

// Revyst appends ONE reimbursement request (+ its receipt). The client never
// sends the whole list, so revyster can't read or overwrite others' requests.
function budget_submit($body) {
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  $comment  = $body['comment'] ?? '';
  $receipt  = $body['receiptBase64'] ?? '';
  if (!in_array($category, budget_category_keys(), true)
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($name) || trim($name) === ''
      || !is_string($phone) || trim($phone) === ''
      || !is_string($comment)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $raw = budget_decode_receipt($receipt);

  $id = dechex(time()) . bin2hex(random_bytes(4));
  $receiptsDir = budget_receipts_dir();
  if (@file_put_contents($receiptsDir . '/pending/' . $id . '.jpg', $raw) === false) {
    respond(500, ['error' => 'budget_storage_unavailable']);
  }

  $request = [
    'id'          => $id,
    'category'    => $category,
    'amount'      => round((float) $amount, 2),
    'name'        => trim($name),
    'phone'       => trim($phone),
    'comment'     => trim($comment),
    'receiptFile' => 'pending/' . $id . '.jpg',
    'createdAt'   => date('c'),
  ];
  budget_mutate('requests.json', ['requests' => []], function ($json) use ($request) {
    if (!isset($json['requests']) || !is_array($json['requests'])) $json['requests'] = [];
    $json['requests'][] = $request;
    return $json;
  });
  respond(200, ['ok' => true, 'id' => $id]);
}

// Admin: return everything needed to render the management view (no binaries).
function budget_read() {
  respond(200, [
    'ok'       => true,
    'budget'   => budget_load('budget.json', ['planned' => new stdClass(), 'income' => [], 'updatedAt' => null]),
    'requests' => budget_load('requests.json', ['requests' => []]),
    'expenses' => budget_load('expenses.json', ['expenses' => []]),
  ]);
}

// Admin: stream a receipt image (fetched with the password, so receipts are
// never exposed at a public URL). Overrides the JSON content-type header.
function budget_receipt($body) {
  $file = $body['file'] ?? '';
  if (!is_string($file) || !preg_match(budget_receipt_re(), $file)) {
    respond(400, ['error' => 'bad_path']);
  }
  $path = budget_dir() . '/receipts/' . $file;
  if (!is_file($path)) respond(404, ['error' => 'not_found']);
  header('Content-Type: image/jpeg');
  header('Content-Length: ' . filesize($path));
  readfile($path);
  exit;
}

// Admin: approve a pending request → assign the next bilag number for its
// category, rename the receipt to "<key>_<n>.jpg", move it into the ledger.
function budget_approve($body) {
  $id       = $body['id'] ?? '';
  $paidBy   = $body['paidBy'] ?? '';
  $transfer = $body['transfer'] ?? 0;
  $settled  = $body['settled'] ?? false;
  $date     = $body['date'] ?? date('Y-m-d');
  if (!is_string($id) || $id === ''
      || !is_string($paidBy) || trim($paidBy) === ''
      || !is_numeric($transfer) || (float) $transfer < 0
      || !is_bool($settled)
      || !is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    respond(400, ['error' => 'invalid_shape']);
  }

  // Pull the request out of requests.json.
  $found = null;
  budget_mutate('requests.json', ['requests' => []], function ($json) use ($id, &$found) {
    $keep = [];
    foreach (($json['requests'] ?? []) as $r) {
      if (($r['id'] ?? null) === $id) { $found = $r; continue; }
      $keep[] = $r;
    }
    $json['requests'] = $keep;
    return $json;
  });
  if ($found === null) respond(404, ['error' => 'not_found']);

  $category = $found['category'];
  $n = budget_next_n($category);
  $receiptFile = $category . '_' . $n . '.jpg';

  // Rename the receipt pending/<id>.jpg → <key>_<n>.jpg (best-effort).
  $receiptsDir = budget_receipts_dir();
  $oldPath = $receiptsDir . '/' . ($found['receiptFile'] ?? '');
  $newRel = '';
  if (is_file($oldPath) && preg_match(budget_receipt_re(), $found['receiptFile'] ?? '')) {
    if (@rename($oldPath, $receiptsDir . '/' . $receiptFile)) $newRel = $receiptFile;
  }

  $expense = [
    'id'          => $id,
    'category'    => $category,
    'n'           => $n,
    'bilag'       => $category . '_' . $n,
    'amount'      => $found['amount'],
    'date'        => $date,
    'paidBy'      => trim($paidBy),
    'transfer'    => round((float) $transfer, 2),
    'settled'     => $settled,
    'comment'     => $found['comment'] ?? '',
    'name'        => $found['name'] ?? '',
    'phone'       => $found['phone'] ?? '',
    'receiptFile' => $newRel,
    'approvedAt'  => date('c'),
  ];
  budget_mutate('expenses.json', ['expenses' => []], function ($json) use ($expense) {
    if (!isset($json['expenses']) || !is_array($json['expenses'])) $json['expenses'] = [];
    $json['expenses'][] = $expense;
    return $json;
  });
  respond(200, ['ok' => true, 'expense' => $expense]);
}

// Admin: reject/delete a pending request and its receipt.
function budget_request_reject($body) {
  $id = $body['id'] ?? '';
  if (!is_string($id) || $id === '') respond(400, ['error' => 'invalid_shape']);
  $removed = null;
  budget_mutate('requests.json', ['requests' => []], function ($json) use ($id, &$removed) {
    $keep = [];
    foreach (($json['requests'] ?? []) as $r) {
      if (($r['id'] ?? null) === $id) { $removed = $r; continue; }
      $keep[] = $r;
    }
    $json['requests'] = $keep;
    return $json;
  });
  if ($removed !== null && preg_match(budget_receipt_re(), $removed['receiptFile'] ?? '')) {
    @unlink(budget_dir() . '/receipts/' . $removed['receiptFile']);
  }
  respond(200, ['ok' => true]);
}

// Admin: overwrite the editable budget sheet — the planned amount per category
// plus the income/revenue list. Spent/balance are derived client-side from the
// ledger, never stored here.
function budget_save_sheet($body) {
  $planned = $body['planned'] ?? null;
  $income  = $body['income'] ?? null;
  if (!is_array($planned) || !is_array($income)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $keys = budget_category_keys();
  $cleanPlanned = [];
  foreach ($planned as $key => $val) {
    if (!in_array($key, $keys, true) || !is_numeric($val) || (float) $val < 0) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $cleanPlanned[$key] = round((float) $val, 2);
  }
  $cleanIncome = [];
  foreach ($income as $line) {
    if (!is_array($line)
        || !isset($line['label']) || !is_string($line['label']) || trim($line['label']) === ''
        || !isset($line['amount']) || !is_numeric($line['amount']) || (float) $line['amount'] < 0) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $id = (isset($line['id']) && is_string($line['id']) && $line['id'] !== '')
      ? $line['id']
      : (dechex(time()) . bin2hex(random_bytes(3)));
    $entry = [
      'id'     => $id,
      'label'  => trim($line['label']),
      'amount' => round((float) $line['amount'], 2),
    ];
    // Optional free-text description (e.g. what the "Andet" income covers).
    if (isset($line['note']) && is_string($line['note']) && trim($line['note']) !== '') {
      $entry['note'] = trim($line['note']);
    }
    $cleanIncome[] = $entry;
  }

  budget_mutate('budget.json', ['planned' => new stdClass(), 'income' => [], 'updatedAt' => null],
    function ($json) use ($cleanPlanned, $cleanIncome) {
      // Encode planned as an object even when empty (json_encode turns [] into
      // an array, but the schema — and the client — expect an object).
      $json['planned'] = empty($cleanPlanned) ? new stdClass() : $cleanPlanned;
      $json['income'] = $cleanIncome;
      $json['updatedAt'] = date('c');
      return $json;
    });
  respond(200, ['ok' => true]);
}

// Admin: add an expense directly to the ledger (no revyst request), optionally
// with a receipt photo. Assigns the next bilag number for the category, exactly
// like budget_approve.
function budget_expense_add($body) {
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $date     = $body['date'] ?? date('Y-m-d');
  $paidBy   = $body['paidBy'] ?? '';
  $transfer = $body['transfer'] ?? 0;
  $settled  = $body['settled'] ?? false;
  $comment  = $body['comment'] ?? '';
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  $receipt  = $body['receiptBase64'] ?? '';
  if (!in_array($category, budget_category_keys(), true)
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)
      || !is_string($paidBy) || trim($paidBy) === ''
      || !is_numeric($transfer) || (float) $transfer < 0
      || !is_bool($settled)
      || !is_string($comment) || !is_string($name) || !is_string($phone)
      || !is_string($receipt)) {
    respond(400, ['error' => 'invalid_shape']);
  }

  $id = dechex(time()) . bin2hex(random_bytes(4));
  $n = budget_next_n($category);

  $receiptRel = '';
  if ($receipt !== '') {
    $raw = budget_decode_receipt($receipt);
    $receiptsDir = budget_receipts_dir();
    $receiptRel = $category . '_' . $n . '.jpg';
    if (@file_put_contents($receiptsDir . '/' . $receiptRel, $raw) === false) {
      respond(500, ['error' => 'budget_storage_unavailable']);
    }
  }

  $expense = [
    'id'          => $id,
    'category'    => $category,
    'n'           => $n,
    'bilag'       => $category . '_' . $n,
    'amount'      => round((float) $amount, 2),
    'date'        => $date,
    'paidBy'      => trim($paidBy),
    'transfer'    => round((float) $transfer, 2),
    'settled'     => $settled,
    'comment'     => trim($comment),
    'name'        => trim($name),
    'phone'       => trim($phone),
    'receiptFile' => $receiptRel,
    'approvedAt'  => date('c'),
  ];
  budget_mutate('expenses.json', ['expenses' => []], function ($json) use ($expense) {
    if (!isset($json['expenses']) || !is_array($json['expenses'])) $json['expenses'] = [];
    $json['expenses'][] = $expense;
    return $json;
  });
  respond(200, ['ok' => true, 'expense' => $expense]);
}

// Admin: edit an existing paid expense. Category/n/bilag/receiptFile stay locked
// (changing category would need a bilag renumber + receipt rename — do reject/re-add).
function budget_expense_update($body) {
  $id       = $body['id'] ?? '';
  $amount   = $body['amount'] ?? null;
  $date     = $body['date'] ?? '';
  $paidBy   = $body['paidBy'] ?? '';
  $transfer = $body['transfer'] ?? 0;
  $settled  = $body['settled'] ?? false;
  $comment  = $body['comment'] ?? '';
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  if (!is_string($id) || $id === ''
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)
      || !is_string($paidBy) || trim($paidBy) === ''
      || !is_numeric($transfer) || (float) $transfer < 0
      || !is_bool($settled)
      || !is_string($comment) || !is_string($name) || !is_string($phone)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $found = false;
  budget_mutate('expenses.json', ['expenses' => []],
    function ($json) use ($id, $amount, $date, $paidBy, $transfer, $settled, $comment, $name, $phone, &$found) {
      // Bind &$e to a real variable, not the ($json['expenses'] ?? []) expression
      // — foreach-by-reference over a `??` result mutates a throwaway copy, so the
      // edit would silently not persist (handler still returns ok:true).
      $expenses = $json['expenses'] ?? [];
      foreach ($expenses as &$e) {
        if (($e['id'] ?? null) === $id) {
          $e['amount']   = round((float) $amount, 2);
          $e['date']     = $date;
          $e['paidBy']   = trim($paidBy);
          $e['transfer'] = round((float) $transfer, 2);
          $e['settled']  = $settled;
          $e['comment']  = trim($comment);
          $e['name']     = trim($name);
          $e['phone']    = trim($phone);
          $found = true;
          break;
        }
      }
      unset($e);
      $json['expenses'] = $expenses;
      return $json;
    });
  if (!$found) respond(404, ['error' => 'not_found']);
  respond(200, ['ok' => true]);
}

// Admin: edit a pending request. Category may change (no bilag assigned yet; the
// receipt stays pending/<id>.jpg regardless).
function budget_request_update($body) {
  $id       = $body['id'] ?? '';
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  $comment  = $body['comment'] ?? '';
  if (!is_string($id) || $id === ''
      || !in_array($category, budget_category_keys(), true)
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($name) || trim($name) === ''
      || !is_string($phone) || trim($phone) === ''
      || !is_string($comment)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $found = false;
  budget_mutate('requests.json', ['requests' => []],
    function ($json) use ($id, $category, $amount, $name, $phone, $comment, &$found) {
      // Bind &$r to a real variable, not the ($json['requests'] ?? []) expression
      // — foreach-by-reference over a `??` result mutates a throwaway copy, so the
      // edit would silently not persist (handler still returns ok:true).
      $requests = $json['requests'] ?? [];
      foreach ($requests as &$r) {
        if (($r['id'] ?? null) === $id) {
          $r['category'] = $category;
          $r['amount']   = round((float) $amount, 2);
          $r['name']     = trim($name);
          $r['phone']    = trim($phone);
          $r['comment']  = trim($comment);
          $found = true;
          break;
        }
      }
      unset($r);
      $json['requests'] = $requests;
      return $json;
    });
  if (!$found) respond(404, ['error' => 'not_found']);
  respond(200, ['ok' => true]);
}

// ── Resource savers ──────────────────────────────────────────
// Each resource: minimum level + a validate-and-commit function.
// Later phases (calendar, archive, ...) register here.

function save_manus($payload) {
  $scenesActs = $payload['scenes'] ?? null;
  $castList = $payload['cast'] ?? null;
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
}

function save_calendar($payload) {
  $events = $payload['events'] ?? null;
  if (!is_array($events)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  foreach ($events as $ev) {
    if (!is_array($ev)) {
      respond(400, ['error' => 'invalid_events_shape']);
    }
    $start = $ev['start'] ?? '';
    $end = $ev['end'] ?? '';
    $endDate = $ev['endDate'] ?? '';
    if (!isset($ev['id'], $ev['date'], $ev['endDate'], $ev['title'], $ev['category'], $ev['note'])
        || !is_string($ev['id']) || $ev['id'] === ''
        || !is_string($ev['date']) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $ev['date'])
        || !is_string($endDate) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $endDate) || $endDate < $ev['date']
        || !is_string($ev['title']) || $ev['title'] === ''
        || !in_array($ev['category'], ['manus', 'ove', 'forestilling', 'deadline', 'andet'], true)
        || !is_string($start) || ($start !== '' && !preg_match('/^\d{2}:\d{2}$/', $start))
        || !is_string($end) || ($end !== '' && !preg_match('/^\d{2}:\d{2}$/', $end))
        || !is_string($ev['note'])) {
      respond(400, ['error' => 'invalid_events_shape']);
    }
  }

  update_file('data/calendar.json', function ($json) use ($events) {
    $json['events'] = $events;
    return $json;
  }, 'Opdater calendar.json via kalenderen');
}

// ── Posts (public, git-backed forum on Forside) ──────────────
// posts_create appends exactly ONE server-built post, unlike save_posts
// below (a full-array replace, boss/admin only) — see the dispatch note
// near $POST_ACTIONS for why revyst can't use the full-array path.
function posts_create($body) {
  $author = $body['author'] ?? '';
  $title  = $body['title'] ?? '';
  $text   = $body['text'] ?? '';
  if (!is_string($author) || trim($author) === ''
      || !is_string($title)
      || !is_string($text) || trim($text) === '') {
    respond(400, ['error' => 'invalid_shape']);
  }

  $id = dechex(time()) . bin2hex(random_bytes(4));

  // Optional picture, uploaded inline here (revyst-level) rather than via the
  // admin-gated generic 'upload' action — POST_IMAGE_PATH_RE is the only
  // guard on this write, checked unconditionally even though the path is
  // server-built from $id, mirroring ARCHIVE_PATH_RE's "always check" posture.
  $image = '';
  $imageBase64 = $body['imageBase64'] ?? '';
  if (is_string($imageBase64) && $imageBase64 !== '') {
    $raw = base64_decode($imageBase64, true);
    if ($raw === false) {
      respond(400, ['error' => 'bad_base64']);
    }
    if (strlen($raw) > MAX_UPLOAD_BYTES) {
      respond(413, ['error' => 'too_large']);
    }
    $path = 'posts/' . $id . '/image.jpg';
    if (!preg_match(POST_IMAGE_PATH_RE, $path)) {
      respond(400, ['error' => 'bad_path']);
    }
    put_file($path, $imageBase64, 'Nyt opslagsbillede via forsiden');
    $image = $path;
  }

  $post = [
    'id'       => $id,
    'pinned'   => false,
    'date'     => date('Y-m-d\TH:i:s'),
    'author'   => trim($author),
    'title'    => trim($title),
    'text'     => trim($text),
    'image'    => $image,
    'comments' => [],
  ];
  update_file('data/posts.json', function ($json) use ($post) {
    if (!isset($json['posts']) || !is_array($json['posts'])) $json['posts'] = [];
    $json['posts'][] = $post;
    return $json;
  }, 'Nyt opslag via forsiden');
  respond(200, ['ok' => true, 'id' => $post['id'], 'image' => $post['image']]);
}

// Any revyst+ caller can comment on any post — there's no per-post
// visibility restriction to gate against.
function comments_create($body) {
  $postId = $body['postId'] ?? '';
  $author = $body['author'] ?? '';
  $text   = $body['text'] ?? '';
  if (!is_string($postId) || $postId === ''
      || !is_string($author) || trim($author) === ''
      || !is_string($text) || trim($text) === '') {
    respond(400, ['error' => 'invalid_shape']);
  }

  $comment = [
    'id'     => dechex(time()) . bin2hex(random_bytes(4)),
    'author' => trim($author),
    'text'   => trim($text),
    'date'   => date('Y-m-d\TH:i:s'),
  ];

  $found = false;
  update_file('data/posts.json', function ($json) use ($postId, $comment, &$found) {
    $posts = $json['posts'] ?? [];
    foreach ($posts as &$p) {
      if (($p['id'] ?? null) === $postId) {
        $found = true;
        if (!isset($p['comments']) || !is_array($p['comments'])) $p['comments'] = [];
        $p['comments'][] = $comment;
        break;
      }
    }
    unset($p);
    $json['posts'] = $posts;
    return $json;
  }, 'Ny kommentar via forsiden');

  if (!$found) respond(400, ['error' => 'post_not_found']);
  respond(200, ['ok' => true, 'comment' => $comment]);
}

// ── Manuscripts (public, git-backed upload pool for the Manus page) ──
// Revyster append one submission (pdf + tex, renamed to <title>.pdf/.tex)
// via manuscripts_create; boss/admin remove one via the full-array-replace
// save_manuscripts resource below (client filters the array, files are left
// as harmless orphans in the repo — same accepted trade-off as posts_create's
// image never being cleaned up on post delete).

// Spaces -> underscore, per the user's spec; strips anything else unsafe in a
// filename/URL since the result becomes a repo path segment AND an <a href>
// (a literal "?" here previously broke the link — browsers read it as the
// start of a query string). Danish letters are left as-is — GitHub Contents
// API paths and href unicode handle UTF-8 fine.
function manus_slugify($title) {
  $slug = preg_replace('/\s+/', '_', trim($title));
  // Strip anything unsafe in a filename/URL (path separators, "?", "&", quotes, …) —
  // keep only letters (incl. æøå), digits, underscores and hyphens.
  $slug = preg_replace('/[^\p{L}\p{N}_\-]/u', '', $slug);
  return $slug === '' ? 'uden_titel' : $slug;
}

function manus_existing_slugs($type, $submissions) {
  $slugs = [];
  foreach ($submissions as $s) {
    if (($s['type'] ?? null) !== $type) continue;
    $pdf = $s['pdfPath'] ?? '';
    if (preg_match('#^manus/' . preg_quote($type, '#') . '/([^/]+)\.pdf$#', $pdf, $m)) {
      $slugs[$m[1]] = true;
    }
  }
  return $slugs;
}

// Appends _2, _3, ... on a collision within the same type, so two
// same-titled submissions never overwrite each other's files.
function manus_unique_slug($type, $title, $submissions) {
  $base = manus_slugify($title);
  $taken = manus_existing_slugs($type, $submissions);
  if (!isset($taken[$base])) return $base;
  $n = 2;
  while (isset($taken[$base . '_' . $n])) $n++;
  return $base . '_' . $n;
}

function manuscripts_create($body) {
  $type      = $body['type'] ?? '';
  $title     = $body['title'] ?? '';
  $sender    = $body['sender'] ?? '';
  $pdfBase64 = $body['pdfBase64'] ?? '';
  $texBase64 = $body['texBase64'] ?? '';
  if (!in_array($type, ['sketch', 'sang'], true)
      || !is_string($title) || trim($title) === ''
      || !is_string($sender) || trim($sender) === ''
      || !is_string($pdfBase64) || $pdfBase64 === ''
      || !is_string($texBase64) || $texBase64 === '') {
    respond(400, ['error' => 'invalid_shape']);
  }
  $pdfRaw = base64_decode($pdfBase64, true);
  $texRaw = base64_decode($texBase64, true);
  if ($pdfRaw === false || $texRaw === false) {
    respond(400, ['error' => 'bad_base64']);
  }
  if (strlen($pdfRaw) > MAX_UPLOAD_BYTES || strlen($texRaw) > MAX_UPLOAD_BYTES) {
    respond(413, ['error' => 'too_large']);
  }

  [$getStatus, $current] = github_api('GET', 'contents/data/manuscripts.json');
  $existing = [];
  if ($getStatus === 200) {
    $decoded = json_decode(base64_decode($current['content']), true);
    $existing = (is_array($decoded) && isset($decoded['submissions']) && is_array($decoded['submissions']))
      ? $decoded['submissions'] : [];
  }
  $slug = manus_unique_slug($type, trim($title), $existing);

  $pdfPath = 'manus/' . $type . '/' . $slug . '.pdf';
  $texPath = 'manus/' . $type . '/' . $slug . '.tex';
  if (!preg_match(MANUS_PDF_PATH_RE, $pdfPath) || !preg_match(MANUS_TEX_PATH_RE, $texPath)) {
    respond(400, ['error' => 'bad_path']);
  }
  put_file($pdfPath, $pdfBase64, 'Nyt manus-upload: ' . trim($title));
  put_file($texPath, $texBase64, 'Nyt manus-upload: ' . trim($title));

  $submission = [
    'id'        => dechex(time()) . bin2hex(random_bytes(4)),
    'type'      => $type,
    'title'     => trim($title),
    'sender'    => trim($sender),
    'pdfPath'   => $pdfPath,
    'texPath'   => $texPath,
    'createdAt' => date('Y-m-d\TH:i:s'),
  ];
  update_file('data/manuscripts.json', function ($json) use ($submission) {
    if (!isset($json['submissions']) || !is_array($json['submissions'])) $json['submissions'] = [];
    $json['submissions'][] = $submission;
    return $json;
  }, 'Nyt manus-upload: ' . $submission['title']);
  respond(200, ['ok' => true, 'id' => $submission['id'], 'pdfPath' => $pdfPath, 'texPath' => $texPath]);
}

// Boss-level (matches the `manuscripts` resource's own level — unlike
// manuscripts_create this can't be revyst-append-only-safe, since it moves
// and deletes files). Moves each discarded submission's pdf/tex from
// manus/<type>/ to archive/<currentProductionFolder>/not_selected/, then
// removes those submissions from data/manuscripts.json. The target folder
// always comes from data/config.json server-side — the client sends ids
// only, never a path or folder (same "server is the source of truth for the
// destination" posture as posts_create's image path).
//
// Multi-request, non-atomic: files are moved (GET+PUT+DELETE per file) BEFORE
// data/manuscripts.json is rewritten, so a mid-loop failure leaves at worst an
// orphaned copy under archive/, never a submission whose files are gone but
// whose record still claims it's live. Re-running with the same ids is safe
// either way — put_file() overwrites, delete_file() treats a missing source
// as already-done.
function manuscripts_discard($body) {
  $ids = $body['ids'] ?? null;
  if (!is_array($ids) || !$ids) {
    respond(400, ['error' => 'invalid_shape']);
  }
  foreach ($ids as $id) {
    if (!is_string($id) || $id === '') respond(400, ['error' => 'invalid_shape']);
  }

  [$cfgStatus, $cfg] = github_api('GET', 'contents/data/config.json');
  $folder = ($cfgStatus === 200)
    ? (json_decode(base64_decode($cfg['content']), true)['currentProductionFolder'] ?? '')
    : '';
  if (!is_string($folder) || $folder === '' || !preg_match('#^[A-Za-z0-9_-]+$#', $folder)) {
    respond(400, ['error' => 'no_production_folder']);
  }

  [$getStatus, $current] = github_api('GET', 'contents/data/manuscripts.json');
  if ($getStatus !== 200) {
    respond(502, ['error' => 'github_read_failed', 'file' => 'data/manuscripts.json']);
  }
  $decoded = json_decode(base64_decode($current['content']), true);
  $submissions = (is_array($decoded) && isset($decoded['submissions']) && is_array($decoded['submissions']))
    ? $decoded['submissions'] : [];

  $idSet = array_flip($ids);
  $toDiscard = array_values(array_filter($submissions, function ($s) use ($idSet) {
    return isset($idSet[$s['id'] ?? '']);
  }));
  $kept = array_values(array_filter($submissions, function ($s) use ($idSet) {
    return !isset($idSet[$s['id'] ?? '']);
  }));

  $moved = [];
  foreach ($toDiscard as $s) {
    $fields = ['pdfPath' => MANUS_PDF_PATH_RE, 'texPath' => MANUS_TEX_PATH_RE];
    foreach ($fields as $field => $srcRe) {
      $src = $s[$field] ?? '';
      if (!is_string($src) || $src === '' || !preg_match($srcRe, $src)) continue; // texPath optional/legacy-missing
      $dest = 'archive/' . $folder . '/not_selected/' . basename($src);
      if (!preg_match(ARCHIVE_NOT_SELECTED_RE, $dest)) {
        respond(400, ['error' => 'bad_path']);
      }
      [$srcStatus, $srcFile] = github_api('GET', 'contents/' . $src);
      if ($srcStatus !== 200) continue; // already moved/gone — treat as done
      // Re-encode rather than forwarding GitHub's own content field verbatim
      // (it comes chunked with embedded newlines) — put_file()'s other
      // callers always pass clean, freshly-encoded base64.
      $cleanBase64 = base64_encode(base64_decode($srcFile['content']));
      put_file($dest, $cleanBase64, 'Arkiver fravalgt manus: ' . $s['title']);
      delete_file($src, 'Fjern fravalgt manus: ' . $s['title']);
    }
    $moved[] = $s['id'];
  }

  update_file('data/manuscripts.json', function ($json) use ($kept) {
    $json['submissions'] = $kept;
    return $json;
  }, 'Fjern fravalgte manus-uploads');

  respond(200, ['ok' => true, 'discarded' => $moved, 'targetFolder' => $folder]);
}

// Boss/admin: full-array replace, used only for removing a submission (the
// client filters it out and re-saves the reduced list) — the pdf/tex blobs
// themselves are left in the repo, not deleted (see file header comment).
function save_manuscripts($payload) {
  $list = $payload['submissions'] ?? null;
  if (!is_array($list)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  foreach ($list as $s) {
    if (!is_array($s)
        || !isset($s['id'], $s['type'], $s['title'], $s['sender'], $s['pdfPath'], $s['texPath'], $s['createdAt'])
        || !is_string($s['id']) || $s['id'] === ''
        || !in_array($s['type'], ['sketch', 'sang'], true)
        || !is_string($s['title']) || trim($s['title']) === ''
        || !is_string($s['sender'])
        || !is_string($s['pdfPath']) || !preg_match(MANUS_PDF_PATH_RE, $s['pdfPath'])
        || !is_string($s['texPath']) || !preg_match(MANUS_TEX_PATH_RE, $s['texPath'])
        || !is_string($s['createdAt'])) {
      respond(400, ['error' => 'invalid_manuscripts_shape']);
    }
  }

  update_file('data/manuscripts.json', function ($json) use ($list) {
    $json['submissions'] = $list;
    return $json;
  }, 'Opdater manuscripts.json via manussiden');
}

// Boss/admin: full-array replace, used for editing/deleting a post
// (including toggling pinned) and for deleting an individual comment
// (client filters it out of the relevant post's comments array before
// calling this) — safe here since only boss/admin can reach this resource.
function save_posts($payload) {
  $list = $payload['posts'] ?? null;
  if (!is_array($list)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  foreach ($list as $p) {
    if (!is_array($p)
        || !isset($p['id'], $p['pinned'], $p['date'], $p['author'], $p['text'])
        || !is_string($p['id']) || $p['id'] === ''
        || !is_bool($p['pinned'])
        || !is_string($p['date']) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/', $p['date'])
        || !is_string($p['author'])
        || !is_string($p['text']) || $p['text'] === '') {
      respond(400, ['error' => 'invalid_posts_shape']);
    }
    // title is optional (posts_create allows an empty one, and a handful
    // of live posts predate the title field entirely).
    $title = $p['title'] ?? '';
    if (!is_string($title)) {
      respond(400, ['error' => 'invalid_posts_shape']);
    }
    $image = $p['image'] ?? '';
    if (!is_string($image) || ($image !== '' && !preg_match(POST_IMAGE_PATH_RE, $image))) {
      respond(400, ['error' => 'invalid_posts_shape']);
    }
    $comments = $p['comments'] ?? [];
    if (!is_array($comments)) {
      respond(400, ['error' => 'invalid_posts_shape']);
    }
    foreach ($comments as $c) {
      if (!is_array($c)
          || !isset($c['id'], $c['author'], $c['text'], $c['date'])
          || !is_string($c['id']) || $c['id'] === ''
          || !is_string($c['author'])
          || !is_string($c['text']) || $c['text'] === ''
          || !is_string($c['date']) || !preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/', $c['date'])) {
        respond(400, ['error' => 'invalid_posts_shape']);
      }
    }
  }

  update_file('data/posts.json', function ($json) use ($list) {
    $json['posts'] = $list;
    return $json;
  }, 'Opdater posts.json via forsiden');
}

// Admin-only: the static "Bosser for ..." info card on Forside. Just a
// title plus a small list of {names, role} rows — no per-item unique key
// needed since it's a full-array replace like save_calendar/save_archive,
// not append-only like posts_create.
function save_bosses($payload) {
  $title = $payload['title'] ?? '';
  $roles = $payload['roles'] ?? null;
  if (!is_string($title) || $title === '' || !is_array($roles)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  foreach ($roles as $r) {
    if (!is_array($r)
        || !isset($r['names'], $r['role'])
        || !is_string($r['names'])
        || !is_string($r['role'])) {
      respond(400, ['error' => 'invalid_bosses_shape']);
    }
  }

  update_file('data/bosses.json', function ($json) use ($title, $roles) {
    $json['title'] = $title;
    $json['roles'] = $roles;
    return $json;
  }, 'Opdater bosses.json via forsiden');
}

function save_archive($payload) {
  $years = $payload['years'] ?? null;
  if (!is_array($years)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  // `folder` is the sole unique key; `year` is not unique (e.g. a jubilee revy
  // held the same year as a regular one), only used for display sorting.
  $seenFolder = [];
  foreach ($years as $y) {
    if (!is_array($y)) {
      respond(400, ['error' => 'invalid_years_shape']);
    }
    // spotifyUrl / driveUrl are optional external links — validated only when present.
    $spotify = $y['spotifyUrl'] ?? '';
    $drive = $y['driveUrl'] ?? '';
    if (!isset($y['year'], $y['name'], $y['folder'], $y['coverImage'], $y['youtubeUrl'], $y['manusPdf'])
        || !is_int($y['year']) || $y['year'] < 1900 || $y['year'] > 2100
        || !is_string($y['name']) || $y['name'] === ''
        || !is_string($y['folder']) || !preg_match('#^[A-Za-z0-9_-]+$#', $y['folder'])
        || isset($seenFolder[$y['folder']])
        || !is_string($y['coverImage']) || ($y['coverImage'] !== '' && !preg_match(ARCHIVE_PATH_RE, $y['coverImage']))
        || !is_string($y['youtubeUrl']) || ($y['youtubeUrl'] !== '' && !preg_match('#^https://(www\.)?(youtube\.com|youtu\.be)/#', $y['youtubeUrl']))
        || !is_string($y['manusPdf']) || ($y['manusPdf'] !== '' && !preg_match(ARCHIVE_PATH_RE, $y['manusPdf']))
        || !is_string($spotify) || ($spotify !== '' && !preg_match('#^https://open\.spotify\.com/#', $spotify))
        || !is_string($drive) || ($drive !== '' && !preg_match('#^https://(drive|docs)\.google\.com/#', $drive))) {
      respond(400, ['error' => 'invalid_years_shape']);
    }
    $seenFolder[$y['folder']] = true;
  }

  update_file('data/archive.json', function ($json) use ($years) {
    $json['years'] = $years;
    return $json;
  }, 'Opdater archive.json via arkivet');
}

// Boss/admin: full-array replace of the wiki's flat chapter list. Each
// chapter is one continuous rich-text record ({id, title, body}) — `body`
// is a sanitized HTML string produced client-side (see wiki.js's
// sanitizeHtmlString), stored as-is; there is no server-side HTML
// sanitization since this is already a boss-level-only, trusted-caller write.
function save_wiki($payload) {
  $chapters = $payload['chapters'] ?? null;
  if (!is_array($chapters)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $seenId = [];
  foreach ($chapters as $c) {
    if (!is_array($c)
        || !isset($c['id'], $c['title'], $c['body'])
        || !is_string($c['id']) || $c['id'] === ''
        || isset($seenId[$c['id']])
        || !is_string($c['title']) || trim($c['title']) === ''
        || !is_string($c['body'])) {
      respond(400, ['error' => 'invalid_wiki_shape']);
    }
    $seenId[$c['id']] = true;
  }

  update_file('data/wiki.json', function ($json) use ($chapters) {
    $json['chapters'] = $chapters;
    return $json;
  }, 'Opdater wiki.json via wikien');
}

// Admin-only site-wide setting: which archive/MatRevy_<year> folder is the
// active production, used server-side (never a client-supplied value) as the
// move target for manuscripts_discard. There's no real "current season"
// concept yet (see matrevy-plan.md's Phase 13) — this is a small, deliberately
// minimal stand-in, set by hand once per production cycle via the Manus page.
function save_config($payload) {
  $folder = $payload['currentProductionFolder'] ?? '';
  if (!is_string($folder) || ($folder !== '' && !preg_match('#^[A-Za-z0-9_-]+$#', $folder))) {
    respond(400, ['error' => 'invalid_shape']);
  }
  update_file('data/config.json', function ($json) use ($folder) {
    $json['currentProductionFolder'] = $folder;
    return $json;
  }, 'Opdater config.json');
}

$RESOURCES = [
  'manus'         => ['level' => 'boss',  'save' => 'save_manus'],
  'calendar'      => ['level' => 'boss',  'save' => 'save_calendar'],
  'archive'       => ['level' => 'admin', 'save' => 'save_archive'],
  'posts'         => ['level' => 'boss',  'save' => 'save_posts'],
  'bosses'        => ['level' => 'admin', 'save' => 'save_bosses'],
  'wiki'          => ['level' => 'boss',  'save' => 'save_wiki'],
  'manuscripts'   => ['level' => 'boss',  'save' => 'save_manuscripts'],
  'config'        => ['level' => 'admin', 'save' => 'save_config'],
];

$resource = $body['resource'] ?? '';
if (!isset($RESOURCES[$resource])) {
  respond(400, ['error' => 'unknown_resource']);
}
if ($LEVEL_RANK[$level] < $LEVEL_RANK[$RESOURCES[$resource]['level']]) {
  respond(403, ['error' => 'insufficient_level']);
}

$payload = $body['payload'] ?? null;
if (!is_array($payload)) {
  respond(400, ['error' => 'invalid_payload']);
}

($RESOURCES[$resource]['save'])($payload);

respond(200, ['ok' => true]);
