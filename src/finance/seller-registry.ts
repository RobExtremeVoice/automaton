import type BetterSqlite3 from "better-sqlite3";
import { ulid } from "ulid";

type Database = BetterSqlite3.Database;

export type GrowthFundSellerType =
  | "root"
  | "clone";

export type GrowthFundSellerStatus =
  | "pending"
  | "authorized"
  | "revoked";

export type GrowthFundSeller = {
  sellerId: string;
  sellerType: GrowthFundSellerType;
  childId: string | null;
  walletAddress: string | null;
  status: GrowthFundSellerStatus;
  createdAt: string;
  authorizedAt: string | null;
  revokedAt: string | null;
  updatedAt: string;
};

export type RegisterSellerInput = {
  sellerId: string;
  sellerType: GrowthFundSellerType;
  childId?: string;
  walletAddress?: string;
};

type SellerRow = {
  seller_id: string;
  seller_type: GrowthFundSellerType;
  child_id: string | null;
  wallet_address: string | null;
  status: GrowthFundSellerStatus;
  created_at: string;
  authorized_at: string | null;
  revoked_at: string | null;
  updated_at: string;
};

function identifier(
  value: string | undefined,
  name: string,
  prefix?: string,
): string {
  const normalized = value?.trim() ?? "";

  if (
    !normalized ||
    normalized.length > 255 ||
    /[\r\n]/.test(normalized) ||
    (prefix && !normalized.startsWith(prefix))
  ) {
    throw new Error(name + " is invalid");
  }

  return normalized;
}

function optionalIdentifier(
  value: string | undefined,
  name: string,
): string | undefined {
  if (value === undefined) return undefined;
  return identifier(value, name);
}

function deserializeSeller(
  row: SellerRow,
): GrowthFundSeller {
  return {
    sellerId: row.seller_id,
    sellerType: row.seller_type,
    childId: row.child_id,
    walletAddress: row.wallet_address,
    status: row.status,
    createdAt: row.created_at,
    authorizedAt: row.authorized_at,
    revokedAt: row.revoked_at,
    updatedAt: row.updated_at,
  };
}

function getSellerRow(
  db: Database,
  sellerId: string,
): SellerRow | undefined {
  return db.prepare(`
    SELECT *
    FROM growth_fund_sellers
    WHERE seller_id = ?
  `).get(sellerId) as SellerRow | undefined;
}

