import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';

export interface RunningBackendProcess {
  url: string;
  stop: () => Promise<void>;
}

function getFreePort() {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();

    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();

      if (!address || typeof address === 'string') {
        reject(new Error('Failed to resolve a free port for frontend integration tests.'));
        return;
      }

      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve(address.port);
      });
    });
  });
}

function formatProcessError(message: string, output: string) {
  return new Error(output ? `${message}\n\n${output}` : message);
}

function requestHealth(url: string) {
  return new Promise<number>((resolve, reject) => {
    const request = http.get(`${url}/health`, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });

    request.once('error', reject);
  });
}

async function waitForHealth(url: string, child: ChildProcessWithoutNullStreams, getOutput: () => string) {
  const deadline = Date.now() + 90_000;

  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw formatProcessError(`Backend integration server exited early with code ${child.exitCode}.`, getOutput());
    }

    try {
      const statusCode = await requestHealth(url);
      if (statusCode === 200) {
        return;
      }
    } catch {
      // Still booting.
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw formatProcessError('Timed out waiting for the backend integration server to become healthy.', getOutput());
}

export async function startBackendProcess(): Promise<RunningBackendProcess> {
  const port = await getFreePort();
  const backendDir = path.resolve(__dirname, '../../../backend-node');
  const tsxCommand =
    process.platform === 'win32'
      ? path.join(backendDir, 'node_modules/.bin/tsx.cmd')
      : path.join(backendDir, 'node_modules/.bin/tsx');
  const { NO_COLOR: _ignoredNoColor, ...childEnv } = process.env;
  let output = '';

  const child = spawn(tsxCommand, ['scripts/e2e-server.ts'], {
    cwd: backendDir,
    env: {
      ...childEnv,
      HOST: '127.0.0.1',
      PORT: String(port),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  child.stdout.on('data', (chunk) => {
    output += chunk.toString();
  });

  child.stderr.on('data', (chunk) => {
    output += chunk.toString();
  });

  const url = `http://127.0.0.1:${port}`;
  await waitForHealth(url, child, () => output);

  return {
    url,
    stop: async () => {
      if (child.exitCode !== null) {
        return;
      }

      child.kill('SIGTERM');

      let timeoutId: ReturnType<typeof setTimeout> | undefined;

      try {
        await Promise.race([
          once(child, 'close'),
          new Promise((_, reject) => {
            timeoutId = setTimeout(() => {
              child.kill('SIGKILL');
              reject(formatProcessError('Timed out stopping the backend integration server.', output));
            }, 10_000);
          }),
        ]);
      } finally {
        if (timeoutId) {
          clearTimeout(timeoutId);
        }
      }
    },
  };
}
