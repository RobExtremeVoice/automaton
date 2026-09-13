import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type { ToolContext } from "../types.js";
import {
  createGooglePlacesLeadTools,
} from "../integrations/google-places-leads.js";

function createContext(): ToolContext {
  const values = new Map<string, string>();

  return {
    db: {
      getKV: (key: string) => values.get(key),
      setKV: (key: string, value: string) => {
        values.set(key, value);
      },
      runTransaction: <T>(operation: () => T): T =>
        operation(),
    },
  } as unknown as ToolContext;
}

function response(
  body: Record<string, unknown>,
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
    },
  });
}

function tool() {
  const found =
    createGooglePlacesLeadTools().find(
      (item) =>
        item.name === "lead_discover_businesses",
    );

  if (!found) {
    throw new Error(
      "Missing lead_discover_businesses",
    );
  }

  return found;
}

describe("Google Places lead discovery", () => {
  beforeEach(() => {
    process.env.GOOGLE_PLACES_API_KEY =
      "google-secret-test-key";
    process.env.LEAD_DISCOVERY_MAX_DAILY = "30";
    process.env
      .GOOGLE_PLACES_MAX_SEARCHES_DAILY = "30";
    process.env.GHL_GOOGLE_PLACES_TAG =
      "thor_gmb_laed";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.LEAD_DISCOVERY_MAX_DAILY;
    delete process.env
      .GOOGLE_PLACES_MAX_SEARCHES_DAILY;
    delete process.env.GHL_GOOGLE_PLACES_TAG;
  });

  it("requires the Google Places API key", async () => {
    delete process.env.GOOGLE_PLACES_API_KEY;

    await expect(
      tool().execute(
        {
          query: "dentists",
          location: "Boca Raton, Florida",
        },
        createContext(),
      ),
    ).rejects.toThrow(
      "GOOGLE_PLACES_API_KEY",
    );
  });

  it("returns website and phone for later enrichment", async () => {
    const website =
      "https:" + "//example.test";

    const fetchMock = vi.fn().mockResolvedValue(
      response({
        places: [{
          id: "place-1",
          displayName: {
            text: "Example Dental",
          },
          formattedAddress:
            "100 Main St, Boca Raton, FL",
          internationalPhoneNumber:
            "+1 561-555-0100",
          websiteUri: website,
          googleMapsUri:
            "https:" + "//maps.example.test/place-1",
          businessStatus: "OPERATIONAL",
          primaryType: "dentist",
          rating: 4.8,
          userRatingCount: 120,
        }],
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(
      await tool().execute(
        {
          query: "dentists",
          location: "Boca Raton, Florida",
          limit: 10,
          regionCode: "us",
        },
        createContext(),
      ),
    );

    expect(result.returned).toBe(1);
    expect(result.dailySearchLimit).toBe(30);
    expect(result.dailyLeadLimit).toBe(30);
    expect(result.ghlTag).toBe(
      "thor_gmb_laed",
    );
    expect(result.leads[0]).toMatchObject({
      placeId: "place-1",
      companyName: "Example Dental",
      website,
      phone: "+1 561-555-0100",
      email: null,
      emailEnrichment:
        "pending_website_research",
      suggestedGhlTag: "thor_gmb_laed",
    });

    const options =
      fetchMock.mock.calls[0][1];

    expect(
      options.headers["X-Goog-Api-Key"],
    ).toBe("google-secret-test-key");

    expect(
      JSON.parse(options.body).pageSize,
    ).toBe(10);
  });

  it("deduplicates places across searches", async () => {
    const context = createContext();

    const fetchMock = vi.fn().mockImplementation(
      async () =>
        response({
          places: [{
            id: "same-place",
            displayName: {
              text: "Same Company",
            },
          }],
        }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const first = JSON.parse(
      await tool().execute(
        {
          query: "roofers",
          location: "Boca Raton",
        },
        context,
      ),
    );

    const second = JSON.parse(
      await tool().execute(
        {
          query: "roofing companies",
          location: "Boca Raton",
        },
        context,
      ),
    );

    expect(first.returned).toBe(1);
    expect(second.returned).toBe(0);
    expect(
      second.duplicatesOrLimitSkipped,
    ).toBe(1);
    expect(second.searchesUsedToday).toBe(2);
    expect(second.leadsDiscoveredToday).toBe(1);
  });

  it("authorizes the website of a previously discovered place", async () => {
    const context = createContext();

    context.db.setKV(
      "lead.discovery.google.place.legacy-place",
      "2026-09-12T00:00:00.000Z",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          places: [{
            id: "legacy-place",
            displayName: {
              text: "Legacy Company",
            },
            websiteUri:
              "https://www.legacy-company.example/",
          }],
        }),
      ),
    );

    const result = JSON.parse(
      await tool().execute(
        {
          query: "legacy company",
          location: "Boca Raton",
        },
        context,
      ),
    );

    expect(result.returned).toBe(0);
    expect(result.leadsDiscoveredToday).toBe(0);
    expect(
      context.db.getKV(
        "lead.discovery.website.host." +
          "legacy-company.example",
      ),
    ).toBe("legacy-place");
    expect(
      context.db.getKV(
        "lead.discovery.website.host." +
          "www.legacy-company.example",
      ),
    ).toBe("legacy-place");
  });

  it("enforces daily search and lead limits", async () => {
    process.env
      .GOOGLE_PLACES_MAX_SEARCHES_DAILY = "1";
    process.env.LEAD_DISCOVERY_MAX_DAILY = "1";

    const context = createContext();

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        response({
          places: [
            {
              id: "place-a",
              displayName: { text: "Company A" },
            },
            {
              id: "place-b",
              displayName: { text: "Company B" },
            },
          ],
        }),
      ),
    );

    const first = JSON.parse(
      await tool().execute(
        {
          query: "contractors",
          location: "Miami",
          limit: 2,
        },
        context,
      ),
    );

    expect(first.returned).toBe(1);
    expect(first.leadsDiscoveredToday).toBe(1);

    await expect(
      tool().execute(
        {
          query: "plumbers",
          location: "Miami",
        },
        context,
      ),
    ).rejects.toThrow(
      "daily search limit reached",
    );
  });

  it("releases search quota and redacts key on API failure", async () => {
    const context = createContext();
    const secret = "google-secret-test-key";

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        response({
          error: {
            message:
              "Invalid API key " + secret,
          },
        }, 403),
      )
      .mockResolvedValueOnce(
        response({ places: [] }),
      );

    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool().execute(
        {
          query: "accountants",
          location: "Miami",
        },
        context,
      ),
    ).rejects.toThrow("[REDACTED]");

    const result = JSON.parse(
      await tool().execute(
        {
          query: "accountants",
          location: "Miami",
        },
        context,
      ),
    );

    expect(result.searchesUsedToday).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
