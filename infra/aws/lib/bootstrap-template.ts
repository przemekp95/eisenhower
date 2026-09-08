export interface BootstrapTemplateResource {
  Type?: string;
  Properties?: Record<string, unknown>;
}

export interface BootstrapTemplate {
  Resources: Record<string, BootstrapTemplateResource>;
  [key: string]: unknown;
}

export interface HardenedBootstrapTemplate {
  template: BootstrapTemplate;
  roleCount: number;
}

export function applyBootstrapBoundaryToAllRoles(
  source: BootstrapTemplate,
): HardenedBootstrapTemplate {
  const template = structuredClone(source);
  const executionRole = template.Resources.CloudFormationExecutionRole;
  const boundary = executionRole?.Properties?.PermissionsBoundary;
  if (!boundary) {
    throw new Error('CloudFormationExecutionRole permissions boundary is required');
  }

  const roles = Object.values(template.Resources).filter(
    (resource) => resource.Type === 'AWS::IAM::Role',
  );
  for (const role of roles) {
    role.Properties ??= {};
    role.Properties.PermissionsBoundary = structuredClone(boundary);
  }

  return { template, roleCount: roles.length };
}
