// mint/reserve.mjs — Step 1 of the FXRP mint: reserve collateral with an agent.
//
// Reserving returns (via the CollateralReserved event) the agent's XRPL payment
// address, the payment reference, and the exact XRP amount to pay. We save those
// to mint/reservation.json for the pay + executeMinting steps.
//
// Run in the Codespace (needs the funded deployer key + ~1.7 C2FLR per lot):
//   cd /workspaces/mindorr/app
//   DEPLOYMENT_PRIVATE_KEY=$(grep '^DEPLOYMENT_PRIVATE_KEY=' ../extension/.env | cut -d= -f2) \
//     node mint/reserve.mjs
//
// Optional env: LOTS (default 1), AGENT (default: first available), MAX_FEE_BIPS (default 10000).
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  createPublicClient,
  createWalletClient,
  http,
  decodeEventLog,
  formatEther,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { assetManagerAbi, coston2, ASSET_MANAGER_FXRP } from "./assetManagerAbi.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function requireKey() {
  let k = process.env.DEPLOYMENT_PRIVATE_KEY;
  if (!k) {
    console.error("Set DEPLOYMENT_PRIVATE_KEY (the funded Coston2 deployer key).");
    process.exit(1);
  }
  if (!k.startsWith("0x")) k = "0x" + k;
  return k;
}

const LOTS = BigInt(process.env.LOTS ?? "1");
const MAX_FEE_BIPS = BigInt(process.env.MAX_FEE_BIPS ?? "10000");
const ZERO = "0x0000000000000000000000000000000000000000";

const account = privateKeyToAccount(requireKey());
const pub = createPublicClient({ chain: coston2, transport: http() });
const wallet = createWalletClient({ account, chain: coston2, transport: http() });

const read = (functionName, args = []) =>
  pub.readContract({ address: ASSET_MANAGER_FXRP, abi: assetManagerAbi, functionName, args });

async function pickAgent() {
  if (process.env.AGENT) return process.env.AGENT;
  const [agents] = await read("getAvailableAgentsList", [0n, 20n]);
  if (!agents.length) throw new Error("no available FXRP agents on Coston2 right now");
  return agents[0];
}

async function main() {
  const lotSize = await read("lotSize");
  const fee = await read("collateralReservationFee", [LOTS]);
  const agent = await pickAgent();

  console.log(`Minter (deployer): ${account.address}`);
  console.log(`Agent:             ${agent}`);
  console.log(`Lots:              ${LOTS}  (lotSize=${lotSize} UBA => ${(LOTS * lotSize) / 1000000n} FXRP)`);
  console.log(`Reservation fee:   ${formatEther(fee)} C2FLR`);

  console.log("Sending reserveCollateral...");
  const hash = await wallet.writeContract({
    address: ASSET_MANAGER_FXRP,
    abi: assetManagerAbi,
    functionName: "reserveCollateral",
    args: [agent, LOTS, MAX_FEE_BIPS, ZERO],
    value: fee,
  });
  console.log(`  tx: ${hash}`);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`reserveCollateral reverted (tx ${hash})`);

  // Find + decode the CollateralReserved event.
  let reserved = null;
  for (const log of receipt.logs) {
    try {
      const ev = decodeEventLog({ abi: assetManagerAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "CollateralReserved") {
        reserved = ev.args;
        break;
      }
    } catch {
      /* not our event */
    }
  }
  if (!reserved) throw new Error("CollateralReserved event not found in receipt");

  // valueUBA + feeUBA are in UBA (== XRP drops for FXRP, 6dp). Total to pay = value + fee.
  const totalDrops = reserved.valueUBA + reserved.feeUBA;
  const out = {
    collateralReservationId: reserved.collateralReservationId.toString(),
    agentVault: reserved.agentVault,
    minter: account.address,
    paymentAddress: reserved.paymentAddress, // agent's XRPL r-address
    paymentReference: reserved.paymentReference, // 32-byte memo to include
    valueUBA: reserved.valueUBA.toString(),
    feeUBA: reserved.feeUBA.toString(),
    totalDrops: totalDrops.toString(),
    totalXrp: (Number(totalDrops) / 1_000_000).toString(),
    lastUnderlyingBlock: reserved.lastUnderlyingBlock.toString(),
    lastUnderlyingTimestamp: reserved.lastUnderlyingTimestamp.toString(),
    reserveTx: hash,
  };
  const path = join(here, "reservation.json");
  writeFileSync(path, JSON.stringify(out, null, 2));

  console.log("\n=== Reservation complete ===");
  console.log(`  reservationId:    ${out.collateralReservationId}`);
  console.log(`  PAY TO (XRPL):    ${out.paymentAddress}`);
  console.log(`  PAYMENT REF:      ${out.paymentReference}`);
  console.log(`  AMOUNT:           ${out.totalXrp} XRP (${out.totalDrops} drops)`);
  console.log(`  Pay before XRPL ledger ~${out.lastUnderlyingBlock} / ts ${out.lastUnderlyingTimestamp}`);
  console.log(`  Saved to ${path}`);
  console.log("\nNext: node mint/pay.mjs  (sends the XRP with the reference), then executeMinting.");
}

main().catch((e) => {
  console.error("reserve failed:", e.shortMessage ?? e.message ?? e);
  process.exit(1);
});
