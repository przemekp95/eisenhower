import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { CONTRACT_CASES } from '../tests/contract-harness/cases';
import { createExpressTarget } from '../tests/contract-harness/express-target';
import { normalizeResponse } from '../tests/contract-harness/normalizers';
import { ContractFixture } from '../tests/contract-harness/types';

const BASELINE_SHA = '5db1983da7f4e583a133f42d6b4a95ac8b3ab9c9';
const backendRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(backendRoot, '..');
const contractsDirectory = path.join(backendRoot, 'contracts');

function assertOracleDidNotDrift() {
  const changedSources = execFileSync('git', [
    'diff', '--name-only', BASELINE_SHA, '--', 'backend-node/src',
  ], { cwd: repositoryRoot, encoding: 'utf8' }).trim();
  if (changedSources) throw new Error(`Express baseline sources drifted:\n${changedSources}`);

  const baselinePackage = JSON.parse(execFileSync(
    'git', ['show', `${BASELINE_SHA}:backend-node/package.json`],
    { cwd: repositoryRoot, encoding: 'utf8' },
  )) as { dependencies?: unknown; devDependencies?: unknown };
  const currentPackage = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8')) as {
    dependencies?: unknown; devDependencies?: unknown;
  };
  for (const field of ['dependencies', 'devDependencies'] as const) {
    if (JSON.stringify(currentPackage[field]) !== JSON.stringify(baselinePackage[field])) {
      throw new Error(`Express baseline ${field} drifted.`);
    }
  }
}

async function main() {
  assertOracleDidNotDrift();
  fs.mkdirSync(contractsDirectory, { recursive: true });
  const routes = CONTRACT_CASES.map(({ route }) => route)
    .sort((left, right) => `${left.method} ${left.path}`.localeCompare(`${right.method} ${right.path}`));
  fs.writeFileSync(
    path.join(contractsDirectory, 'node-http-routes.json'),
    `${JSON.stringify(routes, null, 2)}\n`,
  );

  const target = await createExpressTarget();
  const fixture: ContractFixture = {
    baselineSha: BASELINE_SHA,
    nodeVersion: process.version,
    cases: [],
  };
  try {
    for (const contractCase of CONTRACT_CASES) {
      await target.reset();
      const response = normalizeResponse(
        await target.request(contractCase.request),
        contractCase.normalization,
      );
      fixture.cases.push({
        id: contractCase.request.id,
        routeKey: `${contractCase.route.method} ${contractCase.route.path}`,
        request: contractCase.request,
        response,
      });
    }
  } finally {
    await target.close();
  }
  fs.writeFileSync(
    path.join(contractsDirectory, 'express-5db1983-contract.json'),
    `${JSON.stringify(fixture, null, 2)}\n`,
  );
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
