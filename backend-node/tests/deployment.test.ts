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
      IMAGE_TAG: 'a'.repeat(40),
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
      APP_ENV: 'production',
      AUTH_MODE: 'static',
      EISENHOWER_API_TOKEN: environment.EISENHOWER_API_TOKEN,
      EISENHOWER_ADMIN_TOKEN: environment.EISENHOWER_ADMIN_TOKEN,
      AUDIT_HMAC_KEY: environment.AUDIT_HMAC_KEY,
      AUDIT_DATABASE_PATH: '/app/audit/ai-boundary.sqlite3',
      CLASSIFIER_SERVICE_URL: environment.KNOWLEDGE_SERVICE_BASE_URL,
      KNOWLEDGE_SERVICE_URL: environment.KNOWLEDGE_SERVICE_BASE_URL,
      AI_ROLE_ALLOWED_HOSTS: environment.KNOWLEDGE_SERVICE_ALLOWED_HOSTS,
      CORS_ALLOW_ORIGINS: environment.CORS_ALLOW_ORIGINS,
      RELEASE_SHA: environment.IMAGE_TAG,
    });
    expect(JSON.stringify(rendered.services['ai-service'].volumes)).toContain('/app/audit');
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
    expect(aiBlock).toContain('CLASSIFIER_SERVICE_URL:');
    expect(aiBlock).toContain('KNOWLEDGE_SERVICE_URL:');
    expect(aiBlock).toContain('AI_ROLE_ALLOWED_HOSTS:');
    expect(aiBlock).toContain('/health/live');
    expect(aiBlock).not.toMatch(/LOCAL_MODEL|TRAINING_DATA|TESSERACT|QDRANT/);
  });

  it('bounds MongoDB cache and container resources on the small Mikrus host', () => {
    const compose = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/docker-compose.yml'),
      'utf8'
    );
    const mongoBlock = compose.slice(compose.indexOf('  mongodb:'), compose.indexOf('  ai-service:'));

    expect(mongoBlock).toContain('--wiredTigerCacheSizeGB');
    expect(mongoBlock).toContain('${MONGODB_CACHE_SIZE_GB:-0.25}');
    expect(mongoBlock).toContain('mem_limit: ${MONGODB_MEMORY_LIMIT:-1g}');
    expect(mongoBlock).toContain('cpus: ${MONGODB_CPUS:-1.0}');
    expect(mongoBlock).toContain('pids_limit: 512');
  });

  it('keeps the Mikrus core web and API bootable when optional AI is unavailable', () => {
    const compose = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/mikrus/docker-compose.yml'),
      'utf8'
    );
    const deployScript = fs.readFileSync(
      path.join(repositoryRoot, '.github/scripts/deploy-mikrus.sh'),
      'utf8'
    );
    const apiBlock = compose.slice(compose.indexOf('  api-service:'), compose.indexOf('  frontend:'));
    const frontendBlock = compose.slice(compose.indexOf('  frontend:'), compose.indexOf('  prometheus:'));
    const prometheusBlock = compose.slice(compose.indexOf('  prometheus:'), compose.indexOf('\nvolumes:'));
    const apiDependencies = apiBlock.slice(apiBlock.indexOf('    depends_on:'), apiBlock.indexOf('    expose:'));
    const frontendDependencies = frontendBlock.slice(
      frontendBlock.indexOf('    depends_on:'),
      frontendBlock.indexOf('    ports:'),
    );

    expect(apiDependencies).toContain('mongodb:');
    expect(apiDependencies).not.toContain('ai-service:');
    expect(frontendDependencies).toContain('api-service:');
    expect(frontendDependencies).not.toContain('ai-service:');
    expect(prometheusBlock).not.toContain('depends_on:');
    expect(deployScript).toContain('for service in mongodb api-service frontend prometheus; do');
    expect(deployScript).toContain('if ./assert-http-status.sh "$MIKRUS_PUBLIC_URL/ai/health/ready" 200; then');
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
    expect(release).not.toContain('workflow_run:');
    expect(release).toContain('workflow_dispatch:');
    expect(release).toContain('release_sha:');
    expect(release).toContain("github.event.inputs.deploy == 'true'");
    expect(release).toContain('IMAGE_TAG: ${{ inputs.release_sha }}');
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

  it('blocks publication until every complete release image passes an all-severity scan', () => {
    const release = fs.readFileSync(
      path.join(repositoryRoot, '.github/workflows/release.yml'),
      'utf8'
    );
    const dockerRelease = release.slice(
      release.indexOf('  docker-release:'),
      release.indexOf('  android-release:')
    );

    for (const [name, target] of [
      ['backend-ai-boundary', 'boundary'],
      ['backend-ai-classifier', 'classifier'],
      ['backend-ai-knowledge', 'knowledge'],
      ['backend-ai-ingest', 'ingest'],
      ['backend-node', 'production'],
      ['web', 'production'],
    ]) {
      expect(dockerRelease).toMatch(new RegExp(`- name: ${name}[\\s\\S]*?target: ${target}`));
    }
    expect(dockerRelease).toContain('target: ${{ matrix.target }}');
    expect(dockerRelease).toMatch(/- name: Build image[\s\S]*?load:\s*true/);
    expect(dockerRelease).toMatch(/- name: Build image[\s\S]*?push:\s*false/);
    expect(dockerRelease).toMatch(/TRIVY_IMAGE:\s*aquasec\/trivy:[^\s]+@sha256:[a-f0-9]{64}/);
    expect(dockerRelease).toMatch(/- name: Scan complete image for vulnerabilities/);
    expect(dockerRelease).toContain('--severity LOW,MEDIUM,HIGH,CRITICAL');
    expect(dockerRelease).toContain('--exit-code 1');
    expect(dockerRelease).not.toContain('--ignore-unfixed');
    expect(dockerRelease).toMatch(/- name: Generate image SBOM[\s\S]*?--format cyclonedx/);
    expect(dockerRelease).toMatch(/- name: Verify role-specific SBOM coverage/);
    expect(dockerRelease).toContain('REQUIRE_TORCH: ${{ matrix.require_torch }}');
    expect(dockerRelease).toContain('REQUIRE_TORCHVISION: ${{ matrix.require_torchvision }}');
    expect(dockerRelease).toContain('--arg version "2.13.0+cpu"');
    expect(dockerRelease).toContain('--arg version "0.28.0+cpu"');
    expect(dockerRelease).toMatch(/- name: Verify image security evidence[\s\S]*?\.trivy\.json[\s\S]*?\.cdx\.json/);
    expect(dockerRelease).toMatch(/- name: Preserve image security evidence\n\s+if: \$\{\{ always\(\)/);
    expect(dockerRelease).toMatch(/if-no-files-found:\s*error/);
    expect(dockerRelease).toMatch(/- name: Publish verified image\n\s+if: \$\{\{ success\(\) \}\}/);

    const buildAt = dockerRelease.indexOf('- name: Build image');
    const scanAt = dockerRelease.indexOf('- name: Scan complete image for vulnerabilities');
    const sbomAt = dockerRelease.indexOf('- name: Generate image SBOM');
    const publishAt = dockerRelease.indexOf('- name: Publish verified image');
    expect(scanAt).toBeGreaterThan(buildAt);
    expect(sbomAt).toBeGreaterThan(scanAt);
    expect(publishAt).toBeGreaterThan(sbomAt);
  });

  it('builds production runtimes from digest-pinned, scanner-visible Wolfi packages', () => {
    const aiDockerfile = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/Dockerfile'),
      'utf8'
    );
    const nodeDockerfile = fs.readFileSync(
      path.join(repositoryRoot, 'backend-node/Dockerfile'),
      'utf8'
    );
    const extractionAdapter = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/app/document_extraction/adapters.py'),
      'utf8'
    );
    const corpusManifest = JSON.parse(fs.readFileSync(
      path.join(repositoryRoot, 'docs/ai-rebuild/corpus-manifest-v1.json'),
      'utf8'
    ));
    const compose = fs.readFileSync(path.join(repositoryRoot, 'docker-compose.yml'), 'utf8');

    const wolfiDigest = 'cgr.dev/chainguard/wolfi-base@sha256:0a8fd427de5882aed77471b0a432c3675eda6b6a0ae952b5d640b46da628cdbe';

    expect(aiDockerfile).toContain(`FROM ${wolfiDigest} AS python-builder`);
    expect(aiDockerfile).toContain(`FROM ${wolfiDigest} AS runtime-base`);
    expect(aiDockerfile).toContain('python-3.11=3.11.16-r1');
    expect(aiDockerfile).toContain('py3.11-pip=26.2.1-r0');
    expect(aiDockerfile).not.toContain('python:3.11-slim');
    expect(aiDockerfile).not.toContain('apt-get');
    expect(aiDockerfile.match(/tesseract-eng=5\.5\.2-r8/g)).toHaveLength(2);
    expect(aiDockerfile.match(/tesseract-osd=5\.5\.2-r8/g)).toHaveLength(2);
    expect(aiDockerfile.match(/tesseract-pol=5\.5\.2-r8/g)).toHaveLength(2);
    expect(extractionAdapter).toContain('TESSERACT_CLI_VERSION = "5.5.2"');
    expect(corpusManifest.document_policy.parser_runtime.tesseract_cli_version).toBe('5.5.2');
    expect(aiDockerfile).toContain('FROM runtime-base AS boundary');
    expect(aiDockerfile).toContain('FROM runtime-base AS classifier');
    expect(aiDockerfile).toContain('FROM runtime-base AS knowledge');
    expect(aiDockerfile).toContain('FROM runtime-base AS ingest');
    expect(aiDockerfile).toContain('COPY --from=dependencies-boundary /opt/python /opt/python');
    expect(aiDockerfile).toContain('COPY --from=dependencies-classifier /opt/python /opt/python');
    expect(aiDockerfile).toContain('COPY --from=dependencies-knowledge /opt/python /opt/python');
    expect(aiDockerfile).toContain('COPY --from=dependencies-ingest /opt/python /opt/python');

    expect(nodeDockerfile).toContain(`FROM ${wolfiDigest} AS build`);
    expect(nodeDockerfile).toContain(`FROM ${wolfiDigest} AS production`);
    expect(nodeDockerfile).toContain('nodejs-24=24.19.0-r0');
    expect(nodeDockerfile).toContain('nodejs-24-minimal=24.19.0-r0');
    expect(nodeDockerfile).not.toContain('node:20-alpine');
    expect(nodeDockerfile).not.toContain('curl');
    expect(nodeDockerfile).toMatch(/HEALTHCHECK[^\n]*\n\s+CMD \["node", "-e",/);
    expect(compose).not.toContain('["CMD", "curl", "-f", "http://127.0.0.1:3001/health"]');
    expect(compose).toContain('["CMD", "node", "-e", "fetch(\'http://127.0.0.1:3001/health/ready\')');

    const nodeProduction = nodeDockerfile.slice(
      nodeDockerfile.indexOf(`FROM ${wolfiDigest} AS production`),
      nodeDockerfile.indexOf('# Development stage')
    );
    expect(nodeProduction).not.toMatch(/\bnpm\b/);
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

  it('builds isolated AI roles from their declared dependency stages', () => {
    const dockerfile = fs.readFileSync(path.join(repositoryRoot, 'backend-ai/Dockerfile'), 'utf8');
    const productionRequirements = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/requirements.txt'),
      'utf8'
    );
    const boundaryRequirements = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/requirements-boundary.txt'),
      'utf8'
    );
    const knowledgeRequirements = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/requirements-knowledge.txt'),
      'utf8'
    );
    const experimentalRequirements = fs.readFileSync(
      path.join(repositoryRoot, 'backend-ai/requirements-experimental.txt'),
      'utf8'
    );

    expect(dockerfile).toContain('FROM requirements-source AS dependencies-boundary');
    expect(dockerfile).toContain('FROM dependencies-boundary AS dependencies-ml');
    expect(dockerfile).toContain('FROM dependencies-ml AS dependencies-classifier');
    expect(dockerfile).toContain('FROM dependencies-ml AS dependencies-knowledge');
    expect(dockerfile).toContain('FROM dependencies-knowledge AS dependencies-ingest');
    expect(dockerfile).not.toMatch(/(?:FROM|--from=) dependencies(?:\s|$)/);
    expect(productionRequirements).toContain('-r requirements-ingest.txt');
    expect(knowledgeRequirements).toContain('qdrant-client==1.19.0');
    expect(knowledgeRequirements).toContain('llama-index-core==0.14.23');
    expect(boundaryRequirements).not.toMatch(/qdrant|llama-index|torch/);
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
