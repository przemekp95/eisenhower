#!/usr/bin/env node

import { createHash } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const PLAN_VERSION = "ci-impact-plan/v1";
export const ALL_TARGETS = Object.freeze([
  "api-client",
  "backend-ai",
  "backend-node",
  "dependency-audit",
  "frontend-e2e",
  "frontend-integration",
  "mcp",
  "mobile",
  "mobile-native-android",
  "n8n",
  "security-lint",
  "web",
]);

const FULL_CI_PATHS = [
  /^\.github\/(?:workflows|actions)\//,
  /^\.github\/scripts\/ci-impact-plan(?:\.test)?\.mjs$/,
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|uv\.lock|poetry\.lock|gradle\.lockfile)$/,
  /(?:^|\/)(?:Dockerfile(?:\.[^/]+)?|docker-compose(?:\.[^/]+)?\.ya?ml|compose(?:\.[^/]+)?\.ya?ml)$/i,
  /^(?:deploy|infrastructure|terraform|k8s|helm)\//i,
  /^(?:Makefile|package\.json|pyproject\.toml|requirements[^/]*\.txt|gradle\.properties|settings\.gradle(?:\.kts)?|build\.gradle(?:\.kts)?|trivy\.ya?ml|\.trivyignore\.ya?ml)$/,
];

const SAFE_NON_EXECUTABLE_PATHS = [
  /^(?:docs|\.tasks)\//,
  /^(?:README|CHANGELOG|CONTRIBUTING|SECURITY|INFRASTRUCTURE)(?:\.[^/]+)?$/i,
  /^\.github\/(?:ISSUE_TEMPLATE|PULL_REQUEST_TEMPLATE)\//,
];

const DIRECT_RULES = [
  {
    pattern: /^backend-node\//,
    targets: [
      "backend-node",
      "api-client",
      "web",
      "frontend-integration",
      "frontend-e2e",
      "mobile",
      "mcp",
      "n8n",
    ],
    reason: "backend-node HTTP, auth, application, repository, messaging, or BDD surface",
  },
  {
    pattern: /^backend-ai\//,
    targets: ["backend-ai", "web", "mcp", "n8n"],
    reason: "backend-ai API, webhook, job, retrieval, or adapter surface",
  },
  {
    pattern: /^web\//,
    targets: ["web", "frontend-integration", "frontend-e2e"],
    reason: "web browser, CSRF, auth, transport, or UI surface",
  },
  {
    pattern: /^mobile\/eisenhower-matrix\//,
    targets: ["mobile", "mobile-native-android"],
    reason: "mobile application, Metro bundle, Expo, or native Android surface",
  },
  {
    pattern: /^packages\/api-client\//,
    targets: [
      "api-client",
      "backend-node",
      "web",
      "frontend-integration",
      "frontend-e2e",
      "mobile",
      "mobile-native-android",
      "mcp",
    ],
    reason: "shared HTTP API client contract",
  },
  {
    pattern: /^mcp\/eisenhower_adapter\//,
    targets: ["mcp"],
    reason: "MCP HTTP adapter or port",
  },
  {
    pattern: /^n8n\//,
    targets: ["n8n", "backend-ai"],
    reason: "n8n webhook, job, retry, or messaging contract",
  },
  {
    pattern: /^contracts\//,
    targets: [
      "api-client",
      "backend-ai",
      "backend-node",
      "web",
      "frontend-integration",
      "frontend-e2e",
      "mobile",
      "mcp",
      "n8n",
    ],
    reason: "cross-service contract",
  },
];

const MANIFEST_RULES = [
  /^backend-node\/package\.json$/,
  /^backend-ai\/(?:requirements[^/]*\.txt|pyproject\.toml)$/,
  /^web\/package\.json$/,
  /^mobile\/eisenhower-matrix\/package\.json$/,
  /^packages\/api-client\/package\.json$/,
  /^mcp\/eisenhower_adapter\/pyproject\.toml$/,
];

const normalizeChange = (entry) => {
  const normalized = { status: String(entry.status), path: String(entry.path) };
  if (entry.previousPath !== undefined) normalized.previousPath = String(entry.previousPath);
  return normalized;
};

const canonicalJson = (value) => JSON.stringify(value);

export function parseNameStatusZ(buffer) {
  const fields = buffer.toString("utf8").split("\0");
  if (fields.at(-1) === "") fields.pop();
  const changes = [];
  for (let index = 0; index < fields.length; ) {
    const status = fields[index++];
    if (!status) throw new Error("empty git diff status");
    if (/^[RC]/.test(status)) {
      if (index + 1 >= fields.length) throw new Error(`incomplete ${status} diff record`);
      changes.push({ status, previousPath: fields[index++], path: fields[index++] });
    } else {
      if (index >= fields.length) throw new Error(`incomplete ${status} diff record`);
      changes.push({ status, path: fields[index++] });
    }
  }
  return changes;
}

