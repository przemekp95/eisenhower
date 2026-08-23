import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';
import { CreateAppOptions } from './app-options';
import { loadConfig } from './config';
import { createFastifyAdapter, registerFastifyPlatform } from './platform/http/fastify-platform';
import { HttpErrorFilter } from './platform/http/http-error.filter';

export async function createNestApp(
  options: CreateAppOptions = {},
): Promise<NestFastifyApplication> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule.register(options),
    createFastifyAdapter(config.nodeEnv),
    { rawBody: true, logger: false },
  );
  app.setGlobalPrefix('');
  await registerFastifyPlatform(app, config, options);
  app.useGlobalFilters(new HttpErrorFilter(config.nodeEnv === 'production'));
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
