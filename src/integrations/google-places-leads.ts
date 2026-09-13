import type { AutomatonTool, ToolContext } from "../types.js";

const API_URL =
  "https:" +
  "//places.googleapis.com/v1/places:searchText";

type Place = {
  id?: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  googleMapsUri?: string;
  businessStatus?: string;
  rating?: number;
  userRatingCount?: number;
  primaryType?: string;
};

function requiredText(
  value: unknown,
  name: string,
  maximum: number,
): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(name + " is required");
  }

  const normalized = value.trim();

  if (normalized.length > maximum) {
    throw new Error(
      name + " exceeds " + maximum + " characters",
    );
  }

  return normalized;
}

function positiveLimit(
  name: string,
  fallback: number,
  maximum: number,
): number {
  const parsed = Number.parseInt(
    process.env[name] ?? String(fallback),
    10,
  );

  return Number.isFinite(parsed)
    ? Math.max(1, Math.min(parsed, maximum))
    : fallback;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function claimSearch(
  context: ToolContext,
): { used: number; limit: number } {
  const limit = positiveLimit(
    "GOOGLE_PLACES_MAX_SEARCHES_DAILY",
    30,
    100,
  );

  const key =
    "lead.discovery.google.searches." + today();

  return context.db.runTransaction(() => {
    const current =
      Number.parseInt(
        context.db.getKV(key) ?? "0",
        10,
      ) || 0;

    if (current >= limit) {
      throw new Error(
        "Google Places daily search limit reached: " +
          current +
          "/" +
          limit,
      );
    }

    const used = current + 1;
    context.db.setKV(key, String(used));

    return { used, limit };
  });
}

function releaseSearch(context: ToolContext): void {
  const key =
    "lead.discovery.google.searches." + today();

  context.db.runTransaction(() => {
    const current =
      Number.parseInt(
        context.db.getKV(key) ?? "0",
        10,
      ) || 0;

    context.db.setKV(
      key,
      String(Math.max(0, current - 1)),
    );
  });
}

function recordNewPlaces(
  context: ToolContext,
  places: Place[],
): {
  accepted: Place[];
  used: number;
  limit: number;
} {
  const limit = positiveLimit(
    "LEAD_DISCOVERY_MAX_DAILY",
    30,
    100,
  );

  const counterKey =
    "lead.discovery.google.leads." + today();

  return context.db.runTransaction(() => {
    let used =
      Number.parseInt(
        context.db.getKV(counterKey) ?? "0",
        10,
      ) || 0;

    const accepted: Place[] = [];

    for (const place of places) {
      if (!place.id) {
        continue;
      }

      const placeKey =
        "lead.discovery.google.place." + place.id;

      // Authorize websites returned by Google Places even when the
      // place was discovered by an older version or is a duplicate.
      if (place.websiteUri) {
        try {
          const website =
            new URL(place.websiteUri);
          const host =
            website.hostname
              .trim()
              .toLowerCase()
              .replace(/\.$/, "");
          const comparable =
            host.startsWith("www.")
              ? host.slice(4)
              : host;

          if (
            (website.protocol === "https:" ||
              website.protocol === "http:") &&
            host
          ) {
            context.db.setKV(
              "lead.discovery.website.host." +
                host,
              place.id,
            );
            context.db.setKV(
              "lead.discovery.website.host." +
                comparable,
              place.id,
            );
            context.db.setKV(
              "lead.discovery.website.host.www." +
                comparable,
              place.id,
            );
          }
        } catch {
          // Invalid Places website URLs are not authorized.
        }
      }

      if (
        context.db.getKV(placeKey) ||
        used >= limit
      ) {
        continue;
      }

      context.db.setKV(
        placeKey,
        new Date().toISOString(),
      );

      accepted.push(place);
      used += 1;
    }

    context.db.setKV(counterKey, String(used));

    return { accepted, used, limit };
  });
}

function regionCode(
  value: unknown,
): string | undefined {
  if (
    value === undefined ||
    value === null ||
    value === ""
  ) {
    return undefined;
  }

  const normalized = requiredText(
    value,
    "regionCode",
    2,
  ).toUpperCase();

  if (!/^[A-Z]{2}$/.test(normalized)) {
    throw new Error(
      "regionCode must be a two-letter country code",
    );
  }

  return normalized;
}

export function createGooglePlacesLeadTools():
AutomatonTool[] {
  return [{
    name: "lead_discover_businesses",
    description:
      "Discover public business leads through Google Places. " +
      "Returns company, website, phone, address, rating and " +
      "Google Maps URL. Email enrichment must be performed " +
      "later from the public business website. Import qualified " +
      "contacts with ghl_upsert_contact and tag thor_gmb_laed.",
    category: "memory",
    riskLevel: "safe",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          minLength: 2,
          maxLength: 150,
          description:
            "Business category or ideal prospect",
        },
        location: {
          type: "string",
          minLength: 2,
          maxLength: 150,
          description:
            "City, state, region, or market",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 20,
        },
        regionCode: {
          type: "string",
          minLength: 2,
          maxLength: 2,
        },
      },
      required: ["query", "location"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      const apiKey =
        process.env.GOOGLE_PLACES_API_KEY?.trim();

      if (!apiKey) {
        throw new Error(
          "GOOGLE_PLACES_API_KEY is not configured",
        );
      }

      const query = requiredText(
        args.query,
        "query",
        150,
      );

      const location = requiredText(
        args.location,
        "location",
        150,
      );

      const limit =
        args.limit === undefined ? 10 : args.limit;

      if (
        !Number.isInteger(limit) ||
        Number(limit) < 1 ||
        Number(limit) > 20
      ) {
        throw new Error(
          "limit must be an integer from 1 to 20",
        );
      }

      const region = regionCode(args.regionCode);
      const searchQuota = claimSearch(context);

      let response: Response;

      try {
        response = await fetch(API_URL, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": [
              "places.id",
              "places.displayName",
              "places.formattedAddress",
              "places.nationalPhoneNumber",
              "places.internationalPhoneNumber",
              "places.websiteUri",
              "places.googleMapsUri",
              "places.businessStatus",
              "places.rating",
              "places.userRatingCount",
              "places.primaryType",
            ].join(","),
          },
          body: JSON.stringify({
            textQuery:
              query + " in " + location,
            pageSize: Number(limit),
            ...(region
              ? { regionCode: region }
              : {}),
          }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (error) {
        releaseSearch(context);
        throw error;
      }

      const raw = await response.text();

      let data: Record<string, unknown> = {};

      try {
        data = raw
          ? JSON.parse(raw) as Record<string, unknown>
          : {};
      } catch {
        data = {};
      }

      if (!response.ok) {
        releaseSearch(context);

        const apiError =
          data.error &&
          typeof data.error === "object"
            ? data.error as Record<string, unknown>
            : {};

        const safeMessage = String(
          apiError.message ?? "unknown error",
        )
          .replaceAll(apiKey, "[REDACTED]")
          .slice(0, 500);

        throw new Error(
          "Google Places request failed (" +
            response.status +
            "): " +
            safeMessage,
        );
      }

      const places = Array.isArray(data.places)
        ? data.places as Place[]
        : [];

      const discovery =
        recordNewPlaces(context, places);

      const tag =
        process.env.GHL_GOOGLE_PLACES_TAG?.trim() ||
        "thor_gmb_laed";

      const leads = discovery.accepted.map(
        (place) => ({
          source: "google_places",
          placeId: place.id ?? null,
          companyName:
            place.displayName?.text ?? null,
          website:
            place.websiteUri ?? null,
          phone:
            place.internationalPhoneNumber ??
            place.nationalPhoneNumber ??
            null,
          email: null,
          emailEnrichment:
            place.websiteUri
              ? "pending_website_research"
              : "website_unavailable",
          suggestedGhlTag: tag,
          address:
            place.formattedAddress ?? null,
          googleMapsUrl:
            place.googleMapsUri ?? null,
          businessStatus:
            place.businessStatus ?? null,
          primaryType:
            place.primaryType ?? null,
          rating:
            place.rating ?? null,
          userRatingCount:
            place.userRatingCount ?? null,
        }),
      );

      return JSON.stringify({
        query,
        location,
        leads,
        returned: leads.length,
        duplicatesOrLimitSkipped:
          Math.max(0, places.length - leads.length),
        searchesUsedToday: searchQuota.used,
        dailySearchLimit: searchQuota.limit,
        leadsDiscoveredToday: discovery.used,
        dailyLeadLimit: discovery.limit,
        ghlTag: tag,
        nextStep:
          "Research each public website for a business email, " +
          "qualify the lead, then use ghl_upsert_contact.",
      });
    },
  }];
}
