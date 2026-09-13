import {
  describe,
  expect,
  it,
} from "vitest";

import {
  resolveLocalWorkerMaxTurns,
} from "../../agent/runtime-limits.js";

describe("local worker runtime limits", () => {
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
