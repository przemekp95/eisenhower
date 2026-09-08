#!/usr/bin/env node

import { createHmac } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixtureServer = path.join(root, 'benchmarks/http-migration/fixture-server.mjs');
const hmacKey = 'rollback-calendar-hmac-key-at-least-32-bytes';
const token = 'benchmark-token';

function parseArguments(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const entry = argv[index];
    if (!entry.startsWith('--')) continue;
    const [name, inline] = entry.slice(2).split('=', 2);
    parsed[name] = inline ?? argv[++index];
  }
  return parsed;
}

function command(name, args, options = {}) {
  const completed = spawnSync(name, args, {
    cwd: options.cwd ?? root,
    encoding: 'utf8',
    stdio: options.capture ? 'pipe' : 'inherit',
    env: process.env,
  });
  if (completed.status !== 0) {
    throw new Error(`${name} ${args.join(' ')} failed: ${completed.stderr ?? ''}`);
  }
  return (completed.stdout ?? '').trim();
}

function prepareBaseline(sha, temporaryRoot) {
  const archive = path.join(temporaryRoot, 'baseline.tar');
  const source = path.join(temporaryRoot, 'baseline');
  fs.mkdirSync(source);
  command('git', ['archive', '--format=tar', '--output', archive, sha]);
  command('tar', ['-xf', archive, '-C', source]);
  const backend = path.join(source, 'backend-node');
  command('npm', ['ci', '--no-audit', '--no-fund'], { cwd: backend });
  command('npm', ['run', 'build'], { cwd: backend });
  return backend;
}

async function startFixture({ implementation, appRoot, mongoUri }) {
  const child = spawn(process.execPath, [
    fixtureServer,
    `--implementation=${implementation}`,
    `--app-root=${appRoot}`,
    `--mongo-uri=${mongoUri}`,
  ], {
    cwd: appRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CALENDAR_INTERNAL_HMAC_KEY: hmacKey },
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
  return { child, baseUrl: `http://127.0.0.1:${ready.port}`, stderr: () => stderr };
}

async function stopFixture(fixture) {
  if (!fixture || fixture.child.exitCode !== null) return fixture?.child.exitCode ?? 0;
  fixture.child.kill('SIGTERM');
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      fixture.child.kill('SIGKILL');
      resolve(137);
    }, 10_000);
    fixture.child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve(code ?? (signal ? 128 : 1));
    });
  });
}

