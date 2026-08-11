# Real integration plan — build-process applied

Living tracker for taking Mindorr from a narrated simulation to **real on-chain
execution** (full FAssets mint + live enclave signing from the chat app). This is
the checker we grade progress against. Update the status boxes as each phase lands;
do not delete the reasoning — the "why" is what keeps us honest.

Skills this is run through: `build-process` (build the risky core first, verify
against reality, additive/honest) and `project-edge` (finishing lens). Both live in
`~/Desktop/skill/`.

Chosen scope (user decision, 2026-08-11): **full real FXRP mint** + **live from the
chat app** (not recorded, not a test token). The two hardest options.

---

## Pipeline

```
deposit (XRPL)  →  mint (FAssets)  →  sign (enclave guard)  →  execute (MindorrVault)  →  report (chat + /verify)
```

---

## Phase 0 — the load-bearing module

The one module everything's trust depends on, and the one least sure end-to-end:

> **Does a signature from the *real* enclave recover to the registered managed
> wallet inside `MindorrVault.execute()` on live Coston2?**

That is the whole confidential-custody claim. Everything else is plumbing.

- [ ] Load-bearing question answered with a real on-chain tx.

## Phase 1 — prove the risky core first (cheapest real signal)

Half is **already proven in isolation**: `forge test` (6/6) shows `execute()`
recovers a test key's signature and reverts on a foreign dest. The only unproven
link is whether the **live enclave's** signature over `actionDigest` matches
byte-for-byte what `ecrecover` expects.

First real move once the enclave is back — a single live proof, **before** the mint
or app wiring:

- [ ] Enclave signs one known `actionDigest` (via `POST /action`).
- [ ] Deploy `MindorrVault`; `registerAccount(managedWallet, returnAddress, FXRP)`.
- [ ] `execute()` with that signature **succeeds**; emits `ActionExecuted`, signer == managedWallet.
- [ ] Tampered / foreign-dest `execute()` **reverts** (`VenueNotAllowed` / `NotReturnAddress` / `BadSigner`).

Gate: **do not build the mint or the app wiring until the above is green.** Hour one,
not day three.

## Phase 6 — doctor-check the mint before coding it

Already earned its keep: a `getAgentInfo` ABI guess returned garbage — the exact
"shape differs from what you coded against" trap. Before writing
`reserveCollateral` / `executeMinting`:

- [ ] Read-only `doctor` against the live `AssetManagerFXRP` (`0xc1Ca88…bDFA`):
  `getSettings` (lot size, fee), `getAvailableAgentsDetailedList`, collateral
  reservation fee. Confirm every struct shape against reality.
- [x] Confirmed 4 FXRP minting agents are live on Coston2 (mint is feasible).
- [ ] No assumed ABIs anywhere in the mint module.

## Phase 4/5 — make the environment stop fighting us

Config corruption + hand-configuring the Codespace **is** the rebuild churn. Fix:
reproducible, one-command bring-up that doubles as the deliverable.

- [x] `write-proxy-config.sh` — proxy config from env, no hand-edited heredoc.
- [x] RUNBOOK rewritten to the path that actually worked (real indexer, 6664→6674, exact post-build).
- [ ] `.devcontainer/devcontainer.json` — committed, forwards 6674, Docker-in-Docker.
- [ ] One-command bring-up wrapper (use-chain → write-proxy-config → pre/start/post-build).

## Phase 7 — additive, never break the demo

- [ ] Real path behind a `MINDORR_LIVE` flag; in-memory sim stays the default.
- [ ] If the enclave sleeps, chat still works (graceful degrade).
- [ ] Guard every external call (enclave POST, RPC, mint) so a failure never crashes the main path.

---

## project-edge — finishing lens (later) + one guardrail NOW

Run before submission: claim-audit → cross off rubric → differentiate → adversarial
table → present.

**Guardrail that bites immediately:** as we move from sim to real, **site copy must
stay true.** The landing currently implies real fund movement; the moment that isn't
literally true it is a claim-vs-reality bug. Label sim vs live until the real path is
proven.

- [ ] Landing/verify copy audited against what is literally true at each step.

---

## Known blockers / externals (user-supplied)

- [ ] Codespace enclave **back up** and 6674 public (currently asleep — `/info` 404s).
- [ ] Funded Coston2 key (gas: deploy, reserve, mint, per-message `execute`).
- [ ] XRPL **testnet** wallet with test XRP (the mint's middle step is a real payment).
- [ ] Relayer key in Vercel for live `execute()` per message (user sets; never handled here).

## On-chain facts (already true)

| | |
|---|---|
| TEE machine ID | `0x4A47F54fC5C8f1e6321Ea29c47f5D33EF1d05056` |
| Extension ID | `66129` |
| Status | PRODUCTION (code 2) |
| FlareTeeManager | `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` |
| FXRP | `0x0b6A3645c240605887a5532109323A3E12273dc7` (6dp) |
| AssetManagerFXRP | `0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA` |
