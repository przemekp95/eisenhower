import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { ContainerRegistryStack } from '../lib/container-registry-stack';
import { GitHubOidcStack } from '../lib/github-oidc-stack';
import { PlatformStack, platformConfig } from '../lib/platform-stack';

function expectEveryRoleUses(template: Template, boundaryName: string) {
  const roles = Object.values(template.findResources('AWS::IAM::Role'));
  expect(roles.length).toBeGreaterThan(0);
  for (const role of roles) {
    expect(JSON.stringify(role.Properties.PermissionsBoundary)).toContain(boundaryName);
  }
}

test('shared identity roles use the identity permissions boundary', () => {
  const app = new App();
  const stack = new GitHubOidcStack(app, 'Identity', {
    env: { account: '111122223333', region: 'eu-central-1' },
    githubOwner: 'przemekp95', githubRepository: 'eisenhower',
  });
  expectEveryRoleUses(Template.fromStack(stack), 'eisenhower-identity-permissions-boundary');
});

test.each(['staging', 'production'] as const)(
  '%s workload roles use only their environment permissions boundary',
  (environment) => {
    const app = new App();
    const registries = new ContainerRegistryStack(app, `Registries-${environment}`, {
      env: { account: '111122223333', region: 'eu-central-1' },
      deploymentEnvironment: environment,
    });
    const platform = new PlatformStack(app, `Platform-${environment}`, {
      env: { account: '111122223333', region: 'eu-central-1' },
      config: platformConfig(environment),
    });
    const expected = `eisenhower-${environment}-permissions-boundary`;
    expectEveryRoleUses(Template.fromStack(registries), expected);
    expectEveryRoleUses(Template.fromStack(platform), expected);
  },
);
