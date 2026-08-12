/**
 * The agent API, now LIVE and per-user. Every fund-touching action drives the
 * VPS live-server, which sends a real on-chain instruction to the enclave and
 * returns the enclave's real result: a fresh signature (allowed) or a refusal
 * (guard rejected it). The user's wallet is derived in-enclave from their own
 * address; nothing here is simulated.
 */

import { parse } from "@/lib/brain";
import { getVaultFxrp, getXrpUsd, type XrpPrice } from "@/lib/coston2";
import { liveAllocate, liveHealth, liveOnboard, liveWithdraw } from "@/lib/enclave";

const EXPLORER = "https://coston2-explorer.flare.network";
const NOMINAL_AMOUNT = "1000000"; // 1 FXRP (6dp), the enclave signs regardless of balance
const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;
const txLink = (h: string): string => `${EXPLORER}/tx/${h}`;

interface Step {
  label: string;
  detail: string;
  ok: boolean;
  code?: string;
  link?: string;
}

interface AgentState {
  onboarded: boolean;
  user?: string;
  walletAddress?: string;
  riskLevel?: string;
  signed: number;
  refused: number;
}

const initialState = (): AgentState => ({ onboarded: false, signed: 0, refused: 0 });

const NOT_YET = 'Nothing set up yet. Try "put my XRP to work, low risk" and I\'ll create your enclave wallet.';
const OFFLINE =
  "I can't reach the enclave right now (the VPS live-server may be down). On-chain proofs still stand on the Verify page; live actions need the enclave online.";

function statusText(state: AgentState, price: XrpPrice | null, vaultFxrp: number | null): string {
  if (!state.onboarded) return NOT_YET;
  const lines: string[] = [];
  lines.push(`**Your enclave wallet:** ${short(state.walletAddress ?? "")}, derived inside the TEE from your address, ${short(state.user ?? "")}.`);
  lines.push(`**Policy:** ${state.riskLevel ?? "moderate"} · withdrawals only ever to your own address.`);
  lines.push(`**Enclave actions:** ${state.signed} signed, ${state.refused} refused (this session).`);
  if (vaultFxrp !== null) {
    lines.push(`**Vault FXRP (on-chain):** ${vaultFxrp.toLocaleString()} FXRP.`);
  }
  if (price) {
    lines.push(`**XRP/USD (live from Flare FTSO):** $${price.usd.toFixed(4)}.`);
  }
  return lines.join("\n");
}

