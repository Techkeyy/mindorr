/**
 * ★ Mindorr payload codec — decode instruction payloads into typed Policy /
 * Intent values, and compute the canonical digest the enclave signs.
 *
 * Payloads arrive as hex-encoded UTF-8 JSON (like the scaffold's SAY_HELLO).
 * Amounts are base-unit decimal strings so they survive JSON without precision
 * loss, then become bigint here. Validation is strict: a malformed payload is
 * refused before it can reach the guard or the signer.
 */

import { encodeAbiParameters, keccak256, type Hex } from "viem";

import type { Intent, IntentKind, Policy, RiskLevel } from "./policy.js";

const RISK_LEVELS: readonly RiskLevel[] = ["conservative", "moderate", "growth"];
const KIND_CODE: Record<IntentKind, number> = { allocate: 1, rebalance: 2, withdraw: 3 };
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const DECIMAL_RE = /^\d+$/;

// --- field readers ----------------------------------------------------------

function asObject(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new Error("expected a JSON object");
  }
  return v as Record<string, unknown>;
}

function reqString(o: Record<string, unknown>, k: string): string {
  const v = o[k];
  if (typeof v !== "string" || v === "") throw new Error(`missing or empty "${k}"`);
  return v;
}

function reqAddress(o: Record<string, unknown>, k: string): string {
  const v = reqString(o, k);
  if (!ADDRESS_RE.test(v)) throw new Error(`"${k}" is not a 20-byte address`);
  return v;
}

function reqAmount(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v !== "string" || !DECIMAL_RE.test(v)) {
    throw new Error(`"${k}" must be a base-unit decimal string`);
  }
  return BigInt(v);
}

function reqInt(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v)) throw new Error(`"${k}" must be an integer`);
  return v;
}

function optAmount(o: Record<string, unknown>, k: string): bigint | undefined {
  return o[k] === undefined ? undefined : reqAmount(o, k);
}

function optInt(o: Record<string, unknown>, k: string): number | undefined {
  return o[k] === undefined ? undefined : reqInt(o, k);
}

function optBool(o: Record<string, unknown>, k: string): boolean {
  const v = o[k];
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new Error(`"${k}" must be a boolean`);
  return v;
}

// --- decoders ---------------------------------------------------------------

/** Decode + validate a SET_POLICY payload. */
export function parsePolicy(raw: unknown): Policy {
  const o = asObject(raw);

  const riskLevel = reqString(o, "riskLevel") as RiskLevel;
  if (!RISK_LEVELS.includes(riskLevel)) {
    throw new Error(`"riskLevel" must be one of: ${RISK_LEVELS.join(", ")}`);
  }

  const venuesRaw = o["allowedVenues"];
  if (!Array.isArray(venuesRaw) || venuesRaw.length === 0) {
    throw new Error(`"allowedVenues" must be a non-empty array`);
  }
  const allowedVenues = venuesRaw.map((v, i) => {
    if (typeof v !== "string" || !ADDRESS_RE.test(v)) {
      throw new Error(`allowedVenues[${i}] is not a 20-byte address`);
    }
    return v;
  });

  return {
    owner: reqAddress(o, "owner"),
    returnAddress: reqAddress(o, "returnAddress"),
    riskLevel,
    asset: reqAddress(o, "asset"),
    allowedVenues,
    maxVenueBps: reqInt(o, "maxVenueBps"),
    maxTxAmount: reqAmount(o, "maxTxAmount"),
    minHealthFactorBps: reqInt(o, "minHealthFactorBps"),
  };
}

/** Decode + validate an ALLOCATE / REBALANCE / WITHDRAW payload into an Intent. */
export function parseVaultIntent(kind: IntentKind, raw: unknown): Intent {
  const o = asObject(raw);

  const intent: Intent = {
    kind,
    asset: reqAddress(o, "asset"),
    amount: reqAmount(o, "amount"),
    portfolioValue: optAmount(o, "portfolioValue"),
    venueBalance: optAmount(o, "venueBalance"),
    projectedHealthFactorBps: optInt(o, "projectedHealthFactorBps"),
  };

  if (kind === "withdraw") {
    intent.to = reqAddress(o, "to");
    intent.userAuthorized = optBool(o, "userAuthorized");
  } else {
    intent.venue = reqAddress(o, "venue");
  }

  return intent;
}

/**
 * Canonical digest the on-chain vault adapter reconstructs and verifies against
 * the managed wallet's signature: keccak256(abi.encode(kind, asset, amount, dest)).
 * `dest` is the venue for allocate/rebalance, the return address for withdraw.
 */
export function actionDigest(intent: Intent): Hex {
  // Canonicalize to lowercase: viem's ABI encoder strict-checks address
  // checksums, whereas the guard compares case-insensitively. Lowercasing is the
  // canonical form and does not change the encoded 20 bytes.
  const asset = intent.asset.toLowerCase() as Hex;
  const dest = (intent.to ?? intent.venue ?? ZERO_ADDR).toLowerCase() as Hex;
  const encoded = encodeAbiParameters(
    [{ type: "uint8" }, { type: "address" }, { type: "uint256" }, { type: "address" }],
    [KIND_CODE[intent.kind], asset, intent.amount, dest],
  );
  return keccak256(encoded);
}
