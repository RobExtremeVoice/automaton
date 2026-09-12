import { createHmac, timingSafeEqual } from "crypto";
import { createServer, type IncomingMessage, type Server } from "http";

const MAX_BODY_BYTES = 1_048_576;
const SUPPORTED_EVENTS = new Set([
  "checkout.session.completed",
  "payment_intent.succeeded",
  "payment_intent.payment_failed",
  "charge.refunded",
  "charge.dispute.created",
]);

export type StripeWebhookEvent = {
  id: string;
  type: string;
  created?: number;
  livemode?: boolean;
  data: { object: Record<string, unknown> };
};

export type StripeWebhookOptions = {
  secret: string;
  port: number;
  host?: string;
  toleranceSeconds?: number;
  expectedMode?: "test" | "live";
  isProcessed: (eventId: string) => boolean;
  markProcessed: (event: StripeWebhookEvent) => void;
  onEvent: (event: StripeWebhookEvent) => Promise<void> | void;
  log?: (message: string) => void;
};

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.destroy();
        reject(new Error("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

export function verifyStripeSignature(
  body: Buffer,
  signatureHeader: string,
  secret: string,
  toleranceSeconds = 300,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const values = new Map<string, string[]>();
  for (const part of signatureHeader.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    values.set(key, [...(values.get(key) ?? []), value]);
  }
  const timestampText = values.get("t")?.[0];
  const signatures = values.get("v1") ?? [];
  if (!timestampText || signatures.length === 0) return false;
  const timestamp = Number.parseInt(timestampText, 10);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > toleranceSeconds) return false;
  const expected = createHmac("sha256", secret)
    .update(timestampText + ".")
    .update(body)
    .digest();
  return signatures.some((candidate) => {
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    const actual = Buffer.from(candidate, "hex");
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  });
}

function json(response: import("http").ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

function parseEvent(body: Buffer): StripeWebhookEvent {
  const value = JSON.parse(body.toString("utf8")) as Partial<StripeWebhookEvent>;
  if (
    typeof value.id !== "string" ||
    !value.id.startsWith("evt_") ||
    typeof value.type !== "string" ||
    !value.data ||
    typeof value.data.object !== "object" ||
    value.data.object === null
  ) {
    throw new Error("invalid Stripe event");
  }
  return value as StripeWebhookEvent;
}

export function startStripeWebhookServer(options: StripeWebhookOptions): Server {
  if (!options.secret.startsWith("whsec_")) throw new Error("invalid Stripe webhook secret");
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "GET" && pathname === "/healthz") {
        json(response, 200, { status: "ok", service: "stripe-webhook" });
        return;
      }
      if (request.method !== "POST" || pathname !== "/webhooks/stripe") {
        json(response, 404, { error: "not_found" });
        return;
      }
      const signature = request.headers["stripe-signature"];
      if (typeof signature !== "string") {
        json(response, 400, { error: "missing_signature" });
        return;
      }
      const body = await readBody(request);
      if (!verifyStripeSignature(
        body,
        signature,
        options.secret,
        options.toleranceSeconds,
      )) {
        json(response, 400, { error: "invalid_signature" });
        return;
      }
      const event = parseEvent(body);
      const expectedLive = options.expectedMode === "live";
      if (options.expectedMode && Boolean(event.livemode) !== expectedLive) {
        json(response, 400, { error: "mode_mismatch" });
        return;
      }
      if (options.isProcessed(event.id)) {
        json(response, 200, { received: true, duplicate: true });
        return;
      }
      if (SUPPORTED_EVENTS.has(event.type)) {
        await options.onEvent(event);
      }
      options.markProcessed(event);
      json(response, 200, { received: true });
    } catch (error) {
      options.log?.("Stripe webhook rejected: " + (error instanceof Error ? error.message : String(error)));
      if (!response.headersSent) json(response, 400, { error: "invalid_request" });
      else response.end();
    }
  });
  server.listen(options.port, options.host ?? "127.0.0.1");
  return server;
}
