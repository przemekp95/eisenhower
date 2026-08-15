import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { loadConfig } from '../src/config';

const repositoryRoot = path.resolve(__dirname, '../..');
const execFileAsync = promisify(execFile);

describe('production deployment boundaries', () => {
  it('renders a bootable static single-tenant API environment for Mikrus', async () => {
    const composeFile = path.join(repositoryRoot, 'deploy/mikrus/docker-compose.yml');
    const environment = {
      ...process.env,
      DOCKER_HUB_USERNAME: 'example',
      IMAGE_TAG: 'sha256-test',
      EISENHOWER_API_TOKEN: 'production-api-token-at-least-32-characters',
      EISENHOWER_ADMIN_TOKEN: 'production-admin-token-at-least-32-characters',
      CORS_ALLOW_ORIGINS: 'https://tasks.example.com',
      LOCAL_MODEL_APPROVED_EVALUATION_SHA256: '0'.repeat(64),
      AI_EVALUATION_FILE: '/tmp/production-evaluation.json',
      AUDIT_HMAC_KEY: 'audit-hmac-key-at-least-32-characters',
      KNOWLEDGE_SERVICE_BASE_URL: 'http://knowledge.internal:8000',
      KNOWLEDGE_SERVICE_ALLOWED_HOSTS: 'knowledge.internal',
    };
    const { stdout } = await execFileAsync(
      'docker',
      ['compose', '-f', composeFile, 'config', '--format', 'json'],
      { cwd: repositoryRoot, env: environment }
    );
    const rendered = JSON.parse(stdout) as {
      services: {
        'api-service': { environment: Record<string, string>; volumes: unknown[] };
        'ai-service': { environment: Record<string, string>; volumes?: unknown[] };
      };
    };
    const apiEnvironment = rendered.services['api-service'].environment;

    expect(apiEnvironment).toMatchObject({
      NODE_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: environment.EISENHOWER_API_TOKEN,
      AUDIT_HMAC_KEY: environment.AUDIT_HMAC_KEY,
      AUDIT_LOG_PATH: '/app/audit/node-audit.ndjson',
      RELEASE_SHA: environment.IMAGE_TAG,
    });
    expect(() => loadConfig(apiEnvironment)).not.toThrow();
    expect(rendered.services['ai-service'].environment).toMatchObject({
      KNOWLEDGE_SERVICE_BASE_URL: environment.KNOWLEDGE_SERVICE_BASE_URL,
      KNOWLEDGE_SERVICE_ALLOWED_HOSTS: environment.KNOWLEDGE_SERVICE_ALLOWED_HOSTS,
      CORS_ALLOW_ORIGINS: environment.CORS_ALLOW_ORIGINS,
    });
    expect(rendered.services['ai-service'].volumes).toBeUndefined();
    expect(JSON.stringify(rendered.services['api-service'].volumes)).toContain('/app/audit');
  });

  it('does not publish backend service ports from the Mikrus compose file', () => {
    const compose = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/docker-compose.yml'),
      'utf8'
    );

    const aiBlock = compose.slice(compose.indexOf('  ai-service:'), compose.indexOf('  api-service:'));
    const apiBlock = compose.slice(compose.indexOf('  api-service:'), compose.indexOf('  frontend:'));

    expect(aiBlock).not.toMatch(/^\s+ports:/m);
    expect(apiBlock).not.toMatch(/^\s+ports:/m);
    expect(compose).toMatch(/\$\{WEB_PORT:-8080\}:3000/);
    expect(aiBlock).toContain('eisenhower-ai-boundary');
    expect(aiBlock).toContain('KNOWLEDGE_SERVICE_BASE_URL:');
    expect(aiBlock).toContain('KNOWLEDGE_SERVICE_ALLOWED_HOSTS:');
    expect(aiBlock).not.toMatch(/LOCAL_MODEL|TRAINING_DATA|TESSERACT|QDRANT/);
  });

  it('activates private same-SHA metrics scraping and bounded alert rules on Mikrus', () => {
    const compose = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/docker-compose.yml'), 'utf8'
    );
    const prometheus = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/prometheus.yml'), 'utf8'
    );
    const alerts = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/alert_rules.yml'), 'utf8'
    );
    const deployScript = fs.readFileSync(
      path.join(repositoryRoot, '.github/scripts/deploy-mikrus.sh'), 'utf8'
    );

    expect(compose).toMatch(/prom\/prometheus:[^\s]+@sha256:[a-f0-9]{64}/);
    expect(compose).not.toMatch(/prometheus:[\s\S]*?ports:/);
    expect(prometheus).toContain("targets: ['ai-service:8000']");
    expect(alerts).toContain('EisenhowerKnowledgeServiceDown');
    expect(alerts).not.toContain('eisenhower_rag_');
    expect(deployScript).toContain('eisenhower_release_info{sha=');
  });

  it('keeps deploy ownership fail-closed and has no demo-fortis target', () => {
    const deployScript = fs.readFileSync(
      path.join(repositoryRoot, '.github/scripts/deploy-mikrus.sh'),
      'utf8'
    );

    expect(deployScript).not.toContain('demo-fortis');
    expect(deployScript).toContain('.eisenhower-deployment');
    expect(deployScript).toContain('MIKRUS_APP_DIR');
  });

  it('uses immutable release tags and rolls back a failed readiness or public smoke check', () => {
    const deployScript = fs.readFileSync(
      path.join(repositoryRoot, '.github/scripts/deploy-mikrus.sh'),
      'utf8'
    );
    const compose = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/docker-compose.yml'),
      'utf8'
    );
    const release = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/release.yml'),
      'utf8'
    );

    expect(compose).toContain(':${IMAGE_TAG:?IMAGE_TAG is required}');
    expect(compose).not.toContain(':latest');
    expect(release).toContain("github.event.workflow_run.conclusion == 'success'");
    expect(release).toContain('IMAGE_TAG: ${{ github.event.workflow_run.head_sha }}');
    expect(release).toContain("format('{0}/{1}:{2}', env.DOCKER_HUB_USERNAME, matrix.tag, env.RELEASE_SHA)");
    expect(release).toMatch(/deploy-mikrus:[\s\S]*?needs:\s*docker-release/);
    expect(release).not.toMatch(/deploy-mikrus:[\s\S]*?needs:\s*\[docker-release, android-release\]/);
    expect(deployScript).toContain('MIKRUS_PUBLIC_URL');
    expect(deployScript).toContain('rollback_deployment');
    expect(deployScript).toContain('/health');
    expect(deployScript).toContain('/api/health');
    expect(deployScript).toContain('./assert-http-status.sh "$MIKRUS_PUBLIC_URL/health" 200');
    expect(deployScript).toContain('./assert-http-status.sh "$MIKRUS_PUBLIC_URL/ai/health/ready" 200');
    expect(deployScript).not.toMatch(/curl --fail[^\n]*MIKRUS_PUBLIC_URL/);
  });

  it('accepts only the exact public HTTP status and rejects a redirect to a success page', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(301, { Location: '/ok' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' });
      response.end('ok');
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const checkScript = path.join(repositoryRoot, '.github/scripts/assert-http-status.sh');
    const environment = { ...process.env, ALLOW_INSECURE_HTTP_FOR_TESTS: '1' };

    try {
      await expect(execFileAsync(checkScript, [`http://127.0.0.1:${address.port}/ok`, '200'], {
        env: environment,
      })).resolves.toBeDefined();
      await expect(execFileAsync(checkScript, [`http://127.0.0.1:${address.port}/redirect`, '200'], {
        env: environment,
      })).rejects.toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps experimental infrastructure isolated from the supported runtime', () => {
    const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');
    const envExample = fs.readFileSync(path.join(repositoryRoot, '.env.example'), 'utf8');

    const aiBlock = compose.slice(compose.indexOf('  ai-service:'), compose.indexOf('  rag-worker:'));
    const redisBlock = compose.slice(compose.indexOf('\n  redis:'), compose.indexOf('\n  qdrant:'));
    const qdrantBlock = compose.slice(compose.indexOf('  qdrant:'), compose.indexOf('  minio:'));
    const minioBlock = compose.slice(compose.indexOf('  minio:'), compose.indexOf('  nginx:'));

    expect(aiBlock).toContain('RAG_ENABLED=${RAG_ENABLED:-false}');
    expect(aiBlock).toContain('QDRANT_URL=http://qdrant:6333');
    expect(aiBlock).toContain('INFERENCE_BASE_URL=${INFERENCE_BASE_URL:-http://inference:8000/v1}');
    expect(redisBlock).toContain('profiles:');
    expect(redisBlock).toContain('- cache');
    expect(compose).not.toContain('driver: nvidia');
    expect(aiBlock).not.toContain('MINIO_');
    expect(qdrantBlock).toMatch(/profiles:\n\s+- experimental\n\s+- rag/);
    expect(minioBlock).toMatch(/profiles:\n\s+- experimental/);
    expect(compose).toContain('${GRAFANA_ADMIN_USER:?GRAFANA_ADMIN_USER is required}');
    expect(compose).toContain('${GRAFANA_ADMIN_PASSWORD:?GRAFANA_ADMIN_PASSWORD is required}');
    expect(compose).not.toContain('StrongPassword123!');
    expect(compose).not.toContain('GF_SECURITY_ADMIN_PASSWORD: admin');
    expect(envExample).toContain('MINIO_ROOT_USER=');
    expect(envExample).toContain('MINIO_ROOT_PASSWORD=');
    expect(envExample).toContain('GRAFANA_ADMIN_USER=');
    expect(envExample).toContain('GRAFANA_ADMIN_PASSWORD=');
  });

  it('builds AI runtime stages from the declared CPU dependency stage', () => {
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'backend-ai/Dockerfile'), 'utf8');
    const productionRequirements = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/requirements.txt'),
      'utf8'
    );
    const experimentalRequirements = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/requirements-experimental.txt'),
      'utf8'
    );

    expect(dockerfile).toContain('FROM base AS dependencies-cpu');
    expect(dockerfile).toContain('COPY --from=dependencies-cpu');
    expect(dockerfile).toContain('FROM dependencies-cpu AS development');
    expect(dockerfile).not.toMatch(/(?:FROM|--from=) dependencies(?:\s|$)/);
    expect(productionRequirements).toContain('qdrant-client');
    expect(productionRequirements).not.toMatch(/minio|langchain/);
    expect(productionRequirements).not.toMatch(/pytest|pylint|pip-audit/);
    expect(experimentalRequirements).toContain('-r requirements.txt');
    expect(experimentalRequirements).toMatch(/qdrant|minio|langchain/);
  });

  it('provides checksum-verified backup and confirmation-gated restore tooling', () => {
    const backup = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/backup.sh'),
      'utf8'
    );
    const restore = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/restore.sh'),
      'utf8'
    );

    expect(backup).toContain('mongodump --archive --gzip');
    expect(backup).toContain('sha256sum');
    expect(restore).toContain('RESTORE_CONFIRM');
    expect(restore).toContain('sha256sum --check');
    expect(restore).toContain('mongorestore --drop --archive --gzip');
  });
});
