#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { renderReport } from './report.mjs';
import { runWindow, SCENARIOS, summarizeWindow } from './workload.mjs';

const benchmarkRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(benchmarkRoot, '../..');
const fixtureServer = path.join(benchmarkRoot, 'fixture-server.mjs');

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) continue;
    const [rawName, inline] = entry.slice(2).split('=', 2);
    result[rawName] = inline ?? argv[++index];
  }
  return result;
}

function command(commandName, args, options = {}) {
  const completed = spawnSync(commandName, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (completed.status !== 0) {
    throw new Error(`${commandName} ${args.join(' ')} failed: ${completed.stderr ?? ''}`);
  }
  return (completed.stdout ?? '').trim();
}

function prepareBaseline(sha, temporaryRoot) {
  const archive = path.join(temporaryRoot, 'baseline.tar');
  const source = path.join(temporaryRoot, 'baseline');
  fs.mkdirSync(source);
  command('git', ['archive', '--format=tar', '--output', archive, sha]);
  command('tar', ['-xf', archive, '-C', source]);
  command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: path.join(source, 'backend-node') });
  command('npm', ['run', 'build'], { cwd: path.join(source, 'backend-node') });
  return path.join(source, 'backend-node');
}

function readRss(pid) {
  const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
  const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
  return match ? Number(match[1]) * 1024 : 0;
}

async function startFixture({ implementation, appRoot, mongoUri }) {
  const startedAt = performance.now();
  const child = spawn(process.execPath, [
    fixtureServer,
    `--implementation=${implementation}`,
    `--app-root=${appRoot}`,
    `--mongo-uri=${mongoUri}`,
  ], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const ready = await new Promise((resolve, reject) => {
    let stdout = '';
    const timeout = setTimeout(() => reject(new Error(`fixture startup timed out: ${stderr}`)), 45_000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      const line = stdout.split('\n').find((candidate) => candidate.startsWith('BENCH_READY '));
      if (line) {
        clearTimeout(timeout);
        resolve(JSON.parse(line.slice('BENCH_READY '.length)));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`fixture exited ${code}: ${stderr}`));
    });
  });
  return {
    child,
    baseUrl: `http://127.0.0.1:${ready.port}`,
    readyDurationMs: performance.now() - startedAt,
    stderr: () => stderr,
  };
}

async function stopFixture(fixture) {
  if (fixture.child.exitCode !== null) return;
  fixture.child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      fixture.child.kill('SIGKILL');
      resolve();
    }, 10_000);
    fixture.child.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

