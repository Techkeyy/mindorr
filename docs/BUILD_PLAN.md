# Mindorr — Build Plan

**An XRP agent you can hand your keys to — because it has none to steal.**

Target: **Flare Summer Signal**, both bounties (Confidential Compute + Interoperable
Assets). Ship by **Aug 14**. Network: **Coston2**.

## What we're building (plain English)

Most people's XRP sits idle — earning yield means a new wallet, bridging, gas tokens, and
DeFi screens nobody wants to learn; the shortcut (a custodial yield platform) means
trusting a company with your coins. Mindorr is a money-manager you *talk to*: "put my XRP
to work, nothing risky." It wraps XRP into **FXRP**, spreads it across safe lending vaults,
and rebalances — all inside a sealed enclave that (1) never holds your keys and (2) never
exposes your positions on the public chain.

## Why it's not a yield bot

An autonomous money agent used to be either **custodial** (someone holds your keys) or
**not autonomous** (you sign everything). Flare's in-enclave key breaks that; Mindorr's
one novel addition is the **in-enclave policy + allowlist** — funds can only ever reach an
approved vault or your own return address. See [`ARCHITECTURE.md`](ARCHITECTURE.md).

## Autonomy boundary (the line that keeps it honest)

| Autonomous — no human | Needs your signature |
| --- | --- |
| Mint FXRP from an FDC-proven deposit | Withdraw to any external address |
| Allocate across **approved** vaults, within risk policy | Change the policy / risk / caps |
| Rebalance when thresholds cross | Whitelist a new venue |
| Harvest & compound rewards | Move funds outside the approved set |

## Phases (Aug 1 → Aug 14)

Sequenced so the hard, un-fakeable core lands first. If we fall behind we cut product
polish, never the trust primitive.

| Phase | Dates | Ships | Proof | Status |
| --- | --- | --- | --- | --- |
| **P0** Spine | Aug 1–2 | Scaffold + tee-node/tee-proxy, named cloudflared tunnel, register on live `FlareTeeManager 0x1a9C…18aE` | TEE reaches PRODUCTION; hello-world round-trips | ⏳ |
| **P1** Sealed wallet | Aug 3–5 | In-enclave key (UPDATE_KEY) + gated signing | A Coston2 tx lands whose key never left the TEE | 🔨 core guard done |
| **P2** FXRP in | Aug 5–7 | FDC `Payment` attestation → mint FXRP to the managed wallet | Real deposit proof mints FXRP | ⏳ |
| **P3** Put to work | Aug 7–10 | In-enclave policy engine + one lending vault; FTSO rebalance trigger | Agent deposits then rebalances on its own | 🔨 policy engine done |
| **P4** The chat | Aug 10–12 | Next.js chat, intent→policy, withdrawal w/ sign-off | "Put my XRP to work, low risk" → funds working | ⏳ |
| **P5** Prove it | Aug 12–13 | Attestation/verify page; "malicious instruction bounces" demo | Positions invisible on-chain; rug attempt blocked live | 🔨 bounce cases unit-tested |
| **P6** Ship | Aug 13–14 | 3-min video, README + addresses, "new vs integrated" writeup, roadmap | Submitted on DoraHacks | ⏳ |

Legend: ✅ done · 🔨 in progress · ⏳ not started.

## Done so far

- Monorepo scaffolded on Flare's real `fce-extension-scaffold` (TypeScript path).
- **Trust core** ([`policy.ts`](../extension/typescript/src/app/policy.ts)) implemented:
  policy + destination allowlist guard, autonomy boundary, concentration + health caps.
- **68/68 tests green** (43 scaffold conformance + 14 Mindorr policy + 11 base) via
  `npm test`, including the malicious-instruction-bounces cases. No chain required.
- Coston2 addresses pinned; RUNBOOK with the live-deployment gotchas.

## If we fall behind — cut list

- `SIMULATED_TEE` / `MODE=1` is accepted for judging — GCP Confidential Space is off the
  critical path.
- One vault, not many.
- Mock the mint if FAssets-on-Coston2 fights us — keep the FDC deposit *proof* real.
- Threshold rebalance, not clever optimization.

## New vs. integrated (for judges)

- **Newly built:** the in-enclave policy + allowlist guard, the gated signing path, the
  FDC→FXRP mint trigger, the chat brain.
- **Integrated:** FAssets/FXRP, FTSO feeds, a Morpho-style lending market, Flare's
  `fce-sign`/scaffold + `tee-node`.
- **The point:** FXRP and confidential yield exist elsewhere — *a non-custodial
  autonomous agent that can hold XRP does not yet exist on Flare.*
