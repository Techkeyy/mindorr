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

## 2. Build & pre-build (fresh EXTENSION_ID)

The redeploy may have wiped registrations. Re-run pre-build for a fresh `EXTENSION_ID`,
then post-build. Select the TypeScript language path (`LANGUAGE=typescript`).

## 3. Register the TEE

```bash
# capital R = fresh challenge
register-tee -command rRap
```

Then confirm state against the **live** manager:

```bash
# is the on-chain URL the one you're serving right now?
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachine(address)((address,address,string))" <teeId>

# 1 = INITIALIZED, 2 = PRODUCTION
cast call 0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE \
  "getTeeMachineStatus(address)(uint8)" <teeId>
```

A simulated TEE reaches **PRODUCTION** in seconds on a current stack. Stuck at
`INITIALIZED` almost always means the on-chain URL is dead (see §4).

## 4. Tunnel — do NOT use a quick tunnel

Data providers push actions to the URL stored on-chain. `trycloudflare` quick-tunnel
hostnames change on restart, so the on-chain URL goes dead and the machine stalls at
`INITIALIZED`. Use a **named** cloudflared tunnel or a **reserved** ngrok domain. If the
tunnel rotates, update `EXT_PROXY_URL` and re-run post-build.

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
