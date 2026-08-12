import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  ALL_TARGETS,
  PLAN_VERSION,
  buildImpactPlan,
  parseNameStatusZ,
} from "./ci-impact-plan.mjs";

const change = (status, path, previousPath) => ({ status, path, previousPath });

test("a backend HTTP change selects backend, BDD, browser integration, and consumers", () => {
  const plan = buildImpactPlan({
    eventName: "pull_request",
    refName: "feature/http",
    mergeBase: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: [change("M", "backend-node/src/routes/tasks.ts")],
  });

  assert.equal(plan.version, PLAN_VERSION);
  assert.equal(plan.fullCi, false);
  assert.deepEqual(plan.targets, [
    "api-client",
    "backend-node",
    "frontend-e2e",
    "frontend-integration",
    "mcp",
    "mobile",
    "n8n",
    "web",
  ]);
  assert.match(plan.reasons["backend-node"][0], /backend-node/);
  assert.match(plan.inputDigest, /^sha256:[a-f0-9]{64}$/);
});

test("contract changes propagate through every HTTP and browser consumer", () => {
  const plan = buildImpactPlan({
    eventName: "pull_request",
    refName: "feature/contracts",
    mergeBase: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: [change("M", "contracts/quadrants.json")],
  });

  assert.deepEqual(plan.targets, [
    "api-client",
    "backend-ai",
    "backend-node",
    "frontend-e2e",
    "frontend-integration",
    "mcp",
    "mobile",
    "n8n",
    "web",
  ]);
});

test("renames evaluate both old and new paths while deletes retain the old owner", () => {
  const parsed = parseNameStatusZ(
    Buffer.from("R100\0web/src/old.ts\0packages/api-client/new.ts\0D\0mcp/eisenhower_adapter/old.py\0"),
  );
  const plan = buildImpactPlan({
    eventName: "pull_request",
    refName: "feature/rename",
    mergeBase: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: parsed,
  });

  assert.deepEqual(parsed, [
    { status: "R100", previousPath: "web/src/old.ts", path: "packages/api-client/new.ts" },
    { status: "D", path: "mcp/eisenhower_adapter/old.py" },
  ]);
  assert.ok(plan.targets.includes("web"));
  assert.ok(plan.targets.includes("api-client"));
  assert.ok(plan.targets.includes("mcp"));
});

test("module manifests select dependency audits without forcing unrelated suites", () => {
  const plan = buildImpactPlan({
    eventName: "pull_request",
    refName: "deps/mcp",
    mergeBase: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: [change("M", "mcp/eisenhower_adapter/pyproject.toml")],
  });

  assert.equal(plan.fullCi, false);
  assert.deepEqual(plan.targets, ["dependency-audit", "mcp"]);
});

test("every mobile application change validates the bundled Android release surface", () => {
  for (const path of [
    "mobile/eisenhower-matrix/src/services/tasks.js",
    "mobile/eisenhower-matrix/App.js",
    "mobile/eisenhower-matrix/metro.config.js",
    "mobile/eisenhower-matrix/assets/icon.png",
  ]) {
    const plan = buildImpactPlan({
      eventName: "pull_request",
      refName: "feature/mobile-source",
      mergeBase: "a".repeat(40),
      headSha: "b".repeat(40),
      changes: [change("M", path)],
    });

    assert.ok(plan.targets.includes("mobile"), path);
    assert.ok(plan.targets.includes("mobile-native-android"), path);
  }
});

test("the shared API client validates every consumer including the Android bundle", () => {
  for (const path of ["packages/api-client/index.js", "packages/api-client/package.json"]) {
    const plan = buildImpactPlan({
      eventName: "pull_request",
      refName: "feature/shared-client",
      mergeBase: "a".repeat(40),
      headSha: "b".repeat(40),
      changes: [change("M", path)],
    });

    assert.ok(plan.targets.includes("api-client"), path);
    assert.ok(plan.targets.includes("mobile"), path);
    assert.ok(plan.targets.includes("mobile-native-android"), path);
  }
});

