import { performance } from 'node:perf_hooks';

export const SCENARIOS = ['liveness', 'task-list', 'task-create'];

let requestSequence = 0;

function requestFor(baseUrl, scenario, implementation) {
  if (scenario === 'liveness') return { url: `${baseUrl}/health`, options: {} };
  if (scenario === 'task-list') {
    return {
      url: `${baseUrl}/tasks?limit=100&lifecycle=active`,
      options: { headers: { Authorization: 'Bearer benchmark-token' } },
    };
  }
  requestSequence += 1;
  return {
    url: `${baseUrl}/tasks`,
    options: {
      method: 'POST',
      headers: {
        Authorization: 'Bearer benchmark-token',
        'Content-Type': 'application/json',
        'Idempotency-Key': `bench-${implementation}-${process.pid}-${requestSequence}`,
      },
      body: JSON.stringify({ title: `Benchmark task ${requestSequence}` }),
    },
  };
}

async function oneRequest(baseUrl, scenario, implementation, record) {
  const request = requestFor(baseUrl, scenario, implementation);
  const started = performance.now();
  const response = await fetch(request.url, request.options);
  await response.arrayBuffer();
  const elapsed = performance.now() - started;
  if (!response.ok) throw new Error(`${scenario} returned HTTP ${response.status}`);
  if (record) record.push(elapsed);
}

export async function runWindow({ baseUrl, scenario, implementation, concurrency, seconds, record }) {
  const latencies = [];
  const deadline = performance.now() + seconds * 1000;
  const worker = async () => {
    while (performance.now() < deadline) {
      await oneRequest(baseUrl, scenario, implementation, record ? latencies : null);
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: concurrency }, worker));
  return { latencies, durationMs: performance.now() - started };
}

function percentile(sorted, quantile) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1)];
}

export function summarizeWindow({ latencies, durationMs }) {
  const sorted = [...latencies].sort((left, right) => left - right);
  return {
    count: sorted.length,
    throughput_rps: sorted.length / (durationMs / 1000),
    p50_ms: percentile(sorted, 0.50),
    p95_ms: percentile(sorted, 0.95),
    p99_ms: percentile(sorted, 0.99),
  };
}
