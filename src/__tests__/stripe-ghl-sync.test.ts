import { afterEach, describe, expect, it, vi } from "vitest";
import {
  hydrateStripeWebhookEvent,
  stripeEventToOpportunity,
} from "../integrations/stripe-ghl-sync.js";
import type { StripeWebhookEvent } from "../integrations/stripe-webhook.js";

function event(
  type: string,
  object: Record<string, unknown>,
): StripeWebhookEvent {
  return {
    id: "evt_phase3",
    type,
    livemode: false,
    data: { object },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.STRIPE_RESTRICTED_KEY;
});

describe("Stripe to GoHighLevel opportunity mapping", () => {
  it("maps a paid checkout with a GHL contact ID", () => {
    expect(stripeEventToOpportunity(event("checkout.session.completed", {
      payment_status: "paid",
      amount_total: 12500,
      currency: "usd",
      metadata: {
        ghlContactId: "contact_123",
        ghlOpportunityName: "Consulting package",
      },
    }))).toEqual({
      contactId: "contact_123",
      name: "Consulting package",
      status: "won",
      monetaryValue: 125,
    });
  });

  it("hydrates a thin checkout event from Stripe", async () => {
    process.env.STRIPE_RESTRICTED_KEY = "rk_test_phase3";
    const fullEvent = event("checkout.session.completed", {
      payment_status: "paid",
      amount_total: 100,
      metadata: { ghlContactId: "contact_123" },
    });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(
      new Response(JSON.stringify(fullEvent), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    ));

    const hydrated = await hydrateStripeWebhookEvent(
      event("checkout.session.completed", { id: "cs_test_phase3" }),
    );

    expect(hydrated).toEqual(fullEvent);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.stripe.com/v1/events/evt_phase3",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer rk_test_phase3",
        }),
      }),
    );
  });

  it("does not fetch an already complete checkout event", async () => {
    const fullEvent = event("checkout.session.completed", {
      payment_status: "paid",
      amount_total: 100,
      metadata: { ghlContactId: "contact_123" },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    expect(await hydrateStripeWebhookEvent(fullEvent)).toBe(fullEvent);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses a stable non-PII name when no name is supplied", () => {
    expect(stripeEventToOpportunity(event("checkout.session.completed", {
      payment_status: "paid",
      amount_total: 100,
      metadata: { ghlContactId: "contact_123" },
    }))).toEqual({
      contactId: "contact_123",
      name: "Stripe payment evt_phase3",
      status: "won",
      monetaryValue: 1,
    });
  });

  it("skips unpaid checkout sessions", () => {
    expect(stripeEventToOpportunity(event("checkout.session.completed", {
      payment_status: "unpaid",
      amount_total: 100,
      metadata: { ghlContactId: "contact_123" },
    }))).toBeNull();
  });

  it("skips events without an explicit GHL contact mapping", () => {
    expect(stripeEventToOpportunity(event("checkout.session.completed", {
      payment_status: "paid",
      amount_total: 100,
      metadata: {},
    }))).toBeNull();
  });

  it("skips unrelated Stripe event types", () => {
    expect(stripeEventToOpportunity(event("payment_intent.succeeded", {
      status: "succeeded",
      metadata: { ghlContactId: "contact_123" },
    }))).toBeNull();
  });
});