export function buildImpactPlan(rawInput) {
  const changes = (rawInput.changes ?? [])
    .map(normalizeChange)
    .sort((left, right) => {
      const leftKey = canonicalJson(left);
      const rightKey = canonicalJson(right);
      return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
    });
  const input = {
    version: PLAN_VERSION,
    eventName: String(rawInput.eventName ?? "unknown"),
    refName: String(rawInput.refName ?? "unknown"),
    baseRefName: String(rawInput.baseRefName ?? rawInput.refName ?? "unknown"),
    mergeBase: String(rawInput.mergeBase ?? "unknown"),
    headSha: String(rawInput.headSha ?? "unknown"),
    changes,
    error: rawInput.error ? String(rawInput.error) : null,
  };
  const inputDigest = `sha256:${createHash("sha256").update(canonicalJson(input)).digest("hex")}`;
  const reasons = Object.fromEntries(ALL_TARGETS.map((target) => [target, []]));
  const planReasons = [];
  let fullCi = false;

  const forceFull = (reason) => {
    fullCi = true;
    planReasons.push(reason);
  };

  if (input.error) forceFull(`planner-error: ${input.error}`);
  if (input.eventName === "schedule") forceFull("scheduled full dependency and security scan");
  const protectedRef = [input.refName, input.baseRefName].find(
    (ref) => ref === "master" || ref.startsWith("release/"),
  );
  if (protectedRef) {
    forceFull(`protected release ref: ${protectedRef}`);
  }
  if (changes.length === 0) forceFull("empty or unavailable change set");

  for (const entry of changes) {
    if (!/^[ACDMRT](?:\d{1,3})?$/.test(entry.status)) {
      forceFull(`unknown or unsafe git status: ${entry.status}`);
    }
    const paths = [entry.previousPath, entry.path].filter(Boolean);
    for (const path of paths) {
      if (FULL_CI_PATHS.some((pattern) => pattern.test(path))) {
        forceFull(`full-ci path: ${path}`);
        continue;
      }

      let owned = SAFE_NON_EXECUTABLE_PATHS.some((pattern) => pattern.test(path));
      for (const rule of DIRECT_RULES) {
        if (!rule.pattern.test(path)) continue;
        owned = true;
        for (const target of rule.targets) {
          reasons[target].push(`${rule.reason}: ${path}`);
        }
      }
      if (MANIFEST_RULES.some((pattern) => pattern.test(path))) {
        owned = true;
        reasons["dependency-audit"].push(`dependency manifest: ${path}`);
      }
      if (!owned) forceFull(`unknown path: ${path}`);
    }
  }

  if (fullCi) {
    for (const target of ALL_TARGETS) {
      reasons[target].push(...planReasons);
    }
  }

  const targets = fullCi
    ? [...ALL_TARGETS]
    : ALL_TARGETS.filter((target) => reasons[target].length > 0);
  const selectedReasons = Object.fromEntries(
    targets.map((target) => [target, [...new Set(reasons[target])].sort()]),
  );

  return {
    version: PLAN_VERSION,
    inputDigest,
    eventName: input.eventName,
    refName: input.refName,
    baseRefName: input.baseRefName,
    mergeBase: input.mergeBase,
    headSha: input.headSha,
    fullCi,
    targets,
    reasons: selectedReasons,
    changes,
  };
}

const git = (...args) => {
  const result = spawnSync("git", args, { encoding: null, maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString("utf8").trim()}`);
  }
  return result.stdout;
};

const parseArgs = (argv) => {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error(`invalid argument: ${key}`);
    options[key.slice(2)] = value;
  }
  return options;
};

function runCli() {
  const options = parseArgs(process.argv.slice(2));
  const eventName = options.event ?? process.env.GITHUB_EVENT_NAME ?? "unknown";
  const refName = options.ref ?? process.env.GITHUB_REF_NAME ?? "unknown";
  const baseRefName = options["base-ref"] ?? process.env.GITHUB_BASE_REF ?? refName;
  const headSha = options.head ?? process.env.GITHUB_SHA ?? "HEAD";
  const outputPath = options.output ?? "ci-impact-plan.json";
  let mergeBase = "unknown";
  let changes = [];
  let error;

  try {
    const base = options.base;
    if (!base) throw new Error("--base is required");
    mergeBase = git("merge-base", base, headSha).toString("utf8").trim();
    changes = parseNameStatusZ(git("diff", "--name-status", "-z", "-M", mergeBase, headSha));
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  }

  const plan = buildImpactPlan({
    eventName,
    refName,
    baseRefName,
    mergeBase,
    headSha,
    changes,
    error,
  });
  writeFileSync(outputPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  if (process.env.GITHUB_OUTPUT) {
    const lines = [
      `version=${plan.version}`,
      `input_digest=${plan.inputDigest}`,
      `full_ci=${plan.fullCi}`,
      `plan_path=${outputPath}`,
      ...ALL_TARGETS.map(
        (target) => `${target.replaceAll("-", "_")}=${plan.targets.includes(target)}`,
      ),
    ];
    appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`, "utf8");
  }
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      process.env.GITHUB_STEP_SUMMARY,
      `### CI impact plan\n\n- version: \`${plan.version}\`\n- input digest: \`${plan.inputDigest}\`\n- full CI: \`${plan.fullCi}\`\n- targets: ${plan.targets.length ? plan.targets.map((target) => `\`${target}\``).join(", ") : "not applicable"}\n\n`,
      "utf8",
    );
  }
  process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) runCli();
