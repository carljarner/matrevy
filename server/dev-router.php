<?php
// Router for PHP's built-in server, local development only:
//   php -S localhost:8741 server/dev-router.php   (from the repo root)
// Mirrors the clean-URL rewrites in server/apache-site.conf (keep the two
// in sync): /kalender serves kalender.html, old .html links and a trailing
// slash 301 to the clean URL. Everything else falls through to the
// built-in server (static files, update-data.php).

$root = dirname(__DIR__);
$path = parse_url($_SERVER['REQUEST_URI'], PHP_URL_PATH);
$query = parse_url($_SERVER['REQUEST_URI'], PHP_URL_QUERY);
$suffix = $query !== null && $query !== '' ? '?' . $query : '';

function dev_redirect($to) {
    header('Location: ' . $to, true, 301);
    exit;
}

if (preg_match('#^/index(\.html)?$#', $path)) dev_redirect('/' . $suffix);
// Renamed pages (keep in sync with apache-site.conf): Sangere -> Lydfiler.
if (preg_match('#^/sangere(\.html|/)?$#', $path)) dev_redirect('/lydfiler' . $suffix);
if (preg_match('#^/([a-z-]+)(\.html|/)$#', $path, $m) && is_file("$root/{$m[1]}.html")) {
    dev_redirect('/' . $m[1] . $suffix);
}
if ($path === '/' || (preg_match('#^/([a-z-]+)$#', $path, $m) && is_file("$root/{$m[1]}.html"))) {
    $file = $path === '/' ? "$root/index.html" : "$root/{$m[1]}.html";
    header('Content-Type: text/html; charset=utf-8');
    readfile($file);
    return true;
}
// The built-in server would answer an unknown path with index.html.
if (!is_file($root . $path) && !is_dir($root . $path)) {
    http_response_code(404);
    echo "404 Not Found\n";
    return true;
}
return false;
