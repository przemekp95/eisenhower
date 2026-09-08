export type BootstrapEnvironment = 'identity' | 'staging' | 'production';

export interface BootstrapPlanInput {
  account: string;
  region: string;
  executionPolicyArns: Record<BootstrapEnvironment, string>;
  permissionsBoundaryNames: Record<BootstrapEnvironment, string>;
}

export interface BootstrapPlanEntry {
  environment: BootstrapEnvironment;
  qualifier: string;
  toolkitStackName: string;
  args: string[];
}

const APPROVED_ACCOUNT = '802954286692';
const APPROVED_REGION = 'eu-central-1';
const BOOTSTRAP = {
  identity: { qualifier: 'eisnidt', toolkitStackName: 'CDKToolkit-EisenhowerIdentity' },
  staging: { qualifier: 'eisnstg', toolkitStackName: 'CDKToolkit-EisenhowerStaging' },
  production: { qualifier: 'eisnprd', toolkitStackName: 'CDKToolkit-EisenhowerProduction' },
} as const satisfies Record<BootstrapEnvironment, {
  qualifier: string;
  toolkitStackName: string;
}>;

function expectedExecutionPolicyArn(environment: BootstrapEnvironment): string {
  return `arn:aws:iam::${APPROVED_ACCOUNT}:policy/eisenhower/bootstrap/${environment}-cloudformation-execution`;
}

export function permissionsBoundaryName(environment: BootstrapEnvironment): string {
  return `eisenhower-${environment}-permissions-boundary`;
}

export function buildBootstrapPlan(input: BootstrapPlanInput): BootstrapPlanEntry[] {
  if (input.account !== APPROVED_ACCOUNT) {
    throw new Error(`bootstrap account must be ${APPROVED_ACCOUNT}`);
  }
  if (input.region !== APPROVED_REGION) {
    throw new Error(`bootstrap region must be ${APPROVED_REGION}`);
  }

  return (Object.keys(BOOTSTRAP) as BootstrapEnvironment[]).map((environment) => {
    const executionPolicyArn = input.executionPolicyArns[environment];
    const boundaryName = input.permissionsBoundaryNames[environment];
    if (executionPolicyArn !== expectedExecutionPolicyArn(environment)) {
      throw new Error(`${environment} must use its approved customer-managed execution policy`);
    }
    if (boundaryName !== permissionsBoundaryName(environment)) {
      throw new Error(`${environment} must use its approved permissions boundary`);
    }
    const { qualifier, toolkitStackName } = BOOTSTRAP[environment];
    return {
      environment,
      qualifier,
      toolkitStackName,
      args: [
        'exec', '--', 'cdk', 'bootstrap',
        `aws://${input.account}/${input.region}`,
        '--qualifier', qualifier,
        '--toolkit-stack-name', toolkitStackName,
        '--template', 'dist/bootstrap-template.yaml',
        '--cloudformation-execution-policies', executionPolicyArn,
        '--custom-permissions-boundary', boundaryName,
        '--tags', 'Project=eisenhower',
        '--tags', `Environment=${environment === 'identity' ? 'shared' : environment}`,
        '--tags', 'ManagedBy=aws-cdk',
      ],
    };
  });
}

function required(environment: Record<string, string | undefined>, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

export function bootstrapPlanFromEnvironment(
  environment: Record<string, string | undefined>,
): BootstrapPlanEntry[] {
  return buildBootstrapPlan({
    account: required(environment, 'CDK_BOOTSTRAP_ACCOUNT'),
    region: required(environment, 'CDK_BOOTSTRAP_REGION'),
    executionPolicyArns: {
      identity: required(environment, 'CDK_IDENTITY_EXECUTION_POLICY_ARN'),
      staging: required(environment, 'CDK_STAGING_EXECUTION_POLICY_ARN'),
      production: required(environment, 'CDK_PRODUCTION_EXECUTION_POLICY_ARN'),
    },
    permissionsBoundaryNames: {
      identity: required(environment, 'CDK_IDENTITY_PERMISSIONS_BOUNDARY'),
      staging: required(environment, 'CDK_STAGING_PERMISSIONS_BOUNDARY'),
      production: required(environment, 'CDK_PRODUCTION_PERMISSIONS_BOUNDARY'),
    },
  });
}

export function formatBootstrapCommand(entry: BootstrapPlanEntry): string {
  return ['npm', ...entry.args].join(' ');
}
