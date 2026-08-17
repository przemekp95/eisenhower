import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREPARE_SCRIPT = join(REPOSITORY_ROOT, 'scripts', 'prepare-worktree-dependencies.mjs');
const NODE_COMPONENTS = [
  'backend-node',
  'packages/api-client',
  'web',
  'mobile/eisenhower-matrix',
];

function writeExecutable(path, source) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `#!/usr/bin/env node\n${source}`);
  chmodSync(path, 0o755);
}

function createFixture() {
  const root = mkdtempSync(join(tmpdir(), 'eisenhower-dependencies-'));
  const log = join(root, 'install.log');
  for (const component of NODE_COMPONENTS) {
    const directory = join(root, component);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package-lock.json'), `{"name":"${component}"}\n`);
  }

  mkdirSync(join(root, 'backend-ai'), { recursive: true });
  writeFileSync(join(root, 'backend-ai', 'requirements-dev.txt'), '-r requirements.txt\n-r requirements-knowledge.txt\n');
  writeFileSync(join(root, 'backend-ai', 'requirements.txt'), '-r requirements-ingest.txt\nfastapi==1.0\n');
  writeFileSync(join(root, 'backend-ai', 'requirements-ingest.txt'), 'pillow==1.0\n');
  writeFileSync(join(root, 'backend-ai', 'requirements-knowledge.txt'), 'qdrant-client==1.0\n');

  const bin = join(root, 'fake-bin');
  const npm = join(bin, 'npm');
  const python = join(bin, 'python');
  const pip = join(bin, 'pip');
  writeExecutable(
    npm,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { relative } from 'node:path';
const component = relative(process.env.PREPARE_ROOT, process.cwd());
if (process.env.FAIL_COMPONENT === component) {
  console.error(\`intentional failure for \${component}\`);
  process.exit(7);
}
appendFileSync(process.env.PREPARE_LOG, \`npm:\${component}\\n\`);
mkdirSync('node_modules', { recursive: true });
`,
  );
  writeExecutable(
    python,
    `import { appendFileSync, mkdirSync } from 'node:fs';
import { relative } from 'node:path';
if (process.argv[2] === '--version') {
  console.log('Python 3.12.0');
} else {
  const venv = process.argv[4];
  appendFileSync(process.env.PREPARE_LOG, \`python-venv:\${relative(process.env.PREPARE_ROOT, venv)}\\n\`);
  mkdirSync(venv, { recursive: true });
}
`,
  );
  writeExecutable(
    pip,
    `import { appendFileSync } from 'node:fs';
appendFileSync(process.env.PREPARE_LOG, 'pip:backend-ai\\n');
`,
  );

  return { root, log, npm, python, pip };
}

function runPrepare(fixture, extraEnvironment = {}) {
  execFileSync(process.execPath, [PREPARE_SCRIPT, '--root', fixture.root], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NPM: fixture.npm,
      PYTHON: fixture.python,
      BACKEND_AI_VENV: 'backend-ai/venv',
      BACKEND_AI_PIP: fixture.pip,
      PREPARE_ROOT: fixture.root,
      PREPARE_LOG: fixture.log,
      ...extraEnvironment,
    },
    stdio: 'pipe',
  });
}

function runPrepareResult(fixture, extraEnvironment = {}) {
  return spawnSync(process.execPath, [PREPARE_SCRIPT, '--root', fixture.root], {
    cwd: fixture.root,
    env: {
      ...process.env,
      NPM: fixture.npm,
      PYTHON: fixture.python,
      BACKEND_AI_VENV: 'backend-ai/venv',
      BACKEND_AI_PIP: fixture.pip,
      PREPARE_ROOT: fixture.root,
      PREPARE_LOG: fixture.log,
      ...extraEnvironment,
    },
    encoding: 'utf8',
  });
}

function readLog(path) {
  return readFileSync(path, 'utf8').trim().split('\n');
}

test('prepares every dependency surface once in a fresh worktree', () => {
  const fixture = createFixture();
  try {
    runPrepare(fixture);
    assert.deepEqual(readLog(fixture.log), [
      'npm:backend-node',
      'npm:packages/api-client',
      'npm:web',
      'npm:mobile/eisenhower-matrix',
      'python-venv:backend-ai/venv',
      'pip:backend-ai',
    ]);

    runPrepare(fixture);
    assert.equal(readLog(fixture.log).length, 6);
    for (const component of NODE_COMPONENTS) {
      assert.match(
        readFileSync(join(fixture.root, component, 'node_modules', '.eisenhower-dependency-input.sha256'), 'utf8'),
        /^[a-f0-9]{64}\n$/,
      );
    }
    assert.match(
      readFileSync(join(fixture.root, 'backend-ai', 'venv', '.eisenhower-dependency-input.sha256'), 'utf8'),
      /^[a-f0-9]{64}\n$/,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('refreshes only the component whose lockfile changed', () => {
  const fixture = createFixture();
  try {
    runPrepare(fixture);
    writeFileSync(join(fixture.root, 'web', 'package-lock.json'), '{"name":"web","version":"2"}\n');

    runPrepare(fixture);

    assert.deepEqual(readLog(fixture.log).slice(6), ['npm:web']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('does not mark a component current when its installation fails', () => {
  const fixture = createFixture();
  try {
    const result = runPrepareResult(fixture, { FAIL_COMPONENT: 'backend-node' });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Failed to prepare backend-node/);
    assert.equal(
      existsSync(join(fixture.root, 'backend-node', 'node_modules', '.eisenhower-dependency-input.sha256')),
      false,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('refreshes Python dependencies when the selected interpreter changes', () => {
  const fixture = createFixture();
  try {
    runPrepare(fixture);
    const alternatePython = join(fixture.root, 'alternate-bin', 'python');
    mkdirSync(dirname(alternatePython), { recursive: true });
    writeFileSync(alternatePython, readFileSync(fixture.python));
    chmodSync(alternatePython, 0o755);

    runPrepare(fixture, { PYTHON: alternatePython });

    assert.deepEqual(readLog(fixture.log).slice(6), ['pip:backend-ai']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('Make exposes incremental and force preparation before verification', () => {
  const incremental = spawnSync('make', ['-n', 'prepare-verify'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.equal(incremental.status, 0, incremental.stderr);
  assert.match(incremental.stdout, /prepare-worktree-dependencies\.mjs(?:\s|$)/);
  assert.doesNotMatch(incremental.stdout, /--force/);

  const force = execFileSync('make', ['-n', 'setup'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.match(force, /prepare-worktree-dependencies\.mjs --force/);

  const verification = execFileSync('make', ['-n', 'verify'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.ok(
    verification.indexOf('prepare-worktree-dependencies.mjs') < verification.indexOf('audit-production'),
    'dependency preparation must run before repository verification',
  );
});
