import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { createApp } from '../../src/app';
import { CalendarApplicationService } from '../../src/application/calendar';
import * as configModule from '../../src/config';
import { CalendarInboundController } from '../../src/modules/calendar-internal/calendar-inbound.controller';
import { CalendarQueryController } from '../../src/modules/calendar/calendar-query.controller';

type CalendarController = { calendar: CalendarApplicationService };

describe('Nest runtime composition', () => {
  let app: NestFastifyApplication | undefined;
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env.NODE_ENV = 'test';
    process.env.AUTH_MODE = 'static';
    process.env.EISENHOWER_API_TOKEN = 'test-api-token';
    process.env.CALENDAR_INTERNAL_HMAC_KEY = 'runtime-composition-hmac-key-32-bytes';
  });

  afterEach(async () => {
    await app?.close();
    app = undefined;
    jest.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnvironment)) delete process.env[key];
    }
    Object.assign(process.env, originalEnvironment);
  });

  it('resolves configuration exactly once per application bootstrap', async () => {
    const loadConfig = jest.spyOn(configModule, 'loadConfig');

    app = await createApp({
      auditSink: { record() {} },
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    expect(loadConfig).toHaveBeenCalledTimes(1);
  });

  it('shares one Calendar application service across public and internal controllers', async () => {
    app = await createApp({
      auditSink: { record() {} },
      aiHealthChecker: async () => 'healthy',
      databaseStatusResolver: () => 'connected',
    });

    const publicController = app.get(CalendarQueryController) as unknown as CalendarController;
    const internalController = app.get(CalendarInboundController) as unknown as CalendarController;

    expect(publicController.calendar).toBe(internalController.calendar);
  });
});
