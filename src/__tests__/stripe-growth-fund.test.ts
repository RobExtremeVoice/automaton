import Database from "better-sqlite3";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import { MIGRATION_V12 } from "../state/schema.js";
import {
  getGrowthFundSummary,
} from "../finance/growth-fund.js";
import {
  recordStripeEventInGrowthFund,
} from "../finance/stripe-growth-fund.js";
import type {
  StripeWebhookEvent,
} from "../integrations/stripe-webhook.js";

describe("Stripe Growth Fund accounting", () => {
  let db: Database.Database | undefined;

  function database(): Database.Database {
    db = new Database(":memory:");
    db.exec(MIGRATION_V12);
    return db;
  }

  function event(
    id: string,
    type: string,
    object: Record<string, unknown>,
  ): StripeWebhookEvent {
    return {
      id,
      type,
      livemode: true,
      data: { object },
    };
  }

  afterEach(() => {
    db?.close();
    db = undefined;
  });

  it("deduplicates checkout and payment intent", () => {
    const raw = database();

    const checkout = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_checkout",
        "checkout.session.completed",
        {
          id: "cs_example",
          payment_intent: "pi_example",
          payment_status: "paid",
          amount_total: 7_900,
          currency: "usd",
        },
      ),
    );

    const payment = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_payment",
        "payment_intent.succeeded",
        {
          id: "pi_example",
          amount_received: 7_900,
          currency: "usd",
        },
      ),
    );

    expect(checkout.outcome).toBe("recorded");
    expect(payment.outcome).toBe("duplicate");
    expect(
      getGrowthFundSummary(raw).balanceCents,
    ).toBe(790);
    expect(
      getGrowthFundSummary(raw).entryCount,
    ).toBe(1);
  });

  it("reverses only incremental refunds", () => {
    const raw = database();

    recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_payment",
        "payment_intent.succeeded",
        {
          id: "pi_refund",
          amount_received: 12_900,
          currency: "usd",
        },
      ),
    );

    const first = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_refund_1",
        "charge.refunded",
        {
          id: "ch_example",
          amount_refunded: 2_900,
          currency: "usd",
        },
      ),
    );

    const second = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_refund_2",
        "charge.refunded",
        {
          id: "ch_example",
          amount_refunded: 3_900,
          currency: "usd",
        },
      ),
    );

    const repeated = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_refund_3",
        "charge.refunded",
        {
          id: "ch_example",
          amount_refunded: 3_900,
          currency: "usd",
        },
      ),
    );

    expect(first.amountCents).toBe(-290);
    expect(second.amountCents).toBe(-100);
    expect(repeated.outcome).toBe("duplicate");
    expect(
      getGrowthFundSummary(raw).balanceCents,
    ).toBe(900);
  });

  it("reserves ten percent for disputes", () => {
    const raw = database();

    const result = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_dispute",
        "charge.dispute.created",
        {
          id: "dp_example",
          amount: 7_900,
          currency: "usd",
        },
      ),
    );

    expect(result.outcome).toBe("recorded");
    expect(result.amountCents).toBe(-790);
    expect(
      getGrowthFundSummary(raw).balanceCents,
    ).toBe(-790);
  });

  it("skips unpaid, foreign and failed events", () => {
    const raw = database();

    expect(
      recordStripeEventInGrowthFund(
        raw,
        event(
          "evt_unpaid",
          "checkout.session.completed",
          {
            payment_intent: "pi_unpaid",
            payment_status: "unpaid",
            amount_total: 7_900,
            currency: "usd",
          },
        ),
      ).reason,
    ).toBe("checkout_not_paid");

    expect(
      recordStripeEventInGrowthFund(
        raw,
        event(
          "evt_eur",
          "payment_intent.succeeded",
          {
            id: "pi_eur",
            amount_received: 7_900,
            currency: "eur",
          },
        ),
      ).reason,
    ).toBe("unsupported_currency");

    expect(
      recordStripeEventInGrowthFund(
        raw,
        event(
          "evt_failed",
          "payment_intent.payment_failed",
          {
            id: "pi_failed",
            currency: "usd",
          },
        ),
      ).reason,
    ).toBe("event_not_financial");

    expect(
      getGrowthFundSummary(raw).entryCount,
    ).toBe(0);
  });

  it("can be disabled with zero basis points", () => {
    const raw = database();

    const result = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_disabled",
        "payment_intent.succeeded",
        {
          id: "pi_disabled",
          amount_received: 7_900,
          currency: "usd",
        },
      ),
      {
        AUTOMATON_GROWTH_FUND_BASIS_POINTS: "0",
      },
    );

    expect(result.reason).toBe(
      "growth_fund_disabled",
    );
    expect(
      getGrowthFundSummary(raw).entryCount,
    ).toBe(0);
  });
});
