import type BetterSqlite3 from "better-sqlite3";
import type {
  StripeWebhookEvent,
} from "../integrations/stripe-webhook.js";
import {
  calculateGrowthFundAllocation,
  recordGrowthFundEntry,
  resolveGrowthFundBasisPoints,
} from "./growth-fund.js";

type Database = BetterSqlite3.Database;

export type StripeGrowthFundResult = {
  outcome: "recorded" | "duplicate" | "skipped";
  reason?: string;
  entryType?: string;
  amountCents?: number;
  externalKey?: string;
};

function safeAmount(
  value: unknown,
): number | undefined {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0
  )
    ? value
    : undefined;
}

function text(
  value: unknown,
): string | undefined {
  return typeof value === "string" && value.trim()
    ? value.trim()
    : undefined;
}

function currency(
  object: Record<string, unknown>,
): string | undefined {
  return text(object.currency)?.toLowerCase();
}

function configuredIds(
  value: string | undefined,
  prefix?: string,
): Set<string> {
  return new Set(
    (value ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter(
        (item) =>
          item.length > 0 &&
          (!prefix || item.startsWith(prefix)),
      ),
  );
}

function objectMetadata(
  object: Record<string, unknown>,
): Record<string, string> {
  const value = object.metadata;

  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return {};
  }

  const result: Record<string, string> = {};

  for (
    const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )
  ) {
    if (typeof item === "string") {
      result[key] = item.trim();
    }
  }

  return result;
}

type SaleAttribution = {
  sellerId: string;
  paymentLinkId?: string;
  method: "payment_link_allowlist" | "metadata";
};

function resolveSaleAttribution(
  event: StripeWebhookEvent,
  object: Record<string, unknown>,
  environment: NodeJS.ProcessEnv,
): SaleAttribution | undefined {
  const authorizedLinks = configuredIds(
    environment
      .AUTOMATON_GROWTH_FUND_PAYMENT_LINK_IDS,
    "plink_",
  );

  const authorizedSellers = configuredIds(
    environment
      .AUTOMATON_GROWTH_FUND_AUTHORIZED_SELLER_IDS,
  );

  const localSellerId = text(
    environment.AUTOMATON_GROWTH_FUND_SELLER_ID,
  );

  const paymentLinkId = text(object.payment_link);

  if (
    event.type === "checkout.session.completed" &&
    paymentLinkId &&
    authorizedLinks.has(paymentLinkId) &&
    localSellerId &&
    authorizedSellers.has(localSellerId)
  ) {
    return {
      sellerId: localSellerId,
      paymentLinkId,
      method: "payment_link_allowlist",
    };
  }

  const metadata = objectMetadata(object);
  const metadataSellerId =
    text(metadata.automaton_seller_id);

  if (
    metadata.automaton_growth_fund === "eligible" &&
    metadataSellerId &&
    authorizedSellers.has(metadataSellerId)
  ) {
    return {
      sellerId: metadataSellerId,
      paymentLinkId,
      method: "metadata",
    };
  }

  return undefined;
}

function allocationResult(
  db: Database,
  event: StripeWebhookEvent,
  object: Record<string, unknown>,
  basisPoints: number,
  environment: NodeJS.ProcessEnv,
): StripeGrowthFundResult {
  if (
    event.type === "checkout.session.completed" &&
    object.payment_status !== "paid"
  ) {
    return {
      outcome: "skipped",
      reason: "checkout_not_paid",
    };
  }

  const attribution = resolveSaleAttribution(
    event,
    object,
    environment,
  );

  if (!attribution) {
    return {
      outcome: "skipped",
      reason: "unauthorized_sale",
    };
  }

  const paymentIntentId =
    event.type === "payment_intent.succeeded"
      ? text(object.id)
      : text(object.payment_intent);

  if (!paymentIntentId) {
    return {
      outcome: "skipped",
      reason: "missing_payment_intent",
    };
  }

  if (currency(object) !== "usd") {
    return {
      outcome: "skipped",
      reason: "unsupported_currency",
    };
  }

  const grossAmount =
    event.type === "payment_intent.succeeded"
      ? safeAmount(object.amount_received)
      : safeAmount(object.amount_total);

  if (grossAmount === undefined) {
    return {
      outcome: "skipped",
      reason: "invalid_payment_amount",
    };
  }

  const amountCents =
    calculateGrowthFundAllocation(
      grossAmount,
      basisPoints,
    );

  if (amountCents === 0) {
    return {
      outcome: "skipped",
      reason: "allocation_below_one_cent",
    };
  }

  const externalKey =
    "stripe-payment:" + paymentIntentId;

  const recorded = recordGrowthFundEntry(db, {
    externalKey,
    entryType: "stripe_allocation",
    amountCents,
    stripeEventId: event.id,
    stripeObjectId: paymentIntentId,
    metadata: {
      sourceEventType: event.type,
      grossAmountCents: grossAmount,
      basisPoints,
      sellerId: attribution.sellerId,
      attributionMethod: attribution.method,
      paymentLinkId:
        attribution.paymentLinkId ?? null,
    },
  });

  return {
    outcome: recorded.inserted
      ? "recorded"
      : "duplicate",
    entryType: "stripe_allocation",
    amountCents,
    externalKey,
  };
}

