import { AuditSink } from './audit';
import { GoogleCalendarConfig, GoogleCalendarPort } from './application/googleCalendar';
import { GoogleOAuthConfig, GoogleOAuthPort } from './application/googleOAuth';
import { OidcTokenVerifier } from './auth';
import { DatabaseState, HealthState } from './types';
import type { TaskRepository } from './application/taskRepository';

export interface CreateAppOptions {
  aiHealthChecker?: () => Promise<HealthState>;
  databaseStatusResolver?: () => DatabaseState;
  rateLimitLimit?: number;
  auditSink?: AuditSink;
  calendarInternalHmacKey?: string;
  googleOAuthConfig?: GoogleOAuthConfig;
  googleOAuthPort?: GoogleOAuthPort;
  googleCalendarPort?: GoogleCalendarPort;
  googleCalendarConfig?: GoogleCalendarConfig;
  oidcTokenVerifier?: OidcTokenVerifier;
  taskRepository?: TaskRepository;
}
