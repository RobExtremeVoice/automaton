import type { AutomatonTool } from "../types.js";

const GHL_API_BASE = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";
const REQUEST_TIMEOUT_MS = 15_000;

interface GhlConfig {
  token: string;
  locationId: string;
}

function getConfig(): GhlConfig {
  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN?.trim();
  const locationId = process.env.GHL_LOCATION_ID?.trim();
  if (!token || !locationId) {
    throw new Error("GoHighLevel is not configured. Set GHL_PRIVATE_INTEGRATION_TOKEN and GHL_LOCATION_ID.");
  }
  return { token, locationId };
}

async function ghlRequest(pathname: string, query?: Record<string, string | number | undefined>): Promise<unknown> {
  const { token } = getConfig();
  const url = new URL(pathname, GHL_API_BASE);
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined && String(value).length > 0) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Version: GHL_API_VERSION, Accept: "application/json" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const raw = await response.text();
  let body: unknown = {};
  if (raw) {
    try { body = JSON.parse(raw); } catch { body = { message: raw.slice(0, 500) }; }
  }
  if (!response.ok) {
    const message = body && typeof body === "object" && "message" in body
      ? String((body as { message?: unknown }).message) : `HTTP ${response.status}`;
    throw new Error(`GoHighLevel request failed (${response.status}): ${message.slice(0, 500)}`);
  }
  return body;
}

function asLimitedInteger(value: unknown, fallback: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isInteger(value)) return fallback;
  return Math.max(1, Math.min(value, maximum));
}

function jsonResult(value: unknown): string {
  const serialized = JSON.stringify(value, null, 2);
  return serialized.length <= 12_000 ? serialized : `${serialized.slice(0, 12_000)}\n[response truncated]`;
}

export function createGoHighLevelTools(): AutomatonTool[] {
  return [
    {
      name: "ghl_get_location",
      description: "Get the configured GoHighLevel sub-account and verify CRM connectivity.",
      category: "memory",
      riskLevel: "safe",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute: async () => {
        const { locationId } = getConfig();
        return jsonResult(await ghlRequest(`/locations/${encodeURIComponent(locationId)}`));
      },
    },
    {
      name: "ghl_search_contacts",
      description: "Search contacts in the configured GoHighLevel sub-account by name, email, or phone.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", minLength: 1, maxLength: 200 },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const { locationId } = getConfig();
        const query = typeof args.query === "string" ? args.query.trim() : "";
        if (!query) throw new Error("query is required");
        if (query.length > 200) throw new Error("query must not exceed 200 characters");
        return jsonResult(await ghlRequest("/contacts/", {
          locationId, query, limit: asLimitedInteger(args.limit, 10, 20),
        }));
      },
    },
  ];
}
