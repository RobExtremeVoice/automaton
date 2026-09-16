import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type { ToolContext } from "../types.js";
import {
  createDatabase,
} from "../state/database.js";
import {
  authorizeGrowthFundSeller,
  registerGrowthFundSeller,
  resolveAuthorizedPaymentLinkSeller,
} from "../finance/seller-registry.js";
import { createStripeRevenueTools } from "../integrations/stripe-revenue.js";

const context = {} as ToolContext;

let registryDatabase:
  | ReturnType<typeof createDatabase>
  | undefined;
let registryDirectory: string | undefined;

function registeredContext(
  authorize = true,
): ToolContext {
  registryDirectory = fs.mkdtempSync(
    path.join(
      os.tmpdir(),
      "stripe-revenue-registry-",
    ),
  );

  registryDatabase = createDatabase(
    path.join(
      registryDirectory,
      "state.db",
    ),
  );

  registerGrowthFundSeller(
    registryDatabase.raw,
    {
      sellerId: "thor",
      sellerType: "root",
      walletAddress:
        "0x3333333333333333333333333333333333333333",
    },
  );

  if (authorize) {
    authorizeGrowthFundSeller(
      registryDatabase.raw,
      "thor",
    );
  }

  return {
    db: registryDatabase,
  } as ToolContext;
}

