import {
  describe,
  expect,
  it,
} from "vitest";
import {
  buildPlannerPrompt,
  type PlannerContext,
} from "../../orchestration/planner.js";
import {
  DEFAULT_PLANNER_AVAILABLE_ROLES,
} from "../../orchestration/planner-context.js";

describe("financial role routing", () => {
  it("includes financial-analyst in default planner roles", () => {
    expect(
      DEFAULT_PLANNER_AVAILABLE_ROLES,
    ).toContain("financial-analyst");
  });

  it("routes financial API execution away from coding roles", () => {
    const context: PlannerContext = {
      creditsCents: 500,
      usdcBalance: 0,
      survivalTier: "stable",
      availableRoles: [
        "executor",
        "financial-analyst",
      ],
      customRoles: [],
      activeGoals: [],
      recentOutcomes: [],
      marketIntel: "none",
      idleAgents: 1,
      busyAgents: 0,
      maxAgents: 2,
      workspaceFiles: [],
    };

    const prompt = buildPlannerPrompt(context);

    expect(prompt).toContain(
      "financial-analyst",
    );
    expect(prompt).toContain(
      "Never assign",
    );
    expect(prompt).toContain(
      "financial API execution",
    );
    expect(prompt).toContain(
      "coding-only role",
    );
  });
});
