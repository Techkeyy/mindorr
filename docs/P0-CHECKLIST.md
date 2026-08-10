# P0 — Register the Mindorr TEE on Coston2 (simulated, hackathon path)

Goal: get the confidential extension **registered and PRODUCTION** on the live
`FlareTeeManager 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`, reachable by the
data providers. Per the hackathon FCC notes, **`SIMULATED_TEE=true` / `MODE=1`
is accepted** — no GCP Confidential Space VM required. This runs the extension +
proxy locally and exposes them through a named tunnel.

All commands run from `extension/`.

## Before you start — things only you can provide

- [ ] **Funded Coston2 key** — `cast wallet new`, then fund at
      `https://faucet.flare.network/coston2`. Becomes `INITIAL_OWNER`.
- [ ] **Go 1.25.1+** installed — the register tooling is Go (`go run ./cmd/...`).
      *(Not currently on this machine — install it first.)*
- [ ] **A named cloudflared tunnel** or reserved ngrok domain — **never a quick
      tunnel** (hostnames rotate → the on-chain URL goes dead → machine stalls at
      INITIALIZED).
- [ ] **Flare indexer DB creds + VPN** (`35.241.249.150:3306`) — from the
      hackathon pinned message.
- [ ] Docker running; Foundry (`forge`/`cast`) — already present.

## Steps

1. **Configure env.** Copy `.env.example` → `.env.coston2` and set:
   ```
   CHAIN=coston2
   CHAIN_URL=https://coston2-api.flare.network/ext/C/rpc
   ADDRESSES_FILE=./config/coston2/deployed-addresses.json   # has the live FlareTeeManager
   NORMAL_PROXY_URL=https://tee-proxy-coston2-1.flare.rocks
   EXT_PROXY_URL=                                            # set in step 5
   LANGUAGE=typescript
   SIMULATED_TEE=true
   MODE=1
   DEPLOYMENT_PRIVATE_KEY=<key, no 0x>
   INITIAL_OWNER=0x<your funded address>
   ```
   Activate: `bash ./scripts/use-chain.sh coston2`

2. **Pre-build (fresh EXTENSION_ID).** The redeploy wipes registrations, so mint
   a new one: `bash ./scripts/pre-build.sh` → writes `config/extension.env`
   (`EXTENSION_ID`, `INSTRUCTION_SENDER`). `cat config/extension.env`.

3. **Start the extension + proxy locally** (TypeScript image, simulated):
   `bash ./scripts/start-services.sh --chain coston2`
   (uses `MODE=1`; `tee-node`/`tee-proxy` are pinned in the build).

4. **Open the named tunnel** to the proxy's public port and copy the stable
   HTTPS URL.

5. **Register the URL:** put it in `.env.coston2` as `EXT_PROXY_URL=<url>`, then
   `bash ./scripts/use-chain.sh coston2` again.

6. **Post-build (register + promote):** `bash ./scripts/post-build.sh`
   — whitelists the codeHash and runs `register-tee -command rRap` (capital R =
   fresh challenge, so re-runs work). This should reach **PRODUCTION** in
   seconds on the current stack.

7. **Verify (30-second check):**
   ```bash
   # 2 = PRODUCTION, 1 = INITIALIZED
   cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
     "getTeeMachineStatus(address)(uint8)" <teeId> \
     --rpc-url https://coston2-api.flare.network/ext/C/rpc
   # confirm the on-chain URL is the one you're serving:
   cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
     "getTeeMachine(address)((address,address,string))" <teeId> \
     --rpc-url https://coston2-api.flare.network/ext/C/rpc
   ```

8. **Deploy the vault + wire the account** (contract side, separate):
   see [`DEPLOY.md`](DEPLOY.md) — `scripts/deploy-coston2.sh`.

9. **End-to-end:** `bash ./scripts/test.sh`.

## If it stalls (from the FCC notes)

- Stuck at **INITIALIZED** → the on-chain URL is dead (quick tunnel rotated) or
  `tee-node` isn't on `develop` ≥ v0.0.22. Fix the tunnel, `use-chain.sh`, re-run
  post-build.
- `FunctionNotFound` / `register()` reverts → you're pointed at the **old dead**
  manager `0x004224fa…5d41F`. `ADDRESSES_FILE` must resolve to `0x1a9C…18aE`.
- Empty action queue forever → data-provider votes rejected → check `tee-node`
  version.

Ping me at any step with the output and I'll help debug — the read-only `cast`
checks above tell us which side is broken in ~30 seconds.
