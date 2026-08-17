#!/usr/bin/env node

import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const REQUIRED_CI_JOBS = Object.freeze([
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
]);

export function validateReleaseSha(value) {
  const sha = String(value ?? "").toLowerCase();
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error("release_sha must be a 40-character hexadecimal SHA");
  }
  return sha;
}

export function selectExactGreenMasterRun(runs, releaseSha) {
  const sha = validateReleaseSha(releaseSha);
  const candidates = (Array.isArray(runs) ? runs : []).filter((run) =>
    run?.head_sha?.toLowerCase() === sha
      && run.head_branch === "master"
      && run.event === "push"
      && run.status === "completed"
      && run.conclusion === "success"
      && (run.name === undefined || run.name === "CI")
  );

  candidates.sort((left, right) => Number(right.id) - Number(left.id));
  if (candidates.length === 0) {
    throw new Error(`No exact green master push CI run exists for ${sha}`);
  }
  return candidates[0];
}

export function assertRequiredJobsGreen(jobs) {
  const availableJobs = Array.isArray(jobs) ? jobs : [];
  const failures = [];

  for (const requiredName of REQUIRED_CI_JOBS) {
    const matchingJobs = availableJobs.filter((job) => job?.name === requiredName);
    if (matchingJobs.length === 0) {
      failures.push(`${requiredName}:missing`);
      continue;
    }

    const green = matchingJobs.some((job) => job.status === "completed" && job.conclusion === "success");
    if (!green) {
      const job = matchingJobs.at(-1);
      failures.push(`${requiredName}:${job?.conclusion ?? job?.status ?? "unknown"}`);
    }
  }

  if (failures.length > 0) {
    throw new Error(`Required CI jobs are not green: ${failures.join(", ")}`);
  }
}

function runGit(args) {
  return spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function assertMasterAncestor(releaseSha) {
  const fetchResult = runGit(["fetch", "--no-tags", "origin", "master"]);
  if (fetchResult.status !== 0) {
    throw new Error("Could not fetch origin/master");
  }

  const commitResult = runGit(["cat-file", "-e", `${releaseSha}^{commit}`]);
  if (commitResult.status !== 0) {
    throw new Error(`Release SHA ${releaseSha} is not an available commit`);
  }

  const ancestorResult = runGit(["merge-base", "--is-ancestor", releaseSha, "origin/master"]);
  if (ancestorResult.status !== 0) {
    throw new Error(`Release SHA ${releaseSha} is not an ancestor of origin/master`);
  }
}

async function githubJson(url, token) {
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "eisenhower-release-preflight",
    },
  });
  if (!response.ok) {
    throw new Error(`GitHub API request failed with status ${response.status}`);
  }
  return response.json();
}

async function getExactGreenRun(repository, token, releaseSha) {
  const [owner, repo] = repository.split("/");
  if (!owner || !repo || repository !== `${owner}/${repo}`) {
    throw new Error("GITHUB_REPOSITORY must use the owner/repository format");
  }

  const baseUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const params = new URLSearchParams({
    branch: "master",
    event: "push",
    status: "success",
    head_sha: releaseSha,
    per_page: "100",
  });
  const payload = await githubJson(`${baseUrl}/actions/workflows/ci.yml/runs?${params}`, token);
  const run = selectExactGreenMasterRun(payload?.workflow_runs, releaseSha);
  return { baseUrl, run };
}

async function getRunJobs(baseUrl, token, runId) {
  const jobs = [];
  let page = 1;

  while (true) {
    const payload = await githubJson(
      `${baseUrl}/actions/runs/${encodeURIComponent(String(runId))}/jobs?filter=latest&per_page=100&page=${page}`,
      token,
    );
    const pageJobs = Array.isArray(payload?.jobs) ? payload.jobs : [];
    jobs.push(...pageJobs);
    if (pageJobs.length < 100) break;
    page += 1;
  }
  return jobs;
}

function parseReleaseSha(argv) {
  if (argv.length === 1 && !argv[0].startsWith("-")) return argv[0];
  if (argv.length === 2 && argv[0] === "--release-sha") return argv[1];
  if (argv.length === 1 && argv[0].startsWith("--release-sha=")) return argv[0].slice("--release-sha=".length);
  throw new Error("Usage: release-preflight.mjs --release-sha <40-character SHA>");
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const releaseSha = validateReleaseSha(parseReleaseSha(argv));
  const token = env.GITHUB_TOKEN;
  const repository = env.GITHUB_REPOSITORY;
  const outputPath = env.GITHUB_OUTPUT;
  if (!token) throw new Error("GITHUB_TOKEN is required");
  if (!repository) throw new Error("GITHUB_REPOSITORY is required");
  if (!outputPath) throw new Error("GITHUB_OUTPUT is required");

  assertMasterAncestor(releaseSha);
  const { baseUrl, run } = await getExactGreenRun(repository, token, releaseSha);
  const jobs = await getRunJobs(baseUrl, token, run.id);
  assertRequiredJobsGreen(jobs);

  appendFileSync(outputPath, `release_sha=${releaseSha}\nci_run_id=${run.id}\n`, { encoding: "utf8" });
}

const invokedPath = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (import.meta.url === invokedPath) {
  main().catch((error) => {
    console.error(`Release preflight failed: ${error instanceof Error ? error.message : "unknown error"}`);
    process.exitCode = 1;
  });
}
