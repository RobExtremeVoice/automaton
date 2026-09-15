import { createHash } from "node:crypto";
import type { AutomatonTool } from "../types.js";

const API_BASE = "https://api.stripe.com";

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is not configured");
  return value;
}

function getConfig(): {
  key: string;
  mode: "test" | "live";
  currencies: Set<string>;
  maxPriceCents: number;
  successUrl?: string;
} {
  const key = env("STRIPE_RESTRICTED_KEY");
  const configuredMode = (process.env.STRIPE_MODE ?? "test").trim().toLowerCase();
  if (configuredMode !== "test" && configuredMode !== "live") {
    throw new Error("STRIPE_MODE must be test or live");
  }
  const mode = configuredMode as "test" | "live";
  if (!key.startsWith("rk_test_") && !key.startsWith("rk_live_")) {
    throw new Error("STRIPE_RESTRICTED_KEY must be a Stripe restricted key");
  }
  if (mode === "test" && !key.startsWith("rk_test_")) {
    throw new Error("Live Stripe key is blocked while STRIPE_MODE=test");
  }
  if (mode === "live" && !key.startsWith("rk_live_")) {
    throw new Error("Test Stripe key is blocked while STRIPE_MODE=live");
  }

  const currencies = new Set(
    (process.env.STRIPE_ALLOWED_CURRENCIES ?? "usd")
      .split(",")
      .map((item) => item.trim().toLowerCase())
      .filter((item) => /^[a-z]{3}$/.test(item)),
  );
  if (currencies.size === 0) throw new Error("STRIPE_ALLOWED_CURRENCIES is invalid");

  const parsedMaximum = Number.parseInt(
    process.env.STRIPE_MAX_PRICE_CENTS ?? "100000",
    10,
  );
  const maxPriceCents = Number.isSafeInteger(parsedMaximum) && parsedMaximum > 0
    ? Math.min(parsedMaximum, 10_000_000)
    : 100_000;

  const rawSuccessUrl = process.env.STRIPE_SUCCESS_URL?.trim();
  let successUrl: string | undefined;
  if (rawSuccessUrl) {
    const parsed = new URL(rawSuccessUrl);
    if (parsed.protocol !== "https:" && !(mode === "test" && parsed.hostname === "localhost")) {
      throw new Error("STRIPE_SUCCESS_URL must use HTTPS");
    }
    successUrl = parsed.toString();
  }

  return { key, mode, currencies, maxPriceCents, successUrl };
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " is required");
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(name + " exceeds " + maximum + " characters");
  return normalized;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredText(value, name, maximum);
}

function identifier(value: unknown, name: string, prefix: string): string {
  const normalized = requiredText(value, name, 255);
  if (!normalized.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(normalized)) {
    throw new Error(name + " is invalid");
  }
  return normalized;
}

function amount(value: unknown, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 50) {
    throw new Error("amountCents must be an integer of at least 50");
  }
  if ((value as number) > maximum) {
    throw new Error("amountCents exceeds STRIPE_MAX_PRICE_CENTS");
  }
  return value as number;
}

function currency(value: unknown, allowed: Set<string>): string {
  const normalized = requiredText(value ?? "usd", "currency", 3).toLowerCase();
  if (!/^[a-z]{3}$/.test(normalized) || !allowed.has(normalized)) {
    throw new Error("currency is not allowed");
  }
  return normalized;
}

const SENSITIVE_METADATA = /secret|token|password|api.?key|private|card|cvc|cvv|ssn/i;

const RESERVED_AUTOMATON_METADATA = new Set([
  "automaton_growth_fund",
  "automaton_seller_id",
]);

function metadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("metadata must be an object");
  }
  const result: Record<string, string> = {};
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 20) throw new Error("metadata cannot exceed 20 entries");
  for (const [rawKey, rawValue] of entries) {
    const key = rawKey.trim();
    if (
      !key ||
      key.length > 40 ||
      SENSITIVE_METADATA.test(key) ||
      RESERVED_AUTOMATON_METADATA.has(key)
    ) {
      throw new Error(
        "metadata contains an invalid, sensitive, or reserved key",
      );
    }
    if (typeof rawValue !== "string") throw new Error("metadata values must be strings");
    const normalized = rawValue.trim();
    if (normalized.length > 500) throw new Error("metadata value exceeds 500 characters");
    result[key] = normalized;
  }
  return result;
}

function growthFundSellerId(): string {
  const sellerId =
    process.env
      .AUTOMATON_GROWTH_FUND_SELLER_ID
      ?.trim();

  const authorizedSellers = new Set(
    (
      process.env
        .AUTOMATON_GROWTH_FUND_AUTHORIZED_SELLER_IDS ??
      ""
    )
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );

  if (!sellerId) {
    throw new Error(
      "AUTOMATON_GROWTH_FUND_SELLER_ID is not configured",
    );
  }

  if (!authorizedSellers.has(sellerId)) {
    throw new Error(
      "Stripe seller is not authorized for Growth Fund",
    );
  }

  return sellerId;
}

