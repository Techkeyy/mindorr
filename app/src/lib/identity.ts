/**
 * Per-user identity for the browser. Each visitor gets their own address, so the
 * enclave derives a wallet unique to them and the app is genuinely multi-user,
 * never one shared hardcoded identity.
 *
 * Default path: a session key generated in-browser and kept in localStorage. It
 * is a real address the user holds for the session, used as their owner /
 * return address, so "withdrawals only ever go back to your address" is real and
 * personal. For moving real FXRP, a user connects a funded Coston2 wallet
 * instead (the funds path); this session identity is enough for the full
 * confidential demo (wallet creation, policy, guarded signing, refusals).
 */

import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const STORAGE_KEY = "mindorr:identity:v1";

export interface Identity {
  address: string;
}

/** Get (or lazily create) this browser's identity address. Client-only. */
export function getIdentity(): Identity {
  if (typeof window === "undefined") {
    throw new Error("getIdentity is client-only");
  }
  let pk = window.localStorage.getItem(STORAGE_KEY);
  if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
    pk = generatePrivateKey();
    window.localStorage.setItem(STORAGE_KEY, pk);
  }
  return { address: privateKeyToAccount(pk as `0x${string}`).address };
}

/** Start fresh, a new identity, as if a new user. */
export function resetIdentity(): Identity {
  if (typeof window === "undefined") {
    throw new Error("resetIdentity is client-only");
  }
  const pk = generatePrivateKey();
  window.localStorage.setItem(STORAGE_KEY, pk);
  return { address: privateKeyToAccount(pk as `0x${string}`).address };
}
