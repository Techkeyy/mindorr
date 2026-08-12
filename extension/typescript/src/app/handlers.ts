/**
 * ★ Mindorr handlers — where the per-user guard meets the per-user signer.
 *
 * Multi-tenant: the enclave holds one master seed (WALLET/UPDATE_KEY) and derives
 * a distinct managed wallet per user. Every user has their own policy and their
 * own counters, keyed by owner address. Each fund-moving action follows the same
 * rule: decode → look up that user's policy → evaluate → **sign only if allowed**,
 * with that user's derived key. A refused action returns status 0 with the refusal
 * code and produces no signature. This is the "malicious instruction bounces"
 * guarantee, live and per-user.
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
  OP_COMMAND_CREATE,
  OP_COMMAND_REBALANCE,
  OP_COMMAND_SET_POLICY,
  OP_COMMAND_UPDATE_KEY,
  OP_COMMAND_WITHDRAW,
  OP_TYPE_VAULT,
  OP_TYPE_WALLET,
} from "./config.js";
import { parseConfirmDeposit, validatePaymentProof } from "./fdc.js";
import { evaluateIntent, type Address, type Intent, type IntentKind, type Policy } from "./policy.js";
import { WalletManager } from "./wallet.js";

// --- Enclave state (serialized by the framework) ----------------------------

const wallets = new WalletManager();

interface UserState {
  policy: Policy | null;
  actionsSigned: number;
  actionsRefused: number;
  confirmedDrops: bigint; // FXRP verified as deposited (drops == FXRP base units, both 6dp)
  depositsConfirmed: number;
}

/** owner address (lowercased) => their state */
const users = new Map<string, UserState>();

function userState(owner: Address): UserState {
  const key = owner.toLowerCase();
  let s = users.get(key);
  if (!s) {
    s = { policy: null, actionsSigned: 0, actionsRefused: 0, confirmedDrops: 0n, depositsConfirmed: 0 };
    users.set(key, s);
  }
  return s;
}

export function resetState(): void {
  wallets.clear();
  users.clear();
}

export function register(framework: Framework): void {
  framework.handle(OP_TYPE_WALLET, OP_COMMAND_UPDATE_KEY, handleUpdateKey);
  framework.handle(OP_TYPE_WALLET, OP_COMMAND_CREATE, handleCreateWallet);
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_SET_POLICY, handleSetPolicy);
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_CONFIRM_DEPOSIT, handleConfirmDeposit);
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_ALLOCATE, (m) => handleVaultAction("allocate", m));
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_REBALANCE, (m) => handleVaultAction("rebalance", m));
  framework.handle(OP_TYPE_VAULT, OP_COMMAND_WITHDRAW, (m) => handleVaultAction("withdraw", m));
}

/** Global, aggregate snapshot for the proxy /state endpoint. */
export function reportState(): unknown {
  let signed = 0;
  let refused = 0;
  let deposits = 0;
  for (const s of users.values()) {
    signed += s.actionsSigned;
    refused += s.actionsRefused;
    deposits += s.depositsConfirmed;
  }
  return {
    hasSeed: wallets.hasSeed(),
    users: users.size,
    actionsSigned: signed,
    actionsRefused: refused,
    depositsConfirmed: deposits,
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

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** Pull and validate the `user` (owner) field from a decoded payload. */
function reqUser(o: unknown): [Address | null, string | null] {
  if (typeof o !== "object" || o === null || Array.isArray(o)) {
    return [null, "expected a JSON object"];
  }
  const v = (o as Record<string, unknown>)["user"];
  if (typeof v !== "string" || !ADDRESS_RE.test(v)) {
    return [null, `"user" must be a 20-byte address`];
  }
  return [v, null];
}

// --- handlers ---------------------------------------------------------------

/** WALLET/UPDATE_KEY — deliver the master seed, encrypted to the TEE. */
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
    await wallets.loadEncryptedSeed(signPort, raw);
  } catch (e) {
    return [null, 0, `seed update failed: ${msgOf(e)}`];
  }
  return okJson({ ok: true });
}

