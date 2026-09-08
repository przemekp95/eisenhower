import { AuditSink } from './audit';
import { GoogleCalendarConfig, GoogleCalendarPort } from './application/googleCalendar';
import { GoogleOAuthConfig, GoogleOAuthPort } from './application/googleOAuth';
import { OidcTokenVerifier } from './auth';
import { DatabaseState, HealthState } from './types';
import type { TaskRepository } from './application/taskRepository';
import type { CalendarApplicationService } from './application/calendar';
import type { GoogleCalendarService } from './application/googleCalendar';
import type { GoogleOAuthService } from './application/googleOAuth';
import type Redis from 'ioredis';

export interface CreateAppOptions {
  aiHealthChecker?: () => Promise<HealthState>;
  databaseStatusResolver?: () => DatabaseState;
  redisStatusResolver?: () => DatabaseState;
  rateLimitLimit?: number;
  rateLimitRedis?: Redis;
  rateLimitNameSpace?: string;
  logSink?: (level: 'info' | 'error', event: Record<string, unknown>) => void;
  auditSink?: AuditSink;
  calendarInternalHmacKey?: string;
  googleOAuthConfig?: GoogleOAuthConfig;
  googleOAuthPort?: GoogleOAuthPort;
  googleCalendarPort?: GoogleCalendarPort;
  googleCalendarConfig?: GoogleCalendarConfig;
  oidcTokenVerifier?: OidcTokenVerifier;
  taskRepository?: TaskRepository;
  calendarApplicationService?: CalendarApplicationService;
  googleCalendarService?: GoogleCalendarService;
  calendarCanConnect?: boolean;
  googleOAuthService?: GoogleOAuthService;
  calendarEnabled?: boolean;
}
