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
  createGoHighLevelWriteTools,
} from "../integrations/gohighlevel-write.js";

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
    createGoHighLevelWriteTools().find(
      (item) =>
        item.name === "ghl_upsert_contact",
    );

  if (!found) {
    throw new Error("Missing ghl_upsert_contact");
  }

  return found;
}

describe("GoHighLevel contact write tools", () => {
  beforeEach(() => {
    process.env
      .GHL_PRIVATE_INTEGRATION_TOKEN =
      "test-token";
    process.env.GHL_LOCATION_ID =
      "test-location";
    process.env.GHL_MAX_NEW_CONTACTS_DAILY =
      "30";
    process.env.GHL_GOOGLE_PLACES_TAG =
      "thor_gmb_laed";
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env
      .GHL_PRIVATE_INTEGRATION_TOKEN;
    delete process.env.GHL_LOCATION_ID;
    delete process.env
      .GHL_MAX_NEW_CONTACTS_DAILY;
    delete process.env.GHL_GOOGLE_PLACES_TAG;
  });

  it("adds the Google Places tag without sending tags in upsert", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(
        response({
          new: true,
          contact: {
            id: "contact-1",
            email: "owner@example.test",
          },
        }),
      )
      .mockResolvedValueOnce(
        response({
          tags: [
            "existing-tag",
            "thor_gmb_laed",
          ],
        }, 201),
      );

    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(
      await tool().execute(
        {
          name: "Example Business",
          email: "owner@example.test",
          website:
            "https:" + "//example.test",
          source: "google_places",
        },
        createContext(),
      ),
    );

    expect(result.contactId).toBe("contact-1");
    expect(result.googlePlacesTag).toBe(
      "thor_gmb_laed",
    );
    expect(
      result.googlePlacesTagApplied,
    ).toBe(true);

    const upsertOptions =
      fetchMock.mock.calls[0][1];
    const upsertBody =
      JSON.parse(upsertOptions.body);

    expect(upsertBody.tags).toBeUndefined();
    expect(upsertBody.source).toBe(
      "google_places",
    );

    const tagUrl = String(
      fetchMock.mock.calls[1][0],
    );
    const tagOptions =
      fetchMock.mock.calls[1][1];

    expect(tagUrl).toContain(
      "/contacts/contact-1/tags",
    );
    expect(
      JSON.parse(tagOptions.body),
    ).toEqual({
      tags: ["thor_gmb_laed"],
    });
  });

  it("does not tag contacts from other sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response({
        new: true,
        contact: {
          id: "contact-2",
          email: "client@example.test",
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(
      await tool().execute(
        {
          email: "client@example.test",
          source: "referral",
        },
        createContext(),
      ),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      result.googlePlacesTagApplied,
    ).toBe(false);
    expect(result.googlePlacesTag).toBeNull();
  });
});
