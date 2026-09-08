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
  }
});

test("AWS delivery uses environment-scoped OIDC and immutable green SHAs without static keys", () => {
  const aws = readWorkflow("aws-deploy.yml");
  const release = readWorkflow("release.yml");

  assert.match(aws, /workflow_run:[\s\S]*branches:\n      - dev/);
  assert.match(aws, /environment: staging/);
  assert.match(aws, /id-token: write/);
  assert.match(aws, /role-to-assume: \$\{\{ vars\.AWS_STAGING_DEPLOY_ROLE_ARN \}\}/);
  assert.match(aws, /github\.event\.workflow_run\.head_sha/);
  assert.match(aws, /Eisenhower-staging-Registries/);
  assert.match(aws, /role-to-assume: \$\{\{ steps\.registries\.outputs\.image_publishing_role_arn \}\}/);
  assert.match(aws, /Eisenhower-staging-Platform/);
  assert.match(aws, /role-to-assume: \$\{\{ steps\.platform-stopped\.outputs\.migration_ops_role_arn \}\}/);
  assert.match(aws, /Restore AWS OIDC deployment identity after migration/);

  assert.match(release, /environment: production/);
  assert.match(release, /id-token: write/);
  assert.match(release, /role-to-assume: \$\{\{ vars\.AWS_PRODUCTION_DEPLOY_ROLE_ARN \}\}/);
  assert.match(release, /role-to-assume: \$\{\{ steps\.registries\.outputs\.image_publishing_role_arn \}\}/);
  assert.match(release, /role-to-assume: \$\{\{ steps\.platform-stopped\.outputs\.migration_ops_role_arn \}\}/);
  assert.match(release, /Restore production AWS OIDC identity after migration/);
  assert.doesNotMatch(`${aws}\n${release}`, /AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY/);
  assert.doesNotMatch(`${aws}\n${release}`, /--force-new-deployment/);
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
  assert.match(ci, /qdrant\/qdrant:v1\.12\.0@sha256:[a-f0-9]{64}/);
  assert.match(ci, /aquasec\/trivy:0\.71\.1@sha256:[a-f0-9]{64}/);
  assert.doesNotMatch(ci, /aquasec\/trivy:0\.63\.0/);
});
