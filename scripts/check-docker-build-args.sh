#!/usr/bin/env bash
# ==============================================================================
# check-docker-build-args.sh — web build-arg completeness gate (#5-infra).
#
# Fails (exit 1) when any ARG declared in apps/web/Dockerfile is NOT passed
# as a build-arg in .github/workflows/docker-build.yaml.
#
# Why: build-time values (NEXT_PUBLIC_* client vars, API_INTERNAL_URL rewrite
# destination) are baked into the web image when it is built; the GHCR images
# CI publishes deploy to k8s. An ARG left unset silently falls back to the
# Dockerfile default — which bit API_INTERNAL_URL (compose service-name
# default baked in; in-cluster DNS failed because the k8s Service name was
# never passed).
#
# Run in CI (see .github/workflows/ci.yaml) and locally:
#   bash scripts/check-docker-build-args.sh
#
# Scope: web Dockerfile ARGs -> docker-build.yaml build-args. The build-args
# block is shared across the api/web/worker matrix builds; unknown args are
# ignored by the api/worker builds, so presence here is always safe.
# ==============================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

DOCKERFILE="apps/web/Dockerfile"
WORKFLOW=".github/workflows/docker-build.yaml"

# ARGs that are deliberately NOT passed by the publish workflow; justify each.
ALLOWLIST=(
  # Optional convenience knob: next.config.mjs maps it into
  # NEXT_PUBLIC_ALLOW_PUBLIC_REGISTRATION at build time, but falls back to
  # 'false' when unset. CI deliberately does not set it — leaving it out is
  # the safe default (registration closed unless an operator opts in).
  ALLOW_PUBLIC_REGISTRATION
)

# --- 1. ARG names declared in the Dockerfile ---------------------------------
mapfile -t args < <(grep -oE '^[[:space:]]*ARG [A-Za-z0-9_]+' "$DOCKERFILE" \
  | awk '{print $2}' | sort -u)

# --- 2. build-args passed in the workflow ------------------------------------
# The build-args: | block lists VAR=... lines (one per line).
passed=()
while IFS= read -r var; do
  [[ -z "$var" ]] && continue
  passed+=("$var")
done < <(grep -oE '^[[:space:]]+[A-Za-z0-9_]+=' "$WORKFLOW" \
  | grep -oE '[A-Za-z0-9_]+' | sort -u)

failures=0
for arg in "${args[@]}"; do
  [[ -z "$arg" ]] && continue
  if printf '%s\n' "${passed[@]}" | grep -qxF "$arg"; then
    continue
  fi
  if printf '%s\n' "${ALLOWLIST[@]:-}" | grep -qxF "$arg"; then
    echo "OK (allowlisted): $arg"
    continue
  fi
  echo "MISSING build-arg in $WORKFLOW: $arg (declared in $DOCKERFILE)"
  failures=$((failures + 1))
done

if (( failures > 0 )); then
  echo ""
  echo "$failures ARG(s) from $DOCKERFILE are not passed as build-args in $WORKFLOW."
  echo "Add them (with a sane default) or justify an ALLOWLIST entry above."
  exit 1
fi

echo "All ${#args[@]} web Dockerfile ARGs are passed in $WORKFLOW."
