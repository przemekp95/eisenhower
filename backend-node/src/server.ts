import { createApp } from './app';
import { loadConfig } from './config';
import { connectToDatabase } from './db';

async function bootstrap() {
  const config = loadConfig();
  await connectToDatabase(config.mongodbUri);

  const app = createApp();
  app.listen(config.port, () => {
    console.log(`backend-node listening on ${config.port}`);
  });
}

bootstrap().catch((error) => {
  console.error('Failed to start backend-node', error);
  process.exit(1);
});
