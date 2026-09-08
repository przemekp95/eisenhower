#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAMP_NAME = '.eisenhower-dependency-input.sha256';
const NODE_COMPONENTS = ['backend-node', 'packages/api-client', 'web', 'mobile/eisenhower-matrix'];

function parseArguments(argv) {
  let root = DEFAULT_ROOT;
  let force = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--force') {
      force = true;
    } else if (argument === '--root' && argv[index + 1]) {
      root = resolve(argv[index + 1]);
      index += 1;
    } else {
      throw new Error(`Unsupported argument: ${argument}`);
    }
  }
  return { force, root };
}

function resolveExecutable(root, value) {
  if (isAbsolute(value) || !value.includes(sep)) {
    return value;
  }
  return resolve(root, value);
}

function run(command, args, options) {
  const result = spawnSync(command, args, options);
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function digestFiles(root, files, prefix = '') {
  const hash = createHash('sha256');
  hash.update(prefix);
  for (const file of [...files].sort()) {
    hash.update(`${relative(root, file)}\0`);
    hash.update(readFileSync(file));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function readStamp(path) {
  if (!existsSync(path)) {
    return null;
  }
  return readFileSync(path, 'utf8').trim();
}

function writeStamp(path, digest) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(temporary, `${digest}\n`, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function localRequirementReference(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) {
    return null;
  }
  const match = trimmed.match(/^(?:-r\s*|--requirement(?:=|\s+))([^\s#]+)/);
  return match?.[1] ?? null;
}

function collectRequirementFiles(entry) {
  const collected = new Set();
  function visit(path) {
    const absolute = resolve(path);
    if (collected.has(absolute)) {
      return;
    }
    collected.add(absolute);
    for (const line of readFileSync(absolute, 'utf8').split(/\r?\n/)) {
      const reference = localRequirementReference(line);
      if (reference) {
        visit(resolve(dirname(absolute), reference));
      }
    }
  }
  visit(entry);
  return [...collected];
}

function prepareNodeDependencies({ force, npm, root }) {
  for (const component of NODE_COMPONENTS) {
    const directory = join(root, component);
    const modules = join(directory, 'node_modules');
    const stamp = join(modules, STAMP_NAME);
    const digest = digestFiles(root, [join(directory, 'package-lock.json')]);
    if (!force && existsSync(modules) && readStamp(stamp) === digest) {
      console.log(`[prepare] ${component} dependencies are current`);
      continue;
    }
    console.log(`[prepare] Installing ${component} dependencies`);
    try {
      run(npm, ['ci'], { cwd: directory, env: process.env, stdio: 'inherit' });
      if (!existsSync(modules)) {
        throw new Error('npm ci completed without creating node_modules');
      }
      writeStamp(stamp, digest);
    } catch (error) {
      throw new Error(`Failed to prepare ${component}: ${error.message}`, { cause: error });
    }
  }
}

function pythonIdentity(python, root) {
  const result = run(python, ['--version'], {
    cwd: root,
    env: process.env,
    encoding: 'utf8',
  });
  return `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
}

function pipInvocation(pip, venv) {
  if (pip && ((!isAbsolute(pip) && !pip.includes(sep)) || existsSync(pip))) {
    return { args: [], command: pip };
  }
  const venvPython = join(venv, 'bin', 'python');
  if (!existsSync(venvPython)) {
    throw new Error(`Neither the configured pip launcher nor ${venvPython} exists`);
  }
  return { args: ['-m', 'pip'], command: venvPython };
}

function preparePythonDependencies({ force, pip, python, root, venv }) {
  const requirements = join(root, 'backend-ai', 'requirements-dev.txt');
  const files = collectRequirementFiles(requirements);
  const digest = digestFiles(
    root,
    files,
    `python=${python}\0version=${pythonIdentity(python, root)}\0`
  );
  const stamp = join(venv, STAMP_NAME);
  if (!force && existsSync(venv) && readStamp(stamp) === digest) {
    console.log('[prepare] backend-ai dependencies are current');
    return;
  }

  console.log('[prepare] Installing backend-ai dependencies');
  try {
    if (!existsSync(venv)) {
      run(python, ['-m', 'venv', venv], { cwd: root, env: process.env, stdio: 'inherit' });
    }
    const invocation = pipInvocation(pip, venv);
    run(invocation.command, [...invocation.args, 'install', '-r', requirements], {
      cwd: root,
      env: process.env,
      stdio: 'inherit',
    });
    if (!existsSync(venv)) {
      throw new Error('Python setup completed without creating the virtual environment');
    }
    writeStamp(stamp, digest);
  } catch (error) {
    throw new Error(`Failed to prepare backend-ai: ${error.message}`, { cause: error });
  }
}

function main() {
  const { force, root } = parseArguments(process.argv.slice(2));
  const npm = resolveExecutable(root, process.env.NPM || 'npm');
  const python = resolveExecutable(root, process.env.PYTHON || 'python3');
  const venv = resolve(root, process.env.BACKEND_AI_VENV || 'backend-ai/venv');
  const pip = resolveExecutable(root, process.env.BACKEND_AI_PIP || join(venv, 'bin', 'pip'));
  prepareNodeDependencies({ force, npm, root });
  preparePythonDependencies({ force, pip, python, root, venv });
}

try {
  main();
} catch (error) {
  console.error(`[prepare] ${error.message}`);
  process.exitCode = 1;
}
