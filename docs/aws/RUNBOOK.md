# AWS bootstrap, migration, release, rollback, and destroy runbook

## 1. Preconditions

The owner selected account `802954286692` as the single AWS account for all of their AWS projects, including Eisenhower. Eisenhower owns one account-level GitHub OIDC provider, separate staging/production deployment roles and separately qualified CDK bootstrap paths. Do not create a second provider for the same GitHub URL. Confirm the account ID, `eu-central-1`, ACM certificate, DNS/origin, application OIDC issuer/audience/JWKS URL, external AI service URL, cost approval, owner, and expiry time. Existing non-Eisenhower resources in the account remain outside this runbook and must not be modified.

Before trusting GitHub OIDC, inspect a real token claim. The expected subject is `repo:przemekp95/eisenhower:environment:staging` or `:production`; repositories subject to newer immutable owner/repository-ID customization must put the observed exact claim into the trust policy before use.

## 2. Credential-free review

```bash
cd infra/aws
npm ci
../../.codex/verify --scope aws
```

This synthesizes both environments with lookups disabled and dummy account context. It must not access AWS.

## 3. One-time account bootstrap (explicit approval required)

An administrator first creates and independently reviews three customer-managed CloudFormation execution policies and three permissions boundaries. Their names and paths are a contract: `eisenhower/bootstrap/{identity,staging,production}-cloudformation-execution` and `eisenhower-{identity,staging,production}-permissions-boundary`. The execution policies must permit only the services and Eisenhower resource paths needed by the synthesized templates; the boundaries are the maximum permissions for every bootstrap and application role. Neither policy type may use or attach AWS-managed `AdministratorAccess`. Confirm the default policy version and document digest with `iam:GetPolicy` and `iam:GetPolicyVersion` before bootstrap.

AWS CDK's `--custom-permissions-boundary` option attaches the boundary only to `CloudFormationExecutionRole`, not to the deploy, lookup, file-publishing, or image-publishing roles. Therefore `prebootstrap:plan` generates the pinned CDK CLI template, copies its conditional boundary expression to all five `AWS::IAM::Role` resources, requires exactly five roles, and writes `dist/bootstrap-template.yaml`. Every generated command must include that template. This follows AWS's supported custom-template route; using the flag alone violates this repository's all-role boundary contract.

Set the exact non-secret identifiers below. The generator rejects another account, a non-EU region, AWS-managed or cross-account policy ARNs, unexpected boundary names, and missing input. It only prints commands; it never calls AWS.

```bash
export CDK_BOOTSTRAP_ACCOUNT=802954286692
export CDK_BOOTSTRAP_REGION=eu-central-1
export CDK_IDENTITY_EXECUTION_POLICY_ARN=arn:aws:iam::802954286692:policy/eisenhower/bootstrap/identity-cloudformation-execution
export CDK_STAGING_EXECUTION_POLICY_ARN=arn:aws:iam::802954286692:policy/eisenhower/bootstrap/staging-cloudformation-execution
export CDK_PRODUCTION_EXECUTION_POLICY_ARN=arn:aws:iam::802954286692:policy/eisenhower/bootstrap/production-cloudformation-execution
export CDK_IDENTITY_PERMISSIONS_BOUNDARY=eisenhower-identity-permissions-boundary
export CDK_STAGING_PERMISSIONS_BOUNDARY=eisenhower-staging-permissions-boundary
export CDK_PRODUCTION_PERMISSIONS_BOUNDARY=eisenhower-production-permissions-boundary
npm run bootstrap:plan
```

Only an approved administrator session may execute the three printed commands, one at a time, after checking `aws sts get-caller-identity`. Long-lived credentials belonging to an unrelated workload or service user are forbidden. The administrator records account, actor, time, CDK CLI version, bootstrap template digest, execution-policy version/digest, boundary version/digest, qualifier, CloudFormation events, and created role ARNs. Stop on the first unexpected change or denied action rather than broadening a policy during the deployment.

The reviewed commands create three current CDK v2 bootstrap stacks in account `802954286692`, region `eu-central-1`: shared identity qualifier `eisnidt`, staging qualifier `eisnstg`, and production qualifier `eisnprd`. Each has a distinct toolkit stack name. Afterward, deploy the shared `Eisenhower-GitHubOidc` stack once with administrator credentials; neither environment's GitHub role may create or update its own trust path. The stack must synthesize a native `AWS::IAM::OIDCProvider`: CDK's L2 provider uses a custom-resource Lambda and helper role that do not fit the constrained identity bootstrap path. Every synthesized IAM role carries its environment-specific boundary. Each GitHub deployment role may assume only its qualified tagged CDK bootstrap roles and its environment-specific image-publishing, migration-operator, and artifact-operator roles; it is not a direct ECS/ECR/S3 administrator.

