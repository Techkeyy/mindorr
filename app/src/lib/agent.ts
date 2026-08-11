/**
 * The Mindorr agent: the money-manager the chat talks to.
 *
 * It holds a tiny in-memory portfolio and, for every fund move, runs the same
 * guard the enclave runs (guard.ts) before "signing". Refused actions never move
 * funds; that's the trust story, live in the demo.
 *
 * Amounts are XRP units for legibility. The enclave works in FXRP base units.
 */

import { evaluateIntent, type Policy, type RiskLevel, type Venue } from "./guard";

const addr = (prefix: string): string => `0x${prefix}${"0".repeat(40 - prefix.length)}`;

export const FXRP = "0x0b6A3645c240605887a5532109323A3E12273dc7"; // verified Coston2 FXRP
export const ENCLAVE_WALLET = addr("e0c1a5e0"); // simulated in-enclave wallet address
export const RETURN_ADDRESS = addr("abcdef01"); // "your own wallet"

const VAULT_A: Venue = { address: addr("a11a0001"), name: "Morpho FXRP/USDC (blue-chip)", apy: 4.2 };
const VAULT_B: Venue = { address: addr("b00b0002"), name: "Mystic Core FXRP", apy: 6.9 };
const VAULT_C: Venue = { address: addr("c0c00003"), name: "Kinetic High-Yield FXRP", apy: 11.4 };

const CATALOG: Record<RiskLevel, Venue[]> = {
  conservative: [VAULT_A],
  moderate: [VAULT_A, VAULT_B],
  growth: [VAULT_A, VAULT_B, VAULT_C],
};

const RISK_PARAMS: Record<RiskLevel, { maxVenueBps: number; minHealthFactorBps: number }> = {
  conservative: { maxVenueBps: 10_000, minHealthFactorBps: 15_000 },
  moderate: { maxVenueBps: 6_000, minHealthFactorBps: 13_000 },
  growth: { maxVenueBps: 5_000, minHealthFactorBps: 12_000 },
};

const DEMO_DEPOSIT = 5_000; // XRP the demo "detects" as idle
const MAX_TX = 1_000_000;

export interface Position extends Venue {
  amount: number;
}

export interface AgentState {
  onboarded: boolean;
  walletAddress?: string;
  policy?: Policy;
  idle: number; // FXRP minted, not yet allocated
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
    allowedVenues: CATALOG[risk],
    maxVenueBps: p.maxVenueBps,
    maxTxAmount: MAX_TX,
    minHealthFactorBps: p.minHealthFactorBps,
  };
}

/** Onboard: create the enclave wallet, set policy, mint FXRP, allocate. */
export function onboard(state: AgentState, risk: RiskLevel): { steps: Step[]; state: AgentState } {
  const s: AgentState = { ...state, positions: [...state.positions] };
  const steps: Step[] = [];

  s.walletAddress = ENCLAVE_WALLET;
  steps.push({
    label: "Created your private wallet",
    detail: `The signing key was generated inside the TEE and never leaves. Nobody, including us, can move your funds. Wallet ${short(ENCLAVE_WALLET)}.`,
    ok: true,
  });

  s.policy = makePolicy(risk);
  steps.push({
    label: "Set your policy",
    detail: `${cap(risk)} · ${s.policy.allowedVenues.length} approved vault${s.policy.allowedVenues.length > 1 ? "s" : ""} · withdrawals only ever to your own address.`,
    ok: true,
  });

  s.idle = round2(s.idle + DEMO_DEPOSIT);
  steps.push({
    label: "Minted FXRP",
    detail: `Detected ${DEMO_DEPOSIT.toLocaleString()} idle XRP and wrapped it into FXRP (deposit proven via FDC). Held in your private wallet.`,
    ok: true,
  });

  allocateIdle(s, steps);
  s.onboarded = true;
  return { steps, state: s };
}

/** Spread idle FXRP evenly across the allowed vaults, guard-checking each move. */
function allocateIdle(s: AgentState, steps: Step[]): void {
  if (!s.policy || s.idle <= 0) return;
  const venues = s.policy.allowedVenues;
  const portfolio = portfolioValue(s);
  const per = round2(s.idle / venues.length);

  for (const v of venues) {
    if (s.idle <= 0) break;
    const amount = Math.min(per, s.idle);
    const existing = s.positions.find((p) => p.address === v.address);
    const decision = evaluateIntent(s.policy, {
      kind: "allocate",
      asset: FXRP,
      amount,
      venue: v.address,
      portfolioValue: portfolio,
      venueBalance: existing?.amount ?? 0,
    });
    if (!decision.allow) {
      steps.push({ label: `Skipped ${v.name}`, detail: decision.reason, ok: false, code: decision.code });
      continue;
    }
    if (existing) existing.amount = round2(existing.amount + amount);
    else s.positions.push({ ...v, amount });
    s.idle = round2(s.idle - amount);
    steps.push({
      label: `Allocated to ${v.name}`,
      detail: `${amount.toLocaleString()} FXRP → ~${v.apy}% APY · guard: OK, signed in-enclave.`,
      ok: true,
    });
  }
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
      label: `${p.name}`,
      detail: decision.allow
        ? `${p.amount.toLocaleString()} FXRP · within policy, health above floor.`
        : decision.reason,
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
    detail: `${amount.toLocaleString()} FXRP redeemed to XRP and sent to your address ${short(dest)} · guard: OK.`,
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
