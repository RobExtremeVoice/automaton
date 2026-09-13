import {
  afterEach,
  describe,
  expect,
  it,
} from "vitest";

import {
  createDashboardOverview,
} from "../dashboard/overview.js";
import {
  createDatabase,
} from "../state/database.js";

describe("dashboard overview", () => {
  afterEach(() => {
    delete process.env.AUTOMATON_STANDALONE;
    delete process.env
      .AUTOMATON_STANDALONE_CREDITS_CENTS;
    delete process.env
      .AUTOMATON_INFERENCE_DAILY_BUDGET_CENTS;
    delete process.env
      .GOOGLE_PLACES_MAX_SEARCHES_DAILY;
    delete process.env.LEAD_DISCOVERY_MAX_DAILY;
    delete process.env
      .GHL_MAX_NEW_CONTACTS_DAILY;
    delete process.env.GHL_MAX_OUTREACH_DAILY;
    delete process.env.STRIPE_MODE;
  });

  it("returns operational state without secrets", () => {
    const appDb = createDatabase(":memory:");
    const db = appDb.raw;

    process.env.AUTOMATON_STANDALONE = "true";
    process.env
      .AUTOMATON_STANDALONE_CREDITS_CENTS =
      "500";
    process.env
      .AUTOMATON_INFERENCE_DAILY_BUDGET_CENTS =
      "500";
    process.env
      .GOOGLE_PLACES_MAX_SEARCHES_DAILY =
      "30";
    process.env.LEAD_DISCOVERY_MAX_DAILY =
      "30";
    process.env
      .GHL_MAX_NEW_CONTACTS_DAILY =
      "30";
    process.env.GHL_MAX_OUTREACH_DAILY =
      "30";
    process.env.STRIPE_MODE = "live";
    process.env.GOOGLE_PLACES_API_KEY =
      "must-not-appear";
    process.env.STRIPE_RESTRICTED_KEY =
      "must-not-appear";

    db.prepare(`
      INSERT INTO goals (
        id,
        title,
        description,
        status,
        created_at
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      "goal-1",
      "Generate revenue",
      "Test goal",
      "active",
      new Date().toISOString(),
    );

    db.prepare(`
      INSERT INTO task_graph (
        id,
        goal_id,
        title,
        description,
        status,
        assigned_to,
        agent_role,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "task-1",
      "goal-1",
      "Discover leads",
      "Find qualified businesses",
      "running",
      "local://worker-1",
      "generalist",
      new Date().toISOString(),
    );

    db.prepare(`
      INSERT INTO inference_costs (
        id,
        session_id,
        model,
        provider,
        input_tokens,
        output_tokens,
        cost_cents,
        latency_ms,
        tier,
        task_type,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "cost-1",
      "session-1",
      "gpt-5.2",
      "openai",
      100,
      50,
      12,
      100,
      "normal",
      "agent_turn",
      new Date().toISOString(),
    );

    const overview =
      createDashboardOverview(db) as any;

    expect(overview.agent.standalone).toBe(true);
    expect(
      overview.agent.configuredCreditsCents,
    ).toBe(500);
    expect(
      overview.finance.inferenceToday.spentCents,
    ).toBe(12);
    expect(
      overview.finance.inferenceToday
        .remainingCents,
    ).toBe(488);
    expect(overview.finance.stripeMode).toBe(
      "live",
    );
    expect(overview.counts.goals.active).toBe(1);
    expect(overview.counts.tasks.running).toBe(1);
    expect(overview.goals[0].id).toBe("goal-1");
    expect(overview.tasks[0].id).toBe("task-1");

    const serialized = JSON.stringify(overview);

    expect(serialized).not.toContain(
      "must-not-appear",
    );
    expect(serialized).not.toContain(
      "GOOGLE_PLACES_API_KEY",
    );
    expect(serialized).not.toContain(
      "STRIPE_RESTRICTED_KEY",
    );

    appDb.close();

    delete process.env.GOOGLE_PLACES_API_KEY;
    delete process.env.STRIPE_RESTRICTED_KEY;
  });
});
