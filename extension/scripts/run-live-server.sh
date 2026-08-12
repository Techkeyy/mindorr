#!/usr/bin/env bash
# run-live-server.sh, build and launch the Mindorr live-server on the VPS.
#
# The live-server exposes the enclave over HTTP so the web app can drive REAL
# per-user actions. It talks to the proxy's POST /direct endpoint, bypassing
# the on-chain instruction pipeline (no InstructionSender, no indexer DB).
#
# Inputs (env vars):
#   EXT_PROXY_URL       proxy URL (default http://localhost:6674)
#   LIVE_SERVER_TOKEN   optional shared secret the app must send
#   LISTEN              listen address (default :8888)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[live-server]${NC} $*"; }
die() { echo -e "${RED}[live-server] ERROR:${NC} $*" >&2; exit 1; }

if [[ -f "$PROJECT_DIR/.env" ]]; then set -a; source "$PROJECT_DIR/.env"; set +a; fi

EXT_PROXY_URL="${EXT_PROXY_URL:-http://localhost:6674}"
LISTEN="${LISTEN:-:8888}"

curl -sf -o /dev/null "$EXT_PROXY_URL/info" || die "proxy not reachable at $EXT_PROXY_URL"

log "Proxy:  $EXT_PROXY_URL"
log "Listen: $LISTEN"

cd "$PROJECT_DIR/tools"
log "building cmd/live-server..."
go build -o "$PROJECT_DIR/live-server" ./cmd/live-server || die "go build failed"

pkill -f "$PROJECT_DIR/live-server" 2>/dev/null || true
sleep 1

export LIVE_SERVER_TOKEN="${LIVE_SERVER_TOKEN:-}"
nohup "$PROJECT_DIR/live-server" \
    -p "$EXT_PROXY_URL" \
    -listen "$LISTEN" \
    > "$PROJECT_DIR/live-server.log" 2>&1 &

log "waiting for seed delivery (enclave may need up to 60s)..."
for i in $(seq 1 12); do
    sleep 10
    if curl -sf -o /dev/null "http://localhost${LISTEN}/health" 2>/dev/null; then
        log "live-server is UP (health 200). Logs: $PROJECT_DIR/live-server.log"
        curl -s "http://localhost${LISTEN}/health"; echo
        exit 0
    fi
    log "attempt $i/12: not ready yet..."
done
die "live-server did not become healthy after 120s. Check $PROJECT_DIR/live-server.log"
