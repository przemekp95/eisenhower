import {
  CfnOutput,
  CfnParameter,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
} from 'aws-cdk-lib';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as events from 'aws-cdk-lib/aws-events';
import * as eventTargets from 'aws-cdk-lib/aws-events-targets';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';
import { permissionsBoundaryName } from './bootstrap-plan';
import { containerRepositoryNames } from './container-registry-stack';

export type DeploymentEnvironment = 'staging' | 'production';

export interface PlatformConfig {
  environment: DeploymentEnvironment;
  availabilityZones: readonly [string, string];
  natGateways: number;
  desiredCount: number;
  logRetention: logs.RetentionDays;
  database: {
    multiAz: boolean;
    backupRetention: Duration;
    deletionProtection: boolean;
  };
}

export function platformConfig(environment: DeploymentEnvironment): PlatformConfig {
  const production = environment === 'production';
  return {
    environment,
    availabilityZones: ['eu-central-1a', 'eu-central-1b'],
    natGateways: production ? 2 : 1,
    desiredCount: production ? 2 : 1,
    logRetention: production ? logs.RetentionDays.THREE_MONTHS : logs.RetentionDays.ONE_MONTH,
    database: {
      multiAz: production,
      backupRetention: Duration.days(production ? 35 : 7),
      deletionProtection: production,
    },
  };
}

export interface PlatformStackProps extends StackProps {
  config: PlatformConfig;
}

export class PlatformStack extends Stack {
  constructor(scope: Construct, id: string, props: PlatformStackProps) {
    super(scope, id, props);
    const { config } = props;
    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(
      this, 'WorkloadPermissionsBoundary', permissionsBoundaryName(config.environment),
    ));
    const production = config.environment === 'production';

    Tags.of(this).add('Project', 'eisenhower');
    Tags.of(this).add('Environment', config.environment);
    Tags.of(this).add('ManagedBy', 'aws-cdk');
    Tags.of(this).add('CostCenter', 'eisenhower-aws-core');

    const releaseSha = new CfnParameter(this, 'ReleaseSha', {
      type: 'String',
      allowedPattern: '^[a-f0-9]{40}$',
      description: 'Exact green Git commit used as the immutable ECR image tag.',
    });
    const certificateArn = new CfnParameter(this, 'CertificateArn', {
      type: 'String',
      allowedPattern: '^arn:aws:acm:[a-z0-9-]+:[0-9]{12}:certificate/[a-f0-9-]+$',
      description: 'Validated ACM certificate in the deployment region.',
    });
    const publicOrigin = new CfnParameter(this, 'PublicOrigin', {
      type: 'String',
      allowedPattern: '^https://[^/]+$',
      description: 'Public HTTPS origin used by the API CORS policy.',
    });
    const oidcIssuer = new CfnParameter(this, 'OidcIssuer', {
      type: 'String', allowedPattern: '^https://[^/]+(?:/[^/]+)*$',
    });
    const oidcAudience = new CfnParameter(this, 'OidcAudience', {
      type: 'String', minLength: 1,
    });
    const oidcJwksUrl = new CfnParameter(this, 'OidcJwksUrl', {
      type: 'String', allowedPattern: '^https://.+$',
    });
    const aiServiceUrl = new CfnParameter(this, 'AiServiceUrl', {
      type: 'String', allowedPattern: '^https?://.+$',
    });
    const serviceDesiredCount = new CfnParameter(this, 'ServiceDesiredCount', {
      type: 'Number', default: 0, minValue: 0, maxValue: production ? 6 : 3,
      description: 'Fail-closed at zero until the one-shot database migration succeeds.',
    });
    const serviceMinimumCapacity = new CfnParameter(this, 'ServiceMinimumCapacity', {
      type: 'Number', default: 0, minValue: 0, maxValue: production ? 6 : 3,
      description: 'Fail-closed autoscaling floor; activate only after migration succeeds.',
    });

    const vpc = new ec2.Vpc(this, 'Vpc', {
      availabilityZones: [...config.availabilityZones],
      natGateways: config.natGateways,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'application', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'data', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    });
    vpc.addGatewayEndpoint('S3Endpoint', { service: ec2.GatewayVpcEndpointAwsService.S3 });

