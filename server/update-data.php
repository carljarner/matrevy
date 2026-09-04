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
  'budget_request_split'    => 'admin', // duplicate a pending request (one receipt, multiple expenses)
  'budget_categories_save'  => 'admin', // replace a year's expense/income category lists (add/rename/delete)
  'budget_create_year'      => 'admin', // create a new (inactive) budget year, seeded from the active year's planned amounts
  'budget_set_active_year'  => 'admin', // flip which year new revyst submissions/uploads land in
  'budget_delete_year'      => 'admin', // permanently delete a whole budget year — irreversible
  'budget_rename_year'      => 'admin', // rename/relabel an existing budget year, data carries over unchanged
  'streg_read'              => 'admin', // stregregnskab: read one budget's bar-tally sheet
  'streg_save_rows'         => 'admin', // replace the whole name/tally-count rows list (also "Nulstil", with an empty array)
  'streg_save_categories'   => 'admin', // replace the drink-category list + prices (add/rename/reorder/remove)
  'streg_save_connection'   => 'admin', // connect/disconnect a Formularer form for name rows
];
if (isset($BUDGET_ACTIONS[$action])) {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK[$BUDGET_ACTIONS[$action]]) {
    respond(403, ['error' => 'insufficient_level']);
  }
  handle_budget($action, $body);
}

// ── Forms actions (private Simply.com datastore, "Formularer" page) ──
// Self-hosted sign-up forms — same privacy posture as Budget above (never
// the public repo). Management (forms_admin_*/forms_save/forms_delete/
// templates_*) is boss-level, not admin-level: this is production-
// coordination tooling like Manus/Kalender/Wiki, not financial control —
// see the forms feature plan for the full reasoning.
$FORMS_ACTIONS = [
  'forms_list_open'  => 'revyst', // open forms, summary only (no fields)
  'forms_get'        => 'revyst', // one OPEN form's schema, for fill-in
  'forms_submit'     => 'revyst', // append-only response
  'forms_admin_list' => 'boss',   // all forms (any status), summary + response count
  'forms_admin_read' => 'boss',   // one form's full definition + all responses
  'forms_save'       => 'boss',   // create (no id) or update (id given) a form
  'forms_reorder'    => 'boss',   // Oversigt's drag-and-drop row order
  'forms_delete'     => 'boss',
  'forms_delete_response' => 'boss', // remove one response, not the whole form
  'templates_list'   => 'boss',
  'templates_save'   => 'boss',   // create (no id) or update (id given) a template
  'templates_delete' => 'boss',
];
if (isset($FORMS_ACTIONS[$action])) {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK[$FORMS_ACTIONS[$action]]) {
    respond(403, ['error' => 'insufficient_level']);
  }
  handle_forms($action, $body, $level);
}