function recordEvent(
  db: Database,
  input: {
    sellerId: string;
    eventType:
      | "registered"
      | "authorized"
      | "revoked"
      | "payment_link_registered"
      | "payment_link_revoked";
    paymentLinkId?: string;
    metadata?: Record<string, unknown>;
  },
): void {
  const metadata = JSON.stringify(
    input.metadata ?? {},
  );

  if (metadata.length > 10_000) {
    throw new Error(
      "Seller event metadata exceeds size limit",
    );
  }

  db.prepare(`
    INSERT INTO growth_fund_seller_events (
      id,
      seller_id,
      event_type,
      payment_link_id,
      metadata
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    ulid(),
    input.sellerId,
    input.eventType,
    input.paymentLinkId ?? null,
    metadata,
  );
}

export function getGrowthFundSeller(
  db: Database,
  sellerId: string,
): GrowthFundSeller | undefined {
  const normalized = identifier(
    sellerId,
    "sellerId",
  );

  const row = getSellerRow(db, normalized);

  return row
    ? deserializeSeller(row)
    : undefined;
}

export function registerGrowthFundSeller(
  db: Database,
  input: RegisterSellerInput,
): {
  inserted: boolean;
  seller: GrowthFundSeller;
} {
  const sellerId = identifier(
    input.sellerId,
    "sellerId",
  );

  if (
    input.sellerType !== "root" &&
    input.sellerType !== "clone"
  ) {
    throw new Error("sellerType is invalid");
  }

  const childId = optionalIdentifier(
    input.childId,
    "childId",
  );

  const walletAddress = optionalIdentifier(
    input.walletAddress,
    "walletAddress",
  );

  if (
    input.sellerType === "root" &&
    childId !== undefined
  ) {
    throw new Error(
      "Root seller cannot reference a child",
    );
  }

  if (
    input.sellerType === "clone" &&
    childId === undefined
  ) {
    throw new Error(
      "Clone seller requires childId",
    );
  }

  const operation = db.transaction(() => {
    const existing = getSellerRow(db, sellerId);

    if (existing) {
      const sameIdentity =
        existing.seller_type === input.sellerType &&
        existing.child_id === (childId ?? null) &&
        existing.wallet_address ===
          (walletAddress ?? null);

      if (!sameIdentity) {
        throw new Error(
          "Seller identity already exists with different attributes",
        );
      }

      return {
        inserted: false,
        seller: deserializeSeller(existing),
      };
    }

    if (childId) {
      const childExists = Boolean(
        db.prepare(`
          SELECT 1
          FROM children
          WHERE id = ?
        `).get(childId),
      );

      if (!childExists) {
        throw new Error(
          "Clone child does not exist",
        );
      }
    }

    db.prepare(`
      INSERT INTO growth_fund_sellers (
        seller_id,
        seller_type,
        child_id,
        wallet_address,
        status
      ) VALUES (?, ?, ?, ?, 'pending')
    `).run(
      sellerId,
      input.sellerType,
      childId ?? null,
      walletAddress ?? null,
    );

    recordEvent(db, {
      sellerId,
      eventType: "registered",
      metadata: {
        sellerType: input.sellerType,
        childId: childId ?? null,
      },
    });

    return {
      inserted: true,
      seller: deserializeSeller(
        getSellerRow(db, sellerId)!,
      ),
    };
  });

  return operation();
}

export function authorizeGrowthFundSeller(
  db: Database,
  sellerId: string,
): {
  changed: boolean;
  seller: GrowthFundSeller;
} {
  const normalized = identifier(
    sellerId,
    "sellerId",
  );

  const operation = db.transaction(() => {
    const seller = getSellerRow(db, normalized);

    if (!seller) {
      throw new Error("Seller does not exist");
    }

    if (seller.status === "revoked") {
      throw new Error(
        "Revoked seller cannot be reauthorized",
      );
    }

    if (seller.status === "authorized") {
      return {
        changed: false,
        seller: deserializeSeller(seller),
      };
    }

    if (seller.seller_type === "clone") {
      const child = db.prepare(`
        SELECT status
        FROM children
        WHERE id = ?
      `).get(seller.child_id) as
        | { status: string }
        | undefined;

      if (
        !child ||
        !["healthy", "running", "sleeping"]
          .includes(child.status)
      ) {
        throw new Error(
          "Clone must be operational before authorization",
        );
      }
    }

    db.prepare(`
      UPDATE growth_fund_sellers
      SET
        status = 'authorized',
        authorized_at = datetime('now'),
        revoked_at = NULL,
        updated_at = datetime('now')
      WHERE seller_id = ?
        AND status = 'pending'
    `).run(normalized);

    recordEvent(db, {
      sellerId: normalized,
      eventType: "authorized",
    });

    return {
      changed: true,
      seller: deserializeSeller(
        getSellerRow(db, normalized)!,
      ),
    };
  });

  return operation();
}

export function revokeGrowthFundSeller(
  db: Database,
  sellerId: string,
  reason: string,
): {
  changed: boolean;
  seller: GrowthFundSeller;
} {
  const normalized = identifier(
    sellerId,
    "sellerId",
  );

  const normalizedReason = identifier(
    reason,
    "reason",
  );

  const operation = db.transaction(() => {
    const seller = getSellerRow(db, normalized);

    if (!seller) {
      throw new Error("Seller does not exist");
    }

    if (seller.status === "revoked") {
      return {
        changed: false,
        seller: deserializeSeller(seller),
      };
    }

    db.prepare(`
      UPDATE growth_fund_sellers
      SET
        status = 'revoked',
        revoked_at = datetime('now'),
        updated_at = datetime('now')
      WHERE seller_id = ?
    `).run(normalized);

    db.prepare(`
      UPDATE growth_fund_payment_links
      SET
        status = 'revoked',
        revoked_at = datetime('now')
      WHERE seller_id = ?
        AND status = 'active'
    `).run(normalized);

    recordEvent(db, {
      sellerId: normalized,
      eventType: "revoked",
      metadata: {
        reason: normalizedReason,
      },
    });

    return {
      changed: true,
      seller: deserializeSeller(
        getSellerRow(db, normalized)!,
      ),
    };
  });

  return operation();
}

export function registerGrowthFundPaymentLink(
  db: Database,
  input: {
    paymentLinkId: string;
    sellerId: string;
    livemode: boolean;
  },
): {
  inserted: boolean;
} {
  const paymentLinkId = identifier(
    input.paymentLinkId,
    "paymentLinkId",
    "plink_",
  );

  const sellerId = identifier(
    input.sellerId,
    "sellerId",
  );

  const operation = db.transaction(() => {
    const seller = getSellerRow(db, sellerId);

    if (!seller || seller.status !== "authorized") {
      throw new Error(
        "Payment Link seller is not authorized",
      );
    }

    const existing = db.prepare(`
      SELECT
        seller_id AS sellerId,
        livemode
      FROM growth_fund_payment_links
      WHERE payment_link_id = ?
    `).get(paymentLinkId) as
      | {
          sellerId: string;
          livemode: number;
        }
      | undefined;

    if (existing) {
      if (
        existing.sellerId !== sellerId ||
        Boolean(existing.livemode) !==
          input.livemode
      ) {
        throw new Error(
          "Payment Link already belongs to another identity",
        );
      }

      return { inserted: false };
    }

    db.prepare(`
      INSERT INTO growth_fund_payment_links (
        payment_link_id,
        seller_id,
        status,
        livemode
      ) VALUES (?, ?, 'active', ?)
    `).run(
      paymentLinkId,
      sellerId,
      input.livemode ? 1 : 0,
    );

    recordEvent(db, {
      sellerId,
      eventType: "payment_link_registered",
      paymentLinkId,
      metadata: {
        livemode: input.livemode,
      },
    });

    return { inserted: true };
  });

  return operation();
}

export function revokeGrowthFundPaymentLink(
  db: Database,
  paymentLinkId: string,
): {
  changed: boolean;
} {
  const normalized = identifier(
    paymentLinkId,
    "paymentLinkId",
    "plink_",
  );

  const operation = db.transaction(() => {
    const existing = db.prepare(`
      SELECT seller_id AS sellerId, status
      FROM growth_fund_payment_links
      WHERE payment_link_id = ?
    `).get(normalized) as
      | {
          sellerId: string;
          status: "active" | "revoked";
        }
      | undefined;

    if (!existing) {
      throw new Error(
        "Payment Link does not exist",
      );
    }

    if (existing.status === "revoked") {
      return { changed: false };
    }

    db.prepare(`
      UPDATE growth_fund_payment_links
      SET
        status = 'revoked',
        revoked_at = datetime('now')
      WHERE payment_link_id = ?
    `).run(normalized);

    recordEvent(db, {
      sellerId: existing.sellerId,
      eventType: "payment_link_revoked",
      paymentLinkId: normalized,
    });

    return { changed: true };
  });

  return operation();
}

export function isGrowthFundSellerAuthorized(
  db: Database,
  sellerId: string,
): boolean {
  const normalized = identifier(
    sellerId,
    "sellerId",
  );

  return Boolean(
    db.prepare(`
      SELECT 1
      FROM growth_fund_sellers
      WHERE seller_id = ?
        AND status = 'authorized'
    `).get(normalized),
  );
}

export function resolveAuthorizedPaymentLinkSeller(
  db: Database,
  paymentLinkId: string,
  livemode: boolean,
): string | undefined {
  const normalized = identifier(
    paymentLinkId,
    "paymentLinkId",
    "plink_",
  );

  const row = db.prepare(`
    SELECT links.seller_id AS sellerId
    FROM growth_fund_payment_links AS links
    JOIN growth_fund_sellers AS sellers
      ON sellers.seller_id = links.seller_id
    WHERE links.payment_link_id = ?
      AND links.status = 'active'
      AND links.livemode = ?
      AND sellers.status = 'authorized'
  `).get(
    normalized,
    livemode ? 1 : 0,
  ) as { sellerId: string } | undefined;

  return row?.sellerId;
}
