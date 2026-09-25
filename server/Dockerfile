FROM php:8.3-apache

# curl and mbstring, the only extensions update-data.php needs, are built in.
COPY php.ini /usr/local/etc/php/conf.d/matrevy.ini
COPY apache-matrevy.conf /etc/apache2/conf-enabled/matrevy.conf
COPY update-data.php /var/www/html/update-data.php
COPY config.docker.php /var/www/html/config.php

RUN mkdir -p /data && chown www-data:www-data /data
