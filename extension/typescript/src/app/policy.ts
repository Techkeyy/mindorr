/**
 * ★ Mindorr trust core — the in-enclave policy + destination allowlist guard.
 *
 * This is the one thing that makes Mindorr more than a yield bot. Flare's
 * `fce-sign` primitive proves a key can live and sign *inside* the TEE and never
 * leave. Mindorr adds the missing half: before the enclave signs anything that
 * moves funds, the intent is evaluated against the owner's policy here. If it
 * fails, the enclave refuses to sign.
 *
 * The guarantee this encodes: **a compromised or malicious brain can still only
 * move funds to (a) a pre-approved vault, or (b) the owner's own return
 * address.** Nothing else can be signed, ever — the allowlist lives where the
 * brain cannot reach it.
 *
 * This module is intentionally pure (no I/O, no TEE calls) so it is fully
 * unit-testable off-chain. `handlers.ts` wires it to the enclave signer.
 */

export type Address = string;

export type RiskLevel = "conservative" | "moderate" | "growth";

/** The three fund-moving intents the agent can produce. */
export type IntentKind = "allocate" | "rebalance" | "withdraw";

/**
 * The owner's policy. Set once (user-authorized) via SET_POLICY, then enforced
 * on every subsequent action. `returnAddress` and `allowedVenues` are the only
 * destinations funds can ever reach.
 */
export interface Policy {
  /** Owner / beneficiary of this managed wallet. */
  owner: Address;
  /** The ONLY external address a withdrawal may target. Usually the user's own wallet. */
  returnAddress: Address;
  /** Declared risk appetite. Informational + used to bound venue concentration. */
  riskLevel: RiskLevel;
  /** The asset under management (FXRP). Actions on any other asset are refused. */
  asset: Address;
  /** Lending vaults the agent is permitted to deposit into. */
  allowedVenues: Address[];
  /** Max share of the portfolio allowed in any single venue, in basis points (10000 = 100%). */
  maxVenueBps: number;
  /** Per-transaction cap, in asset base units. Bounds blast radius of any single signature. */
  maxTxAmount: bigint;
  /** A rebalance must leave the position's health factor at or above this (10000 = 1.0). */
  minHealthFactorBps: number;
}

/**
 * A decoded, proposed action awaiting the guard's verdict. Produced by decoding
 * an FCC instruction's `originalMessage`; context fields (portfolioValue,
 * venueBalance, projectedHealthFactorBps) are supplied by the handler from
 * on-chain / FTSO reads.
 */
export interface Intent {
  kind: IntentKind;
  asset: Address;
  amount: bigint;
  /** Destination vault for `allocate` / `rebalance`. */
  venue?: Address;
  /** Destination for `withdraw`. Must equal policy.returnAddress. */
  to?: Address;
  /**
   * True iff this action arrived with a fresh owner signature (enforced on-chain
   * by the instruction sender). Autonomous actions (allocate/rebalance) do not
   * require it; withdrawals do.
   */
  userAuthorized?: boolean;
  /** Total portfolio value in asset units, for concentration checks. */
  portfolioValue?: bigint;
  /** Amount already sitting in `venue`, for concentration checks. */
  venueBalance?: bigint;
  /** Resulting health factor (bps) if this rebalance executes. */
  projectedHealthFactorBps?: number;
}

export type DecisionCode =
  | "OK"
  | "ZERO_AMOUNT"
  | "ASSET_NOT_ALLOWED"
  | "AMOUNT_EXCEEDS_CAP"
  | "DEST_NOT_ALLOWED"
  | "WITHDRAW_NON_RETURN"
  | "NEEDS_USER_SIGNATURE"
  | "VENUE_CONCENTRATION"
  | "HEALTH_FACTOR"
  | "UNKNOWN_INTENT";

export interface Decision {
  allow: boolean;
  code: DecisionCode;
  reason: string;
}

const ALLOW: Decision = { allow: true, code: "OK", reason: "ok" };

function deny(code: DecisionCode, reason: string): Decision {
  return { allow: false, code, reason };
}

/** Case-insensitive address equality. Addresses arrive in mixed case from the wire. */
export function eqAddr(a: Address | undefined, b: Address | undefined): boolean {
  if (!a || !b) return false;
  return a.toLowerCase() === b.toLowerCase();
}

/** Is `venue` on the policy's allowlist? */
export function isAllowedVenue(policy: Policy, venue: Address | undefined): boolean {
  if (!venue) return false;
  return policy.allowedVenues.some((v) => eqAddr(v, venue));
}

/**
 * The guard. Returns a verdict; the caller signs only when `allow` is true.
 *
 * Checks are ordered cheapest-and-most-fundamental first, so the returned code
 * names the *first* reason an action was refused — useful for the "malicious
 * instruction bounces" demo and for user-facing explanations.
 */
export function evaluateIntent(policy: Policy, intent: Intent): Decision {
  // Universal invariants -----------------------------------------------------
  if (intent.amount <= 0n) {
    return deny("ZERO_AMOUNT", "amount must be greater than zero");
  }
  if (!eqAddr(intent.asset, policy.asset)) {
    return deny(
      "ASSET_NOT_ALLOWED",
      `asset ${intent.asset} is not the managed asset ${policy.asset}`,
    );
  }
  if (intent.amount > policy.maxTxAmount) {
    return deny(
      "AMOUNT_EXCEEDS_CAP",
      `amount ${intent.amount} exceeds per-tx cap ${policy.maxTxAmount}`,
    );
  }

  // Per-intent destination + authorization rules -----------------------------
  switch (intent.kind) {
    case "allocate":
    case "rebalance": {
      if (!isAllowedVenue(policy, intent.venue)) {
        return deny(
          "DEST_NOT_ALLOWED",
          `venue ${intent.venue ?? "(none)"} is not on the allowlist`,
        );
      }
      // Concentration cap: projected share of the portfolio in this venue.
      if (
        policy.maxVenueBps < 10_000 &&
        intent.portfolioValue !== undefined &&
        intent.portfolioValue > 0n
      ) {
        const projected = (intent.venueBalance ?? 0n) + intent.amount;
        const capAmount = (intent.portfolioValue * BigInt(policy.maxVenueBps)) / 10_000n;
        if (projected > capAmount) {
          return deny(
            "VENUE_CONCENTRATION",
            `venue would hold ${projected}, above the ${policy.maxVenueBps}bps cap of ${capAmount}`,
          );
        }
      }
      // Rebalances must not push the position below the health floor.
      if (
        intent.kind === "rebalance" &&
        intent.projectedHealthFactorBps !== undefined &&
        intent.projectedHealthFactorBps < policy.minHealthFactorBps
      ) {
        return deny(
          "HEALTH_FACTOR",
          `projected health ${intent.projectedHealthFactorBps}bps below floor ${policy.minHealthFactorBps}bps`,
        );
      }
      return ALLOW;
    }

    case "withdraw": {
      // Withdrawals are the exit door — they require a fresh owner signature.
      if (intent.userAuthorized !== true) {
        return deny(
          "NEEDS_USER_SIGNATURE",
          "withdrawals require a fresh owner signature",
        );
      }
      // ...and can only ever go back to the owner's own return address.
      if (!eqAddr(intent.to, policy.returnAddress)) {
        return deny(
          "WITHDRAW_NON_RETURN",
          `withdrawal destination ${intent.to ?? "(none)"} is not the return address ${policy.returnAddress}`,
        );
      }
      return ALLOW;
    }

    default:
      return deny("UNKNOWN_INTENT", `unknown intent kind: ${String((intent as Intent).kind)}`);
  }
}
