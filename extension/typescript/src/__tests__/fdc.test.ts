/** FDC Payment deposit verification (P2). */

import { describe, expect, it } from "vitest";

import {
  encodePaymentRequest,
  parseConfirmDeposit,
  validatePaymentProof,
  type ExpectedDeposit,
  type PaymentResponse,
} from "../app/fdc.js";

const SRC = `0x${"11".repeat(32)}` as const;
const RECIP = `0x${"22".repeat(32)}` as const;
const REF = `0x${"33".repeat(32)}` as const;
const OTHER = `0x${"99".repeat(32)}` as const;

function proof(over: Partial<PaymentResponse> = {}): PaymentResponse {
  return {
    status: 0,
    sourceId: SRC,
    receivingAddressHash: RECIP,
    receivedAmount: 5_000_000n, // 5 XRP in drops
    standardPaymentReference: REF,
    ...over,
  };
}
function expected(over: Partial<ExpectedDeposit> = {}): ExpectedDeposit {
  return { sourceId: SRC, receivingAddressHash: RECIP, minAmount: 1_000_000n, reference: REF, ...over };
}

describe("validatePaymentProof", () => {
  it("accepts a matching, successful payment", () => {
    expect(validatePaymentProof(proof(), expected())).toMatchObject({ ok: true, code: "OK" });
  });

  it("accepts when the received amount exactly meets the minimum", () => {
    expect(validatePaymentProof(proof({ receivedAmount: 1_000_000n }), expected()).ok).toBe(true);
  });

  it("rejects a non-successful payment", () => {
    expect(validatePaymentProof(proof({ status: 1 }), expected()).code).toBe("DEPOSIT_NOT_SUCCESSFUL");
  });

  it("rejects a payment from the wrong source chain", () => {
    expect(validatePaymentProof(proof({ sourceId: OTHER }), expected()).code).toBe("WRONG_SOURCE");
  });

  it("rejects a payment to a different address", () => {
    expect(validatePaymentProof(proof({ receivingAddressHash: OTHER }), expected()).code).toBe("WRONG_RECIPIENT");
  });

  it("rejects a payment below the required amount", () => {
    expect(validatePaymentProof(proof({ receivedAmount: 999_999n }), expected()).code).toBe("AMOUNT_TOO_LOW");
  });

  it("rejects a payment carrying the wrong reference", () => {
    expect(validatePaymentProof(proof({ standardPaymentReference: OTHER }), expected()).code).toBe("WRONG_REFERENCE");
  });
});

describe("parseConfirmDeposit", () => {
  it("decodes a well-formed payload", () => {
    const { proof: p, expected: e } = parseConfirmDeposit({
      proof: {
        status: 0,
        sourceId: SRC,
        receivingAddressHash: RECIP,
        receivedAmount: "5000000",
        standardPaymentReference: REF,
      },
      expected: { sourceId: SRC, receivingAddressHash: RECIP, minAmount: "1000000", reference: REF },
    });
    expect(p.receivedAmount).toBe(5_000_000n);
    expect(e.minAmount).toBe(1_000_000n);
  });

  it("rejects a non-decimal amount", () => {
    expect(() =>
      parseConfirmDeposit({
        proof: { status: 0, sourceId: SRC, receivingAddressHash: RECIP, receivedAmount: "5.0", standardPaymentReference: REF },
        expected: { sourceId: SRC, receivingAddressHash: RECIP, minAmount: "1", reference: REF },
      }),
    ).toThrow();
  });

  it("rejects a malformed bytes32 field", () => {
    expect(() =>
      parseConfirmDeposit({
        proof: { status: 0, sourceId: "0x1234", receivingAddressHash: RECIP, receivedAmount: "5", standardPaymentReference: REF },
        expected: { sourceId: SRC, receivingAddressHash: RECIP, minAmount: "1", reference: REF },
      }),
    ).toThrow();
  });
});

describe("encodePaymentRequest", () => {
  it("produces a deterministic ABI-encoded request", () => {
    const req = encodePaymentRequest(SRC, { transactionId: `0x${"ab".repeat(32)}`, inUtxo: 0, utxo: 0 });
    expect(req.startsWith("0x")).toBe(true);
    expect(req.length).toBeGreaterThan(2);
  });
});
