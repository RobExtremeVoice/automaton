import type { AutomatonTool, ToolContext } from "../types.js";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

type Opportunity = {
  id?: string;
  name?: string;
  status?: string;
  contactId?: string;
  pipelineId?: string;
  pipelineStageId?: string;
};

function getConfig(): {
  token: string;
  locationId: string;
  pipelineId: string;
  pipelineStageId: string;
} {
  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN?.trim();
  const locationId = process.env.GHL_LOCATION_ID?.trim();
  const pipelineId = process.env.GHL_DEFAULT_PIPELINE_ID?.trim();
  const pipelineStageId = process.env.GHL_DEFAULT_PIPELINE_STAGE_ID?.trim();
  if (!token || !locationId || !pipelineId || !pipelineStageId) {
    throw new Error("GoHighLevel opportunity configuration is incomplete");
  }
  return { token, locationId, pipelineId, pipelineStageId };
}

async function request(
  method: "GET" | "POST" | "PUT",
  pathname: string,
  body?: Record<string, unknown>,
  query?: Record<string, string>,
): Promise<Record<string, unknown>> {
  const { token } = getConfig();
  const url = new URL(pathname, API_BASE);
  for (const [key, value] of Object.entries(query ?? {})) {
    url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Version: API_VERSION,
      Accept: "application/json",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const raw = await response.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = raw ? JSON.parse(raw) as Record<string, unknown> : {};
  } catch {
    parsed = { message: raw.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(
      "GoHighLevel request failed (" + response.status + "): " +
      String(parsed.message ?? parsed.error ?? "unknown error").slice(0, 500),
    );
  }
  return parsed;
}

function requiredText(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(name + " is required");
  }
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(name + " exceeds " + maximum + " characters");
  }
  return normalized;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(name + " must be a string");
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(name + " exceeds " + maximum + " characters");
  }
  return normalized || undefined;
}

function claimDailyCreation(context: ToolContext): { used: number; limit: number } {
  const configured = Number.parseInt(
    process.env.GHL_MAX_NEW_OPPORTUNITIES_DAILY ?? "5",
    10,
  );
  const limit = Number.isFinite(configured)
    ? Math.max(1, Math.min(configured, 100))
    : 5;
  const key = "ghl.opportunities.created." + new Date().toISOString().slice(0, 10);
  return context.db.runTransaction(() => {
    const current = Number.parseInt(context.db.getKV(key) ?? "0", 10) || 0;
    if (current >= limit) {
      throw new Error(
        "GoHighLevel daily opportunity creation limit reached: " + current + "/" + limit,
      );
    }
    const used = current + 1;
    context.db.setKV(key, String(used));
    return { used, limit };
  });
}

function opportunitiesFrom(value: Record<string, unknown>): Opportunity[] {
  return Array.isArray(value.opportunities)
    ? value.opportunities as Opportunity[]
    : [];
}

export function createGoHighLevelOpportunityTools(): AutomatonTool[] {
  return [
    {
      name: "ghl_search_opportunities",
      description: "Search GoHighLevel opportunities in the configured sales pipeline.",
      category: "memory",
      riskLevel: "safe",
      parameters: {
        type: "object",
        properties: {
          contactId: { type: "string", minLength: 1, maxLength: 100 },
          status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"] },
          limit: { type: "integer", minimum: 1, maximum: 20 },
        },
        additionalProperties: false,
      },
      execute: async (args) => {
        const { locationId, pipelineId } = getConfig();
        const contactId = optionalText(args.contactId, "contactId", 100);
        const status = optionalText(args.status, "status", 20);
        const requestedLimit = typeof args.limit === "number" && Number.isInteger(args.limit)
          ? args.limit
          : 20;
        const result = await request("GET", "/opportunities/search", undefined, {
          location_id: locationId,
          pipeline_id: pipelineId,
          ...(contactId ? { contact_id: contactId } : {}),
          ...(status && status !== "all" ? { status } : {}),
          limit: String(Math.max(1, Math.min(requestedLimit, 20))),
        });
        return JSON.stringify({ opportunities: opportunitiesFrom(result) });
      },
    },
    {
      name: "ghl_upsert_opportunity",
      description: "Update an open opportunity for a contact in the configured pipeline, or create one when none exists.",
      category: "memory",
      riskLevel: "caution",
      parameters: {
        type: "object",
        properties: {
          contactId: { type: "string", minLength: 1, maxLength: 100 },
          name: { type: "string", minLength: 1, maxLength: 200 },
          pipelineStageId: { type: "string", minLength: 1, maxLength: 100 },
          status: { type: "string", enum: ["open", "won", "lost", "abandoned"] },
          monetaryValue: { type: "number", minimum: 0, maximum: 10000000 },
        },
        required: ["contactId", "name"],
        additionalProperties: false,
      },
      execute: async (args, context) => {
        const { locationId, pipelineId, pipelineStageId: defaultStageId } = getConfig();
        const contactId = requiredText(args.contactId, "contactId", 100);
        const name = requiredText(args.name, "name", 200);
        const pipelineStageId = optionalText(args.pipelineStageId, "pipelineStageId", 100)
          ?? defaultStageId;
        const status = optionalText(args.status, "status", 20) ?? "open";
        const monetaryValue = args.monetaryValue;
        if (
          monetaryValue !== undefined &&
          (typeof monetaryValue !== "number" || !Number.isFinite(monetaryValue) || monetaryValue < 0)
        ) {
          throw new Error("monetaryValue must be a non-negative number");
        }

        const search = await request("GET", "/opportunities/search", undefined, {
          location_id: locationId,
          pipeline_id: pipelineId,
          contact_id: contactId,
          limit: "20",
        });
        const existing = opportunitiesFrom(search).find((item) =>
          item.contactId === contactId &&
          item.pipelineId === pipelineId &&
          item.status === "open"
        );
        const payload: Record<string, unknown> = {
          name,
          pipelineId,
          pipelineStageId,
          status,
          ...(monetaryValue !== undefined ? { monetaryValue } : {}),
        };

        if (existing?.id) {
          const updated = await request(
            "PUT",
            "/opportunities/" + encodeURIComponent(existing.id),
            payload,
          );
          const opportunity = (updated.opportunity ?? updated) as Opportunity;
          return JSON.stringify({
            operation: "updated",
            opportunityId: opportunity.id ?? existing.id,
          });
        }

        const quota = claimDailyCreation(context);
        const created = await request("POST", "/opportunities/", {
          ...payload,
          locationId,
          contactId,
        });
        const opportunity = (created.opportunity ?? created) as Opportunity;
        return JSON.stringify({
          operation: "created",
          opportunityId: opportunity.id ?? null,
          dailyCreationsUsed: quota.used,
          dailyCreationLimit: quota.limit,
        });
      },
    },
  ];
}
