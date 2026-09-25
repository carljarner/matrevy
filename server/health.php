<?php
// Liveness probe for Coolify's health check and UptimeRobot: 200 + "ok".
// Touches nothing (no config, no data), so it only proves Apache + PHP run.
header('Content-Type: text/plain');
header('Cache-Control: no-store');
echo "ok\n";
