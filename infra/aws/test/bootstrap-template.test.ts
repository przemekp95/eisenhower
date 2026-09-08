import { applyBootstrapBoundaryToAllRoles } from '../lib/bootstrap-template';

test('applies the configured permissions boundary to every bootstrap IAM role', () => {
  const boundary = {
    'Fn::If': [
      'PermissionsBoundarySet',
      { 'Fn::Sub': 'arn:${AWS::Partition}:iam::${AWS::AccountId}:policy/${InputPermissionsBoundary}' },
      { Ref: 'AWS::NoValue' },
    ],
  };
  const template = {
    Resources: {
      FilePublishingRole: { Type: 'AWS::IAM::Role', Properties: {} },
      CloudFormationExecutionRole: {
        Type: 'AWS::IAM::Role',
        Properties: { PermissionsBoundary: boundary },
      },
      StagingBucket: { Type: 'AWS::S3::Bucket', Properties: {} },
    },
  };

  const result = applyBootstrapBoundaryToAllRoles(template);

  expect(result.roleCount).toBe(2);
  expect(result.template.Resources.FilePublishingRole.Properties!.PermissionsBoundary).toEqual(boundary);
  expect(result.template.Resources.CloudFormationExecutionRole.Properties!.PermissionsBoundary).toEqual(boundary);
  expect(result.template.Resources.StagingBucket.Properties).not.toHaveProperty('PermissionsBoundary');
});

test('fails closed when the canonical execution role has no boundary expression', () => {
  expect(() => applyBootstrapBoundaryToAllRoles({
    Resources: {
      CloudFormationExecutionRole: { Type: 'AWS::IAM::Role', Properties: {} },
    },
  })).toThrow(/CloudFormationExecutionRole permissions boundary/);
});
