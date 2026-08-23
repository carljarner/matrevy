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
// Manuskript.pdf (capitalized) is generate-pdfs.js's CI-generated output,
// distinct from manus.pdf (lowercase) — Arkiv's own browser-uploaded field.
// Both are allow-listed here so a Koordinator year-close can point a new
// archive entry's manusPdf straight at the real generated file.
const ARCHIVE_PATH_RE = '#^archive/[A-Za-z0-9_-]+/(cover\.jpg|manus\.pdf|Manuskript\.pdf)$#';
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
// A closing production year's final scenes.json/cast.json snapshot (see
// Koordinator's year-close flow, manus-resource reset step) — admin-level,
// same posture as ARCHIVE_PATH_RE above.
const ARCHIVE_SNAPSHOT_RE = '#^archive/[A-Za-z0-9_-]+/snapshot/(scenes|cast)\.json$#';
// Posts images are written inline from posts_create (revyst-level), not via
// the admin-gated upload action — this is the only guard on that path, so it
// must live above the dispatch same as ARCHIVE_PATH_RE (see comment above).
const POST_IMAGE_PATH_RE = '#^posts/[0-9a-f]+/image\.jpg$#';
// Manuscript pdf/tex live under archive/<folder>/{submitted,sketches,songs}/
// — "submitted" is where an upload lands immediately (manuscripts_create)
// and where a deselected submission returns to; "sketches"/"songs" (reusing
// Arkiv's existing plural per-year folder-naming convention, not the pool's
// old singular "sketch"/"sang") are where a *selected* one moves. All three
// are server-built from data/config.json's currentProductionFolder (never a
// client-supplied path) but still checked unconditionally, same posture as
// every regex above.
const ARCHIVE_MANUS_SUBMITTED_RE = '#^archive/[A-Za-z0-9_-]+/submitted/[^/]+\.(pdf|tex)$#';
const ARCHIVE_MANUS_SKETCHES_RE  = '#^archive/[A-Za-z0-9_-]+/sketches/[^/]+\.(pdf|tex)$#';
const ARCHIVE_MANUS_SONGS_RE     = '#^archive/[A-Za-z0-9_-]+/songs/[^/]+\.(pdf|tex)$#';
// Union of the three — used only where "is this any valid manus-archive
// path" is the question (save_manuscripts' shape validator, which doesn't
// care which of the three folders a given record currently sits in). Every
// path-construction site instead checks against one of the three specific
// regexes above, so a freshly built path is always checked against exactly
// the folder it's meant to land in.
const ARCHIVE_MANUS_ANY_RE = '#^archive/[A-Za-z0-9_-]+/(submitted|sketches|songs)/[^/]+\.(pdf|tex)$#';
// A chapter's attached pdf/tex files — client-picked path (like ARCHIVE_PATH_RE),
// wired into upload_path_level() below at 'boss' level, matching the wiki
// resource's own save level. Must live above the dispatch for the same
// const-ordering reason as every regex above.
const WIKI_ATTACHMENT_PATH_RE = '#^wiki/[A-Za-z0-9_-]+/[^/]+\.(pdf|tex)$#';

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
  'budget_submit'           => 'revyst', // revyster submit reimbursement requests
  'budget_active_year_info' => 'revyst', // read-only: just the active year number + label, for the submit form's title
  'budget_active_categories'=> 'revyst', // read-only: active year's expense categories, for the submit form's dropdown
  'budget_read'             => 'admin',
  'budget_receipt'          => 'admin',
  'budget_approve'          => 'admin',
  'budget_request_reject'   => 'admin',
  'budget_save_sheet'       => 'admin', // editable planned/income budget sheet
  'budget_expense_add'      => 'admin', // admin-entered direct expense
  'budget_expense_update'   => 'admin', // edit a paid expense (category locked); also toggles `deleted`
  'budget_expense_remove'   => 'admin', // permanently remove an already soft-deleted expense + its receipt
  'budget_request_update'   => 'admin', // edit a pending request
  'budget_categories_save'  => 'admin', // replace a year's expense/income category lists (add/rename/delete)
  'budget_create_year'      => 'admin', // create a new (inactive) budget year, seeded from the active year's planned amounts
  'budget_set_active_year'  => 'admin', // flip which year new revyst submissions/uploads land in
  'budget_delete_year'      => 'admin', // permanently delete a whole budget year — irreversible
  'budget_rename_year'      => 'admin', // rename/relabel an existing budget year, data carries over unchanged
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

// manuscripts_sync_selection is boss-level (not revyst, unlike the actions
// above) — it moves files, so it isn't safely append-only-trustable at
// revyst. Not in $RESOURCES either, since it never accepts a full-array
// replace, only {id, selected} pairs.
if ($action === 'manuscripts_sync_selection') {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK['boss']) {
    respond(403, ['error' => 'insufficient_level']);
  }
  manuscripts_sync_selection($body);
}

// manuscripts_delete is admin-level (stricter than the `manuscripts`
// resource's boss-level save_manuscripts) — permanently deletes a
// submission's pdf/tex files from the repo AND its JSON record (if one
// still exists) in one request, unlike save_manuscripts (record-only) or
// manuscripts_sync_selection (files moved, never deleted). Not in
// $RESOURCES: only accepts a single {pdfPath, texPath, id?}, never a
// full-array replace.
if ($action === 'manuscripts_delete') {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK['admin']) {
    respond(403, ['error' => 'insufficient_level']);
  }
  manuscripts_delete($body);
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
  if (preg_match(ARCHIVE_SNAPSHOT_RE, $path)) return 'admin';
  if (preg_match(WIKI_ATTACHMENT_PATH_RE, $path)) return 'boss';
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

// Categories are now per-year data (categories.json, see budget_load_categories
// below) rather than a fixed list — this only supplies the exact original 14
// expense + 2 income rows, used solely to (a) lazy-seed a year that predates
// this feature and (b) bootstrap a brand-new year when there's no active year
// to copy from. A function, not a `const` array: the budget-action dispatch
// near the top of this file calls budget_submit() before execution reaches a
// top-level `const` array declaration (which — unlike a scalar const — is
// only defined once its line runs), so a const here would be undefined at
// call time. Functions are hoisted, so this always works.
function budget_default_categories() {
  $expenseLabels = [
    'rekvisitter' => 'Rekvisitter og kostumer', 'makeup' => 'Makeup', 'texnik' => 'TeXnik',
    'snacks' => 'Snacks', 'kage' => 'Kage', 'mad' => 'Mad', 'sammenholdet' => 'Sammenholdet',
    'fest' => 'Efterfest', 'diverse' => 'Diverse', 'rengoring' => 'Rengøring',
    'tur' => 'Revyttetur', 'manus' => 'Manusmøder', 'tshirts' => 'T-shirts', 'stregnskab' => 'Stregnskab',
  ];
  $expense = [];
  foreach ($expenseLabels as $key => $label) {
    // abbrev = key initially — reproduces the pre-feature "<key>_<n>" receipt
    // filenames exactly, so nothing on disk needs migrating.
    $expense[] = ['key' => $key, 'label' => $label, 'abbrev' => $key];
  }
  return [
    'expense' => $expense,
    'income'  => [
      ['key' => 'billetsalg', 'label' => 'Billetsalg (efter kontingent)'],
      ['key' => 'andet',      'label' => 'Andet'],
    ],
  ];
}

// Reads a year's categories.json, lazily seeding it (via the same flock'd
// budget_mutate used everywhere else, so a concurrent first-read can't
// double-seed or clobber a file that appears in between) if it's missing or
// structurally invalid. Every handler that needs a year's categories calls
// THIS — never inline json_decode elsewhere — so the seed behavior is
// conservative and defined in exactly one place.
function budget_load_categories($budgetId) {
  $path = budget_year_dir($budgetId) . '/categories.json';
  if (is_file($path)) {
    $json = json_decode((string) file_get_contents($path), true);
    if (is_array($json) && isset($json['expense']) && isset($json['income'])) return $json;
  }
  return budget_mutate($budgetId, 'categories.json', null, function ($json) {
    if (is_array($json) && isset($json['expense']) && isset($json['income'])) return $json;
    return budget_default_categories();
  });
}

