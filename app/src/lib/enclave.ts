/**
 * Server-side client for the Mindorr live-server running on the VPS beside the
 * enclave. Every call here triggers a REAL on-chain instruction and returns the
 * enclave's real result (fresh signature or refusal). Nothing is simulated.
 *
 * The live-server URL and optional shared token come from env so they are never
 * committed. If the live-server is unreachable, callers get null and the UI
 * degrades to read-only (on-chain reads still work).
 */

const LIVE_SERVER = process.env.LIVE_SERVER_URL ?? "http://103.195.188.198:8888";
const LIVE_TOKEN = process.env.LIVE_SERVER_TOKEN ?? "";

const TIMEOUT_MS = 45_000; // one action polls the chain; give it room

async function call<T>(path: string, body: unknown): Promise<T | null> {
  try {
    const res = await fetch(`${LIVE_SERVER}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(LIVE_TOKEN ? { "X-Mindorr-Token": LIVE_TOKEN } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

export interface OnboardResult {
  ok: boolean;
  user: string;
  walletAddress: string;
  riskLevel: string;
  venue: string;
  createTx: string;
  policyTx: string;
}

export interface ActionResult {
  ok: boolean;
  tx: string;
  // present on success
  signer?: string;
  kind?: string;
  amount?: string;
  destination?: string;
  digest?: string;
  signature?: string;
  // present on refusal
  refused?: boolean;
  log?: string;
}

/** Create the user's in-enclave wallet and set their policy. Real on-chain. */
export function liveOnboard(user: string, riskLevel: string): Promise<OnboardResult | null> {
  return call<OnboardResult>("/onboard", { user, riskLevel });
}

/** Ask the enclave to sign a real allocation to a venue. */
export function liveAllocate(user: string, amount: string, venue?: string): Promise<ActionResult | null> {
  return call<ActionResult>("/allocate", { user, amount, venue });
}

/** Ask the enclave to sign a real withdrawal to `to` (refused unless it's the return address). */
export function liveWithdraw(user: string, amount: string, to: string): Promise<ActionResult | null> {
  return call<ActionResult>("/withdraw", { user, amount, to });
}

export interface EnclaveHealth {
  ok: boolean;
  proxy: string;
  sender: string;
}

/** Liveness check of the VPS enclave/live-server. */
export async function liveHealth(): Promise<EnclaveHealth | null> {
  try {
    const res = await fetch(`${LIVE_SERVER}/health`, { signal: AbortSignal.timeout(6000) });
    if (!res.ok) return null;
    return (await res.json()) as EnclaveHealth;
  } catch {
    return null;
  }
}
