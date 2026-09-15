import Database from "better-sqlite3";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { MIGRATION_V12 } from "../state/schema.js";
import {
  calculateGrowthFundAllocation,
  getGrowthFundSummary,
  recordGrowthFundEntry,
  resolveGrowthFundBasisPoints,
} from "../finance/growth-fund.js";

describe("Growth Fund", () => {
  let db: Database.Database | undefined;

  function database(): Database.Database {
    db = new Database(":memory:");
    db.exec(MIGRATION_V12);
    return db;
  }

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("allocates ten percent using integer cents", () => {
    expect(
      calculateGrowthFundAllocation(7_900),
    ).toBe(790);

    expect(
      calculateGrowthFundAllocation(12_900),
    ).toBe(1_290);

    expect(
      calculateGrowthFundAllocation(999),
    ).toBe(99);
  });

  it("uses 1000 basis points by default", () => {
    expect(
      resolveGrowthFundBasisPoints({}),
    ).toBe(1_000);

    expect(
      resolveGrowthFundBasisPoints({
        AUTOMATON_GROWTH_FUND_BASIS_POINTS: "1500",
      }),
    ).toBe(1_500);
  });

  it("deduplicates entries by external key", () => {
    const raw = database();

    const first = recordGrowthFundEntry(raw, {
      externalKey: "stripe-payment:pi_example",
      entryType: "stripe_allocation",
      amountCents: 790,
      stripeEventId: "evt_checkout",
      stripeObjectId: "pi_example",
    });

    const duplicate = recordGrowthFundEntry(raw, {
      externalKey: "stripe-payment:pi_example",
      entryType: "stripe_allocation",
      amountCents: 790,
      stripeEventId: "evt_payment",
      stripeObjectId: "pi_example",
    });

    expect(first.inserted).toBe(true);
    expect(duplicate.inserted).toBe(false);

    expect(
      getGrowthFundSummary(raw),
    ).toEqual({
      balanceCents: 790,
      allocatedCents: 790,
      reversedCents: 0,
      spentCents: 0,
      entryCount: 1,
      currency: "usd",
    });
  });

  it("records reversals and clone spending", () => {
    const raw = database();

    recordGrowthFundEntry(raw, {
      externalKey: "stripe-payment:pi_example",
      entryType: "stripe_allocation",
      amountCents: 1_290,
    });

    recordGrowthFundEntry(raw, {
      externalKey: "stripe-refund:re_example",
      entryType: "refund_reversal",
      amountCents: -290,
    });

    recordGrowthFundEntry(raw, {
      externalKey: "clone-spend:child_example:1",
      entryType: "clone_spend",
      amountCents: -400,
    });

    expect(
      getGrowthFundSummary(raw),
    ).toEqual({
      balanceCents: 600,
      allocatedCents: 1_290,
      reversedCents: 290,
      spentCents: 400,
      entryCount: 3,
      currency: "usd",
    });
  });

  it("rejects invalid and non-USD entries", () => {
    const raw = database();

    expect(() =>
      recordGrowthFundEntry(raw, {
        externalKey: "invalid-zero",
        entryType: "manual_adjustment",
        amountCents: 0,
      })
    ).toThrow("non-zero");

    expect(() =>
      recordGrowthFundEntry(raw, {
        externalKey: "invalid-currency",
        entryType: "manual_adjustment",
        amountCents: 100,
        currency: "eur",
      })
    ).toThrow("USD only");
  });
});
