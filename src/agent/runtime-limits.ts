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
