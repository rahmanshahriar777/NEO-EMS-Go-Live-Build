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

# 2. Start NestJS API Backend in background
echo "⚡ Starting NestJS API Backend on port 4000..."
cd /app/apps/api
PORT=4000 NODE_ENV=production DATABASE_URL="${DATABASE_URL}" node dist/main.js &
API_PID=$!

# 3. Start Next.js Frontend in background
echo "🌐 Starting Next.js Web Frontend on port 3000..."
cd /app/apps/web
PORT=3000 HOSTNAME="0.0.0.0" NODE_ENV=production NEXT_PUBLIC_API_URL="/api/v1" NEXT_PUBLIC_API_BASE_URL="/api/v1" npx next start -p 3000 &
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
