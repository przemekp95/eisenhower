import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPlan,
  loadDesiredWorkflows,
  workflowFingerprint,
} from '../scripts/reconcile-runtime.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const workflowDir = path.join(root, 'n8n/workflows');

test('allowlist gives stable identities and enables only Calendar by default', async () => {
  const first = await loadDesiredWorkflows(workflowDir, { ragReady: false });
  const second = await loadDesiredWorkflows(workflowDir, { ragReady: false });

  assert.equal(first.length, 5);
  assert.deepEqual(first.map(({ id }) => id), second.map(({ id }) => id));
  assert.equal(new Set(first.map(({ id }) => id)).size, first.length);
  assert.deepEqual(
    first.filter(({ desiredActive }) => desiredActive).map(({ file }) => file).sort(),
    ['calendar-inbound.json', 'calendar-outbound.json', 'calendar-reconciliation.json'],
  );
  assert.deepEqual(
    first.filter(({ file }) => file.startsWith('rag-') || file.startsWith('async-rag'))
      .map(({ desiredActive }) => desiredActive),
    [false, false],
  );

  const compose = await readFile(path.join(root, 'deploy/local/compose.yaml'), 'utf8');
  assert.match(compose, /EISENHOWER_INTERNAL_API_URL[^\n]*api-service:3001/);
  assert.match(compose, /EISENHOWER_NODE_INTERNAL_API_URL[^\n]*api-service:3001/);
  assert.match(
    compose,
    /EISENHOWER_KNOWLEDGE_INTERNAL_API_URL[^\n]*knowledge-service:8000/,
  );
  const ingestion = first.find(({ file }) => file === 'async-rag-ingestion.json');
  assert.match(
    JSON.stringify(ingestion.definition),
    /EISENHOWER_KNOWLEDGE_INTERNAL_API_URL/,
  );
});

test('RAG activation remains behind an explicit ready gate', async () => {
  await assert.rejects(
    loadDesiredWorkflows(workflowDir, { ragReady: true }),
    /RAG Header Auth credential ID is required/,
  );
  const desired = await loadDesiredWorkflows(workflowDir, {
    ragCredentialId: 'runtime-header-auth-id',
    ragReady: true,
  });
  assert.deepEqual(
    desired.filter(({ file }) => file.startsWith('rag-') || file.startsWith('async-rag'))
      .map(({ desiredActive }) => desiredActive),
    [true, true],
  );
  const ingestion = desired.find(({ file }) => file === 'async-rag-ingestion.json');
  assert.equal(
    ingestion.definition.nodes[0].credentials.httpHeaderAuth.id,
    'runtime-header-auth-id',
  );
  assert.equal(
    ingestion.definition.settings.errorWorkflow,
    '8c1d0c2b-87bf-5c73-816c-c8b47f9ec863',
  );
});

test('plan detects active drift, removes same-name duplicates, and converges', async () => {
  const desired = await loadDesiredWorkflows(workflowDir, { ragReady: false });
  const canonical = desired[0];
  const drifted = structuredClone(canonical.definition);
  drifted.nodes[0].name = 'operator drift';
  const unchanged = desired[1];
  const current = [
    { ...drifted, id: canonical.id, active: true },
    { ...canonical.definition, id: 'stale-duplicate', active: false },
    { ...unchanged.definition, id: unchanged.id, active: unchanged.desiredActive },
  ];

  const plan = buildPlan(desired, current);
  assert.deepEqual(plan.deleteIds, ['stale-duplicate']);
  assert.deepEqual(plan.activeDriftIds, [canonical.id]);
  assert.ok(plan.importIds.includes(canonical.id));
  assert.ok(!plan.importIds.includes(unchanged.id));
});

test('plan is a no-op after definitions and publication state converge', async () => {
  const desired = await loadDesiredWorkflows(workflowDir, { ragReady: false });
  const current = desired.map(({ definition, id, desiredActive }) => ({
    ...structuredClone(definition), id, active: desiredActive,
  }));

  const plan = buildPlan(desired, current);
  assert.deepEqual(plan, {
    activeDriftIds: [],
    deleteIds: [],
    importIds: [],
    publishIds: [],
    unpublishIds: [],
  });
  assert.equal(
    workflowFingerprint(current[0]),
    workflowFingerprint(desired[0].definition),
  );
});
