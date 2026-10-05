#!/bin/bash
set -e

echo "🚀 Starting Neoteric Digital EMS..."

# Set port for reverse proxy (default 8080)
PORT="${PORT:-8080}"
sed -i "s/listen 8080;/listen ${PORT};/g" /etc/nginx/nginx.conf

# ------------------------------------------------------------------------------
# 1. Database — FAIL CLOSED (F1/F2)
# ------------------------------------------------------------------------------
# The container NEVER provisions, migrates, or seeds the database:
#   - no embedded PostgreSQL (the old --auth=trust init path was removed),
#   - no `prisma db push` (schema changes ship as versioned migrations,
#     applied by the release pipeline via `prisma migrate deploy`),
#   - no boot-time `db seed` (seeding would reset demo credentials and
#     could destroy production data).
# A managed PostgreSQL must be provided through DATABASE_URL.
if [ -z "$DATABASE_URL" ]; then
  echo "❌ FATAL: DATABASE_URL is not set. Refusing to start." >&2
  echo "   Provide a managed PostgreSQL connection string via the DATABASE_URL" >&2
  echo "   environment variable. The entrypoint never creates databases or users." >&2
  exit 1
fi
echo "✅ DATABASE_URL is set (value redacted)"

# 2. Start NestJS API Backend in background
echo "⚡ Starting NestJS API Backend on port 4000..."
cd /app/apps/api
PORT=4000 NODE_ENV=production DATABASE_URL="${DATABASE_URL}" node dist/main.js &
API_PID=$!

# 3. Start Next.js Frontend in background
echo "🌐 Starting Next.js Web Frontend on port 3000..."
cd /app/apps/web
PORT=3000 HOSTNAME="0.0.0.0" NODE_ENV=production NEXT_PUBLIC_API_URL="/api/v1" ./node_modules/.bin/next start -p 3000 &
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
