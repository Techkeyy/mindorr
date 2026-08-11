#!/usr/bin/env bash
#
# resume-coston2.sh — bring the enclave back after a Codespace idle/restart.
#
# A bare `docker compose up -d` regenerates the enclave key (new TEE ID) AND the
# Codespace forwards revert 6674 to private. So instructions 404 and the TEE looks
# unregistered. This script does the full, proven recovery in one shot:
#   1. start the containers            2. wait for the proxy
#   3. re-expose 6674 as public        4. re-register the (new) TEE to PRODUCTION
#
# The managed wallet (delivered via WALLET/UPDATE_KEY, a fixed key) is STABLE across
# restarts, so the MindorrVault registration and every captured signature stay valid.
#
# Usage (in the Codespace):
#   ./scripts/resume-coston2.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GREEN='\033[0;32m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}[resume]${NC} $*"; }
step() { echo -e "\n${CYAN}=== $* ===${NC}"; }
die()  { echo -e "${RED}[resume] ERROR:${NC} $*" >&2; exit 1; }

cd "$PROJECT_DIR"

: "${CODESPACE_NAME:?CODESPACE_NAME is not set — run this inside the Codespace}"
PUBLIC_URL="https://${CODESPACE_NAME}-6674.app.github.dev"
COMPOSE=(docker compose -f "$PROJECT_DIR/docker-compose.yaml" -f "$PROJECT_DIR/docker-compose.coston2.yaml")

step "1/4 Start containers"
"${COMPOSE[@]}" up -d

step "2/4 Wait for the extension proxy"
for i in $(seq 1 30); do
    if curl -sf -o /dev/null "http://localhost:6674/info"; then
        log "proxy is up (localhost:6674/info 200)"
        break
    fi
    [[ $i -eq 30 ]] && die "proxy never came up on localhost:6674"
    sleep 2
done

step "3/4 Re-expose port 6674 (reverts to private on restart)"
gh codespace ports visibility 6674:public -c "$CODESPACE_NAME" || die "could not set port 6674 public"
log "public endpoint: $PUBLIC_URL"

step "4/4 Re-register the TEE (a restart regenerates its key)"
EXT_PROXY_URL="http://localhost:6674" EXT_PROXY_HOST_URL="$PUBLIC_URL" "$SCRIPT_DIR/post-build.sh" \
    || die "post-build (TEE re-register) failed — is the port public and the proxy healthy?"

echo
echo -e "${GREEN}========================================${NC}"
echo -e "${GREEN} Enclave resumed and PRODUCTION${NC}"
echo -e "${GREEN}========================================${NC}"
echo "  Public endpoint : $PUBLIC_URL"
echo "  Next            : ALLOC_AMOUNT=1000000 EXT_PROXY_URL=http://localhost:6674 ./scripts/test.sh"
