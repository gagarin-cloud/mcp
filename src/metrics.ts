/*
  Reducing a metrics range to what an agent can reason about.

  The engine's range read answers with a few hundred points per series. An
  agent does not need them and cannot read them; it needs the last value, the
  average and the peak, and how close the peak came to the limit. Units are
  named in the answer so nothing has to be remembered about what a bare number
  is.
*/

export type Point = readonly [number, number | null];

export type RangeRead = {
  service?: string;
  window?: string;
  step?: number;
  limits?: Record<string, number | null | undefined>;
  series?: Record<string, readonly Point[] | undefined>;
};

export type SeriesSummary = {
  unit: string;
  last: number;
  avg: number;
  peak: number;
  limit: number | null;
  peak_pct_of_limit: number | null;
};

/** The unit of each series the engine can send. */
export const SERIES_UNITS: Readonly<Record<string, string>> = {
  cpu: 'cores',
  memory: 'bytes',
  disk: 'bytes',
  throttled: 'fraction 0..1 of CPU time throttled',
  net_in: 'bytes/s',
  net_out: 'bytes/s',
  requests: 'requests/s',
  errors: 'fraction 0..1 of requests answered 5xx',
  latency_p95: 'seconds',
};

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/** One series reduced, or undefined when it has no measured points. */
export function summarizeSeries(
  unit: string,
  points: readonly Point[],
  limit: number | null | undefined,
): SeriesSummary | undefined {
  const values = points
    .map((p) => p[1])
    .filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (values.length === 0) return undefined;
  const peak = Math.max(...values);
  const hasLimit = typeof limit === 'number' && limit > 0;
  return {
    unit,
    last: round(values[values.length - 1]!),
    avg: round(values.reduce((a, b) => a + b, 0) / values.length),
    peak: round(peak),
    limit: hasLimit ? limit : null,
    peak_pct_of_limit: hasLimit ? Math.round((peak / limit) * 1000) / 10 : null,
  };
}

/** The whole range read as a summary. A series with nothing to say is left out. */
export function summarizeRange(read: RangeRead) {
  const series: Record<string, SeriesSummary> = {};
  for (const [key, points] of Object.entries(read.series ?? {})) {
    const s = summarizeSeries(SERIES_UNITS[key] ?? 'unknown', points ?? [], read.limits?.[key]);
    if (s) series[key] = s;
  }
  return { service: read.service, window: read.window, step_seconds: read.step, series };
}