/**
 * WALLET/CREATE — derive and reveal a user's managed wallet from the master seed.
 * Deterministic: calling it again for the same user returns the same address.
 * This is what the app calls to onboard a new user and learn the address it must
 * register on-chain (MindorrVault.registerAccount).
 */
export function handleCreateWallet(msg: string): HandlerResult {
  if (!wallets.hasSeed()) return [null, 0, "no master seed loaded"];

  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];
  const [user, uerr] = reqUser(obj);
  if (uerr) return [null, 0, uerr];

  let walletAddress: string;
  try {
    walletAddress = wallets.walletFor(user!).address();
  } catch (e) {
    return [null, 0, `derive failed: ${msgOf(e)}`];
  }
  // Materialize the user's state so they appear in the enclave census.
  userState(user!);
  return okJson({ user: user!, walletAddress });
}

/** VAULT/SET_POLICY — set a user's policy (allowlist, caps, return address). */
export function handleSetPolicy(msg: string): HandlerResult {
  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];

  let p: Policy;
  try {
    p = parsePolicy(obj);
  } catch (e) {
    return [null, 0, `invalid policy: ${msgOf(e)}`];
  }
  // The policy owner IS the tenant key. No separate user field needed.
  userState(p.owner).policy = p;
  return okJson({ ok: true, user: p.owner, riskLevel: p.riskLevel, allowedVenues: p.allowedVenues.length });
}

/**
 * VAULT/CONFIRM_DEPOSIT — verify, via an FDC Payment proof, that a user's XRP
 * actually arrived, before any FXRP is credited to them. The on-chain
 * AssetManagerFXRP.executeMinting(proof) is a separate tx (docs/DEPLOY.md); this
 * is the confidential check that gates it.
 */
export function handleConfirmDeposit(msg: string): HandlerResult {
  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];
  const [user, uerr] = reqUser(obj);
  if (uerr) return [null, 0, uerr];

  const st = userState(user!);
  if (st.policy === null) return [null, 0, "no policy set"];

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

  st.confirmedDrops += parsed.proof.receivedAmount;
  st.depositsConfirmed++;
  return okJson({
    confirmed: true,
    user: user!,
    receivedFxrp: parsed.proof.receivedAmount.toString(),
    totalConfirmedFxrp: st.confirmedDrops.toString(),
    reference: parsed.proof.standardPaymentReference,
  });
}

/** VAULT/{ALLOCATE,REBALANCE,WITHDRAW} — evaluate, then sign only if allowed. */
export async function handleVaultAction(kind: IntentKind, msg: string): Promise<HandlerResult> {
  const [obj, err] = decodeJson(msg);
  if (err) return [null, 0, `decoding request: ${err}`];
  const [user, uerr] = reqUser(obj);
  if (uerr) return [null, 0, uerr];

  const st = userState(user!);
  if (st.policy === null) return [null, 0, "no policy set"];
  if (!wallets.hasSeed()) return [null, 0, "no managed key loaded"];

  let intent: Intent;
  try {
    intent = parseVaultIntent(kind, obj);
  } catch (e) {
    return [null, 0, `invalid ${kind}: ${msgOf(e)}`];
  }

  const decision = evaluateIntent(st.policy, intent);
  if (!decision.allow) {
    st.actionsRefused++;
    return [null, 0, `refused ${decision.code}: ${decision.reason}`];
  }

  const digest = actionDigest(intent);
  let signature: string;
  let signer: string;
  try {
    const wallet = wallets.walletFor(user!);
    signer = wallet.address();
    signature = await wallet.signDigest(digest);
  } catch (e) {
    return [null, 0, `signing failed: ${msgOf(e)}`];
  }

  st.actionsSigned++;
  return okJson({
    user: user!,
    signer,
    kind: intent.kind,
    asset: intent.asset,
    amount: intent.amount.toString(),
    destination: intent.to ?? intent.venue,
    digest,
    signature,
  });
}
