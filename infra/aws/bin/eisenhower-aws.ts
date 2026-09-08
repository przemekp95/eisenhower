#!/usr/bin/env node
import 'source-map-support/register';
import { App, DefaultStackSynthesizer } from 'aws-cdk-lib';
import {
  bootstrapQualifier,
  GitHubOidcStack,
  identityBootstrapQualifier,
} from '../lib/github-oidc-stack';
import { DeploymentEnvironment, PlatformStack, platformConfig } from '../lib/platform-stack';
import { ContainerRegistryStack } from '../lib/container-registry-stack';

const app = new App();
const environment = app.node.tryGetContext('environment') as DeploymentEnvironment | undefined;
if (!environment || !['staging', 'production'].includes(environment)) {
  throw new Error('CDK context environment=staging|production is required.');
}
const account = process.env.CDK_DEFAULT_ACCOUNT;
const region = process.env.CDK_DEFAULT_REGION ?? 'eu-central-1';
if (!account) throw new Error('CDK_DEFAULT_ACCOUNT is required.');
if (region !== 'eu-central-1') throw new Error('Only the approved AWS region eu-central-1 is supported.');

// Keep synthesis deterministic and credential-free. The target region and AZ pair
// are an explicit platform decision rather than an AWS environment lookup.
app.node.setContext(
  `availability-zones:account=${account}:region=${region}`,
  platformConfig(environment).availabilityZones,
);

new GitHubOidcStack(app, 'Eisenhower-GitHubOidc', {
  env: { account, region },
  githubOwner: 'przemekp95',
  githubRepository: 'eisenhower',
  synthesizer: new DefaultStackSynthesizer({ qualifier: identityBootstrapQualifier }),
});
new ContainerRegistryStack(app, `Eisenhower-${environment}-Registries`, {
  env: { account, region },
  deploymentEnvironment: environment,
  synthesizer: new DefaultStackSynthesizer({ qualifier: bootstrapQualifier(environment) }),
});
new PlatformStack(app, `Eisenhower-${environment}-Platform`, {
  env: { account, region },
  config: platformConfig(environment),
  synthesizer: new DefaultStackSynthesizer({ qualifier: bootstrapQualifier(environment) }),
});
