#!/bin/bash
set -e

echo "🚀 Starting Neoteric Digital EMS..."

# Set port for reverse proxy (default 8080)
PORT="${PORT:-8080}"
sed -i "s/listen 8080;/listen ${PORT};/g" /etc/nginx/nginx.conf

# ------------------------------------------------------------------------------
# 1. Database Provisioning & Startup
# ------------------------------------------------------------------------------
if [ -z "$DATABASE_URL" ]; then
  echo "📦 No external DATABASE_URL provided. Initializing embedded PostgreSQL..."
  mkdir -p /run/postgresql /var/lib/postgresql/data
  chown -R postgres:postgres /run/postgresql /var/lib/postgresql

  if [ ! -d "/var/lib/postgresql/data/base" ]; then
    echo "⚙️ Initializing PostgreSQL data directory..."
    su-exec postgres initdb -D /var/lib/postgresql/data --auth=trust
    su-exec postgres pg_ctl -D /var/lib/postgresql/data -o "-c listen_addresses='127.0.0.1' -c log_statement=none" -w start
    su-exec postgres psql -U postgres -c "CREATE ROLE ems_admin WITH LOGIN SUPERUSER PASSWORD 'ems_admin_secret_2026';"
    su-exec postgres psql -U postgres -c "CREATE DATABASE ems_db OWNER ems_admin;"
    echo "✅ Embedded PostgreSQL ready"

    export DATABASE_URL="postgresql://ems_admin:ems_admin_secret_2026@127.0.0.1:5432/ems_db?schema=public"

    echo "🌱 Syncing database schema and seeding demo data..."
    cd /app/packages/database
    DATABASE_URL="${DATABASE_URL}" npx prisma db push --skip-generate
    ALLOW_SEED=yes SEED_DEFAULT_PASSWORD="Password1234!" DATABASE_URL="${DATABASE_URL}" npx tsx prisma/seed.ts || true
    cd /app
  else
    su-exec postgres pg_ctl -D /var/lib/postgresql/data -o "-c listen_addresses='127.0.0.1' -c log_statement=none" -w start
    export DATABASE_URL="postgresql://ems_admin:ems_admin_secret_2026@127.0.0.1:5432/ems_db?schema=public"
    echo "✅ Embedded PostgreSQL started"
  fi
else
  echo "✅ External DATABASE_URL is set (value redacted)"
fi

# Default environment secrets for standalone Cloud Run deployment
export S3_ACCESS_KEY="${S3_ACCESS_KEY:-ems_minio_access_key_2026}"
export S3_SECRET_KEY="${S3_SECRET_KEY:-ems_minio_secret_key_2026}"
export SMTP_HOST="${SMTP_HOST:-localhost}"
export SMTP_PORT="${SMTP_PORT:-587}"
export SMTP_FROM="${SMTP_FROM:-noreply@ems.local}"
export JWT_ACCESS_SECRET="${JWT_ACCESS_SECRET:-ems_super_secret_access_jwt_key_development_only_change_in_prod_123!}"
export JWT_REFRESH_SECRET="${JWT_REFRESH_SECRET:-ems_super_secret_refresh_jwt_key_development_only_change_in_prod_456!}"
export DOCUMENT_ENCRYPTION_KEY="${DOCUMENT_ENCRYPTION_KEY:-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef}"

# 2. Start NestJS API Backend in background
echo "⚡ Starting NestJS API Backend on port 4000..."
cd /app/apps/api
PORT=4000 NODE_ENV=production DATABASE_URL="${DATABASE_URL}" node dist/main.js &
API_PID=$!

# 3. Start Next.js Frontend in background
echo "🌐 Starting Next.js Web Frontend on port 3000..."
cd /app/apps/web
export PORT=3000
export HOSTNAME="0.0.0.0"
export NODE_ENV=production
export NEXT_PUBLIC_API_URL="/api/v1"
export NEXT_PUBLIC_API_BASE_URL="/api/v1"

if [ -f "/app/apps/web/.next/standalone/apps/web/server.js" ]; then
  cp -r /app/apps/web/public /app/apps/web/.next/standalone/apps/web/ 2>/dev/null || true
  cp -r /app/apps/web/.next/static /app/apps/web/.next/standalone/apps/web/.next/ 2>/dev/null || true
  node /app/apps/web/.next/standalone/apps/web/server.js &
elif [ -f "/app/apps/web/.next/standalone/server.js" ]; then
  cp -r /app/apps/web/public /app/apps/web/.next/standalone/ 2>/dev/null || true
  cp -r /app/apps/web/.next/static /app/apps/web/.next/standalone/.next/ 2>/dev/null || true
  node /app/apps/web/.next/standalone/server.js &
else
  node ./node_modules/.bin/next start -p 3000 &
fi
WEB_PID=$!

cd /app

# 4. Wait for internal services to become ready
echo "⏳ Waiting for API to become ready on port 4000..."
for i in $(seq 1 45); do
  if curl -s http://127.0.0.1:4000/api/v1/health/liveness > /dev/null 2>&1; then
    echo "✅ API is up and running on port 4000!"
    break
  fi
  sleep 1
done

echo "⏳ Waiting for Web Frontend to become ready on port 3000..."
for i in $(seq 1 45); do
  if curl -s http://127.0.0.1:3000 > /dev/null 2>&1; then
    echo "✅ Web Frontend is up and running on port 3000!"
    break
  fi
  sleep 1
done

# Graceful termination handler
trap "echo 'Shutting down...'; kill $API_PID $WEB_PID; exit 0" SIGTERM SIGINT

# 5. Start Nginx reverse proxy in foreground
echo "🛡️ Starting Nginx on port ${PORT}..."
nginx -g "daemon off;"
