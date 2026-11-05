/** Reconnect delay for network failures: 1 s, 2 s, 4 s … capped at 30 s, with ±20 % jitter. */
export const backoff = (attempt: number, random: () => number = Math.random) =>
  Math.min(30_000, 1000 * 2 ** Math.max(0, attempt - 1)) * (0.8 + 0.4 * random());

/** HTTP-classified failures (503/401/403/HTML) will not clear by themselves: probe on a flat interval instead. */
export const HTTP_PROBE_MS = 30_000;
