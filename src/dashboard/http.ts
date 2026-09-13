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

const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta
    name="viewport"
    content="width=device-width,initial-scale=1"
  >
  <title>Thor Operations</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #07111f;
      --panel: #101d2d;
      --panel2: #15263a;
      --line: #29425e;
      --text: #edf6ff;
      --muted: #9eb1c7;
      --blue: #50a7ff;
      --green: #43d19e;
      --yellow: #f6c85f;
      --red: #ff6b75;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background:
        radial-gradient(
          circle at top right,
          #12345a,
          transparent 35%
        ),
        var(--bg);
      color: var(--text);
      font: 14px/1.45 system-ui, sans-serif;
    }
    header, main {
      width: min(1440px, calc(100% - 32px));
      margin: auto;
    }
    header {
      display: flex;
      gap: 20px;
      align-items: center;
      justify-content: space-between;
      padding: 24px 0 14px;
    }
    h1, h2, p { margin: 0; }
    h1 { font-size: 24px; }
    h2 {
      font-size: 15px;
      margin-bottom: 12px;
    }
    .muted { color: var(--muted); }
    .auth {
      display: flex;
      gap: 8px;
    }
    input, button {
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 9px 11px;
      color: var(--text);
      background: var(--panel);
    }
    input { width: 260px; }
    button {
      cursor: pointer;
      background: #1769aa;
      font-weight: 700;
    }
    .status {
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      margin-bottom: 14px;
      background: var(--panel);
    }
    .grid {
      display: grid;
      grid-template-columns:
        repeat(auto-fit, minmax(190px, 1fr));
      gap: 12px;
      margin-bottom: 14px;
    }
    .card, section {
      border: 1px solid var(--line);
      border-radius: 12px;
      background: rgba(16,29,45,.92);
      padding: 16px;
    }
    .value {
      font-size: 25px;
      font-weight: 800;
      margin-top: 5px;
    }
    .ok { color: var(--green); }
    .warn { color: var(--yellow); }
    .bad { color: var(--red); }
    .layout {
      display: grid;
      grid-template-columns: 1fr 1fr;
      gap: 14px;
      padding-bottom: 30px;
    }
    section.full { grid-column: 1 / -1; }
    .list {
      display: grid;
      gap: 8px;
      max-height: 420px;
      overflow: auto;
    }
    .row {
      padding: 10px;
      background: var(--panel2);
      border-radius: 8px;
      border-left: 3px solid var(--blue);
    }
    .row strong {
      display: block;
      margin-bottom: 3px;
    }
    .meta {
      color: var(--muted);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .badge {
      display: inline-block;
      padding: 2px 7px;
      margin-left: 6px;
      border-radius: 999px;
      background: #243c55;
      font-size: 11px;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      color: var(--muted);
      margin: 5px 0 0;
      max-height: 100px;
      overflow: hidden;
    }
    @media (max-width: 780px) {
      header {
        align-items: stretch;
        flex-direction: column;
      }
      .auth { flex-direction: column; }
      input { width: 100%; }
      .layout { grid-template-columns: 1fr; }
      section.full { grid-column: auto; }
    }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>Thor Operations</h1>
      <p class="muted">
        Autonomous business control center
      </p>
    </div>
    <div class="auth">
      <input
        id="token"
        type="password"
        placeholder="Dashboard access token"
        autocomplete="current-password"
      >
      <button id="connect">Connect</button>
    </div>
  </header>

  <main>
    <div id="status" class="status">
      Enter the dashboard token.
    </div>

    <div class="grid">
      <div class="card">
        <span class="muted">Thor state</span>
        <div id="agentState" class="value">—</div>
      </div>
      <div class="card">
        <span class="muted">Active goals</span>
        <div id="activeGoals" class="value">—</div>
      </div>
      <div class="card">
        <span class="muted">Running tasks</span>
        <div id="runningTasks" class="value">—</div>
      </div>
      <div class="card">
        <span class="muted">Agents / children</span>
        <div id="children" class="value">—</div>
      </div>
      <div class="card">
        <span class="muted">AI spent today</span>
        <div id="aiSpent" class="value">—</div>
      </div>
      <div class="card">
        <span class="muted">AI remaining</span>
        <div id="aiRemaining" class="value">—</div>
      </div>
    </div>

    <div class="layout">
      <section>
        <h2>Goals</h2>
        <div id="goals" class="list"></div>
      </section>
      <section>
        <h2>Workers and tasks</h2>
        <div id="tasks" class="list"></div>
      </section>
      <section>
        <h2>Created agents</h2>
        <div id="agentList" class="list"></div>
      </section>
      <section>
        <h2>Recent tool activity</h2>
        <div id="tools" class="list"></div>
      </section>
      <section class="full">
        <h2>Recent reasoning turns</h2>
        <div id="turns" class="list"></div>
      </section>
    </div>
  </main>

  <script>
    const byId = (id) =>
      document.getElementById(id);

    const text = (id, value) => {
      byId(id).textContent =
        value === undefined || value === null
          ? "—"
          : String(value);
    };

    const money = (cents) =>
      cents === null || cents === undefined
        ? "Unlimited"
        : "$" + (Number(cents) / 100).toFixed(2);

    const escapeText = (value) =>
      String(value ?? "");

    function rows(id, values, render) {
      const container = byId(id);
      container.replaceChildren();

      if (!values || values.length === 0) {
        const empty = document.createElement("div");
        empty.className = "muted";
        empty.textContent = "No records.";
        container.appendChild(empty);
        return;
      }

      for (const value of values) {
        const row = document.createElement("div");
        row.className = "row";
        render(row, value);
        container.appendChild(row);
      }
    }

    function title(row, value, status) {
      const strong = document.createElement("strong");
      strong.textContent = escapeText(value);

      if (status) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = escapeText(status);
        strong.appendChild(badge);
      }

      row.appendChild(strong);
    }

    function meta(row, value) {
      const element = document.createElement("div");
      element.className = "meta";
      element.textContent = escapeText(value);
      row.appendChild(element);
    }

    function pre(row, value) {
      const element = document.createElement("pre");
      element.textContent = escapeText(value);
      row.appendChild(element);
    }

    function render(data) {
      const state = data.agent?.state ?? "unknown";

      text("agentState", state);
      byId("agentState").className =
        "value " +
        (
          state === "running" ||
          state === "waking"
            ? "ok"
            : state === "critical" ||
              state === "dead"
              ? "bad"
              : "warn"
        );

      text(
        "activeGoals",
        data.counts?.goals?.active ?? 0,
      );
      text(
        "runningTasks",
        data.counts?.tasks?.running ?? 0,
      );
      text("children", data.counts?.children ?? 0);
      text(
        "aiSpent",
        money(
          data.finance?.inferenceToday
            ?.spentCents,
        ),
      );
      text(
        "aiRemaining",
        money(
          data.finance?.inferenceToday
            ?.remainingCents,
        ),
      );

      rows("goals", data.goals, (row, goal) => {
        title(row, goal.title, goal.status);
        meta(
          row,
          "Revenue: " +
          money(goal.actualRevenueCents) +
          " · Created: " +
          (goal.createdAt ?? "unknown"),
        );
      });

      rows("tasks", data.tasks, (row, task) => {
        title(row, task.title, task.status);
        meta(
          row,
          "Worker: " +
          (task.assignedTo ?? "unassigned") +
          " · Role: " +
          (task.agentRole ?? "generalist") +
          " · Retry: " +
          task.retryCount +
          "/" +
          task.maxRetries,
        );
      });

      rows(
        "agentList",
        data.children,
        (row, agent) => {
          title(row, agent.name, agent.status);
          meta(
            row,
            "Role: " +
            (agent.role ?? "generalist") +
            " · Address: " +
            (agent.address ?? "unknown"),
          );
        },
      );

      rows("tools", data.recentTools, (row, tool) => {
        title(
          row,
          tool.name,
          tool.error ? "error" : "completed",
        );
        meta(
          row,
          "Duration: " +
          tool.durationMs +
          " ms · " +
          (tool.createdAt ?? ""),
        );
        if (tool.error) pre(row, tool.error);
      });

      rows(
        "turns",
        data.recentTurns,
        (row, turn) => {
          title(row, "Turn " + turn.id, turn.state);
          meta(
            row,
            (turn.timestamp ?? "") +
            " · Cost: " +
            money(turn.costCents),
          );
          pre(row, turn.thinking);
        },
      );

      byId("status").textContent =
        "Connected · Updated " +
        data.generatedAt +
        " · Stripe " +
        data.finance?.stripeMode;
    }

    async function refresh() {
      const token = byId("token").value.trim();

      if (!token) {
        byId("status").textContent =
          "Dashboard token is required.";
        return;
      }

      try {
        const response = await fetch(
          "/api/dashboard/overview",
          {
            headers: {
              Authorization: "Bearer " + token,
            },
            cache: "no-store",
          },
        );

        if (!response.ok) {
          throw new Error(
            response.status === 401
              ? "Invalid dashboard token."
              : "Dashboard request failed: " +
                response.status
          );
        }

        sessionStorage.setItem(
          "thorDashboardToken",
          token,
        );

        render(await response.json());
      } catch (error) {
        byId("status").textContent =
          error instanceof Error
            ? error.message
            : String(error);
      }
    }

    byId("token").value =
      sessionStorage.getItem(
        "thorDashboardToken",
      ) ?? "";

    byId("connect").addEventListener(
      "click",
      refresh,
    );

    setInterval(() => {
      if (byId("token").value.trim()) {
        refresh();
      }
    }, 5000);

    if (byId("token").value.trim()) {
      refresh();
    }
  </script>
</body>
</html>`;

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
