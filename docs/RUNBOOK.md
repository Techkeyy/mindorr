# Mindorr — Runbook (Coston2 FCC)

Operational notes for standing up the Mindorr extension on Coston2. **Read the "live
deployment" box first** — most FCC issues this cycle are stale clients talking to the dead
stack.

> ## ⚠️ Live deployment, not the old one
> Coston2 FCC was **redeployed**. Use only the live addresses.
> - **Live `FlareTeeManager`: `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`**
> - Dead since ~22 Jul: `0x004224fa…5d41F` → causes `FunctionNotFound`, `register()` reverts,
>   "only reward offers manager". If you see those, you're on the old stack.
> - `tee-node` + `tee-proxy` must be on **`develop`**, `tee-node ≥ v0.0.22`. Older versions
>   get every data-provider vote rejected, so the action queue stays empty forever.

## Secrets

Never commit keys or the hackathon password. Put them in `extension/.env` (git-ignored).
Hackathon test user: `hackathon_user_57` (password lives in your private notes / `.env`,
not this repo).

## 0. Local dev — no chain needed

The trust core runs and tests off-chain:

```bash
cd extension/typescript
npm ci
npm test        # 68/68 — scaffold conformance + Mindorr policy guard
npm run build
```

## 1. Toolchain

- Docker (running) — the extension + tee-node run as containers.
- Node ≥ 20 for the TypeScript extension and the `app/` chat brain.
- A **named** cloudflared tunnel **or** a reserved ngrok domain — see §4.
- The `fce-sign` `go/tools/cmd` helpers are the reference CLI: `register-tee`,
  `register-extension`, `check-tee-state`, `deploy-contract`, `start-proxy`,
  `start-tee`, `verify-deploy`.

## 2. The path that actually worked (GitHub Codespace)

> Docker Desktop on **Windows** produced no `server` binary from `go build` (a buildkit
> bug — `go build ./cmd/extension` exits 0 in ~2 ms and writes nothing). Do **not** burn
> time repairing it; it is non-reproducible. Build in a **GitHub Codespace** on
> `Techkeyy/mindorr` — it also doubles as the reproducible deliverable. Edit code locally,
> run the heavy runtime in the Codespace.

Registered live on 2026-08-11 — these are the real values:

| | |
|---|---|
| TEE machine ID | `0x4A47F54fC5C8f1e6321Ea29c47f5D33EF1d05056` |
| Extension ID | `66129` |
| Owner | `0x16Cbdc4974754F915aDd3Fb7240A7eF9699c8700` |
| Status | **PRODUCTION** (code 2) |

Bring-up in the Codespace (`/workspaces/mindorr/extension`):

```bash
# 1. Chain env: create .env.coston2 (SIMULATED_TEE=true, MODE=1, CHAIN=coston2,
#    CHAIN_URL, DEPLOYMENT_PRIVATE_KEY, INITIAL_OWNER), then activate it.
./scripts/use-chain.sh coston2

# 2. Proxy config from env — NO hand-edited heredoc (that is what kept corrupting).
INDEXER_DB_PASSWORD=<from Flare pinned msg> ./scripts/write-proxy-config.sh

# 3. Fresh registration: pre-build (new EXTENSION_ID) then bring the containers up.
./scripts/pre-build.sh
./scripts/start-services.sh

# 4. Expose the proxy. In a Codespace the container's 6664 maps to host 6674.
gh codespace ports visibility 6674:public -c "$CODESPACE_NAME"
PUBLIC_URL="https://${CODESPACE_NAME}-6674.app.github.dev"

# 5. Register the TEE to PRODUCTION. EXT_PROXY_URL is the LOCAL port the script polls;
#    EXT_PROXY_HOST_URL is the PUBLIC url written on-chain for data providers.
EXT_PROXY_URL=http://localhost:6674 EXT_PROXY_HOST_URL="$PUBLIC_URL" ./scripts/post-build.sh
```

The live **indexer DB** is host `34.38.42.208`, db `indexer`, user `hackathon_user_57`
(from the Flare FCC getting-started guide, step 3). The old `35.241.249.150` /
`flare_indexer_coston2` in stale docs is dead/firewalled — the proxy PANICs with a MySQL
dial timeout if you use it.

## 3. Confirm PRODUCTION

`cast` reads `CHAIN=coston2` from `.env` and rejects it as an unknown `--chain`, so pass
the real one explicitly:

```bash
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" 0x4A47F54fC5C8f1e6321Ea29c47f5D33EF1d05056 \
  --chain flare-coston2 --rpc-url https://coston2-api.flare.network/ext/C/rpc
# => 2  (PRODUCTION)
```

A simulated TEE reaches PRODUCTION in seconds on a current stack. Stuck at `INITIALIZED`
almost always means the on-chain URL is dead (see §4).

## 3b. Resume after a Codespace restart (one command)

A bare `docker compose up -d` regenerates the enclave key (new TEE ID) and the Codespace
reverts port 6674 to private, so instructions 404. Recover in one shot:

```bash
./scripts/resume-coston2.sh   # up -d -> wait -> re-expose 6674 -> post-build (re-register)
```

The managed wallet (delivered via UPDATE_KEY) is stable across restarts, so the MindorrVault
registration and any captured signatures stay valid.

## 4. Endpoint — a stable public URL, not a quick tunnel

Data providers push actions to the URL stored on-chain, so it must stay reachable. The
Codespace public-port URL (`https://<CODESPACE_NAME>-6674.app.github.dev`) is derived from
the **stable** `CODESPACE_NAME`, so it survives stop/start of the *same* Codespace — no
re-registration needed on a restart, just re-run `write-proxy-config` + `start-services` +
the port-visibility command. It does **not** survive if the Codespace sleeps and you never
reopen it, and the port reverts to private on stop. `trycloudflare` quick tunnels rotate
hostnames and go dead — never use them. If you must rotate the endpoint, update
`EXT_PROXY_HOST_URL` and re-run post-build.

## 5. Attestation mode

`SIMULATED_TEE=true` / `MODE=1` on Coston2 is fine for judging — GCP Confidential Space is
not required. Switch to `MODE=0` only for a real Confidential Space VM.

## 6. Diagnose (30 seconds, tells you which side is broken)

1. `check-tee-state` (or the two `cast` calls above) — is your served URL the on-chain one?
2. Status `1` (INITIALIZED) with a good URL → data-provider votes rejected → check
   `tee-node` version is on `develop` ≥ v0.0.22.
3. Status `2` (PRODUCTION) but no actions → the calling contract isn't sending
   instructions, or the `(opType, opCommand)` doesn't match `app/config.ts`.

## 7. Mindorr op identifiers

`app/config.ts` op strings must match the `bytes32` constants in the instruction-sending
contract exactly, or actions fall through to `unsupported op type`:
`WALLET/UPDATE_KEY`, `VAULT/SET_POLICY`, `VAULT/ALLOCATE`, `VAULT/REBALANCE`,
`VAULT/WITHDRAW`. See [`ARCHITECTURE.md`](ARCHITECTURE.md).
