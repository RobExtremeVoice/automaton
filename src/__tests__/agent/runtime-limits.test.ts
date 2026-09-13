import {
  describe,
  expect,
  it,
} from "vitest";

import {
  nextUtcDayStart,
  resolveDailyInferenceBudgetCents,
  resolveLocalWorkerMaxTurns,
} from "../../agent/runtime-limits.js";

describe("local worker runtime limits", () => {
  it("resolves the runtime daily inference limit", () => {
    expect(
      resolveDailyInferenceBudgetCents({
        AUTOMATON_INFERENCE_DAILY_BUDGET_CENTS:
          "500",
      }),
    ).toBe(500);

    expect(
      resolveDailyInferenceBudgetCents({
        AUTOMATON_INFERENCE_DAILY_BUDGET_CENTS:
          "invalid",
      }),
    ).toBe(0);

    expect(
      resolveDailyInferenceBudgetCents({}),
    ).toBe(0);
  });

  it("calculates the next UTC reset", () => {
    expect(
      nextUtcDayStart(
        new Date("2026-09-13T23:59:59.000Z"),
      ),
    ).toBe("2026-09-14T00:00:00.000Z");
  });

  it("does not override non-standalone workers", () => {
    expect(
      resolveLocalWorkerMaxTurns({}),
    ).toBeUndefined();
  });

  it("uses ten turns by default in standalone mode", () => {
    expect(
      resolveLocalWorkerMaxTurns({
        AUTOMATON_STANDALONE: "true",
      }),
    ).toBe(10);
  });

  it("accepts a configured standalone limit", () => {
    expect(
      resolveLocalWorkerMaxTurns({
        AUTOMATON_STANDALONE: "true",
        AUTOMATON_LOCAL_WORKER_MAX_TURNS: "25",
      }),
    ).toBe(25);
  });

  it("clamps the configured limit safely", () => {
    expect(
      resolveLocalWorkerMaxTurns({
        AUTOMATON_STANDALONE: "true",
        AUTOMATON_LOCAL_WORKER_MAX_TURNS: "2",
      }),
    ).toBe(5);

    expect(
      resolveLocalWorkerMaxTurns({
        AUTOMATON_STANDALONE: "true",
        AUTOMATON_LOCAL_WORKER_MAX_TURNS: "100",
      }),
    ).toBe(50);
  });

  it("uses the default for invalid input", () => {
    expect(
      resolveLocalWorkerMaxTurns({
        AUTOMATON_STANDALONE: "true",
        AUTOMATON_LOCAL_WORKER_MAX_TURNS:
          "invalid",
      }),
    ).toBe(10);
  });
});
