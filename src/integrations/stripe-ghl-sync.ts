import type { ToolContext } from "../types.js";
import { createGoHighLevelOpportunityTools } from "./gohighlevel-opportunities.js";
import type { StripeWebhookEvent } from "./stripe-webhook.js";

export type StripeGhlOpportunityInput = {
  contactId: string;
  name: string;
  status: "won";
  monetaryValue?: number;
};

export type StripeGhlSyncResult =
  | { outcome: "skipped"; reason: string }
  | {
      outcome: "synced";
      contactId: string;
      opportunityId: string | null;
      operation: string | null;
    };

function metadataFrom(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof item === "string") result[key] = item.trim();
  }
  return result;
}

export function stripeEventToOpportunity(
  event: StripeWebhookEvent,
): StripeGhlOpportunityInput | null {
  if (event.type !== "checkout.session.completed") return null;

  const object = event.data.object;
  if (object.payment_status !== "paid") return null;

  const metadata = metadataFrom(object.metadata);
  const contactId = metadata.ghlContactId;
  if (!contactId || contactId.length > 100) return null;

  const configuredName = metadata.ghlOpportunityName;
  const name = configuredName && configuredName.length <= 200
    ? configuredName
    : "Stripe payment " + event.id;

  const amountTotal = object.amount_total;
  const monetaryValue =
    typeof amountTotal === "number" &&
    Number.isSafeInteger(amountTotal) &&
    amountTotal >= 0
      ? amountTotal / 100
      : undefined;

  return {
    contactId,
    name,
    status: "won",
    ...(monetaryValue !== undefined ? { monetaryValue } : {}),
  };
}

export async function syncStripeEventToGoHighLevel(
  event: StripeWebhookEvent,
  context: Pick<ToolContext, "db">,
): Promise<StripeGhlSyncResult> {
  if (event.type !== "checkout.session.completed") {
    return { outcome: "skipped", reason: "unsupported_event" };
  }

  if (event.data.object.payment_status !== "paid") {
    return { outcome: "skipped", reason: "payment_not_paid" };
  }

  const input = stripeEventToOpportunity(event);
  if (!input) {
    return { outcome: "skipped", reason: "missing_or_invalid_ghl_contact_id" };
  }

  const tool = createGoHighLevelOpportunityTools()
    .find((item) => item.name === "ghl_upsert_opportunity");
  if (!tool) throw new Error("GoHighLevel opportunity tool is unavailable");

  const raw = await tool.execute(input, context as ToolContext);
  const result = JSON.parse(raw) as Record<string, unknown>;

  return {
    outcome: "synced",
    contactId: input.contactId,
    opportunityId:
      typeof result.opportunityId === "string" ? result.opportunityId : null,
    operation: typeof result.operation === "string" ? result.operation : null,
  };
}
