import assert from "node:assert/strict";
import test from "node:test";

import {
  REQUIRED_CI_JOBS,
  assertRequiredJobsGreen,
  selectExactGreenMasterRun,
  validateReleaseSha,
} from "./release-preflight.mjs";

const SHA = "a".repeat(40);

test("release SHA must be a complete immutable commit identifier", () => {
  assert.equal(validateReleaseSha(SHA.toUpperCase()), SHA);
  for (const invalid of ["main", "a".repeat(39), `${SHA};echo`, "", "g".repeat(40)]) {
    assert.throws(() => validateReleaseSha(invalid), /40-character hexadecimal SHA/);
  }
});

test("release preflight accepts only an exact successful master push run", () => {
  const selected = selectExactGreenMasterRun(
    [
      { id: 1, head_sha: SHA, head_branch: "feature", event: "push", status: "completed", conclusion: "success" },
      { id: 2, head_sha: SHA, head_branch: "master", event: "pull_request", status: "completed", conclusion: "success" },
      { id: 3, head_sha: SHA, head_branch: "master", event: "push", status: "completed", conclusion: "failure" },
      { id: 4, head_sha: SHA, head_branch: "master", event: "push", status: "completed", conclusion: "success" },
    ],
    SHA,
  );

  assert.equal(selected.id, 4);
  assert.throws(() => selectExactGreenMasterRun([], SHA), /green master push CI/);
});

test("release preflight requires every stable CI context to be green", () => {
  const jobs = REQUIRED_CI_JOBS.map((name) => ({ name, status: "completed", conclusion: "success" }));
  assert.doesNotThrow(() => assertRequiredJobsGreen(jobs));
  assert.throws(
    () => assertRequiredJobsGreen(jobs.filter((job) => job.name !== "test-frontend-e2e")),
    /test-frontend-e2e:missing/,
  );
  assert.throws(
    () => assertRequiredJobsGreen(jobs.map((job) => job.name === "security-lint" ? { ...job, conclusion: "failure" } : job)),
    /security-lint:failure/,
  );
});
