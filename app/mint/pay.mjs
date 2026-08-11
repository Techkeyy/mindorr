// mint/pay.mjs — Step 2 of the FXRP mint: pay the agent on the XRPL testnet.
//
// Reads mint/reservation.json (from reserve.mjs) and sends exactly totalDrops XRP
// to the agent's paymentAddress, carrying the FAssets paymentReference as a memo
// so the FDC Payment attestation can match it. Saves mint/payment.json.
//
// Run:
//   cd /workspaces/mindorr/app/mint && npm install
//   XRPL_SECRET=s... node pay.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { Client, Wallet } from "xrpl";

const here = dirname(fileURLToPath(import.meta.url));
const TESTNET = "wss://s.altnet.rippletest.net:51233";

function loadReservation() {
  try {
    return JSON.parse(readFileSync(join(here, "reservation.json"), "utf-8"));
  } catch {
    console.error("mint/reservation.json not found — run `node reserve.mjs` first.");
    process.exit(1);
  }
}

function requireSecret() {
  const s = process.env.XRPL_SECRET;
  if (!s || !s.startsWith("s")) {
    console.error("Set XRPL_SECRET to your funded XRPL testnet secret (starts with 's').");
    process.exit(1);
  }
  return s;
}

async function main() {
  const r = loadReservation();
  const wallet = Wallet.fromSeed(requireSecret());

  // FAssets expects the 32-byte standardPaymentReference in a memo (hex, no 0x, upper).
  const memoData = r.paymentReference.replace(/^0x/, "").toUpperCase();

  console.log(`Paying from ${wallet.address}`);
  console.log(`  to agent:   ${r.paymentAddress}`);
  console.log(`  amount:     ${r.totalXrp} XRP (${r.totalDrops} drops)`);
  console.log(`  reference:  ${r.paymentReference}`);

  const client = new Client(TESTNET);
  await client.connect();
  try {
    const prepared = await client.autofill({
      TransactionType: "Payment",
      Account: wallet.address,
      Destination: r.paymentAddress,
      Amount: r.totalDrops, // exact drops; must match valueUBA + feeUBA
      Memos: [{ Memo: { MemoData: memoData } }],
    });
    const signed = wallet.sign(prepared);
    const res = await client.submitAndWait(signed.tx_blob);

    const code = res.result.meta?.TransactionResult;
    if (code !== "tesSUCCESS") {
      throw new Error(`XRPL payment not successful: ${code}`);
    }
    const out = {
      xrplTxHash: res.result.hash, // 64-hex, uppercase
      ledgerIndex: res.result.ledger_index,
      from: wallet.address,
      to: r.paymentAddress,
      drops: r.totalDrops,
      collateralReservationId: r.collateralReservationId,
    };
    writeFileSync(join(here, "payment.json"), JSON.stringify(out, null, 2));
    console.log(`\nPaid. XRPL tx: ${out.xrplTxHash} (ledger ${out.ledgerIndex})`);
    console.log(`Saved mint/payment.json.  Next: node execute-minting.mjs`);
  } finally {
    await client.disconnect();
  }
}

main().catch((e) => {
  console.error("pay failed:", e.message ?? e);
  process.exit(1);
});
