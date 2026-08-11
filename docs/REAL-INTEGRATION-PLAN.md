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

**Reframe after reading the code (2026-08-11):** the sign→execute *logic* is already
proven to high confidence by inspection + existing tests, so this core risk is largely
retired:
- `forge test` (6/6) proves `execute()` recovers a **viem-signed** digest and enforces
  the allowlist / return-address.
- `wallet.ts` shows the enclave signs with the **identical** viem primitive
  (`privateKeyToAccount(k).sign({ hash })`) over the **identical** `actionDigest`
  (`codec.ts`). Same bytes in, same signature format out — so the "does the live
  enclave's sig match what ecrecover expects" risk is essentially zero.

So the genuine remaining risk is **not** the crypto — it is the **on-chain round-trip**:
send a Mindorr op instruction → InstructionSender → enclave executes → retrieve the
result. No Mindorr driver exists yet (`run-test` only sends the scaffold's
`SAY_HELLO`/`SAY_GOODBYE`; those now fail since `handlers.ts` only registers WALLET/VAULT
ops). The `WALLET/UPDATE_KEY` step needs the signing key **encrypted to the TEE pubkey**
(node `/decrypt`), whose encrypt-and-deliver pattern lives in the **fce-sign reference**
(`reference/fce-sign/go/tools/{cmd/run-test,pkg/utils/instructions.go}`).

Revised Phase 1 proof (belt-and-suspenders live confirmation + the app→enclave wiring
we need anyway):

- [x] sign→execute logic proven in isolation (forge 6/6 + shared viem primitive).
- [x] `InstructionSender.sol` rewritten for Mindorr ops (`sendUpdateKey`/`sendSetPolicy`/
  `sendAllocate`/`sendWithdraw`/…). Kept the scaffold contract name + `helloworld` pkg so
  binding-gen/deploy/register tooling is untouched. **Compiles ✓** (verified in the ABI).
- [x] `tools/pkg/utils/instructions.go`: replaced hello senders with `SendSetPolicy`/
  `SendUpdateKey`/`SendAllocate`/`SendWithdraw` (DRY helper). *Pending Codespace `go build`.*
- [x] `tools/cmd/run-test`: Phase-1 driver — `VAULT/SET_POLICY` round-trip proof
  (no key). *Pending Codespace run.*
- [x] **Codespace GREEN (2026-08-11):** `go build` clean; redeployed; `./scripts/test.sh`
  → `SET_POLICY response: riskLevel=conservative allowedVenues=1` → **Phase 1 round-trip
  GREEN**. Real tx `0x5b46a8a2…`, instruction `0x6fb15764…`. The on-chain→enclave→result
  path works for Mindorr ops.
- [x] `run-test` extended to the full Phase-1 proof: SET_POLICY → UPDATE_KEY
  (ECIES to the TEE pubkey) → ALLOCATE (capture + local ecrecover of the real enclave
  sig, digest recomputed independently) → malicious ALLOCATE (expect refusal). Payloads
  verified against the real `policy.ts` guard (allowed passes, attacker → DEST_NOT_ALLOWED).
  *Pending Codespace run — Go only, no re-registration needed.*
- [x] **Phase 1 COMPLETE on live enclave (2026-08-11).** Real txs: SET_POLICY `0x2dba08d3…`,
  UPDATE_KEY `0xdd7220a3…` (managed wallet `0x71562b71999873DB5b286dF957af199Ec94617F7`),
  ALLOCATE `0xa7bce239…` (sig recovers to managed wallet ✓), malicious ALLOCATE `0x16a109e3…`
  (refused `DEST_NOT_ALLOWED` ✓). Captured signature:
  `0x2e5f496fa626519d56eb7844743172301c7d34d8390df5cef127ca6b820ce6d02564795bfb958b7b941b6e6d4e939d6a65d8775162d4a0f8e05f8bdfe40c486c1c`.
- [x] Added `previewExecute` view to `MindorrVault` (recover + allowlist, no transfer).
  Compiles; forge tests still 6/6.
- [x] **PROVEN ON-CHAIN (2026-08-11).** `MindorrVault` deployed at
  `0x64CA30780Cf7ecA918C667bebbabB5F833Ee58fc`; `registerAccount` + `setVenue` done.
  `cast call previewExecute(...)` with the real enclave sig →
  **`true / 0x71562b71999873DB5b286dF957af199Ec94617F7 / "ok"`**. The enclave signature
  clears the on-chain verifier: recovered == managed wallet, allowlist enforced.