function idempotency(operation: string, value: unknown): string {
  return "thor-" + operation + "-" +
    createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 48);
}

function addMetadata(form: URLSearchParams, values: Record<string, string>): void {
  for (const [key, value] of Object.entries(values)) {
    form.set("metadata[" + key + "]", value);
  }
}

function sanitizedMessage(value: unknown, secret: string): string {
  return String(value ?? "unknown error").replaceAll(secret, "[redacted]").slice(0, 500);
}

async function request(
  method: "GET" | "POST",
  pathname: string,
  form?: URLSearchParams,
  idempotencyKey?: string,
): Promise<Record<string, unknown>> {
  const { key } = getConfig();
  const url = new URL(pathname, API_BASE);
  if (method === "GET" && form) {
    for (const [name, value] of form) url.searchParams.append(name, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + key,
      Accept: "application/json",
      ...(method === "POST" ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: method === "POST" ? form?.toString() : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    parsed = { error: { message: raw } };
  }
  if (!response.ok) {
    const error = parsed.error;
    const message = error && typeof error === "object"
      ? (error as Record<string, unknown>).message
      : parsed.message ?? error;
    throw new Error(
      "Stripe request failed (" + response.status + "): " + sanitizedMessage(message, key),
    );
  }
  return parsed;
}

function publicMetadata(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!SENSITIVE_METADATA.test(key) && typeof item === "string") result[key] = item.slice(0, 500);
  }
  return result;
}