// ASCII-folds æøå, lowercases, joins on underscore (not hyphen — the result
// must satisfy budget_receipt_re()'s filename regex), and dedupes against
// $knownKeys (by reference, so a whole batch of new labels in one save can't
// collide with each other either, not just with pre-existing keys).
function budget_slugify_key($label, &$knownKeys) {
  $map = ['æ' => 'ae', 'ø' => 'oe', 'å' => 'aa', 'Æ' => 'ae', 'Ø' => 'oe', 'Å' => 'aa'];
  $s = strtolower(strtr($label, $map));
  $s = preg_replace('/[^a-z0-9]+/', '_', $s);
  $s = trim($s, '_');
  if ($s === '') $s = 'kategori';
  $base = $s;
  $n = 2;
  while (isset($knownKeys[$s])) { $s = $base . '_' . $n; $n++; }
  $knownKeys[$s] = true;
  return $s;
}

// Generates a stable, unique storage key (budgetId) for a NEW budget —
// mirrors budget_slugify_key()'s slug+dedupe approach, seeded with the year
// number so a fresh id can never collide with a legacy budget's own id
// (before multiple budgets per year were possible, a budget's id WAS simply
// its bare year number as a string, e.g. "2026" — every id generated here
// always contains an underscore right after the year, so it's safe against
// that by construction; no migration of existing directories is needed).
// $knownIds is passed by reference so a batch can't collide with itself
// either, same convention as budget_slugify_key.
function budget_slugify_budget_id($year, $label, &$knownIds) {
  $map = ['æ' => 'ae', 'ø' => 'oe', 'å' => 'aa', 'Æ' => 'ae', 'Ø' => 'oe', 'Å' => 'aa'];
  $s = strtolower(strtr($label, $map));
  $s = preg_replace('/[^a-z0-9]+/', '_', $s);
  $s = trim($s, '_');
  if ($s === '') $s = 'budget';
  $base = $year . '_' . $s;
  $budgetId = $base;
  $n = 2;
  while (isset($knownIds[$budgetId])) { $budgetId = $base . '_' . $n; $n++; }
  $knownIds[$budgetId] = true;
  return $budgetId;
}

// Receipt-filename component for a category key: its current abbrev, or the
// key itself if somehow not found (unreachable in normal operation — every
// caller validates the key against this year's category list first).
function budget_category_abbrev($categories, $key) {
  foreach (($categories['expense'] ?? []) as $c) {
    if (($c['key'] ?? null) === $key) {
      return (($c['abbrev'] ?? '') !== '') ? $c['abbrev'] : $key;
    }
  }
  return $key;
}

// The ONLY guard between a request's "file" field and reading an arbitrary
// file off the host. Receipts are named "<key>_<n>.<ext>" (paid) or
// "pending/<id>.<ext>" (submitted), ext being jpg (re-encoded images) or
// pdf (uploaded as-is — see budget_receipt_ext). Keep it strict.
// A function, not a `const`: the budget-action dispatch runs before any
// top-level `const` line in this file has executed (PHP registers const
// declarations in execution order), so a const here would be undefined at
// call time — see budget_category_keys() for the same reason.
function budget_receipt_re() {
  return '#^(pending/)?[A-Za-z0-9_]+\.(jpg|pdf)$#';
}

