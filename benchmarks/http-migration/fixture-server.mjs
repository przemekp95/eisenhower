import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const values = Object.fromEntries(process.argv.slice(2).map((entry) => {
  const [key, ...rest] = entry.replace(/^--/, '').split('=');
  return [key, rest.join('=')];
}));
const appRoot = path.resolve(values['app-root']);
const implementation = values.implementation;
const mongoUri = values['mongo-uri'];

process.env.NODE_ENV = 'test';
process.env.AUTH_MODE = 'static';
process.env.EISENHOWER_API_TOKEN = 'benchmark-token';
process.env.MONGODB_URI = mongoUri;

const imported = async (relative) => import(pathToFileURL(path.join(appRoot, relative)).href);
const appModule = await imported('dist/app.js');
const databaseModule = await imported('dist/db.js');
const createApp = appModule.createApp ?? appModule.default?.createApp;
const connectToDatabase = databaseModule.connectToDatabase ?? databaseModule.default?.connectToDatabase;
const disconnectFromDatabase = databaseModule.disconnectFromDatabase
  ?? databaseModule.default?.disconnectFromDatabase;
await connectToDatabase(mongoUri);
const application = await createApp({
  auditSink: { record() {} },
  aiHealthChecker: async () => 'healthy',
  databaseStatusResolver: () => 'connected',
  rateLimitLimit: 1_000_000_000,
});

let server;
let port;
if (implementation === 'nest-fastify') {
  await application.listen({ host: '127.0.0.1', port: 0 });
  port = application.getHttpServer().address().port;
} else {
  server = await new Promise((resolve, reject) => {
    const listening = application.listen(0, '127.0.0.1', () => resolve(listening));
    listening.once('error', reject);
  });
  port = server.address().port;
}
process.stdout.write(`BENCH_READY ${JSON.stringify({ port })}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  if (implementation === 'nest-fastify') await application.close();
  else await new Promise((resolve) => server.close(resolve));
  await disconnectFromDatabase();
  process.exit(0);
}
process.on('SIGTERM', () => void stop());
process.on('SIGINT', () => void stop());
