FROM php:8.3-apache

# curl and mbstring, the only extensions update-data.php needs, are built in.
COPY php.ini /usr/local/etc/php/conf.d/matrevy.ini
# zz- so it loads after Debian's own security.conf, which would
# otherwise override ServerTokens/ServerSignature.
COPY apache-matrevy.conf /etc/apache2/conf-enabled/zz-matrevy.conf
COPY update-data.php /var/www/html/update-data.php
COPY config.docker.php /var/www/html/config.php
COPY health.php /var/www/html/health.php

RUN mkdir -p /data && chown www-data:www-data /data
