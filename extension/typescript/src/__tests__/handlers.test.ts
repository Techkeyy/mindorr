/** Mindorr handlers — per-user evaluate-then-sign behaviour. */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as handlers from "../app/handlers.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";
import * as nodeMod from "../base/node.js";
import type { HandlerResult } from "../base/types.js";

// --- fixtures ---------------------------------------------------------------

// A 32-byte master seed. The enclave derives each user's key from it; addresses
// are read back from CREATE, not hardcoded, so assertions can't drift.
const SEED = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const SEED_BYTES = hexToBytes(SEED);

const OWNER = "0x1111111111111111111111111111111111111111";
const OWNER_2 = "0x4444444444444444444444444444444444444444";
const RETURN = "0x2222222222222222222222222222222222222222";
const FXRP = "0x3333333333333333333333333333333333333333";
const VAULT_A = "0xAAAA000000000000000000000000000000000001";
const ATTACKER = "0xdead00000000000000000000000000000000beef";

const policyFor = (owner: string) => ({
  owner,
  returnAddress: RETURN,
  riskLevel: "moderate",
  asset: FXRP,
  allowedVenues: [VAULT_A],
  maxVenueBps: 10000,
  maxTxAmount: "1000000000000000000000",
  minHealthFactorBps: 12000,
});

const VALID_POLICY = policyFor(OWNER);

const toMsg = (o: unknown): string => bytesToHex(Buffer.from(JSON.stringify(o), "utf-8"));
const decode = (r: HandlerResult): Record<string, unknown> =>
  JSON.parse(Buffer.from(hexToBytes(r[0] as string)).toString("utf-8"));

/** Deliver the seed, create the user's wallet, set their policy. Returns wallet addr. */
async function ready(owner: string = OWNER): Promise<string> {
  await handlers.handleUpdateKey(bytesToHex(SEED_BYTES));
  const c = handlers.handleCreateWallet(toMsg({ user: owner }));
  handlers.handleSetPolicy(toMsg(policyFor(owner)));
  return String(decode(c).walletAddress).toLowerCase();
}

beforeEach(() => {
  handlers.resetState();
  // Decrypt happens inside the enclave in production; here identity stands in.
  vi.spyOn(nodeMod.NodeClient.prototype, "decrypt").mockImplementation(
    async (ct: Uint8Array) => ct,
  );
});
afterEach(() => vi.restoreAllMocks());

// --- UPDATE_KEY -------------------------------------------------------------

describe("WALLET/UPDATE_KEY", () => {
  it("loads the master seed in-enclave", async () => {
    const r = await handlers.handleUpdateKey(bytesToHex(SEED_BYTES));
    expect(r[1]).toBe(1);
    expect((handlers.reportState() as { hasSeed: boolean }).hasSeed).toBe(true);
  });

  it("fails on an empty payload", async () => {
    const r = await handlers.handleUpdateKey("0x");
    expect(r[1]).toBe(0);
  });
});

// --- CREATE -----------------------------------------------------------------

