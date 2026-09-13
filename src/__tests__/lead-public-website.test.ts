import {
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import type {
  ToolContext,
} from "../types.js";
import {
  createLeadPublicWebsiteTools,
  isPublicAddress,
} from "../integrations/lead-public-website.js";

function createContext(): ToolContext {
  const values = new Map<string, string>();

  return {
    db: {
      getKV: (key: string) => values.get(key),
      setKV: (key: string, value: string) => {
        values.set(key, value);
      },
      runTransaction: <T>(
        operation: () => T,
      ): T => operation(),
    },
  } as unknown as ToolContext;
}

function tool() {
  const found =
    createLeadPublicWebsiteTools().find(
      (item) =>
        item.name ===
        "lead_fetch_public_website",
    );

  if (!found) {
    throw new Error(
      "Missing lead_fetch_public_website",
    );
  }

  return found;
}

function authorize(
  context: ToolContext,
  hostname: string,
): void {
  context.db.setKV(
    "lead.discovery.website.host." +
      hostname,
    "place-test",
  );
}

describe("public lead website fetch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies private and public addresses", () => {
    expect(isPublicAddress("127.0.0.1"))
      .toBe(false);
    expect(isPublicAddress("10.0.0.1"))
      .toBe(false);
    expect(isPublicAddress("169.254.169.254"))
      .toBe(false);
    expect(isPublicAddress("192.168.1.10"))
      .toBe(false);
    expect(isPublicAddress("::1"))
      .toBe(false);
    expect(isPublicAddress("fc00::1"))
      .toBe(false);
    expect(isPublicAddress("93.184.216.34"))
      .toBe(true);
    expect(isPublicAddress("2606:2800:220:1::1"))
      .toBe(true);
  });

  it("rejects domains not discovered by Places", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool().execute(
        {
          url: "https://93.184.216.34/",
        },
        createContext(),
      ),
    ).rejects.toThrow(
      "was not discovered through Google Places",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks discovered private addresses", async () => {
    const context = createContext();
    authorize(context, "127.0.0.1");

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      tool().execute(
        {
          url: "http://127.0.0.1/",
        },
        context,
      ),
    ).rejects.toThrow(
      "private or reserved",
    );

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("extracts public emails and readable text", async () => {
    const context = createContext();
    authorize(context, "93.184.216.34");

    const html = [
      "<html><head>",
      "<title>Example HVAC</title>",
      "<style>.hidden{display:none}</style>",
      "</head><body>",
      "<h1>Example HVAC</h1>",
      "<p>Commercial automation services.</p>",
      "<p>Email sales@example.test</p>",
      "<script>ignore@example.test</script>",
      "</body></html>",
    ].join("");

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(html, {
        status: 200,
        headers: {
          "Content-Type":
            "text/html; charset=utf-8",
        },
      }),
    );

    vi.stubGlobal("fetch", fetchMock);

    const result = JSON.parse(
      await tool().execute(
        {
          url: "https://93.184.216.34/",
        },
        context,
      ),
    );

    expect(result.title).toBe("Example HVAC");
    expect(result.emails).toContain(
      "sales@example.test",
    );
    expect(result.emails).not.toContain(
      "ignore@example.test",
    );
    expect(result.text).toContain(
      "Commercial automation services.",
    );
    expect(result.text).not.toContain(
      "ignore@example.test",
    );
    expect(result.source).toBe(
      "public_business_website",
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("blocks cross-domain redirects", async () => {
    const context = createContext();
    authorize(context, "93.184.216.34");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(null, {
          status: 302,
          headers: {
            Location:
              "https://93.184.216.35/private",
          },
        }),
      ),
    );

    await expect(
      tool().execute(
        {
          url: "https://93.184.216.34/",
        },
        context,
      ),
    ).rejects.toThrow(
      "Cross-domain redirects are blocked",
    );
  });

  it("rejects oversized responses", async () => {
    const context = createContext();
    authorize(context, "93.184.216.34");

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response("small", {
          status: 200,
          headers: {
            "Content-Type": "text/html",
            "Content-Length": "600000",
          },
        }),
      ),
    );

    await expect(
      tool().execute(
        {
          url: "https://93.184.216.34/",
        },
        context,
      ),
    ).rejects.toThrow(
      "exceeds size limit",
    );
  });
});
