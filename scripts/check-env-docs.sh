#!/usr/bin/env bash
# ==============================================================================
# check-env-docs.sh — .env.example completeness gate (Phase 1 item 4).
#
# Fails (exit 1) when any environment variable read in code lacks a
# .env.example entry. Run in CI (see .github/workflows/ci.yaml) and locally:
#   bash scripts/check-env-docs.sh
#
# What is scanned:
#   1. Static reads:  process.env.VAR
#   2. Literal dynamic reads: process.env['VAR'], process.env["VAR"],
#      readPublicEnv('VAR')   (apps/web/src/lib/env.ts)
#   Scanned roots: apps/*/src, packages/*/src, scripts/.
#   Excluded: *.test.ts, *.spec.ts, */test/* (test fixtures set fake envs).
#
# What counts as documented: a line in .env.example shaped like
#   VAR=value   or   # VAR=value        (commented-out still counts)
#
# Genuinely dynamic reads (process.env[key] over a computed key) cannot be
# grepped; they belong in ALLOWLIST below with a justification comment.
# Known dynamic sites (need NO allowlist entry — handled above):
#   - apps/api/src/config/configuration.ts :: validateRequiredSecrets()
#     iterates the REQUIRED_SECRETS const; every member is also read
#     statically elsewhere, so the static scan covers them.
#   - apps/web/src/lib/env.ts :: process.env[name] is always called with a
#     string literal via readPublicEnv('VAR'); the literal scan covers it.
#
# LIMITATION (documented, not silently ignored): smtp-sender.ts resolves its
# config from an `env: NodeJS.ProcessEnv = process.env` parameter, so its
# reads appear as `env.VAR`, not `process.env.VAR`. If you add a new env read
# behind a ProcessEnv alias, either read process.env directly or add the var
# to ALLOWLIST with a comment naming the file.
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ENV_EXAMPLE=".env.example"
SRC_DIRS=(apps/api/src apps/worker/src apps/web/src packages/shared/src packages/database/src scripts)

# Vars that are read dynamically AND cannot be discovered by the scans above.
# Keep this empty unless a genuinely computed key appears; justify each entry.
ALLOWLIST=(
)

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# --- 1a. static process.env.VAR reads ----------------------------------------
find "${SRC_DIRS[@]}" \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) \
  -not -name '*.test.ts' -not -name '*.spec.ts' -not -path '*/test/*' \
  -exec grep -hoE 'process\.env\.[A-Za-z0-9_]+' {} + 2>/dev/null \
  | sed 's/.*process\.env\.//' \
  | sort -u > "$WORK/read.txt"

# --- 1b. string-literal dynamic reads ----------------------------------------
find "${SRC_DIRS[@]}" \
  \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.mjs' \) \
  -not -name '*.test.ts' -not -name '*.spec.ts' -not -path '*/test/*' \
  -exec grep -hoE "(process\.env\[|readPublicEnv\()['\"][A-Za-z0-9_]+['\"]" {} + 2>/dev/null \
  | grep -oE "['\"][A-Za-z0-9_]+['\"]" \
  | tr -d "'\"" \
  | sort -u >> "$WORK/read.txt"
sort -u -o "$WORK/read.txt" "$WORK/read.txt"

# --- 2. vars documented in .env.example ----------------------------------------
grep -oE '^[[:space:]]*#?[[:space:]]*[A-Z][A-Z0-9_]+=' "$ENV_EXAMPLE" \
  | grep -oE '[A-Z][A-Z0-9_]+' \
  | sort -u > "$WORK/documented.txt"

# --- 3. diff -------------------------------------------------------------------
failures=0
while IFS= read -r var; do
  [[ -z "$var" ]] && continue
  if grep -qxF "$var" "$WORK/documented.txt"; then
    continue
  fi
  if printf '%s\n' "${ALLOWLIST[@]:-}" | grep -qxF "$var"; then
    continue
  fi
  echo "::error file=$ENV_EXAMPLE::env var '$var' is read in code but not documented in $ENV_EXAMPLE"
  failures=$((failures + 1))
done < "$WORK/read.txt"

read_count="$(wc -l < "$WORK/read.txt" | tr -d ' ')"
if [[ "$failures" -ne 0 ]]; then
  echo "FAIL: $failures of $read_count env var(s) read in code lack a $ENV_EXAMPLE entry."
  exit 1
fi
echo "OK: all $read_count env var(s) read in code are documented in $ENV_EXAMPLE."
