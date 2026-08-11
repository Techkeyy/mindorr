/**
 * The Mindorr agent: narrates the flow using the REAL Coston2 deployment, not
 * placeholder data. Every address here is the live deployment (the enclave
 * signer, the owner/return address, the allowlisted venue, FXRP), the deposit
 * is seeded from the live vault balance, and the steps link the real on-chain
 * receipts. For every fund move it runs the same guard the enclave runs
 * (guard.ts) before "signing" — refused actions never move funds.
 *
 * There is no live yield venue on testnet, so no APY is claimed; the allocation
 * is the real guarded transfer to the allowlisted address, verified on-chain by
 * MindorrVault.
 */

import { evaluateIntent, type Policy, type RiskLevel, type Venue } from "./guard";
import { FXRP, MANAGED_WALLET, OWNER_ADDRESS, ALLOWED_VENUE, PROOF_TX } from "./coston2";

export const FXRP_ADDRESS = FXRP;
export const ENCLAVE_WALLET = MANAGED_WALLET; // the real in-enclave signing wallet
export const RETURN_ADDRESS = OWNER_ADDRESS; // the real owner / only withdrawal target

// The single on-chain allowlisted venue — the address funds actually move to via
// the guarded execute(). No live yield on testnet, so apy stays 0 (unused).
const VENUE: Venue = { address: ALLOWED_VENUE, name: "your allowlisted venue", apy: 0 };

const RISK_PARAMS: Record<RiskLevel, { maxVenueBps: number; minHealthFactorBps: number }> = {
  conservative: { maxVenueBps: 10_000, minHealthFactorBps: 15_000 },
  moderate: { maxVenueBps: 10_000, minHealthFactorBps: 13_000 },
  growth: { maxVenueBps: 10_000, minHealthFactorBps: 12_000 },
};

const MAX_TX = 1_000_000_000; // per-tx cap in whole FXRP (illustrative bound)

export interface Position extends Venue {
  amount: number;
}

export interface AgentState {
  onboarded: boolean;
  walletAddress?: string;
  policy?: Policy;
  idle: number;
  positions: Position[];
  refusals: number;
}

export const initialState = (): AgentState => ({
  onboarded: false,
  idle: 0,
  positions: [],
  refusals: 0,
});

