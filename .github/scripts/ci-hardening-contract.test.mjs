import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readWorkflow = (name) => readFileSync(`.github/workflows/${name}`, "utf8");

test("every workflow uses explicit least-privilege token permissions", () => {
  const ci = readWorkflow("ci.yml");
  const release = readWorkflow("release.yml");
  const policy = readWorkflow("branch-policy.yml");
  const sync = readWorkflow("sync-master-into-dev.yml");
  const aws = readWorkflow("aws-deploy.yml");

  assert.match(ci, /^permissions:\n  contents: read$/m);
  assert.match(release, /^permissions:\n  contents: read$/m);
  assert.match(policy, /^permissions: \{\}$/m);
  assert.match(sync, /^permissions:\n  actions: write\n  contents: write\n  pull-requests: write\n  statuses: write$/m);
  assert.match(aws, /^permissions:\n  contents: read$/m);
});

test("every job has a bounded timeout and every external action is immutable", () => {
  for (const name of ["ci.yml", "release.yml", "branch-policy.yml", "sync-master-into-dev.yml", "aws-deploy.yml"]) {
    const workflow = readWorkflow(name);
    const jobsBlock = workflow.split(/^jobs:\s*$/m)[1];
    const jobCount = (jobsBlock.match(/^  [a-z0-9][a-z0-9-]*:\s*$/gm) ?? []).length;
    const timeoutCount = (jobsBlock.match(/^    timeout-minutes: \d+\s*$/gm) ?? []).length;
    assert.equal(timeoutCount, jobCount, `${name} must bound every job`);
    assert.doesNotMatch(workflow, /^\s+uses: [^\s]+@v\d+(?:\.\d+)*\s*$/m, `${name} has a movable action tag`);

    for (const [, action, ref] of workflow.matchAll(/^\s+uses: ([^\s@]+)@([^\s#]+)/gm)) {
      if (!action.startsWith("./")) {
        assert.match(ref, /^[a-f0-9]{40}$/, `${name} must pin ${action} to a full commit SHA`);
      }
    }
  }
});

test("AWS staging delivery uses environment-scoped OIDC and immutable green SHAs without static keys", () => {
  const aws = readWorkflow("aws-deploy.yml");
  const release = readWorkflow("release.yml");
  const deploymentGate = aws.split(/^  staging-deployment-gate:\s*$/m)[1]?.split(/^  deploy-staging:\s*$/m)[0] ?? "";
  const deployJob = aws.split(/^  deploy-staging:\s*$/m)[1] ?? "";

  assert.match(aws, /workflow_run:[\s\S]*branches:\n      - dev/);
  assert.match(aws, /workflow_dispatch:[\s\S]*release_sha:/);
  assert.match(deploymentGate, /environment: staging/);
  assert.match(deploymentGate, /DEPLOY_ENABLED: \$\{\{ vars\.AWS_STAGING_DEPLOY_ENABLED \}\}/);
  assert.match(deploymentGate, /enabled: \$\{\{ steps\.gate\.outputs\.enabled \}\}/);
  assert.match(deployJob, /needs: staging-deployment-gate/);
  assert.match(deployJob, /needs\.staging-deployment-gate\.outputs\.enabled == 'true'/);
  assert.doesNotMatch(deployJob, /vars\.AWS_STAGING_DEPLOY_ENABLED == 'true'/);
  assert.match(aws, /environment: staging/);
  assert.match(aws, /actions: read/);
  assert.match(aws, /id-token: write/);
  assert.match(aws, /role-to-assume: \$\{\{ vars\.AWS_STAGING_DEPLOY_ROLE_ARN \}\}/);
  assert.match(aws, /github\.event\.workflow_run\.head_sha/);
  assert.match(aws, /git\/ref\/heads\/dev/);
  assert.match(aws, /actions\/workflows\/ci\.yml\/runs\?branch=dev&event=push&status=success/);
  assert.match(aws, /Eisenhower-staging-Registries/);
  assert.match(aws, /role-to-assume: \$\{\{ steps\.registries\.outputs\.image_publishing_role_arn \}\}/);
  assert.match(aws, /Eisenhower-staging-Platform/);
  assert.match(aws, /role-to-assume: \$\{\{ steps\.platform-stopped\.outputs\.migration_ops_role_arn \}\}/);
  assert.match(aws, /load_balancer_dns_name=\$load_balancer_dns_name/);
  assert.match(aws, /::notice title=Cloudflare DNS target::/);
  assert.match(aws, /--retry 60 --retry-all-errors --retry-delay 15/);
  assert.match(aws, /Restore AWS OIDC deployment identity after migration/);

  assert.doesNotMatch(release, /AWS_/);
  assert.doesNotMatch(aws, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(aws, /--force-new-deployment/);
  assert.match(readWorkflow("ci.yml"), /\.codex\/verify --scope aws/);
});

test("release and master synchronization are serialized and exact-SHA gated", () => {
  const release = readWorkflow("release.yml");
  const sync = readWorkflow("sync-master-into-dev.yml");
  const ci = readWorkflow("ci.yml");

  assert.match(release, /group: release-production/);
  assert.match(release, /release-preflight:[\s\S]*run: node \.github\/scripts\/release-preflight\.mjs/);
  assert.doesNotMatch(release, /run:[^\n]*\$\{\{ inputs\.release_sha \}\}/);
  assert.match(release, /RELEASE_SHA_INPUT: \$\{\{ inputs\.release_sha \}\}/);
  assert.match(sync, /group: sync-master-into-dev/);
  assert.match(sync, /context=ci\/master-exact-sha-reuse/);
  assert.match(ci, /\.context == "ci\/master-exact-sha-reuse"/);
});

test("CI service and scanner images are immutable", () => {
  const ci = readWorkflow("ci.yml");
  assert.match(ci, /mongo:7@sha256:[a-f0-9]{64}/);
  assert.match(ci, /postgres:16-alpine@sha256:[a-f0-9]{64}/);
  assert.match(ci, /redis:7-alpine@sha256:[a-f0-9]{64}/);
  assert.match(ci, /qdrant\/qdrant:v1\.12\.0@sha256:[a-f0-9]{64}/);
  assert.match(ci, /aquasec\/trivy:0\.71\.1@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(ci, /aquasec\/trivy:0\.63\.0/);
});

test("backend CI runs PostgreSQL and Redis integration coverage", () => {
  const ci = readWorkflow("ci.yml");
  const backendJob = ci.split(/^  test-backend-node:\s*$/m)[1].split(/^  test-api-client:\s*$/m)[0];

  assert.match(backendJob, /pg_isready -U eisenhower -d eisenhower/);
  assert.match(backendJob, /redis-cli ping/);
  assert.match(backendJob, /npx prisma migrate deploy/);
  assert.match(backendJob, /POSTGRES_TEST_URL: postgresql:\/\/eisenhower:eisenhower_test@127\.0\.0\.1:33196\/eisenhower/);
  assert.match(backendJob, /REDIS_TEST_URL: redis:\/\/127\.0\.0\.1:33197/);
});

test("release image analysis allows large ROCm layers to exceed Trivy's five-minute default", () => {
  const release = readWorkflow("release.yml");
  const invocations = release.match(/"\$TRIVY_IMAGE" image \\\n(?:\s+.*\\\n)+?\s+"\$image_ref"/g) ?? [];

  assert.equal(invocations.length, 2, "release must scan vulnerabilities and generate an SBOM");
  for (const invocation of invocations) {
    assert.match(invocation, /\s+--timeout 15m \\\n/);
  }
});
