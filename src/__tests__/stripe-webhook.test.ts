import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import type { Server } from "http";
import { isStoredStripeEvent, startStripeWebhookServer, verifyStripeSignature } from "../integrations/stripe-webhook.js";

const secret = "whsec_test_secret";
const body = Buffer.from(JSON.stringify({
  id: "evt_test_1",
  type: "payment_intent.succeeded",
  created: 1_789_000_000,
  livemode: false,
  data: { object: { id: "pi_test", amount_received: 100, currency: "usd" } },
}));

function signature(payload: Buffer, timestamp: number): string {
  const digest = createHmac("sha256", secret)
    .update(String(timestamp) + ".")
    .update(payload)
    .digest("hex");
  return "t=" + timestamp + ",v1=" + digest;
}

describe("Stripe webhook", () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) =>
      new Promise<void>((resolve) => server.close(() => resolve()))
    ));
  });

  it("treats undefined and null KV results as unseen events", () => {
    expect(isStoredStripeEvent(undefined)).toBe(false);
    expect(isStoredStripeEvent(null)).toBe(false);
    expect(isStoredStripeEvent("")).toBe(true);
    expect(isStoredStripeEvent("1789237320")).toBe(true);
  });

  it("validates signatures and rejects stale timestamps", () => {
    expect(verifyStripeSignature(body, signature(body, 1000), secret, 300, 1000)).toBe(true);
    expect(verifyStripeSignature(body, signature(body, 1000), secret, 300, 1400)).toBe(false);
    expect(verifyStripeSignature(Buffer.from("tampered"), signature(body, 1000), secret, 300, 1000)).toBe(false);
  });

  it("accepts a signed event and deduplicates retries", async () => {
    const handled = vi.fn();
    const processed = new Set<string>();
    const server = startStripeWebhookServer({
      secret,
      host: "127.0.0.1",
      port: 0,
      expectedMode: "test",
      isProcessed: (id) => processed.has(id),
      markProcessed: (event) => processed.add(event.id),
      onEvent: handled,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const url = "http://127.0.0.1:" + address.port + "/webhooks/stripe";
    const timestamp = Math.floor(Date.now() / 1000);
    const headers = { "Stripe-Signature": signature(body, timestamp) };
    const first = await fetch(url, { method: "POST", headers, body });
    const second = await fetch(url, { method: "POST", headers, body });
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ received: true, duplicate: true });
    expect(handled).toHaveBeenCalledTimes(1);
  });

  it("rejects unsigned requests", async () => {
    const server = startStripeWebhookServer({
      secret, host: "127.0.0.1", port: 0,
      isProcessed: () => false,
      markProcessed: () => undefined,
      onEvent: () => undefined,
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const response = await fetch("http://127.0.0.1:" + address.port + "/webhooks/stripe", {
      method: "POST", body,
    });
    expect(response.status).toBe(400);
  });
  it("serves the dashboard with protected API access", async () => {
    const dashboardToken =
      "dashboard-test-token-" + "x".repeat(32);
    const secretValue =
      "secret-that-must-not-be-returned";

    const server = startStripeWebhookServer({
      secret,
      host: "127.0.0.1",
      port: 0,
      isProcessed: () => false,
      markProcessed: () => undefined,
      onEvent: () => undefined,
      dashboard: {
        token: dashboardToken,
        getOverview: () => ({
          agent: {
            state: "running",
          },
          safeValue: "visible",
        }),
      },
    });

    servers.push(server);

    await new Promise<void>((resolve) =>
      server.once("listening", resolve)
    );

    const address = server.address();

    if (
      !address ||
      typeof address === "string"
    ) {
      throw new Error("missing address");
    }

    const baseUrl =
      "http://127.0.0.1:" + address.port;

    const offerPage = await fetch(
      baseUrl +
        "/offers/gmb-review-reply-pack",
    );

    expect(offerPage.status).toBe(200);
    expect(
      offerPage.headers.get("content-type"),
    ).toContain("text/html");

    const offerHtml = await offerPage.text();

    expect(offerHtml).toContain(
      "Google Review Reply Pack",
    );
    expect(offerHtml).toContain(
      "fZu28rbwx4d59dkflcaIM1s",
    );
    expect(offerHtml).toContain(
      "bJe4gzgQRbFxaho0qiaIM1t",
    );
    expect(offerHtml).not.toContain(
      dashboardToken,
    );
    expect(offerHtml).not.toContain(
      "support@example.com",
    );

    const page = await fetch(
      baseUrl + "/dashboard",
    );

    expect(page.status).toBe(200);
    expect(
      page.headers.get("content-type"),
    ).toContain("text/html");

    const html = await page.text();

    expect(html).toContain("Thor Operations");
    expect(html).not.toContain(dashboardToken);
    expect(html).not.toContain(secretValue);

    const unauthorized = await fetch(
      baseUrl + "/api/dashboard/overview",
    );

    expect(unauthorized.status).toBe(401);
    expect(await unauthorized.json()).toEqual({
      error: "unauthorized",
    });

    const wrongToken = await fetch(
      baseUrl + "/api/dashboard/overview",
      {
        headers: {
          Authorization: "Bearer wrong-token",
        },
      },
    );

    expect(wrongToken.status).toBe(401);

    const authorized = await fetch(
      baseUrl + "/api/dashboard/overview",
      {
        headers: {
          Authorization:
            "Bearer " + dashboardToken,
        },
      },
    );

    expect(authorized.status).toBe(200);
    expect(await authorized.json()).toEqual({
      agent: {
        state: "running",
      },
      safeValue: "visible",
    });
  });

});
