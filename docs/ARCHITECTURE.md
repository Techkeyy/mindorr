# Mindorr — Architecture

## The one idea

Flare Confidential Compute lets a signing key live **inside** a TEE (Trusted Execution
Environment) and never leave — Flare's `fce-sign` example proves it. Mindorr adds the
missing half: **a policy + destination allowlist, enforced inside the same enclave, that
gates every signature.** The enclave will only sign a transfer to (a) a pre-approved
lending vault, or (b) the owner's own return address. That is the whole trust story.

```
        proposes (no funds)                 gated by policy.ts                 settles
  You ───────────────────▶ Brain ─────────▶  Mindorr TEE extension ─────────▶ Flare Coston2
 (chat)                  (off-chain)     (holds key · evaluates · signs)   (vaults / FXRP / FTSO)
```

## Process topology

Two-process container (the standard non-Go shape from the FCC extension contract):

- **tee-node** (`server` binary) — Flare infra. Holds crypto, polls the proxy for
  actions, signs the `ActionResult`, exposes the crypto API on `SIGN_PORT`.
- **Mindorr extension** (TypeScript) — serves `POST /action` and `GET /state` on
  `EXTENSION_PORT`. Decodes each instruction, runs `evaluateIntent`, and only then asks
  the in-enclave key to sign.

The container dies if either child dies. `MODE=1` = simulated attestation (local dev and
accepted for hackathon judging); `MODE=0` = production attestation.

## Operations (opType / opCommand)

Every instruction arrives on-chain via a contract calling the instruction sender, is
routed to Mindorr by its `(opType, opCommand)` bytes32 pair, and carries a payload in
`originalMessage`.

| opType | opCommand | Autonomous? | What it does |
| --- | --- | --- | --- |
| `WALLET` | `UPDATE_KEY` | n/a (setup) | Deliver the managed wallet's key, encrypted to the TEE. Decrypted via the node, held only in enclave memory. Mirrors `fce-sign`. |
| `VAULT` | `SET_POLICY` | ❌ owner-signed | Set/replace the owner's `Policy` (risk level, allowlist, return address, caps). |
| `VAULT` | `CONFIRM_DEPOSIT` | n/a (proof-gated) | Verify, via an FDC `Payment` proof, that the user's XRP actually arrived (right recipient, amount, reference) before FXRP is credited. Gates the on-chain `executeMinting`. |
| `VAULT` | `ALLOCATE` | ✅ | Deposit FXRP into an **allowlisted** vault, within the concentration cap. |
| `VAULT` | `REBALANCE` | ✅ | Move between allowlisted vaults while keeping health ≥ the floor. |
| `VAULT` | `WITHDRAW` | ❌ owner-signed | Redeem and return FXRP **only** to the owner's return address. |

The autonomy column is enforced in [`policy.ts`](../extension/typescript/src/app/policy.ts):
`allocate`/`rebalance` need no signature; `withdraw` requires `userAuthorized === true`
*and* the destination to equal `returnAddress`.

## The guard (`policy.ts`)

`evaluateIntent(policy, intent) → { allow, code, reason }`, checked in order:

1. `ZERO_AMOUNT` — amount must be > 0
2. `ASSET_NOT_ALLOWED` — must be the managed asset (FXRP)
3. `AMOUNT_EXCEEDS_CAP` — per-tx blast-radius cap
4. `DEST_NOT_ALLOWED` — allocate/rebalance venue must be on the allowlist
5. `VENUE_CONCENTRATION` — projected venue share ≤ `maxVenueBps`
6. `HEALTH_FACTOR` — rebalance must keep health ≥ `minHealthFactorBps`
7. `NEEDS_USER_SIGNATURE` — withdrawals require a fresh owner signature
8. `WITHDRAW_NON_RETURN` — withdrawals may only target the return address

The handler signs **only** when `allow` is true. Because the guard is pure, the full
matrix is unit-tested off-chain (`src/__tests__/policy.test.ts`) — no chain required.

## What talks to the chain

- **FXRP / FAssets** — mint from a proven XRP deposit; deposit/withdraw against vaults.
- **FDC** (`FdcHub` / `Fdc2Hub`) — `Payment` attestation proves the user's XRP deposit
  actually happened before any FXRP is minted.
- **FTSO** (`FtsoTestXrp`, `FtsoTestUsdc`) — prices for valuation, concentration, and
  rebalance triggers.
- **FCC facets** (`WalletManagerFacet`, `InstructionsFacet`, `FlareTeeManager`) — the
  managed-wallet + instruction plumbing.

Addresses: [`extension/config/coston2/mindorr-addresses.json`](../extension/config/coston2/mindorr-addresses.json).
