import assert from 'node:assert/strict';
import { test } from 'node:test';

import { summarizeRange, summarizeSeries } from './metrics.js';

test('a series is reduced to last, average, peak and the peak against the limit', () => {
  const s = summarizeSeries(
    'cores',
    [
      [1, 0.1],
      [2, 0.4],
      [3, 0.25],
    ],
    0.5,
  )!;
  assert.deepEqual(s, {
    unit: 'cores',
    last: 0.25,
    last_at: 3,
    avg: 0.25,
    peak: 0.4,
    limit: 0.5,
    peak_pct_of_limit: 80,
  });
});

test('no limit means no percentage, and a zero limit is not divided by', () => {
  for (const limit of [null, undefined, 0]) {
    const s = summarizeSeries('bytes', [[1, 10]], limit)!;
    assert.equal(s.limit, null);
    assert.equal(s.peak_pct_of_limit, null);
  }
});

test('null points are not measured and are not counted as zero', () => {
  const s = summarizeSeries(
    'bytes',
    [
      [1, null],
      [2, 100],
      [3, null],
    ],
    200,
  )!;
  assert.equal(s.last, 100);
  assert.equal(s.last_at, 2, 'the last value is dated by its own point, not the end of the window');
  assert.equal(s.avg, 100);
  assert.equal(summarizeSeries('bytes', [[1, null]], 200), undefined);
  assert.equal(summarizeSeries('bytes', [], 200), undefined);
});

test('the range summary names units, leaves absent series out and keeps window and step', () => {
  const out = summarizeRange({
    service: 'api',
    window: '24h',
    step: 300,
    limits: { cpu: 0.5, memory: 1073741824, disk: null },
    series: {
      cpu: [[1, 0.2]],
      memory: [
        [1, 536870912],
        [2, 966367641.6],
      ],
      latency_p95: [[1, 0.142]],
    },
  });
  assert.equal(out.window, '24h');
  assert.equal(out.step_seconds, 300);
  assert.deepEqual(Object.keys(out.series).sort(), ['cpu', 'latency_p95', 'memory']);
  assert.equal(out.series.memory!.peak_pct_of_limit, 90);
  assert.equal(out.series.memory!.unit, 'bytes');
  assert.equal(out.series.latency_p95!.unit, 'seconds');
  assert.equal(out.series.latency_p95!.limit, null);
});
