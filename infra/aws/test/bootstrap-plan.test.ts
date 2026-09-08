import {
  bootstrapPlanFromEnvironment,
  buildBootstrapPlan,
  formatBootstrapCommand,
} from '../lib/bootstrap-plan';
import fs from 'node:fs';
import path from 'node:path';

const account = '802954286692';

const approved = {
  account,
  region: 'eu-central-1',
  executionPolicyArns: {
    identity: `arn:aws:iam::${account}:policy/eisenhower/bootstrap/identity-cloudformation-execution`,
    staging: `arn:aws:iam::${account}:policy/eisenhower/bootstrap/staging-cloudformation-execution`,
    production: `arn:aws:iam::${account}:policy/eisenhower/bootstrap/production-cloudformation-execution`,
  },
  permissionsBoundaryNames: {
    identity: 'eisenhower-identity-permissions-boundary',
    staging: 'eisenhower-staging-permissions-boundary',
    production: 'eisenhower-production-permissions-boundary',
  },
} as const;

test('builds three EU-only bootstrap commands with separate customer-managed policies and boundaries', () => {
  expect(buildBootstrapPlan(approved)).toEqual([
    {
      environment: 'identity',
      qualifier: 'eisnidt',
      toolkitStackName: 'CDKToolkit-EisenhowerIdentity',
      args: expect.arrayContaining([
        'aws://802954286692/eu-central-1',
        '--cloudformation-execution-policies',
        approved.executionPolicyArns.identity,
        '--template',
        'dist/bootstrap-template.yaml',
        '--custom-permissions-boundary',
        approved.permissionsBoundaryNames.identity,
      ]),
    },
    expect.objectContaining({
      environment: 'staging', qualifier: 'eisnstg',
      toolkitStackName: 'CDKToolkit-EisenhowerStaging',
    }),
    expect.objectContaining({
      environment: 'production', qualifier: 'eisnprd',
      toolkitStackName: 'CDKToolkit-EisenhowerProduction',
    }),
  ]);
});

test.each([
  ['wrong account', { ...approved, account: '111122223333' }],
  ['wrong region', { ...approved, region: 'us-east-1' }],
  ['AWS-managed policy', {
    ...approved,
    executionPolicyArns: {
      ...approved.executionPolicyArns,
      staging: 'arn:aws:iam::aws:policy/AdministratorAccess',
    },
  }],
  ['cross-account policy', {
    ...approved,
    executionPolicyArns: {
      ...approved.executionPolicyArns,
      staging: 'arn:aws:iam::111122223333:policy/eisenhower/bootstrap/staging-cloudformation-execution',
    },
  }],
  ['unexpected boundary', {
    ...approved,
    permissionsBoundaryNames: {
      ...approved.permissionsBoundaryNames,
      staging: 'AdministratorAccess',
    },
  }],
])('rejects %s before producing a bootstrap command', (_label, input) => {
  expect(() => buildBootstrapPlan(input)).toThrow();
});

test('reads only the explicit policy and boundary contract from the environment', () => {
  const plan = bootstrapPlanFromEnvironment({
    CDK_BOOTSTRAP_ACCOUNT: account,
    CDK_BOOTSTRAP_REGION: 'eu-central-1',
    CDK_IDENTITY_EXECUTION_POLICY_ARN: approved.executionPolicyArns.identity,
    CDK_STAGING_EXECUTION_POLICY_ARN: approved.executionPolicyArns.staging,
    CDK_PRODUCTION_EXECUTION_POLICY_ARN: approved.executionPolicyArns.production,
    CDK_IDENTITY_PERMISSIONS_BOUNDARY: approved.permissionsBoundaryNames.identity,
    CDK_STAGING_PERMISSIONS_BOUNDARY: approved.permissionsBoundaryNames.staging,
    CDK_PRODUCTION_PERMISSIONS_BOUNDARY: approved.permissionsBoundaryNames.production,
  });
  expect(plan).toHaveLength(3);
  expect(plan.map(formatBootstrapCommand).join('\n')).not.toContain('AdministratorAccess');
  expect(plan.map(formatBootstrapCommand)[0]).toMatch(
    /^npm exec -- cdk bootstrap aws:\/\/802954286692\/eu-central-1 /,
  );
});

test('fails closed when one bootstrap security input is missing', () => {
  expect(() => bootstrapPlanFromEnvironment({
    CDK_BOOTSTRAP_ACCOUNT: account,
    CDK_BOOTSTRAP_REGION: 'eu-central-1',
  })).toThrow(/CDK_IDENTITY_EXECUTION_POLICY_ARN/);
});

test('runbook routes bootstrap through the validated plan and contains no bare bootstrap command', () => {
  const runbook = fs.readFileSync(path.resolve('../../docs/aws/RUNBOOK.md'), 'utf8');
  expect(runbook).toContain('npm run bootstrap:plan');
  expect(runbook).not.toMatch(/^npm exec -- cdk bootstrap /m);
  expect(runbook).toContain('AdministratorAccess');
});
