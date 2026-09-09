import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const webRoot = path.resolve(__dirname, '..');
const runtimeSecurity = path.join(webRoot, 'runtime-security.sh');

function connectSources(aiUrl: string, oidcIssuer: string) {
  return execFileSync(
    'sh',
    [
      '-eu',
      '-c',
      `. "$1"; build_csp_connect_src "$2" "$3"`,
      'runtime-security-test',
      runtimeSecurity,
      aiUrl,
      oidcIssuer,
    ],
    { encoding: 'utf8' }
  );
}

describe('runtime web security policy', () => {
  it('allows only the configured cross-origin AI and OIDC origins', () => {
    expect(
      connectSources(
        'https://eisenhower-ai.example.test/ai',
        'https://eisenhower-auth.example.test/identity/realms/eisenhower'
      )
    ).toBe("'self' https://eisenhower-ai.example.test https://eisenhower-auth.example.test");
  });

  it('keeps same-origin endpoints implicit and removes duplicate origins', () => {
    expect(connectSources('/ai', '')).toBe("'self'");
    expect(
      connectSources(
        'https://services.example.test/ai',
        'https://services.example.test/identity/realms/eisenhower'
      )
    ).toBe("'self' https://services.example.test");
  });

  it('rejects non-HTTP runtime endpoints instead of weakening CSP', () => {
    expect(() => connectSources('javascript:alert(1)', '')).toThrow();
    expect(() => connectSources('https://safe.example.test/ai', 'https://bad host.test')).toThrow();
    expect(() => connectSources('//evil.example.test/ai', '')).toThrow();
    expect(() => connectSources('https://safe.example.test:99999/ai', '')).toThrow();
    expect(() => connectSources('https://999.999.999.999/ai', '')).toThrow();
    expect(() => connectSources('https://-bad.example.test/ai', '')).toThrow();
    expect(() => connectSources('/ai\nInjected', '')).toThrow();
  });

  it('requires nginx to use the runtime-generated connect-src value', () => {
    const nginx = readFileSync(path.join(webRoot, 'nginx.conf'), 'utf8');
    expect(nginx).toContain('connect-src __CSP_CONNECT_SRC__;');
    expect(nginx).not.toContain("connect-src 'self';");
  });

  it('renders the runtime nginx config in a location writable by the unprivileged image user', () => {
    const dockerfile = readFileSync(path.join(webRoot, 'Dockerfile'), 'utf8');
    const entrypoint = readFileSync(path.join(webRoot, 'docker-entrypoint.sh'), 'utf8');
    expect(dockerfile).toContain('COPY web/nginx.conf /etc/nginx/nginx.conf.template');
    const productionStage = dockerfile.split('# Development stage')[0];
    const effectiveUser = [...productionStage.matchAll(/^USER\s+(\S+)$/gm)].at(-1)?.[1];
    expect(effectiveUser).toBe('nginx');
    expect(entrypoint).toContain('> /tmp/nginx.conf');
    expect(entrypoint).toContain("exec nginx -c /tmp/nginx.conf -g 'daemon off;'");
  });
});
