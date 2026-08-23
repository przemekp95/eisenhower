#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const failures = [];
const requireBoundary = (condition, message) => {
  if (!condition) failures.push(message);
};

const nodeManifest = JSON.parse(read('backend-node/package.json'));
const declared = new Set(Object.keys({
  ...nodeManifest.dependencies,
  ...nodeManifest.devDependencies,
}));
for (const forbidden of [
  'express', 'express-validator', 'express-rate-limit', 'cors', 'helmet',
  '@types/express', '@types/cors', 'supertest', '@types/supertest',
]) {
  requireBoundary(!declared.has(forbidden), `backend-node still declares ${forbidden}`);
}

const nodeSource = fs.readdirSync(path.join(root, 'backend-node/src'), { recursive: true })
  .filter((name) => name.endsWith('.ts'))
  .map((name) => read(path.join('backend-node/src', name)))
  .join('\n');
requireBoundary(
  !/from ['"](?:express|cors|helmet|express-rate-limit|express-validator)['"]/.test(nodeSource),
  'backend-node source still imports an Express transport package',
);
requireBoundary(
  !fs.existsSync(path.join(root, 'backend-node/src/routes')),
  'legacy backend-node/src/routes still exists',
);

const routeContract = JSON.parse(read('backend-node/contracts/node-http-routes.json'));
const migrationMap = read('docs/architecture/node-http-migration-map.md');
requireBoundary(routeContract.length === 41, 'Node route contract must retain all 41 routes');
requireBoundary(
  (migrationMap.match(/\| nest-final \|/g) ?? []).length === 41,
  'every Node route must have exactly one nest-final owner',
);

const fastApiFacade = read('backend-ai/app/main.py');
requireBoundary(!fastApiFacade.includes('@app.'), 'app/main.py still owns FastAPI routes');
requireBoundary(!fastApiFacade.includes('build_dependencies('), 'app/main.py still composes providers');
requireBoundary(
  fastApiFacade.includes('from .http.factory import create_app'),
  'app/main.py does not re-export the canonical FastAPI factory',
);
requireBoundary(
  read('backend-ai/app/__init__.py').includes('from .http.factory import create_app'),
  'app.create_app does not resolve through the canonical FastAPI factory',
);
requireBoundary(
  read('backend-ai/main.py').includes('from app.http.factory import create_app'),
  'main.app does not use the canonical FastAPI factory',
);

const pythonRequirements = fs.readdirSync(path.join(root, 'backend-ai'))
  .filter((name) => name.startsWith('requirements') && name.endsWith('.txt'))
  .map((name) => read(path.join('backend-ai', name)))
  .join('\n');
requireBoundary(!/^\s*(?:django|flask)(?:[<=>~!]|\s|$)/im.test(pythonRequirements), 'Django or Flask was added');

const readme = read('README.md');
const securityReview = read('docs/ai-rebuild/security-review.md');
const methodology = read('docs/ai-rebuild/methodology-assessment.md');
requireBoundary(
  readme.includes('NestJS/Fastify API') && readme.includes('FastAPI AI/RAG service'),
  'README does not describe the final NestJS/Fastify and FastAPI boundary',
);
requireBoundary(
  readme.includes('n8n remains asynchronous-only'),
  'README does not preserve the asynchronous-only n8n boundary',
);
requireBoundary(
  securityReview.includes('NestJS/Fastify task API') && !securityReview.includes('Express task API'),
  'security review still describes Express as the active task API',
);
requireBoundary(
  methodology.includes('app/http/factory.py') && methodology.includes('app/main.py'),
  'methodology assessment does not record the modular FastAPI composition boundary',
);

const nodeDockerfile = read('backend-node/Dockerfile');
const aiDockerfile = read('backend-ai/Dockerfile');
const compose = read('compose.yaml');
requireBoundary(nodeDockerfile.includes("3001/health/ready"), 'Node image readiness path changed');
requireBoundary(aiDockerfile.includes('main:app'), 'FastAPI boundary image entrypoint changed');
requireBoundary(
  aiDockerfile.includes('app.knowledge_runtime:from_environment')
    && compose.includes('app.knowledge_runtime:from_environment'),
  'knowledge-only FastAPI factory path changed',
);

if (failures.length) {
  for (const failure of failures) process.stderr.write(`framework-boundary: ${failure}\n`);
  process.exit(1);
}
process.stdout.write('Framework boundaries verified: NestJS/Fastify + FastAPI, n8n async-only.\n');
