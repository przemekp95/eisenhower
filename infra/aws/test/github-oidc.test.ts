import { App } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { GitHubOidcStack, bootstrapQualifier } from '../lib/github-oidc-stack';

test('creates one provider and environment-specific deployment roles for a shared account', () => {
  const app = new App();
  const stack = new GitHubOidcStack(app, 'Oidc', {
    env: { account: '111122223333', region: 'eu-central-1' },
    githubOwner: 'przemekp95',
    githubRepository: 'eisenhower',
  });
  const template = Template.fromStack(stack);

  template.resourceCountIs('AWS::IAM::OIDCProvider', 1);
  template.resourceCountIs('Custom::AWSCDKOpenIdConnectProvider', 0);
  const deploymentRoleNames = Object.values(template.findResources('AWS::IAM::Role'))
    .map((resource) => resource.Properties.RoleName)
    .filter((roleName) => typeof roleName === 'string' && roleName.startsWith('eisenhower-'));
  expect(deploymentRoleNames).toEqual([
    'eisenhower-staging-github-deploy',
    'eisenhower-production-github-deploy',
  ]);
  for (const environment of ['staging', 'production'] as const) {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: `eisenhower-${environment}-github-deploy`,
      AssumeRolePolicyDocument: {
        Statement: Match.arrayWith([Match.objectLike({
          Effect: 'Allow',
          Action: 'sts:AssumeRoleWithWebIdentity',
          Condition: {
            StringEquals: {
              'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
              'token.actions.githubusercontent.com:sub': `repo:przemekp95/eisenhower:environment:${environment}`,
            },
          },
        })]),
      },
    });
  }
});

test.each(['staging', 'production'] as const)(
  '%s deployment role assumes only its isolated bootstrap and operator roles',
  (environment) => {
  const app = new App();
  const template = Template.fromStack(new GitHubOidcStack(app, 'Oidc', {
    env: { account: '111122223333', region: 'eu-central-1' },
    githubOwner: 'przemekp95', githubRepository: 'eisenhower',
  }));
  template.resourceCountIs('AWS::IAM::User', 0);
  const roles = template.findResources('AWS::IAM::Role');
  const roleLogicalId = Object.entries(roles).find(
    ([, resource]) => resource.Properties.RoleName === `eisenhower-${environment}-github-deploy`,
  )?.[0];
  expect(roleLogicalId).toBeDefined();
  const policies = template.findResources('AWS::IAM::Policy');
  const statements = Object.values(policies).filter(
    (resource) => JSON.stringify(resource.Properties.Roles).includes(roleLogicalId!),
  ).flatMap(
    (resource) => resource.Properties.PolicyDocument.Statement
  );
  expect(statements).toHaveLength(4);
  expect(statements).toEqual(expect.arrayContaining([
    expect.objectContaining({
      Action: 'sts:AssumeRole',
      Effect: 'Allow',
      Condition: { StringLike: { 'iam:ResourceTag/aws-cdk:bootstrap-role': '*' } },
    }),
    expect.objectContaining({
      Action: 'sts:AssumeRole',
      Effect: 'Allow',
      Condition: {
        StringEquals: {
          'iam:ResourceTag/Project': 'eisenhower',
          'iam:ResourceTag/Environment': environment,
        },
      },
    }),
  ]));
  expect(JSON.stringify(statements)).toContain(
    `:iam::111122223333:role/cdk-${bootstrapQualifier(environment)}-*-role-111122223333-eu-central-1`
  );
  expect(JSON.stringify(statements)).toContain(
    `:iam::111122223333:role/eisenhower-${environment}-artifact-ops`
  );
  expect(JSON.stringify(statements)).toContain(
    `:iam::111122223333:role/eisenhower-${environment}-migration-ops`
  );
  expect(JSON.stringify(statements)).toContain(
    `:iam::111122223333:role/eisenhower-${environment}-image-publishing`
  );
  expect(JSON.stringify(statements)).not.toContain('cloudformation:');
  expect(JSON.stringify(statements)).not.toContain('ecr:');
  expect(JSON.stringify(statements)).not.toContain(
    `cdk-${bootstrapQualifier(environment === 'staging' ? 'production' : 'staging')}`,
  );
});
