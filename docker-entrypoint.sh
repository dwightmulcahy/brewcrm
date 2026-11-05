#!/bin/sh
set -eu
cd /app

DATA_DIR="${DATA_DIR:-/data}"
ARGS="--dir=$DATA_DIR --migrationsDir=/app/pb_migrations --hooksDir=/app/pb_hooks --publicDir=/app/pb_public"

if ! touch "$DATA_DIR/.write-test" 2>/dev/null; then
  echo "ERROR: $DATA_DIR is not writable by uid $(id -u). On QNAP: chown -R $(id -u):$(id -g) <QNAP_DATA_DIR>" >&2
  exit 1
fi
rm -f "$DATA_DIR/.write-test"

# Apply schema migrations
./pocketbase migrate up $ARGS >/dev/null

# Create/refresh the admin (superuser) from .env on every start, if provided
if [ -n "${PB_ADMIN_EMAIL:-}" ] && [ -n "${PB_ADMIN_PASSWORD:-}" ]; then
  ./pocketbase superuser upsert "$PB_ADMIN_EMAIL" "$PB_ADMIN_PASSWORD" --dir="$DATA_DIR" >/dev/null
fi

exec ./pocketbase serve --http="0.0.0.0:${PORT:-8080}" --hooksWatch=false --hooksPool="${PB_HOOKS_POOL:-4}" $ARGS
