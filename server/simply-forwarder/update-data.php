<?php
// Temporary Simply.com stand-in for update-data.php during the move to the
// Hetzner/Coolify server (hosting.md Part 6, low-downtime cutover).
//
// Uploaded over the real update-data.php on Simply right after the final
// private-data sync. From then on every API call — whichever IP a visitor's
// DNS still resolves manus.matematikrevy.dk to — executes on the new server,
// so private data can never be written in two places during DNS propagation.
//
// Also relays Let's Encrypt HTTP-01 challenges for manus.matematikrevy.dk
// (via the .htaccess next to this file) to the new server's Traefik, so it can
// get its certificate for manus.* *before* the DNS record is switched.
//
// Holds no secrets: passwords travel inside the forwarded request body, over
// HTTPS, exactly as they do today. Remove from Simply ≥48h after the DNS switch.

const FORWARD_HOST = 'api-new.matematikrevy.dk';
const PUBLIC_HOST = 'manus.matematikrevy.dk';

set_time_limit(120);

// Marker so `curl -sI` can confirm this forwarder (not the old endpoint, and
// not a host-level handler) is what answered a request.
header('X-Matrevy-Forwarder: 1');

function forwarder_fail($code, $error, $detail = null) {
  http_response_code($code);
  header('Content-Type: application/json; charset=utf-8');
  echo json_encode(['ok' => false, 'error' => $error, 'detail' => $detail]);
  exit;
}

// ── ACME HTTP-01 relay ───────────────────────────────────────
// Traefik looks the token up by the request's Host, so send the public name.
if (isset($_GET['acme'])) {
  $token = (string) $_GET['acme'];
  if (!preg_match('/^[A-Za-z0-9_-]{1,256}$/', $token)) {
    forwarder_fail(400, 'bad_token');
  }
  $ch = curl_init('http://' . FORWARD_HOST . '/.well-known/acme-challenge/' . $token);
  curl_setopt_array($ch, [
    CURLOPT_HTTPHEADER => ['Host: ' . PUBLIC_HOST],
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => false,
    CURLOPT_CONNECTTIMEOUT => 10,
    CURLOPT_TIMEOUT => 20,
  ]);
  $out = curl_exec($ch);
  $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
  if ($out === false || $status !== 200) {
    http_response_code(404);
    exit;
  }
  header('Content-Type: text/plain');
  echo $out;
  exit;
}

// ── API forwarding ───────────────────────────────────────────
// Same CORS headers as update-data.php; answer preflights locally.
header('Access-Control-Allow-Origin: https://matematikrevy.dk');
header('Access-Control-Allow-Methods: POST, OPTIONS');
header('Access-Control-Allow-Headers: Content-Type');

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
  http_response_code(204);
  exit;
}

// Headers from the upstream reply worth passing on (receipt downloads need
// their own Content-Type/Content-Disposition; everything else is JSON).
$passHeaders = ['content-type', 'content-disposition', 'cache-control'];
$upstreamHeaders = [];

$ch = curl_init('https://' . FORWARD_HOST . '/update-data.php');
curl_setopt_array($ch, [
  CURLOPT_CUSTOMREQUEST => $_SERVER['REQUEST_METHOD'],
  CURLOPT_POSTFIELDS => file_get_contents('php://input'),
  CURLOPT_HTTPHEADER => [
    'Content-Type: ' . ($_SERVER['CONTENT_TYPE'] ?? 'application/json'),
    'Origin: https://matematikrevy.dk',
    'X-Forwarded-For: ' . ($_SERVER['REMOTE_ADDR'] ?? ''),
  ],
  CURLOPT_RETURNTRANSFER => true,
  CURLOPT_HEADERFUNCTION => function ($ch, $line) use (&$upstreamHeaders, $passHeaders) {
    $parts = explode(':', $line, 2);
    if (count($parts) === 2) {
      $name = strtolower(trim($parts[0]));
      if (in_array($name, $passHeaders, true)) {
        $upstreamHeaders[$name] = trim($parts[1]);
      }
    }
    return strlen($line);
  },
  CURLOPT_CONNECTTIMEOUT => 10,
  CURLOPT_TIMEOUT => 100,
]);
$out = curl_exec($ch);
if ($out === false) {
  $err = curl_error($ch);
  forwarder_fail(502, 'forward_failed', $err);
}
$status = curl_getinfo($ch, CURLINFO_HTTP_CODE);

http_response_code($status);
foreach ($upstreamHeaders as $name => $value) {
  header($name . ': ' . $value);
}
echo $out;
