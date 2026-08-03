# Mindorr

**An XRP agent you can hand your keys to — because it has none to steal.**

Mindorr is a confidential, non-custodial agent that puts idle XRP to work. You tell it
what you want in plain English ("put my XRP to work, nothing risky"); it wraps your XRP
into **FXRP**, allocates it across approved lending vaults, and rebalances over time —
all inside a **Flare Confidential Compute (FCC)** enclave, so:

1. **It never holds your keys.** The signing key is born inside the TEE and never leaves.
   No custodian exists to lose or misuse your funds.
2. **Nobody can see your positions.** Balances and strategy live inside the sealed
   enclave; only settlement touches the public chain.

Built for the **Flare Summer Signal** hackathon — targeting both the *Confidential Compute*
and *Interoperable Assets* bounties.

---

## Why this is not "another yield bot"

Until now an autonomous money agent was always one of two bad things: **custodial**
(someone holds your keys) or **not autonomous** (you sign every transaction). FCC's
in-enclave key breaks that trade-off. Mindorr's one novel addition on top of Flare's
`fce-sign` primitive is the **policy + destination allowlist enforced inside the enclave**:
the agent will only sign a transfer to (a) a pre-approved vault, or (b) your own return
address. A compromised brain still cannot move your money anywhere else — see
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

## Repository layout

| Path | What it is |
| --- | --- |
| `extension/` | The FCC extension (TypeScript), built on Flare's `fce-extension-scaffold`. The confidential core. |
| `extension/typescript/src/app/policy.ts` | **The trust core** — the policy + allowlist guard. Pure, unit-tested. |
| `app/` | Next.js chat brain + UI (intent → policy). *In progress.* |
| `docs/` | [`BUILD_PLAN.md`](docs/BUILD_PLAN.md), [`ARCHITECTURE.md`](docs/ARCHITECTURE.md), [`RUNBOOK.md`](docs/RUNBOOK.md) |
| `reference/` | Upstream Flare repos (`fce-sign`, scaffold, shielded-transfers) cloned for study. Git-ignored. |

## Network

Everything targets **Flare Coston2** testnet. Live `FlareTeeManager`:
`0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE`. Key contract addresses are in
[`extension/config/coston2/mindorr-addresses.json`](extension/config/coston2/mindorr-addresses.json).

## Status

Early build. See [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md) for the phase-by-phase plan
and what is done vs. pending.
