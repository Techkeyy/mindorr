/**
 * Live connection to the Mindorr enclave proxy running on the VPS.
 * Reads /state to pull the real enclave state (key loaded, policy set,
 * actions signed/refused, confirmed deposits).
 */

const ENCLAVE_PROXY = process.env.ENCLAVE_PROXY_URL ?? "http://103.195.188.198:6674";

export interface EnclaveState {
  hasKey: boolean;
  walletAddress: string | null;
  hasPolicy: boolean;
  riskLevel: string | null;
  allowedVenues: string[];
  confirmedFxrp: string;
  depositsConfirmed: number;
  actionsSigned: number;
  actionsRefused: number;
}

export interface EnclaveInfo {
  extensionId: string;
  teeId: string;
  version: string;
}

export async function getEnclaveState(): Promise<EnclaveState | null> {
  try {
    const res = await fetch(`${ENCLAVE_PROXY}/state`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.state ?? data ?? null;
  } catch {
    return null;
  }
}

export async function getEnclaveInfo(): Promise<EnclaveInfo | null> {
  try {
    const res = await fetch(`${ENCLAVE_PROXY}/info`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function isEnclaveReachable(): Promise<boolean> {
  return getEnclaveInfo().then((i) => i !== null);
}
