import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import type { CreateAppOptions } from './app-options';
import { loadConfig } from './config';
import { createFastifyAdapter, registerFastifyPlatform } from './platform/http/fastify-platform';
import { HttpErrorFilter } from './platform/http/http-error.filter';

export type { CreateAppOptions } from './app-options';
export { defaultAiHealthChecker } from './modules/health/health.service';

function validateSynchronousStartup(
  options: CreateAppOptions,
  config: ReturnType<typeof loadConfig> = loadConfig(),
) {
  if (config.nodeEnv === 'production' && (
    !process.env.AUDIT_LOG_PATH
    || !process.env.AUDIT_HMAC_KEY
    || Buffer.byteLength(process.env.AUDIT_HMAC_KEY) < 32
    || !process.env.RELEASE_SHA
    || !/^[a-f0-9]{40}$/.test(process.env.RELEASE_SHA)
  )) {
    throw new Error(
      'AUDIT_LOG_PATH, a strong AUDIT_HMAC_KEY, and exact RELEASE_SHA are required in production.',
    );
  }
  const hmacKey = options.calendarInternalHmacKey ?? process.env.CALENDAR_INTERNAL_HMAC_KEY;
  if (hmacKey && Buffer.byteLength(hmacKey) < 32) {
    throw new Error('CALENDAR_INTERNAL_HMAC_KEY must contain at least 32 bytes.');
  }
  return config;
}

export function createApp(options: CreateAppOptions = {}): Promise<NestFastifyApplication> {
  const config = validateSynchronousStartup(options);
  return createNestApplication(options, config);
}

export function createAppFromConfig(
  options: CreateAppOptions,
  config: ReturnType<typeof loadConfig>,
): Promise<NestFastifyApplication> {
  validateSynchronousStartup(options, config);
  return createNestApplication(options, config);
}

async function createNestApplication(
  options: CreateAppOptions,
  config: ReturnType<typeof loadConfig>,
) {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(options, config),
    createFastifyAdapter(config.nodeEnv),
    { rawBody: true, logger: false, abortOnError: false },
  );
  await registerFastifyPlatform(app, config, options);
  app.useGlobalFilters(new HttpErrorFilter(config.nodeEnv === 'production'));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
