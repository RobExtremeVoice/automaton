import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../types.js";
import { createStripeRevenueTools } from "../integrations/stripe-revenue.js";

const context = {} as ToolContext;

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
    delete process.env.STRIPE_SUCCESS_URL;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.STRIPE_RESTRICTED_KEY;
    delete process.env.STRIPE_MODE;
    delete process.env.STRIPE_ALLOWED_CURRENCIES;
    delete process.env.STRIPE_MAX_PRICE_CENTS;
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
    const fetchMock = vi.fn().mockResolvedValue(response({
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
    const result = JSON.parse(await tool("stripe_create_payment_link").execute(
      { priceId: "price_123", quantity: 1, metadata: { offer: "pilot" } }, context,
    ));
    expect(result.paymentLinkId).toBe("plink_123");
    expect(fetchMock.mock.calls[0][1].body).toContain("after_completion");
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
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response({
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
