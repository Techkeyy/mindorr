#!/usr/bin/env bash
#
# Deploy MindorrVault to Coston2 and wire one account.
#
# This script never contains a key. Provide your FUNDED Coston2 deployer key via
# the environment, and run it yourself — Mindorr's tooling never handles keys.
#
#   export DEPLOYER_KEY=0x...            # a funded Coston2 key (C2FLR for gas)
#   export MANAGED_WALLET=0x...          # enclave wallet addr (from UPDATE_KEY / GET /state)
#   export RETURN_ADDR=0x...             # your own address — the only withdraw target
#   export VENUE=0x...                   # a lending vault to allowlist (optional)
#   bash scripts/deploy-coston2.sh
#
set -euo pipefail

RPC="${RPC:-https://coston2-api.flare.network/ext/C/rpc}"
FXRP="${FXRP:-0x0b6A3645c240605887a5532109323A3E12273dc7}"   # verified Coston2 FXRP

: "${DEPLOYER_KEY:?set DEPLOYER_KEY to a funded Coston2 key}"
: "${MANAGED_WALLET:?set MANAGED_WALLET to the enclave wallet address}"
: "${RETURN_ADDR:?set RETURN_ADDR to your own return address}"

cd "$(dirname "$0")/../extension"

echo "==> Deploying MindorrVault to Coston2 ($RPC)"
ADDR=$(forge create contracts/MindorrVault.sol:MindorrVault \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" --broadcast \
  --json | node -e 'process.stdin.on("data",d=>{try{console.log(JSON.parse(d).deployedTo)}catch(e){process.stdout.write(d)}})')
echo "    MindorrVault deployed at: $ADDR"

echo "==> Registering account (managedWallet=$MANAGED_WALLET, returnAddr=$RETURN_ADDR, asset=$FXRP)"
cast send "$ADDR" "registerAccount(address,address,address)" \
  "$MANAGED_WALLET" "$RETURN_ADDR" "$FXRP" \
  --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
echo "    account registered"

if [ -n "${VENUE:-}" ]; then
  echo "==> Allowlisting venue $VENUE"
  cast send "$ADDR" "setVenue(address,bool)" "$VENUE" true \
    --rpc-url "$RPC" --private-key "$DEPLOYER_KEY" >/dev/null
  echo "    venue allowlisted"
fi

echo
echo "Done. MindorrVault: $ADDR"
echo "Next: register the TEE extension itself — see docs/RUNBOOK.md §2–§4."