test("workflows, lockfiles, infrastructure, root config, and unknown paths fail closed", () => {
  for (const path of [
    ".github/workflows/ci.yml",
    "web/package-lock.json",
    "deploy/mikrus/docker-compose.yml",
    "Dockerfile",
    "Makefile",
    "unowned/new-surface.txt",
  ]) {
    const plan = buildImpactPlan({
      eventName: "pull_request",
      refName: "feature/risky",
      mergeBase: "a".repeat(40),
      headSha: "b".repeat(40),
      changes: [change("M", path)],
    });
    assert.equal(plan.fullCi, true, path);
    assert.deepEqual(plan.targets, ALL_TARGETS, path);
  }
});

test("master, release, schedule, empty diff, and planner errors force full CI", () => {
  const cases = [
    { eventName: "push", refName: "master", changes: [change("M", "README.md")] },
    { eventName: "push", refName: "release/1.2", changes: [change("M", "README.md")] },
    { eventName: "schedule", refName: "dev", changes: [change("M", "README.md")] },
    { eventName: "pull_request", refName: "docs", changes: [] },
    {
      eventName: "pull_request",
      refName: "feature/error",
      changes: [change("M", "README.md")],
      error: "merge-base unavailable",
    },
  ];

  for (const entry of cases) {
    const plan = buildImpactPlan({
      mergeBase: "a".repeat(40),
      headSha: "b".repeat(40),
      ...entry,
    });
    assert.equal(plan.fullCi, true, JSON.stringify(entry));
    assert.deepEqual(plan.targets, ALL_TARGETS);
  }
});

test("pull requests targeting master or a release branch force full CI", () => {
  for (const baseRefName of ["master", "release/2.0"]) {
    const plan = buildImpactPlan({
      eventName: "pull_request",
      refName: "157/merge",
      baseRefName,
      mergeBase: "a".repeat(40),
      headSha: "b".repeat(40),
      changes: [change("M", "docs/release-notes.md")],
    });

    assert.equal(plan.fullCi, true, baseRefName);
    assert.deepEqual(plan.targets, ALL_TARGETS);
  }
});

test("an unknown git status fails closed even for an otherwise owned path", () => {
  const plan = buildImpactPlan({
    eventName: "pull_request",
    refName: "feature/unknown-status",
    mergeBase: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: [change("X", "web/src/api.ts")],
  });

  assert.equal(plan.fullCi, true);
  assert.deepEqual(plan.targets, ALL_TARGETS);
});

test("documentation-only changes produce an explicit not-applicable plan", () => {
  const input = {
    eventName: "pull_request",
    refName: "docs/readme",
    mergeBase: "a".repeat(40),
    headSha: "b".repeat(40),
    changes: [change("M", "docs/architecture.md")],
  };
  const first = buildImpactPlan(input);
  const second = buildImpactPlan(input);

  assert.equal(first.fullCi, false);
  assert.deepEqual(first.targets, []);
  assert.equal(first.inputDigest, second.inputDigest);
  assert.deepEqual(first, second);
});

test("required job guard fails closed when the resolver fails or omits its output", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const guard = workflow.match(
    /- name: Require a successful CI impact plan[\s\S]*?\n\s+run: ([^\n]+)/,
  )?.[1];
  assert.ok(guard);

  const execute = (resolverResult, target) =>
    spawnSync("bash", ["-c", guard], {
      env: { ...process.env, RESOLVER_RESULT: resolverResult, TARGET: target },
    }).status;

  assert.notEqual(execute("failure", "true"), 0);
  assert.notEqual(execute("success", ""), 0);
  assert.equal(execute("success", "false"), 0);
  assert.equal(execute("success", "true"), 0);
});

