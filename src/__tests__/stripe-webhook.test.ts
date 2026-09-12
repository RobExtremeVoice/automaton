import { afterEach, describe, expect, it, vi } from "vitest";
import { createHmac } from "crypto";
import type { Server } from "http";
import { startStripeWebhookServer, verifyStripeSignature } from "../integrations/stripe-webhook.js";

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
});
