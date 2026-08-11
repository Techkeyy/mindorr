// mint/execute-minting.mjs — Step 3 of the FXRP mint.
//
// Takes the XRPL payment (mint/payment.json) through the FDC Payment attestation
// and calls executeMinting, then moves the minted FXRP into MindorrVault so the
// guarded execute() can transfer it for real.
//
// Flow: prepareRequest (verifier) -> requestAttestation (FdcHub, pay fee) ->
// wait for the voting round -> proof-by-request-round (DA layer) ->
// executeMinting(proof, crtId) -> transfer FXRP -> vault.
//
// Run:
//   cd /workspaces/mindorr/app/mint && npm install
//   DEPLOYMENT_PRIVATE_KEY=$(grep '^DEPLOYMENT_PRIVATE_KEY=' ../../extension/.env | cut -d= -f2) \
//     VAULT=0x64CA30780Cf7ecA918C667bebbabB5F833Ee58fc node execute-minting.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createPublicClient, createWalletClient, http, stringToHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  assetManagerAbi, coston2, ASSET_MANAGER_FXRP, FXRP,
  FDC_HUB, FDC_FEE_CONFIG, FDC_VERIFIER, FDC_DA_LAYER, FDC_API_KEY,
  FDC_FIRST_ROUND_TS, FDC_ROUND_SECS, fdcHubAbi, fdcFeeConfigAbi, erc20Abi,
} from "./assetManagerAbi.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadJson(name) {
  try { return JSON.parse(readFileSync(join(here, name), "utf-8")); }
  catch { console.error(`mint/${name} not found — run the earlier step first.`); process.exit(1); }
}
function requireKey() {
  let k = process.env.DEPLOYMENT_PRIVATE_KEY;
  if (!k) { console.error("Set DEPLOYMENT_PRIVATE_KEY."); process.exit(1); }
  return k.startsWith("0x") ? k : "0x" + k;
}

const account = privateKeyToAccount(requireKey());
const pub = createPublicClient({ chain: coston2, transport: http() });
const wallet = createWalletClient({ account, chain: coston2, transport: http() });

// The DA layer returns numbers as decimal strings; the executeMinting tuple wants
// bigints for the int/uint fields. Coerce the known numeric fields.
function coerceResponse(resp) {
  const B = (v) => BigInt(v);
  return {
    attestationType: resp.attestationType,
    sourceId: resp.sourceId,
    votingRound: B(resp.votingRound),
    lowestUsedTimestamp: B(resp.lowestUsedTimestamp),
    requestBody: {
      transactionId: resp.requestBody.transactionId,
      inUtxo: B(resp.requestBody.inUtxo),
      utxo: B(resp.requestBody.utxo),
    },
    responseBody: {
      blockNumber: B(resp.responseBody.blockNumber),
      blockTimestamp: B(resp.responseBody.blockTimestamp),
      sourceAddressHash: resp.responseBody.sourceAddressHash,
      sourceAddressesRoot: resp.responseBody.sourceAddressesRoot,
      receivingAddressHash: resp.responseBody.receivingAddressHash,
      intendedReceivingAddressHash: resp.responseBody.intendedReceivingAddressHash,
      spentAmount: B(resp.responseBody.spentAmount),
      intendedSpentAmount: B(resp.responseBody.intendedSpentAmount),
      receivedAmount: B(resp.responseBody.receivedAmount),
      intendedReceivedAmount: B(resp.responseBody.intendedReceivedAmount),
      standardPaymentReference: resp.responseBody.standardPaymentReference,
      oneToOne: resp.responseBody.oneToOne,
      status: Number(resp.responseBody.status),
    },
  };
}

