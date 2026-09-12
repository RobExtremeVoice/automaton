import { createHash } from "node:crypto";
import type { AutomatonTool, ToolContext } from "../types.js";

const API_BASE = "https://services.leadconnectorhq.com";
const API_VERSION = "2021-07-28";

type Contact = {
  id?: string;
  email?: string;
  dnd?: boolean;
  dndSettings?: Record<string, unknown>;
};

function env(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(name + " is not configured");
  return value;
}

function positiveLimit(name: string, fallback: number, maximum: number): number {
  const parsed = Number.parseInt(process.env[name] ?? String(fallback), 10);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(parsed, maximum)) : fallback;
}

async function request(
  method: "GET" | "POST",
  pathname: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const token = env("GHL_PRIVATE_INTEGRATION_TOKEN");
  const response = await fetch(new URL(pathname, API_BASE), {
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

function text(value: unknown, name: string, maximum: number): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(name + " is required");
  const normalized = value.trim();
  if (normalized.length > maximum) {
    throw new Error(name + " exceeds " + maximum + " characters");
  }
  return normalized;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function isEmailDnd(contact: Contact): boolean {
  if (contact.dnd === true) return true;
  const settings = contact.dndSettings;
  if (!settings || typeof settings !== "object") return false;
  const email = settings.Email ?? settings.email;
  if (email === true) return true;
  if (!email || typeof email !== "object") return false;
  const record = email as Record<string, unknown>;
  return record.status === "active" || record.status === "dnd" || record.enabled === true;
}

function counterKey(): string {
  return "ghl.outreach.sent." + new Date().toISOString().slice(0, 10);
}

function claimDailySend(context: ToolContext): { used: number; limit: number } {
  const limit = positiveLimit("GHL_MAX_OUTREACH_DAILY", 3, 100);
  const key = counterKey();
  return context.db.runTransaction(() => {
    const current = Number.parseInt(context.db.getKV(key) ?? "0", 10) || 0;
    if (current >= limit) {
      throw new Error("GoHighLevel daily outreach limit reached: " + current + "/" + limit);
    }
    const used = current + 1;
    context.db.setKV(key, String(used));
    return { used, limit };
  });
}

function releaseDailySend(context: ToolContext): void {
  const key = counterKey();
  context.db.runTransaction(() => {
    const current = Number.parseInt(context.db.getKV(key) ?? "0", 10) || 0;
    context.db.setKV(key, String(Math.max(0, current - 1)));
  });
}

function assertSequenceAllowed(
  context: ToolContext,
  contactId: string,
  kind: "initial" | "followup",
): void {
  const initialKey = "ghl.outreach.initial." + contactId;
  const followupKey = "ghl.outreach.followups." + contactId;
  const initialSent = context.db.getKV(initialKey) === "sent";
  const followups = Number.parseInt(context.db.getKV(followupKey) ?? "0", 10) || 0;
  const maxFollowups = positiveLimit("GHL_MAX_FOLLOWUPS", 1, 10);

  if (kind === "initial" && initialSent) {
    throw new Error("Initial outreach was already sent to this contact");
  }
  if (kind === "followup" && !initialSent) {
    throw new Error("Follow-up blocked because no initial outreach is recorded");
  }
  if (kind === "followup" && followups >= maxFollowups) {
    throw new Error("Maximum follow-ups reached for this contact: " + followups + "/" + maxFollowups);
  }
}

function recordSequence(
  context: ToolContext,
  contactId: string,
  kind: "initial" | "followup",
  fingerprint: string,
): void {
  context.db.runTransaction(() => {
    if (kind === "initial") {
      context.db.setKV("ghl.outreach.initial." + contactId, "sent");
    } else {
      const key = "ghl.outreach.followups." + contactId;
      const current = Number.parseInt(context.db.getKV(key) ?? "0", 10) || 0;
      context.db.setKV(key, String(current + 1));
    }
    context.db.setKV("ghl.outreach.fingerprint." + fingerprint, "sent");
    context.db.setKV(
      "ghl.outreach.last." + contactId,
      new Date().toISOString(),
    );
  });
}

export function createGoHighLevelEmailTools(): AutomatonTool[] {
  return [{
    name: "ghl_send_email",
    description: "Send one compliant, personalized email through GoHighLevel with DND, duplicate, daily-limit, and follow-up controls.",
    category: "conway",
    riskLevel: "caution",
    parameters: {
      type: "object",
      properties: {
        contactId: { type: "string", minLength: 1, maxLength: 100 },
        subject: { type: "string", minLength: 1, maxLength: 150 },
        message: { type: "string", minLength: 1, maxLength: 4000 },
        kind: { type: "string", enum: ["initial", "followup"] },
      },
      required: ["contactId", "subject", "message", "kind"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      if (env("GHL_OUTREACH_CHANNEL").toLowerCase() !== "email") {
        throw new Error("Only the Email outreach channel is enabled");
      }
      const locationId = env("GHL_LOCATION_ID");
      const fromEmail = env("GHL_FROM_EMAIL");
      const fromName = env("GHL_FROM_NAME");
      const postalAddress = env("GHL_BUSINESS_POSTAL_ADDRESS");
      const contactId = text(args.contactId, "contactId", 100);
      const subject = text(args.subject, "subject", 150);
      const message = text(args.message, "message", 4000);
      const kind = args.kind;
      if (kind !== "initial" && kind !== "followup") {
        throw new Error("kind must be initial or followup");
      }

      const contactResult = await request(
        "GET",
        "/contacts/" + encodeURIComponent(contactId),
      );
      const contact = (contactResult.contact ?? contactResult) as Contact;
      if (!contact.email) throw new Error("Contact has no email address");
      if (isEmailDnd(contact)) throw new Error("Contact is DND for email");

      assertSequenceAllowed(context, contactId, kind);
      const fingerprint = createHash("sha256")
        .update(contactId + "\n" + subject + "\n" + message)
        .digest("hex");
      if (context.db.getKV("ghl.outreach.fingerprint." + fingerprint) === "sent") {
        throw new Error("Duplicate email blocked");
      }

      const footer = "\n\n---\n" + fromName + "\n" + postalAddress +
        "\nNão deseja receber novos e-mails? Responda REMOVER.";
      const completeMessage = message + footer;
      const quota = claimDailySend(context);

      try {
        const result = await request("POST", "/conversations/messages", {
          type: "Email",
          locationId,
          contactId,
          subject,
          html: "<div style=\"white-space:pre-wrap\">" +
            escapeHtml(completeMessage) + "</div>",
          emailFrom: fromEmail,
          emailTo: contact.email,
        });
        recordSequence(context, contactId, kind, fingerprint);
        return JSON.stringify({
          sent: true,
          messageId: result.messageId ?? result.id ?? null,
          conversationId: result.conversationId ?? null,
          kind,
          dailyOutreachUsed: quota.used,
          dailyOutreachLimit: quota.limit,
        });
      } catch (error) {
        releaseDailySend(context);
        throw error;
      }
    },
  }];
}
