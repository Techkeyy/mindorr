# Mindorr — Deploy & Register (Coston2)

Two things must go on-chain: **(A)** the `MindorrVault` verifier contract, and
**(B)** the TEE extension itself, registered on the live `FlareTeeManager`.

> **Keys:** Mindorr's tooling never handles your private key. You run the write
> commands yourself with a **funded Coston2 key** in your environment. Nothing in
> this repo stores or transmits it.

## 0. Verify locally first (no key, no chain)

```bash
cd extension/typescript && npm test        # 63/63 — enclave signer + guard
cd .. && forge test                          # 6/6 — on-chain verifier
```

## A. Deploy the vault verifier

Prereqs: a funded Coston2 deployer key (needs C2FLR for gas — Coston2 faucet),
your enclave wallet address (printed by `WALLET/UPDATE_KEY` and in `GET /state`),
and your own return address.

```bash
export DEPLOYER_KEY=0x...        # funded Coston2 key
export MANAGED_WALLET=0x...      # enclave wallet address
export RETURN_ADDR=0x...         # your address — the ONLY withdrawal target
export VENUE=0x...               # optional: a lending vault to allowlist
bash scripts/deploy-coston2.sh
```

This deploys `MindorrVault`, calls `registerAccount(managedWallet, returnAddress, FXRP)`,
and optionally `setVenue(venue, true)`. FXRP on Coston2 is pinned to
`0x0b6A3645c240605887a5532109323A3E12273dc7` (verified live).

Verify the deployment read-only:

```bash
cast call <VAULT> "accounts(address)(address,address,address,bool)" <YOUR_OWNER_ADDR> \
  --rpc-url https://coston2-api.flare.network/ext/C/rpc
```

## B. Register the TEE extension

The confidential extension is registered separately on the FCC stack. Full steps
and the live-deployment gotchas are in [`RUNBOOK.md`](RUNBOOK.md):

1. Pre-build for a fresh `EXTENSION_ID`, then post-build (RUNBOOK §2).
2. `register-tee -command rRap` against live `FlareTeeManager`
   `0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE` (RUNBOOK §3).
3. Serve the extension behind a **named** cloudflared tunnel — never a quick
   tunnel (RUNBOOK §4).
4. `SIMULATED_TEE=true` / `MODE=1` is accepted for judging (RUNBOOK §5).
5. Confirm PRODUCTION with `check-tee-state` (RUNBOOK §6).

## C. Mint FXRP from an XRP deposit (P2)

The confidential half — verifying the deposit — runs in the enclave
(`VAULT/CONFIRM_DEPOSIT`, backed by [`fdc.ts`](../extension/typescript/src/app/fdc.ts)).
The on-chain half is a normal FAssets flow against `AssetManagerFXRP`
`0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA`:

1. Reserve a mint with an agent (`reserveCollateral`) → get the agent's XRPL
   address + payment reference.
2. Pay XRP on the XRPL testnet to that address with the reference.
3. Request an FDC `Payment` attestation for that XRPL tx; retrieve the proof.
   The enclave validates it via `CONFIRM_DEPOSIT` before crediting anything.
4. Submit the proof on-chain:

```bash
cast send 0xc1Ca88b937d0b528842F95d5731ffB586f4fbDFA \
  "executeMinting((bytes32[],(bytes32,bytes32,uint64,uint64,(bytes32,uint256,uint256),(...))) ,uint256)" \
  <PROOF> <CRT_ID> --rpc-url "$RPC" --private-key "$DEPLOYER_KEY"
```

FXRP (`0x0b6A3645…73dc7`, 6 decimals) is minted to the minter. Amounts are in
drops (1 XRP = 1,000,000), which lines up 1:1 with FXRP's 6 decimals.

## End-to-end sanity check (the demo)

1. `WALLET/UPDATE_KEY` → enclave holds a key; note the wallet address.
2. `VAULT/SET_POLICY` → allowlist + return address set (mirror on-chain via
   `registerAccount` / `setVenue`).
3. `VAULT/ALLOCATE` to an allowlisted vault → enclave returns a signature →
   `MindorrVault.execute(...)` moves FXRP. ✅
4. `VAULT/ALLOCATE` to a **foreign** address → enclave refuses (no signature);
   and even a forged call to `execute(...)` reverts `VenueNotAllowed`. ✅
5. `VAULT/WITHDRAW` to your return address → signs + settles; to anywhere else →
   refused off-chain and reverts `NotReturnAddress` on-chain. ✅
