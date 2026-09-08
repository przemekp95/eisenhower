import { DynamicModule, Global, Module } from '@nestjs/common';
import type { CreateAppOptions } from '../../app-options';
import {
  GoogleCalendarHttpAdapter, GoogleCalendarService, loadGoogleCalendarConfig,
} from '../../application/googleCalendar';
import {
  GoogleOAuthHttpClient, GoogleOAuthService, loadGoogleOAuthConfig,
} from '../../application/googleOAuth';
import type { AppConfig } from '../../config';
import { CalendarSyncStateModel } from '../../models/calendar';
import {
  CALENDAR_CAN_CONNECT, GOOGLE_CALENDAR_SERVICE, GOOGLE_OAUTH_SERVICE,
} from '../../platform/tokens';
import { GoogleOAuthController } from './google-oauth.controller';
import { GoogleProviderController } from './google-provider.controller';

@Global()
@Module({})
export class GoogleModule {
  static register(options: CreateAppOptions, config: AppConfig): DynamicModule {
    const oauthConfig = options.googleOAuthConfig ?? loadGoogleOAuthConfig(process.env, config.nodeEnv);
    const calendarConfig = options.googleCalendarConfig ?? loadGoogleCalendarConfig(process.env);
    const hmacKey = options.calendarInternalHmacKey ?? process.env.CALENDAR_INTERNAL_HMAC_KEY;
    const calendarService = options.googleCalendarService ?? (
      hmacKey && oauthConfig && calendarConfig
        ? new GoogleCalendarService(
          oauthConfig, calendarConfig, options.googleCalendarPort ?? new GoogleCalendarHttpAdapter(),
        )
        : null
    );
    const oauthService = options.googleOAuthService ?? (oauthConfig
      ? new GoogleOAuthService(
        oauthConfig,
        options.googleOAuthPort ?? new GoogleOAuthHttpClient(),
        calendarService ? async (connectionId) => {
          try {
            await calendarService.registerWatch(connectionId);
          } catch {
            await CalendarSyncStateModel.findOneAndUpdate(
              { connectionId }, { $set: { fullResyncRequired: true } },
              { upsert: true, setDefaultsOnInsert: true },
            );
          }
        } : undefined,
      ) : null);
    const controllers = [
      ...(oauthService ? [GoogleOAuthController] : []),
      ...(calendarService && hmacKey ? [GoogleProviderController] : []),
    ];
    return {
      global: true,
      module: GoogleModule,
      controllers,
      providers: [
        { provide: GOOGLE_CALENDAR_SERVICE, useValue: calendarService },
        { provide: GOOGLE_OAUTH_SERVICE, useValue: oauthService },
        { provide: CALENDAR_CAN_CONNECT, useValue: options.calendarCanConnect ?? Boolean(oauthService) },
      ],
      exports: [GOOGLE_CALENDAR_SERVICE, GOOGLE_OAUTH_SERVICE, CALENDAR_CAN_CONNECT],
    };
  }
}