// Validates a client-supplied receipt extension, defaulting to 'jpg' (every
// caller pre-dating PDF support omits this field entirely).
function budget_receipt_ext($body) {
  $ext = $body['receiptExt'] ?? 'jpg';
  if ($ext !== 'jpg' && $ext !== 'pdf') respond(400, ['error' => 'invalid_shape']);
  return $ext;
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

// Every budget gets its own subdirectory under BUDGET_DATA_DIR
// (budget.json/requests.json/expenses.json/receipts/ per budget) — see
// years.json below for the cross-budget manifest. $budgetId is the stable
// storage key (see years.json's own comment below) — always an
// already-validated string (see budget_resolve_budget_id) by the time it
// reaches here, never taken raw from a client request.
function budget_year_dir($budgetId) {
  return budget_dir() . '/' . $budgetId;
}

// Read-only load of one of the JSON files; returns $default if missing/empty.
// $budgetId is null for the one file that lives at BUDGET_DATA_DIR root
// (years.json, see budget_load_years) and a string for every per-budget file.
function budget_load($budgetId, $name, $default) {
  $path = ($budgetId === null ? budget_dir() : budget_year_dir($budgetId)) . '/' . $name;
  if (!is_file($path)) return $default;
  $json = json_decode((string) file_get_contents($path), true);
  return is_array($json) ? $json : $default;
}

// Locked read-modify-write of one JSON file. $mutate receives the decoded
// array (or $default) and returns the array to persist. $budgetId: see
// budget_load() above.
function budget_mutate($budgetId, $name, $default, $mutate) {
  $dir = $budgetId === null ? budget_dir() : budget_year_dir($budgetId);
  budget_ensure_dir($dir);
  $path = $dir . '/' . $name;
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

function budget_receipts_dir($budgetId) {
  $dir = budget_year_dir($budgetId) . '/receipts';
  budget_ensure_dir($dir);
  budget_ensure_dir($dir . '/pending');
  return $dir;
}

// The cross-budget manifest — {activeBudgetId, years: [{budgetId, year,
// label, createdAt}]} — lives at BUDGET_DATA_DIR root (budgetId=null),
// sibling to the per-budget subdirectories, never inside one of them.
// `budgetId` is the stable storage key/directory name (mirrors Arkiv's own
// `folder`, per CLAUDE.md); `year` is a plain display/grouping field and,
// unlike before this feature, is NOT unique — multiple budgets can share a
// calendar year (e.g. a regular run and a jubilee edition), distinguished
// by `label` instead (which IS kept unique — see budget_create_year/
// budget_rename_year). budget_normalize_years_shape() upgrades a
// pre-existing (pre-multi-budget) years.json on the fly — see its own
// comment — so every read/write here always sees the current shape
// regardless of what's actually on disk.
function budget_load_years() {
  return budget_normalize_years_shape(budget_load(null, 'years.json', ['activeBudgetId' => null, 'years' => []]));
}

// Upgrades a possibly-legacy years.json shape: data from before this
// multi-budgets-per-year feature has {activeYear, years:[{year, label,
// createdAt}]} with no budgetId anywhere — the year number WAS the id (and
// the on-disk directory name), so every legacy entry's budgetId defaults to
// its own year, stringified, which is byte-identical to its existing
// directory name — no directory renames or data migration needed. Called
// both from budget_load_years() (every read) and at the top of every
// years.json budget_mutate() callback (which reads the raw file straight
// off disk, bypassing budget_load_years' own normalization), so a write
// against old-shape data can never silently drop or misinterpret it.
function budget_normalize_years_shape($json) {
  if (!is_array($json)) $json = [];
  $years = is_array($json['years'] ?? null) ? $json['years'] : [];
  foreach ($years as &$y) {
    if (!isset($y['budgetId']) || !is_string($y['budgetId']) || $y['budgetId'] === '') {
      $y['budgetId'] = (string) ($y['year'] ?? '');
    }
  }
  unset($y);
  $json['years'] = $years;
  if (!isset($json['activeBudgetId']) || !is_string($json['activeBudgetId']) || $json['activeBudgetId'] === '') {
    $legacyActiveYear = $json['activeYear'] ?? null;
    $json['activeBudgetId'] = is_int($legacyActiveYear) ? (string) $legacyActiveYear : null;
  }
  return $json;
}

// Finds one budget's full years.json entry ({budgetId, year, label,
// createdAt}) by its budgetId — used wherever a caller has an id and needs
// the display year/label that go with it (budget_read, budget_active_year_info).
function budget_find_year_entry($budgetId, $years) {
  foreach (($years['years'] ?? []) as $y) {
    if (($y['budgetId'] ?? null) === $budgetId) return $y;
  }
  return null;
}

// The budget revyst submissions/uploads land in — always server-resolved,
// never trusted from a client request (see budget_submit).
function budget_active_budget_id($years = null) {
  if ($years === null) $years = budget_load_years();
  $budgetId = $years['activeBudgetId'] ?? null;
  if (!is_string($budgetId) || $budgetId === '') respond(500, ['error' => 'no_active_year']);
  return $budgetId;
}

function budget_valid_budget_id($budgetId, $years) {
  if (!is_string($budgetId) || $budgetId === '') return false;
  foreach (($years['years'] ?? []) as $y) {
    if (($y['budgetId'] ?? null) === $budgetId) return true;
  }
  return false;
}

// Revyst: exposes only the active budget's year number + label from
// years.json — no personal data — so the submit-form page title can read
// "Budget for MatRevy <year>" without needing admin-level budget_read access.
function budget_active_year_info($body) {
  $years = budget_load_years();
  $budgetId = $years['activeBudgetId'] ?? null;
  if (!is_string($budgetId) || $budgetId === '') respond(200, ['ok' => true, 'year' => null, 'label' => null]);
  $entry = budget_find_year_entry($budgetId, $years);
  respond(200, ['ok' => true, 'year' => $entry ? ($entry['year'] ?? null) : null, 'label' => $entry ? ($entry['label'] ?? null) : null]);
}

// Every admin-level budget action accepts an optional {budgetId} to target
// a budget other than the active one (e.g. correcting a past year's ledger
// via "Tilføj udgift" without touching where new revyst submissions land)
// — validated against years.json's real list, defaulting to the active
// budget when omitted. budget_submit is the one caller that must NEVER use
// this; it always resolves the active budget directly instead.
function budget_resolve_budget_id($body, $years = null) {
  if ($years === null) $years = budget_load_years();
  if (array_key_exists('budgetId', $body) && $body['budgetId'] !== null) {
    $budgetId = $body['budgetId'];
    if (!is_string($budgetId) || !budget_valid_budget_id($budgetId, $years)) {
      respond(400, ['error' => 'invalid_year']);
    }
    return $budgetId;
  }
  return budget_active_budget_id($years);
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
    case 'budget_submit':           return budget_submit($body);
    case 'budget_active_year_info': return budget_active_year_info($body);
    case 'budget_active_categories':return budget_active_categories($body);
    case 'budget_read':             return budget_read($body);
    case 'budget_receipt':          return budget_receipt($body);
    case 'budget_approve':          return budget_approve($body);
    case 'budget_request_reject':   return budget_request_reject($body);
    case 'budget_save_sheet':       return budget_save_sheet($body);
    case 'budget_expense_add':      return budget_expense_add($body);
    case 'budget_expense_update':   return budget_expense_update($body);
    case 'budget_expense_remove':   return budget_expense_remove($body);
    case 'budget_request_update':   return budget_request_update($body);
    case 'budget_categories_save':  return budget_categories_save($body);
    case 'budget_create_year':      return budget_create_year($body);
    case 'budget_set_active_year':  return budget_set_active_year($body);
    case 'budget_delete_year':      return budget_delete_year($body);
    case 'budget_rename_year':      return budget_rename_year($body);
  }
  respond(400, ['error' => 'unknown_action']);
}

// Next bilag number for a category = max existing n + 1 (so deletions never
// reuse a number). Shared by budget_approve and budget_expense_add.
function budget_next_n($budgetId, $category) {
  $existing = budget_load($budgetId, 'expenses.json', ['expenses' => []])['expenses'] ?? [];
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
// Always resolves the active budget server-side — a client-supplied budgetId
// is never accepted here, unlike every admin-level handler below (a revyst
// caller must never be able to write into an arbitrary past budget).
//
// Category is deliberately NOT validated against this year's current list:
// the submit form loads categories once on open, and an admin can delete a
// category in the moments before a submitter clicks send. That submission
// must still be accepted — it lands in Afventende udlæg with an unresolvable
// category, and budget_request_update/budget_approve below refuse to let it
// become an approved expense until an admin assigns it a real one. Rejecting
// it here instead would just lose the submitter's work entirely.
function budget_submit($body) {
  $years = budget_load_years();
  $budgetId = $years['activeBudgetId'] ?? null;
  // A real, expected state (see budget_set_active_year's null-budgetId
  // path) rather than a server fault — respond 409, not
  // budget_active_budget_id()'s generic 500, so the submit form can show a
  // clear "not accepting requests right now" message instead of a scary error.
  if (!is_string($budgetId) || $budgetId === '') respond(409, ['error' => 'no_active_year']);
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  $comment  = $body['comment'] ?? '';
  $receipt  = $body['receiptBase64'] ?? '';
  if (!is_string($category) || trim($category) === '' || mb_strlen(trim($category)) > 60
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($name) || trim($name) === ''
      || !is_string($phone) || trim($phone) === ''
      || !is_string($comment)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $category = trim($category);
  $raw = budget_decode_receipt($receipt);
  $ext = budget_receipt_ext($body);

  $id = dechex(time()) . bin2hex(random_bytes(4));
  $receiptsDir = budget_receipts_dir($budgetId);
  if (@file_put_contents($receiptsDir . '/pending/' . $id . '.' . $ext, $raw) === false) {
    respond(500, ['error' => 'budget_storage_unavailable']);
  }

  $request = [
    'id'          => $id,
    'category'    => $category,
    'amount'      => round((float) $amount, 2),
    'name'        => trim($name),
    'phone'       => trim($phone),
    'comment'     => trim($comment),
    'receiptFile' => 'pending/' . $id . '.' . $ext,
    'createdAt'   => date('c'),
  ];
  budget_mutate($budgetId, 'requests.json', ['requests' => []], function ($json) use ($request) {
    if (!isset($json['requests']) || !is_array($json['requests'])) $json['requests'] = [];
    $json['requests'][] = $request;
    return $json;
  });
  respond(200, ['ok' => true, 'id' => $id]);
}

// Admin: return everything needed to render the management view for one
// budget (no binaries) — plus the cross-budget manifest itself
// (activeBudgetId/years), so the client can build its year-switcher from
// this same call without a separate round trip. $body['budgetId']
// (optional) picks which budget's budget/requests/expenses to return;
// defaults to the active budget.
function budget_read($body) {
  $years = budget_load_years();
  $requestedBudgetId = (array_key_exists('budgetId', $body) && $body['budgetId'] !== null) ? $body['budgetId'] : null;
  // Nothing to resolve/read: either a brand-new deploy (no years.json yet,
  // no budget has ever been created) or there's deliberately no active
  // budget right now (see budget_set_active_year's null-budgetId path) and
  // the caller didn't ask for a specific one either — respond with an
  // explicit "nothing yet" shape instead of budget_resolve_budget_id's
  // normal 500 (via budget_active_budget_id), so the client can render
  // just the "Start nyt budgetår" control. A caller that DOES pass an
  // explicit budgetId (e.g. the admin browsing a past budget, or
  // re-resolving after the active one was deleted) still resolves
  // normally below even with no active budget — only budget_submit (which
  // always needs a real active budget, never a client-chosen one) is
  // blocked outright by having no active budget.
  if (!is_string($years['activeBudgetId'] ?? null) && $requestedBudgetId === null) {
    respond(200, [
      'ok' => true, 'budgetId' => null, 'year' => null, 'activeBudgetId' => null, 'years' => $years['years'] ?? [],
      'budget' => null, 'requests' => null, 'expenses' => null,
    ]);
  }
  $budgetId = budget_resolve_budget_id($body, $years);
  $entry = budget_find_year_entry($budgetId, $years);
  respond(200, [
    'ok'             => true,
    'budgetId'       => $budgetId,
    'year'           => $entry ? ($entry['year'] ?? null) : null,
    'activeBudgetId' => $years['activeBudgetId'] ?? null,
    'years'          => $years['years'] ?? [],
    'budget'         => budget_load($budgetId, 'budget.json', ['planned' => new stdClass(), 'income' => [], 'updatedAt' => null]),
    'requests'       => budget_load($budgetId, 'requests.json', ['requests' => []]),
    'expenses'       => budget_load($budgetId, 'expenses.json', ['expenses' => []]),
    'categories'     => budget_load_categories($budgetId),
  ]);
}

// Revyst: the active budget's expense categories only (no income, no
// personal data) — for the submit form's category dropdown. Mirrors
// budget_active_year_info: always the active budget, never a
// client-supplied one, since a revyst caller must never read an arbitrary
// past budget. Also mirrors its graceful no-active-budget handling
// (year:null, empty list) rather than budget_active_budget_id()'s 500, so
// the submit form can render a clear "not accepting requests right now"
// state instead of an error.
function budget_active_categories($body) {
  $years = budget_load_years();
  $budgetId = $years['activeBudgetId'] ?? null;
  if (!is_string($budgetId) || $budgetId === '') respond(200, ['ok' => true, 'year' => null, 'expense' => []]);
  $entry = budget_find_year_entry($budgetId, $years);
  $categories = budget_load_categories($budgetId);
  respond(200, ['ok' => true, 'year' => $entry ? ($entry['year'] ?? null) : null, 'expense' => $categories['expense'] ?? []]);
}

// Admin: stream a receipt image (fetched with the password, so receipts are
// never exposed at a public URL). Overrides the JSON content-type header.
function budget_receipt($body) {
  $budgetId = budget_resolve_budget_id($body);
  $file = $body['file'] ?? '';
  if (!is_string($file) || !preg_match(budget_receipt_re(), $file)) {
    respond(400, ['error' => 'bad_path']);
  }
  $path = budget_year_dir($budgetId) . '/receipts/' . $file;
  if (!is_file($path)) respond(404, ['error' => 'not_found']);
  $ext = strtolower(pathinfo($file, PATHINFO_EXTENSION));
  header('Content-Type: ' . ($ext === 'pdf' ? 'application/pdf' : 'image/jpeg'));
  header('Content-Length: ' . filesize($path));
  readfile($path);
  exit;
}

// Admin: approve a pending request → assign the next bilag number for its
// category, rename the receipt to "<abbrev>_<n>.<ext>", move it into the
// ledger. $body['budgetId'] (optional) picks which budget's pending
// requests to approve into; defaults to the active budget. Re-validates
// the request's category against this budget's current list (see
// budget_submit) and, if it's no longer valid, puts the request back and
// refuses to approve.
function budget_approve($body) {
  $budgetId = budget_resolve_budget_id($body);
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
  budget_mutate($budgetId, 'requests.json', ['requests' => []], function ($json) use ($id, &$found) {
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
  $categories = budget_load_categories($budgetId);
  $validExpenseKeys = array_column($categories['expense'] ?? [], 'key');
  if (!in_array($category, $validExpenseKeys, true)) {
    // Category no longer exists (deleted after the request was submitted,
    // or was never valid — see budget_submit) — put the pulled request back
    // rather than silently losing it, and refuse to approve it. The admin
    // must reassign a real category via budget_request_update first.
    budget_mutate($budgetId, 'requests.json', ['requests' => []], function ($json) use ($found) {
      if (!isset($json['requests']) || !is_array($json['requests'])) $json['requests'] = [];
      $json['requests'][] = $found;
      return $json;
    });
    respond(409, ['error' => 'invalid_category']);
  }
  $n = budget_next_n($budgetId, $category);
  $abbrev = budget_category_abbrev($categories, $category);

  // Rename the receipt pending/<id>.<ext> → <abbrev>_<n>.<ext> (best-effort)
  // — ext follows whatever the pending file actually is (jpg or pdf), never
  // hardcoded, so a PDF receipt doesn't get silently renamed to .jpg.
  $receiptsDir = budget_receipts_dir($budgetId);
  $oldPath = $receiptsDir . '/' . ($found['receiptFile'] ?? '');
  $newRel = '';
  if (preg_match(budget_receipt_re(), $found['receiptFile'] ?? '') && is_file($oldPath)) {
    $ext = strtolower(pathinfo($found['receiptFile'], PATHINFO_EXTENSION));
    $receiptFile = $abbrev . '_' . $n . '.' . $ext;
    if (@rename($oldPath, $receiptsDir . '/' . $receiptFile)) $newRel = $receiptFile;
  }

  $expense = [
    'id'          => $id,
    'category'    => $category,
    'n'           => $n,
    'bilag'       => $abbrev . '_' . $n,
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
  budget_mutate($budgetId, 'expenses.json', ['expenses' => []], function ($json) use ($expense) {
    if (!isset($json['expenses']) || !is_array($json['expenses'])) $json['expenses'] = [];
    $json['expenses'][] = $expense;
    return $json;
  });
  respond(200, ['ok' => true, 'expense' => $expense]);
}

// Admin: reject/delete a pending request and its receipt. $body['budgetId']
// (optional) picks which budget; defaults to the active budget.
function budget_request_reject($body) {
  $budgetId = budget_resolve_budget_id($body);
  $id = $body['id'] ?? '';
  if (!is_string($id) || $id === '') respond(400, ['error' => 'invalid_shape']);
  $removed = null;
  budget_mutate($budgetId, 'requests.json', ['requests' => []], function ($json) use ($id, &$removed) {
    $keep = [];
    foreach (($json['requests'] ?? []) as $r) {
      if (($r['id'] ?? null) === $id) { $removed = $r; continue; }
      $keep[] = $r;
    }
    $json['requests'] = $keep;
    return $json;
  });
  if ($removed !== null && preg_match(budget_receipt_re(), $removed['receiptFile'] ?? '')) {
    @unlink(budget_year_dir($budgetId) . '/receipts/' . $removed['receiptFile']);
  }
  respond(200, ['ok' => true]);
}

// Admin: overwrite the editable budget sheet — the planned amount per category
// plus the income/revenue list. Spent/balance are derived client-side from the
// ledger, never stored here. $body['budgetId'] (optional) picks which
// budget; defaults to the active budget.
function budget_save_sheet($body) {
  $budgetId = budget_resolve_budget_id($body);
  $planned = $body['planned'] ?? null;
  $income  = $body['income'] ?? null;
  if (!is_array($planned) || !is_array($income)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $categories = budget_load_categories($budgetId);
  $expenseKeys = array_column($categories['expense'] ?? [], 'key');
  $incomeKeys  = array_column($categories['income']  ?? [], 'key');
  $cleanPlanned = [];
  foreach ($planned as $key => $val) {
    if (!in_array($key, $expenseKeys, true) || !is_numeric($val) || (float) $val < 0) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $cleanPlanned[$key] = round((float) $val, 2);
  }
  $cleanIncome = [];
  foreach ($income as $line) {
    // Label is intentionally not accepted/stored here any more — it lives
    // solely in categories.json now, resolved live, so it can't drift out
    // of sync with a rename made via the "Rediger kategorier" modal.
    if (!is_array($line)
        || !isset($line['key']) || !is_string($line['key']) || !in_array($line['key'], $incomeKeys, true)
        || !isset($line['amount']) || !is_numeric($line['amount']) || (float) $line['amount'] < 0) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $entry = [
      'key'    => $line['key'],
      'amount' => round((float) $line['amount'], 2),
    ];
    // Optional free-text description (e.g. what the "Andet" income covers).
    if (isset($line['note']) && is_string($line['note']) && trim($line['note']) !== '') {
      $entry['note'] = trim($line['note']);
    }
    $cleanIncome[] = $entry;
  }

  budget_mutate($budgetId, 'budget.json', ['planned' => new stdClass(), 'income' => [], 'updatedAt' => null],
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
// like budget_approve. $body['budgetId'] (optional) picks which budget to
// add into — this is what lets "Tilføj udgift" target a past budget while
// it's being viewed, independent of which one is currently active.
function budget_expense_add($body) {
  $budgetId = budget_resolve_budget_id($body);
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
  $categories = budget_load_categories($budgetId);
  $validExpenseKeys = array_column($categories['expense'] ?? [], 'key');
  if (!in_array($category, $validExpenseKeys, true)
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
  $n = budget_next_n($budgetId, $category);
  $abbrev = budget_category_abbrev($categories, $category);

  $receiptRel = '';
  if ($receipt !== '') {
    $raw = budget_decode_receipt($receipt);
    $ext = budget_receipt_ext($body);
    $receiptsDir = budget_receipts_dir($budgetId);
    $receiptRel = $abbrev . '_' . $n . '.' . $ext;
    if (@file_put_contents($receiptsDir . '/' . $receiptRel, $raw) === false) {
      respond(500, ['error' => 'budget_storage_unavailable']);
    }
  }

  $expense = [
    'id'          => $id,
    'category'    => $category,
    'n'           => $n,
    'bilag'       => $abbrev . '_' . $n,
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
  budget_mutate($budgetId, 'expenses.json', ['expenses' => []], function ($json) use ($expense) {
    if (!isset($json['expenses']) || !is_array($json['expenses'])) $json['expenses'] = [];
    $json['expenses'][] = $expense;
    return $json;
  });
  respond(200, ['ok' => true, 'expense' => $expense]);
}

// Admin: edit an existing paid expense. Category/n/bilag/receiptFile stay locked
// (changing category would need a bilag renumber + receipt rename — do reject/re-add).
// $body['budgetId'] (optional) picks which budget's ledger to edit;
// defaults to the active budget.
function budget_expense_update($body) {
  $budgetId = budget_resolve_budget_id($body);
  $id       = $body['id'] ?? '';
  $amount   = $body['amount'] ?? null;
  $date     = $body['date'] ?? '';
  $paidBy   = $body['paidBy'] ?? '';
  $transfer = $body['transfer'] ?? 0;
  $settled  = $body['settled'] ?? false;
  $comment  = $body['comment'] ?? '';
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  // Soft-delete flag: Slet sets it true (crossed out, excluded from Brugt,
  // receipt kept); Gendan sets it back to false. Defaults false so every
  // pre-existing caller of this action is unaffected.
  $deleted  = $body['deleted'] ?? false;
  if (!is_string($id) || $id === ''
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($date) || !preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)
      || !is_string($paidBy) || trim($paidBy) === ''
      || !is_numeric($transfer) || (float) $transfer < 0
      || !is_bool($settled)
      || !is_string($comment) || !is_string($name) || !is_string($phone)
      || !is_bool($deleted)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $found = false;
  budget_mutate($budgetId, 'expenses.json', ['expenses' => []],
    function ($json) use ($id, $amount, $date, $paidBy, $transfer, $settled, $comment, $name, $phone, $deleted, &$found) {
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
          $e['deleted']  = $deleted;
          if ($deleted) {
            $e['deletedAt'] = date('c');
          } else {
            unset($e['deletedAt']);
          }
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

// Admin: permanently remove an already soft-deleted expense — the only
// path that actually erases the ledger record and its receipt file. Never
// renumbers other receipts in the category: budget_next_n() already picks
// max-existing-n + 1 specifically so deletions never reuse a bilag number,
// so a gap left behind here is expected, not a bug to fix up.
// $body['budgetId'] (optional) picks which budget; defaults to the active
// budget.
function budget_expense_remove($body) {
  $budgetId = budget_resolve_budget_id($body);
  $id = $body['id'] ?? '';
  if (!is_string($id) || $id === '') respond(400, ['error' => 'invalid_shape']);
  $removed = null;
  budget_mutate($budgetId, 'expenses.json', ['expenses' => []], function ($json) use ($id, &$removed) {
    $keep = [];
    foreach (($json['expenses'] ?? []) as $e) {
      if (($e['id'] ?? null) === $id) { $removed = $e; continue; }
      $keep[] = $e;
    }
    $json['expenses'] = $keep;
    return $json;
  });
  if ($removed === null) respond(404, ['error' => 'not_found']);
  if (preg_match(budget_receipt_re(), $removed['receiptFile'] ?? '')) {
    @unlink(budget_year_dir($budgetId) . '/receipts/' . $removed['receiptFile']);
  }
  respond(200, ['ok' => true]);
}

// Admin: edit a pending request. Category may change (no bilag assigned yet; the
// receipt stays pending/<id>.<ext> regardless). $body['budgetId'] (optional)
// picks which budget; defaults to the active budget. Since budget_submit no
// longer validates category, this is the one place that enforces it — the
// actual reassignment step that clears an "orphaned" (deleted-category) request.
function budget_request_update($body) {
  $budgetId = budget_resolve_budget_id($body);
  $id       = $body['id'] ?? '';
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  $comment  = $body['comment'] ?? '';
  $validExpenseKeys = array_column(budget_load_categories($budgetId)['expense'] ?? [], 'key');
  if (!is_string($id) || $id === ''
      || !in_array($category, $validExpenseKeys, true)
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($name) || trim($name) === ''
      || !is_string($phone) || trim($phone) === ''
      || !is_string($comment)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $found = false;
  budget_mutate($budgetId, 'requests.json', ['requests' => []],
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

// Admin: replace a budget's expense + income category lists in one atomic
// write — the save handler behind the "Rediger kategorier" modal. Deleting a
// category is simply omitting it from the payload; no server-side block on
// deleting an in-use one (the client warns first). $body['budgetId']
// (optional) picks which budget to edit; defaults to the active budget.
function budget_categories_save($body) {
  $budgetId = budget_resolve_budget_id($body);
  $expenseIn = $body['expense'] ?? null;
  $incomeIn  = $body['income'] ?? null;
  if (!is_array($expenseIn) || !is_array($incomeIn) || count($expenseIn) === 0 || count($incomeIn) === 0) {
    respond(400, ['error' => 'invalid_shape']);
  }

  $current = budget_load_categories($budgetId);
  $currentExpenseByKey = [];
  foreach (($current['expense'] ?? []) as $c) { $currentExpenseByKey[$c['key']] = $c; }
  $expensesLedger = budget_load($budgetId, 'expenses.json', ['expenses' => []])['expenses'] ?? [];

  $knownExpenseKeys = array_fill_keys(array_keys($currentExpenseByKey), true);
  $usedExpenseKeys = [];
  $usedAbbrevsLower = [];
  $cleanExpense = [];
  foreach ($expenseIn as $item) {
    if (!is_array($item)
        || !isset($item['label']) || !is_string($item['label']) || trim($item['label']) === '' || mb_strlen(trim($item['label'])) > 60
        || !isset($item['abbrev']) || !is_string($item['abbrev']) || !preg_match('/^[A-Za-z0-9_]{1,20}$/', $item['abbrev'])) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $label = trim($item['label']);
    $abbrev = $item['abbrev'];
    $keyIn = (isset($item['key']) && is_string($item['key']) && $item['key'] !== '') ? $item['key'] : null;

    if ($keyIn !== null) {
      // A client-supplied key must already exist in this year's stored
      // list — a stale key means a concurrent edit happened elsewhere;
      // reject the whole save rather than silently inventing a row under
      // an untrusted key.
      if (!isset($currentExpenseByKey[$keyIn])) respond(409, ['error' => 'stale_categories']);
      $key = $keyIn;
      $storedAbbrev = $currentExpenseByKey[$keyIn]['abbrev'] ?? $keyIn;
      if ($storedAbbrev !== $abbrev) {
        foreach ($expensesLedger as $e) {
          if (($e['category'] ?? null) === $keyIn && empty($e['deleted'])) {
            respond(409, ['error' => 'abbrev_locked', 'category' => $keyIn]);
          }
        }
      }
    } else {
      $key = budget_slugify_key($label, $knownExpenseKeys);
    }
    if (isset($usedExpenseKeys[$key])) respond(400, ['error' => 'duplicate_category']);
    $usedExpenseKeys[$key] = true;
    // Abbrev uniqueness (case-insensitive) is a hard requirement, not
    // polish: budget_next_n() numbers per category KEY, but the receipt
    // filename is "<abbrev>_<n>" — two keys sharing an abbrev would each
    // restart their own n sequence while writing into the same filename
    // space, silently overwriting one category's receipt with another's.
    $abbrevLower = strtolower($abbrev);
    if (isset($usedAbbrevsLower[$abbrevLower])) respond(400, ['error' => 'duplicate_abbrev']);
    $usedAbbrevsLower[$abbrevLower] = true;

    $cleanExpense[] = ['key' => $key, 'label' => $label, 'abbrev' => $abbrev];
  }

  $currentIncomeByKey = [];
  foreach (($current['income'] ?? []) as $c) { $currentIncomeByKey[$c['key']] = $c; }
  $knownIncomeKeys = array_fill_keys(array_keys($currentIncomeByKey), true);
  $usedIncomeKeys = [];
  $cleanIncome = [];
  foreach ($incomeIn as $item) {
    if (!is_array($item) || !isset($item['label']) || !is_string($item['label'])
        || trim($item['label']) === '' || mb_strlen(trim($item['label'])) > 60) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $label = trim($item['label']);
    $keyIn = (isset($item['key']) && is_string($item['key']) && $item['key'] !== '') ? $item['key'] : null;
    if ($keyIn !== null) {
      if (!isset($currentIncomeByKey[$keyIn])) respond(409, ['error' => 'stale_categories']);
      $key = $keyIn;
    } else {
      $key = budget_slugify_key($label, $knownIncomeKeys);
    }
    if (isset($usedIncomeKeys[$key])) respond(400, ['error' => 'duplicate_category']);
    $usedIncomeKeys[$key] = true;
    $cleanIncome[] = ['key' => $key, 'label' => $label];
  }

  $result = budget_mutate($budgetId, 'categories.json', budget_default_categories(),
    function ($json) use ($cleanExpense, $cleanIncome) {
      return ['expense' => $cleanExpense, 'income' => $cleanIncome];
    });
  respond(200, ['ok' => true, 'categories' => $result]);
}

// Admin: create a new, empty budget — seeds its `planned` amounts and its
// categories.json as a copy of the *currently active* budget's (a
// deliberate starting point so the admin doesn't retype every category from
// scratch; falls back to budget_default_categories() if there's no active
// budget yet, i.e. true first-ever bootstrap), leaves income/expenses/
// requests empty, and appends it to years.json under a freshly-generated
// budgetId. Does NOT change which budget is active — call
// budget_set_active_year separately to actually route new revyst
// submissions into it (so "Start nyt budgetår" in the client is just these
// two calls in sequence). `year` no longer needs to be unique — multiple
// budgets can share a calendar year (e.g. a regular run and a jubilee
// edition), each in its own budgetId-keyed directory — but `label` does,
// so the two stay distinguishable everywhere they're shown by label alone
// (the year switcher, "Aktivt budget", the page title).
function budget_create_year($body) {
  $year = $body['year'] ?? null;
  $label = $body['label'] ?? '';
  if (!is_int($year) || $year < 2000 || $year > 2100
      || !is_string($label) || trim($label) === '') {
    respond(400, ['error' => 'invalid_shape']);
  }
  $label = trim($label);
  $years = budget_load_years();
  foreach (($years['years'] ?? []) as $y) {
    if (mb_strtolower($y['label'] ?? '') === mb_strtolower($label)) {
      respond(409, ['error' => 'label_exists']);
    }
  }
  $knownIds = [];
  foreach (($years['years'] ?? []) as $y) { $knownIds[$y['budgetId'] ?? ''] = true; }
  $budgetId = budget_slugify_budget_id($year, $label, $knownIds);

  $activeBudgetId = $years['activeBudgetId'] ?? null;
  $hasActive = is_string($activeBudgetId) && $activeBudgetId !== '';
  $seedPlanned = $hasActive
    ? (budget_load($activeBudgetId, 'budget.json', ['planned' => []])['planned'] ?? [])
    : [];
  if (empty($seedPlanned)) $seedPlanned = new stdClass();
  $seedCategories = $hasActive ? budget_load_categories($activeBudgetId) : budget_default_categories();

  budget_mutate($budgetId, 'budget.json', ['planned' => new stdClass(), 'income' => [], 'updatedAt' => null],
    function ($json) use ($seedPlanned) {
      $json['planned'] = $seedPlanned;
      $json['income'] = [];
      $json['updatedAt'] = date('c');
      return $json;
    });
  budget_mutate($budgetId, 'requests.json', ['requests' => []], function ($json) { return ['requests' => []]; });
  budget_mutate($budgetId, 'expenses.json', ['expenses' => []], function ($json) { return ['expenses' => []]; });
  budget_mutate($budgetId, 'categories.json', budget_default_categories(), function ($json) use ($seedCategories) {
    return $seedCategories;
  });
  budget_mutate(null, 'years.json', ['activeBudgetId' => null, 'years' => []], function ($json) use ($budgetId, $year, $label) {
    $json = budget_normalize_years_shape($json);
    $json['years'][] = ['budgetId' => $budgetId, 'year' => $year, 'label' => $label, 'createdAt' => date('c')];
    return $json;
  });
  respond(200, ['ok' => true, 'budgetId' => $budgetId, 'year' => $year]);
}

// Admin: flip which budget new revyst submissions/receipts land in. Works
// equally for a brand-new budget (right after budget_create_year) or for
// re-activating an already-existing past one (e.g. correcting a mistaken
// switch) — it never creates anything itself. `budgetId: null` is also
// accepted, deliberately (the "Intet valgt" option in the Skift-modal's
// dropdown) — it blocks revyst submissions (budget_submit/
// budget_active_categories both require a real active budget) without
// deleting anything; every budget, including whichever was last active,
// stays fully browsable via budget_read's explicit-budgetId path.
function budget_set_active_year($body) {
  if (!array_key_exists('budgetId', $body)) respond(400, ['error' => 'invalid_shape']);
  $budgetId = $body['budgetId'];
  if ($budgetId !== null) {
    if (!is_string($budgetId)) respond(400, ['error' => 'invalid_shape']);
    $years = budget_load_years();
    if (!budget_valid_budget_id($budgetId, $years)) respond(400, ['error' => 'unknown_year']);
  }
  budget_mutate(null, 'years.json', ['activeBudgetId' => null, 'years' => []], function ($json) use ($budgetId) {
    $json = budget_normalize_years_shape($json);
    $json['activeBudgetId'] = $budgetId;
    return $json;
  });
  respond(200, ['ok' => true, 'activeBudgetId' => $budgetId]);
}

// Recursively removes a directory and everything in it. No built-in PHP
// equivalent of `rm -rf` — used only by budget_delete_year, and only ever on
// a path built from budget_year_dir($budgetId) with an already-validated
// $budgetId (never a client-supplied path), same "server builds the path"
// posture as the rest of this file's filesystem writes.
function budget_rrmdir($dir) {
  if (!is_dir($dir)) return;
  foreach (scandir($dir) as $item) {
    if ($item === '.' || $item === '..') continue;
    $path = $dir . '/' . $item;
    if (is_dir($path)) budget_rrmdir($path);
    else @unlink($path);
  }
  @rmdir($dir);
}

// Admin: permanently deletes an entire budget — its directory
// (budget.json/requests.json/expenses.json/receipts/, including every
// receipt photo) and its years.json entry. Cannot be undone; the client is
// expected to have already confirmed this explicitly (twice, per the UI) —
// nothing here asks again. If the deleted budget was active, activeBudgetId
// is cleared (never left pointing at a directory that no longer exists) —
// which puts the page back in its "no active budget" state until a new or
// existing budget is activated (though every other budget, if any remain,
// stays fully browsable regardless — see budget_read).
function budget_delete_year($body) {
  $budgetId = $body['budgetId'] ?? null;
  if (!is_string($budgetId) || $budgetId === '') respond(400, ['error' => 'invalid_shape']);
  $years = budget_load_years();
  if (!budget_valid_budget_id($budgetId, $years)) respond(404, ['error' => 'not_found']);

  budget_rrmdir(budget_year_dir($budgetId));

  $wasActive = ($years['activeBudgetId'] ?? null) === $budgetId;
  budget_mutate(null, 'years.json', ['activeBudgetId' => null, 'years' => []], function ($json) use ($budgetId, $wasActive) {
    $json = budget_normalize_years_shape($json);
    $json['years'] = array_values(array_filter($json['years'] ?? [], function ($y) use ($budgetId) {
      return ($y['budgetId'] ?? null) !== $budgetId;
    }));
    if ($wasActive) $json['activeBudgetId'] = null;
    return $json;
  });
  respond(200, ['ok' => true]);
}

// Admin: renames/relabels an existing budget — a pure years.json metadata
// update now: budgetId is the stable storage key, fully decoupled from
// year/label (see budget_slugify_budget_id), so unlike before this
// multi-budgets-per-year feature, changing the year number or label never
// needs a directory rename — every existing request/expense/receipt is
// completely unaffected. `label` must still be unique across every budget
// (year no longer needs to be — see budget_create_year), checked against
// every OTHER entry.
function budget_rename_year($body) {
  $budgetId = $body['budgetId'] ?? null;
  $year = $body['year'] ?? null;
  $label = $body['label'] ?? '';
  if (!is_string($budgetId) || $budgetId === ''
      || !is_int($year) || $year < 2000 || $year > 2100
      || !is_string($label) || trim($label) === '') {
    respond(400, ['error' => 'invalid_shape']);
  }
  $label = trim($label);
  $years = budget_load_years();
  if (!budget_valid_budget_id($budgetId, $years)) respond(404, ['error' => 'not_found']);
  foreach (($years['years'] ?? []) as $y) {
    if (($y['budgetId'] ?? null) !== $budgetId && mb_strtolower($y['label'] ?? '') === mb_strtolower($label)) {
      respond(409, ['error' => 'label_exists']);
    }
  }

  budget_mutate(null, 'years.json', ['activeBudgetId' => null, 'years' => []],
    function ($json) use ($budgetId, $year, $label) {
      $json = budget_normalize_years_shape($json);
      $list = $json['years'];
      foreach ($list as &$y) {
        if (($y['budgetId'] ?? null) === $budgetId) {
          $y['year'] = $year;
          $y['label'] = $label;
        }
      }
      unset($y);
      $json['years'] = $list;
      return $json;
    });
  respond(200, ['ok' => true, 'budgetId' => $budgetId, 'year' => $year]);
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
  // A same-day resave with unchanged acts/cast previously produced a
  // byte-identical JSON body once `version` had already been stamped to
  // today's date earlier that day — GitHub's Contents API still accepts
  // that PUT, but the resulting commit has a genuinely empty diff, which
  // silently fails to trigger the path-filtered embed-scenes.yml/
  // generate-pdfs.yml workflows (confirmed live 2026-08-21: four real
  // "Generér PDF'er" clicks in a row all produced 0-addition/0-deletion
  // commits). `version` itself stays date-only since it's real displayed
  // content (printed on every scene manuscript's running header via
  // revy.sty's \version{}) — this second, purely-mechanical field is what
  // actually guarantees a real diff on every single save, same-day repeats
  // included.
  $now = date('c');

  // Only an explicit "Generér PDF'er" click asks the PDF pipeline
  // (generate-pdfs.yml) to actually run — a plain Gem just persists the
  // draft. manusRegeneratePdfs() sends regeneratePdfs:true in the payload;
  // that becomes a `[regen-pdfs]` marker in both commits' messages, which
  // generate-pdfs.yml's own job-level `if:` checks for (see that workflow).
  // embed-scenes.yml is untouched by this and still runs on every save
  // regardless, so scenes-data.js/CAST_DATA stay live immediately either
  // way — only the compiled PDFs are decoupled from a bare Gem.
  $regeneratePdfs = ($payload['regeneratePdfs'] ?? false) === true;
  $pdfMarker = $regeneratePdfs ? ' [regen-pdfs]' : '';

  update_file('data/scenes.json', function ($json) use ($scenesActs, $today, $now) {
    $json['acts'] = $scenesActs;
    $json['version'] = $today;
    $json['generatedAt'] = $now;
    return $json;
  }, 'Opdater scenes.json via manus-værktøj' . $pdfMarker);

  update_file('data/cast.json', function ($json) use ($castList, $now) {
    $json['cast'] = $castList;
    $json['generatedAt'] = $now;
    return $json;
  }, 'Opdater cast.json via manus-værktøj' . $pdfMarker);
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

// Slug collisions are checked per type using each submission's own `type`
// field plus its pdf filename's basename — not the path's folder segment,
// since a submission's *current* pdfPath now depends on where it sits
// (submitted/sketches/songs), not on its type alone.
function manus_existing_slugs($type, $submissions) {
  $slugs = [];
  foreach ($submissions as $s) {
    if (($s['type'] ?? null) !== $type) continue;
    $pdf = $s['pdfPath'] ?? '';
    if (is_string($pdf) && preg_match('#([^/]+)\.pdf$#', $pdf, $m)) {
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

// Shared by manuscripts_create and manuscripts_sync_selection — both need
// data/config.json's currentProductionFolder as the base of every manus
// archive path they build. Returns null on any failure (missing file,
// missing/invalid field) so callers can respond with a single clear error.
function manus_current_production_folder() {
  [$cfgStatus, $cfg] = github_api('GET', 'contents/data/config.json');
  $folder = ($cfgStatus === 200)
    ? (json_decode(base64_decode($cfg['content']), true)['currentProductionFolder'] ?? '')
    : '';
  if (!is_string($folder) || $folder === '' || !preg_match('#^[A-Za-z0-9_-]+$#', $folder)) {
    return null;
  }
  return $folder;
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

  $folder = manus_current_production_folder();
  if ($folder === null) {
    respond(400, ['error' => 'no_production_folder']);
  }

  [$getStatus, $current] = github_api('GET', 'contents/data/manuscripts.json');
  $existing = [];
  if ($getStatus === 200) {
    $decoded = json_decode(base64_decode($current['content']), true);
    $existing = (is_array($decoded) && isset($decoded['submissions']) && is_array($decoded['submissions']))
      ? $decoded['submissions'] : [];
  }
  // Titles must be unique across all types, not just within one — both
  // sketch and song uploads stage into the same flat submitted/ folder, so
  // a same-titled sketch and song would otherwise slugify to the same
  // filename and the second upload would silently overwrite the first.
  $normalizedTitle = mb_strtolower(trim($title));
  foreach ($existing as $s) {
    if (mb_strtolower(trim($s['title'] ?? '')) === $normalizedTitle) {
      respond(409, ['error' => 'duplicate_title']);
    }
  }
  $slug = manus_unique_slug($type, trim($title), $existing);

  $pdfPath = 'archive/' . $folder . '/submitted/' . $slug . '.pdf';
  $texPath = 'archive/' . $folder . '/submitted/' . $slug . '.tex';
  if (!preg_match(ARCHIVE_MANUS_SUBMITTED_RE, $pdfPath) || !preg_match(ARCHIVE_MANUS_SUBMITTED_RE, $texPath)) {
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
// files). Not in $RESOURCES either — never accepts a full-array replace,
// only {id, selected} pairs. Nothing is ever permanently "discarded" via Gem
// anymore — a submission just cycles between
// archive/<folder>/{submitted,sketches,songs}/. Only the boss/admin ✕
// button's full-array-replace (save_manuscripts) can still truly remove a
// submission's *record*, and even that never deletes its files (see
// save_manuscripts' own comment).
//
// Runs as a full reconciliation every time it's called (i.e. on every Gem
// click on the Main Manus View, not just once): for each {id, selected} pair
// sent, looks up that submission's current pdfPath/texPath/type in
// data/manuscripts.json, works out which of the three folders it *should* be
// in (submitted if selected=false; sketches/songs by type if selected=true),
// and moves it there if it isn't already — so re-running with the same
// selections is a no-op, and a submission that was selected then later
// deselected moves itself straight back to submitted/ on the very next Gem
// click, with no separate "un-discard" step.
//
// Submissions already "graduated" into a real scene (data/scenes.json has a
// scene whose sourcePdf equals this submission's current pdfPath) are always
// skipped, regardless of what the client sent for their id — manusInitDraft()
// on the client already permanently excludes a graduated submission from
// Vælg scener's pool, so the client should never send one, but this is
// checked server-side too as defense-in-depth.
//
// Multi-request, non-atomic, same posture as the old manuscripts_discard:
// files are moved (GET+put_file()+delete_file() per file) BEFORE
// data/manuscripts.json is rewritten once at the end with every reconciled
// submission's current pdfPath/texPath.
function manuscripts_sync_selection($body) {
  $selections = $body['selections'] ?? null;
  if (!is_array($selections)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $selectedById = [];
  foreach ($selections as $sel) {
    if (!is_array($sel) || !isset($sel['id'], $sel['selected'])
        || !is_string($sel['id']) || $sel['id'] === '' || !is_bool($sel['selected'])) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $selectedById[$sel['id']] = $sel['selected'];
  }
  if (!$selectedById) {
    respond(200, ['ok' => true, 'results' => []]);
  }

  $folder = manus_current_production_folder();
  if ($folder === null) {
    respond(400, ['error' => 'no_production_folder']);
  }

  // Graduated submissions (already placed+saved as a real scene) are never
  // touched — same "sourcePdf" linkage manusInitDraft() uses client-side.
  [$scenesStatus, $scenesFile] = github_api('GET', 'contents/data/scenes.json');
  $graduatedPaths = [];
  if ($scenesStatus === 200) {
    $scenesDecoded = json_decode(base64_decode($scenesFile['content']), true);
    $acts = (is_array($scenesDecoded) && isset($scenesDecoded['acts']) && is_array($scenesDecoded['acts']))
      ? $scenesDecoded['acts'] : [];
    foreach ($acts as $act) {
      foreach (($act['scenes'] ?? []) as $scene) {
        if (!empty($scene['sourcePdf'])) $graduatedPaths[$scene['sourcePdf']] = true;
      }
    }
  }

  [$getStatus, $current] = github_api('GET', 'contents/data/manuscripts.json');
  if ($getStatus !== 200) {
    respond(502, ['error' => 'github_read_failed', 'file' => 'data/manuscripts.json']);
  }
  $decoded = json_decode(base64_decode($current['content']), true);
  $submissions = (is_array($decoded) && isset($decoded['submissions']) && is_array($decoded['submissions']))
    ? $decoded['submissions'] : [];

  $destFolderByType = ['sketch' => 'sketches', 'sang' => 'songs'];
  $destRegexByFolder = [
    'submitted' => ARCHIVE_MANUS_SUBMITTED_RE,
    'sketches'  => ARCHIVE_MANUS_SKETCHES_RE,
    'songs'     => ARCHIVE_MANUS_SONGS_RE,
  ];

  $results = [];
  $updatedSubmissions = [];
  foreach ($submissions as $s) {
    $id = $s['id'] ?? '';
    if (!isset($selectedById[$id]) || isset($graduatedPaths[$s['pdfPath'] ?? ''])) {
      $updatedSubmissions[] = $s; // not in this request, or graduated — untouched
      continue;
    }
    $type = $s['type'] ?? '';
    $destFolder = $selectedById[$id] ? ($destFolderByType[$type] ?? null) : 'submitted';
    if ($destFolder === null) {
      $updatedSubmissions[] = $s; // unrecognized type — leave untouched, defensive
      continue;
    }
    foreach (['pdfPath', 'texPath'] as $field) {
      $src = $s[$field] ?? '';
      if (!is_string($src) || $src === '') continue; // texPath optional/legacy-missing
      $dest = 'archive/' . $folder . '/' . $destFolder . '/' . basename($src);
      if (!preg_match($destRegexByFolder[$destFolder], $dest)) {
        respond(400, ['error' => 'bad_path']);
      }
      if ($dest !== $src) {
        [$srcStatus, $srcFile] = github_api('GET', 'contents/' . $src);
        if ($srcStatus === 200) {
          // Re-encode rather than forwarding GitHub's own content field
          // verbatim (chunked with embedded newlines) — put_file()'s other
          // callers always pass clean, freshly-encoded base64.
          $cleanBase64 = base64_encode(base64_decode($srcFile['content']));
          put_file($dest, $cleanBase64, 'Flyt manus: ' . ($s['title'] ?? $id));
          delete_file($src, 'Flyt manus: ' . ($s['title'] ?? $id));
        } // else: already moved/gone — treat as done, still record the new path
        $s[$field] = $dest;
      }
    }
    $updatedSubmissions[] = $s;
    $results[] = ['id' => $id, 'pdfPath' => $s['pdfPath'], 'texPath' => $s['texPath'] ?? ''];
  }

  update_file('data/manuscripts.json', function ($json) use ($updatedSubmissions) {
    $json['submissions'] = $updatedSubmissions;
    return $json;
  }, 'Synkroniser manus-udvælgelse');

  respond(200, ['ok' => true, 'results' => $results]);
}

// Admin-only permanent delete: removes the pdf+tex files from the repo and,
// if a matching submission record still exists, drops it from
// data/manuscripts.json too. Matches by pdfPath/texPath (not just id) so an
// already-placed row — which the client only knows via its scene's
// sourcePdf/sourceTex, never the original submission id — is still cleaned
// up correctly; if no submission matches, the filter below is a no-op and
// only the files are removed.
function manuscripts_delete($body) {
  $pdfPath = $body['pdfPath'] ?? '';
  $texPath = $body['texPath'] ?? '';
  $id = $body['id'] ?? null;
  if (!is_string($pdfPath) || !preg_match(ARCHIVE_MANUS_ANY_RE, $pdfPath)
      || !is_string($texPath) || !preg_match(ARCHIVE_MANUS_ANY_RE, $texPath)) {
    respond(400, ['error' => 'bad_path']);
  }

  delete_file($pdfPath, 'Slet manus permanent: ' . $pdfPath);
  delete_file($texPath, 'Slet manus permanent: ' . $texPath);

  update_file('data/manuscripts.json', function ($json) use ($pdfPath, $texPath, $id) {
    $submissions = (is_array($json['submissions'] ?? null)) ? $json['submissions'] : [];
    $json['submissions'] = array_values(array_filter($submissions, function ($s) use ($pdfPath, $texPath, $id) {
      if ($id !== null && ($s['id'] ?? null) === $id) return false;
      if (($s['pdfPath'] ?? null) === $pdfPath || ($s['texPath'] ?? null) === $texPath) return false;
      return true;
    }));
    return $json;
  }, 'Slet manus permanent fra manuscripts.json');

  respond(200, ['ok' => true]);
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
        || !is_string($s['pdfPath']) || !preg_match(ARCHIVE_MANUS_ANY_RE, $s['pdfPath'])
        || !is_string($s['texPath']) || !preg_match(ARCHIVE_MANUS_ANY_RE, $s['texPath'])
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
// `attachments` (optional, defaults to none) is a list of pdf/tex files
// uploaded separately via the generic 'upload' action (see
// WIKI_ATTACHMENT_PATH_RE) before this save — each entry just references
// an already-uploaded path, re-checked here the same "always check" way
// every other stored path is (e.g. save_archive's coverImage/manusPdf).
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
    if (isset($c['attachments'])) {
      if (!is_array($c['attachments'])) {
        respond(400, ['error' => 'invalid_wiki_shape']);
      }
      $seenAttachmentId = [];
      foreach ($c['attachments'] as $a) {
        if (!is_array($a)
            || !isset($a['id'], $a['name'], $a['path'])
            || !is_string($a['id']) || $a['id'] === ''
            || isset($seenAttachmentId[$a['id']])
            || !is_string($a['name']) || $a['name'] === ''
            || !is_string($a['path']) || !preg_match(WIKI_ATTACHMENT_PATH_RE, $a['path'])) {
          respond(400, ['error' => 'invalid_wiki_shape']);
        }
        $seenAttachmentId[$a['id']] = true;
      }
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
// base of every path manuscripts_create/manuscripts_sync_selection build.
// There's no real "current season" concept yet (see matrevy-plan.md's
// Phase 13) — this is a small, deliberately minimal stand-in, set by hand
// once per production cycle via the Manus page.
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
