import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";
import {
  createDatabase,
} from "../state/database.js";
import {
  authorizeGrowthFundSeller,
  getGrowthFundSeller,
  isGrowthFundSellerAuthorized,
  registerGrowthFundPaymentLink,
  registerGrowthFundSeller,
  resolveAuthorizedPaymentLinkSeller,
  revokeGrowthFundPaymentLink,
  revokeGrowthFundSeller,
} from "../finance/seller-registry.js";

describe("Growth Fund seller registry", () => {
  let directory: string | undefined;
  let database:
    | ReturnType<typeof createDatabase>
    | undefined;

  function openDatabase() {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "seller-registry-"),
    );

    database = createDatabase(
      path.join(directory, "state.db"),
    );

    return database;
  }

  function insertChild(
    status:
      | "dead"
      | "running"
      | "sleeping"
      | "healthy",
    id = "child-1",
  ): void {
    const db = database!;

    db.raw.prepare(`
      INSERT INTO children (
        id,
        name,
        address,
        sandbox_id,
        genesis_prompt,
        funded_amount_cents,
        status,
        created_at,
        chain_type
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      "Independent Clone",
      "0x2222222222222222222222222222222222222222",
      "do-sandbox-1",
      "Operate independently",
      0,
      status,
      new Date().toISOString(),
      "evm",
    );
  }

  function registerAndAuthorizeRoot(): void {
    const db = database!;

    registerGrowthFundSeller(db.raw, {
      sellerId: "thor",
      sellerType: "root",
      walletAddress:
        "0x1111111111111111111111111111111111111111",
    });

    authorizeGrowthFundSeller(
      db.raw,
      "thor",
    );
  }

  afterEach(() => {
    database?.close();
    database = undefined;

    if (directory) {
      fs.rmSync(directory, {
        recursive: true,
        force: true,
      });
    }

    directory = undefined;
  });

  it("registers and authorizes the root seller", () => {
    const db = openDatabase();

    const registered =
      registerGrowthFundSeller(db.raw, {
        sellerId: "thor",
        sellerType: "root",
        walletAddress:
          "0x1111111111111111111111111111111111111111",
      });

    expect(registered.inserted).toBe(true);
    expect(registered.seller.status).toBe(
      "pending",
    );

    const authorized =
      authorizeGrowthFundSeller(
        db.raw,
        "thor",
      );

    expect(authorized.changed).toBe(true);
    expect(authorized.seller.status).toBe(
      "authorized",
    );
    expect(
      isGrowthFundSellerAuthorized(
        db.raw,
        "thor",
      ),
    ).toBe(true);

    expect(
      authorizeGrowthFundSeller(
        db.raw,
        "thor",
      ).changed,
    ).toBe(false);
  });

  it("requires a real operational child before clone authorization", () => {
    const db = openDatabase();

    expect(() =>
      registerGrowthFundSeller(db.raw, {
        sellerId: "clone-missing",
        sellerType: "clone",
        childId: "missing-child",
      }),
    ).toThrow("does not exist");

    insertChild("dead");

    const registered =
      registerGrowthFundSeller(db.raw, {
        sellerId: "clone-1",
        sellerType: "clone",
        childId: "child-1",
        walletAddress:
          "0x2222222222222222222222222222222222222222",
      });

    expect(registered.seller.status).toBe(
      "pending",
    );

    expect(() =>
      authorizeGrowthFundSeller(
        db.raw,
        "clone-1",
      ),
    ).toThrow("must be operational");

    db.raw.prepare(`
      UPDATE children
      SET status = 'healthy'
      WHERE id = ?
    `).run("child-1");

    expect(
      authorizeGrowthFundSeller(
        db.raw,
        "clone-1",
      ).seller.status,
    ).toBe("authorized");
  });

  it("registers and resolves an authorized Payment Link", () => {
    const db = openDatabase();

    registerAndAuthorizeRoot();

    const first =
      registerGrowthFundPaymentLink(
        db.raw,
        {
          paymentLinkId: "plink_thor_1",
          sellerId: "thor",
          livemode: true,
        },
      );

    const repeated =
      registerGrowthFundPaymentLink(
        db.raw,
        {
          paymentLinkId: "plink_thor_1",
          sellerId: "thor",
          livemode: true,
        },
      );

    expect(first.inserted).toBe(true);
    expect(repeated.inserted).toBe(false);

    expect(
      resolveAuthorizedPaymentLinkSeller(
        db.raw,
        "plink_thor_1",
        true,
      ),
    ).toBe("thor");

    expect(
      resolveAuthorizedPaymentLinkSeller(
        db.raw,
        "plink_thor_1",
        false,
      ),
    ).toBeUndefined();

    expect(
      revokeGrowthFundPaymentLink(
        db.raw,
        "plink_thor_1",
      ).changed,
    ).toBe(true);

    expect(
      resolveAuthorizedPaymentLinkSeller(
        db.raw,
        "plink_thor_1",
        true,
      ),
    ).toBeUndefined();
  });

  it("revokes a seller and all active links permanently", () => {
    const db = openDatabase();

    registerAndAuthorizeRoot();

    registerGrowthFundPaymentLink(
      db.raw,
      {
        paymentLinkId: "plink_thor_2",
        sellerId: "thor",
        livemode: true,
      },
    );

    const revoked =
      revokeGrowthFundSeller(
        db.raw,
        "thor",
        "Security review",
      );

    expect(revoked.changed).toBe(true);
    expect(revoked.seller.status).toBe(
      "revoked",
    );
    expect(
      isGrowthFundSellerAuthorized(
        db.raw,
        "thor",
      ),
    ).toBe(false);

    expect(
      resolveAuthorizedPaymentLinkSeller(
        db.raw,
        "plink_thor_2",
        true,
      ),
    ).toBeUndefined();

    expect(() =>
      authorizeGrowthFundSeller(
        db.raw,
        "thor",
      ),
    ).toThrow("cannot be reauthorized");

    expect(
      revokeGrowthFundSeller(
        db.raw,
        "thor",
        "Repeated revocation",
      ).changed,
    ).toBe(false);
  });

  it("preserves identity uniqueness and audit history", () => {
    const db = openDatabase();

    registerAndAuthorizeRoot();

    const repeated =
      registerGrowthFundSeller(
        db.raw,
        {
          sellerId: "thor",
          sellerType: "root",
          walletAddress:
            "0x1111111111111111111111111111111111111111",
        },
      );

    expect(repeated.inserted).toBe(false);

    expect(() =>
      registerGrowthFundSeller(
        db.raw,
        {
          sellerId: "thor",
          sellerType: "root",
          walletAddress:
            "0x9999999999999999999999999999999999999999",
        },
      ),
    ).toThrow("different attributes");

    expect(() =>
      registerGrowthFundSeller(
        db.raw,
        {
          sellerId: "other-root",
          sellerType: "root",
          walletAddress:
            "0x1111111111111111111111111111111111111111",
        },
      ),
    ).toThrow();

    registerGrowthFundPaymentLink(
      db.raw,
      {
        paymentLinkId: "plink_audit",
        sellerId: "thor",
        livemode: true,
      },
    );

    revokeGrowthFundPaymentLink(
      db.raw,
      "plink_audit",
    );

    const events = db.raw.prepare(`
      SELECT event_type
      FROM growth_fund_seller_events
      WHERE seller_id = ?
      ORDER BY created_at, id
    `).pluck().all("thor");

    expect(events).toEqual([
      "registered",
      "authorized",
      "payment_link_registered",
      "payment_link_revoked",
    ]);

    expect(
      getGrowthFundSeller(
        db.raw,
        "thor",
      )?.walletAddress,
    ).toBe(
      "0x1111111111111111111111111111111111111111",
    );
  });
});