export function createStripeRevenueTools(): AutomatonTool[] {
  return [
    {
      name: "stripe_create_product",
      description: "Create a verified Stripe product for a lawful offer.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 120 },
          description: { type: "string", minLength: 1, maxLength: 500 },
          metadata: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["name", "description"],
        additionalProperties: false,
      },
      execute: async (args) => {
        getConfig();
        const name = requiredText(args.name, "name", 120);
        const description = requiredText(args.description, "description", 500);
        const meta = metadata(args.metadata);
        const form = new URLSearchParams({ name, description });
        addMetadata(form, meta);
        const result = await request("POST", "/v1/products", form, idempotency("product", { name, description, meta }));
        return JSON.stringify({
          productId: result.id ?? null,
          name: result.name ?? name,
          active: result.active ?? true,
          livemode: result.livemode ?? false,
        });
      },
    },
    {
      name: "stripe_create_price",
      description: "Create a capped one-time or recurring Stripe price for an existing product.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          productId: { type: "string", minLength: 1, maxLength: 255 },
          amountCents: { type: "integer", minimum: 50 },
          currency: { type: "string", minLength: 3, maxLength: 3 },
          kind: { type: "string", enum: ["one_time", "recurring"] },
          interval: { type: "string", enum: ["day", "week", "month", "year"] },
          metadata: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["productId", "amountCents", "kind"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const config = getConfig();
        const productId = identifier(args.productId, "productId", "prod_");
        const unitAmount = amount(args.amountCents, config.maxPriceCents);
        const selectedCurrency = currency(args.currency, config.currencies);
        const kind = args.kind;
        if (kind !== "one_time" && kind !== "recurring") throw new Error("kind is invalid");
        const interval = optionalText(args.interval, "interval", 5);
        if (kind === "recurring" && !["day", "week", "month", "year"].includes(interval ?? "")) {
          throw new Error("interval is required for recurring prices");
        }
        if (kind === "one_time" && interval) throw new Error("interval is only valid for recurring prices");
        const meta = metadata(args.metadata);
        const form = new URLSearchParams({
          product: productId,
          unit_amount: String(unitAmount),
          currency: selectedCurrency,
        });
        if (kind === "recurring") form.set("recurring[interval]", interval!);
        addMetadata(form, meta);
        const result = await request(
          "POST",
          "/v1/prices",
          form,
          idempotency("price", { productId, unitAmount, selectedCurrency, kind, interval, meta }),
        );
        return JSON.stringify({
          priceId: result.id ?? null,
          productId: result.product ?? productId,
          amountCents: result.unit_amount ?? unitAmount,
          currency: result.currency ?? selectedCurrency,
          recurring: result.recurring ?? null,
          livemode: result.livemode ?? false,
        });
      },
    },
    {
      name: "stripe_create_payment_link",
      description: "Create a Stripe-hosted Payment Link for an approved price.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          priceId: { type: "string", minLength: 1, maxLength: 255 },
          quantity: { type: "integer", minimum: 1, maximum: 100 },
          metadata: { type: "object", additionalProperties: { type: "string" } },
        },
        required: ["priceId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const config = getConfig();
        const priceId = identifier(args.priceId, "priceId", "price_");
        const quantity = args.quantity === undefined ? 1 : args.quantity;
        if (!Number.isSafeInteger(quantity) || (quantity as number) < 1 || (quantity as number) > 100) {
          throw new Error("quantity must be an integer from 1 to 100");
        }
        const meta = metadata(args.metadata);
        const sellerId = growthFundSellerId();
        const managedMetadata = {
          ...meta,
          automaton_growth_fund: "eligible",
          automaton_seller_id: sellerId,
        };

        const form = new URLSearchParams({
          "line_items[0][price]": priceId,
          "line_items[0][quantity]": String(quantity),
        });

        addMetadata(form, managedMetadata);

        form.set(
          "payment_intent_data[metadata]" +
            "[automaton_growth_fund]",
          "eligible",
        );
        form.set(
          "payment_intent_data[metadata]" +
            "[automaton_seller_id]",
          sellerId,
        );

        if (config.successUrl) {
          form.set("after_completion[type]", "redirect");
          form.set("after_completion[redirect][url]", config.successUrl);
        }
        const result = await request(
          "POST",
          "/v1/payment_links",
          form,
          idempotency(
            "payment-link",
            {
              priceId,
              quantity,
              managedMetadata,
              successUrl: config.successUrl,
            },
          ),
        );
        return JSON.stringify({
          paymentLinkId: result.id ?? null,
          url: result.url ?? null,
          active: result.active ?? true,
          livemode: result.livemode ?? false,
        });
      },
    },
    {
      name: "stripe_get_payment_status",
      description: "Retrieve sanitized payment status for a Stripe Checkout Session.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          sessionId: { type: "string", minLength: 1, maxLength: 255 },
        },
        required: ["sessionId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        getConfig();
        const sessionId = identifier(args.sessionId, "sessionId", "cs_");
        const result = await request("GET", "/v1/checkout/sessions/" + encodeURIComponent(sessionId));
        return JSON.stringify({
          sessionId: result.id ?? sessionId,
          status: result.status ?? null,
          paymentStatus: result.payment_status ?? null,
          amountTotal: result.amount_total ?? null,
          currency: result.currency ?? null,
          paymentIntentId: result.payment_intent ?? null,
          metadata: publicMetadata(result.metadata),
          livemode: result.livemode ?? false,
        });
      },
    },
    {
      name: "stripe_list_recent_payments",
      description: "List sanitized recent Stripe PaymentIntents for revenue monitoring.",
      category: "financial",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          limit: { type: "integer", minimum: 1, maximum: 25 },
          status: {
            type: "string",
            enum: ["all", "succeeded", "processing", "requires_payment_method", "requires_action", "canceled"],
          },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        getConfig();
        const limit = args.limit === undefined ? 10 : args.limit;
        if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 25) {
          throw new Error("limit must be an integer from 1 to 25");
        }
        const status = args.status === undefined ? "all" : requiredText(args.status, "status", 30);
        const allowedStatuses = ["all", "succeeded", "processing", "requires_payment_method", "requires_action", "canceled"];
        if (!allowedStatuses.includes(status)) throw new Error("status is invalid");
        const query = new URLSearchParams({ limit: String(limit) });
        const result = await request("GET", "/v1/payment_intents", query);
        const data = Array.isArray(result.data) ? result.data as Record<string, unknown>[] : [];
        const payments = data
          .filter((item) => status === "all" || item.status === status)
          .map((item) => ({
            paymentIntentId: item.id ?? null,
            amount: item.amount ?? null,
            amountReceived: item.amount_received ?? null,
            currency: item.currency ?? null,
            status: item.status ?? null,
            created: item.created ?? null,
            metadata: publicMetadata(item.metadata),
            livemode: item.livemode ?? false,
          }));
        return JSON.stringify({ payments, hasMore: result.has_more ?? false });
      },
    },
    {
      name: "stripe_deactivate_payment_link",
      description: "Deactivate a Stripe Payment Link so it can no longer accept new payments.",
      category: "financial",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          paymentLinkId: { type: "string", minLength: 1, maxLength: 255 },
        },
        required: ["paymentLinkId"],
        additionalProperties: false,
      },
      execute: async (args) => {
        getConfig();
        const paymentLinkId = identifier(args.paymentLinkId, "paymentLinkId", "plink_");
        const form = new URLSearchParams({ active: "false" });
        const result = await request(
          "POST",
          "/v1/payment_links/" + encodeURIComponent(paymentLinkId),
          form,
          idempotency("deactivate-link", { paymentLinkId }),
        );
        return JSON.stringify({
          paymentLinkId: result.id ?? paymentLinkId,
          active: result.active ?? false,
          livemode: result.livemode ?? false,
        });
      },
    },
  ];
}
