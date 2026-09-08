import { CfnOutput, Duration, RemovalPolicy, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { permissionsBoundaryName } from './bootstrap-plan';
import type { DeploymentEnvironment } from './platform-stack';

export function containerRepositoryNames(environment: DeploymentEnvironment) {
  return {
    api: `eisenhower-${environment}-api`,
    web: `eisenhower-${environment}-web`,
  } as const;
}

export interface ContainerRegistryStackProps extends StackProps {
  deploymentEnvironment: DeploymentEnvironment;
}

export class ContainerRegistryStack extends Stack {
  constructor(scope: Construct, id: string, props: ContainerRegistryStackProps) {
    super(scope, id, props);
    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(
      this, 'WorkloadPermissionsBoundary', permissionsBoundaryName(props.deploymentEnvironment),
    ));
    const production = props.deploymentEnvironment === 'production';
    const names = containerRepositoryNames(props.deploymentEnvironment);

    Tags.of(this).add('Project', 'eisenhower');
    Tags.of(this).add('Environment', props.deploymentEnvironment);
    Tags.of(this).add('ManagedBy', 'aws-cdk');
    Tags.of(this).add('CostCenter', 'eisenhower-aws-core');

    const repositories = [] as ecr.Repository[];
    for (const [id, repositoryName] of [['Api', names.api], ['Web', names.web]] as const) {
      repositories.push(new ecr.Repository(this, `${id}Repository`, {
        repositoryName,
        imageScanOnPush: true,
        imageTagMutability: ecr.TagMutability.IMMUTABLE,
        lifecycleRules: [{ maxImageCount: 25 }],
        removalPolicy: production ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
        emptyOnDelete: !production,
      }));
    }
    const imagePublishingRole = new iam.Role(this, 'ImagePublishingRole', {
      roleName: `eisenhower-${props.deploymentEnvironment}-image-publishing`,
      description: `Narrow CI role for Eisenhower ${props.deploymentEnvironment} container images`,
      assumedBy: new iam.ArnPrincipal(
        `arn:${this.partition}:iam::${this.account}:role/eisenhower-${props.deploymentEnvironment}-github-deploy`,
      ).withSessionTags(),
      maxSessionDuration: Duration.hours(1),
    });
    for (const repository of repositories) repository.grantPullPush(imagePublishingRole);
    new CfnOutput(this, 'ImagePublishingRoleArn', { value: imagePublishingRole.roleArn });
  }
}
