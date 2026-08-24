import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const readWorkflow = (name) => readFileSync(`.github/workflows/${name}`, "utf8");

test("every workflow uses explicit least-privilege token permissions", () => {
  const ci = readWorkflow("ci.yml");
  const release = readWorkflow("release.yml");
  const policy = readWorkflow("branch-policy.yml");
  const sync = readWorkflow("sync-master-into-dev.yml");

  assert.match(ci, /^permissions:\n  contents: read$/m);
  assert.match(release, /^permissions:\n  contents: read$/m);
  assert.match(policy, /^permissions: \{\}$/m);
  assert.match(sync, /^permissions:\n  actions: write\n  contents: write\n  pull-requests: write\n  statuses: write$/m);
});

test("every job has a bounded timeout and every external action is immutable", () => {
  for (const name of ["ci.yml", "release.yml", "branch-policy.yml", "sync-master-into-dev.yml"]) {
    const workflow = readWorkflow(name);
    const jobsBlock = workflow.split(/^jobs:\s*$/m)[1];
    const jobCount = (jobsBlock.match(/^  [a-z0-9][a-z0-9-]*:\s*$/gm) ?? []).length;
    const timeoutCount = (jobsBlock.match(/^    timeout-minutes: \d+\s*$/gm) ?? []).length;
    assert.equal(timeoutCount, jobCount, `${name} must bound every job`);
    assert.doesNotMatch(workflow, /^\s+uses: [^\s]+@v\d+(?:\.\d+)*\s*$/m, `${name} has a movable action tag`);
  }
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

test("release image analysis allows large ROCm layers to exceed Trivy's five-minute default", () => {
  const release = readWorkflow("release.yml");
  const invocations = release.match(/"\$TRIVY_IMAGE" image \\\n(?:\s+.*\\\n)+?\s+"\$image_ref"/g) ?? [];

  assert.equal(invocations.length, 2, "release must scan vulnerabilities and generate an SBOM");
  for (const invocation of invocations) {
    assert.match(invocation, /\s+--timeout 15m \\\n/);
  }
});
