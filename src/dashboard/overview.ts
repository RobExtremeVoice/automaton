import type BetterSqlite3 from "better-sqlite3";

import type { AgentState } from "../types.js";

type Database = BetterSqlite3.Database;

function integerEnv(

  name: string,

  fallback: number,

): number {

  const parsed = Number.parseInt(

    process.env[name] ?? String(fallback),

    10,

  );

  return Number.isFinite(parsed)

    ? Math.max(0, parsed)

    : fallback;

}

function utcDayStart(): string {

  return new Date()

    .toISOString()

    .slice(0, 10) + "T00:00:00.000Z";

}

function safelyParse(

  value: unknown,

): unknown {

  if (typeof value !== "string" || !value) {

    return value ?? null;

  }

  try {

    return JSON.parse(value);

  } catch {

    return value;

  }

}

export function createDashboardOverview(

  db: Database,

): Record<string, unknown> {

  const generatedAt = new Date().toISOString();

  const dayStart = utcDayStart();

  const stateRow = db.prepare(

    "SELECT value FROM kv WHERE key = ?",

  ).get("agent_state") as

    | { value: AgentState }

    | undefined;

  const goals = db.prepare(`

    SELECT

      id,

      title,

      status,

      expected_revenue_cents AS expectedRevenueCents,

      actual_revenue_cents AS actualRevenueCents,

      created_at AS createdAt,

      deadline,

      completed_at AS completedAt

    FROM goals

    ORDER BY created_at DESC

    LIMIT 20

  `).all();

  const tasks = db.prepare(`

    SELECT

      id,

      parent_id AS parentId,

      goal_id AS goalId,

      title,

      status,

      assigned_to AS assignedTo,

      agent_role AS agentRole,

      priority,

      retry_count AS retryCount,

      max_retries AS maxRetries,

      estimated_cost_cents AS estimatedCostCents,

      actual_cost_cents AS actualCostCents,

      created_at AS createdAt,

      started_at AS startedAt,

      completed_at AS completedAt

    FROM task_graph

    ORDER BY created_at DESC

    LIMIT 100

  `).all();

  const children = db.prepare(`

    SELECT

      id,

      name,

      address,

      status,

      role,

      funded_amount_cents AS fundedAmountCents,

      created_at AS createdAt,

      last_checked AS lastChecked

    FROM children

    ORDER BY created_at DESC

    LIMIT 50

  `).all();

  const recentTurns = (

    db.prepare(`

      SELECT

        id,

        timestamp,

        state,

        input_source AS inputSource,

        thinking,

        token_usage AS tokenUsage,

        cost_cents AS costCents

      FROM turns

      ORDER BY timestamp DESC

      LIMIT 30

    `).all() as Array<Record<string, unknown>>

  ).map((row) => ({

    ...row,

    tokenUsage: safelyParse(row.tokenUsage),

  }));

  const recentTools = (

    db.prepare(`

      SELECT

        id,

        turn_id AS turnId,

        name,

        result,

        duration_ms AS durationMs,

        error,

        created_at AS createdAt

      FROM tool_calls

      ORDER BY created_at DESC

      LIMIT 50

    `).all() as Array<Record<string, unknown>>

  ).map((row) => ({

    ...row,

    result:

      typeof row.result === "string"

        ? row.result.slice(0, 1000)

        : row.result,

  }));

  const inference = db.prepare(`

    SELECT

      COALESCE(SUM(cost_cents), 0) AS spentCents,

      COUNT(*) AS calls,

      COALESCE(SUM(input_tokens), 0) AS inputTokens,

      COALESCE(SUM(output_tokens), 0) AS outputTokens

    FROM inference_costs

    WHERE julianday(created_at) >= julianday(?)
      AND julianday(created_at) < julianday(?, '+1 day')

  `).get(dayStart, dayStart) as {

    spentCents: number;

    calls: number;

    inputTokens: number;

    outputTokens: number;

  };

  const taskCounts = db.prepare(`

    SELECT status, COUNT(*) AS count

    FROM task_graph

    GROUP BY status

  `).all() as Array<{

    status: string;

    count: number;

  }>;

  const goalCounts = db.prepare(`

    SELECT status, COUNT(*) AS count

    FROM goals

    GROUP BY status

  `).all() as Array<{

    status: string;

    count: number;

  }>;

  const lastStripeEvent = db.prepare(

    "SELECT value FROM kv WHERE key = ?",

  ).get("stripe.webhook.last_event") as

    | { value: string }

    | undefined;

  const inferenceLimitCents = integerEnv(

    "AUTOMATON_INFERENCE_DAILY_BUDGET_CENTS",

    0,

  );

  return {

    generatedAt,

    agent: {

      state: stateRow?.value ?? "unknown",

      standalone:

        process.env.AUTOMATON_STANDALONE === "true",

      webhookOnly:

        process.env.AUTOMATON_WEBHOOK_ONLY === "true",

      configuredCreditsCents: integerEnv(

        "AUTOMATON_STANDALONE_CREDITS_CENTS",

        0,

      ),

    },

    limits: {

      inferenceDailyCents: inferenceLimitCents,

      googlePlacesSearchesDaily: integerEnv(

        "GOOGLE_PLACES_MAX_SEARCHES_DAILY",

        0,

      ),

      leadDiscoveryDaily: integerEnv(

        "LEAD_DISCOVERY_MAX_DAILY",

        0,

      ),

      newContactsDaily: integerEnv(

        "GHL_MAX_NEW_CONTACTS_DAILY",

        0,

      ),

      outreachDaily: integerEnv(

        "GHL_MAX_OUTREACH_DAILY",

        0,

      ),

    },

    finance: {

      inferenceToday: {

        ...inference,

        limitCents: inferenceLimitCents,

        remainingCents:

          inferenceLimitCents > 0

            ? Math.max(

                0,

                inferenceLimitCents -

                  inference.spentCents,

              )

            : null,

      },

      stripeMode:

        process.env.STRIPE_MODE ?? "unknown",

      lastStripeEvent:

        safelyParse(lastStripeEvent?.value),

    },

    counts: {

      goals: Object.fromEntries(

        goalCounts.map((row) => [

          row.status,

          row.count,

        ]),

      ),

      tasks: Object.fromEntries(

        taskCounts.map((row) => [

          row.status,

          row.count,

        ]),

      ),

      children: children.length,

    },

    goals,

    tasks,

    children,

    recentTurns,

    recentTools,

  };

}
