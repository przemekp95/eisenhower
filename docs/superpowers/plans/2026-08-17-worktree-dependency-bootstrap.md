# Automatic Worktree Dependency Bootstrap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `make verify` install only missing or stale lockfile-bound dependencies in any fresh or existing worktree.

**Architecture:** A dependency-free Node script calculates deterministic component input hashes, compares ignored success stamps and invokes the existing npm/Python installation commands only when required. Make exposes incremental and force-refresh entry points, while Node's built-in test runner exercises the script in disposable fixture repositories with fake installers.

**Tech Stack:** Node.js built-ins, GNU Make, npm lockfiles, Python venv/pip, Node test runner.

## Global Constraints

- The preparation script must run without repository `node_modules`.
- A success stamp is written atomically only after its component installation succeeds.
- Node inputs are bound to each component's `package-lock.json`.
- Python inputs are bound to the selected interpreter identity and recursively referenced local requirements files.
- `make verify` is incremental; explicit `make setup` remains a force refresh.
- CI keeps its explicit isolated installation commands.

---

### Task 1: Hash-bound dependency preparation

**Files:**
- Create: `scripts/prepare-worktree-dependencies.mjs`
- Create: `scripts/prepare-worktree-dependencies.test.mjs`

**Interfaces:**
- Consumes: repository root from the script location or `--root`, executables from `NPM`, `PYTHON` and optional `BACKEND_AI_PIP`.
- Produces: exit code zero after all components are current; ignored `.eisenhower-dependency-input.sha256` stamps under each dependency directory.

- [ ] **Step 1: Write failing fresh-checkout and cache tests**

Use temporary package roots, requirement files and fake executable scripts. Invoke the absent production script and assert that the first run records four npm installs plus Python venv/pip preparation, while a second run records no additional installs.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/prepare-worktree-dependencies.test.mjs`

Expected: FAIL because `scripts/prepare-worktree-dependencies.mjs` does not exist.

- [ ] **Step 3: Implement the minimal preparation script**

Implement these concrete operations with Node built-ins:

```js
const nodeComponents = [
  'backend-node',
  'packages/api-client',
  'web',
  'mobile/eisenhower-matrix',
];

function digestFiles(files, prefix = '') {
  const hash = createHash('sha256');
  hash.update(prefix);
  for (const file of files.sort()) {
    hash.update(relative(root, file));
    hash.update(readFileSync(file));
  }
  return hash.digest('hex');
}
```

For each Node component, compare the lockfile digest with `node_modules/.eisenhower-dependency-input.sha256`; run `npm ci` in that component on a miss. Recursively parse `-r` and `--requirement` entries beginning at `backend-ai/requirements-dev.txt`, include `python --version` in the digest, ensure the configured venv exists, then run its pip with `install -r backend-ai/requirements-dev.txt`. Write every stamp through a same-directory temporary file followed by rename.

- [ ] **Step 4: Verify GREEN**

Run: `node --test scripts/prepare-worktree-dependencies.test.mjs`

Expected: PASS for fresh preparation and unchanged rerun.

- [ ] **Step 5: Add selective-refresh and failure tests**

Change one fixture lockfile and assert only that npm component runs again. Configure one fake installer to exit nonzero and assert the command fails, identifies the component and leaves no valid success stamp.

- [ ] **Step 6: Verify RED for the new cases, then implement minimal handling**

Run the same Node test command before and after adding digest invalidation, component-labelled errors and atomic stamp handling. Expected sequence: the new assertions fail first, then the complete file passes.

- [ ] **Step 7: Commit the tested preparation unit**

```bash
git add scripts/prepare-worktree-dependencies.mjs scripts/prepare-worktree-dependencies.test.mjs
git commit -m "feat: prepare worktree dependencies incrementally"
```

### Task 2: Make and documentation integration

**Files:**
- Modify: `Makefile`
- Modify: `README.md`
- Test: `scripts/prepare-worktree-dependencies.test.mjs`

**Interfaces:**
- Consumes: `node scripts/prepare-worktree-dependencies.mjs` with `NPM`, `PYTHON`, `BACKEND_AI_VENV` and `BACKEND_AI_PIP` forwarded by Make.
- Produces: `make prepare-verify`, force-refreshing `make setup`, and automatic preparation before `make verify`.

- [ ] **Step 1: Add failing Make-contract tests**

Read the real `Makefile` and assert that `prepare-verify` invokes the script without `--force`, `setup` invokes it with `--force`, and `verify` has an order-preserving dependency on `prepare-verify`.

- [ ] **Step 2: Verify RED**

Run: `node --test scripts/prepare-worktree-dependencies.test.mjs`

Expected: FAIL because the Make targets are not wired.

- [ ] **Step 3: Implement Make integration and README guidance**

Replace the duplicated setup recipe with the force-refresh script call, add the incremental target, and make verification depend on it:

```make
prepare-verify:
	NPM="$(NPM)" PYTHON="$(PYTHON)" BACKEND_AI_VENV="$(BACKEND_AI_VENV)" BACKEND_AI_PIP="$(BACKEND_AI_PIP)" node scripts/prepare-worktree-dependencies.mjs

setup:
	NPM="$(NPM)" PYTHON="$(PYTHON)" BACKEND_AI_VENV="$(BACKEND_AI_VENV)" BACKEND_AI_PIP="$(BACKEND_AI_PIP)" node scripts/prepare-worktree-dependencies.mjs --force

verify: prepare-verify
```

Document that the first verification in a worktree installs missing/stale dependencies and later runs reuse hash-bound environments.

- [ ] **Step 4: Verify GREEN and Make dry runs**

Run:

```bash
node --test scripts/prepare-worktree-dependencies.test.mjs
make -n prepare-verify
make -n setup
```

Expected: all contract tests pass and both targets render the intended commands.

- [ ] **Step 5: Commit integration**

```bash
git add Makefile README.md scripts/prepare-worktree-dependencies.test.mjs
git commit -m "build: bootstrap verification dependencies"
```

### Task 3: Repository acceptance and TaskPlanner completion

**Files:**
- Modify: `.tasks/IN_PROGRESS.md`
- Modify: `.tasks/DONE.md`
- Modify: `.tasks/WORK_LOG.md`

**Interfaces:**
- Consumes: completed preparation and Make integration.
- Produces: fresh-worktree evidence, full repository verification and one completed TASK-064 record.

- [ ] **Step 1: Rehearse a disposable fresh worktree**

Create a temporary detached worktree from the implementation commit, confirm its dependency directories are absent, run `make prepare-verify`, rerun it and confirm the second invocation reports every component current. Remove the disposable worktree after the result is captured.

- [ ] **Step 2: Run proportional and full verification**

Run:

```bash
node --test scripts/prepare-worktree-dependencies.test.mjs
make prepare-verify
make prepare-verify
make verify
/home/przemekp95/.local/bin/actionlint
git diff --check
```

Expected: focused tests, idempotence, full repository verification, workflow lint and whitespace checks all pass.

- [ ] **Step 3: Complete TaskPlanner records**

Add a concise outcome with exact results, move TASK-064 exactly once from `IN_PROGRESS.md` to the top of `DONE.md`, and prepend one short completion entry to `WORK_LOG.md`.

- [ ] **Step 4: Verify repository state and commit**

Run TaskPlanner uniqueness search, inspect the complete diff and final status, then commit the documentation and task-state evidence.
