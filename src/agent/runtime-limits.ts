export function resolveLocalWorkerMaxTurns(
  environment: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (
    environment.AUTOMATON_STANDALONE !== "true"
  ) {
    return undefined;
  }

  const configured =
    environment.AUTOMATON_LOCAL_WORKER_MAX_TURNS;

  if (configured === undefined) {
    return 10;
  }

  const parsed = Number(configured);

  if (!Number.isFinite(parsed)) {
    return 10;
  }

  return Math.max(
    5,
    Math.min(50, Math.trunc(parsed)),
  );
}

export function resolveDailyInferenceBudgetCents(
  environment: NodeJS.ProcessEnv = process.env,
): number {
  const configured =
    environment
      .AUTOMATON_INFERENCE_DAILY_BUDGET_CENTS;

  if (configured === undefined) {
    return 0;
  }

  const parsed = Number(configured);

  if (!Number.isFinite(parsed)) {
    return 0;
  }

  return Math.max(0, Math.trunc(parsed));
}

export function nextUtcDayStart(
  now: Date = new Date(),
): string {
  return new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate() + 1,
    ),
  ).toISOString();
}
