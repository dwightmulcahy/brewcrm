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

# Normalise admin credentials from .env: lowercase email, strip CR/whitespace (Windows-edited .env files)
if [ -n "${PB_ADMIN_EMAIL:-}" ]; then
  PB_ADMIN_EMAIL=$(printf '%s' "$PB_ADMIN_EMAIL" | tr -d '\r' | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')
  export PB_ADMIN_EMAIL
fi
if [ -n "${PB_ADMIN_PASSWORD:-}" ]; then
  PB_ADMIN_PASSWORD=$(printf '%s' "$PB_ADMIN_PASSWORD" | tr -d '\r')
  export PB_ADMIN_PASSWORD
fi

# Fail fast with a clear message instead of PocketBase's terse validation error
if [ -n "${PB_ADMIN_PASSWORD:-}" ] && [ "${#PB_ADMIN_PASSWORD}" -lt 12 ]; then
  printf '{"timestamp":"%s","level":"CRITICAL","message":"PB_ADMIN_PASSWORD reached the container as %s characters; it must be at least 12 (with a letter and a number; a symbol unless it is 16+). In .env, a $ starts a variable and a space before # starts a comment: wrap the value in single quotes or write $ as $$. Fix .env and run docker compose up -d."}\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "${#PB_ADMIN_PASSWORD}"
  exit 1
fi

# Create/refresh the admin (superuser, /_/) from .env on every start, if provided.
# pb_hooks mirrors the same credentials into a CRM user for the main sign-in page.
if [ -n "${PB_ADMIN_EMAIL:-}" ] && [ -n "${PB_ADMIN_PASSWORD:-}" ]; then
  ./pocketbase superuser upsert "$PB_ADMIN_EMAIL" "$PB_ADMIN_PASSWORD" --dir="$DATA_DIR" >/dev/null
fi

exec ./pocketbase serve --http="0.0.0.0:${PORT:-8080}" --hooksWatch=false --hooksPool="${PB_HOOKS_POOL:-4}" $ARGS
