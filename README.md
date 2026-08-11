# Mindorr

**An XRP agent you can hand your keys to, because it has none to steal.**

Mindorr is a confidential, non-custodial agent that puts idle XRP to work. You tell it what
you want in plain English; the strategy runs inside a **Flare Confidential Compute (FCC)**
enclave that holds a signing key we can never see, and it moves funds only through rules it
checks *before* every signature. Built for the **Flare Summer Signal** hackathon, targeting
both the **Confidential Compute** and **Interoperable Assets** bounties.

Most "AI money" projects demo a vault UI. Mindorr is a TEE that actually **holds and moves
the asset**, and every claim below is a live Coston2 transaction you can open.

---

## Proof first (all on Flare Coston2)

The whole loop is real: a confidential agent signs a guard-approved action → an on-chain
vault independently verifies that signature and the allowlist → real FXRP (minted from a
real XRPL payment via Flare's Data Connector) moves.

| What | On-chain evidence |
| --- | --- |
| **Real value moved, released only by the enclave signature** | `execute()` tx [`0xf690cca5…45dac7`](https://coston2-explorer.flare.network/tx/0xf690cca5ccef66f66bf896ab42a74bf77624859b2fd86026090ee258b145dac7) — 1 FXRP vault→venue, `ActionExecuted(signer = managed wallet)` |
| **Real FXRP minted** from an XRPL payment via FDC | `executeMinting` [`0x3ca96a6f…f2adec`](https://coston2-explorer.flare.network/tx/0x3ca96a6fdeb503f36ee17b0c656bb4283100535628710aac1255ec4400f2adec) ← XRPL testnet payment `B4E7A8D5…09F6D7` |
| **Enclave signs a guard-approved allocation** | instruction tx [`0xe849b3f0…dd8f5a`](https://coston2-explorer.flare.network/tx/0xe849b3f00e4f52fbdbfa4dc4fed074baf867ec826996297fe08b828836dd8f5a) |
| **Enclave REFUSES a malicious allocation** (to an un-allowlisted address) | instruction tx [`0x861c6745…5f270`](https://coston2-explorer.flare.network/tx/0x861c6745702eeb7a3538c76f1ecad7626eb95a0517feb3afa3bc4c8df1d5f270) → `DEST_NOT_ALLOWED`, no signature produced |
| **TEE registered, PRODUCTION** | [`FlareTeeManager`](https://coston2-explorer.flare.network/address/0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE) `0x1a9C4A…7618aE`, extension **66157** |
| **On-chain verifier** (recovers the enclave sig, re-enforces the allowlist) | [`MindorrVault`](https://coston2-explorer.flare.network/address/0x64CA30780Cf7ecA918C667bebbabB5F833Ee58fc) `0x64CA30…Ee58fc` |
| **On-chain instruction entry point** | [`InstructionSender`](https://coston2-explorer.flare.network/address/0xf2170a0EBD84Bdf18F1b973A67d95F590F7Cc0f4) `0xf2170a…Cc0f4` |
| Enclave signing wallet (managed) | `0x71562b71999873DB5b286dF957af199Ec94617F7` |
| FXRP (FAssets, Coston2) | [`0x0b6A3645…73dc7`](https://coston2-explorer.flare.network/address/0x0b6A3645c240605887a5532109323A3E12273dc7) |

## Why this exists

An autonomous money agent was always one of two bad things: **custodial** (someone holds
your keys) or **not autonomous** (you sign every transaction). 2B+ XRP sits idle partly for
this reason. FCC's in-enclave key breaks the trade-off: the key is generated and used
*inside* attested hardware and never leaves.

Mindorr's one novel addition on top of Flare's `fce-sign` primitive is the **policy +
destination allowlist enforced inside the enclave**
([`extension/typescript/src/app/policy.ts`](extension/typescript/src/app/policy.ts)): the
agent will only sign a transfer to (a) a pre-approved vault, or (b) your own return address.
A compromised or hijacked brain still cannot move your money anywhere else, and
[`MindorrVault`](extension/contracts/MindorrVault.sol) re-enforces the same allowlist
on-chain as defense in depth.

## How it works

```
plain English  →  enclave sets policy (allowlist + caps)
               →  deposit XRP  →  FDC proves it  →  mint FXRP (FAssets)  →  held by the enclave's vault
               →  agent proposes an allocation  →  guard checks it INSIDE the enclave  →  signs only if allowed
               →  MindorrVault.execute() recovers the signature to the managed wallet, re-checks the allowlist, moves FXRP
```

The signing key never leaves the enclave; the guard lives where a compromised brain can't
reach it; and the vault verifies everything again on-chain.

## How I tried to break it

A guard is only trustworthy if you tried to make it say the wrong thing. Every case below is
a test, and the first two are **real refused transactions** on Coston2:

| Attack | Result | Enforced |
| --- | --- | --- |
| Allocate to an un-allowlisted venue (`0xdead…beef`) | Refused `DEST_NOT_ALLOWED`, no signature | enclave ([tx](https://coston2-explorer.flare.network/tx/0x861c6745702eeb7a3538c76f1ecad7626eb95a0517feb3afa3bc4c8df1d5f270)) **and** `MindorrVault` reverts `VenueNotAllowed` |
| Withdraw to an attacker address | Refused `WITHDRAW_NON_RETURN` | enclave **and** vault reverts `NotReturnAddress` |
| Amount above the per-tx cap | Refused `AMOUNT_EXCEEDS_CAP` | enclave guard |
| Forged / wrong-key signature at the vault | Reverts `BadSigner` | `MindorrVault` ecrecover |
| Replay a used signature | Reverts `Replay` | `MindorrVault` used-digest set |

Covered by `extension/typescript` unit tests (guard + signer) and `forge test` (6/6, the
on-chain verifier). See the guard: [`policy.ts`](extension/typescript/src/app/policy.ts).

## Reproduce / verify it yourself

**No keys, no chain (the trust core):**
```bash
cd extension/typescript && npm ci && npm test     # guard + in-enclave signer
cd .. && forge test                                # MindorrVault: 6/6
```

**The real on-chain loop** (full walkthrough in
[`docs/REAL-INTEGRATION-PLAN.md`](docs/REAL-INTEGRATION-PLAN.md) and
[`docs/RUNBOOK.md`](docs/RUNBOOK.md)):
1. Bring up the enclave (GitHub Codespace) → register the TEE to PRODUCTION.
2. `app/mint/reserve.mjs` → `pay.mjs` (XRPL) → `execute-minting.mjs` — mint FXRP into the vault via FAssets + FDC.
3. `ALLOC_AMOUNT=1000000 ./scripts/test.sh` — the enclave signs a 1-FXRP allocation, refuses a malicious one.
4. `MindorrVault.execute(...)` with that signature — moves the FXRP for real.

## What it does, and what it does not (yet)

- **Real:** the TEE + guard, the on-chain verifier, and the mint→sign→execute loop above are
  all live on Coston2 (see the proof table).
- **Simulated for the demo:** the chat UI (`app/`) is a clear, labeled **simulation** of the
  fund flow for legibility; the *real* fund movement is the scripted mint + `execute()` proven
  on-chain. Wiring the chat to drive the live enclave per message is **roadmap**.
- **Testnet shortcuts:** `SIMULATED_TEE=true` (accepted for judging; real GCP Confidential
  Space is roadmap); the "venue" is a receiving address standing in for a live yield vault;
  the managed key is delivered to the enclave (fce-sign model) rather than enclave-generated.

## Repository layout

| Path | What it is |
| --- | --- |
| `extension/typescript/src/app/policy.ts` | **The trust core** — the in-enclave policy + allowlist guard. Pure, unit-tested. |
| `extension/contracts/MindorrVault.sol` | On-chain verifier: recovers the enclave signature + re-enforces the allowlist. |
| `extension/contracts/InstructionSender.sol` | On-chain entry point for the WALLET/VAULT ops. |
| `extension/tools/cmd/run-test` | Driver that exercises the live enclave (set-policy → key → allocate → refuse). |
| `app/mint/` | The FXRP mint (reserve → XRPL pay → FDC attest → executeMinting). |
| `app/` | Next.js chat + `/verify` proof page. |
| `docs/` | [`REAL-INTEGRATION-PLAN.md`](docs/REAL-INTEGRATION-PLAN.md), [`RUNBOOK.md`](docs/RUNBOOK.md), [`ARCHITECTURE.md`](docs/ARCHITECTURE.md) |

Everything targets **Flare Coston2**; addresses in
[`extension/config/coston2/mindorr-addresses.json`](extension/config/coston2/mindorr-addresses.json).