- [ ] Full `execute()` with real FXRP transfer — needs the mint (next).

## Phase 0/1 STATUS: COMPLETE. The confidential-compute core is real, both off-chain
## (Go ecrecover) and on-chain (MindorrVault.previewExecute). Gate cleared — build the mint.

**Live coordinates after the redeploy (volatile — regenerate on each rebuild):**
InstructionSender `0xf2170a0EBD84Bdf18F1b973A67d95F590F7Cc0f4`, extension **66157**,
TEE `0xbbCeDc053C31adCE49D8DbC57640bD1a9A13528c` (PRODUCTION). NOTE: the app's
`coston2.ts` still hardcodes the OLD TEE `0x4A47…` — update it (and /verify) only after
the FINAL registration, since start-services regenerates the enclave key (new TEE ID) each
rebuild. project-edge claim-audit must catch this before submission.
- [ ] `WALLET/UPDATE_KEY`: encrypt a secp256k1 key to the TEE, deliver, confirm
  `walletAddress` in `/state`.
- [ ] `VAULT/ALLOCATE` → capture the real enclave signature + digest.
- [ ] Deploy `MindorrVault`; `registerAccount(managedWallet, returnAddress, FXRP)` + `setVenue`.
- [ ] Live `execute()` with the real enclave sig **succeeds**; tampered dest **reverts**.

Gate: do not build the FAssets mint until the live round-trip + execute is green.

## Phase 6 — doctor-check the mint before coding it

Already earned its keep: a `getAgentInfo` ABI guess returned garbage — the exact
"shape differs from what you coded against" trap. Before writing
`reserveCollateral` / `executeMinting`:

- [x] Confirmed 4 FXRP minting agents are live on Coston2 (mint is feasible).
- [x] `AssetManagerFXRP` is an **EIP-2535 diamond** proxy; impl `0xac15ba84…45a6`.
  `getabi` returns the diamond ABI, not the minting fns — those come from Flare's
  `IAssetManager` user interface, exposed via the diamond fallback.
- [x] Pulled the **canonical** minting ABI from `flare-foundation/fassets` (below).
- [ ] Verify those signatures against the **deployed** diamond (versions differ —
  `main`'s `reserveCollateral` has 4 params, older ones add `_minterUnderlyingAddresses`).
  Read-only doctor: `getSettings`, `collateralReservationFee(1)`,
  `getAvailableAgentsDetailedList(0,10)` return sane data; diamond loupe confirms the
  `reserveCollateral`/`executeMinting` selectors exist.
- [ ] No assumed ABIs anywhere in the mint module.

### Canonical mint ABI (from fassets `main` — VERIFY against deployed before use)

```solidity
// AssetManagerFXRP = 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA (diamond)
function reserveCollateral(address _agentVault, uint256 _lots, uint256 _maxMintingFeeBIPS,
    address payable _executor) external payable returns (uint256 _collateralReservationId);
function executeMinting(IPayment.Proof _payment, uint256 _collateralReservationId) external;
function collateralReservationFee(uint256 _lots) external view returns (uint256 _feeNATWei);
function getAvailableAgentsDetailedList(uint256 _start, uint256 _end) external view
    returns (AvailableAgentInfo.Data[] _agents, uint256 _totalLength);
function getSettings() external view returns (AssetManagerSettings.Data);
// settings fields we use: lotSizeAMG, assetMintingDecimals, assetMintingGranularityUBA,
//                         collateralReservationFeeBIPS, mintingCapAMG

// The mint's heart — carries the agent's XRPL address + payment reference:
event CollateralReserved(address indexed agentVault, address indexed minter,
    uint256 indexed collateralReservationId, uint256 valueUBA, uint256 feeUBA,
    uint256 firstUnderlyingBlock, uint256 lastUnderlyingBlock, uint256 lastUnderlyingTimestamp,
    string paymentAddress, bytes32 paymentReference, address executor, uint256 executorFeeNatWei);
event MintingExecuted(address indexed agentVault, uint256 indexed collateralReservationId,
    uint256 mintedAmountUBA, uint256 agentFeeUBA, uint256 poolFeeUBA);
```

Mint flow: `reserveCollateral` (pay fee in NAT) → read `CollateralReserved` for
`paymentAddress` + `paymentReference` + `valueUBA` → **pay that XRP on XRPL testnet with
the reference** → FDC `Payment` attestation for the XRPL tx → `executeMinting(proof, crtId)`
→ FXRP minted to the minter.

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
