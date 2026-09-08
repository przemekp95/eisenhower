import { Duration, Stack, StackProps, Tags } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';
import { permissionsBoundaryName } from './bootstrap-plan';
import { DeploymentEnvironment } from './platform-stack';

export interface GitHubOidcStackProps extends StackProps {
  githubOwner: string;
  githubRepository: string;
}

const DEPLOYMENT_ENVIRONMENTS: readonly DeploymentEnvironment[] = ['staging', 'production'];

export function bootstrapQualifier(environment: DeploymentEnvironment): string {
  return environment === 'staging' ? 'eisnstg' : 'eisnprd';
}

export const identityBootstrapQualifier = 'eisnidt';

export class GitHubOidcStack extends Stack {
  readonly deploymentRoles: Record<DeploymentEnvironment, iam.Role>;

  constructor(scope: Construct, id: string, props: GitHubOidcStackProps) {
    super(scope, id, props);
    iam.PermissionsBoundary.of(this).apply(iam.ManagedPolicy.fromManagedPolicyName(
      this, 'IdentityPermissionsBoundary', permissionsBoundaryName('identity'),
    ));
    Tags.of(this).add('Project', 'eisenhower');
    Tags.of(this).add('Environment', 'shared');
    Tags.of(this).add('ManagedBy', 'aws-cdk');
    Tags.of(this).add('CostCenter', 'eisenhower-aws-core');

    const provider = new iam.CfnOIDCProvider(this, 'GitHubProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIdList: ['sts.amazonaws.com'],
    });

    this.deploymentRoles = Object.fromEntries(DEPLOYMENT_ENVIRONMENTS.map((environment) => {
      const role = new iam.Role(this, `DeploymentRole-${environment}`, {
        roleName: `eisenhower-${environment}-github-deploy`,
        description: `GitHub OIDC deployment role for Eisenhower ${environment}`,
        assumedBy: new iam.WebIdentityPrincipal(provider.ref, {
          StringEquals: {
            'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
            'token.actions.githubusercontent.com:sub':
              `repo:${props.githubOwner}/${props.githubRepository}:environment:${environment}`,
          },
        }),
        maxSessionDuration: Duration.hours(1),
      });
      role.addToPolicy(new iam.PolicyStatement({
        sid: 'AssumeOnlyEnvironmentCdkBootstrapRoles',
        actions: ['sts:AssumeRole'],
        resources: [
          `arn:${this.partition}:iam::${this.account}:role/cdk-${bootstrapQualifier(environment)}-*-role-${this.account}-${this.region}`,
        ],
        conditions: { StringLike: { 'iam:ResourceTag/aws-cdk:bootstrap-role': '*' } },
      }));
      for (const [sid, roleSuffix] of [
        ['AssumeImagePublishingRole', 'image-publishing'],
        ['AssumeMigrationOperationsRole', 'migration-ops'],
        ['AssumeArtifactOperationsRole', 'artifact-ops'],
      ] as const) {
        role.addToPolicy(new iam.PolicyStatement({
          sid,
          actions: ['sts:AssumeRole', 'sts:TagSession'],
          resources: [
            `arn:${this.partition}:iam::${this.account}:role/eisenhower-${environment}-${roleSuffix}`,
          ],
          conditions: {
            StringEquals: {
              'iam:ResourceTag/Project': 'eisenhower',
              'iam:ResourceTag/Environment': environment,
            },
          },
        }));
      }
      return [environment, role];
    })) as Record<DeploymentEnvironment, iam.Role>;
  }
}
