# AWS bootstrap evidence

## 2026-09-08 policy foundation

- Observed at: `2026-09-08T14:38:29+02:00`
- Account: `802954286692`
- Console/CloudShell region: `eu-central-1`
- Actor read back by STS: account root
- Access Analyzer result before creation: zero `ERROR` findings for every document
- Attachment count after creation: zero for every policy

| Policy | Version | Canonical AWS read-back SHA-256 |
| --- | --- | --- |
| `identity-cloudformation-execution` | `v1` | `24fbd2b779c743ef3612607e780c8a9d442ee3624b104d2d46774d4bcd34cf4d` |
| `staging-cloudformation-execution` | `v1` | `9b384548932ac698540219697a9caf4461b317a9da19a7be67837f09c11cd12a` |
| `production-cloudformation-execution` | `v1` | `1345c1b72fe0bfedcae04e4636b52b4d2933707a1ac1d3a1415e4edb5bd96fae` |
| `eisenhower-identity-permissions-boundary` | `v1` | `11aad328bae8bfcd529fe0416e07776e687580c917a2ea116b9429505f98b7ca` |
| `eisenhower-staging-permissions-boundary` | `v1` | `42c3428f9c0791013fc7dcee045dfe3492d354c787fc1b198420ead1ed5d6ef0` |
| `eisenhower-production-permissions-boundary` | `v1` | `70a880d2a5f1c3f3f74fff44c64caf00fa77808e4351f0fe1df4f959d2edb34d` |

The identity execution policy and boundary were later narrowed and advanced to `v2` during the first identity deployment. The only added access is `ssm:GetParameter`/`ssm:GetParameters` on the exact identity bootstrap version parameter; Access Analyzer returned zero `ERROR` findings for both final documents.

| Updated policy | Version | Canonical AWS read-back SHA-256 |
| --- | --- | --- |
| `identity-cloudformation-execution` | `v2` | `b491ce3fc6895b0cc4e1256f9aac34496133ab20a36dae12bf95cdd28e4a7cde` |
| `eisenhower-identity-permissions-boundary` | `v2` | `91bdac8c7e5e5484f10753f92ff9ef23e7dc40906c4eb8552b1c89ebdf0fc1e7` |

No CDK bootstrap stack or application resource was created in this step. Root credentials were used only through the existing MFA-protected console session; no root access key was created, viewed, or changed.

## 2026-09-08 CDK bootstrap execution

- Authorized at: `2026-09-08T15:07:59+02:00`
- Account/region: `802954286692` / `eu-central-1`
- Actor: account root through the existing MFA-protected console session
- CDK CLI: `2.1140.0` (`5b77563`)
- Canonical default template SHA-256: `ed382e6eaab4bfddfe9b4fdb5a81fed0dfb7cc1dc6118fb11c41a0381377e89f`
- Hardened all-role template SHA-256: `da42a89c5efab101e715e14ec64e13c991fb81a7c557d80679ec88a98595c373`
- Bootstrap contract version: `32` for every qualifier

The first identity run exposed that CDK's standard `--custom-permissions-boundary` option sets the boundary only on `CloudFormationExecutionRole`. Further environments were stopped. The repository then generated a custom template from the pinned CLI and applied the same conditional boundary expression to all five bootstrap IAM roles. Identity was updated with that template before staging and production were created. AWS read-back confirmed 5/5 roles use the correct environment boundary in each stack.

| Environment | Qualifier | Stack | Final status | Asset bucket | ECR encryption |
| --- | --- | --- | --- | --- | --- |
| identity | `eisnidt` | `CDKToolkit-EisenhowerIdentity` | `UPDATE_COMPLETE` | `cdk-eisnidt-assets-802954286692-eu-central-1` | `AES256` |
| staging | `eisnstg` | `CDKToolkit-EisenhowerStaging` | `CREATE_COMPLETE` | `cdk-eisnstg-assets-802954286692-eu-central-1` | `AES256` |
| production | `eisnprd` | `CDKToolkit-EisenhowerProduction` | `CREATE_COMPLETE` | `cdk-eisnprd-assets-802954286692-eu-central-1` | `AES256` |

Each asset bucket reports region `eu-central-1`, `aws:kms` server-side encryption, and all four S3 public-access-block settings as `true`. No application stack, database, cache, load balancer, NAT gateway, ECS service, image, or application artifact was deployed. No payment method was viewed or edited. Production application deployment remains unauthorized.

## 2026-09-08 GitHub OIDC identity deployment

