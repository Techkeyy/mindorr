/** Mindorr handlers — evaluate-then-sign behaviour. */

import { privateKeyToAccount } from "viem/accounts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as handlers from "../app/handlers.js";
import { bytesToHex, hexToBytes } from "../base/encoding.js";
import * as nodeMod from "../base/node.js";
import type { HandlerResult } from "../base/types.js";

// --- fixtures ---------------------------------------------------------------

// Anvil account #0 — a known-valid secp256k1 key. Its address is derived, not
// hardcoded, so the assertions can't drift.
const PK = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80";
const KEY_BYTES = hexToBytes(PK);
const EXPECTED_ADDR = privateKeyToAccount(PK).address.toLowerCase();

const RETURN = "0x2222222222222222222222222222222222222222";
const FXRP = "0x3333333333333333333333333333333333333333";
const VAULT_A = "0xAAAA000000000000000000000000000000000001";
const ATTACKER = "0xdead00000000000000000000000000000000beef";

const VALID_POLICY = {
  owner: "0x1111111111111111111111111111111111111111",
  returnAddress: RETURN,
  riskLevel: "moderate",
  asset: FXRP,
  allowedVenues: [VAULT_A],
  maxVenueBps: 10000,
  maxTxAmount: "1000000000000000000000",
  minHealthFactorBps: 12000,
};

const toMsg = (o: unknown): string => bytesToHex(Buffer.from(JSON.stringify(o), "utf-8"));
const decode = (r: HandlerResult): Record<string, unknown> =>
  JSON.parse(Buffer.from(hexToBytes(r[0] as string)).toString("utf-8"));

/** Load a key (through the mocked node) and set a policy — the ready state. */
async function ready(): Promise<void> {
  await handlers.handleUpdateKey(bytesToHex(KEY_BYTES));
  handlers.handleSetPolicy(toMsg(VALID_POLICY));
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
  it("loads a key in-enclave and reports the derived wallet address", async () => {
    const r = await handlers.handleUpdateKey(bytesToHex(KEY_BYTES));
    expect(r[1]).toBe(1);
    expect(String(decode(r).walletAddress).toLowerCase()).toBe(EXPECTED_ADDR);
    expect((handlers.reportState() as { hasKey: boolean }).hasKey).toBe(true);
  });

  it("fails on an empty payload", async () => {
    const r = await handlers.handleUpdateKey("0x");
    expect(r[1]).toBe(0);
  });
});

// --- SET_POLICY -------------------------------------------------------------

describe("VAULT/SET_POLICY", () => {
  it("accepts a valid policy", () => {
    const r = handlers.handleSetPolicy(toMsg(VALID_POLICY));
    expect(r[1]).toBe(1);
    const s = handlers.reportState() as { hasPolicy: boolean; riskLevel: string };
    expect(s.hasPolicy).toBe(true);
    expect(s.riskLevel).toBe("moderate");
  });

  it("rejects a malformed policy", () => {
    expect(handlers.handleSetPolicy(toMsg({}))[1]).toBe(0);
    expect(handlers.handleSetPolicy(toMsg({ ...VALID_POLICY, riskLevel: "reckless" }))[1]).toBe(0);
  });
});

// --- guarded vault actions --------------------------------------------------

describe("VAULT/ALLOCATE", () => {
  it("signs a deposit into an approved vault", async () => {
    await ready();
    const r = await handlers.handleVaultAction("allocate", toMsg({ asset: FXRP, amount: "1000", venue: VAULT_A }));
    expect(r[1]).toBe(1);
    const out = decode(r);
    expect(String(out.signer).toLowerCase()).toBe(EXPECTED_ADDR);
    expect(String(out.signature)).toMatch(/^0x[0-9a-f]+$/i);
    expect((handlers.reportState() as { actionsSigned: number }).actionsSigned).toBe(1);
  });

  it("BOUNCES a deposit into a non-allowlisted vault — no signature", async () => {
    await ready();
    const r = await handlers.handleVaultAction("allocate", toMsg({ asset: FXRP, amount: "1000", venue: ATTACKER }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("DEST_NOT_ALLOWED");
    expect(r[0]).toBeNull();
    expect((handlers.reportState() as { actionsRefused: number }).actionsRefused).toBe(1);
  });
});

describe("VAULT/WITHDRAW", () => {
  it("signs a withdrawal back to the owner's return address", async () => {
    await ready();
    const r = await handlers.handleVaultAction("withdraw", toMsg({ asset: FXRP, amount: "1000", to: RETURN, userAuthorized: true }));
    expect(r[1]).toBe(1);
  });

  it("BOUNCES a withdrawal to any other address, even when signed", async () => {
    await ready();
    const r = await handlers.handleVaultAction("withdraw", toMsg({ asset: FXRP, amount: "1000", to: ATTACKER, userAuthorized: true }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("WITHDRAW_NON_RETURN");
  });

  it("BOUNCES a withdrawal lacking a fresh owner signature", async () => {
    await ready();
    const r = await handlers.handleVaultAction("withdraw", toMsg({ asset: FXRP, amount: "1000", to: RETURN }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("NEEDS_USER_SIGNATURE");
  });
});

describe("preconditions", () => {
  it("refuses any action before a policy is set", async () => {
    const r = await handlers.handleVaultAction("allocate", toMsg({ asset: FXRP, amount: "1", venue: VAULT_A }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no policy set");
  });

  it("refuses any action before a key is loaded", async () => {
    handlers.handleSetPolicy(toMsg(VALID_POLICY));
    const r = await handlers.handleVaultAction("allocate", toMsg({ asset: FXRP, amount: "1", venue: VAULT_A }));
    expect(r[1]).toBe(0);
    expect(r[2]).toContain("no managed key");
  });
});
