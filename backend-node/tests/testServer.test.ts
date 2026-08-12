import http from 'node:http';
import { getDatabaseStatus } from '../src/db';
import { startTestServer } from './helpers/testServer';

function closeServer(server: http.Server) {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

describe('test server lifecycle', () => {
  it('starts a real HTTP server and closes every resource idempotently', async () => {
    const server = await startTestServer();

    await expect(fetch(`${server.url}/health`)).resolves.toMatchObject({ status: 200 });
    await server.close();
    await server.close();

    expect(getDatabaseStatus()).toBe('disconnected');
    await expect(fetch(`${server.url}/health`)).rejects.toThrow();
  });

  it('cleans up MongoDB and Mongoose after an occupied-port listen failure', async () => {
    const blocker = http.createServer((_request, response) => response.end('occupied'));
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const address = blocker.address();
    if (!address || typeof address === 'string') throw new Error('blocker did not bind');

    try {
      await expect(startTestServer({ port: address.port })).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(getDatabaseStatus()).toBe('disconnected');
    } finally {
      await closeServer(blocker);
    }
  });
});
