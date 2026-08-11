/**
 * Live reads from Coston2, used server-side to pull the real XRP price off
 * Flare's FTSO so the demo shows a live oracle number, not a hardcoded one,
 * plus the on-chain TEE machine state for the /verify page.
 */

import { createPublicClient, http } from "viem";

const RPC = "https://coston2-api.flare.network/ext/C/rpc";
const FTSO_TEST_XRP = "0x22d10E7305Fd39833B4d14d113Bca3602bA1F701" as const;

export const TEE_MANAGER = "0x1a9C4A0f9D76c0b1D91d22E24E573a9b377618aE" as const;
// Current registration (extension 66157). The TEE machine key is re-attested each
// time the enclave restarts; update this to the latest registered id before a demo.
// The immutable proof of the real fund movement lives on /verify (execute/mint txs).
export const TEE_ID = "0xD876437F023e5681d151845C326270327968F2ff" as const;
export const EXTENSION_ID = 66157n;

// --- Real deployed Mindorr addresses (Coston2) ------------------------------
export const MINDORR_VAULT = "0x64CA30780Cf7ecA918C667bebbabB5F833Ee58fc" as const;
export const INSTRUCTION_SENDER = "0xf2170a0EBD84Bdf18F1b973A67d95F590F7Cc0f4" as const;
export const MANAGED_WALLET = "0x71562b71999873DB5b286dF957af199Ec94617F7" as const; // enclave signer
export const OWNER_ADDRESS = "0x16Cbdc4974754F915aDd3Fb7240A7eF9699c8700" as const; // return address
export const ALLOWED_VENUE = "0xa11a000100000000000000000000000000000000" as const; // allowlisted destination
export const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7" as const; // FAssets FXRP, 6dp

// Permanent on-chain receipts of the real loop (linked from the chat + /verify).
export const PROOF_TX = {
  execute: "0xf690cca5ccef66f66bf896ab42a74bf77624859b2fd86026090ee258b145dac7",
  mint: "0x3ca96a6fdeb503f36ee17b0c656bb4283100535628710aac1255ec4400f2adec",
  refused: "0x861c6745702eeb7a3538c76f1ecad7626eb95a0517feb3afa3bc4c8df1d5f270",
} as const;

const ERC20_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "who", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

/** Live FXRP balance held by the MindorrVault, in whole FXRP. null if RPC is down. */
export async function getVaultFxrp(): Promise<number | null> {
  try {
    const bal = (await client().readContract({
      address: FXRP,
      abi: ERC20_ABI,
      functionName: "balanceOf",
      args: [MINDORR_VAULT],
    })) as bigint;
    return Number(bal) / 1_000_000; // FXRP has 6 decimals
  } catch {
    return null;
  }
}

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