async function prepareRequest(xrplTxHash) {
  const body = {
    attestationType: stringToHex("Payment", { size: 32 }),
    sourceId: stringToHex("testXRP", { size: 32 }),
    requestBody: {
      transactionId: xrplTxHash.startsWith("0x") ? xrplTxHash : "0x" + xrplTxHash,
      inUtxo: "0",
      utxo: "0",
    },
  };
  const res = await fetch(`${FDC_VERIFIER}/verifier/xrp/Payment/prepareRequest`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-api-key": FDC_API_KEY },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`verifier prepareRequest ${res.status}: ${await res.text()}`);
  const j = await res.json();
  if (!j.abiEncodedRequest) throw new Error(`verifier returned no abiEncodedRequest: ${JSON.stringify(j)}`);
  return j.abiEncodedRequest;
}

async function getProof(votingRoundId, requestBytes) {
  // The round must be finalized before the proof exists; poll.
  for (let i = 0; i < 30; i++) {
    const res = await fetch(`${FDC_DA_LAYER}/api/v1/fdc/proof-by-request-round`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": FDC_API_KEY },
      body: JSON.stringify({ votingRoundId, requestBytes }),
    });
    if (res.ok) {
      const j = await res.json();
      if (j && j.response && Array.isArray(j.proof)) return j;
    }
    process.stdout.write(".");
    await sleep(12_000);
  }
  throw new Error("timed out waiting for the FDC proof (round not finalized)");
}

async function main() {
  const reservation = loadJson("reservation.json");
  const payment = loadJson("payment.json");
  const vault = process.env.VAULT;
  if (!vault) { console.error("Set VAULT to the deployed MindorrVault address."); process.exit(1); }

  console.log(`FDC Payment attestation for XRPL tx ${payment.xrplTxHash}`);
  const abiEncodedRequest = await prepareRequest(payment.xrplTxHash);

  const fee = await pub.readContract({
    address: FDC_FEE_CONFIG, abi: fdcFeeConfigAbi,
    functionName: "getRequestFee", args: [abiEncodedRequest],
  });
  console.log(`  request fee: ${fee} wei — submitting to FdcHub...`);
  const reqHash = await wallet.writeContract({
    address: FDC_HUB, abi: fdcHubAbi, functionName: "requestAttestation",
    args: [abiEncodedRequest], value: fee,
  });
  const reqReceipt = await pub.waitForTransactionReceipt({ hash: reqHash });
  const block = await pub.getBlock({ blockNumber: reqReceipt.blockNumber });
  const votingRoundId = Math.floor((Number(block.timestamp) - FDC_FIRST_ROUND_TS) / FDC_ROUND_SECS);
  console.log(`  attestation requested (tx ${reqHash}); voting round ${votingRoundId}. Waiting for finalization`);

  const { response, proof } = await getProof(votingRoundId, abiEncodedRequest);
  console.log(`\n  proof obtained (${proof.length} merkle nodes).`);

  const data = coerceResponse(response);
  console.log(`  calling executeMinting(crtId=${reservation.collateralReservationId})...`);
  const mintHash = await wallet.writeContract({
    address: ASSET_MANAGER_FXRP, abi: assetManagerAbi, functionName: "executeMinting",
    args: [{ merkleProof: proof, data }, BigInt(reservation.collateralReservationId)],
  });
  await pub.waitForTransactionReceipt({ hash: mintHash });
  console.log(`  minted. tx: ${mintHash}`);

  // Move the minted FXRP into the vault so the guarded execute() can transfer it.
  const bal = await pub.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [account.address] });
  console.log(`  minter FXRP balance: ${bal} (${Number(bal) / 1e6} FXRP) — transferring to vault ${vault}`);
  const xferHash = await wallet.writeContract({ address: FXRP, abi: erc20Abi, functionName: "transfer", args: [vault, bal] });
  await pub.waitForTransactionReceipt({ hash: xferHash });

  const vaultBal = await pub.readContract({ address: FXRP, abi: erc20Abi, functionName: "balanceOf", args: [vault] });
  writeFileSync(join(here, "mint-done.json"), JSON.stringify({
    mintTx: mintHash, transferTx: xferHash, vault, vaultFxrp: vaultBal.toString(),
  }, null, 2));

  console.log(`\n=== Mint complete ===`);
  console.log(`  executeMinting tx: ${mintHash}`);
  console.log(`  vault FXRP balance: ${vaultBal} (${Number(vaultBal) / 1e6} FXRP)`);
  console.log(`\nNext: get a 1-FXRP enclave signature (ALLOC_AMOUNT=1000000 ./scripts/test.sh),`);
  console.log(`then MindorrVault.execute(owner,1,FXRP,1000000,venue,sig) moves real FXRP.`);
}

main().catch((e) => { console.error("execute-minting failed:", e.shortMessage ?? e.message ?? e); process.exit(1); });