function response(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function tool(name: string) {
  const found = createStripeRevenueTools().find((item) => item.name === name);
  if (!found) throw new Error("Missing tool: " + name);
  return found;
}

describe("Stripe revenue tools", () => {
  beforeEach(() => {
    process.env.STRIPE_RESTRICTED_KEY = "rk_test_" + "a".repeat(32);
    process.env.STRIPE_MODE = "test";
    process.env.STRIPE_ALLOWED_CURRENCIES = "usd,eur";
    process.env.STRIPE_MAX_PRICE_CENTS = "100000";
    process.env.AUTOMATON_GROWTH_FUND_SELLER_ID =
      "thor";
    process.env
      .AUTOMATON_GROWTH_FUND_AUTHORIZED_SELLER_IDS =
      "thor";
    delete process.env.STRIPE_SUCCESS_URL;
  });

  afterEach(() => {
    registryDatabase?.close();
    registryDatabase = undefined;

    if (registryDirectory) {
      fs.rmSync(
        registryDirectory,
        {
          recursive: true,
          force: true,
        },
      );
    }

    registryDirectory = undefined;
    vi.unstubAllGlobals();
    delete process.env.STRIPE_RESTRICTED_KEY;
    delete process.env.STRIPE_MODE;
    delete process.env.STRIPE_ALLOWED_CURRENCIES;
    delete process.env.STRIPE_MAX_PRICE_CENTS;
    delete process.env
      .AUTOMATON_GROWTH_FUND_SELLER_ID;
    delete process.env
      .AUTOMATON_GROWTH_FUND_AUTHORIZED_SELLER_IDS;
    delete process.env.STRIPE_SUCCESS_URL;
  });

  it("requires a restricted key", async () => {
    delete process.env.STRIPE_RESTRICTED_KEY;
    await expect(tool("stripe_create_product").execute(
      { name: "Offer", description: "Verified offer" },
      context,
    )).rejects.toThrow("STRIPE_RESTRICTED_KEY");
  });

  it("blocks test/live key mismatch", async () => {
    process.env.STRIPE_RESTRICTED_KEY = "rk_live_" + "a".repeat(32);
    await expect(tool("stripe_create_product").execute(
      { name: "Offer", description: "Verified offer" },
      context,
    )).rejects.toThrow("blocked");
  });

  it("enforces integer amount and maximum price", async () => {
    await expect(tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 10.5, kind: "one_time" },
      context,
    )).rejects.toThrow("integer");
    await expect(tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 100001, kind: "one_time" },
      context,
    )).rejects.toThrow("STRIPE_MAX_PRICE_CENTS");
  });

  it("enforces allowed currencies", async () => {
    await expect(tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 5000, currency: "brl", kind: "one_time" },
      context,
    )).rejects.toThrow("not allowed");
  });

  it("validates recurring interval", async () => {
    await expect(tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 5000, kind: "recurring" },
      context,
    )).rejects.toThrow("interval is required");
    await expect(tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 5000, kind: "one_time", interval: "month" },
      context,
    )).rejects.toThrow("only valid");
  });

  it("rejects sensitive metadata", async () => {
    await expect(tool("stripe_create_product").execute(
      { name: "Offer", description: "Verified", metadata: { apiKey: "secret" } },
      context,
    )).rejects.toThrow("sensitive");
  });

  it("creates a product with deterministic idempotency", async () => {
    const fetchMock = vi.fn().mockImplementation(async () => response({
      id: "prod_123", name: "Offer", active: true, livemode: false,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const args = { name: "Offer", description: "Verified", metadata: { source: "thor" } };
    const first = JSON.parse(await tool("stripe_create_product").execute(args, context));
    await tool("stripe_create_product").execute(args, context);
    expect(first.productId).toBe("prod_123");
    const firstHeaders = fetchMock.mock.calls[0][1].headers;
    const secondHeaders = fetchMock.mock.calls[1][1].headers;
    expect(firstHeaders["Idempotency-Key"]).toBe(secondHeaders["Idempotency-Key"]);
    expect(firstHeaders["Idempotency-Key"]).toMatch(/^thor-product-/);
  });

  it("creates one-time and recurring prices", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(response({ id: "price_one", product: "prod_123", unit_amount: 5000, currency: "usd" }))
      .mockResolvedValueOnce(response({ id: "price_month", product: "prod_123", unit_amount: 2900, currency: "usd", recurring: { interval: "month" } }));
    vi.stubGlobal("fetch", fetchMock);
    const one = JSON.parse(await tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 5000, kind: "one_time" }, context,
    ));
    const recurring = JSON.parse(await tool("stripe_create_price").execute(
      { productId: "prod_123", amountCents: 2900, kind: "recurring", interval: "month" }, context,
    ));
    expect(one.priceId).toBe("price_one");
    expect(recurring.recurring.interval).toBe("month");
    expect(fetchMock.mock.calls[1][1].body).toContain("recurring%5Binterval%5D=month");
  });

  it("creates a Payment Link with configured HTTPS redirect", async () => {
    process.env.STRIPE_SUCCESS_URL = "https://example.com/thank-you";
    const fetchMock = vi.fn().mockResolvedValue(response({
      id: "plink_123", url: "https://buy.stripe.com/test", active: true,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const registryContext =
      registeredContext();

    const result = JSON.parse(await tool("stripe_create_payment_link").execute(
      { priceId: "price_123", quantity: 1, metadata: { offer: "pilot" } },
      registryContext,
    ));

    expect(result.paymentLinkId).toBe("plink_123");
    expect(result.registrySynced).toBe(true);
    expect(
      resolveAuthorizedPaymentLinkSeller(
        registryDatabase!.raw,
        "plink_123",
        false,
      ),
    ).toBe("thor");

    const requestBody = new URLSearchParams(
      fetchMock.mock.calls[0][1].body,
    );

    expect(requestBody.get(
      "metadata[automaton_growth_fund]",
    )).toBe("eligible");

    expect(requestBody.get(
      "metadata[automaton_seller_id]",
    )).toBe("thor");

    expect(requestBody.get(
      "payment_intent_data[metadata]" +
        "[automaton_growth_fund]",
    )).toBe("eligible");

    expect(requestBody.get(
      "payment_intent_data[metadata]" +
        "[automaton_seller_id]",
    )).toBe("thor");

    expect(
      fetchMock.mock.calls[0][1].body,
    ).toContain("after_completion");
  });

  it("registers repeated Payment Link responses idempotently", async () => {
    const registryContext =
      registeredContext();

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        response({
          id: "plink_repeat",
          url: "https://buy.stripe.com/test-repeat",
          active: true,
          livemode: false,
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const args = {
      priceId: "price_repeat",
      quantity: 1,
    };

    const first = JSON.parse(
      await tool(
        "stripe_create_payment_link",
      ).execute(
        args,
        registryContext,
      ),
    );

    const second = JSON.parse(
      await tool(
        "stripe_create_payment_link",
      ).execute(
        args,
        registryContext,
      ),
    );

    const linkCount = Number(
      registryDatabase!.raw.prepare(`
        SELECT COUNT(*)
        FROM growth_fund_payment_links
        WHERE payment_link_id = ?
      `).pluck().get("plink_repeat"),
    );

    const registrationEvents = Number(
      registryDatabase!.raw.prepare(`
        SELECT COUNT(*)
        FROM growth_fund_seller_events
        WHERE event_type =
          'payment_link_registered'
          AND payment_link_id = ?
      `).pluck().get("plink_repeat"),
    );

    expect(first.registrySynced).toBe(true);
    expect(second.registrySynced).toBe(true);
    expect(linkCount).toBe(1);
    expect(registrationEvents).toBe(1);
  });

  it("rejects link registration for a pending seller", async () => {
    const pendingContext =
      registeredContext(false);

    const fetchMock = vi.fn().mockResolvedValue(
      response({
        id: "plink_pending",
        url: "https://buy.stripe.com/test-pending",
        active: true,
        livemode: false,
      }),
    );

    vi.stubGlobal(
      "fetch",
      fetchMock,
    );

    await expect(
      tool(
        "stripe_create_payment_link",
      ).execute(
        {
          priceId: "price_pending",
        },
        pendingContext,
      ),
    ).rejects.toThrow(
      "Payment Link seller is not authorized",
    );

    const linkCount = Number(
      registryDatabase!.raw.prepare(`
        SELECT COUNT(*)
        FROM growth_fund_payment_links
        WHERE payment_link_id = ?
      `).pluck().get("plink_pending"),
    );

    expect(linkCount).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks agent-controlled attribution metadata", async () => {
    await expect(
      tool("stripe_create_payment_link").execute(
        {
          priceId: "price_123",
          metadata: {
            automaton_seller_id: "external",
          },
        },
        context,
      ),
    ).rejects.toThrow("reserved");
  });

  it("blocks an unauthorized runtime seller", async () => {
    process.env.AUTOMATON_GROWTH_FUND_SELLER_ID =
      "unapproved-clone";

    await expect(
      tool("stripe_create_payment_link").execute(
        {
          priceId: "price_123",
        },
        context,
      ),
    ).rejects.toThrow(
      "not authorized for Growth Fund",
    );
  });

  it("retrieves sanitized Checkout Session status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      id: "cs_test_123",
      status: "complete",
      payment_status: "paid",
      amount_total: 5000,
      currency: "usd",
      payment_intent: "pi_123",
      metadata: { opportunityId: "opp_1", apiKey: "blocked" },
      livemode: false,
    })));
    const result = JSON.parse(await tool("stripe_get_payment_status").execute(
      { sessionId: "cs_test_123" }, context,
    ));
    expect(result.paymentStatus).toBe("paid");
    expect(result.metadata.opportunityId).toBe("opp_1");
    expect(result.metadata.apiKey).toBeUndefined();
  });

  it("lists recent payments and filters status", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
      data: [
        { id: "pi_1", amount: 5000, amount_received: 5000, currency: "usd", status: "succeeded" },
        { id: "pi_2", amount: 6000, amount_received: 0, currency: "usd", status: "processing" },
      ],
      has_more: false,
    })));
    const result = JSON.parse(await tool("stripe_list_recent_payments").execute(
      { limit: 10, status: "succeeded" }, context,
    ));
    expect(result.payments).toHaveLength(1);
    expect(result.payments[0].paymentIntentId).toBe("pi_1");
  });

  it("deactivates a Payment Link", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response({ id: "plink_123", active: false }));
    vi.stubGlobal("fetch", fetchMock);
    const result = JSON.parse(await tool("stripe_deactivate_payment_link").execute(
      { paymentLinkId: "plink_123" }, context,
    ));
    expect(result.active).toBe(false);
    expect(fetchMock.mock.calls[0][1].body).toBe("active=false");
  });

  it("sanitizes Stripe errors without leaking the key", async () => {
    const secret = process.env.STRIPE_RESTRICTED_KEY!;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => response({
      error: { message: "Rejected credential " + secret },
    }, 401)));
    await expect(tool("stripe_create_product").execute(
      { name: "Offer", description: "Verified" }, context,
    )).rejects.not.toThrow(secret);
    await expect(tool("stripe_create_product").execute(
      { name: "Offer", description: "Verified" }, context,
    )).rejects.toThrow("[redacted]");
  });

  it("exposes exactly the Phase 1 tool surface", () => {
    expect(createStripeRevenueTools().map((item) => item.name)).toEqual([
      "stripe_create_product",
      "stripe_create_price",
      "stripe_create_payment_link",
      "stripe_get_payment_status",
      "stripe_list_recent_payments",
      "stripe_deactivate_payment_link",
    ]);
  });
});