function refundResult(
  db: Database,
  event: StripeWebhookEvent,
  object: Record<string, unknown>,
  basisPoints: number,
): StripeGrowthFundResult {
  const chargeId = text(object.id);
  const paymentIntentId =
    text(object.payment_intent);
  const refundedGross =
    safeAmount(object.amount_refunded);

  if (
    !chargeId ||
    !paymentIntentId ||
    refundedGross === undefined
  ) {
    return {
      outcome: "skipped",
      reason: "invalid_refund",
    };
  }

  if (currency(object) !== "usd") {
    return {
      outcome: "skipped",
      reason: "unsupported_currency",
    };
  }

  const originalAllocation = db.prepare(`
    SELECT 1
    FROM growth_fund_ledger
    WHERE entry_type = 'stripe_allocation'
      AND stripe_object_id = ?
    LIMIT 1
  `).get(paymentIntentId);

  if (!originalAllocation) {
    return {
      outcome: "skipped",
      reason: "original_payment_not_allocated",
    };
  }

  const targetReversal =
    calculateGrowthFundAllocation(
      refundedGross,
      basisPoints,
    );

  const alreadyReversed = Number(
    db.prepare(`
      SELECT COALESCE(SUM(ABS(amount_cents)), 0)
      FROM growth_fund_ledger
      WHERE entry_type = 'refund_reversal'
        AND stripe_object_id = ?
    `).pluck().get(chargeId) ?? 0,
  );

  const amountCents =
    targetReversal - alreadyReversed;

  if (amountCents <= 0) {
    return {
      outcome: "duplicate",
      reason: "refund_already_accounted",
    };
  }

  const externalKey =
    "stripe-refund:" +
    chargeId +
    ":" +
    refundedGross;

  const recorded = recordGrowthFundEntry(db, {
    externalKey,
    entryType: "refund_reversal",
    amountCents: -amountCents,
    stripeEventId: event.id,
    stripeObjectId: chargeId,
    metadata: {
      refundedGrossCents: refundedGross,
      cumulativeReversalCents: targetReversal,
      paymentIntentId,
      basisPoints,
    },
  });

  return {
    outcome: recorded.inserted
      ? "recorded"
      : "duplicate",
    entryType: "refund_reversal",
    amountCents: -amountCents,
    externalKey,
  };
}

function disputeResult(
  db: Database,
  event: StripeWebhookEvent,
  object: Record<string, unknown>,
  basisPoints: number,
): StripeGrowthFundResult {
  const disputeId = text(object.id);
  const paymentIntentId =
    text(object.payment_intent);
  const disputedGross = safeAmount(object.amount);

  if (
    !disputeId ||
    !paymentIntentId ||
    disputedGross === undefined
  ) {
    return {
      outcome: "skipped",
      reason: "invalid_dispute",
    };
  }

  if (currency(object) !== "usd") {
    return {
      outcome: "skipped",
      reason: "unsupported_currency",
    };
  }

  const originalAllocation = db.prepare(`
    SELECT 1
    FROM growth_fund_ledger
    WHERE entry_type = 'stripe_allocation'
      AND stripe_object_id = ?
    LIMIT 1
  `).get(paymentIntentId);

  if (!originalAllocation) {
    return {
      outcome: "skipped",
      reason: "original_payment_not_allocated",
    };
  }

  const reservedCents =
    calculateGrowthFundAllocation(
      disputedGross,
      basisPoints,
    );

  if (reservedCents === 0) {
    return {
      outcome: "skipped",
      reason: "reserve_below_one_cent",
    };
  }

  const externalKey =
    "stripe-dispute:" + disputeId;

  const recorded = recordGrowthFundEntry(db, {
    externalKey,
    entryType: "dispute_reserve",
    amountCents: -reservedCents,
    stripeEventId: event.id,
    stripeObjectId: disputeId,
    metadata: {
      disputedGrossCents: disputedGross,
      paymentIntentId,
      basisPoints,
    },
  });

  return {
    outcome: recorded.inserted
      ? "recorded"
      : "duplicate",
    entryType: "dispute_reserve",
    amountCents: -reservedCents,
    externalKey,
  };
}

export function recordStripeEventInGrowthFund(
  db: Database,
  event: StripeWebhookEvent,
  environment: NodeJS.ProcessEnv = process.env,
): StripeGrowthFundResult {
  const basisPoints =
    resolveGrowthFundBasisPoints(environment);

  if (basisPoints === 0) {
    return {
      outcome: "skipped",
      reason: "growth_fund_disabled",
    };
  }

  const operation = db.transaction(() => {
    const object = event.data.object;

    if (
      event.type === "checkout.session.completed" ||
      event.type === "payment_intent.succeeded"
    ) {
      return allocationResult(
        db,
        event,
        object,
        basisPoints,
        environment,
      );
    }

    if (event.type === "charge.refunded") {
      return refundResult(
        db,
        event,
        object,
        basisPoints,
      );
    }

    if (event.type === "charge.dispute.created") {
      return disputeResult(
        db,
        event,
        object,
        basisPoints,
      );
    }

    return {
      outcome: "skipped",
      reason: "event_not_financial",
    } satisfies StripeGrowthFundResult;
  });

  return operation();
}
