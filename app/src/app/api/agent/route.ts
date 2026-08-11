import { parse } from "@/lib/brain";
import {
  initialState,
  onboard,
  portfolioValue,
  rebalance,
  short,
  withdraw,
  type AgentState,
  type Step,
} from "@/lib/agent";
import { getXrpUsd, type XrpPrice } from "@/lib/coston2";

const NOT_YET = 'Nothing invested yet. Try "put my XRP to work, low risk" and I\'ll take it from there.';

function blendedApy(state: AgentState): number {
  const total = state.positions.reduce((t, p) => t + p.amount, 0);
  if (total === 0) return 0;
  return Math.round((state.positions.reduce((t, p) => t + p.amount * p.apy, 0) / total) * 10) / 10;
}

function statusText(state: AgentState, price: XrpPrice | null): string {
  if (!state.onboarded) return NOT_YET;
  const pv = portfolioValue(state);
  const lines: string[] = [];
  lines.push(`**Portfolio:** ${pv.toLocaleString()} FXRP across ${state.positions.length} vault${state.positions.length > 1 ? "s" : ""} · blended ~${blendedApy(state)}% APY.`);
  for (const p of state.positions) {
    lines.push(`• ${p.name}: ${p.amount.toLocaleString()} FXRP (~${p.apy}%)`);
  }
  if (price) {
    lines.push(`**XRP/USD (live from Flare FTSO):** $${price.usd.toFixed(4)} → your position ≈ $${(pv * price.usd).toLocaleString(undefined, { maximumFractionDigits: 0 })}.`);
  }
  lines.push(`Your balances and strategy stay inside the enclave, so none of this is visible on the public chain. Wallet ${short(state.walletAddress!)}.`);
  return lines.join("\n");
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    state?: AgentState;
  };
  const message = body.message ?? "";
  let state: AgentState = body.state ?? initialState();
  const action = parse(message);
  const price = await getXrpUsd();

  let reply = "";
  let steps: Step[] = [];

  switch (action.kind) {
    case "onboard": {
      if (state.onboarded) {
        reply = 'You\'re already set up. Say "status" to see how it\'s doing, or "withdraw" to pull out.';
        break;
      }
      const r = onboard(state, action.risk);
      state = r.state;
      steps = r.steps;
      reply = `Done. Your XRP is working across ${state.positions.length} vault${state.positions.length > 1 ? "s" : ""}, blended ~${blendedApy(state)}% APY, all inside the sealed enclave. I never held your keys, and your positions aren't public. Say "status" any time, or "withdraw" to pull out.`;
      break;
    }
    case "status": {
      reply = statusText(state, price);
      break;
    }
    case "rebalance": {
      if (!state.onboarded) {
        reply = NOT_YET;
        break;
      }
      const r = rebalance(state);
      state = r.state;
      steps = r.steps;
      reply = "Checked every position against your policy. All within bounds and above the health floor, no moves needed.";
      break;
    }
    case "withdraw": {
      if (!state.onboarded) {
        reply = NOT_YET;
        break;
      }
      const r = withdraw(state, action.to);
      state = r.state;
      steps = r.steps;
      const blocked = steps.some((s) => !s.ok);
      reply = blocked
        ? "I refused that. Withdrawals can only ever go to your own return address, enforced inside the enclave, so not even a hijacked instruction can redirect your funds."
        : "All done. Everything redeemed back to XRP and returned to your own wallet.";
      break;
    }
    default: {
      reply =
        'I\'m your XRP money-manager. Tell me what you want in plain English:\n• "Put my XRP to work, low risk"\n• "How\'s it doing?"\n• "Withdraw everything"\nYour keys never leave the enclave and your positions stay private.';
    }
  }

  return Response.json({ reply, steps, state, price });
}
