/**
 * Mindorr guard — demo mirror of extension/typescript/src/app/policy.ts.
 *
 * Same rules, same refusal codes; amounts are plain XRP units here (the extension
 * uses FXRP base-unit bigints). This is what makes the chat demo show *real*
 * decisions: the UI runs the exact guard the enclave runs before it signs.
 */

export type RiskLevel = "conservative" | "moderate" | "growth";
export type IntentKind = "allocate" | "rebalance" | "withdraw";

export interface Venue {
  address: string;
  name: string;
  apy: number;
}

export interface Policy {
  returnAddress: string;
  riskLevel: RiskLevel;
  asset: string;
  allowedVenues: Venue[];
  maxVenueBps: number;
  maxTxAmount: number;
  minHealthFactorBps: number;
}

export interface Intent {
  kind: IntentKind;
  asset: string;
  amount: number;
  venue?: string;
  to?: string;
  userAuthorized?: boolean;
  portfolioValue?: number;
  venueBalance?: number;
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
const deny = (code: DecisionCode, reason: string): Decision => ({ allow: false, code, reason });

export const eqAddr = (a?: string, b?: string): boolean =>
  !!a && !!b && a.toLowerCase() === b.toLowerCase();

export const isAllowedVenue = (policy: Policy, venue?: string): boolean =>
  !!venue && policy.allowedVenues.some((v) => eqAddr(v.address, venue));

export function evaluateIntent(policy: Policy, intent: Intent): Decision {
  if (intent.amount <= 0) return deny("ZERO_AMOUNT", "amount must be greater than zero");
  if (!eqAddr(intent.asset, policy.asset)) {
    return deny("ASSET_NOT_ALLOWED", `asset ${intent.asset} is not the managed asset`);
  }
  if (intent.amount > policy.maxTxAmount) {
    return deny("AMOUNT_EXCEEDS_CAP", `amount ${intent.amount} exceeds per-tx cap ${policy.maxTxAmount}`);
  }

  switch (intent.kind) {
    case "allocate":
    case "rebalance": {
      if (!isAllowedVenue(policy, intent.venue)) {
        return deny("DEST_NOT_ALLOWED", `venue ${intent.venue ?? "(none)"} is not on the allowlist`);
      }
      if (policy.maxVenueBps < 10_000 && intent.portfolioValue && intent.portfolioValue > 0) {
        const projected = (intent.venueBalance ?? 0) + intent.amount;
        const cap = (intent.portfolioValue * policy.maxVenueBps) / 10_000;
        if (projected > cap) {
          return deny("VENUE_CONCENTRATION", `venue would exceed the ${policy.maxVenueBps / 100}% cap`);
        }
      }
      if (
        intent.kind === "rebalance" &&
        intent.projectedHealthFactorBps !== undefined &&
        intent.projectedHealthFactorBps < policy.minHealthFactorBps
      ) {
        return deny("HEALTH_FACTOR", `projected health below the floor`);
      }
      return ALLOW;
    }
    case "withdraw": {
      if (intent.userAuthorized !== true) {
        return deny("NEEDS_USER_SIGNATURE", "withdrawals require a fresh owner signature");
      }
      if (!eqAddr(intent.to, policy.returnAddress)) {
        return deny("WITHDRAW_NON_RETURN", `destination is not your return address`);
      }
      return ALLOW;
    }
    default:
      return deny("UNKNOWN_INTENT", "unknown intent");
  }
}
