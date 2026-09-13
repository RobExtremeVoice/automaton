import {
  isIP,
} from "node:net";
import {
  lookup,
} from "node:dns/promises";
import type {
  AutomatonTool,
  ToolContext,
} from "../types.js";

const MAX_RESPONSE_BYTES = 524_288;
const MAX_TEXT_CHARACTERS = 20_000;
const MAX_REDIRECTS = 5;

function normalizedHost(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
}

function comparableHost(value: string): string {
  const host = normalizedHost(value);

  return host.startsWith("www.")
    ? host.slice(4)
    : host;
}

function blockedIpv4(address: string): boolean {
  const parts = address
    .split(".")
    .map((value) => Number.parseInt(value, 10));

  if (
    parts.length !== 4 ||
    parts.some((value) =>
      !Number.isInteger(value) ||
      value < 0 ||
      value > 255
    )
  ) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function blockedIpv6(address: string): boolean {
  const normalized = address.toLowerCase();

  return (
    normalized === "::" ||
    normalized === "::1" ||
    normalized.startsWith("fc") ||
    normalized.startsWith("fd") ||
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb") ||
    normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") ||
    normalized.startsWith("::ffff:192.168.") ||
    normalized.startsWith("::ffff:169.254.")
  );
}

export function isPublicAddress(
  address: string,
): boolean {
  const family = isIP(address);

  if (family === 4) {
    return !blockedIpv4(address);
  }

  if (family === 6) {
    return !blockedIpv6(address);
  }

  return false;
}

async function assertPublicHostname(
  hostname: string,
): Promise<void> {
  const host = normalizedHost(hostname);

  if (
    !host ||
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error(
      "Website hostname is not public",
    );
  }

  if (isIP(host)) {
    if (!isPublicAddress(host)) {
      throw new Error(
        "Website address is private or reserved",
      );
    }

    return;
  }

  const addresses = await lookup(host, {
    all: true,
    verbatim: true,
  });

  if (
    addresses.length === 0 ||
    addresses.some(
      (entry) => !isPublicAddress(entry.address),
    )
  ) {
    throw new Error(
      "Website hostname resolved to a " +
      "private or reserved address",
    );
  }
}

function parseTarget(value: unknown): URL {
  if (
    typeof value !== "string" ||
    !value.trim()
  ) {
    throw new Error("url is required");
  }

  if (value.length > 2048) {
    throw new Error("url is too long");
  }

  const url = new URL(value.trim());

  if (
    url.protocol !== "https:" &&
    url.protocol !== "http:"
  ) {
    throw new Error(
      "Only HTTP and HTTPS websites are supported",
    );
  }

  if (
    url.username ||
    url.password
  ) {
    throw new Error(
      "URLs containing credentials are blocked",
    );
  }

  return url;
}

function discoveredHostAllowed(
  context: ToolContext,
  hostname: string,
): boolean {
  const host = normalizedHost(hostname);
  const comparable = comparableHost(host);

  return Boolean(
    context.db.getKV(
      "lead.discovery.website.host." + host,
    ) ||
    context.db.getKV(
      "lead.discovery.website.host." +
      comparable,
    ) ||
    context.db.getKV(
      "lead.discovery.website.host.www." +
      comparable,
    ),
  );
}

async function readLimited(
  response: Response,
): Promise<Buffer> {
  const contentLength = Number.parseInt(
    response.headers.get("content-length") ??
      "0",
    10,
  );

  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_RESPONSE_BYTES
  ) {
    throw new Error(
      "Website response exceeds size limit",
    );
  }

  if (!response.body) {
    return Buffer.alloc(0);
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;

  while (true) {
    const item = await reader.read();

    if (item.done) break;

    const chunk = Buffer.from(item.value);
    size += chunk.length;

    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error(
        "Website response exceeds size limit",
      );
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function htmlToText(html: string): string {
  return html
    .replace(
      /<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi,
      " ",
    )
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_TEXT_CHARACTERS);
}

function publicEmails(value: string): string[] {
  const matches = value.match(
    /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,
  ) ?? [];

  return [
    ...new Set(
      matches
        .map((email) => email.toLowerCase())
        .filter(
          (email) =>
            !email.endsWith(".png") &&
            !email.endsWith(".jpg") &&
            !email.endsWith(".jpeg") &&
            !email.endsWith(".gif") &&
            !email.endsWith(".webp"),
        ),
    ),
  ].slice(0, 20);
}

function pageTitle(html: string): string | null {
  const match = html.match(
    /<title[^>]*>([\s\S]*?)<\/title>/i,
  );

  return match
    ? htmlToText(match[1]).slice(0, 300)
    : null;
}

export function createLeadPublicWebsiteTools():
AutomatonTool[] {
  return [{
    name: "lead_fetch_public_website",
    description:
      "Fetch a public business website previously discovered " +
      "through Google Places. This performs a read-only GET, " +
      "cannot make x402 payments, blocks private networks, " +
      "limits redirects and response size, and extracts public " +
      "business emails for lead enrichment.",
    category: "memory",
    riskLevel: "safe",
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          minLength: 8,
          maxLength: 2048,
          description:
            "Public website URL returned by lead discovery",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: async (args, context) => {
      let current = parseTarget(args.url);
      const originalHost =
        comparableHost(current.hostname);

      if (
        !discoveredHostAllowed(
          context,
          current.hostname,
        )
      ) {
        throw new Error(
          "Website domain was not discovered " +
          "through Google Places",
        );
      }

      for (
        let redirect = 0;
        redirect <= MAX_REDIRECTS;
        redirect += 1
      ) {
        if (
          comparableHost(current.hostname) !==
          originalHost
        ) {
          throw new Error(
            "Cross-domain redirects are blocked",
          );
        }

        await assertPublicHostname(
          current.hostname,
        );

        const response = await fetch(current, {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept:
              "text/html,text/plain," +
              "application/xhtml+xml",
            "User-Agent":
              "ThorBusinessResearch/1.0",
          },
          signal: AbortSignal.timeout(15_000),
        });

        if (
          response.status >= 300 &&
          response.status < 400
        ) {
          const location =
            response.headers.get("location");

          if (!location) {
            throw new Error(
              "Website redirect has no location",
            );
          }

          current = new URL(location, current);
          continue;
        }

        if (!response.ok) {
          throw new Error(
            "Website request failed with HTTP " +
            response.status,
          );
        }

        const contentType = (
          response.headers.get("content-type") ??
          ""
        ).toLowerCase();

        if (
          !contentType.includes("text/html") &&
          !contentType.includes("text/plain") &&
          !contentType.includes(
            "application/xhtml+xml",
          )
        ) {
          throw new Error(
            "Unsupported website content type",
          );
        }

        const bytes = await readLimited(response);
        const raw = bytes.toString("utf8");
        const isHtml =
          contentType.includes("html");
        const emailSource = isHtml
          ? raw.replace(
              /<(script|style|noscript|svg)[^>]*>[\s\S]*?<\/\1>/gi,
              " ",
            )
          : raw;
        const text = isHtml
          ? htmlToText(raw)
          : raw
              .replace(/\s+/g, " ")
              .trim()
              .slice(0, MAX_TEXT_CHARACTERS);

        return JSON.stringify({
          requestedUrl: String(args.url),
          finalUrl: current.toString(),
          hostname: current.hostname,
          contentType,
          title: isHtml
            ? pageTitle(raw)
            : null,
          emails: publicEmails(emailSource),
          text,
          truncated:
            raw.length > MAX_TEXT_CHARACTERS,
          bytesRead: bytes.length,
          source: "public_business_website",
          nextStep:
            "Qualify the business and only use a " +
            "clearly public business email for outreach.",
        });
      }

      throw new Error(
        "Website exceeded redirect limit",
      );
    },
  }];
}