// ── Fællesspisning actions (private Simply.com datastore) ──
// Communal-meal rehearsal-day sign-up sheet — same privacy posture as
// Budget/Forms above (never the public repo, since rows carry names/food
// preferences). A single shared document, fully open at the revyst tier
// (any logged-in cast/crew member can add/edit/delete any row, like a
// plain shared spreadsheet) — managing day columns is boss-gated;
// connecting a Formularer form is admin-only (not even visible to boss —
// see faellesRender's own siteHasLevel('admin') check in
// faellesspisning.js).
$FAELLES_ACTIONS = [
  'faelles_read'            => 'revyst', // {rows, connection, extraDays, hiddenDays, updatedAt} — also lazily syncs a connected form
  'faelles_upsert_row'      => 'revyst', // create (no rowId) or update (rowId given) one row
  'faelles_delete_row'      => 'revyst', // idempotent — ok even if already gone
  'faelles_save_connection' => 'admin',  // connect (formId given) or disconnect (formId: null) a Formularer form
  'faelles_add_day'         => 'boss',   // add a Fællesspisning-only day column (never the public `calendar` resource)
  'faelles_delete_day'      => 'boss',   // remove one — the only way to correct a mistaken add
  'faelles_hide_day'        => 'boss',   // hide a real calendar-sourced day column from this sheet only — the event itself is untouched
];
if (isset($FAELLES_ACTIONS[$action])) {
  if ($LEVEL_RANK[$level] < $LEVEL_RANK[$FAELLES_ACTIONS[$action]]) {
    respond(403, ['error' => 'insufficient_level']);
  }
  handle_faelles($action, $body);
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
// The one budget expense category key that can never be deleted — it's the
// join point between Afventende udlæg's approval flow (budget_approve
// requires a drink-type breakdown for a request under this category) and
// stregregnskab's own derived "Indkøb" column (see stregComputeIndkobByKey
// client-side). A function, not a bare literal repeated everywhere, so
// every comparison site agrees even if this key ever needed to change.
function budget_streg_category_key() {
  return 'stregnskab';
}

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
  // array_key_exists, not isset: budget_set_active_year's "Intet valgt"
  // path writes activeBudgetId:null deliberately, and isset() treats a
  // present-but-null value as absent — which used to send that
  // deliberate null straight back through the legacy migration below,
  // reviving a stale activeYear (or an old activeBudgetId) on every
  // following read/write instead of leaving it cleared.
  if (!array_key_exists('activeBudgetId', $json)) {
    $legacyActiveYear = $json['activeYear'] ?? null;
    $json['activeBudgetId'] = is_int($legacyActiveYear) ? (string) $legacyActiveYear : null;
  } elseif ($json['activeBudgetId'] !== null && (!is_string($json['activeBudgetId']) || $json['activeBudgetId'] === '')) {
    $json['activeBudgetId'] = null;
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
    case 'budget_request_split':    return budget_request_split($body);
    case 'budget_categories_save':  return budget_categories_save($body);
    case 'budget_create_year':      return budget_create_year($body);
    case 'budget_set_active_year':  return budget_set_active_year($body);
    case 'budget_delete_year':      return budget_delete_year($body);
    case 'budget_rename_year':      return budget_rename_year($body);
    case 'streg_read':              return streg_read($body);
    case 'streg_save_rows':         return streg_save_rows($body);
    case 'streg_save_categories':    return streg_save_categories($body);
    case 'streg_save_connection':   return streg_save_connection($body);
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

  // A Stregnskab-category request can't be approved until its amount has
  // been broken down by drink type — that breakdown is what lets
  // stregregnskab's own Priser card derive "Indkøb" per drink type instead
  // of it being hand-typed (see stregComputeIndkobByKey client-side).
  $stregBreakdown = null;
  if ($category === budget_streg_category_key()) {
    $stregDoc = budget_load($budgetId, 'streg.json', streg_default_doc());
    $stregKeys = array_column(streg_categories($stregDoc), 'key');
    $breakdown = is_array($found['stregBreakdown'] ?? null) ? $found['stregBreakdown'] : [];
    $sum = 0.0;
    $allKeysValid = !empty($breakdown);
    foreach ($breakdown as $k => $v) {
      if (!in_array($k, $stregKeys, true) || !is_numeric($v)) { $allKeysValid = false; break; }
      $sum += (float) $v;
    }
    $errorCode = null;
    if (!$allKeysValid) {
      $errorCode = 'streg_breakdown_required';
    } elseif (abs($sum - (float) $found['amount']) > 0.01) {
      $errorCode = 'streg_breakdown_mismatch';
    }
    if ($errorCode !== null) {
      // Same "put it back, refuse to approve" rollback as the invalid_category
      // check above.
      budget_mutate($budgetId, 'requests.json', ['requests' => []], function ($json) use ($found) {
        if (!isset($json['requests']) || !is_array($json['requests'])) $json['requests'] = [];
        $json['requests'][] = $found;
        return $json;
      });
      respond(409, ['error' => $errorCode]);
    }
    $stregBreakdown = $breakdown;
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
    // null for every non-Stregnskab expense — see stregComputeIndkobByKey
    // client-side, which sums this across expenses.json to derive "Indkøb".
    'stregBreakdown' => $stregBreakdown,
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
  // Note: `amount` can be edited here independently of a Stregnskab
  // expense's own `stregBreakdown` (category is locked post-approval, but
  // amount isn't) — an edit here doesn't re-validate or adjust the
  // breakdown against the new amount, same accepted looseness as every
  // other field here (comment/name/phone are equally editable with no
  // cross-checks). stregComputeIndkobByKey (budget.js) will simply reflect
  // whatever stregBreakdown was captured at approval time.
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
//
// Optional `stregBreakdown` ({[stregCategoryKey]: amount}): only meaningful
// when the (possibly just-changed) category is the Stregnskab one — see
// budget_streg_category_key(). If the client omits the field entirely, any
// existing breakdown is left untouched (so fixing e.g. just the phone number
// doesn't force a breakdown re-submit); if the category is something other
// than Stregnskab, any breakdown is dropped (meaningless outside it). Not
// required to sum to `amount` here — budget_approve is what actually
// enforces completeness, since an admin should be free to save partial
// progress before the request is ready to approve.
function budget_request_update($body) {
  $budgetId = budget_resolve_budget_id($body);
  $id       = $body['id'] ?? '';
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $name     = $body['name'] ?? '';
  $phone    = $body['phone'] ?? '';
  $comment  = $body['comment'] ?? '';
  $breakdownIn = array_key_exists('stregBreakdown', $body) ? $body['stregBreakdown'] : null;
  $validExpenseKeys = array_column(budget_load_categories($budgetId)['expense'] ?? [], 'key');
  if (!is_string($id) || $id === ''
      || !in_array($category, $validExpenseKeys, true)
      || !is_numeric($amount) || (float) $amount <= 0
      || !is_string($name) || trim($name) === ''
      || !is_string($phone) || trim($phone) === ''
      || !is_string($comment)) {
    respond(400, ['error' => 'invalid_shape']);
  }

  $cleanBreakdown = null;
  if ($category === budget_streg_category_key() && $breakdownIn !== null) {
    if (!is_array($breakdownIn)) respond(400, ['error' => 'invalid_shape']);
    $stregDoc = budget_load($budgetId, 'streg.json', streg_default_doc());
    $stregKeys = array_column(streg_categories($stregDoc), 'key');
    $cleanBreakdown = [];
    foreach ($breakdownIn as $k => $v) {
      if (!is_string($k) || !in_array($k, $stregKeys, true) || !is_numeric($v) || (float) $v < 0) {
        respond(400, ['error' => 'invalid_shape']);
      }
      $cleanBreakdown[$k] = round((float) $v, 2);
    }
  }

  $found = false;
  budget_mutate($budgetId, 'requests.json', ['requests' => []],
    function ($json) use ($id, $category, $amount, $name, $phone, $comment, $cleanBreakdown, &$found) {
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
          if ($category !== budget_streg_category_key()) {
            unset($r['stregBreakdown']);
          } elseif ($cleanBreakdown !== null) {
            $r['stregBreakdown'] = $cleanBreakdown;
          }
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

// Admin: split one pending request into two, for a single receipt that
// actually covers more than one expense (e.g. two categories on one
// grocery bill). The admin picks the new expense's own category and how
// much of the original amount belongs to it; that amount is subtracted
// from the original request (left otherwise untouched — same name/phone/
// comment) and a new request is appended for the split-off amount, with
// its own chosen category and a **copy** of the receipt file (a fresh
// file under pending/, so approving/rejecting either half never touches
// the other's file). $body['budgetId'] (optional) picks which budget;
// defaults to the active budget.
function budget_request_split($body) {
  $budgetId = budget_resolve_budget_id($body);
  $id       = $body['id'] ?? '';
  $category = $body['category'] ?? '';
  $amount   = $body['amount'] ?? null;
  $validExpenseKeys = array_column(budget_load_categories($budgetId)['expense'] ?? [], 'key');
  if (!is_string($id) || $id === ''
      || !in_array($category, $validExpenseKeys, true)
      || !is_numeric($amount) || (float) $amount <= 0) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $amount = round((float) $amount, 2);

  $receiptsDir = budget_receipts_dir($budgetId);
  $foundId = false;
  $success = false;
  $created = null;
  budget_mutate($budgetId, 'requests.json', ['requests' => []],
    function ($json) use ($id, $category, $amount, $receiptsDir, &$foundId, &$success, &$created) {
      $requests = $json['requests'] ?? [];
      $originalIndex = null;
      foreach ($requests as $i => $r) {
        if (($r['id'] ?? null) === $id) { $originalIndex = $i; break; }
      }
      if ($originalIndex === null) return $json;
      $foundId = true;
      $original = $requests[$originalIndex];
      // Must leave something behind on the original — otherwise this is
      // just a disguised category change, which budget_request_update
      // already covers.
      if ($amount >= (float) ($original['amount'] ?? 0)) return $json;
      $success = true;

      $requests[$originalIndex]['amount'] = round((float) $original['amount'] - $amount, 2);
      // A previously-saved stregBreakdown on the original can no longer sum
      // correctly against its new, smaller amount — clear it rather than
      // leave a stale value sitting there (budget_approve's own sum check
      // would catch it either way, but this avoids a confusing UI state).
      unset($requests[$originalIndex]['stregBreakdown']);

      $newId = dechex(time()) . bin2hex(random_bytes(4));
      $newReceiptFile = '';
      $oldPath = $receiptsDir . '/' . ($original['receiptFile'] ?? '');
      if (preg_match(budget_receipt_re(), $original['receiptFile'] ?? '') && is_file($oldPath)) {
        $ext = strtolower(pathinfo($original['receiptFile'], PATHINFO_EXTENSION));
        $candidate = 'pending/' . $newId . '.' . $ext;
        if (@copy($oldPath, $receiptsDir . '/' . $candidate)) $newReceiptFile = $candidate;
      }

      $duplicate = [
        'id'          => $newId,
        'category'    => $category,
        'amount'      => $amount,
        'name'        => $original['name'] ?? '',
        'phone'       => $original['phone'] ?? '',
        'comment'     => $original['comment'] ?? '',
        'receiptFile' => $newReceiptFile,
        'createdAt'   => date('c'),
      ];
      $created = $duplicate;
      $requests[] = $duplicate;
      $json['requests'] = $requests;
      return $json;
    });
  if (!$foundId) respond(404, ['error' => 'not_found']);
  if (!$success) respond(400, ['error' => 'invalid_amount']);
  respond(200, ['ok' => true, 'request' => $created]);
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

  // "Stregnskab" is a structural join point with stregregnskab's own
  // approval-gated Indkøb derivation (see budget_streg_category_key) — it
  // can be renamed like any other category, but never omitted/deleted.
  if (isset($currentExpenseByKey[budget_streg_category_key()]) && !isset($usedExpenseKeys[budget_streg_category_key()])) {
    respond(409, ['error' => 'category_protected', 'category' => budget_streg_category_key()]);
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

// ── Stregregnskab (bar tally accounting) — lives inside Budget's own
// per-budget storage, not a separate datastore: one names × drink-category
// grid per budget year, `streg.json` sibling to budget.json/requests.json/
// expenses.json under budget_year_dir($budgetId), read/written via the
// already-generic budget_load()/budget_mutate() above. Every action here
// resolves $budgetId via budget_resolve_budget_id($body) exactly like every
// other admin budget action, so switching "Viser budget for" also switches
// which year's stregregnskab is shown.
//
// "Indkøb" (per-category purchase total), STREGPRIS PR STYK (price per
// tally), and each row's Betaling are all derived client-side only — never
// stored here. Indkøb sums approved Stregnskab-category expenses' own
// stregBreakdown (see budget_approve above and stregComputeIndkobByKey in
// budget.js); the other two divide/multiply that against `rows[].counts`.
// A category is only ever added/removed, never renamed in place (same
// posture as Fællesspisning's day columns); deleting one leaves any row's
// existing counts[key] alone server-side, the client just stops rendering
// that column. Seeded with the three drink categories every year starts
// with in practice (Øl/Cider/Soda) — a brand-new stregregnskab isn't
// useful with an empty column list, and the admin can rename/reorder/
// remove/add from there via the Pris pr. streg card same as any other.
function streg_default_doc() {
  return [
    'categories' => [
      ['key' => 'ol', 'label' => 'Øl'],
      ['key' => 'cider', 'label' => 'Cider'],
      ['key' => 'soda', 'label' => 'Soda'],
    ],
    'rows' => [], 'connection' => null, 'updatedAt' => null,
  ];
}

function streg_categories($doc) {
  return (isset($doc['categories']) && is_array($doc['categories'])) ? $doc['categories'] : [];
}

// rowId/categoryId-agnostic hex id, same generator as every other feature
// (forms_id()/faelles_id()).
function streg_valid_id($id) {
  return is_string($id) && $id !== '' && preg_match('/^[0-9a-f]+$/', $id) === 1;
}

function streg_id() {
  return dechex(time()) . bin2hex(random_bytes(4));
}

function streg_read($body) {
  $budgetId = budget_resolve_budget_id($body);
  $doc = budget_load($budgetId, 'streg.json', streg_default_doc());
  $doc = streg_maybe_sync($budgetId, $doc);
  respond(200, [
    'ok'         => true,
    'budgetId'   => $budgetId,
    'categories' => streg_categories($doc),
    'rows'       => $doc['rows'] ?? [],
    'connection' => $doc['connection'] ?? null,
    'updatedAt'  => $doc['updatedAt'] ?? null,
  ]);
}

// Admin: replaces the whole rows list (navn + counts + paid per row) in one
// atomic write — the save handler behind the stregregnskab grid's own
// Nulstil/Gem bar (mirrors streg_save_categories's shape/validation almost
// exactly, and the same "send the full next array" convention used
// throughout this file). A client-supplied `id` that still matches a
// currently-existing row keeps that row's identity — `createdAt` and, most
// importantly, `source` (a row synced in from a connected Formularer form
// keeps that link, so a later sync still recognizes it as already
// present) are carried over from the current doc; `navn`/`counts`/`paid`
// always reflect exactly what the client sent. An omitted or stale `id`
// mints a fresh one via streg_id(). Any row currently on file whose id
// isn't present in the payload is simply dropped — "Nulstil" (clear the
// whole sheet) is just this same action called with an empty `rows` array.
function streg_save_rows($body) {
  $budgetId = budget_resolve_budget_id($body);
  $rowsIn = $body['rows'] ?? null;
  if (!is_array($rowsIn)) respond(400, ['error' => 'invalid_shape']);
  foreach ($rowsIn as $item) {
    if (!is_array($item)
        || !isset($item['navn']) || !is_string($item['navn']) || trim($item['navn']) === '' || mb_strlen(trim($item['navn'])) > 120
        || !isset($item['counts']) || !is_array($item['counts'])) {
      respond(400, ['error' => 'invalid_shape']);
    }
    foreach ($item['counts'] as $k => $v) {
      if (!is_string($k) || $k === '' || !is_numeric($v) || (float) $v < 0) {
        respond(400, ['error' => 'invalid_shape']);
      }
    }
  }

  $doc = budget_mutate($budgetId, 'streg.json', streg_default_doc(),
    function ($json) use ($rowsIn) {
      $knownKeys = array_column(streg_categories($json), 'key');
      $currentById = [];
      foreach (($json['rows'] ?? []) as $row) { $currentById[$row['id']] = $row; }
      $now = date('c');
      $nextRows = [];
      foreach ($rowsIn as $item) {
        $counts = [];
        foreach ($item['counts'] as $k => $v) {
          if (in_array($k, $knownKeys, true)) $counts[$k] = (int) round((float) $v);
        }
        $idIn = (isset($item['id']) && is_string($item['id']) && streg_valid_id($item['id'])) ? $item['id'] : null;
        $existing = ($idIn !== null && isset($currentById[$idIn])) ? $currentById[$idIn] : null;
        $paid = !empty($item['paid']);
        if ($existing) {
          $row = [
            'id' => $existing['id'], 'navn' => trim($item['navn']), 'counts' => $counts, 'paid' => $paid,
            'createdAt' => $existing['createdAt'] ?? $now, 'updatedAt' => $now,
          ];
          if (isset($existing['source'])) $row['source'] = $existing['source'];
          $nextRows[] = $row;
        } else {
          $nextRows[] = ['id' => streg_id(), 'navn' => trim($item['navn']), 'counts' => $counts, 'paid' => $paid, 'createdAt' => $now, 'updatedAt' => $now];
        }
      }
      $json['rows'] = $nextRows;
      $json['updatedAt'] = $now;
      return $json;
    });
  respond(200, ['ok' => true, 'rows' => $doc['rows'], 'updatedAt' => $doc['updatedAt']]);
}

// Admin: replaces the whole category list (key/label) in one atomic write,
// order preserved exactly as given — the save handler behind the Pris pr.
// streg card's own Gem button (mirrors budget_categories_save's shape/
// validation almost exactly, simplified: no abbrev/paid-expense-lock
// concept here, since a streg category never gates a filename the way a
// budget category's abbrev does). A client-supplied key must already exist
// in this budget's current list — a stale key means a concurrent edit
// happened elsewhere; reject the whole save rather than silently inventing
// a row under an untrusted key, same as budget_categories_save. Omitting
// `key` creates a new category, slugified via budget_slugify_key() (never
// client-chosen). Reordering is simply sending the array in the new order —
// the array order IS the display order, both here and in the stregregnskab
// grid's own columns. Deleting a category is simply omitting it from the
// payload; any row's counts[key] for it are left alone server-side (same
// "don't cross-validate against a removed column" posture as
// Fællesspisning's day deletion) — the client just stops rendering it.
//
// No `price` field any more — "Indkøb" is derived client-side from approved
// Stregnskab-category expenses' own stregBreakdown (see
// stregComputeIndkobByKey in budget.js and budget_approve above), never
// hand-typed or stored here.
function streg_save_categories($body) {
  $budgetId = budget_resolve_budget_id($body);
  $categoriesIn = $body['categories'] ?? null;
  if (!is_array($categoriesIn) || count($categoriesIn) === 0) {
    respond(400, ['error' => 'invalid_shape']);
  }

  $current = budget_load($budgetId, 'streg.json', streg_default_doc());
  $currentByKey = [];
  foreach (streg_categories($current) as $c) { $currentByKey[$c['key']] = $c; }
  $knownKeys = array_fill_keys(array_keys($currentByKey), true);

  $usedKeys = [];
  $cleanCategories = [];
  foreach ($categoriesIn as $item) {
    if (!is_array($item)
        || !isset($item['label']) || !is_string($item['label']) || trim($item['label']) === '' || mb_strlen(trim($item['label'])) > 60) {
      respond(400, ['error' => 'invalid_shape']);
    }
    $label = trim($item['label']);
    $keyIn = (isset($item['key']) && is_string($item['key']) && $item['key'] !== '') ? $item['key'] : null;
    if ($keyIn !== null) {
      if (!isset($currentByKey[$keyIn])) respond(409, ['error' => 'stale_categories']);
      $key = $keyIn;
    } else {
      $key = budget_slugify_key($label, $knownKeys);
    }
    if (isset($usedKeys[$key])) respond(400, ['error' => 'duplicate_category']);
    $usedKeys[$key] = true;
    $cleanCategories[] = ['key' => $key, 'label' => $label];
  }

  $doc = budget_mutate($budgetId, 'streg.json', streg_default_doc(),
    function ($json) use ($cleanCategories) {
      $json['categories'] = $cleanCategories;
      $json['updatedAt'] = date('c');
      return $json;
    });
  respond(200, ['ok' => true, 'categories' => $doc['categories'], 'updatedAt' => $doc['updatedAt']]);
}

// `formId: null` means "disconnect". Only a Navn-field mapping exists here
// (unlike Fællesspisning's Navn+Madforbehold pair) — tally counts have no
// form-field equivalent, they're always typed in directly at the bar.
function streg_validate_connection($body) {
  $formId = array_key_exists('formId', $body) ? $body['formId'] : null;
  if ($formId === null) return ['disconnect' => true];
  if (!is_string($formId) || !forms_valid_id($formId)) return null;
  $navnFieldId = $body['navnFieldId'] ?? '';
  if (!is_string($navnFieldId) || $navnFieldId === '' || mb_strlen($navnFieldId) > 80) return null;
  $formTitle = $body['formTitle'] ?? '';
  if (!is_string($formTitle)) $formTitle = '';
  return ['disconnect' => false, 'connection' => [
    'formId' => $formId,
    'navnFieldId' => $navnFieldId,
    'formTitle' => mb_substr(trim($formTitle), 0, 200),
    'syncedCount' => 0,
  ]];
}

// Pulls every response from the connected form and upserts it into rows by
// `source.responseId`, exactly mirroring faelles_sync_connection() — except
// only `navn` is ever written; an existing synced row's `counts` are left
// untouched on re-sync (the tally counts are this feature's own data, the
// form is only ever the source of truth for who's on the list). Reuses
// Forms' own storage (forms_form_dir) and its generic answer-to-string
// helper (faelles_forms_answer_to_text, despite the name a plain Forms-
// value stringifier, not Fællesspisning-specific) directly — this is one
// PHP file, not a per-page-loaded JS file, so there's no duplication
// convention to honour here.
function streg_sync_connection($budgetId, $connection) {
  return budget_mutate($budgetId, 'streg.json', streg_default_doc(), function ($doc) use ($connection) {
    $formId = $connection['formId'] ?? '';
    if (!forms_valid_id($formId)) return $doc;
    $navnFieldId = $connection['navnFieldId'] ?? '';
    $responsesDoc = forms_load(forms_form_dir($formId) . '/responses.json', ['responses' => []]);
    $responses = is_array($responsesDoc['responses'] ?? null) ? $responsesDoc['responses'] : [];

    $doc['rows'] = $doc['rows'] ?? [];
    $bySource = [];
    foreach ($doc['rows'] as $idx => $row) {
      if (isset($row['source']['formId'], $row['source']['responseId']) && $row['source']['formId'] === $formId) {
        $bySource[$row['source']['responseId']] = $idx;
      }
    }

    $now = date('c');
    foreach ($responses as $resp) {
      $rid = $resp['id'] ?? null;
      if (!is_string($rid) || $rid === '') continue;
      $answers = is_array($resp['answers'] ?? null) ? $resp['answers'] : [];
      $navn = trim(faelles_forms_answer_to_text($answers[$navnFieldId] ?? null));
      if ($navn === '') continue; // nothing meaningful to sync for this response
      if (isset($bySource[$rid])) {
        $idx = $bySource[$rid];
        if ($doc['rows'][$idx]['navn'] !== $navn) {
          $doc['rows'][$idx]['navn'] = $navn;
          $doc['rows'][$idx]['updatedAt'] = $now;
        }
      } else {
        $doc['rows'][] = [
          'id' => streg_id(),
          'navn' => $navn,
          'counts' => [],
          'source' => ['formId' => $formId, 'responseId' => $rid],
          'createdAt' => $now,
          'updatedAt' => $now,
        ];
      }
    }

    $connection['syncedCount'] = count($responses);
    $doc['connection'] = $connection;
    $doc['updatedAt'] = $now;
    return $doc;
  });
}

// Cheap pre-check (no lock) so an ordinary streg_read doesn't pay for a
// flock'd write when there's nothing new to sync — mirrors
// faelles_maybe_sync exactly.
function streg_maybe_sync($budgetId, $doc) {
  $connection = $doc['connection'] ?? null;
  if (!is_array($connection) || !forms_valid_id($connection['formId'] ?? '')) return $doc;
  $responsesDoc = forms_load(forms_form_dir($connection['formId']) . '/responses.json', ['responses' => []]);
  $respCount = count(is_array($responsesDoc['responses'] ?? null) ? $responsesDoc['responses'] : []);
  $syncedCount = is_int($connection['syncedCount'] ?? null) ? $connection['syncedCount'] : -1;
  if ($respCount === $syncedCount) return $doc;
  return streg_sync_connection($budgetId, $connection);
}

// Connecting immediately runs streg_sync_connection() so existing responses
// land right away, not just on the next streg_read. Disconnecting only
// clears `connection` — rows already synced in stay.
function streg_save_connection($body) {
  $budgetId = budget_resolve_budget_id($body);
  $clean = streg_validate_connection($body);
  if ($clean === null) respond(400, ['error' => 'invalid_shape']);

  if (!empty($clean['disconnect'])) {
    $doc = budget_mutate($budgetId, 'streg.json', streg_default_doc(), function ($json) {
      $json['connection'] = null;
      $json['updatedAt'] = date('c');
      return $json;
    });
    respond(200, ['ok' => true, 'connection' => null, 'rows' => $doc['rows'] ?? [], 'updatedAt' => $doc['updatedAt']]);
  }

  $doc = budget_mutate($budgetId, 'streg.json', streg_default_doc(), function ($json) use ($clean) {
    $json['connection'] = $clean['connection'];
    $json['updatedAt'] = date('c');
    return $json;
  });
  $doc = streg_sync_connection($budgetId, $doc['connection']);
  respond(200, ['ok' => true, 'connection' => $doc['connection'], 'rows' => $doc['rows'] ?? [], 'updatedAt' => $doc['updatedAt']]);
}

// ── Forms datastore (private Simply.com store, same posture as Budget) ──
// Self-hosted replacement for the Google Forms coordinators build every
// year (cast/crew sign-up, rehearsal availability, ...). Definitions,
// reusable templates, and submitted responses all live under
// FORMS_DATA_DIR — never the public repo, since responses may carry names/
// phone numbers. Unlike Budget, there is no "active year" to resolve: any
// number of forms can be open at once, and every call targets one specific
// formId the client already has, so there's no per-year directory/manifest
// here — each form is just its own subdirectory keyed by a stable formId.
// See CLAUDE.md's Budget section / the forms feature plan for the full
// rationale (co-located private store, boss-level management, flat
// per-form layout).

function forms_dir() {
  if (!defined('FORMS_DATA_DIR') || !is_string(FORMS_DATA_DIR) || FORMS_DATA_DIR === '') {
    respond(500, ['error' => 'forms_not_configured']);
  }
  return rtrim(FORMS_DATA_DIR, '/');
}

function forms_ensure_dir($dir) {
  if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
    respond(500, ['error' => 'forms_storage_unavailable']);
  }
}

// formId/templateId are always server-generated hex strings (see
// forms_id()) and are used directly to build filesystem paths — validated
// strictly here (never trusted raw from a client) to rule out path
// traversal. Unlike Budget's budgetId, forms has no years.json-style
// manifest to cross-check an id against, so this regex is the only guard.
function forms_valid_id($id) {
  return is_string($id) && $id !== '' && preg_match('/^[0-9a-f]+$/', $id) === 1;
}

function forms_form_dir($formId) {
  return forms_dir() . '/forms/' . $formId;
}

function forms_templates_path() {
  return forms_dir() . '/templates.json';
}

// Read-only load of one JSON file; returns $default if missing/empty.
function forms_load($path, $default) {
  if (!is_file($path)) return $default;
  $json = json_decode((string) file_get_contents($path), true);
  return is_array($json) ? $json : $default;
}

// Locked read-modify-write of one JSON file, structurally identical to
// budget_mutate() minus the per-budget directory indirection.
function forms_mutate($path, $default, $mutate) {
  forms_ensure_dir(dirname($path));
  $fh = @fopen($path, 'c+');
  if ($fh === false) respond(500, ['error' => 'forms_storage_unavailable']);
  if (!flock($fh, LOCK_EX)) { fclose($fh); respond(500, ['error' => 'forms_lock_failed']); }
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

function forms_id() {
  return dechex(time()) . bin2hex(random_bytes(4));
}

// Every form directory under forms_dir()/forms — filters out anything that
// doesn't look like a real, server-generated form (defensive against stray
// files on the host), same spirit as forms_valid_id().
function forms_all_form_ids() {
  $dir = forms_dir() . '/forms';
  if (!is_dir($dir)) return [];
  $ids = [];
  foreach (scandir($dir) as $item) {
    if ($item === '.' || $item === '..') continue;
    if (!forms_valid_id($item)) continue;
    if (is_file($dir . '/' . $item . '/definition.json')) $ids[] = $item;
  }
  return $ids;
}

function forms_valid_field_type($type) {
  return in_array($type, ['text', 'textarea', 'select', 'checkboxes', 'yesno',
    'scale', 'grid_single', 'grid_multi'], true);
}

// Validates a manual {value,label} option list (select/checkboxes' manual
// source, and grid columns which are always manual) — returns the clean
// list, or null if empty/malformed. The client always keeps value===label
// (there's no separate machine-value input any more), but this only
// enforces shape, not that equality, since nothing downstream depends on it.
function forms_validate_options($optionsIn) {
  $options = is_array($optionsIn) ? $optionsIn : [];
  $clean = [];
  foreach ($options as $o) {
    if (!is_array($o)) return null;
    $value = $o['value'] ?? '';
    $label = $o['label'] ?? '';
    if (!is_string($value) || $value === '' || mb_strlen($value) > 200) return null;
    if (!is_string($label) || $label === '' || mb_strlen($label) > 200) return null;
    $clean[] = ['value' => $value, 'label' => $label];
  }
  return count($clean) > 0 ? $clean : null;
}

// Validates + returns a clean FieldSpec, or null on any violation. $seenIds
// (by reference) rejects a duplicate field id within the same form/template
// — response answers are keyed by field id, so a collision would silently
// merge two questions' answers together. It also doubles as the lookup a
// LATER field's dependsOn needs: every entry holds the earlier field's own
// clean spec (not just a bool), overwritten in below once this field's
// $clean is built, so "is this fieldId valid and does it come before me"
// falls out of the same map for free — a forward/self reference simply
// isn't in there yet when a later field tries to resolve it.
function forms_validate_field_spec($f, &$seenIds) {
  if (!is_array($f)) return null;
  $id = $f['id'] ?? '';
  $type = $f['type'] ?? '';
  $label = $f['label'] ?? '';
  if (!is_string($id) || $id === '' || mb_strlen($id) > 60 || isset($seenIds[$id])) return null;
  if (!forms_valid_field_type($type)) return null;
  if (!is_string($label) || trim($label) === '' || mb_strlen($label) > 200) return null;
  $seenIds[$id] = true; // placeholder — real spec patched in below, once $clean exists

  $clean = [
    'id' => $id,
    'type' => $type,
    'label' => trim($label),
    'required' => !empty($f['required']),
  ];

  if ($type === 'text' || $type === 'textarea') {
    $placeholder = $f['placeholder'] ?? '';
    if (!is_string($placeholder) || mb_strlen($placeholder) > 200) return null;
    $clean['placeholder'] = $placeholder;
  } else if ($type === 'select' || $type === 'checkboxes') {
    $source = $f['optionsSource'] ?? 'manual';
    if (!in_array($source, ['manual', 'scenes', 'rehearsals'], true)) return null;
    $clean['optionsSource'] = $source;
    if ($source === 'manual') {
      $cleanOptions = forms_validate_options($f['options'] ?? []);
      if ($cleanOptions === null) return null;
      $clean['options'] = $cleanOptions;
    } else {
      // scenes/rehearsals — resolved client-side from live SCENES_DATA/
      // CALENDAR_DATA at render time, never stored here (see the forms
      // feature plan). sourceFilter is opaque server-side, just shape-capped.
      $filter = $f['sourceFilter'] ?? null;
      $clean['sourceFilter'] = is_array($filter) ? $filter : null;
    }
  } else if ($type === 'scale') {
    $min = $f['scaleMin'] ?? null;
    $max = $f['scaleMax'] ?? null;
    if (!is_int($min) || !is_int($max) || $min < 0 || $max > 10 || $min >= $max) return null;
    $minLabel = $f['scaleMinLabel'] ?? '';
    $maxLabel = $f['scaleMaxLabel'] ?? '';
    if (!is_string($minLabel) || mb_strlen($minLabel) > 60) return null;
    if (!is_string($maxLabel) || mb_strlen($maxLabel) > 60) return null;
    $clean['scaleMin'] = $min;
    $clean['scaleMax'] = $max;
    $clean['scaleMinLabel'] = $minLabel;
    $clean['scaleMaxLabel'] = $maxLabel;
  } else if ($type === 'grid_single' || $type === 'grid_multi') {
    $rowsIn = is_array($f['rows'] ?? null) ? $f['rows'] : [];
    if (count($rowsIn) === 0) return null;
    $seenRowIds = [];
    $rows = [];
    foreach ($rowsIn as $r) {
      if (!is_array($r)) return null;
      $rid = $r['id'] ?? '';
      $rlabel = $r['label'] ?? '';
      if (!is_string($rid) || $rid === '' || mb_strlen($rid) > 60 || isset($seenRowIds[$rid])) return null;
      if (!is_string($rlabel) || trim($rlabel) === '' || mb_strlen($rlabel) > 200) return null;
      $seenRowIds[$rid] = true;
      $rows[] = ['id' => $rid, 'label' => trim($rlabel)];
    }
    $clean['rows'] = $rows;
    $cleanOptions = forms_validate_options($f['options'] ?? []);
    if ($cleanOptions === null) return null;
    $clean['options'] = $cleanOptions;
  }

  // Optional conditional-visibility rule: shows this field only when an
  // EARLIER field's answer is one of a fixed value set — see forms.js's
  // formsEarlierDependencyCandidates/formsDependencyMatches for the
  // client-side half, and forms_dependency_hidden below for how a hidden
  // field's own `required` gets exempted on submit.
  if (array_key_exists('dependsOn', $f) && $f['dependsOn'] !== null) {
    $dep = $f['dependsOn'];
    if (!is_array($dep)) return null;
    $depId = $dep['fieldId'] ?? '';
    $depValues = $dep['values'] ?? null;
    // Must already be in $seenIds — i.e. a real, earlier field (a forward
    // or self reference isn't in there yet) — and of a type whose answer
    // is a fixed, matchable token set (see FORMS_DEPENDENCY_CONTROL_TYPES
    // client-side; scenes/rehearsals-sourced select/checkboxes excluded
    // too, since their options only ever resolve live client-side — this
    // server has no stored list to validate dependsOn.values against).
    if (!is_string($depId) || !isset($seenIds[$depId]) || !is_array($seenIds[$depId])) return null;
    $controlling = $seenIds[$depId];
    if (!in_array($controlling['type'], ['select', 'checkboxes', 'scale', 'yesno'], true)) return null;
    if (($controlling['type'] === 'select' || $controlling['type'] === 'checkboxes')
        && ($controlling['optionsSource'] ?? 'manual') !== 'manual') return null;
    if (!is_array($depValues) || count($depValues) === 0 || count($depValues) > 50) return null;
    $allowed = forms_dependency_allowed_values($controlling);
    $cleanValues = [];
    foreach ($depValues as $v) {
      if (!in_array($v, $allowed, true)) return null;
      $cleanValues[] = $v;
    }
    $clean['dependsOn'] = ['fieldId' => $depId, 'values' => $cleanValues];
  }

  $seenIds[$id] = $clean; // patch the placeholder — see this function's own comment above
  return $clean;
}

// The set of raw answer tokens $field (an already-clean FieldSpec) can
// actually produce — mirrors forms.js's own formsDependencyOptionsForField,
// used to validate a dependsOn.values list against whichever earlier field
// it names.
function forms_dependency_allowed_values($field) {
  $type = $field['type'];
  if ($type === 'yesno') return [true, false];
  if ($type === 'scale') {
    $out = [];
    for ($n = $field['scaleMin']; $n <= $field['scaleMax']; $n++) $out[] = $n;
    return $out;
  }
  $out = [];
  foreach (($field['options'] ?? []) as $o) { $out[] = $o['value']; }
  return $out;
}

// True when $dep's condition is NOT met by $answersSoFar (the clean answers
// already processed earlier in field order, by forms_submit's own loop) —
// i.e. this field should be treated as hidden: never required, never
// stored. Mirrors forms.js's own formsDependencyMatches, inverted. Fails
// open (never hides) on a malformed dependsOn, since forms_validate_field_spec
// already guarantees a saved definition's dependsOn is well-formed — this
// only guards against a stored definition older than that guarantee.
function forms_dependency_hidden($dep, $answersSoFar) {
  $fid = $dep['fieldId'] ?? null;
  $values = is_array($dep['values'] ?? null) ? $dep['values'] : [];
  if (!is_string($fid) || count($values) === 0) return false;
  if (!array_key_exists($fid, $answersSoFar)) return true; // controlling question unanswered
  $answer = $answersSoFar[$fid];
  if (is_array($answer)) {
    foreach ($answer as $a) { if (in_array($a, $values, true)) return false; }
    return true;
  }
  return !in_array($answer, $values, true);
}

// Validates + returns a clean Section ({id, title, description, fields}),
// or null on any violation. $seenIds is the SAME map forms_save/
// templates_save thread through every field on the whole form — a field id
// must stay unique across sections too, since a submitted response is still
// one flat {fieldId: value} map regardless of which section asked it.
function forms_validate_section($s, &$seenIds) {
  if (!is_array($s)) return null;
  $id = $s['id'] ?? '';
  $title = $s['title'] ?? '';
  $description = $s['description'] ?? '';
  $fieldsIn = $s['fields'] ?? [];
  if (!is_string($id) || $id === '' || mb_strlen($id) > 60) return null;
  if (!is_string($title) || trim($title) === '' || mb_strlen($title) > 120) return null;
  if (!is_string($description) || mb_strlen($description) > 2000) return null;
  if (!is_array($fieldsIn)) return null;

  $fields = [];
  foreach ($fieldsIn as $f) {
    $clean = forms_validate_field_spec($f, $seenIds);
    if ($clean === null) return null;
    $fields[] = $clean;
  }
  return ['id' => $id, 'title' => trim($title), 'description' => $description, 'fields' => $fields];
}

// Validates one submitted answer for $field. Returns ['ok'=>true,
// 'present'=>bool, 'value'=>...] on success — 'present' is false only for
// an omitted OPTIONAL answer (nothing to store, not an error) — or
// ['ok'=>false] on any violation (required-but-missing, wrong shape, too
// long). A plain null/empty return can't distinguish those two cases for
// yesno (a real answer there IS a bool, including false), hence the
// explicit shape rather than reusing null as a sentinel.
// Deliberately does NOT cross-check select/checkboxes values against the
// field's live scenes/rehearsals options — same posture as budget_submit's
// category validation (see its comment above): rejecting here risks losing
// a submitter's work over a race between page-load and submit; malformed
// answers just land in the response for an admin to notice.
function forms_validate_answer($field, $raw) {
  $type = (string) ($field['type'] ?? '');
  $required = !empty($field['required']);

  if ($type === 'checkboxes') {
    $value = is_array($raw) ? array_values($raw) : [];
    foreach ($value as $v) {
      if (!is_string($v) || mb_strlen($v) > 300) return ['ok' => false];
    }
    if (count($value) === 0) return ['ok' => true, 'present' => false];
    return ['ok' => true, 'present' => true, 'value' => $value];
  }

  if ($type === 'yesno') {
    if ($raw === null) {
      return $required ? ['ok' => false] : ['ok' => true, 'present' => false];
    }
    if (!is_bool($raw)) return ['ok' => false];
    return ['ok' => true, 'present' => true, 'value' => $raw];
  }

  if ($type === 'text' || $type === 'textarea' || $type === 'select') {
    if ($raw !== null && !is_string($raw)) return ['ok' => false];
    $value = is_string($raw) ? trim($raw) : '';
    $maxLen = $type === 'textarea' ? 5000 : 300;
    if (mb_strlen($value) > $maxLen) return ['ok' => false];
    if ($value === '') return ['ok' => true, 'present' => false];
    return ['ok' => true, 'present' => true, 'value' => $value];
  }

  if ($type === 'scale') {
    if ($raw === null) {
      return $required ? ['ok' => false] : ['ok' => true, 'present' => false];
    }
    if (!is_int($raw)) return ['ok' => false];
    $min = is_int($field['scaleMin'] ?? null) ? $field['scaleMin'] : 1;
    $max = is_int($field['scaleMax'] ?? null) ? $field['scaleMax'] : 5;
    if ($raw < $min || $raw > $max) return ['ok' => false];
    return ['ok' => true, 'present' => true, 'value' => $raw];
  }

  if ($type === 'grid_single' || $type === 'grid_multi') {
    $rows = is_array($field['rows'] ?? null) ? $field['rows'] : [];
    $rawMap = is_array($raw) ? $raw : [];
    $value = [];
    $anyPresent = false;
    foreach ($rows as $row) {
      $rid = $row['id'] ?? null;
      if (!is_string($rid) || $rid === '') continue;
      $cell = array_key_exists($rid, $rawMap) ? $rawMap[$rid] : null;
      if ($type === 'grid_single') {
        if ($cell === null || $cell === '') {
          if ($required) return ['ok' => false];
          continue;
        }
        if (!is_string($cell) || mb_strlen($cell) > 300) return ['ok' => false];
        $value[$rid] = $cell;
        $anyPresent = true;
      } else {
        $cellArr = is_array($cell) ? array_values($cell) : [];
        foreach ($cellArr as $v) {
          if (!is_string($v) || mb_strlen($v) > 300) return ['ok' => false];
        }
        if (count($cellArr) === 0) {
          if ($required) return ['ok' => false];
          continue;
        }
        $value[$rid] = $cellArr;
        $anyPresent = true;
      }
    }
    if (!$anyPresent) return ['ok' => true, 'present' => false];
    return ['ok' => true, 'present' => true, 'value' => $value];
  }

  return ['ok' => false]; // unknown field type in a stored definition — reject defensively
}

function forms_list_open($body) {
  $out = [];
  foreach (forms_all_form_ids() as $id) {
    $def = forms_load(forms_form_dir($id) . '/definition.json', null);
    if (!is_array($def) || ($def['status'] ?? null) !== 'open') continue;
    $out[] = [
      'id' => $id,
      'title' => $def['title'] ?? '',
      'description' => $def['description'] ?? '',
      'deadline' => $def['deadline'] ?? null,
      'productionYear' => $def['productionYear'] ?? null,
      // Needed client-side to sort this list the same way Oversigt does
      // (formsCompareOrder) — Oversigt's own drag-and-drop reorder writes
      // this straight into definition.json (forms_reorder).
      'order' => $def['order'] ?? null,
    ];
  }
  respond(200, ['ok' => true, 'forms' => $out]);
}

// Revyst: fetch one OPEN form's schema to render the fill-in view. A closed
// or unknown formId is refused outright — a revyst caller must never be
// able to preview a draft/closed form by guessing its id (that's what
// forms_admin_read is for, boss-level, status-independent).
function forms_get($body) {
  $id = $body['formId'] ?? '';
  if (!forms_valid_id($id)) respond(400, ['error' => 'invalid_shape']);
  $def = forms_load(forms_form_dir($id) . '/definition.json', null);
  if (!is_array($def)) respond(404, ['error' => 'not_found']);
  if (($def['status'] ?? null) !== 'open') respond(403, ['error' => 'form_closed']);
  respond(200, [
    'ok' => true, 'id' => $id,
    'title' => $def['title'] ?? '', 'description' => $def['description'] ?? '',
    'deadline' => $def['deadline'] ?? null, 'fields' => $def['fields'] ?? [],
    'sections' => $def['sections'] ?? [],
  ]);
}

// Revyst appends ONE response — the client never sends/sees the full
// responses list, mirrors budget_submit's append-only shape exactly.
function forms_submit($body) {
  $formId = $body['formId'] ?? '';
  if (!forms_valid_id($formId)) respond(400, ['error' => 'invalid_shape']);
  $def = forms_load(forms_form_dir($formId) . '/definition.json', null);
  if (!is_array($def)) respond(404, ['error' => 'not_found']);
  if (($def['status'] ?? null) !== 'open') respond(409, ['error' => 'form_closed']);

  $answersIn = $body['answers'] ?? null;
  if (!is_array($answersIn)) respond(400, ['error' => 'invalid_shape']);

  $fields = is_array($def['fields'] ?? null) ? $def['fields'] : [];
  foreach ((is_array($def['sections'] ?? null) ? $def['sections'] : []) as $s) {
    if (is_array($s['fields'] ?? null)) $fields = array_merge($fields, $s['fields']);
  }
  $clean = [];
  foreach ($fields as $field) {
    $fid = $field['id'] ?? null;
    if (!is_string($fid) || $fid === '') continue;

    // A field hidden by its own dependsOn (an earlier answer that doesn't
    // match) is skipped entirely — never required, and never trusted even
    // if the client sent something for it anyway, since dependsOn is
    // purely a display rule the server can independently re-derive from
    // the same $clean answers processed so far (see forms_dependency_hidden).
    $dep = $field['dependsOn'] ?? null;
    if (is_array($dep) && forms_dependency_hidden($dep, $clean)) continue;

    $raw = array_key_exists($fid, $answersIn) ? $answersIn[$fid] : null;
    $result = forms_validate_answer($field, $raw);
    if (!$result['ok']) respond(400, ['error' => 'invalid_shape']);
    if (!$result['present']) {
      if (!empty($field['required'])) respond(400, ['error' => 'invalid_shape']);
      continue; // optional & empty/absent — nothing to store
    }
    $clean[$fid] = $result['value'];
  }
  if (count($clean) === 0) respond(400, ['error' => 'empty_response']);

  $id = forms_id();
  forms_mutate(forms_form_dir($formId) . '/responses.json', ['responses' => []], function ($json) use ($id, $clean) {
    if (!isset($json['responses']) || !is_array($json['responses'])) $json['responses'] = [];
    $json['responses'][] = ['id' => $id, 'submittedAt' => date('c'), 'answers' => $clean];
    return $json;
  });
  respond(200, ['ok' => true, 'id' => $id]);
}

// Boss: every form (any status), summary only — response counts are cheap
// to compute at this scale (a handful of forms), keeps the dashboard table
// light without a second round trip per form.
function forms_admin_list($body) {
  $out = [];
  foreach (forms_all_form_ids() as $id) {
    $def = forms_load(forms_form_dir($id) . '/definition.json', null);
    if (!is_array($def)) continue;
    $responses = forms_load(forms_form_dir($id) . '/responses.json', ['responses' => []]);
    $out[] = [
      'id' => $id,
      'title' => $def['title'] ?? '',
      'status' => $def['status'] ?? 'closed',
      'deadline' => $def['deadline'] ?? null,
      'productionYear' => $def['productionYear'] ?? null,
      'visibility' => forms_visibility($def),
      'fieldCount' => count($def['fields'] ?? []),
      'responseCount' => count($responses['responses'] ?? []),
      'updatedAt' => $def['updatedAt'] ?? null,
      'order' => array_key_exists('order', $def) ? $def['order'] : null,
    ];
  }
  respond(200, ['ok' => true, 'forms' => $out]);
}

// Boss: persists Oversigt's drag-and-drop row order. `formIds` is the
// client's own current (year-filtered) view, already in its new order —
// order is only ever compared between forms shown in the same filtered
// table, so this never needs to touch a form from another year. Stamps
// 0..N-1 straight into each form's own definition.json; forms_save (see
// below) carries the existing value through on every future edit so a
// builder save can't silently wipe a manual reorder.
function forms_reorder($body) {
  $formIds = $body['formIds'] ?? null;
  if (!is_array($formIds) || count($formIds) === 0 || count($formIds) > 500) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $seen = [];
  foreach ($formIds as $id) {
    if (!is_string($id) || !forms_valid_id($id) || isset($seen[$id])) respond(400, ['error' => 'invalid_shape']);
    $seen[$id] = true;
    if (!is_file(forms_form_dir($id) . '/definition.json')) respond(404, ['error' => 'not_found']);
  }
  foreach (array_values($formIds) as $index => $id) {
    forms_mutate(forms_form_dir($id) . '/definition.json', [], function ($json) use ($index) {
      if (!is_array($json) || empty($json)) return $json; // shouldn't happen, existence checked above
      $json['order'] = $index;
      return $json;
    });
  }
  respond(200, ['ok' => true]);
}

// A form's Synlighed — 'boss' (default, every management-level visitor can
// see its responses) or 'admin' (responses restricted to admin login only;
// the form's own definition stays boss-editable regardless — see
// forms_admin_read below). Normalizes anything else (missing, or a stale/
// invalid value) back to 'boss', same defensive posture as forms_save's
// own validation.
function forms_visibility($def) {
  $v = $def['visibility'] ?? 'boss';
  return in_array($v, ['boss', 'admin'], true) ? $v : 'boss';
}

// Boss: everything needed to render the management view for one form (full
// definition + every response) in one round trip, mirrors budget_read.
// `$level` is the caller's own resolved level (always 'boss' or 'admin'
// here, per $FORMS_ACTIONS' own boss-minimum gate) — a boss-level caller
// still gets the definition back (so Rediger/the status-toggle chip keep
// working on any form), but `responses` is withheld when the form's own
// Synlighed restricts it to admin, and `responsesRestricted:true` tells the
// client to show that explicitly rather than reading as "no responses yet".
function forms_admin_read($body, $level) {
  $id = $body['formId'] ?? '';
  if (!forms_valid_id($id)) respond(400, ['error' => 'invalid_shape']);
  $def = forms_load(forms_form_dir($id) . '/definition.json', null);
  if (!is_array($def)) respond(404, ['error' => 'not_found']);
  $restricted = forms_visibility($def) === 'admin' && $level !== 'admin';
  $responses = $restricted ? [] : (forms_load(forms_form_dir($id) . '/responses.json', ['responses' => []])['responses'] ?? []);
  respond(200, [
    'ok' => true,
    'definition' => array_merge(['id' => $id], $def),
    'responses' => $responses,
    'responsesRestricted' => $restricted,
  ]);
}

// Boss: create (no id) or update (id given) a form definition — a full
// replace either way, same "resend the whole record" convention as Manus/
// Kalender/Budget categories. Also used to close/reopen a form (client
// resends the current definition with status flipped) and to create a form
// from a template (client clones the template's fields into a fresh draft
// and calls this with no id).
function forms_save($body) {
  $title = $body['title'] ?? '';
  $description = $body['description'] ?? '';
  $status = $body['status'] ?? 'closed';
  $visibility = $body['visibility'] ?? 'boss';
  $deadline = array_key_exists('deadline', $body) ? $body['deadline'] : null;
  $productionYear = array_key_exists('productionYear', $body) ? $body['productionYear'] : null;
  $fromTemplateId = array_key_exists('fromTemplateId', $body) ? $body['fromTemplateId'] : null;
  $fieldsIn = $body['fields'] ?? [];
  $sectionsIn = $body['sections'] ?? [];

  if (!is_string($title) || trim($title) === '' || mb_strlen($title) > 120
      || !is_string($description) || mb_strlen($description) > 2000
      || !in_array($status, ['open', 'closed'], true)
      || !in_array($visibility, ['boss', 'admin'], true)
      // Deadline is a bare date, or a date+time pair (siteCreateDateTimeField's
      // own 'YYYY-MM-DDTHH:MM' shape) — the time half is always optional.
      || ($deadline !== null && (!is_string($deadline) || !preg_match('/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?$/', $deadline)))
      || ($productionYear !== null && !is_int($productionYear))
      || ($fromTemplateId !== null && !forms_valid_id($fromTemplateId))
      || !is_array($fieldsIn) || !is_array($sectionsIn)) {
    respond(400, ['error' => 'invalid_shape']);
  }

  $seenIds = [];
  $fields = [];
  foreach ($fieldsIn as $f) {
    $clean = forms_validate_field_spec($f, $seenIds);
    if ($clean === null) respond(400, ['error' => 'invalid_field']);
    $fields[] = $clean;
  }
  $sections = [];
  foreach ($sectionsIn as $s) {
    $clean = forms_validate_section($s, $seenIds);
    if ($clean === null) respond(400, ['error' => 'invalid_section']);
    $sections[] = $clean;
  }

  $id = $body['id'] ?? null;
  $now = date('c');
  if ($id !== null) {
    if (!is_string($id) || !forms_valid_id($id)) respond(400, ['error' => 'invalid_shape']);
    $existing = forms_load(forms_form_dir($id) . '/definition.json', null);
    if (!is_array($existing)) respond(404, ['error' => 'not_found']);
    $createdAt = $existing['createdAt'] ?? $now;
    // Oversigt's own drag-and-drop reorder (forms_reorder) is the only
    // writer of this field — carry it through unchanged on every ordinary
    // edit save, or a Rediger click on the builder would silently wipe it.
    $order = array_key_exists('order', $existing) ? $existing['order'] : null;
  } else {
    $id = forms_id();
    $createdAt = $now;
    $order = null; // unordered — sorts after every manually-ordered form, in creation order
  }

  $definition = [
    'title' => trim($title),
    'description' => $description,
    'status' => $status,
    'visibility' => $visibility,
    'deadline' => $deadline,
    'productionYear' => $productionYear,
    'fromTemplateId' => $fromTemplateId,
    'fields' => $fields,
    'sections' => $sections,
    'createdAt' => $createdAt,
    'updatedAt' => $now,
    'order' => $order,
  ];

  $formDir = forms_form_dir($id);
  forms_ensure_dir($formDir);
  if (@file_put_contents($formDir . '/definition.json',
      json_encode($definition, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n") === false) {
    respond(500, ['error' => 'forms_storage_unavailable']);
  }
  if (!is_file($formDir . '/responses.json')) {
    @file_put_contents($formDir . '/responses.json', json_encode(['responses' => []], JSON_PRETTY_PRINT) . "\n");
  }

  respond(200, ['ok' => true, 'id' => $id, 'definition' => array_merge(['id' => $id], $definition)]);
}

// Boss: permanently deletes a form — its definition AND every response.
// Cannot be undone; no server-side confirmation, same posture as
// budget_delete_year (client's job).
function forms_delete($body) {
  $id = $body['formId'] ?? '';
  if (!forms_valid_id($id)) respond(400, ['error' => 'invalid_shape']);
  $dir = forms_form_dir($id);
  if (!is_dir($dir)) respond(404, ['error' => 'not_found']);
  budget_rrmdir($dir); // generic recursive delete, not budget-specific despite the name
  respond(200, ['ok' => true]);
}

// Boss: remove exactly ONE response from a form (as opposed to forms_delete,
// which removes the whole form + every response) — lets a boss clear out
// individual test/junk submissions, and is also how a form with responses
// becomes editable again (the builder locks question/section editing while
// responseCount > 0, see formsRenderBuilderScreen).
function forms_delete_response($body) {
  $formId = $body['formId'] ?? '';
  if (!forms_valid_id($formId)) respond(400, ['error' => 'invalid_shape']);
  $responseId = $body['responseId'] ?? '';
  if (!forms_valid_id($responseId)) respond(400, ['error' => 'invalid_shape']);
  $dir = forms_form_dir($formId);
  if (!is_dir($dir)) respond(404, ['error' => 'not_found']);
  forms_mutate($dir . '/responses.json', ['responses' => []], function ($json) use ($responseId) {
    $list = is_array($json['responses'] ?? null) ? $json['responses'] : [];
    $json['responses'] = array_values(array_filter($list, function ($r) use ($responseId) {
      return ($r['id'] ?? null) !== $responseId;
    }));
    return $json;
  });
  respond(200, ['ok' => true]);
}

function templates_list($body) {
  $json = forms_load(forms_templates_path(), ['templates' => []]);
  respond(200, ['ok' => true, 'templates' => $json['templates'] ?? []]);
}

// Boss: create (no id) or update (id given) a reusable template — same
// full-replace convention as forms_save.
function templates_save($body) {
  $title = $body['title'] ?? '';
  $description = $body['description'] ?? '';
  $fieldsIn = $body['fields'] ?? [];
  $sectionsIn = $body['sections'] ?? [];
  if (!is_string($title) || trim($title) === '' || mb_strlen($title) > 120
      || !is_string($description) || mb_strlen($description) > 2000
      || !is_array($fieldsIn) || !is_array($sectionsIn)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $seenIds = [];
  $fields = [];
  foreach ($fieldsIn as $f) {
    $clean = forms_validate_field_spec($f, $seenIds);
    if ($clean === null) respond(400, ['error' => 'invalid_field']);
    $fields[] = $clean;
  }
  $sections = [];
  foreach ($sectionsIn as $s) {
    $clean = forms_validate_section($s, $seenIds);
    if ($clean === null) respond(400, ['error' => 'invalid_section']);
    $sections[] = $clean;
  }

  $id = $body['id'] ?? null;
  if ($id !== null && (!is_string($id) || !forms_valid_id($id))) respond(400, ['error' => 'invalid_shape']);

  $now = date('c');
  $newId = $id;
  $notFound = false;
  forms_mutate(forms_templates_path(), ['templates' => []],
    function ($json) use ($id, $title, $description, $fields, $sections, $now, &$newId, &$notFound) {
      if (!isset($json['templates']) || !is_array($json['templates'])) $json['templates'] = [];
      if ($id !== null) {
        $found = false;
        foreach ($json['templates'] as &$t) {
          if (($t['id'] ?? null) === $id) {
            $t['title'] = trim($title);
            $t['description'] = $description;
            $t['fields'] = $fields;
            $t['sections'] = $sections;
            $t['updatedAt'] = $now;
            $found = true;
            break;
          }
        }
        unset($t);
        if (!$found) $notFound = true;
      } else {
        $newId = forms_id();
        $json['templates'][] = [
          'id' => $newId, 'title' => trim($title), 'description' => $description,
          'fields' => $fields, 'sections' => $sections, 'createdAt' => $now, 'updatedAt' => $now,
        ];
      }
      return $json;
    });
  if ($notFound) respond(404, ['error' => 'not_found']);
  respond(200, ['ok' => true, 'id' => $newId]);
}

function templates_delete($body) {
  $id = $body['id'] ?? '';
  if (!forms_valid_id($id)) respond(400, ['error' => 'invalid_shape']);
  $found = false;
  forms_mutate(forms_templates_path(), ['templates' => []], function ($json) use ($id, &$found) {
    $keep = [];
    foreach (($json['templates'] ?? []) as $t) {
      if (($t['id'] ?? null) === $id) { $found = true; continue; }
      $keep[] = $t;
    }
    $json['templates'] = $keep;
    return $json;
  });
  if (!$found) respond(404, ['error' => 'not_found']);
  respond(200, ['ok' => true]);
}

function handle_forms($action, $body, $level) {
  switch ($action) {
    case 'forms_list_open':  return forms_list_open($body);
    case 'forms_get':        return forms_get($body);
    case 'forms_submit':     return forms_submit($body);
    case 'forms_admin_list': return forms_admin_list($body);
    case 'forms_admin_read': return forms_admin_read($body, $level);
    case 'forms_save':       return forms_save($body);
    case 'forms_reorder':    return forms_reorder($body);
    case 'forms_delete':     return forms_delete($body);
    case 'forms_delete_response': return forms_delete_response($body);
    case 'templates_list':   return templates_list($body);
    case 'templates_save':   return templates_save($body);
    case 'templates_delete': return templates_delete($body);
  }
  respond(400, ['error' => 'unknown_action']);
}

// ── Fællesspisning datastore (private Simply.com store, same posture as Budget/Forms) ──
// Communal-meal rehearsal-day sign-up sheet. A single JSON document lives
// under FAELLESSPISNING_DATA_DIR — never the public repo, since rows carry
// names and food preferences. Unlike Forms/Sheets (many documents, one per
// form/sheet) there is exactly one document total — no manifest, no id
// routing — so every action just opens the same fixed path. Optionally
// `connection`-ed to one Formularer form (see faelles_save_connection/
// faelles_sync_connection below) — once connected, every faelles_read
// lazily pulls in any new responses, so a boss never has to manually
// re-import.

function faelles_dir() {
  if (!defined('FAELLESSPISNING_DATA_DIR') || !is_string(FAELLESSPISNING_DATA_DIR) || FAELLESSPISNING_DATA_DIR === '') {
    respond(500, ['error' => 'faellesspisning_not_configured']);
  }
  return rtrim(FAELLESSPISNING_DATA_DIR, '/');
}

function faelles_ensure_dir($dir) {
  if (!is_dir($dir) && !@mkdir($dir, 0775, true) && !is_dir($dir)) {
    respond(500, ['error' => 'faellesspisning_storage_unavailable']);
  }
}

function faelles_doc_path() {
  return faelles_dir() . '/faellesspisning.json';
}

function faelles_default_doc() {
  return ['rows' => [], 'connection' => null, 'extraDays' => [], 'hiddenDays' => [], 'updatedAt' => null];
}

// A document written before extraDays/hiddenDays existed has no such key —
// back-fill rather than migrate on disk, same posture as
// budget_normalize_years_shape.
function faelles_extra_days($doc) {
  return (isset($doc['extraDays']) && is_array($doc['extraDays'])) ? $doc['extraDays'] : [];
}

// Ids of calendar-sourced day columns hidden from this sheet only — the
// real data/calendar.json event is never touched (see faelles_hide_day).
function faelles_hidden_days($doc) {
  return (isset($doc['hiddenDays']) && is_array($doc['hiddenDays'])) ? $doc['hiddenDays'] : [];
}

// Read-only load, no lock — matches forms_get's own plain-read convention;
// a reader racing an in-flight write sees either the old or the new file,
// never a torn one (the writer always replaces the full content of an
// already-open fd under an exclusive lock, not in place).
function faelles_load() {
  $path = faelles_doc_path();
  if (!is_file($path)) return faelles_default_doc();
  $doc = json_decode((string) file_get_contents($path), true);
  return is_array($doc) ? $doc : faelles_default_doc();
}

// rowId is always a server-generated hex string (see faelles_id()).
function faelles_valid_id($id) {
  return is_string($id) && $id !== '' && preg_match('/^[0-9a-f]+$/', $id) === 1;
}

function faelles_id() {
  return dechex(time()) . bin2hex(random_bytes(4));
}

// Flock'd read-modify-write against the single document — safe against
// concurrent revyst edits to different rows, unlike a whole-document
// replace (the pattern Ark/Sheets used, and specifically why this feature
// isn't just a copy of it: many revyster toggle different rows at once).
function faelles_mutate($mutate) {
  $dir = faelles_dir();
  faelles_ensure_dir($dir);
  $path = faelles_doc_path();
  $fh = @fopen($path, 'c+');
  if (!$fh || !flock($fh, LOCK_EX)) {
    if ($fh) fclose($fh);
    respond(500, ['error' => 'faellesspisning_storage_unavailable']);
  }
  $raw = stream_get_contents($fh);
  $doc = ($raw === '' || $raw === false) ? faelles_default_doc() : json_decode($raw, true);
  if (!is_array($doc)) $doc = faelles_default_doc();
  $doc = $mutate($doc);
  rewind($fh);
  ftruncate($fh, 0);
  fwrite($fh, json_encode($doc, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . "\n");
  fflush($fh);
  flock($fh, LOCK_UN);
  fclose($fh);
  return $doc;
}

// Fixed shape — just Navn (required) and Madforbehold (optional), no more
// boss-configurable extra fields (there used to be an extra-field editor
// here; the sheet never needed more than these two, so it's gone).
function faelles_validate_answers($answersIn) {
  if (!is_array($answersIn)) return null;
  foreach ($answersIn as $key => $_) {
    if ($key !== 'navn' && $key !== 'madforbehold') return null;
  }
  $navn = $answersIn['navn'] ?? '';
  $madforbehold = $answersIn['madforbehold'] ?? '';
  if (!is_string($navn) || trim($navn) === '' || mb_strlen($navn) > 120) return null;
  if (!is_string($madforbehold) || mb_strlen($madforbehold) > 500) return null;
  return ['navn' => $navn, 'madforbehold' => $madforbehold];
}

// Opt-out model: a day column defaults to checked (attending) for a row
// once that row's own createdAt date has passed, and unchecked before it —
// `dayOverrides` ({dayId: bool}) holds only the explicit deviations from
// that default (an opted-out future day, or a manually opted-in day
// predating the row), so a brand-new/legacy row with no overrides at all
// is exactly "everyone auto-signed-up from the day they filled out the
// form," with no migration needed for rows that predate this field. No
// cross-check against CALENDAR_DATA (which day ids currently exist) — same
// "don't validate against a live external list" posture as
// forms_submit/budget_submit, since rejecting risks losing a submitter's
// work over a race between page-load and submit.
//
// A key is checked via its string form, not is_string($key) — PHP coerces
// a purely-numeric array key (e.g. a day id that happens to look like
// "123") to an int, which is_string() would then wrongly reject.
function faelles_validate_day_overrides($overridesIn) {
  if (!is_array($overridesIn)) return null;
  $overrides = [];
  $count = 0;
  foreach ($overridesIn as $key => $value) {
    $keyStr = (string) $key;
    if ($keyStr === '' || mb_strlen($keyStr) > 80) return null;
    if (!is_bool($value)) return null;
    $overrides[$keyStr] = $value;
    if (++$count > 100) return null;
  }
  return $overrides;
}

// Always JSON-object-shaped on the wire (even empty/all-numeric-keyed),
// never a JSON array — json_encode only emits an object for an array with
// non-sequential-int keys, so an empty override map, or one that happens
// to land on keys "0","1",..., would otherwise silently serialize as `[]`.
function faelles_overrides_for_json($overrides) {
  return (object) $overrides;
}

// title/date for a Fællesspisning-only day column (faelles_add_day).
function faelles_validate_extra_day($body) {
  $title = $body['title'] ?? '';
  $date = $body['date'] ?? '';
  if (!is_string($title) || trim($title) === '' || mb_strlen($title) > 120) return null;
  if (!is_string($date) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) !== 1) return null;
  return ['title' => trim($title), 'date' => $date];
}

// Stringifies a Forms answer value regardless of field type — plain text
// for text/textarea/select, comma-joined for checkboxes/grid_multi,
// Ja/Nej for yesno, etc. — so a connection can map Navn/Madforbehold to
// any Forms field type and still get a sensible string instead of an
// array or the literal word "Array" being stored.
function faelles_forms_answer_to_text($value) {
  if ($value === null) return '';
  if (is_string($value)) return trim($value);
  if (is_bool($value)) return $value ? 'Ja' : 'Nej';
  if (is_int($value) || is_float($value)) return (string) $value;
  if (is_array($value)) {
    $parts = [];
    foreach ($value as $v) {
      $t = faelles_forms_answer_to_text($v);
      if ($t !== '') $parts[] = $t;
    }
    return implode(', ', $parts);
  }
  return '';
}

// Validates a `faelles_save_connection` body. `formId: null` (or omitted)
// means "disconnect" — distinct from a malformed connection request,
// which is rejected outright. `formId` is validated with Forms' own
// forms_valid_id() since it's actually used to build a filesystem path
// (forms_form_dir) during sync — same path-traversal-guard reasoning as
// Forms' own internal use of that regex.
function faelles_validate_connection($body) {
  $formId = array_key_exists('formId', $body) ? $body['formId'] : null;
  if ($formId === null) return ['disconnect' => true];
  if (!is_string($formId) || !forms_valid_id($formId)) return null;
  $navnFieldId = $body['navnFieldId'] ?? '';
  $madforboholdFieldId = $body['madforboholdFieldId'] ?? '';
  if (!is_string($navnFieldId) || $navnFieldId === '' || mb_strlen($navnFieldId) > 80) return null;
  if (!is_string($madforboholdFieldId) || $madforboholdFieldId === '' || mb_strlen($madforboholdFieldId) > 80) return null;
  $formTitle = $body['formTitle'] ?? '';
  if (!is_string($formTitle)) $formTitle = '';
  return ['disconnect' => false, 'connection' => [
    'formId' => $formId,
    'navnFieldId' => $navnFieldId,
    'madforboholdFieldId' => $madforboholdFieldId,
    'formTitle' => mb_substr(trim($formTitle), 0, 200),
    'syncedCount' => 0,
  ]];
}

// Pulls every response from the connected form and upserts it into rows —
// a response already synced before (tracked via each row's own
// `source: {formId, responseId}`) is updated in place, never duplicated.
// Always runs inside faelles_mutate(), so it's safe against a concurrent
// grid edit. Deliberately never removes/un-syncs a row if its response is
// no longer returned by the form (Forms has no per-response delete today
// anyway) — this is a one-way "the form is the source of truth for these
// rows" sync, not a full reconciliation; a row a boss deleted by hand
// will reappear on the next sync as long as the response still exists,
// same trade-off the old one-shot import made.
function faelles_sync_connection($connection) {
  return faelles_mutate(function ($doc) use ($connection) {
    $formId = $connection['formId'] ?? '';
    if (!forms_valid_id($formId)) return $doc;
    $navnFieldId = $connection['navnFieldId'] ?? '';
    $madforboholdFieldId = $connection['madforboholdFieldId'] ?? '';
    $responsesDoc = forms_load(forms_form_dir($formId) . '/responses.json', ['responses' => []]);
    $responses = is_array($responsesDoc['responses'] ?? null) ? $responsesDoc['responses'] : [];

    $bySource = [];
    foreach ($doc['rows'] as $idx => $row) {
      if (isset($row['source']['formId'], $row['source']['responseId']) && $row['source']['formId'] === $formId) {
        $bySource[$row['source']['responseId']] = $idx;
      }
    }

    $now = date('c');
    foreach ($responses as $resp) {
      $rid = $resp['id'] ?? null;
      if (!is_string($rid) || $rid === '') continue;
      $answers = is_array($resp['answers'] ?? null) ? $resp['answers'] : [];
      $navn = trim(faelles_forms_answer_to_text($answers[$navnFieldId] ?? null));
      if ($navn === '') continue; // nothing meaningful to sync for this response
      $madforbehold = faelles_forms_answer_to_text($answers[$madforboholdFieldId] ?? null);
      if (isset($bySource[$rid])) {
        $idx = $bySource[$rid];
        if ($doc['rows'][$idx]['answers']['navn'] !== $navn || $doc['rows'][$idx]['answers']['madforbehold'] !== $madforbehold) {
          $doc['rows'][$idx]['answers']['navn'] = $navn;
          $doc['rows'][$idx]['answers']['madforbehold'] = $madforbehold;
          $doc['rows'][$idx]['updatedAt'] = $now;
        }
      } else {
        $doc['rows'][] = [
          'id' => faelles_id(),
          'answers' => ['navn' => $navn, 'madforbehold' => $madforbehold],
          'dayOverrides' => faelles_overrides_for_json([]),
          'source' => ['formId' => $formId, 'responseId' => $rid],
          'createdAt' => $now,
          'updatedAt' => $now,
        ];
      }
    }

    $connection['syncedCount'] = count($responses);
    $doc['connection'] = $connection;
    $doc['updatedAt'] = $now;
    return $doc;
  });
}

// Cheap pre-check (no lock) so an ordinary page view doesn't pay for a
// flock'd write when there's nothing new to sync — only calls
// faelles_sync_connection() (which re-reads under the lock and does the
// real per-response reconciliation) when the connected form's response
// count has moved since the last sync.
function faelles_maybe_sync($doc) {
  $connection = $doc['connection'] ?? null;
  if (!is_array($connection) || !forms_valid_id($connection['formId'] ?? '')) return $doc;
  $responsesDoc = forms_load(forms_form_dir($connection['formId']) . '/responses.json', ['responses' => []]);
  $respCount = count(is_array($responsesDoc['responses'] ?? null) ? $responsesDoc['responses'] : []);
  $syncedCount = is_int($connection['syncedCount'] ?? null) ? $connection['syncedCount'] : -1;
  if ($respCount === $syncedCount) return $doc;
  return faelles_sync_connection($connection);
}

// Revyst: also lazily syncs a connected form's responses (see
// faelles_maybe_sync) — so simply opening the page is what makes "every
// new response gets written to the sheet" automatic, no manual re-import
// button anywhere in the normal flow.
function faelles_read($body) {
  $doc = faelles_load();
  $doc = faelles_maybe_sync($doc);
  respond(200, ['ok' => true, 'rows' => $doc['rows'], 'connection' => $doc['connection'], 'extraDays' => faelles_extra_days($doc), 'hiddenDays' => faelles_hidden_days($doc), 'updatedAt' => $doc['updatedAt']]);
}

// Revyst: create (no rowId) or update (rowId given) one row from an
// ordinary grid edit. `answers` is merged onto the existing row's answers
// (only overwriting keys actually sent), `dayOverrides` is a full replace —
// a checkbox handler always has the complete current override map on hand,
// so that's safe. A row created/refreshed by a connected form goes through
// faelles_sync_connection() instead, which writes rows directly (see
// there for why `source` tagging happens there, not here). `createdAt` is
// left untouched on an update — it's the row's own "day they filled out
// the form," the anchor the opt-out default is computed from client-side,
// and must never move just because an existing row was edited later.
function faelles_upsert_row($body) {
  $rowId = $body['rowId'] ?? null;
  if ($rowId !== null && (!is_string($rowId) || !faelles_valid_id($rowId))) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $answers = faelles_validate_answers($body['answers'] ?? []);
  $overrides = faelles_validate_day_overrides($body['dayOverrides'] ?? []);
  if ($answers === null || $overrides === null) respond(400, ['error' => 'invalid_shape']);

  $savedRow = null;
  $doc = faelles_mutate(function ($doc) use ($rowId, $answers, $overrides, &$savedRow) {
    $now = date('c');
    $found = false;
    foreach ($doc['rows'] as &$row) {
      if ($rowId !== null && $row['id'] === $rowId) {
        $row['answers'] = array_merge($row['answers'], $answers);
        $row['dayOverrides'] = faelles_overrides_for_json($overrides);
        $row['updatedAt'] = $now;
        $savedRow = $row;
        $found = true;
        break;
      }
    }
    unset($row);
    if ($rowId !== null && !$found) respond(404, ['error' => 'not_found']);
    if ($rowId === null) {
      $savedRow = [
        'id' => faelles_id(),
        'answers' => $answers,
        'dayOverrides' => faelles_overrides_for_json($overrides),
        'createdAt' => $now,
        'updatedAt' => $now,
      ];
      $doc['rows'][] = $savedRow;
    }
    $doc['updatedAt'] = $now;
    return $doc;
  });
  respond(200, ['ok' => true, 'row' => $savedRow, 'updatedAt' => $doc['updatedAt']]);
}

// Revyst, fully open (any row, not just one's own — matches the "plain
// shared spreadsheet" model). Idempotent: still {ok:true} if already gone,
// since two people deleting the same stale row is a realistic race here.
function faelles_delete_row($body) {
  $rowId = $body['rowId'] ?? '';
  if (!faelles_valid_id($rowId)) respond(400, ['error' => 'invalid_shape']);
  faelles_mutate(function ($doc) use ($rowId) {
    $doc['rows'] = array_values(array_filter($doc['rows'], function ($r) use ($rowId) {
      return $r['id'] !== $rowId;
    }));
    $doc['updatedAt'] = date('c');
    return $doc;
  });
  respond(200, ['ok' => true]);
}

// Boss: connect (formId given) or disconnect (formId: null) a Formularer
// form. Connecting immediately runs faelles_sync_connection() so existing
// responses land right away, not just on the next faelles_read.
// Disconnecting only clears `connection` — rows already synced in stay,
// since deleting them would be a surprising side effect of what reads as
// a purely forward-looking "stop syncing" action.
function faelles_save_connection($body) {
  $clean = faelles_validate_connection($body);
  if ($clean === null) respond(400, ['error' => 'invalid_shape']);

  if (!empty($clean['disconnect'])) {
    $doc = faelles_mutate(function ($doc) {
      $doc['connection'] = null;
      $doc['updatedAt'] = date('c');
      return $doc;
    });
    respond(200, ['ok' => true, 'connection' => null, 'rows' => $doc['rows'], 'updatedAt' => $doc['updatedAt']]);
  }

  $doc = faelles_mutate(function ($doc) use ($clean) {
    $doc['connection'] = $clean['connection'];
    $doc['updatedAt'] = date('c');
    return $doc;
  });
  $doc = faelles_sync_connection($doc['connection']);
  respond(200, ['ok' => true, 'connection' => $doc['connection'], 'rows' => $doc['rows'], 'updatedAt' => $doc['updatedAt']]);
}

// Boss: adds a Fællesspisning-only day column — never written to the
// public `calendar` resource (see the "+" button's own comment in
// faellesspisning.js), so this does NOT create a Kalender event.
function faelles_add_day($body) {
  $clean = faelles_validate_extra_day($body);
  if ($clean === null) respond(400, ['error' => 'invalid_shape']);
  $day = null;
  $doc = faelles_mutate(function ($doc) use ($clean, &$day) {
    $doc['extraDays'] = faelles_extra_days($doc);
    $day = ['id' => faelles_id(), 'date' => $clean['date'], 'title' => $clean['title']];
    $doc['extraDays'][] = $day;
    $doc['updatedAt'] = date('c');
    return $doc;
  });
  respond(200, ['ok' => true, 'day' => $day, 'extraDays' => $doc['extraDays'], 'updatedAt' => $doc['updatedAt']]);
}

// Boss: removes a Fællesspisning-only day column — the only way to
// correct a mistaken add, since it was never written to Kalender. Any
// row's `dayOverrides` entry referencing it is left alone (same "don't
// cross-validate against the live day-id list" posture as
// faelles_validate_day_overrides) — it just becomes an orphaned, invisible
// id until that row is next edited.
function faelles_delete_day($body) {
  $dayId = $body['dayId'] ?? '';
  if (!faelles_valid_id($dayId)) respond(400, ['error' => 'invalid_shape']);
  $doc = faelles_mutate(function ($doc) use ($dayId) {
    $doc['extraDays'] = array_values(array_filter(faelles_extra_days($doc), function ($d) use ($dayId) {
      return $d['id'] !== $dayId;
    }));
    $doc['updatedAt'] = date('c');
    return $doc;
  });
  respond(200, ['ok' => true, 'extraDays' => $doc['extraDays'], 'updatedAt' => $doc['updatedAt']]);
}

// Boss: hides a real (calendar-sourced) day column from just this sheet —
// data/calendar.json, and Kalender's own display of the event, are left
// completely untouched, only this document's own `hiddenDays` gains the
// id. Not a `faelles_valid_id()` hex string like a row/extra-day id — a
// calendar event's id comes from calendar.js's own generator (arbitrary
// alphanumeric), so this just bounds it as a plain non-empty string, same
// posture as faelles_validate_day_overrides. No cross-check against which day ids
// currently exist in the calendar either — a stale/already-removed id is
// harmless to hide, same "don't validate against a live external list"
// posture used throughout this file.
function faelles_hide_day($body) {
  $dayId = $body['dayId'] ?? '';
  if (!is_string($dayId) || $dayId === '' || mb_strlen($dayId) > 80) respond(400, ['error' => 'invalid_shape']);
  $doc = faelles_mutate(function ($doc) use ($dayId) {
    $doc['hiddenDays'] = faelles_hidden_days($doc);
    if (!in_array($dayId, $doc['hiddenDays'], true)) $doc['hiddenDays'][] = $dayId;
    $doc['updatedAt'] = date('c');
    return $doc;
  });
  respond(200, ['ok' => true, 'hiddenDays' => $doc['hiddenDays'], 'updatedAt' => $doc['updatedAt']]);
}

function handle_faelles($action, $body) {
  switch ($action) {
    case 'faelles_read':            return faelles_read($body);
    case 'faelles_upsert_row':      return faelles_upsert_row($body);
    case 'faelles_delete_row':      return faelles_delete_row($body);
    case 'faelles_save_connection': return faelles_save_connection($body);
    case 'faelles_add_day':         return faelles_add_day($body);
    case 'faelles_delete_day':      return faelles_delete_day($body);
    case 'faelles_hide_day':        return faelles_hide_day($body);
  }
  respond(400, ['error' => 'unknown_action']);
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
// `published` (optional bool, defaults to not-published if omitted) gates
// whether a revyst-level visitor can open the chapter — see wiki.js.
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
    if (isset($c['published']) && !is_bool($c['published'])) {
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

// Admin-only site-wide settings, each sent independently and only applied
// when its key is present in the payload — a Koordinator toggle save must
// not silently wipe currentProductionFolder (and vice versa), since
// update_file() only merges what this callback actually touches.
//
// currentProductionFolder: which archive/MatRevy_<year> folder is the
// active production, used server-side (never a client-supplied value) as the
// base of every path manuscripts_create/manuscripts_sync_selection build.
// There's no real "current season" concept yet (see matrevy-plan.md's
// Phase 13) — this is a small, deliberately minimal stand-in, set by hand
// once per production cycle via the Manus page.
//
// pdfLinksVisibleToRevyst: whether manus.js's PDF quick-links box
// (renderManusPdfLinksSection) is shown to plain revyst-level visitors —
// boss/admin always see it regardless. Off by default each production cycle
// (koordCloseYear resets it) so a coordinator can proof freshly generated
// PDFs before revealing them; flipped from Koordinator's own toggle.
function save_config($payload) {
  $hasFolder = array_key_exists('currentProductionFolder', $payload);
  $folder = $payload['currentProductionFolder'] ?? '';
  if ($hasFolder && (!is_string($folder) || ($folder !== '' && !preg_match('#^[A-Za-z0-9_-]+$#', $folder)))) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $hasPdfFlag = array_key_exists('pdfLinksVisibleToRevyst', $payload);
  $pdfFlag = $payload['pdfLinksVisibleToRevyst'] ?? false;
  if ($hasPdfFlag && !is_bool($pdfFlag)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  if (!$hasFolder && !$hasPdfFlag) {
    respond(400, ['error' => 'invalid_shape']);
  }
  update_file('data/config.json', function ($json) use ($hasFolder, $folder, $hasPdfFlag, $pdfFlag) {
    if ($hasFolder) $json['currentProductionFolder'] = $folder;
    if ($hasPdfFlag) $json['pdfLinksVisibleToRevyst'] = $pdfFlag;
    return $json;
  }, 'Opdater config.json');
}

// Boss/admin: full-array replace of the Program tab's content (Manus page)
// — Medvirkende and Ordliste (each a single raw-LaTeX string, edited as a
// plain textarea exactly like scenes.json's scriptBody — see
// js/manus.js's renderProgramMedvirkendeSection/renderProgramOrdlisteSection)
// plus QR-codes ({label, url}), feeding archive/<folder>/Program.pdf
// (scripts/generate-pdfs.js's buildProgramTex). Unlike scenes.json's own
// scriptBody/name/melody though, medvirkende/ordliste here are boss-typed
// through this tab rather than pre-authored in a .tex upload, but the
// escaping convention is the same: both are inserted into the .tex verbatim,
// un-texEscape()'d (see buildProgramTex's own comment). Only a length cap is
// checked here, same posture as save_wiki's body. `qrCodes[].label`/`.url`
// stay plain admin-typed text (always texEscape()'d) since those aren't
// LaTeX — `url` is loosely checked to look like an http(s) link (not a hard
// requirement of the PDF pipeline, just a sanity check against an obviously
// wrong value — the actual QR image is generated from whatever string is
// here regardless).
function save_program($payload) {
  $medvirkende = $payload['medvirkende'] ?? null;
  $ordliste    = $payload['ordliste'] ?? null;
  $qrCodes     = $payload['qrCodes'] ?? null;
  if (!is_string($medvirkende) || mb_strlen($medvirkende) > 50000
      || !is_string($ordliste) || mb_strlen($ordliste) > 50000
      || !is_array($qrCodes)) {
    respond(400, ['error' => 'invalid_shape']);
  }

  $seenQrId = [];
  foreach ($qrCodes as $q) {
    if (!is_array($q)
        || !isset($q['id'], $q['label'], $q['url'])
        || !is_string($q['id']) || $q['id'] === '' || isset($seenQrId[$q['id']])
        || !is_string($q['label']) || trim($q['label']) === '' || mb_strlen($q['label']) > 200
        || !is_string($q['url']) || mb_strlen($q['url']) > 500
        || ($q['url'] !== '' && !preg_match('#^https?://#i', $q['url']))) {
      respond(400, ['error' => 'invalid_program_shape']);
    }
    $seenQrId[$q['id']] = true;
  }

  update_file('data/program.json', function ($json) use ($medvirkende, $ordliste, $qrCodes) {
    $json['medvirkende'] = $medvirkende;
    $json['ordliste'] = $ordliste;
    $json['qrCodes'] = $qrCodes;
    return $json;
  }, 'Opdater program.json via Manus');
}

// Admin-only (Koordinator page is admin-gated, same rank as archive/config):
// full-array replace of every Masterplan checklist "plan" (one per
// production year, e.g. "MatRevy 2026" — js/koordinator.js's own
// masterplanViewId/plan picker lets the admin switch which one is being
// viewed/edited, mirroring Arkiv's year picker in spirit). Each plan has a
// fixed set of 5 tabs (Blok 4 / August / Blok 1 / Revyen / Efter revyen,
// keyed by js/koordinator.js's own KOORD_MP_TABS list), each an ordered
// flat list of rows mixing two kinds: a "group" divider (just a title, may
// be empty — mirrors the source spreadsheet's blank/labelled blue section
// rows) and a "task" (Emne/To do/Beskrivelse/two freeform Ansvar fields/a
// Status enum). The two Ansvar columns ("Ansvarlig sidste revy"/
// "Ansvarlig") are fixed UI labels, not per-plan data — js/koordinator.js's
// "+ Tilføj" copies a new plan forward from the previous one, shifting each
// task's ansvarB into ansvarA and clearing ansvarB/status for the new cycle.
define('MASTERPLAN_TAB_KEYS', ['blok4', 'august', 'blok1', 'revyen', 'efterrevyen']);
define('MASTERPLAN_STATUSES', ['', 'mangler', 'igang', 'faerdig']);

function save_masterplan($payload) {
  $plans = $payload['plans'] ?? null;
  if (!is_array($plans)) {
    respond(400, ['error' => 'invalid_masterplan_shape']);
  }

  $seenPlanId = [];
  foreach ($plans as $plan) {
    if (!is_array($plan)
        || !isset($plan['id'], $plan['year'], $plan['label'], $plan['tabs'])
        || !is_string($plan['id']) || !preg_match('#^[A-Za-z0-9_-]+$#', $plan['id'])
        || isset($seenPlanId[$plan['id']])
        || !is_int($plan['year']) || $plan['year'] < 1900 || $plan['year'] > 2100
        || !is_string($plan['label']) || trim($plan['label']) === '' || mb_strlen($plan['label']) > 100) {
      respond(400, ['error' => 'invalid_masterplan_shape']);
    }
    $seenPlanId[$plan['id']] = true;

    $tabs = $plan['tabs'];
    if (!is_array($tabs) || array_keys($tabs) !== MASTERPLAN_TAB_KEYS) {
      respond(400, ['error' => 'invalid_masterplan_shape']);
    }

    // Row ids only need to be unique within their own plan — the client
    // never needs to address a row across plans.
    $seenRowId = [];
    foreach ($tabs as $rows) {
      if (!is_array($rows)) {
        respond(400, ['error' => 'invalid_masterplan_shape']);
      }
      foreach ($rows as $r) {
        if (!is_array($r)
            || !isset($r['id'], $r['type'])
            || !is_string($r['id']) || $r['id'] === ''
            || isset($seenRowId[$r['id']])
            || !is_string($r['type']) || !in_array($r['type'], ['group', 'task'], true)) {
          respond(400, ['error' => 'invalid_masterplan_shape']);
        }
        $seenRowId[$r['id']] = true;

        if ($r['type'] === 'group') {
          if (!isset($r['title']) || !is_string($r['title']) || mb_strlen($r['title']) > 200) {
            respond(400, ['error' => 'invalid_masterplan_shape']);
          }
          continue;
        }

        // 'task'
        if (!isset($r['emne'], $r['todo'], $r['beskrivelse'], $r['ansvarA'], $r['ansvarB'], $r['status'])
            || !is_string($r['emne']) || mb_strlen($r['emne']) > 200
            || !is_string($r['todo']) || mb_strlen($r['todo']) > 200
            || !is_string($r['beskrivelse']) || mb_strlen($r['beskrivelse']) > 2000
            || !is_string($r['ansvarA']) || mb_strlen($r['ansvarA']) > 100
            || !is_string($r['ansvarB']) || mb_strlen($r['ansvarB']) > 100
            || !is_string($r['status']) || !in_array($r['status'], MASTERPLAN_STATUSES, true)) {
          respond(400, ['error' => 'invalid_masterplan_shape']);
        }
      }
    }
  }

  update_file('data/masterplan.json', function ($json) use ($plans) {
    $json['plans'] = $plans;
    return $json;
  }, 'Opdater masterplan.json via Koordinator');
}

// data/scenes.json's own top-level `production` field (e.g. "Matematikrevyen
// 2026") — distinct from config.json's currentProductionFolder (an archive
// *folder slug* like "MatRevy_2026"). scripts/generate-pdfs.js reads this
// string as the \revyname{}/\revyyear{} printed on every generated PDF's
// title page (splitting the year back out of it via a regex — see that
// script's own comment), so it needs to change whenever a new production
// starts or every PDF keeps printing the old year. A dedicated resource
// rather than folding this into the `manus` resource above: `manus` is a
// full-array-replace of `acts`/`cast` (mirrors save_manus's own scenes/cast
// validation), and round-tripping the *current* acts/cast just to touch
// this one unrelated field would risk clobbering concurrent scene edits
// with a stale copy — same one-key-at-a-time posture as save_config above.
function save_production($payload) {
  $name = $payload['name'] ?? '';
  $year = $payload['year'] ?? '';
  if (!is_string($name) || trim($name) === '' || mb_strlen($name) > 100
      || !is_string($year) || !preg_match('/^\d{4}$/', $year)) {
    respond(400, ['error' => 'invalid_shape']);
  }
  $production = trim($name) . ' ' . $year;

  update_file('data/scenes.json', function ($json) use ($production) {
    $json['production'] = $production;
    return $json;
  }, 'Opdater produktionsnavn via Koordinator');
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
  'program'       => ['level' => 'boss',  'save' => 'save_program'],
  'masterplan'    => ['level' => 'admin', 'save' => 'save_masterplan'],
  'production'    => ['level' => 'admin', 'save' => 'save_production'],
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