- Account/region: `802954286692` / `eu-central-1`
- Stack: `Eisenhower-GitHubOidc`
- Final status: `CREATE_COMPLETE`
- Stack ARN: `arn:aws:cloudformation:eu-central-1:802954286692:stack/Eisenhower-GitHubOidc/417728b0-ab8e-11f1-9fcf-0ac0fbc85b65`
- Final assembly SHA-256: `5842cd9c3de2d11fe72d91e3a894811331357163f80084d7883a38af62aa7eb4`

The first synthesis used CDK's L2 OIDC provider, which creates a custom-resource Lambda and a randomly named helper role. Deployment stopped when the constrained execution path denied attaching policy to that helper. The failed stack and its exact helper role were removed, and read-back confirmed that neither the failed stack nor an orphan provider/role remained. The implementation was then changed under a RED-GREEN test to native `AWS::IAM::OIDCProvider`, eliminating the Lambda and helper role instead of widening IAM.

Final AWS read-back confirms one provider at `arn:aws:iam::802954286692:oidc-provider/token.actions.githubusercontent.com`, client ID `sts.amazonaws.com`, and the shared Eisenhower tags. Roles `eisenhower-staging-github-deploy` and `eisenhower-production-github-deploy` both carry `eisenhower-identity-permissions-boundary`; their trust policies accept only their matching GitHub environment subject and `sts.amazonaws.com` audience.

The GitHub `staging` environment now exists with account `802954286692`, deploy role `arn:aws:iam::802954286692:role/eisenhower-staging-github-deploy`, and `AWS_STAGING_DEPLOY_ENABLED=false`. The owner's `2026-09-08T16:10:54+02:00` direction removes pending tax read-back as a staging blocker, but does not relax the USD 38/7-day cap, EU-only region, production prohibition, or card-selection stop.

## 2026-09-08 staging DNS and certificate preparation

- Domain: `pietrzakprzemyslaw.pl`
- Registrar: SEOHOST
- Authoritative DNS target: Cloudflare Free, zone `dd6ae39166274f0f75c98e4267fdeb0d`
- Assigned nameservers: `cora.ns.cloudflare.com`, `eugene.ns.cloudflare.com`
- ACM region: `eu-central-1`
- Certificate ARN: `arn:aws:acm:eu-central-1:802954286692:certificate/3b3488e1-653d-4926-978c-39305257467a`
- Certificate name: `eisenhower-staging.pietrzakprzemyslaw.pl`

The live Cyber_Folks zone was copied into Cloudflare before delegation. Website, mail, autodiscovery, MX, SRV, DKIM, DMARC, Google verification and the three legacy application A records were kept DNS-only; the imported `localhost` record was removed. Both assigned Cloudflare nameservers returned the expected website and mail records before the registrar change. Registry DNSSEC was off because the parent returned no DS record.

SEOHOST accepted the two Cloudflare nameservers and removed all three prior `cyberfolks.pl` nameservers. Cloudflare marks the zone active and its assigned authoritative servers return the migrated records, but the resolver observed during the final check still returned the previous Cyber_Folks delegation. Delegation convergence therefore remains open and must be rechecked before staging acceptance. A DNS-only ACM validation CNAME is published by both Cloudflare nameservers, and AWS ACM returned `ISSUED`. The earlier nested-name certificate was unused and was deleted together with its obsolete validation record. No application DNS target has been created.

The reserved staging addresses are:

- public origin: `https://eisenhower-staging.pietrzakprzemyslaw.pl`;
- application OIDC issuer: `https://eisenhower-auth.pietrzakprzemyslaw.pl/identity/realms/eisenhower`;
- application OIDC JWKS: `https://eisenhower-auth.pietrzakprzemyslaw.pl/identity/realms/eisenhower/protocol/openid-connect/certs`;
- OIDC audience: `eisenhower-api`;
- external AI service: `https://eisenhower-ai.pietrzakprzemyslaw.pl/ai`.

The OIDC and AI names are Cloudflare Tunnel routes to the existing owner-operated Eisenhower runtime in Poland. Direct checks against Cloudflare's authoritative edge returned the expected Keycloak issuer/JWKS metadata, AI readiness `200`, and Node readiness with healthy database and AI dependencies. The `eisenhower-web` Keycloak client allows both the existing local callback and the future AWS staging callback. GitHub's `staging` environment contains the certificate, public-origin, OIDC and AI variables, while `AWS_STAGING_DEPLOY_ENABLED` remains `false`. The current AWS platform stack deploys only the Node API and web application and consumes OIDC and AI as external inputs. The complete working-tree gate passed after PostgreSQL/Redis integration setup, including 288 Node, 217 web, 826 AI and 199 mobile tests; the deployment still requires delegation convergence and the same result on a committed/pushed exact SHA. None of those checks is replaced by the tunnel smoke test.
