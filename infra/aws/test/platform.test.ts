import { App, Duration, Stack } from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { PlatformStack, platformConfig } from '../lib/platform-stack';

function synth(environment: 'staging' | 'production') {
  const app = new App();
  const stack = new PlatformStack(app, `Test-${environment}`, {
    env: { account: '111122223333', region: 'eu-central-1' },
    config: platformConfig(environment),
  });
  return { stack, template: Template.fromStack(stack) };
}

describe.each(['staging', 'production'] as const)('%s platform', (environment) => {
  it('uses two availability zones with public ingress and private workloads', () => {
    const { template } = synth(environment);
    template.resourceCountIs('AWS::EC2::NatGateway', environment === 'production' ? 2 : 1);
    template.resourceCountIs('AWS::ElasticLoadBalancingV2::LoadBalancer', 1);
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::LoadBalancer', {
      Scheme: 'internet-facing',
      Type: 'application',
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'DISABLED',
          Subnets: Match.anyValue(),
        }),
      },
    });
    for (const resource of Object.values(template.findResources('AWS::ECS::Service'))) {
      const subnets = resource.Properties?.NetworkConfiguration?.AwsvpcConfiguration?.Subnets;
      expect(Array.isArray(subnets)).toBe(true);
      expect(subnets).toHaveLength(2);
    }
    const subnets = Object.values(template.findResources('AWS::EC2::Subnet'));
    expect(new Set(subnets.map((resource) => resource.Properties?.AvailabilityZone))).toEqual(
      new Set(['eu-central-1a', 'eu-central-1b']),
    );
  });

  it('serves HTTPS and keeps exact-release ECS services rollback capable', () => {
    const { template } = synth(environment);
    template.hasParameter('ServiceDesiredCount', { Type: 'Number', Default: 0 });
    template.hasParameter('ServiceMinimumCapacity', { Type: 'Number', Default: 0 });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 443,
      Protocol: 'HTTPS',
      Certificates: Match.arrayWith([Match.objectLike({ CertificateArn: Match.anyValue() })]),
    });
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::Listener', {
      Port: 80,
      DefaultActions: Match.arrayWith([Match.objectLike({ Type: 'redirect' })]),
    });
    template.resourceCountIs('AWS::ECS::Service', 2);
    template.allResourcesProperties('AWS::ECS::Service', Match.objectLike({
      DeploymentConfiguration: Match.objectLike({
        DeploymentCircuitBreaker: { Enable: true, Rollback: true },
      }),
      DesiredCount: { Ref: 'ServiceDesiredCount' },
      EnableExecuteCommand: false,
    }));
    template.hasResourceProperties('AWS::ElasticLoadBalancingV2::TargetGroup', {
      HealthCheckPath: '/health/ready',
      Matcher: { HttpCode: '200' },
    });
    template.resourceCountIs('AWS::ApplicationAutoScaling::ScalableTarget', 2);
    template.allResourcesProperties('AWS::ApplicationAutoScaling::ScalableTarget', Match.objectLike({
      MinCapacity: { Ref: 'ServiceMinimumCapacity' },
    }));
  });

  it('injects the public API, AI, and OIDC runtime contract into the web container', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([Match.objectLike({
        Name: 'Web',
        Environment: Match.arrayWith([
          { Name: 'VITE_API_URL', Value: '/api' },
          { Name: 'VITE_AI_API_URL', Value: { Ref: 'AiServiceUrl' } },
          { Name: 'VITE_OIDC_ISSUER', Value: { Ref: 'OidcIssuer' } },
          { Name: 'VITE_OIDC_CLIENT_ID', Value: 'eisenhower-web' },
          {
            Name: 'VITE_OIDC_REDIRECT_URI',
            Value: { 'Fn::Join': ['', [{ Ref: 'PublicOrigin' }, '/oauth/callback']] },
          },
          {
            Name: 'VITE_OIDC_SCOPES',
            Value: 'openid tasks:read tasks:write calendar:read calendar:write knowledge:read ai:analyze',
          },
        ]),
      })]),
    });
  });

  it('defines a one-shot migration task with admin DDL and separate application credentials', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([Match.objectLike({
        Command: ['node', 'dist/postgresMigrations.js'],
        Environment: Match.arrayWith([{ Name: 'PRISMA_MIGRATIONS_PATH', Value: '/app/prisma/migrations' }]),
        Secrets: Match.arrayWith([
          { Name: 'DATABASE_ADMIN_USERNAME', ValueFrom: Match.anyValue() },
          { Name: 'DATABASE_ADMIN_PASSWORD', ValueFrom: Match.anyValue() },
          { Name: 'DATABASE_USERNAME', ValueFrom: Match.anyValue() },
          { Name: 'DATABASE_PASSWORD', ValueFrom: Match.anyValue() },
        ]),
      })]),
    });
    template.hasOutput('MigrationOpsRoleArn', { Value: Match.anyValue() });
    const policies = template.findResources('AWS::IAM::Policy');
    const migrationPolicy = Object.entries(policies).find(([logicalId]) =>
      logicalId.includes('MigrationOpsRole')
    );
    expect(migrationPolicy).toBeDefined();
    const migrationPolicyJson = JSON.stringify(migrationPolicy![1]);
    expect(migrationPolicyJson).toContain('ecs:RunTask');
    expect(migrationPolicyJson).toContain('ecs:DescribeTasks');
    expect(migrationPolicyJson).toContain('iam:PassRole');
  });

  it('accepts audited session tags on scoped operator role chaining', () => {
    const { template } = synth(environment);
    for (const suffix of ['artifact-ops', 'migration-ops']) {
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: `eisenhower-${environment}-${suffix}`,
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([Match.objectLike({
            Action: ['sts:AssumeRole', 'sts:TagSession'],
            Effect: 'Allow',
          })]),
        },
      });
    }
  });

  it('uses encrypted private PostgreSQL with backups and safe production retention', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::RDS::DBInstance', Match.objectLike({
      Engine: 'postgres',
      StorageEncrypted: true,
      PubliclyAccessible: false,
      BackupRetentionPeriod: environment === 'production' ? 35 : 7,
      DeletionProtection: environment === 'production',
      MultiAZ: environment === 'production',
      EnablePerformanceInsights: true,
    }));
    template.hasResource('AWS::RDS::DBInstance', {
      DeletionPolicy: environment === 'production' ? 'Snapshot' : 'Delete',
      UpdateReplacePolicy: environment === 'production' ? 'Snapshot' : 'Delete',
    });
  });

  it('keeps Redis private, encrypted, authenticated, and failover-capable in production', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::ElastiCache::ReplicationGroup', Match.objectLike({
      AtRestEncryptionEnabled: true,
      TransitEncryptionEnabled: true,
      AuthToken: Match.anyValue(),
      AutomaticFailoverEnabled: environment === 'production',
      MultiAZEnabled: environment === 'production',
      NumCacheClusters: environment === 'production' ? 2 : 1,
    }));
  });

  it('creates a private versioned encrypted bucket with lifecycle controls', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::S3::Bucket', Match.objectLike({
      BucketEncryption: Match.anyValue(),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      VersioningConfiguration: { Status: 'Enabled' },
      LifecycleConfiguration: Match.objectLike({ Rules: Match.anyValue() }),
    }));
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: environment === 'production' ? 'Retain' : 'Delete',
      UpdateReplacePolicy: environment === 'production' ? 'Retain' : 'Delete',
    });
  });

  it('limits security-group paths and grants only dedicated artifact operations storage access', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432,
      SourceSecurityGroupId: Match.anyValue(),
    });
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp', FromPort: 6379, ToPort: 6379,
      SourceSecurityGroupId: Match.anyValue(),
    });
    const policies = template.findResources('AWS::IAM::Policy');
    const storagePolicies = Object.entries(policies).filter(([, resource]) =>
      resource.Properties.PolicyDocument.Statement.some((statement: { Action?: string[] }) =>
        Array.isArray(statement.Action) && statement.Action.includes('s3:PutObject')
      )
    );
    expect(storagePolicies).toHaveLength(1);
    expect(storagePolicies[0][0]).toContain('ArtifactOpsRole');
    const storageStatements = storagePolicies[0][1].Properties.PolicyDocument.Statement.filter(
      (statement: { Action?: string[] }) => Array.isArray(statement.Action) && statement.Action.includes('s3:PutObject')
    );
    expect(storageStatements).toHaveLength(1);
    expect(JSON.stringify(storageStatements)).toContain('/model-artifacts/*');
    expect(JSON.stringify(storageStatements)).not.toContain('s3:DeleteObject');
  });

  it('emits structured logs and actionable alarms and dashboard', () => {
    const { template } = synth(environment);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([Match.objectLike({
        Environment: Match.arrayWith([{ Name: 'AUDIT_SINK', Value: 'stdout' }]),
        Secrets: Match.arrayWith([{ Name: 'AUDIT_HMAC_KEY', ValueFrom: Match.anyValue() }]),
      })]),
    });
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      RetentionInDays: environment === 'production' ? 90 : 30,
    });
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.resourceCountIs('AWS::CloudWatch::Alarm', 6);
    template.resourceCountIs('AWS::SNS::Topic', 1);
    template.resourceCountIs('AWS::Events::Rule', 1);
    const alarmResources = template.findResources('AWS::CloudWatch::Alarm');
    for (const alarm of Object.values(alarmResources)) {
      expect(alarm.Properties.AlarmActions).toHaveLength(1);
      expect(JSON.stringify(alarm.Properties.AlarmActions)).toContain('OperationsTopic');
    }
    template.hasResourceProperties('AWS::Events::Rule', {
      EventPattern: Match.objectLike({
        source: ['aws.ecs'],
        'detail-type': ['ECS Deployment State Change'],
        detail: { eventName: ['SERVICE_DEPLOYMENT_FAILED'] },
      }),
    });
  });
});

test('environment defaults remain explicit and distinct', () => {
  expect(platformConfig('staging')).toMatchObject({
    environment: 'staging', natGateways: 1, desiredCount: 1,
    availabilityZones: ['eu-central-1a', 'eu-central-1b'],
    database: { multiAz: false, backupRetention: Duration.days(7) },
  });
  expect(platformConfig('production')).toMatchObject({
    environment: 'production', natGateways: 2, desiredCount: 2,
    availabilityZones: ['eu-central-1a', 'eu-central-1b'],
    database: { multiAz: true, backupRetention: Duration.days(35) },
  });
});
