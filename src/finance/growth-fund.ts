import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

export type GrowthFundEntryType =
  | "stripe_allocation"
  | "refund_reversal"
  | "dispute_reserve"
  | "dispute_release"
  | "clone_spend"
  | "manual_adjustment";

export type GrowthFundEntry = {
  externalKey: string;
  entryType: GrowthFundEntryType;
  amountCents: number;
  currency?: string;
  stripeEventId?: string;
  stripeObjectId?: string;
  metadata?: Record<string, unknown>;
};

export type GrowthFundSummary = {
  balanceCents: number;
  allocatedCents: number;
  reversedCents: number;
  spentCents: number;
  entryCount: number;
  currency: "usd";
};

export function resolveGrowthFundBasisPoints(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured =
    environment.AUTOMATON_GROWTH_FUND_BASIS_POINTS;

  if (configured === undefined) {
    return 1_000;
  }

  const parsed = Number(configured);

  if (!Number.isFinite(parsed)) {
    return 1_000;
  }

  return Math.max(
    0,
    Math.min(5_000, Math.trunc(parsed)),
  );
}

export function calculateGrowthFundAllocation(
  grossAmountCents: number,
  basisPoints = 1_000,
): number {
  if (
    !Number.isSafeInteger(grossAmountCents) ||
    grossAmountCents < 0
  ) {
    throw new Error(
      "grossAmountCents must be a non-negative safe integer",
    );
  }

  if (
    !Number.isSafeInteger(basisPoints) ||
    basisPoints < 0 ||
    basisPoints > 10_000
  ) {
    throw new Error(
      "basisPoints must be an integer between 0 and 10000",
    );
  }

  return Math.floor(
    grossAmountCents * basisPoints / 10_000,
  );
}

function requiredIdentifier(
  value: string | undefined,
  name: string,
): string {
  const normalized = value?.trim() ?? "";

  if (
    !normalized ||
    normalized.length > 255 ||
    /[\r\n]/.test(normalized)
  ) {
    throw new Error(name + " is invalid");
  }

  return normalized;
}

export function recordGrowthFundEntry(
  db: Database,
  entry: GrowthFundEntry,
): {
  inserted: boolean;
  id: string | null;
} {
  const externalKey = requiredIdentifier(
    entry.externalKey,
    "externalKey",
  );

  if (
    !Number.isSafeInteger(entry.amountCents) ||
    entry.amountCents === 0
  ) {
    throw new Error(
      "amountCents must be a non-zero safe integer",
    );
  }

  const currency =
    (entry.currency ?? "usd").trim().toLowerCase();

  if (currency !== "usd") {
    throw new Error(
      "Growth Fund currently supports USD only",
    );
  }

  const metadata = JSON.stringify(
    entry.metadata ?? {},
  );

  if (metadata.length > 10_000) {
    throw new Error(
      "Growth Fund metadata exceeds size limit",
    );
  }

  const id = ulid();

  const result = db.prepare(`
    INSERT INTO growth_fund_ledger (
      id,
      external_key,
      entry_type,
      amount_cents,
      currency,
      stripe_event_id,
      stripe_object_id,
      metadata
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(external_key) DO NOTHING
  `).run(
    id,
    externalKey,
    entry.entryType,
    entry.amountCents,
    currency,
    entry.stripeEventId ?? null,
    entry.stripeObjectId ?? null,
    metadata,
  );

  return {
    inserted: result.changes === 1,
    id: result.changes === 1 ? id : null,
  };
}

export function getGrowthFundSummary(
  db: Database,
): GrowthFundSummary {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(amount_cents), 0) AS balanceCents,
      COALESCE(SUM(
        CASE
          WHEN entry_type = 'stripe_allocation'
            THEN amount_cents
          ELSE 0
        END
      ), 0) AS allocatedCents,
      COALESCE(SUM(
        CASE
          WHEN entry_type IN (
            'refund_reversal',
            'dispute_reserve'
          )
            THEN ABS(amount_cents)
          ELSE 0
        END
      ), 0) AS reversedCents,
      COALESCE(SUM(
        CASE
          WHEN entry_type = 'clone_spend'
            THEN ABS(amount_cents)
          ELSE 0
        END
      ), 0) AS spentCents,
      COUNT(*) AS entryCount
    FROM growth_fund_ledger
    WHERE currency = 'usd'
  `).get() as {
    balanceCents: number;
    allocatedCents: number;
    reversedCents: number;
    spentCents: number;
    entryCount: number;
  };

  return {
    ...row,
    currency: "usd",
  };
}
