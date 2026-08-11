#!/usr/bin/env bash
#
# write-proxy-config.sh — generate the Coston2 proxy config from env vars.
#
# The proxy needs the LIVE Flare indexer DB. Hand-editing the TOML in a terminal
# is how the heredoc kept getting mangled during bring-up; this script fills the
# placeholders in the committed .example so that never happens again. The schema
# lives in the .example (single source of truth); we only substitute values.
#
# The public defaults (host/db/user) are the live Coston2 indexer from
# https://dev.flare.network/fcc/guides/getting-started (step 3). The PASSWORD is
# a secret — it is read from the environment and never committed.
#
# Usage:
#   INDEXER_DB_PASSWORD=... ./scripts/write-proxy-config.sh
#
# Optional overrides: INDEXER_DB_HOST, INDEXER_DB_NAME, INDEXER_DB_USER.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

EXAMPLE="$PROJECT_DIR/config/proxy/extension_proxy.coston2.docker.toml.example"
OUT="$PROJECT_DIR/config/proxy/extension_proxy.coston2.docker.toml"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
die() { echo -e "${RED}[write-proxy-config] ERROR:${NC} $*" >&2; exit 1; }
log() { echo -e "${GREEN}[write-proxy-config]${NC} $*"; }

# Live Coston2 indexer (public — from the Flare FCC getting-started guide).
DB_HOST="${INDEXER_DB_HOST:-34.38.42.208}"
DB_NAME="${INDEXER_DB_NAME:-indexer}"
DB_USER="${INDEXER_DB_USER:-hackathon_user_57}"
DB_PASS="${INDEXER_DB_PASSWORD:?set INDEXER_DB_PASSWORD (the indexer password — never commit it)}"

[[ -f "$EXAMPLE" ]] || die "template not found: $EXAMPLE"

# Guard against a stale directory left by a previous bad `docker compose` mount
# (docker creates a dir at the path when the file is missing).
[[ -d "$OUT" ]] && rm -rf "$OUT"

# Substitute only the four placeholders. Using a temp file + mv keeps it atomic.
tmp="$(mktemp)"
sed \
  -e "s|<indexer-db-host>|${DB_HOST}|" \
  -e "s|<indexer-db-name>|${DB_NAME}|" \
  -e "s|<indexer-db-user>|${DB_USER}|" \
  -e "s|<indexer-db-password>|${DB_PASS}|" \
  "$EXAMPLE" > "$tmp"

# Fail loudly if any placeholder survived (schema drifted in the .example).
if grep -q '<indexer-db-' "$tmp"; then
  rm -f "$tmp"
  die "unsubstituted placeholder remains — the .example schema changed; update this script"
fi

mv "$tmp" "$OUT"
log "wrote $OUT (host=$DB_HOST db=$DB_NAME user=$DB_USER, password hidden)"