The separate qualifiers and policies reduce accidental environment crossover but do not turn one AWS account into three security boundaries. Keep account-administrator access outside automated workflows. AWS documents that the default bootstrap grants `AdministratorAccess`, that `--cloudformation-execution-policies` replaces it with customer-managed policies, and that a custom bootstrap template is supported when CLI options are insufficient. The generated all-role template, customer-managed execution policy, and custom boundary parameter are mandatory here. See [AWS permissions-boundary behavior](https://docs.aws.amazon.com/cdk/v2/guide/customize-permissions-boundaries.html) and [custom bootstrap templates](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping-customizing.html).

Create GitHub environments `staging` and `production`. Configure environment-scoped variables referenced by the workflows. Keep `AWS_STAGING_DEPLOY_ENABLED=false` until the owner approves the bounded staging spend. Configure production reviewers where the repository plan supports them.

The current staging contract uses `https://eisenhower-staging.pietrzakprzemyslaw.pl`, ACM certificate `arn:aws:acm:eu-central-1:802954286692:certificate/3b3488e1-653d-4926-978c-39305257467a`, issuer `https://eisenhower-auth.pietrzakprzemyslaw.pl/identity/realms/eisenhower`, its `/protocol/openid-connect/certs` JWKS endpoint, audience `eisenhower-api`, and AI base URL `https://eisenhower-ai.pietrzakprzemyslaw.pl/ai`. OIDC and AI are external Cloudflare Tunnel endpoints backed by the owner-operated runtime in Poland. Verify public delegation, discovery metadata and AI readiness immediately before enabling staging; do not substitute a direct authoritative-server override for public recursive resolution.

After the platform stack exists, subscribe the approved operational receiver to `OperationsTopicArn` and confirm the SNS subscription before acceptance testing. A topic without a confirmed subscriber does not prove alert delivery.

## 4. Staging delivery

A successful CI run on exact `dev` SHA triggers `.github/workflows/aws-deploy.yml` only when the enable variable is true. The workflow:

1. deploys immutable ECR repositories;
2. publishes ARM64 API/web images tagged by the complete SHA;
3. creates the platform with both services at zero;
4. runs the one-shot PostgreSQL migration task with the admin secret;
5. creates/rotates the restricted application role and verifies migration exit code zero;
6. activates one task per service;
7. verifies HTTPS readiness for PostgreSQL and Redis and uploads evidence.

Before switching real task traffic from MongoDB, run repeatable backfills with `npm run migrate:tasks`. The final run requires `TASK_MIGRATION_MODE=final`, `MONGO_WRITES_FROZEN=true`, no resume cursor, and full count/checksum parity. The command never changes runtime configuration. Calendar must stay disabled in PostgreSQL mode until its binding/outbox/audit boundary has its own migration and reconciliation evidence.

## 5. Acceptance drills

Within the approved seven-day window capture: two-AZ placement, private IPs, TLS, exact image digests/labels, task CRUD/isolation/idempotency/revision behavior, shared rate limiting across two API tasks, S3 replay/conflict/tamper behavior, alarm delivery, ECS failed-deploy automatic rollback, RDS snapshot/PITR restore into an isolated database, and failover/recovery times. A green unit/synth result is not a substitute.

## 6. Rollback

- Application rollback selects the prior exact green SHA. Production uses the manual Release workflow with that full master SHA and `deploy=true`; staging uses a revert promoted through `dev` CI.
- ECS circuit breakers roll back tasks that fail steady state. Verify the service's primary deployment and image digest, not only workflow success.
- Database changes follow expand/contract compatibility. Do not reverse a schema destructively during application rollback. Restore/PITR is an incident path and must target an isolated instance until validated.
- Redis contains coordination/rate-limit state and may be recreated; it is not canonical business storage.
- S3 objects and manifests are immutable/versioned. Recovery selects a checksum-verified version; never overwrite lineage.

## 7. Staging destroy

Destroy staging no later than seven days unless a new approval extends it. First export the evidence bundle and final cost snapshot. Set services to zero, confirm no migration/task is running, then destroy the platform and registries with the approved account. Independently verify CloudFormation stacks, NAT gateways, ALB, ENIs, RDS, Valkey, ECR, S3, secrets, log groups, snapshots, and Route 53 records. Report every retained object and its continuing cost. Never use a broad or unresolved account/region target.
