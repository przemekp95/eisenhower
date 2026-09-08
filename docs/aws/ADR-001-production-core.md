# ADR-001: Governed AWS production core

**Status:** accepted for implementation; runtime acceptance pending paid staging evidence
**Date:** 2026-09-07
**Target:** one owner-approved AWS account (`802954286692`), `eu-central-1`, with environment-separated stacks and roles

## Context and gaps

The application already has a Node API/web boundary, immutable release SHAs, an application `TaskRepository` port, MongoDB persistence, a transactional MongoDB Calendar outbox, and local AI candidate governance. It did not have a deployable AWS topology, cloud database adapter, shared rate limiting, immutable cloud artifact registry, environment-scoped deployment identity, or AWS runtime evidence.

The source job description asks for production AWS, TypeScript/Node, PostgreSQL, Redis, object storage, CI/CD, security, observability, and operational ownership. Source: :codex-file-citation{path="/home/przemekp95/Pobrane/JD - 30527 Full-Stack Engineer, Backend and Cloud Infrastructure - WeAsWeb.pdf" purpose="source"}.

## Decision

- Use CDK v2/TypeScript as the infrastructure source of truth. Synthesis must work offline with explicit `eu-central-1a` and `eu-central-1b`; this deliberately trades AZ-name portability for deterministic, credential-free review.
- Split deployment into identity, immutable ECR registries, and the paid platform. Initial order is ECR, exact-SHA ARM64 images, platform with services at zero, one-shot database migration, then service activation.
- Run one public HTTPS ALB and private Fargate web/API tasks. Staging uses one task per service and one NAT gateway; production uses at least two tasks per service and two NAT gateways.
- Use encrypted private RDS PostgreSQL 16 with automated backups/PITR, a separate admin secret for migrations, and a restricted application login created by the migration task.
- Preserve 24-hex task identifiers and the existing task port. Prisma is an infrastructure adapter. MongoDB-to-PostgreSQL migration is repeatable and checksum-verified; final parity requires a write freeze. No synchronous dual-write is introduced.
- Keep Calendar and its MongoDB transaction/outbox on MongoDB until that bounded context is migrated atomically. PostgreSQL composition disables Calendar instead of pretending cross-store atomicity.
- Use encrypted private Valkey/Redis for the shared API rate-limit store. Do not add a distributed lock without a demonstrated multi-instance critical section; the existing Calendar outbox already owns its lease semantics.
- Use a private, versioned S3 bucket for checksum-addressed model/candidate artifacts. Writes are conditional and immutable. S3 is not used as a vague filesystem replacement and production never silently falls back to local disk.
- Use one account-level GitHub OIDC provider with separate GitHub environment subjects and deployment roles for `staging` and `production`. Identity, staging and production use distinct CDK bootstrap qualifiers (`eisnidt`, `eisnstg`, `eisnprd`); the GitHub roles can assume only their environment qualifier plus tagged environment operator roles. Static AWS access keys are prohibited.
- Emit request and security-audit JSON to CloudWatch with service, exact release SHA, request ID, pseudonymous principals, and per-event HMAC integrity. Local/Mikrus keeps its existing chained file ledger.

## Security and architecture applicability

- **CSRF/browser controls:** the API uses bearer tokens, does not use authentication cookies, sets CORS credentials to false, validates trusted browser origins for unsafe methods, and terminates public HTTP at an HTTPS redirect. Traditional cookie-CSRF tokens are therefore not applicable to this boundary.
- **HTTP transport:** ALB accepts HTTPS with ACM and redirects port 80. RDS and Valkey use encrypted transport; public workload IPs are disabled.
- **Messaging/jobs/webhooks:** the only new job is the bounded ECS migration task. Calendar messages/webhooks remain on the existing MongoDB outbox and are explicitly outside this cutover.
- **CQRS/ports and adapters:** task commands and reads share one repository contract; Mongoose and Prisma are replaceable adapters selected in the composition root. A separate CQRS model would add cost without a present read/write scaling need.
- **DDD:** Tasks and Calendar are treated as separate consistency boundaries. Shared language and lifecycle invariants remain in the application/domain layer; AWS, Prisma, Redis, and S3 remain infrastructure adapters.
- **TDD/BDD:** new behavior is developed with observed failing tests followed by passing implementation. Existing executable task scenarios remain BDD evidence; infrastructure assertions are not mislabeled as BDD.

## Consequences and open runtime evidence

The design supports horizontal API scaling, exact-image rollback, constrained identities, and incremental persistence migration. Sharing one AWS account avoids a duplicate account-level OIDC provider while retaining separate roles, names, tags, stacks and bootstrap paths. This is defense against accidental cross-environment use, not the same security boundary as separate AWS accounts: an administrator or broadly privileged CloudFormation execution policy remains account-wide. Calendar parity is not yet implemented for PostgreSQL, and all AWS availability, restore, alarm, rollback, DNS, certificate, and cost claims remain unverified until an explicitly approved staging deployment. Local synthesis and container-backed tests are implementation evidence, not production ownership evidence.

References: [GitHub OIDC in AWS](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws), [GitHub deployment environments](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments), [CDK bootstrapping](https://docs.aws.amazon.com/cdk/v2/guide/bootstrapping.html), [ECS deployment circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html), [RDS point-in-time recovery](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/USER_PIT.html), [S3 Block Public Access](https://docs.aws.amazon.com/AmazonS3/latest/userguide/access-control-block-public-access.html), [Prisma PostgreSQL](https://www.prisma.io/docs/orm/v7/core-concepts/supported-databases/postgresql).
