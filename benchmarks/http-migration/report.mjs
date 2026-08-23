function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

const fixed = (value) => Number(value).toFixed(2);

export function renderReport(result) {
  const lines = [
    '# Express baseline vs NestJS/Fastify',
    '',
    `Data: ${result.generated_at}`,
    '',
    `Baseline: \`${result.baseline.sha}\`; candidate: \`${result.candidate.sha}\`; Node: \`${result.environment.node}\`.`,
    '',
    'To jest syntetyczny benchmark transportu na jednej maszynie i nie jest dowodem produkcyjnym ani pomiarem realnego ruchu. Tryb `memory` używa izolowanego MongoMemoryServer, a `mongo` jednoelementowego MongoMemoryReplSet; oba kontrolują dane, lecz nie odtwarzają sieci, dysku i obciążenia produkcyjnego.',
    '',
    `Metoda: warm-up ${result.method.warmup_seconds}s, pomiar ${result.method.measurement_seconds}s, ${result.method.repetitions} naprzemiennych powtórzeń, concurrency ${result.method.concurrency.join('/')}, ${result.method.cold_starts} cold startów.`,
    '',
    '| Storage | Scenariusz | C | Implementacja | throughput req/s | p50 ms | p95 ms | p99 ms | RSS MiB |',
    '| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | ---: |',
  ];
  const regressions = [];
  for (const storage of result.method.storage) {
    for (const scenario of result.method.scenarios) {
      for (const concurrency of result.method.concurrency) {
        const rows = {};
        for (const implementation of result.method.implementations) {
          const samples = result.samples.filter((sample) => (
            sample.storage === storage
            && sample.scenario === scenario
            && sample.concurrency === concurrency
            && sample.implementation === implementation
          ));
          rows[implementation] = {
            throughput: median(samples.map((sample) => sample.throughput_rps)),
            p50: median(samples.map((sample) => sample.p50_ms)),
            p95: median(samples.map((sample) => sample.p95_ms)),
            p99: median(samples.map((sample) => sample.p99_ms)),
            rss: median(samples.map((sample) => sample.rss_bytes)) / 1024 / 1024,
          };
          const row = rows[implementation];
          lines.push(`| ${storage} | ${scenario} | ${concurrency} | ${implementation} | ${fixed(row.throughput)} | ${fixed(row.p50)} | ${fixed(row.p95)} | ${fixed(row.p99)} | ${fixed(row.rss)} |`);
        }
        const express = rows.express;
        const nest = rows['nest-fastify'];
        const throughputDelta = (nest.throughput / express.throughput - 1) * 100;
        const p95Delta = (nest.p95 / express.p95 - 1) * 100;
        const rssDelta = (nest.rss / express.rss - 1) * 100;
        if (throughputDelta < -20 || p95Delta > 20 || rssDelta > 20) {
          regressions.push(`${storage}/${scenario}/c${concurrency}: throughput ${fixed(throughputDelta)}%, p95 ${fixed(p95Delta)}%, RSS ${fixed(rssDelta)}%`);
        }
      }
    }
  }
  lines.push('', '## Cold start', '', '| Storage | Implementacja | median ms |', '| --- | --- | ---: |');
  for (const storage of result.method.storage) {
    const coldStartRows = {};
    for (const implementation of result.method.implementations) {
      const values = result.cold_start_samples
        .filter((sample) => sample.storage === storage && sample.implementation === implementation)
        .map((sample) => sample.duration_ms);
      coldStartRows[implementation] = median(values);
      lines.push(`| ${storage} | ${implementation} | ${fixed(coldStartRows[implementation])} |`);
    }
    const coldStartDelta = (
      coldStartRows['nest-fastify'] / coldStartRows.express - 1
    ) * 100;
    if (coldStartDelta > 20) {
      regressions.push(`${storage}/cold-start: czas uruchomienia ${fixed(coldStartDelta)}%`);
    }
  }
  lines.push('', '## Regresje powyżej 20%', '');
  if (regressions.length) lines.push(...regressions.map((entry) => `- ${entry}`));
  else lines.push('- Nie zaobserwowano medianowej regresji >20% dla throughput, p95, RSS ani cold startu.');
  lines.push('', 'Wynik wskazuje koszt pełnego kontenera DI/dekoratorów Nest przy zachowaniu kontraktu. Każda wymieniona regresja jest jawna; syntetyczny pomiar nie uzasadnia sam w sobie optymalizacji kosztem bezpieczeństwa lub zgodności.');
  return `${lines.join('\n')}\n`;
}