    const albSecurityGroup = new ec2.SecurityGroup(this, 'AlbSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Public HTTPS ingress to the application load balancer.',
    });
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(443), 'HTTPS from the internet');
    albSecurityGroup.addIngressRule(ec2.Peer.anyIpv4(), ec2.Port.tcp(80), 'HTTP redirect only');

    const apiSecurityGroup = new ec2.SecurityGroup(this, 'ApiSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'API tasks; inbound only from the ALB.',
    });
    const webSecurityGroup = new ec2.SecurityGroup(this, 'WebSecurityGroup', {
      vpc,
      allowAllOutbound: true,
      description: 'Web tasks; inbound only from the ALB.',
    });
    apiSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3001), 'API from ALB');
    webSecurityGroup.addIngressRule(albSecurityGroup, ec2.Port.tcp(3000), 'Web from ALB');
    albSecurityGroup.addEgressRule(apiSecurityGroup, ec2.Port.tcp(3001), 'ALB to API');
    albSecurityGroup.addEgressRule(webSecurityGroup, ec2.Port.tcp(3000), 'ALB to web');

    const databaseSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'PostgreSQL reachable only from API tasks.',
    });
    databaseSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(5432), 'PostgreSQL from API');
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', {
      vpc,
      allowAllOutbound: false,
      description: 'Redis reachable only from API tasks.',
    });
    redisSecurityGroup.addIngressRule(apiSecurityGroup, ec2.Port.tcp(6379), 'Redis from API');

    const database = new rds.DatabaseInstance(this, 'Database', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [databaseSecurityGroup],
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16_13 }),
      credentials: rds.Credentials.fromGeneratedSecret('eisenhower_admin'),
      databaseName: 'eisenhower',
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      allocatedStorage: 20,
      maxAllocatedStorage: 100,
      storageEncrypted: true,
      publiclyAccessible: false,
      multiAz: config.database.multiAz,
      backupRetention: config.database.backupRetention,
      deleteAutomatedBackups: !production,
      deletionProtection: config.database.deletionProtection,
      enablePerformanceInsights: true,
      performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: config.logRetention,
      removalPolicy: production ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY,
    });
    const databaseApp = new secretsmanager.Secret(this, 'DatabaseAppCredentials', {
      description: `Eisenhower ${config.environment} restricted PostgreSQL application login`,
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'eisenhower_api' }),
        generateStringKey: 'password',
        passwordLength: 40,
        excludePunctuation: true,
      },
    });
    databaseApp.applyRemovalPolicy(production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);

    const redisAuth = new secretsmanager.Secret(this, 'RedisAuth', {
      description: `Eisenhower ${config.environment} Redis auth token`,
      generateSecretString: {
        passwordLength: 40,
        excludePunctuation: true,
      },
    });
    redisAuth.applyRemovalPolicy(production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
    const auditHmac = new secretsmanager.Secret(this, 'AuditHmac', {
      description: `Eisenhower ${config.environment} security-audit authentication key`,
      generateSecretString: { passwordLength: 48, excludePunctuation: true },
    });
    auditHmac.applyRemovalPolicy(production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY);
    const redisSubnets = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: `Eisenhower ${config.environment} isolated Redis subnets`,
      subnetIds: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_ISOLATED }).subnetIds,
    });
    const redis = new elasticache.CfnReplicationGroup(this, 'Redis', {
      replicationGroupDescription: `Eisenhower ${config.environment} shared coordination`,
      engine: 'valkey',
      engineVersion: '8.2',
      cacheNodeType: 'cache.t4g.micro',
      numCacheClusters: production ? 2 : 1,
      automaticFailoverEnabled: production,
      multiAzEnabled: production,
      atRestEncryptionEnabled: true,
      transitEncryptionEnabled: true,
      transitEncryptionMode: 'required',
      authToken: redisAuth.secretValue.unsafeUnwrap(),
      cacheSubnetGroupName: redisSubnets.ref,
      securityGroupIds: [redisSecurityGroup.securityGroupId],
      snapshotRetentionLimit: production ? 7 : 1,
      snapshotWindow: '02:00-03:00',
      preferredMaintenanceWindow: 'sun:03:00-sun:04:00',
    });
    redis.addResourceDependency(redisSubnets);
    redis.applyRemovalPolicy(production ? RemovalPolicy.SNAPSHOT : RemovalPolicy.DESTROY);

    const artifacts = new s3.Bucket(this, 'Artifacts', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: true,
      lifecycleRules: [{
        id: 'expire-temporary-and-old-versions',
        enabled: true,
        prefix: 'temporary/',
        expiration: Duration.days(7),
        noncurrentVersionExpiration: Duration.days(production ? 90 : 30),
        abortIncompleteMultipartUploadAfter: Duration.days(1),
      }],
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      autoDeleteObjects: !production,
    });
    const artifactOpsRole = new iam.Role(this, 'ArtifactOpsRole', {
      roleName: `eisenhower-${config.environment}-artifact-ops`,
      description: `Narrow CI role for immutable Eisenhower ${config.environment} model artifacts`,
      assumedBy: new iam.ArnPrincipal(
        `arn:${this.partition}:iam::${this.account}:role/eisenhower-${config.environment}-github-deploy`,
      ),
      maxSessionDuration: Duration.hours(1),
    });
    artifactOpsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'WriteImmutableModelArtifacts',
      actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:PutObject'],
      resources: [artifacts.arnForObjects('model-artifacts/*')],
    }));

    const cluster = new ecs.Cluster(this, 'Cluster', {
      vpc,
      containerInsightsV2: ecs.ContainerInsights.ENHANCED,
    });
    const repositoryNames = containerRepositoryNames(config.environment);
    const apiRepository = ecr.Repository.fromRepositoryName(this, 'ApiRepository', repositoryNames.api);
    const webRepository = ecr.Repository.fromRepositoryName(this, 'WebRepository', repositoryNames.web);

    const apiLogs = new logs.LogGroup(this, 'ApiLogs', {
      retention: config.logRetention,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const webLogs = new logs.LogGroup(this, 'WebLogs', {
      retention: config.logRetention,
      removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    const apiTask = new ecs.FargateTaskDefinition(this, 'ApiTask', {
      cpu: 512,
      memoryLimitMiB: 1024,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    const apiContainer = apiTask.addContainer('Api', {
      image: ecs.ContainerImage.fromEcrRepository(apiRepository, releaseSha.valueAsString),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'api', logGroup: apiLogs }),
      environment: {
        NODE_ENV: 'production',
        AUTH_MODE: 'oidc',
        OIDC_ISSUER: oidcIssuer.valueAsString,
        OIDC_AUDIENCE: oidcAudience.valueAsString,
        OIDC_JWKS_URL: oidcJwksUrl.valueAsString,
        AI_SERVICE_URL: aiServiceUrl.valueAsString,
        AUDIT_SINK: 'stdout',
        DATABASE_PROVIDER: 'postgresql',
        DATABASE_HOST: database.dbInstanceEndpointAddress,
        DATABASE_PORT: database.dbInstanceEndpointPort,
        DATABASE_NAME: 'eisenhower',
        REDIS_HOST: redis.attrPrimaryEndPointAddress,
        REDIS_PORT: redis.attrPrimaryEndPointPort,
        REDIS_TLS: 'true',
        REDIS_ENABLED: 'true',
        ARTIFACT_BUCKET: artifacts.bucketName,
        AWS_REGION: this.region,
        CORS_ALLOW_ORIGINS: publicOrigin.valueAsString,
        RELEASE_SHA: releaseSha.valueAsString,
      },
      secrets: {
        DATABASE_USERNAME: ecs.Secret.fromSecretsManager(databaseApp, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(databaseApp, 'password'),
        REDIS_AUTH_TOKEN: ecs.Secret.fromSecretsManager(redisAuth),
        AUDIT_HMAC_KEY: ecs.Secret.fromSecretsManager(auditHmac),
      },
      healthCheck: {
        command: ['CMD-SHELL', 'node -e "fetch(\'http://127.0.0.1:3001/health/ready\').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(30),
      },
    });
    apiContainer.addPortMappings({ containerPort: 3001 });

    const migrationTask = new ecs.FargateTaskDefinition(this, 'MigrationTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    migrationTask.addContainer('Migration', {
      image: ecs.ContainerImage.fromEcrRepository(apiRepository, releaseSha.valueAsString),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'migration', logGroup: apiLogs }),
      command: ['node', 'dist/postgresMigrations.js'],
      environment: {
        DATABASE_HOST: database.dbInstanceEndpointAddress,
        DATABASE_PORT: database.dbInstanceEndpointPort,
        DATABASE_NAME: 'eisenhower',
        DATABASE_SSL: 'true',
        PRISMA_MIGRATIONS_PATH: '/app/prisma/migrations',
      },
      secrets: {
        DATABASE_ADMIN_USERNAME: ecs.Secret.fromSecretsManager(database.secret!, 'username'),
        DATABASE_ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(database.secret!, 'password'),
        DATABASE_USERNAME: ecs.Secret.fromSecretsManager(databaseApp, 'username'),
        DATABASE_PASSWORD: ecs.Secret.fromSecretsManager(databaseApp, 'password'),
      },
    });
    const migrationOpsRole = new iam.Role(this, 'MigrationOpsRole', {
      roleName: `eisenhower-${config.environment}-migration-ops`,
      description: `Narrow release role for the Eisenhower ${config.environment} one-shot migration task`,
      assumedBy: new iam.ArnPrincipal(
        `arn:${this.partition}:iam::${this.account}:role/eisenhower-${config.environment}-github-deploy`,
      ),
      maxSessionDuration: Duration.hours(1),
    });
    migrationOpsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'RunOnlyMigrationTask',
      actions: ['ecs:RunTask'],
      resources: [migrationTask.taskDefinitionArn],
      conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
    }));
    migrationOpsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'ObserveMigrationTask',
      actions: ['ecs:DescribeTasks'],
      resources: ['*'],
      conditions: { ArnEquals: { 'ecs:cluster': cluster.clusterArn } },
    }));
    migrationOpsRole.addToPolicy(new iam.PolicyStatement({
      sid: 'PassOnlyMigrationTaskRoles',
      actions: ['iam:PassRole'],
      resources: [migrationTask.taskRole.roleArn, migrationTask.executionRole!.roleArn],
      conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
    }));

    const webTask = new ecs.FargateTaskDefinition(this, 'WebTask', {
      cpu: 256,
      memoryLimitMiB: 512,
      runtimePlatform: { cpuArchitecture: ecs.CpuArchitecture.ARM64 },
    });
    const webContainer = webTask.addContainer('Web', {
      image: ecs.ContainerImage.fromEcrRepository(webRepository, releaseSha.valueAsString),
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'web', logGroup: webLogs }),
      environment: {
        RELEASE_SHA: releaseSha.valueAsString,
        VITE_API_URL: '/api',
        VITE_AI_API_URL: aiServiceUrl.valueAsString,
        VITE_OIDC_ISSUER: oidcIssuer.valueAsString,
        VITE_OIDC_CLIENT_ID: 'eisenhower-web',
        VITE_OIDC_REDIRECT_URI: `${publicOrigin.valueAsString}/oauth/callback`,
        VITE_OIDC_SCOPES:
          'openid tasks:read tasks:write calendar:read calendar:write knowledge:read ai:analyze',
      },
      healthCheck: {
        command: ['CMD-SHELL', 'curl -fsS http://127.0.0.1:3000/health >/dev/null || exit 1'],
        interval: Duration.seconds(30),
        timeout: Duration.seconds(5),
        retries: 3,
        startPeriod: Duration.seconds(15),
      },
    });
    webContainer.addPortMappings({ containerPort: 3000 });

    const serviceDefaults = {
      cluster,
      desiredCount: serviceDesiredCount.valueAsNumber,
      assignPublicIp: false,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      circuitBreaker: { rollback: true },
      enableExecuteCommand: false,
      minHealthyPercent: 100,
      maxHealthyPercent: 200,
    };
    const apiService = new ecs.FargateService(this, 'ApiService', {
      ...serviceDefaults,
      taskDefinition: apiTask,
      securityGroups: [apiSecurityGroup],
    });
    const webService = new ecs.FargateService(this, 'WebService', {
      ...serviceDefaults,
      taskDefinition: webTask,
      securityGroups: [webSecurityGroup],
    });
    for (const [name, service] of [['Api', apiService], ['Web', webService]] as const) {
      const scaling = service.autoScaleTaskCount({
        minCapacity: serviceMinimumCapacity.valueAsNumber,
        maxCapacity: production ? 6 : 3,
      });
      scaling.scaleOnCpuUtilization(`${name}CpuScaling`, {
        targetUtilizationPercent: 60,
        scaleInCooldown: Duration.minutes(5),
        scaleOutCooldown: Duration.minutes(1),
      });
    }

    const loadBalancer = new elbv2.ApplicationLoadBalancer(this, 'LoadBalancer', {
      vpc,
      internetFacing: true,
      securityGroup: albSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      dropInvalidHeaderFields: true,
    });
    loadBalancer.addListener('HttpRedirect', {
      port: 80,
      defaultAction: elbv2.ListenerAction.redirect({ protocol: 'HTTPS', port: '443', permanent: true }),
    });
    const https = loadBalancer.addListener('Https', {
      port: 443,
      certificates: [acm.Certificate.fromCertificateArn(this, 'Certificate', certificateArn.valueAsString)],
      protocol: elbv2.ApplicationProtocol.HTTPS,
      sslPolicy: elbv2.SslPolicy.RECOMMENDED_TLS,
      defaultAction: elbv2.ListenerAction.fixedResponse(404, { contentType: 'application/json' }),
    });
    https.addTargets('ApiTargets', {
      priority: 10,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/api/*'])],
      port: 3001,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [apiService],
      healthCheck: { path: '/health/ready', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(30),
    });
    https.addTargets('WebTargets', {
      priority: 20,
      conditions: [elbv2.ListenerCondition.pathPatterns(['/*'])],
      port: 3000,
      protocol: elbv2.ApplicationProtocol.HTTP,
      targets: [webService],
      healthCheck: { path: '/health', healthyHttpCodes: '200' },
      deregistrationDelay: Duration.seconds(30),
    });

    const operationsTopic = new sns.Topic(this, 'OperationsTopic', {
      displayName: `Eisenhower ${config.environment} operations`,
    });
    const alarmAction = new cloudwatchActions.SnsAction(operationsTopic);
    const alarms = [
      new cloudwatch.Alarm(this, 'Alb5xxAlarm', {
        metric: loadBalancer.metrics.httpCodeElb(elbv2.HttpCodeElb.ELB_5XX_COUNT),
        threshold: 5, evaluationPeriods: 2, datapointsToAlarm: 2,
      }),
      new cloudwatch.Alarm(this, 'Target5xxAlarm', {
        metric: loadBalancer.metrics.httpCodeTarget(elbv2.HttpCodeTarget.TARGET_5XX_COUNT),
        threshold: 5, evaluationPeriods: 2, datapointsToAlarm: 2,
      }),
      new cloudwatch.Alarm(this, 'ApiCpuAlarm', {
        metric: apiService.metricCpuUtilization(), threshold: 85, evaluationPeriods: 3,
      }),
      new cloudwatch.Alarm(this, 'WebCpuAlarm', {
        metric: webService.metricCpuUtilization(), threshold: 85, evaluationPeriods: 3,
      }),
      new cloudwatch.Alarm(this, 'DatabaseStorageAlarm', {
        metric: database.metricFreeStorageSpace(), threshold: 5 * 1024 ** 3,
        comparisonOperator: cloudwatch.ComparisonOperator.LESS_THAN_THRESHOLD,
        evaluationPeriods: 2,
      }),
      new cloudwatch.Alarm(this, 'RedisCpuAlarm', {
        metric: new cloudwatch.Metric({
          namespace: 'AWS/ElastiCache', metricName: 'EngineCPUUtilization',
          dimensionsMap: { ReplicationGroupId: redis.ref },
          period: Duration.minutes(5), statistic: 'Average',
        }),
        threshold: 80, evaluationPeriods: 3,
      }),
    ];
    for (const alarm of alarms) alarm.addAlarmAction(alarmAction);
    new events.Rule(this, 'EcsDeploymentFailureRule', {
      eventPattern: {
        source: ['aws.ecs'],
        detailType: ['ECS Deployment State Change'],
        detail: { eventName: ['SERVICE_DEPLOYMENT_FAILED'] },
      },
      targets: [new eventTargets.SnsTopic(operationsTopic)],
    });
    const dashboard = new cloudwatch.Dashboard(this, 'OperationsDashboard', {
      dashboardName: `eisenhower-${config.environment}`,
    });
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({ title: 'ALB responses', left: [loadBalancer.metrics.requestCount()] }),
      new cloudwatch.GraphWidget({ title: 'ECS CPU', left: [apiService.metricCpuUtilization(), webService.metricCpuUtilization()] }),
      new cloudwatch.AlarmStatusWidget({ title: 'Actionable alarms', alarms }),
    );

    new CfnOutput(this, 'LoadBalancerDnsName', { value: loadBalancer.loadBalancerDnsName });
    new CfnOutput(this, 'ApiRepositoryUri', { value: apiRepository.repositoryUri });
    new CfnOutput(this, 'WebRepositoryUri', { value: webRepository.repositoryUri });
    new CfnOutput(this, 'ArtifactBucketName', { value: artifacts.bucketName });
    new CfnOutput(this, 'ArtifactOpsRoleArn', { value: artifactOpsRole.roleArn });
    new CfnOutput(this, 'ClusterName', { value: cluster.clusterName });
    new CfnOutput(this, 'MigrationTaskDefinitionArn', { value: migrationTask.taskDefinitionArn });
    new CfnOutput(this, 'MigrationOpsRoleArn', { value: migrationOpsRole.roleArn });
    new CfnOutput(this, 'MigrationSubnetIds', {
      value: vpc.selectSubnets({ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }).subnetIds.join(','),
    });
    new CfnOutput(this, 'MigrationSecurityGroupId', { value: apiSecurityGroup.securityGroupId });
    new CfnOutput(this, 'OperationsTopicArn', { value: operationsTopic.topicArn });
  }
}
