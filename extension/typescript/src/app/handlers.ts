/**
 * ★ Mindorr handlers — where the guard meets the signer.
 *
 * Each fund-moving action follows the same rule: decode → evaluate against the
 * owner's policy → **sign only if allowed**. A refused action returns status 0
 * with the refusal code in the log and produces no signature. This is the
 * "malicious instruction bounces" guarantee, live.
 *
 * Handler contract: (originalMessageHex) => [dataHexOrNull, status, errorOrNull],
 * status 0 = error/refused, 1 = success. See docs/extension-contract.md §4.6.
 * The framework serializes handler calls, so module-level state is safe.
 */

import { bytesToHex, hexToBytes } from "../base/encoding.js";
import type { Framework, HandlerResult } from "../base/types.js";

import { actionDigest, parsePolicy, parseVaultIntent } from "./codec.js";
import {
  OP_COMMAND_ALLOCATE,
  OP_COMMAND_CONFIRM_DEPOSIT,
  OP_COMMAND_REBALANCE,
  OP_COMMAND_SET_POLICY,
  OP_COMMAND_UPDATE_KEY,
  OP_COMMAND_WITHDRAW,
  OP_TYPE_VAULT,
  OP_TYPE_WALLET,
} from "./config.js";
import { parseConfirmDeposit, validatePaymentProof } from "./fdc.js";
import { evaluateIntent, type Intent, type IntentKind, type Policy } from "./policy.js";
import { ManagedWallet } from "./wallet.js";

// --- Extension state (serialized by the framework) --------------------------
const wallet = new ManagedWallet();
let policy: Policy | null = null;
let actionsSigned = 0;
let actionsRefused = 0;
let confirmedDrops = 0n; // FXRP verified as deposited (drops == FXRP base units, both 6dp)
let depositsConfirmed = 0;

export function resetState(): void {
  wallet.clear();
  policy = null;
  actionsSigned = 0;
  actionsRefused = 0;
  confirmedDrops = 0n;
  depositsConfirmed = 0;
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_WALLET, OP_COMMAND_UPDATE_KEY, handleUpdateKey);
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_SET_POLICY, handleSetPolicy);
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_CONFIRM_DEPOSIT, handleConfirmDeposit);
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_ALLOCATE, (m) => handleVaultAction("allocate", m));
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_REBALANCE, (m) => handleVaultAction("rebalance", m));
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_WITHDRAW, (m) => handleVaultAction("withdraw", m));
}

export function reportState(): unknown {
  return {
    hasKey: wallet.hasKey(),
    walletAddress: wallet.address(),
    hasPolicy: policy !== null,
    riskLevel: policy?.riskLevel ?? null,
    allowedVenues: policy?.allowedVenues ?? [],
    confirmedFxrp: confirmedDrops.toString(),
    depositsConfirmed,
    actionsSigned,
    actionsRefused,
  };
}

// --- helpers ----------------------------------------------------------------

function decodeJson(msg: string): [unknown, string | null] {
  let raw: Uint8Array;
  try {
    raw = hexToBytes(msg);
  } catch (e) {
    return [null, `invalid hex: ${String(e)}`];
  }
  try {
    return [JSON.parse(Buffer.from(raw).toString("utf-8")), null];
  } catch (e) {
    return [null, `invalid JSON: ${String(e)}`];
  }
}

function okJson(obj: unknown): HandlerResult {
  return [bytesToHex(Buffer.from(JSON.stringify(obj), "utf-8")), 1, null];
}

function msgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// --- handlers ---------------------------------------------------------------

/** WALLET/UPDATE_KEY — deliver the managed key, encrypted to the TEE. */
export async function handleUpdateKey(msg: string): Promise<HandlerResult> {
  let raw: Uint8Array;
  try {
    raw = hexToBytes(msg);
  } catch (e) {
    return [null, 0, `decoding request: invalid hex: ${String(e)}`];
  }
  if (raw.length === 0) return [null, 0, "originalMessage is empty"];

  try {
    const signPort = process.env.SIGN_PORT ?? "9090";
    await wallet.loadEncryptedKey(signPort, raw);
  } catch (e) {
    return [null, 0, `key update failed: ${msgOf(e)}`];
  }
  return okJson({ walletAddress: wallet.address() });
}

/** VAULT/SET_POLICY — set the owner's policy (allowlist, caps, return address). */
export function handleSetPolicy(msg: string): HandlerResult {
  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];

  let p: Policy;
  try {
    p = parsePolicy(obj);
  } catch (e) {
    return [null, 0, `invalid policy: ${msgOf(e)}`];
  }
  policy = p;
  return okJson({ ok: true, riskLevel: p.riskLevel, allowedVenues: p.allowedVenues.length });
}

/**
 * VAULT/CONFIRM_DEPOSIT — verify, via an FDC Payment proof, that the user's XRP
 * actually arrived, before any FXRP is credited. The on-chain
 * AssetManagerFXRP.executeMinting(proof) is a separate tx (docs/DEPLOY.md); this
 * is the confidential check that gates it.
 */
export function handleConfirmDeposit(msg: string): HandlerResult {
  if (policy === null) return [null, 0, "no policy set"];

  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];

  let parsed;
  try {
    parsed = parseConfirmDeposit(obj);
  } catch (e) {
    return [null, 0, `invalid deposit: ${msgOf(e)}`];
  }

  const verdict = validatePaymentProof(parsed.proof, parsed.expected);
  if (!verdict.ok) {
    return [null, 0, `deposit rejected ${verdict.code}: ${verdict.reason}`];
  }

  confirmedDrops += parsed.proof.receivedAmount;
  depositsConfirmed++;
  return okJson({
    confirmed: true,
    receivedFxrp: parsed.proof.receivedAmount.toString(),
    totalConfirmedFxrp: confirmedDrops.toString(),
    reference: parsed.proof.standardPaymentReference,
  });
}

/** VAULT/{ALLOCATE,REBALANCE,WITHDRAW} — evaluate, then sign only if allowed. */
export async function handleVaultAction(kind: IntentKind, msg: string): Promise<HandlerResult> {
  if (policy === null) return [null, 0, "no policy set"];
  if (!wallet.hasKey()) return [null, 0, "no managed key loaded"];

  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];

  let intent: Intent;
  try {
    intent = parseVaultIntent(kind, obj);
  } catch (e) {
    return [null, 0, `invalid ${kind}: ${msgOf(e)}`];
  }

  const decision = evaluateIntent(policy, intent);
  if (!decision.allow) {
    actionsRefused++;
    return [null, 0, `refused ${decision.code}: ${decision.reason}`];
  }

  const digest = actionDigest(intent);
  let signature: string;
  try {
    signature = await wallet.signDigest(digest);
  } catch (e) {
    return [null, 0, `signing failed: ${msgOf(e)}`];
  }

  actionsSigned++;
  return okJson({
    signer: wallet.address(),
    kind: intent.kind,
    asset: intent.asset,
    amount: intent.amount.toString(),
    destination: intent.to ?? intent.venue,
    digest,
    signature,
  });
}
