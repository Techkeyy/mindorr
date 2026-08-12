#!/usr/bin/env bash
# run-live-server.sh, build and launch the Mindorr live-server on the VPS.
#
# The live-server exposes the enclave over HTTP so the web app can drive REAL
# per-user on-chain actions. Run this AFTER post-build.sh (the TEE must be
# registered and the proxy reachable).
#
# Inputs (env vars, same as test.sh):
#   EXT_PROXY_URL       proxy URL (default http://localhost:6674 in Docker)
#   CHAIN_URL           chain RPC (from .env.coston2)
#   INSTRUCTION_SENDER  deployed sender (from config/extension.env)
#   LIVE_SERVER_TOKEN   optional shared secret the app must send
#   LISTEN              listen address (default :8888)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

RED='\033[0;31m'; GREEN='\033[0;32m'; NC='\033[0m'
log() { echo -e "${GREEN}[live-server]${NC} $*"; }
die() { echo -e "${RED}[live-server] ERROR:${NC} $*" >&2; exit 1; }

# Load .env (DEPLOYMENT_PRIVATE_KEY, CHAIN_URL) and the generated extension config.
if [[ -f "$PROJECT_DIR/.env" ]]; then set -a; source "$PROJECT_DIR/.env"; set +a; fi
[[ -f "$PROJECT_DIR/config/extension.env" ]] && source "$PROJECT_DIR/config/extension.env"

EXT_PROXY_URL="${EXT_PROXY_URL:-http://localhost:6674}"
CHAIN_URL="${CHAIN_URL:-https://coston2-api.flare.network/ext/C/rpc}"
INSTRUCTION_SENDER="${INSTRUCTION_SENDER:-}"
LISTEN="${LISTEN:-:8888}"
ADDRESSES_FILE="$PROJECT_DIR/config/coston2/deployed-addresses.json"

[[ -n "$INSTRUCTION_SENDER" ]] || die "INSTRUCTION_SENDER not set. Run pre-build.sh first."
[[ -f "$ADDRESSES_FILE" ]] || die "addresses file not found: $ADDRESSES_FILE"
[[ -n "${DEPLOYMENT_PRIVATE_KEY:-}" ]] || die "DEPLOYMENT_PRIVATE_KEY not set (put it in .env.coston2)."
curl -sf -o /dev/null "$EXT_PROXY_URL/info" || die "proxy not reachable at $EXT_PROXY_URL"

log "Proxy:            $EXT_PROXY_URL"
log "InstructionSender: $INSTRUCTION_SENDER"
log "Listen:           $LISTEN"

cd "$PROJECT_DIR/tools"
log "building cmd/live-server..."
go build -o "$PROJECT_DIR/live-server" ./cmd/live-server || die "go build failed"

# Stop any previous instance, then start detached with a log file.
pkill -f "$PROJECT_DIR/live-server" 2>/dev/null || true
sleep 1

export DEPLOYMENT_PRIVATE_KEY
export LIVE_SERVER_TOKEN="${LIVE_SERVER_TOKEN:-}"
nohup "$PROJECT_DIR/live-server" \
    -a "$ADDRESSES_FILE" \
    -c "$CHAIN_URL" \
    -p "$EXT_PROXY_URL" \
    -instructionSender "$INSTRUCTION_SENDER" \
    -listen "$LISTEN" \
    > "$PROJECT_DIR/live-server.log" 2>&1 &

sleep 8
if curl -sf -o /dev/null "http://localhost${LISTEN}/health"; then
    log "live-server is UP (health 200). Logs: $PROJECT_DIR/live-server.log"
    curl -s "http://localhost${LISTEN}/health"; echo
else
    die "live-server did not become healthy. Check $PROJECT_DIR/live-server.log"
fi
