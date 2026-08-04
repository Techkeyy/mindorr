/**
 * The brain — turns a plain-English message into an action.
 *
 * Deterministic and offline for a reliable demo; the shape (message → typed
 * action) is exactly where an LLM slots in later. It decides *intent* only and
 * never touches funds — every fund move still goes through the guard.
 */

import type { RiskLevel } from "./guard";

export type Action =
  | { kind: "onboard"; risk: RiskLevel }
  | { kind: "status" }
  | { kind: "rebalance" }
  | { kind: "withdraw"; to?: string }
  | { kind: "help" };

const has = (t: string, ...words: string[]): boolean => words.some((w) => t.includes(w));

function detectRisk(t: string): RiskLevel {
  if (has(t, "conservative", "low risk", "low-risk", "safe", "safest", "cautious", "careful")) {
    return "conservative";
  }
  if (has(t, "aggressive", "growth", "high risk", "high-risk", "high yield", "high-yield", "max")) {
    return "growth";
  }
  return "moderate";
}

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/;

export function parse(message: string): Action {
  const t = message.toLowerCase().trim();

  if (has(t, "withdraw", "take out", "cash out", "cash it out", "redeem", "pull out", "get my", "send it", "send my", "move my")) {
    const m = message.match(ADDRESS_RE);
    return { kind: "withdraw", to: m ? m[0] : undefined };
  }
  if (has(t, "rebalance", "rebalanced", "re-balance")) {
    return { kind: "rebalance" };
  }
  if (has(t, "status", "how's", "hows", "how is", "how are", "doing", "balance", "positions", "portfolio", "holdings", "where")) {
    return { kind: "status" };
  }
  if (
    has(t, "put", "invest", "work", "earn", "yield", "start", "go", "deploy", "grow", "stake", "let's", "lets", "begin", "do it")
  ) {
    return { kind: "onboard", risk: detectRisk(t) };
  }
  return { kind: "help" };
}