async function jsonRequest(baseUrl, method, route, { body, headers = {}, statuses = [200] } = {}) {
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const raw = await response.text();
  const parsed = raw ? JSON.parse(raw) : null;
  if (!statuses.includes(response.status)) {
    throw new Error(`${method} ${route} returned ${response.status}: ${raw}`);
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

function internalHeaders(route, body, requestId) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const raw = JSON.stringify(body);
  const signature = createHmac('sha256', hmacKey)
    .update(`v1\n${timestamp}\n${requestId}\nPOST\n${route}\n${raw}`)
    .digest('hex');
  return {
    'X-Eisenhower-Timestamp': timestamp,
    'X-Eisenhower-Request-Id': requestId,
    'X-Eisenhower-Signature': signature,
  };
}

async function assertTask(baseUrl, taskId, revision) {
  const response = await jsonRequest(baseUrl, 'GET', `/tasks/${taskId}`);
  if (response.body._id !== taskId || response.body.revision !== revision) {
    throw new Error(`task mismatch: expected ${taskId}@${revision}, got ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

async function assertReplay(baseUrl, taskId) {
  const replay = await jsonRequest(baseUrl, 'POST', '/tasks', {
    body: { title: 'Rollback durable task', urgent: true },
    headers: { 'Idempotency-Key': 'rollback-task-create-0001' },
    statuses: [200],
  });
  if (replay.body._id !== taskId || replay.headers.get('idempotency-replayed') !== 'true') {
    throw new Error('task idempotency receipt did not replay');
  }
}

async function seedCalendar(db, ObjectId, taskId) {
  const now = new Date();
  const connectionId = new ObjectId();
  await db.collection('calendarconnections').insertOne({
    _id: connectionId,
    tenantId: 'local', ownerId: 'local-user', provider: 'google', calendarId: 'primary',
    credentialRef: 'rollback:credential', status: 'active', createdAt: now, updatedAt: now, __v: 0,
  });
  await db.collection('calendarbindings').insertOne({
    tenantId: 'local', ownerId: 'local-user', connectionId, taskId: new ObjectId(taskId),
    providerEventId: 'rollback-provider-event', providerEtag: 'rollback-etag-1',
    lastTaskRevision: 1, lastProviderRevision: 'rollback-etag-1',
    createdAt: now, updatedAt: now, __v: 0,
  });
  await db.collection('calendaroutboxes').insertOne({
    eventId: 'rollback-outbox-event-0001', tenantId: 'local', ownerId: 'local-user',
    aggregateId: taskId, aggregateRevision: 1, type: 'event_update',
    payload: { taskId, title: 'Rollback durable task' }, status: 'pending', attempts: 0,
    availableAt: new Date(now.getTime() - 1_000), createdAt: now, updatedAt: now, __v: 0,
  });
  return connectionId.toHexString();
}

async function calendarSnapshot(db, taskId) {
  const binding = await db.collection('calendarbindings').findOne({
    tenantId: 'local', ownerId: 'local-user',
  });
  const outbox = await db.collection('calendaroutboxes').findOne({ eventId: 'rollback-outbox-event-0001' });
  if (binding && String(binding.taskId) !== taskId) throw new Error('calendar binding task changed');
  return { binding, outbox };
}

function assertCalendar(snapshot, expectedStatus) {
  if (!snapshot.binding || snapshot.binding.providerEventId !== 'rollback-provider-event') {
    throw new Error('calendar binding was not preserved');
  }
  if (!snapshot.outbox || snapshot.outbox.status !== expectedStatus) {
    throw new Error(`outbox expected ${expectedStatus}, got ${snapshot.outbox?.status}`);
  }
}

function evidenceMarkdown(result) {
  return `# Node transport rollback rehearsal\n\n`
    + `Generated: ${new Date().toISOString()}\n\n`
    + `Baseline SHA: \`${result.baselineSha}\`\n\n`
    + `Candidate SHA: \`${result.candidateSha}\`\n\n`
    + `Shared database URI: \`${result.mongoUri}\`\n\n`
    + 'Migration commands: `none`\n\n'
    + 'Sequence: `Nest -> Express -> Nest`; processes were never concurrent.\n\n'
    + `Nest initial exit: \`${result.exits.nestInitial}\`\n\n`
    + `Express rollback exit: \`${result.exits.express}\`\n\n`
    + `Nest restored exit: \`${result.exits.nestRestored}\`\n\n`
    + 'Task revision before rollback: `1`\n\n'
    + 'Task revision written by Express: `2`\n\n'
    + 'Task revision after restore: `2`\n\n'
    + 'Idempotency replay across all phases: `passed`\n\n'
    + 'Calendar binding across all phases: `passed`\n\n'
    + 'Outbox lease survived rollback: `passed`\n\n'
    + 'Outbox reconciliation after restore: `delivered`\n\n'
    + 'No collection rewrite, schema transformation, import/export or destructive database command was run. '
    + 'The URI points only to an ephemeral local replica set and contains no credentials.\n\n'
    + 'Overall exit: `0`\n';
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const baselineSha = args['baseline-sha'];
  if (!/^[a-f0-9]{40}$/.test(baselineSha ?? '')) throw new Error('--baseline-sha must be a full SHA');
  const candidateSha = command('git', ['rev-parse', 'HEAD'], { capture: true });
  const output = path.resolve(root, args.output ?? 'docs/evidence/2026-08-23-node-transport-rollback.md');
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'eisenhower-rollback-'));
  const candidateRoot = path.join(root, 'backend-node');
  const requireCandidate = createRequire(path.join(candidateRoot, 'package.json'));
  const { MongoMemoryReplSet } = requireCandidate('mongodb-memory-server');
  const { MongoClient, ObjectId } = requireCandidate('mongodb');
  let replicaSet;
  let mongoClient;
  let fixture;
  const exits = {};
  try {
    const baselineRoot = prepareBaseline(baselineSha, temporaryRoot);
    command('npm', ['run', 'build'], { cwd: candidateRoot });
    replicaSet = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger' } });
    const mongoUri = replicaSet.getUri('rollback_transport');
    mongoClient = new MongoClient(mongoUri);
    await mongoClient.connect();
    const db = mongoClient.db();

    fixture = await startFixture({ implementation: 'nest-fastify', appRoot: candidateRoot, mongoUri });
    const created = await jsonRequest(fixture.baseUrl, 'POST', '/tasks', {
      body: { title: 'Rollback durable task', urgent: true },
      headers: { 'Idempotency-Key': 'rollback-task-create-0001' },
      statuses: [201],
    });
    const taskId = created.body._id;
    await assertReplay(fixture.baseUrl, taskId);
    const updated = await jsonRequest(fixture.baseUrl, 'PUT', `/tasks/${taskId}`, {
      body: { description: 'written before rollback' }, headers: { 'If-Match': '"0"' },
    });
    if (updated.body.revision !== 1) throw new Error('Nest did not write revision 1');
    const connectionId = await seedCalendar(db, ObjectId, taskId);
    const claimPath = '/internal/calendar/outbox/claim';
    const claimBody = {};
    const claimHeaders = internalHeaders(claimPath, claimBody, 'rollback-claim-request-0001');
    const claimed = await jsonRequest(fixture.baseUrl, 'POST', claimPath, {
      body: claimBody, headers: claimHeaders,
    });
    if (claimed.body.eventId !== 'rollback-outbox-event-0001' || !claimed.body.leaseId) {
      throw new Error('Nest did not lease the seeded outbox event');
    }
    assertCalendar(await calendarSnapshot(db, taskId), 'leased');
    exits.nestInitial = await stopFixture(fixture);
    fixture = null;

    fixture = await startFixture({ implementation: 'express', appRoot: baselineRoot, mongoUri });
    await assertTask(fixture.baseUrl, taskId, 1);
    await assertReplay(fixture.baseUrl, taskId);
    const replayedClaim = await jsonRequest(fixture.baseUrl, 'POST', claimPath, {
      body: claimBody, headers: claimHeaders,
    });
    if (JSON.stringify(replayedClaim.body) !== JSON.stringify(claimed.body)) {
      throw new Error('Express did not replay the Nest outbox receipt');
    }
    const expressWrite = await jsonRequest(fixture.baseUrl, 'PUT', `/tasks/${taskId}`, {
      body: { description: 'written by exact Express rollback' }, headers: { 'If-Match': '"1"' },
    });
    if (expressWrite.body.revision !== 2) throw new Error('Express did not write revision 2');
    assertCalendar(await calendarSnapshot(db, taskId), 'leased');
    exits.express = await stopFixture(fixture);
    fixture = null;

    fixture = await startFixture({ implementation: 'nest-fastify', appRoot: candidateRoot, mongoUri });
    await assertTask(fixture.baseUrl, taskId, 2);
    await assertReplay(fixture.baseUrl, taskId);
    const restoredClaim = await jsonRequest(fixture.baseUrl, 'POST', claimPath, {
      body: claimBody, headers: claimHeaders,
    });
    if (JSON.stringify(restoredClaim.body) !== JSON.stringify(claimed.body)) {
      throw new Error('restored Nest did not replay the durable outbox receipt');
    }
    assertCalendar(await calendarSnapshot(db, taskId), 'leased');
    const ackPath = '/internal/calendar/outbox/acknowledge';
    const ackBody = {
      eventId: claimed.body.eventId, leaseId: claimed.body.leaseId, delivered: true,
      connectionId, providerEventId: 'rollback-provider-event', providerEtag: 'rollback-etag-2',
    };
    const acknowledged = await jsonRequest(fixture.baseUrl, 'POST', ackPath, {
      body: ackBody,
      headers: internalHeaders(ackPath, ackBody, 'rollback-ack-request-000001'),
    });
    if (acknowledged.body.status !== 'delivered') throw new Error('Nest reconciliation did not deliver outbox');
    assertCalendar(await calendarSnapshot(db, taskId), 'delivered');
    exits.nestRestored = await stopFixture(fixture);
    fixture = null;
    if (Object.values(exits).some((code) => code !== 0)) {
      throw new Error(`transport process exit was not zero: ${JSON.stringify(exits)}`);
    }
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, evidenceMarkdown({ baselineSha, candidateSha, mongoUri, exits }));
    process.stdout.write(`Rollback evidence written to ${output}\n`);
  } finally {
    if (fixture) await stopFixture(fixture);
    if (mongoClient) await mongoClient.close();
    if (replicaSet) await replicaSet.stop();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error}\n`);
  process.exitCode = 1;
});
