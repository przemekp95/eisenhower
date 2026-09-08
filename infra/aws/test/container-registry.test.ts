import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { ContainerRegistryStack } from '../lib/container-registry-stack';

test.each(['staging', 'production'] as const)('%s registries are immutable, scanned, and environment-scoped', (environment) => {
  const app = new App();
  const template = Template.fromStack(new ContainerRegistryStack(app, `Registry-${environment}`, {
    env: { account: '111122223333', region: 'eu-central-1' },
    deploymentEnvironment: environment,
  }));

  template.resourceCountIs('AWS::ECR::Repository', 2);
  for (const name of ['api', 'web']) {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: `eisenhower-${environment}-${name}`,
      ImageScanningConfiguration: { ScanOnPush: true },
      ImageTagMutability: 'IMMUTABLE',
    });
  }
  template.hasOutput('ImagePublishingRoleArn', { Value: Match.anyValue() });
  const policies = template.findResources('AWS::IAM::Policy');
  const publishingPolicy = Object.entries(policies).find(([logicalId]) =>
    logicalId.includes('ImagePublishingRole')
  );
  expect(publishingPolicy).toBeDefined();
  const policyJson = JSON.stringify(publishingPolicy![1]);
  expect(policyJson).toContain('ecr:PutImage');
  expect(policyJson).toContain('ApiRepository');
  expect(policyJson).toContain('WebRepository');
});