describe("WALLET/CREATE", () => {
  it("derives a wallet address for a user", async () => {
    await handlers.handleUpdateKey(bytesToHex(SEED_BYTES));
    const r = handlers.handleCreateWallet(toMsg({ user: OWNER }));
    expect(r[1]).toBe(1);
    expect(String(decode(r).walletAddress)).toMatch(/^0x[0-9a-fA-F]{40}$/);
  });

  it("is deterministic for the same user", async () => {
    await handlers.handleUpdateKey(bytesToHex(SEED_BYTES));
    const a = decode(handlers.handleCreateWallet(toMsg({ user: OWNER }))).walletAddress;
    const b = decode(handlers.handleCreateWallet(toMsg({ user: OWNER }))).walletAddress;
    expect(a).toBe(b);
  });

  it("gives different users different wallets", async () => {
    await handlers.handleUpdateKey(bytesToHex(SEED_BYTES));
    const a = decode(handlers.handleCreateWallet(toMsg({ user: OWNER }))).walletAddress;
    const b = decode(handlers.handleCreateWallet(toMsg({ user: OWNER_2 }))).walletAddress;
    expect(a).not.toBe(b);
  });

  it("refuses before the seed is loaded", () => {
    const r = handlers.handleCreateWallet(toMsg({ user: OWNER }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no master seed");
  });
});

// --- SET_POLICY -------------------------------------------------------------

describe("VAULT/SET_POLICY", () => {
  it("accepts a valid policy", () => {
    const r = handlers.handleSetPolicy(toMsg(VALID_POLICY));
    expect(r[1]).toBe(1);
    expect((handlers.reportState() as { users: number }).users).toBe(1);
  });

  it("rejects a malformed policy", () => {
    expect(handlers.handleSetPolicy(toMsg({}))[1]).toBe(0);
    expect(handlers.handleSetPolicy(toMsg({ ...VALID_POLICY, riskLevel: "reckless" }))[1]).toBe(0);
  });
});

// --- confirm deposit (FDC, P2) ----------------------------------------------

describe("VAULT/CONFIRM_DEPOSIT", () => {
  const SRC = `0x${"11".repeat(32)}`;
  const RECIP = `0x${"22".repeat(32)}`;
  const REF = `0x${"33".repeat(32)}`;
  const goodDeposit = {
    user: OWNER,
    proof: { status: 0, sourceId: SRC, receivingAddressHash: RECIP, receivedAmount: "5000000", standardPaymentReference: REF },
    expected: { sourceId: SRC, receivingAddressHash: RECIP, minAmount: "1000000", reference: REF },
  };

  it("credits FXRP when the FDC proof checks out", () => {
    handlers.handleSetPolicy(toMsg(VALID_POLICY));
    const r = handlers.handleConfirmDeposit(toMsg(goodDeposit));
    expect(r[1]).toBe(1);
    const s = handlers.reportState() as { depositsConfirmed: number };
    expect(String(decode(r).totalConfirmedFxrp)).toBe("5000000");
    expect(s.depositsConfirmed).toBe(1);
  });

  it("rejects a proof whose payment went to a different address", () => {
    handlers.handleSetPolicy(toMsg(VALID_POLICY));
    const bad = { ...goodDeposit, proof: { ...goodDeposit.proof, receivingAddressHash: `0x${"99".repeat(32)}` } };
    const r = handlers.handleConfirmDeposit(toMsg(bad));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("WRONG_RECIPIENT");
  });

  it("refuses before a policy is set", () => {
    const r = handlers.handleConfirmDeposit(toMsg(goodDeposit));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no policy set");
  });
});

// --- guarded vault actions --------------------------------------------------

describe("VAULT/ALLOCATE", () => {
  it("signs a deposit into an approved vault with the user's derived key", async () => {
    const walletAddr = await ready();
    const r = await handlers.handleVaultAction("allocate", toMsg({ user: OWNER, asset: FXRP, amount: "1000", venue: VAULT_A }));
    expect(r[1]).toBe(1);
    const out = decode(r);
    expect(String(out.signer).toLowerCase()).toBe(walletAddr);
    expect(String(out.signature)).toMatch(/^0x[0-9a-f]+$/i);
    expect((handlers.reportState() as { actionsSigned: number }).actionsSigned).toBe(1);
  });

  it("BOUNCES a deposit into a non-allowlisted vault — no signature", async () => {
    await ready();
    const r = await handlers.handleVaultAction("allocate", toMsg({ user: OWNER, asset: FXRP, amount: "1000", venue: ATTACKER }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("DEST_NOT_ALLOWED");
    expect(r[0]).toBeNull();
    expect((handlers.reportState() as { actionsRefused: number }).actionsRefused).toBe(1);
  });

  it("keeps users isolated — one user's policy can't authorize another's action", async () => {
    await ready(OWNER); // OWNER onboarded, OWNER_2 is not
    handlers.handleCreateWallet(toMsg({ user: OWNER_2 }));
    const r = await handlers.handleVaultAction("allocate", toMsg({ user: OWNER_2, asset: FXRP, amount: "1000", venue: VAULT_A }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no policy set");
  });
});

describe("VAULT/WITHDRAW", () => {
  it("signs a withdrawal back to the owner's return address", async () => {
    await ready();
    const r = await handlers.handleVaultAction("withdraw", toMsg({ user: OWNER, asset: FXRP, amount: "1000", to: RETURN, userAuthorized: true }));
    expect(r[1]).toBe(1);
  });

  it("BOUNCES a withdrawal to any other address, even when signed", async () => {
    await ready();
    const r = await handlers.handleVaultAction("withdraw", toMsg({ user: OWNER, asset: FXRP, amount: "1000", to: ATTACKER, userAuthorized: true }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("WITHDRAW_NON_RETURN");
  });

  it("BOUNCES a withdrawal lacking a fresh owner signature", async () => {
    await ready();
    const r = await handlers.handleVaultAction("withdraw", toMsg({ user: OWNER, asset: FXRP, amount: "1000", to: RETURN }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("NEEDS_USER_SIGNATURE");
  });
});

describe("preconditions", () => {
  it("refuses any action before a policy is set", async () => {
    await handlers.handleUpdateKey(bytesToHex(SEED_BYTES));
    const r = await handlers.handleVaultAction("allocate", toMsg({ user: OWNER, asset: FXRP, amount: "1", venue: VAULT_A }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no policy set");
  });

  it("refuses any action before the seed is loaded", async () => {
    handlers.handleSetPolicy(toMsg(VALID_POLICY));
    const r = await handlers.handleVaultAction("allocate", toMsg({ user: OWNER, asset: FXRP, amount: "1", venue: VAULT_A }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no managed key");
  });

  it("requires a user field on vault actions", async () => {
    await ready();
    const r = await handlers.handleVaultAction("allocate", toMsg({ asset: FXRP, amount: "1000", venue: VAULT_A }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain('"user"');
  });
});
