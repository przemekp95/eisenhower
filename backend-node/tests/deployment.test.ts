import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const repositoryRoot = path.resolve(__dirname, '../..');
const execFileAsync = promisify(execFile);

describe('host-neutral deployment and release boundaries', () => {
  it('keeps one canonical ingress and explicit fail-closed environment contracts', () => {
    const compose = fs.readFileSync(path.join(repositoryRoot, 'compose.yaml'), 'utf8');
    const gateway = fs.readFileSync(
      path.join(repositoryRoot, 'deploy/local/access-gateway.conf.template'), 'utf8',
    );

    expect(fs.existsSync(path.join(repositoryRoot, 'docker-compose.yml'))).toBe(false);
    expect(compose.match(/^\s+ports:/gm)).toHaveLength(1);
    expect(compose).toContain('APP_ENV=${APP_ENV:?APP_ENV is required}');
    expect(compose).toContain('AUTH_MODE=${AUTH_MODE:?AUTH_MODE is required}');
    expect(compose).toContain('profiles: [n8n]');
    expect(compose).toContain('INFERENCE_BASE_URL=');
    expect(compose).toContain('INFERENCE_API_KEY=');
    expect(compose).toContain('INFERENCE_ALLOWED_HOSTS=');
    expect(compose).not.toContain('INFERENCE_MODEL=');
    expect(gateway).toContain('location = /eisenhower/google-calendar/webhook');
    expect(gateway).toContain('location = /eisenhower/google-calendar/oauth/callback');
  });

  it('publishes only after all image scans and emits one digest manifest', () => {
    const release = fs.readFileSync(path.join(repositoryRoot, '.github/workflows/release.yml'), 'utf8');
    const build = release.slice(release.indexOf('  docker-build-scan:'), release.indexOf('  publish-release:'));
    const publish = release.slice(release.indexOf('  publish-release:'), release.indexOf('  android-release:'));

    for (const [name, target] of [
      ['backend-ai-boundary', 'boundary'], ['backend-ai-classifier', 'classifier'],
      ['backend-ai-knowledge', 'knowledge'], ['backend-ai-ingest', 'ingest'],
      ['backend-node', 'production'], ['mcp', 'production'], ['web', 'production'],
    ]) expect(build).toMatch(new RegExp(`- name: ${name}[\\s\\S]*?target: ${target}`));
    expect(build).toContain('push: false');
    expect(build).toContain('--severity LOW,MEDIUM,HIGH,CRITICAL');
    expect(build).toContain('--exit-code 1');
    expect(build).toContain('--format cyclonedx');
    expect(build).not.toContain('docker push');
    expect(publish).toContain('needs:\n      - docker-build-scan');
    expect(publish).toContain('release-manifest.json');
    expect(publish).toContain('RepoDigests');
    expect(publish).toContain('docker push');
    expect(release).not.toContain('force-new-deployment');
    expect(release.toLowerCase()).not.toContain('mikrus');
  });

  it('builds production runtimes from digest-pinned scanner-visible packages', () => {
    const ai = fs.readFileSync(path.join(repositoryRoot, 'backend-ai/Dockerfile'), 'utf8');
    const node = fs.readFileSync(path.join(repositoryRoot, 'backend-node/Dockerfile'), 'utf8');
    const mcp = fs.readFileSync(path.join(repositoryRoot, 'mcp/eisenhower_adapter/Dockerfile'), 'utf8');
    const wolfi = 'cgr.dev/chainguard/wolfi-base@sha256:0a8fd427de5882aed77471b0a432c3675eda6b6a0ae952b5d640b46da628cdbe';

    expect(ai).toContain(`FROM ${wolfi} AS python-builder`);
    expect(ai).toContain(`FROM ${wolfi} AS runtime-base`);
    for (const target of ['boundary', 'classifier', 'knowledge', 'ingest']) {
      expect(ai).toContain(`FROM runtime-base AS ${target}`);
    }
    expect(node).toContain(`FROM ${wolfi} AS build`);
    expect(node).toContain(`FROM ${wolfi} AS production`);
    expect(node).not.toContain('node:20-alpine');
    expect(mcp).toContain(`FROM ${wolfi} AS builder`);
    expect(mcp).toContain(`FROM ${wolfi} AS production`);
    expect(mcp).not.toContain('python:3.11-slim');
  });

  it('accepts only the exact public HTTP status and rejects redirects', async () => {
    const server = http.createServer((request, response) => {
      if (request.url === '/redirect') {
        response.writeHead(301, { Location: '/ok' }); response.end(); return;
      }
      response.writeHead(200, { 'Content-Type': 'text/plain' }); response.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('test server did not bind');
    const check = path.join(repositoryRoot, '.github/scripts/assert-http-status.sh');
    const env = { ...process.env, ALLOW_INSECURE_HTTP_FOR_TESTS: '1' };
    try {
      await expect(execFileAsync(check, [`http://127.0.0.1:${address.port}/ok`, '200'], { env })).resolves.toBeDefined();
      await expect(execFileAsync(check, [`http://127.0.0.1:${address.port}/redirect`, '200'], { env })).rejects.toMatchObject({ code: 1 });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('keeps backup restore and rollback bound to checksums and immutable manifests', () => {
    const backup = fs.readFileSync(path.join(repositoryRoot, 'deploy/generic/backup.sh'), 'utf8');
    const restore = fs.readFileSync(path.join(repositoryRoot, 'deploy/generic/restore.sh'), 'utf8');
    const deploy = fs.readFileSync(path.join(repositoryRoot, 'deploy/generic/deploy.sh'), 'utf8');

    expect(backup).toContain('mongodump --archive --gzip');
    expect(backup).toContain('sha256sum');
    expect(restore).toContain('RESTORE_CONFIRM');
    expect(restore).toContain('sha256sum -c SHA256SUMS');
    expect(restore).toContain('mongorestore --drop --archive --gzip');
    expect(deploy).toContain('rollback-release-manifest.json');
    expect(deploy).toContain('restoring the previous immutable manifest');
  });
});
