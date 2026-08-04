/**
 * Live reads from Coston2 — used server-side to pull the real XRP price off
 * Flare's FTSO so the demo shows a live oracle number, not a hardcoded one.
 */

import { createPublicClient, http } from "viem";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const FTSO_TEST_XRP = "0x22d10E7305Fd39833B4d14d113Bca3602bA1F701" as const;

const FTSO_ABI = [
  {
    type: "function",
    name: "getCurrentPriceWithDecimals",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "price", type: "uint256" },
      { name: "timestamp", type: "uint256" },
      { name: "decimals", type: "uint256" },
    ],
  },
] as const;

export interface XrpPrice {
  usd: number;
  at: number;
}

/** Read XRP/USD from FTSO on Coston2. Returns null if the RPC is unreachable. */
export async function getXrpUsd(): Promise<XrpPrice | null> {
  try {
    const client = createPublicClient({ transport: http(RPC) });
    const [price, timestamp, decimals] = (await client.readContract({
      address: FTSO_TEST_XRP,
      abi: FTSO_ABI,
      functionName: "getCurrentPriceWithDecimals",
    })) as [bigint, bigint, bigint];
    return { usd: Number(price) / 10 ** Number(decimals), at: Number(timestamp) };
  } catch {
    return null;
  }
}
