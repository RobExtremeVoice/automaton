import {

  timingSafeEqual,

} from "crypto";

import type {

  IncomingMessage,

  ServerResponse,

} from "http";

export type DashboardHttpOptions = {

  token: string;

  getOverview: () => Record<string, unknown>;

};

function send(

  response: ServerResponse,

  status: number,

  contentType: string,

  body: string,

): void {

  response.writeHead(status, {

    "Content-Type": contentType,

    "Cache-Control": "no-store",

    "X-Content-Type-Options": "nosniff",

    "X-Frame-Options": "DENY",

    "Referrer-Policy": "no-referrer",

    "Content-Security-Policy":

      "default-src 'self'; " +

      "script-src 'unsafe-inline'; " +

      "style-src 'unsafe-inline'; " +

      "connect-src 'self'; " +

      "img-src 'self' data:; " +

      "frame-ancestors 'none'; " +

      "base-uri 'none'; " +

      "form-action 'none'",

  });

  response.end(body);

}

function authorized(

  request: IncomingMessage,

  expectedToken: string,

): boolean {

  const authorization =

    request.headers.authorization;

  if (

    typeof authorization !== "string" ||

    !authorization.startsWith("Bearer ")

  ) {

    return false;

  }

  const supplied = Buffer.from(

    authorization.slice(7),

  );

  const expected = Buffer.from(expectedToken);

  return (

    supplied.length === expected.length &&

    timingSafeEqual(supplied, expected)

  );

}

import { DASHBOARD_HTML } from "./dashboard-page.js";

export function handleDashboardRequest(

  request: IncomingMessage,

  response: ServerResponse,

  options: DashboardHttpOptions,

): boolean {

  const pathname = new URL(

    request.url ?? "/",

    "http://localhost",

  ).pathname;

  if (

    request.method === "GET" &&

    pathname === "/dashboard"

  ) {

    send(

      response,

      200,

      "text/html; charset=utf-8",

      DASHBOARD_HTML,

    );

    return true;

  }

  if (

    request.method === "GET" &&

    pathname === "/api/dashboard/overview"

  ) {

    if (!authorized(request, options.token)) {

      send(

        response,

        401,

        "application/json",

        JSON.stringify({

          error: "unauthorized",

        }),

      );

      return true;

    }

    try {

      send(

        response,

        200,

        "application/json",

        JSON.stringify(options.getOverview()),

      );

    } catch {

      send(

        response,

        500,

        "application/json",

        JSON.stringify({

          error: "dashboard_unavailable",

        }),

      );

    }

    return true;

  }

  return false;

}
