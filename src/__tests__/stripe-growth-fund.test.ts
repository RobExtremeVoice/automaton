import Database from "better-sqlite3";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  MIGRATION_V12,
  MIGRATION_V13,
} from "../state/schema.js";
import {
  getGrowthFundSummary,
} from "../finance/growth-fund.js";
import {
  recordStripeEventInGrowthFund as
    recordStripeEventInGrowthFundRaw,
} from "../finance/stripe-growth-fund.js";
import {
  authorizeGrowthFundSeller,
  registerGrowthFundPaymentLink,
  registerGrowthFundSeller,
  revokeGrowthFundSeller,
} from "../finance/seller-registry.js";
import type {
  StripeWebhookEvent,
} from "../integrations/stripe-webhook.js";

describe("Stripe Growth Fund accounting", () => {
  let db: Database.Database | undefined;

  const authorizedEnvironment = {
    AUTOMATON_GROWTH_FUND_BASIS_POINTS: "1000",
    AUTOMATON_GROWTH_FUND_SELLER_ID: "thor",
    AUTOMATON_GROWTH_FUND_AUTHORIZED_SELLER_IDS:
      "thor",
    AUTOMATON_GROWTH_FUND_PAYMENT_LINK_IDS:
      "plink_thor",
  };

  function recordStripeEventInGrowthFund(
    raw: Database.Database,
    stripeEvent: StripeWebhookEvent,
    environment: NodeJS.ProcessEnv =
      authorizedEnvironment,
  ) {
    return recordStripeEventInGrowthFundRaw(
      raw,
      stripeEvent,
      environment,
    );
  }

  function database(): Database.Database {
    db = new Database(":memory:");
    db.exec(MIGRATION_V12);
    db.exec(`
      CREATE TABLE children (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL
      );
    `);
    db.exec(MIGRATION_V13);
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
          payment_link: "plink_thor",
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
          metadata: {
            automaton_growth_fund: "eligible",
            automaton_seller_id: "thor",
          },
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
          metadata: {
            automaton_growth_fund: "eligible",
            automaton_seller_id: "thor",
          },
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
          payment_intent: "pi_refund",
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
          payment_intent: "pi_refund",
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
          payment_intent: "pi_refund",
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

    recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_dispute_payment",
        "payment_intent.succeeded",
        {
          id: "pi_dispute",
          amount_received: 7_900,
          currency: "usd",
          metadata: {
            automaton_growth_fund: "eligible",
            automaton_seller_id: "thor",
          },
        },
      ),
    );

    const result = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_dispute",
        "charge.dispute.created",
        {
          id: "dp_example",
          payment_intent: "pi_dispute",
          amount: 7_900,
          currency: "usd",
        },
      ),
    );

    expect(result.outcome).toBe("recorded");
    expect(result.amountCents).toBe(-790);
    expect(
      getGrowthFundSummary(raw).balanceCents,
    ).toBe(0);
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
            metadata: {
              automaton_growth_fund: "eligible",
              automaton_seller_id: "thor",
            },
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
          metadata: {
            automaton_growth_fund: "eligible",
            automaton_seller_id: "thor",
          },
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
  it("rejects wrong mode, forged metadata and revoked sellers", () => {
    const raw = database();

    registerGrowthFundSeller(raw, {
      sellerId: "security-seller",
      sellerType: "root",
      walletAddress:
        "0x2222222222222222222222222222222222222222",
    });

    authorizeGrowthFundSeller(
      raw,
      "security-seller",
    );

    registerGrowthFundPaymentLink(raw, {
      paymentLinkId: "plink_security",
      sellerId: "security-seller",
      livemode: true,
    });

    const environment = {
      AUTOMATON_GROWTH_FUND_BASIS_POINTS:
        "1000",
    };

    const wrongMode =
      recordStripeEventInGrowthFund(
        raw,
        {
          id: "evt_wrong_mode",
          type: "checkout.session.completed",
          livemode: false,
          data: {
            object: {
              id: "cs_wrong_mode",
              payment_intent: "pi_wrong_mode",
              payment_link: "plink_security",
              payment_status: "paid",
              amount_total: 7_900,
              currency: "usd",
            },
          },
        },
        environment,
      );

    const forgedMetadata =
      recordStripeEventInGrowthFund(
        raw,
        event(
          "evt_forged_metadata",
          "payment_intent.succeeded",
          {
            id: "pi_forged",
            amount_received: 7_900,
            currency: "usd",
            metadata: {
              automaton_growth_fund:
                "eligible",
              automaton_seller_id:
                "unknown-seller",
            },
          },
        ),
        environment,
      );

    revokeGrowthFundSeller(
      raw,
      "security-seller",
      "security test",
    );

    const revokedLink =
      recordStripeEventInGrowthFund(
        raw,
        event(
          "evt_revoked_link",
          "checkout.session.completed",
          {
            id: "cs_revoked",
            payment_intent: "pi_revoked",
            payment_link: "plink_security",
            payment_status: "paid",
            amount_total: 7_900,
            currency: "usd",
          },
        ),
        environment,
      );

    const revokedMetadata =
      recordStripeEventInGrowthFund(
        raw,
        event(
          "evt_revoked_metadata",
          "payment_intent.succeeded",
          {
            id: "pi_revoked_metadata",
            amount_received: 7_900,
            currency: "usd",
            metadata: {
              automaton_growth_fund:
                "eligible",
              automaton_seller_id:
                "security-seller",
            },
          },
        ),
        environment,
      );

    expect(wrongMode.reason).toBe(
      "unauthorized_sale",
    );
    expect(forgedMetadata.reason).toBe(
      "unauthorized_sale",
    );
    expect(revokedLink.reason).toBe(
      "unauthorized_sale",
    );
    expect(revokedMetadata.reason).toBe(
      "unauthorized_sale",
    );
    expect(
      getGrowthFundSummary(raw).entryCount,
    ).toBe(0);
  });

  it("uses the persistent seller registry before environment fallback", () => {
    const raw = database();

    registerGrowthFundSeller(raw, {
      sellerId: "thor-registry",
      sellerType: "root",
      walletAddress:
        "0x1111111111111111111111111111111111111111",
    });

    authorizeGrowthFundSeller(
      raw,
      "thor-registry",
    );

    registerGrowthFundPaymentLink(raw, {
      paymentLinkId: "plink_registry",
      sellerId: "thor-registry",
      livemode: true,
    });

    const result = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_registry_checkout",
        "checkout.session.completed",
        {
          id: "cs_registry",
          payment_intent: "pi_registry",
          payment_link: "plink_registry",
          payment_status: "paid",
          amount_total: 7_900,
          currency: "usd",
        },
      ),
      {
        AUTOMATON_GROWTH_FUND_BASIS_POINTS:
          "1000",
      },
    );

    expect(result.outcome).toBe("recorded");
    expect(result.amountCents).toBe(790);
    expect(
      getGrowthFundSummary(raw).balanceCents,
    ).toBe(790);
  });

  it("rejects sales without Thor or clone attribution", () => {
    const raw = database();

    const checkout = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_external_checkout",
        "checkout.session.completed",
        {
          id: "cs_external",
          payment_intent: "pi_external",
          payment_link: "plink_external",
          payment_status: "paid",
          amount_total: 20_000,
          currency: "usd",
        },
      ),
    );

    const payment = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_external_payment",
        "payment_intent.succeeded",
        {
          id: "pi_external",
          amount_received: 20_000,
          currency: "usd",
          metadata: {},
        },
      ),
    );

    expect(checkout.outcome).toBe("skipped");
    expect(checkout.reason).toBe("unauthorized_sale");
    expect(payment.outcome).toBe("skipped");
    expect(payment.reason).toBe("unauthorized_sale");
    expect(
      getGrowthFundSummary(raw).entryCount,
    ).toBe(0);
  });

  it("ignores reversals for external payments", () => {
    const raw = database();

    const refund = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_external_refund",
        "charge.refunded",
        {
          id: "ch_external",
          payment_intent: "pi_external",
          amount_refunded: 20_000,
          currency: "usd",
        },
      ),
    );

    const dispute = recordStripeEventInGrowthFund(
      raw,
      event(
        "evt_external_dispute",
        "charge.dispute.created",
        {
          id: "dp_external",
          payment_intent: "pi_external",
          amount: 20_000,
          currency: "usd",
        },
      ),
    );

    expect(refund.outcome).toBe("skipped");
    expect(refund.reason).toBe(
      "original_payment_not_allocated",
    );
    expect(dispute.outcome).toBe("skipped");
    expect(dispute.reason).toBe(
      "original_payment_not_allocated",
    );
    expect(
      getGrowthFundSummary(raw).entryCount,
    ).toBe(0);
  });

});
