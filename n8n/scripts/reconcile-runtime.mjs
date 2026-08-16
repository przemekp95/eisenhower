#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWLIST = [
  {
    file: 'async-rag-ingestion.json',
    id: 'b33131c8-057c-5c35-9c6d-cf9c8b825f23',
    group: 'rag',
  },
  {
    file: 'calendar-inbound.json',
    id: '071f5a26-7b5d-5aa1-9f5b-f49a37855151',
    group: 'calendar',
  },
  {
    file: 'calendar-outbound.json',
    id: '5941556e-b985-5e90-bc92-3d10f5335996',
    group: 'calendar',
  },
  {
    file: 'calendar-reconciliation.json',
    id: '49e68dfe-b1ac-5d91-89ab-45c27e491fbb',
    group: 'calendar',
  },
  {
    file: 'rag-ingestion-error.json',
    id: '8c1d0c2b-87bf-5c73-816c-c8b47f9ec863',
    group: 'rag',
  },
];

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
    );
  }
  return value;
}

export function workflowFingerprint(workflow) {
  const definition = {
    connections: workflow.connections ?? {},
    name: workflow.name,
    nodes: workflow.nodes ?? [],
    pinData: workflow.pinData ?? {},
    settings: workflow.settings ?? {},
    staticData: workflow.staticData ?? null,
  };
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(definition)))
    .digest('hex');
}

export async function loadDesiredWorkflows(workflowDir, { ragCredentialId, ragReady }) {
  if (ragReady && !ragCredentialId) {
    throw new Error('RAG Header Auth credential ID is required when RAG workflows are enabled');
  }
  return Promise.all(ALLOWLIST.map(async ({ file, group, id }) => {
    const definition = JSON.parse(await readFile(path.join(workflowDir, file), 'utf8'));
    if (definition.active !== false) {
      throw new Error(`${file} must remain inactive in source control`);
    }
    if (file === 'async-rag-ingestion.json') {
      definition.settings.errorWorkflow = ALLOWLIST.find(
        ({ file: candidate }) => candidate === 'rag-ingestion-error.json',
      ).id;
      if (ragReady) definition.nodes[0].credentials.httpHeaderAuth.id = ragCredentialId;
    }
    return {
      definition: { ...definition, active: false, id },
      desiredActive: group === 'calendar' || Boolean(ragReady),
      file,
      group,
      id,
    };
  }));
}

export function buildPlan(desired, current) {
  const plan = {
    activeDriftIds: [],
    deleteIds: [],
    importIds: [],
    publishIds: [],
    unpublishIds: [],
  };

  for (const target of desired) {
    const sameName = current.filter(({ name }) => name === target.definition.name);
    for (const duplicate of sameName.filter(({ id }) => id !== target.id)) {
      plan.deleteIds.push(duplicate.id);
    }

    const installed = current.find(({ id }) => id === target.id);
    const changed = !installed
      || workflowFingerprint(installed) !== workflowFingerprint(target.definition);

    if (installed?.active && changed) plan.activeDriftIds.push(target.id);
    if (changed) plan.importIds.push(target.id);

    if (changed) {
      if (installed?.active) plan.unpublishIds.push(target.id);
      if (target.desiredActive) plan.publishIds.push(target.id);
    } else if (Boolean(installed.active) !== target.desiredActive) {
      (target.desiredActive ? plan.publishIds : plan.unpublishIds).push(target.id);
    }
  }

  for (const key of Object.keys(plan)) plan[key] = [...new Set(plan[key])].sort();
  return plan;
}

function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith('--')) throw new Error(`Unexpected argument: ${argument}`);
    const [rawKey, inlineValue] = argument.slice(2).split('=', 2);
    if (inlineValue !== undefined) values[rawKey] = inlineValue;
    else values[rawKey] = argv[++index];
  }
  return values;
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  for (const required of ['workflows', 'current', 'output']) {
    if (!args[required]) throw new Error(`--${required} is required`);
  }

  const desired = await loadDesiredWorkflows(args.workflows, {
    ragCredentialId: args['rag-credential-id'],
    ragReady: args['rag-ready'] === 'true',
  });
  const exported = JSON.parse(await readFile(args.current, 'utf8'));
  const current = Array.isArray(exported) ? exported : [exported];
  const plan = buildPlan(desired, current);
  const imports = desired
    .filter(({ id }) => plan.importIds.includes(id))
    .map(({ definition }) => definition);

  await mkdir(args.output, { recursive: true });
  await writeFile(path.join(args.output, 'import.json'), `${JSON.stringify(imports)}\n`);
  await writeFile(path.join(args.output, 'plan.json'), `${JSON.stringify(plan, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(plan)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exitCode = 1;
  });
}
