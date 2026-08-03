import { describe, expect, it } from "vitest";

import {
  eqAddr,
  evaluateIntent,
  isAllowedVenue,
  type Intent,
  type Policy,
} from "../app/policy.js";

// --- fixtures ---------------------------------------------------------------

const OWNER = "0x1111111111111111111111111111111111111111";
const RETURN = "0x2222222222222222222222222222222222222222";
const FXRP = "0x3333333333333333333333333333333333333333";
const VAULT_A = "0xAAAA000000000000000000000000000000000001";
const VAULT_B = "0xAAAA000000000000000000000000000000000002";
const ATTACKER = "0xdead00000000000000000000000000000000beef";
const OTHER_ASSET = "0x9999999999999999999999999999999999999999";

function policy(overrides: Partial<Policy> = {}): Policy {
  return {
    owner: OWNER,
    returnAddress: RETURN,
    riskLevel: "moderate",
    asset: FXRP,
    allowedVenues: [VAULT_A, VAULT_B],
    maxVenueBps: 6000, // 60% max in one venue
    maxTxAmount: 1_000_000n,
    minHealthFactorBps: 12_000, // 1.2
    ...overrides,
  };
}

function allocate(overrides: Partial<Intent> = {}): Intent {
  return { kind: "allocate", asset: FXRP, amount: 100n, venue: VAULT_A, ...overrides };
}

// --- helpers ----------------------------------------------------------------

describe("address helpers", () => {
  it("compares addresses case-insensitively", () => {
    expect(eqAddr(VAULT_A, VAULT_A.toUpperCase())).toBe(true);
    expect(eqAddr(VAULT_A, VAULT_B)).toBe(false);
    expect(eqAddr(undefined, VAULT_A)).toBe(false);
  });

  it("checks the venue allowlist", () => {
    const p = policy();
    expect(isAllowedVenue(p, VAULT_B)).toBe(true);
    expect(isAllowedVenue(p, ATTACKER)).toBe(false);
    expect(isAllowedVenue(p, undefined)).toBe(false);
  });
});

// --- universal invariants ---------------------------------------------------

describe("universal invariants", () => {
  it("rejects zero / negative amounts", () => {
    expect(evaluateIntent(policy(), allocate({ amount: 0n })).code).toBe("ZERO_AMOUNT");
    expect(evaluateIntent(policy(), allocate({ amount: -5n })).code).toBe("ZERO_AMOUNT");
  });

  it("rejects an asset that is not the managed asset", () => {
    const d = evaluateIntent(policy(), allocate({ asset: OTHER_ASSET }));
    expect(d.allow).toBe(false);
    expect(d.code).toBe("ASSET_NOT_ALLOWED");
  });

  it("rejects amounts over the per-tx cap", () => {
    const d = evaluateIntent(policy(), allocate({ amount: 2_000_000n }));
    expect(d.code).toBe("AMOUNT_EXCEEDS_CAP");
  });
});

// --- allocate / rebalance ---------------------------------------------------

describe("allocate", () => {
  it("allows a deposit into an approved vault, autonomously (no signature needed)", () => {
    const d = evaluateIntent(policy(), allocate());
    expect(d.allow).toBe(true);
    expect(d.code).toBe("OK");
  });

  it("BLOCKS a deposit into a vault that is not on the allowlist (malicious instruction bounces)", () => {
    const d = evaluateIntent(policy(), allocate({ venue: ATTACKER }));
    expect(d.allow).toBe(false);
    expect(d.code).toBe("DEST_NOT_ALLOWED");
  });

  it("enforces the venue concentration cap", () => {
    // 60% of a 1000 portfolio = 600. Already 550 in the vault, +100 => 650 > 600.
    const d = evaluateIntent(
      policy(),
      allocate({ amount: 100n, portfolioValue: 1000n, venueBalance: 550n }),
    );
    expect(d.code).toBe("VENUE_CONCENTRATION");
  });

  it("permits allocation that stays within the concentration cap", () => {
    const d = evaluateIntent(
      policy(),
      allocate({ amount: 40n, portfolioValue: 1000n, venueBalance: 550n }),
    );
    expect(d.allow).toBe(true);
  });
});

describe("rebalance", () => {
  it("blocks a rebalance that would push health below the floor", () => {
    const d = evaluateIntent(
      policy(),
      { kind: "rebalance", asset: FXRP, amount: 100n, venue: VAULT_A, projectedHealthFactorBps: 11_000 },
    );
    expect(d.code).toBe("HEALTH_FACTOR");
  });

  it("allows a rebalance that keeps health at or above the floor", () => {
    const d = evaluateIntent(
      policy(),
      { kind: "rebalance", asset: FXRP, amount: 100n, venue: VAULT_A, projectedHealthFactorBps: 12_500 },
    );
    expect(d.allow).toBe(true);
  });
});

// --- withdraw: the exit door ------------------------------------------------

describe("withdraw", () => {
  it("allows a signed withdrawal back to the owner's return address", () => {
    const d = evaluateIntent(
      policy(),
      { kind: "withdraw", asset: FXRP, amount: 500n, to: RETURN, userAuthorized: true },
    );
    expect(d.allow).toBe(true);
  });

  it("BLOCKS a withdrawal to any address other than the return address, even if signed", () => {
    const d = evaluateIntent(
      policy(),
      { kind: "withdraw", asset: FXRP, amount: 500n, to: ATTACKER, userAuthorized: true },
    );
    expect(d.allow).toBe(false);
    expect(d.code).toBe("WITHDRAW_NON_RETURN");
  });

  it("BLOCKS a withdrawal that lacks a fresh owner signature", () => {
    const d = evaluateIntent(
      policy(),
      { kind: "withdraw", asset: FXRP, amount: 500n, to: RETURN, userAuthorized: false },
    );
    expect(d.code).toBe("NEEDS_USER_SIGNATURE");
  });
});