test("required contexts stay synchronized and expose explicit not-applicable jobs", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const bridge = readFileSync(".github/scripts/bridge-sync-pr-statuses.mjs", "utf8");
  const sync = readFileSync(".github/workflows/sync-master-into-dev.yml", "utf8");
  const acceptance = readFileSync("docs/PRODUCTION_ACCEPTANCE.md", "utf8");
  const readme = readFileSync("README.md", "utf8");
  const contexts = [
    "resolve-run-mode",
    "security-lint",
    "test-backend-node",
    "test-api-client",
    "test-mcp-adapter",
    "test-n8n-workflows",
    "test-frontend",
    "test-frontend-integration",
    "test-frontend-e2e",
    "test-backend-ai",
    "test-mobile",
    "test-mobile-native-android",
  ];

  for (const context of contexts) {
    assert.match(workflow, new RegExp(`name: ${context}(?:\\n|$)`), `workflow: ${context}`);
    assert.ok(bridge.includes(`'${context}'`), `bridge: ${context}`);
    assert.match(sync, new RegExp(`^\\s+${context}$`, "m"), `sync: ${context}`);
    assert.ok(acceptance.includes(`\`${context}\``), `acceptance: ${context}`);
    assert.ok(readme.includes(`\`${context}\``), `README: ${context}`);
  }

  assert.equal((workflow.match(/- name: Not applicable/g) ?? []).length, 10);
  assert.doesNotMatch(workflow, /^\s+if:.*skip_full_ci/m);
  assert.match(
    workflow,
    /- name: Enforce clean Python lint gate\n\s+if: \$\{\{ needs\.resolve-run-mode\.outputs\.backend_ai == 'true' \}\}/,
  );
  assert.doesNotMatch(workflow, /- name: Run Trivy scan\n\s+if:/);
  assert.doesNotMatch(workflow, /security scan not applicable/i);
  assert.equal((workflow.match(/^    if: \$\{\{ always\(\) \}\}$/gm) ?? []).length, 11);
  assert.equal(
    (workflow.match(/- name: Require a successful CI impact plan/g) ?? []).length,
    11,
  );
  assert.equal((workflow.match(/RESOLVER_RESULT: \$\{\{ needs\.resolve-run-mode\.result \}\}/g) ?? []).length, 11);
  assert.equal((workflow.match(/TARGET: \$\{\{ needs\.resolve-run-mode\.outputs\.[a-z0-9_]+ \}\}/g) ?? []).length, 11);

  const auditCommands = [
    "npm --prefix backend-node audit --omit=dev --audit-level=high",
    "npm --prefix packages/api-client audit --omit=dev --audit-level=high",
    "npm --prefix web audit --omit=dev --audit-level=high",
    "npm --prefix mobile/eisenhower-matrix run audit:production",
    "python backend-ai/scripts/production_dependency_audit.py",
    "uv export --project mcp/eisenhower_adapter --locked --no-dev --no-emit-project --format requirements.txt",
    'python -m pip_audit --requirement "$RUNNER_TEMP/mcp-requirements.txt" --require-hashes --disable-pip --progress-spinner off',
  ];
  for (const command of auditCommands) assert.ok(workflow.includes(command), command);
  assert.match(workflow, /- name: Audit every production dependency surface\n\s+run: \|/);
  assert.match(workflow, /- name: Preserve Trivy SARIF artifact\n\s+if: \$\{\{ always\(\)/);
  assert.match(
    workflow,
    /- name: Run Trivy scan\n\s+id: trivy-scan\n\s+if: \$\{\{ always\(\) && steps\.checkout\.outcome == 'success' \}\}/,
  );
  assert.match(
    workflow,
    /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/,
  );
  assert.ok(workflow.includes("github.actor != 'dependabot[bot]'"));
  assert.match(
    workflow,
    /- name: Enforce Trivy gate\n\s+if: \$\{\{ always\(\) && steps\.trivy-scan\.outputs\.exit_code != '0' \}\}/,
  );
});
