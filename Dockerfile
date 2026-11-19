FROM php:8.3-apache

# Apache: serve the app under ${BASE_PATH} (e.g. /booth, /booth-stg), deny data/
COPY docker/booth.conf /etc/apache2/conf-available/zz-booth.conf
COPY docker/php.ini /usr/local/etc/php/conf.d/booth.ini
RUN a2enconf zz-booth \
 && rm -f /var/www/html/index.html

COPY index.html style.css app.js config.js api.php /var/www/html/
COPY images/ /var/www/html/images/
COPY data/.htaccess /var/www/html/data/.htaccess
RUN chown -R www-data:www-data /var/www/html/data

ENV BASE_PATH=/booth \
    PUBLIC_ORIGIN=https://ksv.f5.si