async function coldStartSamples({ count, storage, implementation, appRoot, mongoUri }) {
  const samples = [];
  for (let index = 0; index < count; index += 1) {
    const fixture = await startFixture({ implementation, appRoot, mongoUri });
    try {
      const response = await fetch(`${fixture.baseUrl}/health`);
      await response.arrayBuffer();
      if (!response.ok) throw new Error(`cold-start liveness returned ${response.status}`);
      samples.push({
        storage,
        implementation,
        repetition: index + 1,
        duration_ms: fixture.readyDurationMs,
        rss_bytes: readRss(fixture.child.pid),
      });
    } finally {
      await stopFixture(fixture);
    }
  }
  return samples;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const baselineSha = args['baseline-sha'];
  if (!/^[a-f0-9]{40}$/.test(baselineSha ?? '')) throw new Error('--baseline-sha must be a full SHA');
  const warmupSeconds = Number(args['warmup-seconds'] ?? 5);
  const measurementSeconds = Number(args['measurement-seconds'] ?? 15);
  const repetitions = Number(args.repetitions ?? 5);
  const coldStarts = Number(args['cold-starts'] ?? 10);
  const concurrencyValues = String(args.concurrency ?? '1,10,50').split(',').map(Number);
  const storageValues = String(args.storage ?? 'memory,mongo').split(',');
  const implementations = ['express', 'nest-fastify'];
  const candidateSha = command('git', ['rev-parse', 'HEAD'], { capture: true });
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eisenhower-http-benchmark-'));
  const candidateRoot = path.join(root, 'backend-node');
  const outputPath = path.resolve(root, args.output ?? 'benchmarks/results/nest-fastify-migration.json');
  const reportPath = path.resolve(
    root,
    args.report ?? 'docs/benchmarks/2026-08-23-express-vs-nest-fastify.md',
  );
  const samples = [];
  const coldSamples = [];
  const servers = [];
  const databases = [];
  try {
    process.stdout.write('Preparing exact Express baseline and candidate builds...\n');
    const baselineRoot = prepareBaseline(baselineSha, temporaryRoot);
    command('npm', ['run', 'build'], { cwd: candidateRoot });
    const appRoots = { express: baselineRoot, 'nest-fastify': candidateRoot };
    const candidateRequire = createRequire(path.join(candidateRoot, 'package.json'));
    const { MongoMemoryServer, MongoMemoryReplSet } = candidateRequire('mongodb-memory-server');

    for (const storage of storageValues) {
      process.stdout.write(`Starting isolated ${storage} database...\n`);
      const database = storage === 'mongo'
        ? await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } })
        : await MongoMemoryServer.create();
      databases.push(database);
      const uriFor = (name) => database.getUri(`bench_${storage}_${name}`);

      for (const scenario of SCENARIOS) {
        const fixtures = {};
        for (const implementation of implementations) {
          fixtures[implementation] = await startFixture({
            implementation,
            appRoot: appRoots[implementation],
            mongoUri: uriFor(`${scenario.replace('-', '_')}_${implementation.replace('-', '_')}`),
          });
          servers.push(fixtures[implementation]);
        }
        try {
          for (const concurrency of concurrencyValues) {
            for (const implementation of implementations) {
              process.stdout.write(`Warm-up ${storage}/${scenario}/c${concurrency}/${implementation}\n`);
              await runWindow({
                baseUrl: fixtures[implementation].baseUrl,
                scenario,
                implementation,
                concurrency,
                seconds: warmupSeconds,
                record: false,
              });
            }
            for (let repetition = 0; repetition < repetitions; repetition += 1) {
              const order = repetition % 2 === 0 ? implementations : [...implementations].reverse();
              for (let orderIndex = 0; orderIndex < order.length; orderIndex += 1) {
                const implementation = order[orderIndex];
                process.stdout.write(`Measure ${storage}/${scenario}/c${concurrency}/r${repetition + 1}/${implementation}\n`);
                const window = await runWindow({
                  baseUrl: fixtures[implementation].baseUrl,
                  scenario,
                  implementation,
                  concurrency,
                  seconds: measurementSeconds,
                  record: true,
                });
                samples.push({
                  storage,
                  scenario,
                  concurrency,
                  repetition: repetition + 1,
                  order: orderIndex,
                  implementation,
                  ...summarizeWindow(window),
                  rss_bytes: readRss(fixtures[implementation].child.pid),
                });
              }
            }
          }
        } finally {
          for (const implementation of implementations) {
            await stopFixture(fixtures[implementation]);
            servers.splice(servers.indexOf(fixtures[implementation]), 1);
          }
        }
      }
      for (const implementation of implementations) {
        process.stdout.write(`Cold starts ${storage}/${implementation}\n`);
        coldSamples.push(...await coldStartSamples({
          count: coldStarts,
          storage,
          implementation,
          appRoot: appRoots[implementation],
          mongoUri: uriFor(`cold_${implementation.replace('-', '_')}`),
        }));
      }
    }

    const result = {
      schema_version: 'http-migration-benchmark-v1',
      generated_at: new Date().toISOString(),
      baseline: {
        sha: baselineSha,
        package: JSON.parse(fs.readFileSync(
          path.join(temporaryRoot, 'baseline/backend-node/package.json'),
          'utf8',
        )),
      },
      candidate: {
        sha: candidateSha,
        package: JSON.parse(fs.readFileSync(path.join(candidateRoot, 'package.json'), 'utf8')),
      },
      environment: {
        node: process.version,
        kernel: `${os.type()} ${os.release()} ${os.arch()}`,
        cpu: os.cpus()[0]?.model ?? 'unknown',
        cpu_count: os.cpus().length,
      },
      method: {
        implementations,
        storage: storageValues,
        scenarios: SCENARIOS,
        concurrency: concurrencyValues,
        repetitions,
        warmup_seconds: warmupSeconds,
        measurement_seconds: measurementSeconds,
        cold_starts: coldStarts,
        alternating_order: true,
      },
      samples,
      cold_start_samples: coldSamples,
      limitations: [
        'Synthetic single-host benchmark; not production traffic evidence.',
        'Ephemeral Mongo processes do not reproduce production storage or network latency.',
        'Task-create uses unique idempotency keys and controlled payloads.',
      ],
    };
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(outputPath, `${JSON.stringify(result, null, 2)}\n`);
    fs.writeFileSync(reportPath, renderReport(result));
    process.stdout.write(`Benchmark written to ${outputPath}\n`);
  } finally {
    for (const server of servers) await stopFixture(server);
    for (const database of databases.reverse()) await database.stop();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

await main();
