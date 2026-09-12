import type { AutomatonTool, ToolContext } from "../types.js";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

type Contact = { id?: string; email?: string; phone?: string };

function getConfig(): { token: string; locationId: string } {
  const token = process.env.GHL_PRIVATE_INTEGRATION_TOKEN?.trim();
  const locationId = process.env.GHL_LOCATION_ID?.trim();
  if (!token || !locationId) {
    throw new Error("GoHighLevel credentials are not configured");
  }
  return { token, locationId };
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
      String(parsed.message ?? "unknown error").slice(0, 500),
    );
  }
  return parsed;
}

function optionalText(value: unknown, name: string, maximum: number): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(name + " must be a string");
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(name + " exceeds " + maximum + " characters");
  return normalized || undefined;
}

function digits(value: string | undefined): string {
  return (value ?? "").replace(/\D/g, "");
}

function exactMatch(contacts: Contact[], email?: string, phone?: string): Contact | undefined {
  const normalizedEmail = email?.toLowerCase();
  const normalizedPhone = digits(phone);
  return contacts.find((contact) =>
    Boolean(normalizedEmail && contact.email?.toLowerCase() === normalizedEmail) ||
    Boolean(normalizedPhone && digits(contact.phone) === normalizedPhone)
  );
}

function claimDailySlot(context: ToolContext): { used: number; limit: number } {
  const configured = Number.parseInt(process.env.GHL_MAX_NEW_CONTACTS_DAILY ?? "5", 10);
  const limit = Number.isFinite(configured) ? Math.max(1, Math.min(configured, 100)) : 5;
  const key = "ghl.contacts.created." + new Date().toISOString().slice(0, 10);
  return context.db.runTransaction(() => {
    const current = Number.parseInt(context.db.getKV(key) ?? "0", 10) || 0;
    if (current >= limit) {
      throw new Error("GoHighLevel daily contact creation limit reached: " + current + "/" + limit);
    }
    const used = current + 1;
    context.db.setKV(key, String(used));
    return { used, limit };
  });
}

export function createGoHighLevelWriteTools(): AutomatonTool[] {
  return [{
    name: "ghl_upsert_contact",
    description:
      "Create or update a GoHighLevel contact. Searches for an exact email or phone match first to prevent duplicates.",
    category: "memory",
    riskLevel: "caution",
    parameters: {
      type: "object",
      properties: {
        firstName: { type: "string", maxLength: 100 },
        lastName: { type: "string", maxLength: 100 },
        name: { type: "string", maxLength: 200 },
        email: { type: "string", maxLength: 254 },
        phone: { type: "string", maxLength: 40 },
        companyName: { type: "string", maxLength: 200 },
        website: { type: "string", maxLength: 500 },
        source: { type: "string", maxLength: 100 },
      },
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const { locationId } = getConfig();
      const email = optionalText(args.email, "email", 254);
      const phone = optionalText(args.phone, "phone", 40);
      if (!email && !phone) throw new Error("email or phone is required");

      const payload: Record<string, unknown> = { locationId };
      for (const [key, maximum] of Object.entries({
        firstName: 100, lastName: 100, name: 200, companyName: 200,
        website: 500, source: 100,
      })) {
        const value = optionalText(args[key], key, maximum);
        if (value) payload[key] = value;
      }
      if (email) payload.email = email;
      if (phone) payload.phone = phone;

      const quota = claimDailySlot(context);
      const upserted = await request(
        "POST",
        "/contacts/upsert",
        payload,
      );
      const contact = (upserted.contact ?? upserted) as Contact;
      const created = upserted.new === true;
      return JSON.stringify({
        operation: created ? "created" : "upserted",
        contactId: contact.id ?? null,
        dailyUpsertsUsed: quota.used,
        dailyUpsertLimit: quota.limit,
      });
    },
  }];
}
