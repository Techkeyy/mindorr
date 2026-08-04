/**
 * ★ Mindorr FDC (Flare Data Connector) — the confidential deposit check.
 *
 * P2: before any FXRP is minted, the enclave must be sure the user's XRP
 * actually landed. It does that with an FDC `Payment` attestation: a
 * consensus-verified proof that a specific XRPL payment reached a specific
 * address, for a specific amount, with a specific reference.
 *
 * This module (a) builds the attestation *request* the app submits to the FDC,
 * and (b) validates the attestation *response* against what the enclave
 * expects. The validation is what makes minting safe — an attacker can't get
 * Mindorr to credit a deposit that didn't happen, went elsewhere, was too
 * small, or carried the wrong reference. Pure and fully unit-testable.
 *
 * On-chain, the same proof is handed to AssetManagerFXRP.executeMinting(); that
 * step is a normal transaction (see docs/DEPLOY.md). This module is the
 * confidential verification that gates it.
 */

import { encodeAbiParameters, type Hex } from "viem";

import { stringToBytes32Hex } from "../base/encoding.js";

const ZERO32 = `0x${"00".repeat(32)}` as Hex;

/** FDC attestation type + source ids, as right-padded bytes32 strings. */
export const ATTESTATION_TYPE_PAYMENT = stringToBytes32Hex("Payment") as Hex;
export const SOURCE_ID_TEST_XRP = stringToBytes32Hex("testXRP") as Hex; // FAssets FXRP on Coston2

/** Payment attestation FDC response status: 0 = success (full). */
export const PAYMENT_STATUS_SUCCESS = 0;

export interface PaymentRequestBody {
  /** XRPL transaction hash, as bytes32. */
  transactionId: Hex;
  /** For non-UTXO chains like XRPL these are 0. */
  inUtxo: number;
  utxo: number;
}

/**
 * The subset of a decoded FDC `Payment` response the enclave checks. Field
 * names follow the Flare Payment attestation `responseBody`.
 */
export interface PaymentResponse {
  status: number;
  sourceId: Hex;
  /** keccak256 of the receiving address string. */
  receivingAddressHash: Hex;
  /** Amount received at the receiving address, in drops (XRP has 6 decimals). */
  receivedAmount: bigint;
  /** The standard payment reference that ties this payment to the mint. */
  standardPaymentReference: Hex;
}

/** What the enclave requires the proof to show for this deposit. */
export interface ExpectedDeposit {
  sourceId: Hex;
  receivingAddressHash: Hex;
  minAmount: bigint;
  reference: Hex;
}

export type DepositCode =
  | "OK"
  | "DEPOSIT_NOT_SUCCESSFUL"
  | "WRONG_SOURCE"
  | "WRONG_RECIPIENT"
  | "AMOUNT_TOO_LOW"
  | "WRONG_REFERENCE";

export interface DepositVerdict {
  ok: boolean;
  code: DepositCode;
  reason: string;
}

function eqHex(a: Hex, b: Hex): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

// --- payload decoding -------------------------------------------------------

const BYTES32_RE = /^0x[0-9a-fA-F]{64}$/;
const DECIMAL_RE = /^\d+$/;

function obj(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}
function hex32(o: Record<string, unknown>, k: string): Hex {
  const v = o[k];
  if (typeof v !== "string" || !BYTES32_RE.test(v)) throw new Error(`"${k}" must be a bytes32 hex`);
  return v as Hex;
}
function uint(o: Record<string, unknown>, k: string): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new Error(`"${k}" must be a non-negative integer`);
  return v;
}
function amount(o: Record<string, unknown>, k: string): bigint {
  const v = o[k];
  if (typeof v !== "string" || !DECIMAL_RE.test(v)) throw new Error(`"${k}" must be a base-unit decimal string`);
  return BigInt(v);
}

/** Decode a CONFIRM_DEPOSIT payload: { proof, expected }. */
export function parseConfirmDeposit(raw: unknown): { proof: PaymentResponse; expected: ExpectedDeposit } {
  const o = obj(raw, "payload");
  const p = obj(o["proof"], "proof");
  const e = obj(o["expected"], "expected");
  return {
    proof: {
      status: uint(p, "status"),
      sourceId: hex32(p, "sourceId"),
      receivingAddressHash: hex32(p, "receivingAddressHash"),
      receivedAmount: amount(p, "receivedAmount"),
      standardPaymentReference: hex32(p, "standardPaymentReference"),
    },
    expected: {
      sourceId: hex32(e, "sourceId"),
      receivingAddressHash: hex32(e, "receivingAddressHash"),
      minAmount: amount(e, "minAmount"),
      reference: hex32(e, "reference"),
    },
  };
}

/**
 * Build the ABI-encoded FDC attestation request for an XRPL payment. The
 * `messageIntegrityCode` is normally filled in by the verifier server during
 * the prepare round-trip; it defaults to zero here.
 */
export function encodePaymentRequest(
  sourceId: Hex,
  body: PaymentRequestBody,
  messageIntegrityCode: Hex = ZERO32,
): Hex {
  return encodeAbiParameters(
    [
      {
        type: "tuple",
        components: [
          { name: "attestationType", type: "bytes32" },
          { name: "sourceId", type: "bytes32" },
          { name: "messageIntegrityCode", type: "bytes32" },
          {
            name: "requestBody",
            type: "tuple",
            components: [
              { name: "transactionId", type: "bytes32" },
              { name: "inUtxo", type: "uint256" },
              { name: "utxo", type: "uint256" },
            ],
          },
        ],
      },
    ],
    [
      {
        attestationType: ATTESTATION_TYPE_PAYMENT,
        sourceId,
        messageIntegrityCode,
        requestBody: {
          transactionId: body.transactionId,
          inUtxo: BigInt(body.inUtxo),
          utxo: BigInt(body.utxo),
        },
      },
    ],
  );
}

/**
 * Validate a decoded Payment response against the enclave's expectation. The
 * checks are ordered so the returned code names the first failure.
 */
export function validatePaymentProof(r: PaymentResponse, e: ExpectedDeposit): DepositVerdict {
  if (r.status !== PAYMENT_STATUS_SUCCESS) {
    return { ok: false, code: "DEPOSIT_NOT_SUCCESSFUL", reason: `payment status ${r.status} is not success` };
  }
  if (!eqHex(r.sourceId, e.sourceId)) {
    return { ok: false, code: "WRONG_SOURCE", reason: `payment source ${r.sourceId} != expected ${e.sourceId}` };
  }
  if (!eqHex(r.receivingAddressHash, e.receivingAddressHash)) {
    return { ok: false, code: "WRONG_RECIPIENT", reason: "payment went to a different address" };
  }
  if (r.receivedAmount < e.minAmount) {
    return { ok: false, code: "AMOUNT_TOO_LOW", reason: `received ${r.receivedAmount} < required ${e.minAmount}` };
  }
  if (!eqHex(r.standardPaymentReference, e.reference)) {
    return { ok: false, code: "WRONG_REFERENCE", reason: "payment reference does not match this mint" };
  }
  return { ok: true, code: "OK", reason: "ok" };
}
