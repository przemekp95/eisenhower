#!/usr/bin/env node

const { spawn } = require('node:child_process');

delete process.env.NO_COLOR;

const cliPath = require.resolve('@playwright/test/cli');
const child = spawn(process.execPath, [cliPath, ...process.argv.slice(2)], {
  env: process.env,
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }

  process.exit(code ?? 0);
});