export async function POST(request: Request): Promise<Response> {
  const body = (await request.json().catch(() => ({}))) as {
    message?: string;
    user?: string;
    state?: AgentState;
  };
  const message = body.message ?? "";
  const user = body.user;
  let state: AgentState = body.state ?? initialState();
  const action = parse(message);
  const price = await getXrpUsd();

  // The read-only priming call (empty message) just returns price + health.
  if (message === "") {
    const health = await liveHealth();
    return Response.json({ reply: "", steps: [], state, price, enclaveUp: health !== null });
  }

  if (!user) {
    return Response.json({
      reply: "I need your identity address to create your enclave wallet. Reload the page so it can generate one.",
      steps: [],
      state,
      price,
    });
  }

  let reply = "";
  let steps: Step[] = [];

  switch (action.kind) {
    case "onboard": {
      if (state.onboarded) {
        reply = 'You\'re already set up. Say "status" to see it, or "withdraw" to test the guard.';
        break;
      }
      const r = await liveOnboard(user, action.risk);
      if (!r || !r.ok) {
        reply = OFFLINE;
        break;
      }
      state = {
        onboarded: true,
        user,
        walletAddress: r.walletAddress,
        riskLevel: r.riskLevel,
        signed: 0,
        refused: 0,
      };
      steps = [
        {
          label: "Created your private wallet, in the enclave",
          detail: `The TEE derived a signing key unique to you and revealed only its address ${short(r.walletAddress)}. The key was born inside the enclave and never leaves it.`,
          ok: true,
          link: txLink(r.createTx),
        },
        {
          label: "Set your policy",
          detail: `${cap(r.riskLevel)} · one allowlisted venue · withdrawals only ever to your own address ${short(user)}. The allowlist lives inside the enclave.`,
          ok: true,
          link: txLink(r.policyTx),
        },
      ];
      // Prove a real allocation signature right away.
      const alloc = await liveAllocate(user, NOMINAL_AMOUNT);
      if (alloc?.ok && alloc.signature) {
        state.signed += 1;
        steps.push({
          label: "Signed a real allocation",
          detail: `The enclave evaluated the guard and signed a ${fmtFxrp(NOMINAL_AMOUNT)} allocation with your key. Signature ${short(alloc.signature)}, the exact one MindorrVault verifies on-chain.`,
          ok: true,
          link: txLink(alloc.tx),
        });
      }
      reply = `Done, and all real: your enclave wallet exists, your policy is set, and the enclave signed a live allocation with your key. To move actual FXRP you fund your vault (I'll show you how). Say "status", or try "send it to 0xdead…" to watch the guard refuse it.`;
      break;
    }

    case "status": {
      const vaultFxrp = await getVaultFxrp();
      reply = statusText(state, price, vaultFxrp);
      break;
    }

    case "rebalance": {
      if (!state.onboarded) {
        reply = NOT_YET;
        break;
      }
      const r = await liveAllocate(user, NOMINAL_AMOUNT);
      if (!r) {
        reply = OFFLINE;
        break;
      }
      if (r.ok && r.signature) {
        state.signed += 1;
        steps = [{
          label: "Re-signed within policy",
          detail: `The enclave re-evaluated and signed with your key. Signature ${short(r.signature)}.`,
          ok: true,
          link: txLink(r.tx),
        }];
        reply = "Checked against your policy and re-signed. Still within bounds.";
      } else {
        reply = "The enclave declined that. Details in the step below.";
        steps = [{ label: "Refused", detail: r.log ?? "guard refused", ok: false, link: txLink(r.tx) }];
      }
      break;
    }

    case "withdraw": {
      if (!state.onboarded) {
        reply = NOT_YET;
        break;
      }
      const to = action.to ?? user; // default: your own address (allowed)
      const r = await liveWithdraw(user, NOMINAL_AMOUNT, to);
      if (!r) {
        reply = OFFLINE;
        break;
      }
      if (r.ok && r.signature) {
        state.signed += 1;
        steps = [{
          label: "Signed a withdrawal to your address",
          detail: `Destination is your own return address ${short(to)}, so the enclave signed it. Signature ${short(r.signature)}.`,
          ok: true,
          link: txLink(r.tx),
        }];
        reply = "Allowed. The enclave signed a withdrawal back to your own wallet.";
      } else {
        state.refused += 1;
        steps = [{
          label: "Blocked the withdrawal",
          detail: `${r.log ?? "refused"}. Even I can't send your funds there, the allowlist lives inside the enclave, where a compromised brain can't reach it.`,
          ok: false,
          code: extractCode(r.log),
          link: txLink(r.tx),
        }];
        reply = "I refused that. Withdrawals can only ever go to your own return address, enforced inside the enclave, so not even a hijacked instruction can redirect your funds.";
      }
      break;
    }

    default: {
      reply =
        'I\'m your private XRP money-manager. In plain English:\n• "Put my XRP to work, low risk"\n• "How\'s it doing?"\n• "Send it all to 0xdead…" (watch the guard refuse)\n• "Withdraw everything"\nYour key is generated inside the enclave and never leaves.';
    }
  }

  return Response.json({ reply, steps, state, price });
}

const cap = (r: string): string => r.charAt(0).toUpperCase() + r.slice(1) + " risk";
const fmtFxrp = (base: string): string => `${(Number(base) / 1_000_000).toLocaleString()} FXRP`;

function extractCode(log?: string): string | undefined {
  if (!log) return undefined;
  const m = log.match(/refused ([A-Z_]+)/);
  return m ? m[1] : undefined;
}
