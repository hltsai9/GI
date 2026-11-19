#!/bin/sh
# Backs up the GI database from the MariaDB container to $BACKUP_DIR (default /opt/gi-backups)
# and deletes backups older than $KEEP_DAYS (default 14). See docs/DEPLOYMENT_SOP.md §11.
set -eu
cd "$(dirname "$0")"
BACKUP_DIR="${BACKUP_DIR:-/opt/gi-backups}"
KEEP_DAYS="${KEEP_DAYS:-14}"
mkdir -p "$BACKUP_DIR"
file="$BACKUP_DIR/gi-$(date +%F-%H%M).sql.gz"
docker compose exec -T mariadb sh -c 'mariadb-dump -uroot -p"$MARIADB_ROOT_PASSWORD" --single-transaction --routines gi' | gzip > "$file.tmp"
mv "$file.tmp" "$file"
find "$BACKUP_DIR" -name 'gi-*.sql.gz' -mtime +"$KEEP_DAYS" -delete
echo "backup written: $file ($(du -h "$file" | cut -f1))"
