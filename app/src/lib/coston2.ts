/**
 * Live reads from Coston2, used server-side to pull the real XRP price off
 * Flare's FTSO so the demo shows a live oracle number, not a hardcoded one,
 * plus the on-chain TEE machine state for the /verify page.
 */

import { createPublicClient, http } from "viem";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const FTSO_TEST_XRP = "0x22d10E7305Fd39833B4d14d113Bca3602bA1F701" as const;

export const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE" as const;
export const TEE_ID = "0x4A47F54fC5C8f1e6321Ea29c47f5D33EF1d05056" as const;
export const EXTENSION_ID = 66129n;

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

const TEE_MANAGER_ABI = [
  {
    type: "function",
    name: "getTeeMachine",
    stateMutability: "view",
    inputs: [{ name: "teeId", type: "address" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "teeId", type: "address" },
          { name: "teeProxyId", type: "address" },
          { name: "url", type: "string" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "getTeeMachineStatus",
    stateMutability: "view",
    inputs: [{ name: "teeId", type: "address" }],
    outputs: [{ name: "status", type: "uint8" }],
  },
  {
    type: "function",
    name: "getTeeMachineOwner",
    stateMutability: "view",
    inputs: [{ name: "teeId", type: "address" }],
    outputs: [{ name: "owner", type: "address" }],
  },
  {
    type: "function",
    name: "getExtensionId",
    stateMutability: "view",
    inputs: [{ name: "teeId", type: "address" }],
    outputs: [{ name: "extensionId", type: "uint256" }],
  },
  {
    type: "function",
    name: "getLastStatusChangeTs",
    stateMutability: "view",
    inputs: [{ name: "teeId", type: "address" }],
    outputs: [{ name: "ts", type: "uint256" }],
  },
] as const;

const client = () => createPublicClient({ transport: http(RPC) });

export interface XrpPrice {
  usd: number;
  at: number;
}

/** Read XRP/USD from FTSO on Coston2. Returns null if the RPC is unreachable. */
export async function getXrpUsd(): Promise<XrpPrice | null> {
  try {
    const [price, timestamp, decimals] = (await client().readContract({
      address: FTSO_TEST_XRP,
      abi: FTSO_ABI,
      functionName: "getCurrentPriceWithDecimals",
    })) as [bigint, bigint, bigint];
    return { usd: Number(price) / 10 ** Number(decimals), at: Number(timestamp) };
  } catch {
    return null;
  }
}

export type TeeStatus = "UNKNOWN" | "INITIALIZED" | "PRODUCTION" | "REVOKED" | `RAW_${number}`;

export interface TeeMachine {
  teeId: `0x${string}`;
  teeProxyId: `0x${string}`;
  url: string;
  status: TeeStatus;
  statusCode: number;
  owner: `0x${string}`;
  extensionId: bigint;
  lastStatusChangeTs: number;
}

const STATUS_NAMES: Record<number, TeeStatus> = {
  0: "UNKNOWN",
  1: "INITIALIZED",
  2: "PRODUCTION",
  3: "REVOKED",
};

/** Live on-chain snapshot of our TEE machine: the proof the /verify page renders. */
export async function getTeeMachine(): Promise<TeeMachine | null> {
  try {
    const c = client();
    const [machine, statusRaw, owner, extId, ts] = await Promise.all([
      c.readContract({
        address: TEE_MANAGER,
        abi: TEE_MANAGER_ABI,
        functionName: "getTeeMachine",
        args: [TEE_ID],
      }),
      c.readContract({
        address: TEE_MANAGER,
        abi: TEE_MANAGER_ABI,
        functionName: "getTeeMachineStatus",
        args: [TEE_ID],
      }),
      c.readContract({
        address: TEE_MANAGER,
        abi: TEE_MANAGER_ABI,
        functionName: "getTeeMachineOwner",
        args: [TEE_ID],
      }),
      c.readContract({
        address: TEE_MANAGER,
        abi: TEE_MANAGER_ABI,
        functionName: "getExtensionId",
        args: [TEE_ID],
      }),
      c.readContract({
        address: TEE_MANAGER,
        abi: TEE_MANAGER_ABI,
        functionName: "getLastStatusChangeTs",
        args: [TEE_ID],
      }),
    ]);
    const m = machine as { teeId: `0x${string}`; teeProxyId: `0x${string}`; url: string };
    const s = Number(statusRaw as number);
    return {
      teeId: m.teeId,
      teeProxyId: m.teeProxyId,
      url: m.url,
      status: STATUS_NAMES[s] ?? (`RAW_${s}` as const),
      statusCode: s,
      owner: owner as `0x${string}`,
      extensionId: extId as bigint,
      lastStatusChangeTs: Number(ts as bigint),
    };
  } catch {
    return null;
  }
}