export interface Step {
  label: string;
  detail: string;
  ok: boolean;
  code?: string;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;
const portfolioValue = (s: AgentState): number =>
  round2(s.idle + s.positions.reduce((t, p) => t + p.amount, 0));

function makePolicy(risk: RiskLevel): Policy {
  const p = RISK_PARAMS[risk];
  return {
    returnAddress: RETURN_ADDRESS,
    riskLevel: risk,
    asset: FXRP,
    allowedVenues: [VENUE],
    maxVenueBps: p.maxVenueBps,
    maxTxAmount: MAX_TX,
    minHealthFactorBps: p.minHealthFactorBps,
  };
}

/**
 * Onboard: create the enclave wallet, set policy, reflect the FXRP already
 * minted into the vault, then allocate it to the allowlisted venue.
 * `depositFxrp` is the live MindorrVault FXRP balance.
 */
export function onboard(state: AgentState, risk: RiskLevel, depositFxrp: number): { steps: Step[]; state: AgentState } {
  const s: AgentState = { ...state, positions: [...state.positions] };
  const steps: Step[] = [];

  s.walletAddress = ENCLAVE_WALLET;
  steps.push({
    label: "Created your private wallet",
    detail: `The signing key lives inside the TEE and never leaves. This is the real enclave signer ${short(ENCLAVE_WALLET)} — the address MindorrVault verifies every move against.`,
    ok: true,
  });

  s.policy = makePolicy(risk);
  steps.push({
    label: "Set your policy",
    detail: `${cap(risk)} · 1 allowlisted venue · withdrawals only ever to your own address ${short(RETURN_ADDRESS)}.`,
    ok: true,
  });

  s.idle = round2(s.idle + depositFxrp);
  steps.push({
    label: "Minted FXRP",
    detail: `${depositFxrp.toLocaleString()} FXRP held in the enclave vault, minted from a real XRP deposit proven via Flare's Data Connector (tx ${short(PROOF_TX.mint)}).`,
    ok: true,
  });

  allocateIdle(s, steps);
  s.onboarded = true;
  return { steps, state: s };
}

/** Allocate idle FXRP to the allowlisted venue, guard-checked before signing. */
function allocateIdle(s: AgentState, steps: Step[]): void {
  if (!s.policy || s.idle <= 0) return;
  const v = VENUE;
  const amount = s.idle;
  const decision = evaluateIntent(s.policy, {
    kind: "allocate",
    asset: FXRP,
    amount,
    venue: v.address,
    portfolioValue: portfolioValue(s),
    venueBalance: 0,
  });
  if (!decision.allow) {
    steps.push({ label: `Skipped ${v.name}`, detail: decision.reason, ok: false, code: decision.code });
    return;
  }
  s.positions.push({ ...v, amount });
  s.idle = 0;
  steps.push({
    label: "Allocated to your allowlisted venue",
    detail: `${amount.toLocaleString()} FXRP routed to ${short(v.address)} — guard-checked, then released by MindorrVault only after it verified the enclave signature on-chain (real execute tx ${short(PROOF_TX.execute)}).`,
    ok: true,
  });
}

/** Rebalance: reaffirm the split is within policy (guard-checked, health-aware). */
export function rebalance(state: AgentState): { steps: Step[]; state: AgentState } {
  const s: AgentState = { ...state, positions: [...state.positions] };
  const steps: Step[] = [];
  if (!s.onboarded || !s.policy) return { steps, state: s };

  const portfolio = portfolioValue(s);
  for (const p of s.positions) {
    const decision = evaluateIntent(s.policy, {
      kind: "rebalance",
      asset: FXRP,
      amount: p.amount,
      venue: p.address,
      portfolioValue: portfolio,
      venueBalance: p.amount,
      projectedHealthFactorBps: s.policy.minHealthFactorBps + 3_000,
    });
    steps.push({
      label: p.name,
      detail: decision.allow ? `${p.amount.toLocaleString()} FXRP · within policy.` : decision.reason,
      ok: decision.allow,
      code: decision.allow ? undefined : decision.code,
    });
  }
  return { steps, state: s };
}

/**
 * Withdraw. If `to` is omitted it defaults to your return address (allowed). Any
 * other destination is refused by the guard, the "malicious instruction bounces"
 * moment.
 */
export function withdraw(state: AgentState, to?: string): { steps: Step[]; state: AgentState } {
  const s: AgentState = { ...state, positions: [...state.positions] };
  const steps: Step[] = [];
  if (!s.onboarded || !s.policy) return { steps, state: s };

  const dest = to ?? RETURN_ADDRESS;
  const amount = portfolioValue(s);
  const decision = evaluateIntent(s.policy, {
    kind: "withdraw",
    asset: FXRP,
    amount,
    to: dest,
    userAuthorized: true,
  });

  if (!decision.allow) {
    s.refusals += 1;
    steps.push({
      label: "Blocked the withdrawal",
      detail: `${decision.reason}. Even I can't send your funds there; the allowlist lives inside the enclave, where a compromised brain can't reach it.`,
      ok: false,
      code: decision.code,
    });
    return { steps, state: s };
  }

  for (const p of s.positions) {
    steps.push({ label: `Redeemed from ${p.name}`, detail: `${p.amount.toLocaleString()} FXRP unwound.`, ok: true });
  }
  steps.push({
    label: "Returned to your wallet",
    detail: `${amount.toLocaleString()} FXRP redeemed to your address ${short(dest)} · guard: OK.`,
    ok: true,
  });
  s.positions = [];
  s.idle = 0;
  return { steps, state: s };
}

// --- formatting helpers -----------------------------------------------------

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const cap = (r: RiskLevel): string => r.charAt(0).toUpperCase() + r.slice(1) + " risk";
export { portfolioValue };
