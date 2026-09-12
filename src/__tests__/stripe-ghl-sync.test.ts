import { describe, expect, it } from "vitest";
import { stripeEventToOpportunity } from "../integrations/stripe-ghl-sync.js";
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
