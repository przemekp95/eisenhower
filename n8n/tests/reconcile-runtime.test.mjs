import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildPlan,
  loadDesiredWorkflows,
  validateRagReadiness,
  workflowFingerprint,
} from '../scripts/reconcile-runtime.mjs';

const root = path.resolve(import.meta.dirname, '../..');
const workflowDir = path.join(root, 'n8n/workflows');

const readinessExpected = {
  collection: 'eisenhower-knowledge-v4-candidate',
  manifestSha256: 'a'.repeat(64),
  releaseSha: 'b'.repeat(40),
  responseCandidateId: 'response-task065-v1',
};

function readiness(overrides = {}) {
  return {
    schema_version: 'private-rag-live-readiness-v1',
    status: 'ready',
    checked_at: '2026-08-19T12:00:00Z',
    release_sha: readinessExpected.releaseSha,
    corpus_manifest_sha256: readinessExpected.manifestSha256,
    collection: {
      name: readinessExpected.collection,
      canonical_documents: 19,
      projection_points: 150,
      reconciled: true,
    },
    generator: {
      healthy: true,
      model: 'Qwen/Qwen3-4B-Instruct-2507',
      revision: 'cdbee75f17c01a7cc42f958dc650907174af0554',
    },
    reranker: {
      healthy: true,
      model: 'BAAI/bge-reranker-v2-m3',
      revision: '953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e',
    },
    response_candidate_id: readinessExpected.responseCandidateId,
    memory: { write: false, retrieval: false, response: false },
    mag_mode: 'disabled',
    public_release: false,
    ...overrides,
  };
}

test('allowlist gives stable identities and enables only Calendar by default', async () => {
  const first = await loadDesiredWorkflows(workflowDir, {});
  const second = await loadDesiredWorkflows(workflowDir, {});

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

  const compose = await readFile(path.join(root, 'compose.yaml'), 'utf8');
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

test('RAG activation requires a verified live readiness receipt and credential', async () => {
  await assert.rejects(
    loadDesiredWorkflows(workflowDir, {
      ragReadiness: readiness(),
      readinessExpected,
    }),
    /RAG Header Auth credential ID is required/,
  );
  const desired = await loadDesiredWorkflows(workflowDir, {
    ragCredentialId: 'runtime-header-auth-id',
    ragReadiness: readiness(),
    readinessExpected,
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

test('boolean readiness and identity drift fail closed', async () => {
  assert.throws(
    () => validateRagReadiness(true, readinessExpected),
    /receipt must be an object/,
  );
  assert.throws(
    () => validateRagReadiness(
      readiness({ release_sha: 'c'.repeat(40) }),
      readinessExpected,
    ),
    /release SHA mismatch/,
  );
  assert.throws(
    () => validateRagReadiness(
      readiness({ memory: { write: false, retrieval: true, response: false } }),
      readinessExpected,
    ),
    /memory must remain disabled/,
  );
});

test('runtime rehearsal supports runner UIDs that are absent from the image passwd file', async () => {
  const rehearsal = await readFile(
    path.join(root, 'n8n/scripts/rehearse-runtime.sh'),
    'utf8',
  );
  const containerReconcile = await readFile(
    path.join(root, 'n8n/scripts/reconcile-runtime-container.sh'),
    'utf8',
  );

  assert.equal(rehearsal.match(/-e HOME=\/tmp/g)?.length, 3);
  assert.equal(rehearsal.match(/-e N8N_USER_FOLDER=\/reconcile/g)?.length, 3);
  assert.doesNotMatch(rehearsal, /:\/home\/node\/\.n8n/);
  assert.match(containerReconcile, /\$N8N_USER_FOLDER\/\.n8n\/database\.sqlite/);
  assert.match(containerReconcile, /database_path=\/home\/node\/\.n8n\/database\.sqlite/);
  assert.match(containerReconcile, /rag-readiness-receipt/);
  assert.match(containerReconcile, /RAG_CORPUS_MANIFEST_SHA256/);
  assert.doesNotMatch(containerReconcile, /--rag-ready(?:\s|$)/m);
});

test('credential import uses a private temporary file and verifies the encrypted record', async () => {
  const importer = await readFile(
    path.join(root, 'n8n/scripts/import-rag-credential.sh'),
    'utf8',
  );

  assert.match(importer, /umask 077/);
  assert.match(importer, /mktemp -d/);
  assert.match(importer, /n8n import:credentials/);
  assert.match(importer, /verify-runtime-credential\.cjs/);
  assert.doesNotMatch(importer, /set -x/);
});

test('plan detects active drift, removes same-name duplicates, and converges', async () => {
  const desired = await loadDesiredWorkflows(workflowDir, {});
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
  const desired = await loadDesiredWorkflows(workflowDir, {});
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
