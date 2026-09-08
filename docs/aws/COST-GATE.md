# AWS cost gate

**Estimate date:** 2026-09-07
**Region:** `eu-central-1`
**Pricing basis:** public on-demand list prices, 730-hour month, ARM64 Fargate, before VAT

| Cost group | Staging assumption | Production assumption |
| --- | --- | --- |
| Fargate | 1 API (0.5 vCPU/1 GiB) + 1 web (0.25 vCPU/0.5 GiB) | 2 of each |
| RDS PostgreSQL | `db.t4g.micro`, Single-AZ, 20 GiB gp3 | `db.t4g.small` to `medium`, Multi-AZ, 20 GiB gp3 |
| Valkey | 1 `cache.t4g.micro` | 2 `cache.t4g.micro`, Multi-AZ failover |
| Network | 1 ALB, 1 NAT gateway, 2 AZ | 1 ALB, 2 NAT gateways, 2 AZ |
| Other | ECR, S3, CloudWatch, Secrets Manager, public IPv4, light traffic | same with higher logs/traffic/retention |

Estimated steady-state total:

- staging: **USD 123-145/month**;
- production: **USD 248-362/month**;
- bounded seven-day staging exercise: **USD 30-38**.

The largest avoidable staging cost is the NAT gateway. One NAT is an explicit non-HA staging compromise; production uses two. S3 has a free gateway endpoint. Four interface endpoints across two AZs would add roughly USD 70/month and do not remove every public-egress need, so they are not in the initial topology.

The estimate excludes VAT, domain registration, AWS Support, meaningful internet/NAT transfer, an AWS-hosted AI service, unexpected log volume, retained snapshots/objects/images after deletion, and incident-driven scaling. For this exercise, OIDC and AI reuse the existing owner-operated runtime in Poland through Cloudflare Tunnel and add no AWS-hosted AI or Keycloak resources to the estimate. Retained production RDS snapshots, S3 versions, ECR images, secrets, and CloudWatch logs can continue to cost money after compute is removed.

## Authorization boundary

The repository owner accepted a maximum **USD 38 before VAT** for one staging exercise lasting no more than seven days, recorded on `2026-09-08T10:32:08+02:00` and expiring on `2026-09-15T10:32:08+02:00`. This approval does not renew automatically and does not authorize production.

Any account-registration or billing flow must stop before card selection. This approval does not authorize selecting a card, entering or reusing payment-card data, confirming a payment method, starting a paid subscription, or accepting a charge. Those actions require a new explicit instruction at the final reviewed screen.

At `2026-09-08T13:26:19+02:00` the owner confirmed that account `802954286692` is their single shared AWS account and placed Eisenhower staging within its scope. The USD 38 staging approval is therefore bound to that exact account and only `eu-central-1`. Existing resources for other projects remain excluded. The owner-authorized AWS Tax registrations update was submitted using the current Polish Ministry of Finance/VIES taxpayer name, active EU VAT TRN and legal address. AWS reports that TRN verification is in progress and will notify the owner by email; the table still renders the prior values until that process completes, so business-tax display is not yet accepted. No payment method was viewed or edited. At `2026-09-08T15:07:59+02:00` the owner explicitly authorized the three CDK bootstrap stacks despite the pending tax read-back, within the existing USD 38 cap and card-selection prohibition. At `2026-09-08T16:10:54+02:00` the owner further directed that staging work must not wait for the tax read-back. Pending tax verification is therefore an accepted invoicing/display risk and no longer a staging prerequisite. The certificate, public origin, external OIDC and external AI inputs are now configured and the full working-tree repository gate is green. Staging application provisioning still requires public DNS delegation convergence plus an authorized committed/pushed exact SHA whose CI is green; `AWS_STAGING_DEPLOY_ENABLED` remains `false`. This does not authorize production, a higher/longer spend, or any payment-card action. The locally configured `pp-solutions-render-storage` service user is explicitly unsuitable: it cannot inspect CloudFormation or IAM and must not be broadened for this deployment.

Official machine-readable price lists: [ECS/Fargate](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonECS/current/eu-central-1/index.json), [ELB](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSELB/current/eu-central-1/index.json), [RDS](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonRDS/current/eu-central-1/index.json), [ElastiCache](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonElastiCache/current/eu-central-1/index.json), [VPC](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonVPC/current/eu-central-1/index.json), [S3](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonS3/current/eu-central-1/index.json), [CloudWatch](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AmazonCloudWatch/current/eu-central-1/index.json), [Secrets Manager](https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws/AWSSecretsManager/current/eu-central-1/index.json).
