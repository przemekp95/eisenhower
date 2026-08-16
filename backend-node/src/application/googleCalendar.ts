import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  CalendarBindingModel, CalendarConnectionModel, CalendarOutboxModel,
  CalendarSyncStateModel, GoogleOAuthGrantModel,
} from '../models/calendar';
import {
  decryptGoogleSecret, encryptGoogleSecret, GoogleOAuthConfig, GoogleTokenSet,
} from './googleOAuth';

export interface GoogleProviderResult { providerEventId: string; providerEtag: string }
export interface GoogleChangesResult { events: unknown[]; nextPageToken?: string; nextSyncToken?: string; resetRequired?: boolean }
export interface GoogleCalendarPort {
  refresh(tokens: GoogleTokenSet, config: GoogleOAuthConfig): Promise<GoogleTokenSet>;
  createEvent(input: Record<string, unknown>): Promise<GoogleProviderResult>;
  updateEvent(input: Record<string, unknown>): Promise<GoogleProviderResult>;
  deleteEvent(input: Record<string, unknown>): Promise<GoogleProviderResult>;
  listChanges(input: Record<string, unknown>): Promise<GoogleChangesResult>;
  watch(input: Record<string, unknown>): Promise<{ channelId: string; resourceId: string; expiresAt: Date }>;
}
export interface GoogleCalendarConfig { watchCallbackUrls: string[] }
const MAX_CHANGE_PAGES = 20;
export function loadGoogleCalendarConfig(env: NodeJS.ProcessEnv): GoogleCalendarConfig | null {
  const raw = env.GOOGLE_CALENDAR_WATCH_CALLBACK_URLS?.trim();
  if (!raw) return null;
  const watchCallbackUrls = raw.split(',').map((value) => value.trim()).filter(Boolean);
  if (!watchCallbackUrls.length || watchCallbackUrls.some((value) => {
    const url = new URL(value); return url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '';
  })) throw new Error('Google Calendar watch callback URLs must be exact HTTPS URLs.');
  return { watchCallbackUrls };
}

export class GoogleCalendarHttpAdapter implements GoogleCalendarPort {
  private async request(url: string, init: RequestInit, attempt = 0): Promise<Response> {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
    if ((response.status === 429 || response.status >= 500) && attempt < 1) {
      const retrySeconds = Math.min(Number(response.headers.get('retry-after') ?? '0') || 0, 1);
      if (retrySeconds > 0) await new Promise((resolve) => setTimeout(resolve, retrySeconds * 1000));
      return this.request(url, init, attempt + 1);
    }
    return response;
  }

  async refresh(tokens: GoogleTokenSet, config: GoogleOAuthConfig) {
    if (!tokens.refreshToken) throw new Error('google_refresh_token_missing');
    const response = await this.request('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: config.clientId, client_secret: config.clientSecret,
        refresh_token: tokens.refreshToken, grant_type: 'refresh_token',
      }),
    });
    if (!response.ok) throw new Error('google_token_refresh_failed');
    const body = await response.json() as { access_token?: string; expires_in?: number; scope?: string };
    if (!body.access_token) throw new Error('google_token_refresh_incomplete');
    return {
      ...tokens, accessToken: body.access_token,
      expiresAt: new Date(Date.now() + (body.expires_in ?? 3600) * 1000),
      scopes: body.scope ? body.scope.split(/\s+/).filter(Boolean) : tokens.scopes,
    };
  }

  private eventBody(input: Record<string, unknown>) {
    const payload = input.payload as { title?: string; schedule?: { dueAt?: string; timeZone?: string } };
    return {
      summary: payload.title ?? 'Eisenhower task',
      start: { dateTime: payload.schedule?.dueAt, timeZone: payload.schedule?.timeZone },
      end: { dateTime: payload.schedule?.dueAt, timeZone: payload.schedule?.timeZone },
    };
  }

  async createEvent(input: Record<string, unknown>) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events`;
    const response = await this.request(url, {
      method: 'POST', headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: input.deterministicId, ...this.eventBody(input) }),
    });
    return this.providerResult(response);
  }

  async updateEvent(input: Record<string, unknown>) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events/${encodeURIComponent(String(input.providerEventId))}`;
    const response = await this.request(url, {
      method: 'PUT', headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json', 'If-Match': String(input.providerEtag) },
      body: JSON.stringify(this.eventBody(input)),
    });
    return this.providerResult(response);
  }

  async deleteEvent(input: Record<string, unknown>) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events/${encodeURIComponent(String(input.providerEventId))}`;
    const response = await this.request(url, { method: 'DELETE', headers: { Authorization: `Bearer ${input.accessToken}`, 'If-Match': String(input.providerEtag) } });
    if (!response.ok) throw new Error('google_calendar_delete_failed');
    return { providerEventId: String(input.providerEventId), providerEtag: String(input.providerEtag) };
  }

  async listChanges(input: Record<string, unknown>) {
    const url = new URL(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events`);
    if (input.pageToken) url.searchParams.set('pageToken', String(input.pageToken));
    if (input.syncToken) url.searchParams.set('syncToken', String(input.syncToken));
    const response = await this.request(url.toString(), { headers: { Authorization: `Bearer ${input.accessToken}` } });
    if (response.status === 410) return { events: [], resetRequired: true };
    if (!response.ok) throw new Error('google_calendar_changes_failed');
    const body = await response.json() as { items?: unknown[]; nextPageToken?: string; nextSyncToken?: string };
    return { events: body.items ?? [], ...(body.nextPageToken ? { nextPageToken: body.nextPageToken } : {}), ...(body.nextSyncToken ? { nextSyncToken: body.nextSyncToken } : {}) };
  }

  async watch(input: Record<string, unknown>) {
    const url = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(String(input.calendarId))}/events/watch`;
    const response = await this.request(url, {
      method: 'POST', headers: { Authorization: `Bearer ${input.accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: input.channelId, type: 'web_hook', address: input.address, token: input.channelToken }),
    });
    if (!response.ok) throw new Error('google_calendar_watch_failed');
    const body = await response.json() as { id?: string; resourceId?: string; expiration?: string };
    if (!body.id || !body.resourceId || !body.expiration) throw new Error('google_calendar_watch_incomplete');
    return { channelId: body.id, resourceId: body.resourceId, expiresAt: new Date(Number(body.expiration)) };
  }

  private async providerResult(response: Response) {
    if (!response.ok) throw new Error('google_calendar_write_failed');
    const body = await response.json() as { id?: string; etag?: string };
    if (!body.id || !body.etag) throw new Error('google_calendar_write_incomplete');
    return { providerEventId: body.id, providerEtag: body.etag };
  }
}

export class GoogleCalendarService {
  constructor(
    private readonly oauth: GoogleOAuthConfig,
    private readonly config: GoogleCalendarConfig,
    private readonly port: GoogleCalendarPort,
  ) {
    if (config.watchCallbackUrls.some((value) => new URL(value).protocol !== 'https:')) {
      throw new Error('Google Calendar watch callbacks must use HTTPS.');
    }
  }

  private async resolveConnection(id: string) {
    const connection = await CalendarConnectionModel.findOne({ _id: id, status: 'active' });
    if (!connection || !/^oauth-grant:[a-f0-9]{24}$/.test(connection.credentialRef)) {
      throw new Error('calendar_connection_unavailable');
    }
    const grantId = connection.credentialRef.slice('oauth-grant:'.length);
    const grant = await GoogleOAuthGrantModel.findOne({
      _id: grantId, tenantId: connection.tenantId, ownerId: connection.ownerId, status: 'active',
    }).select('+tokenCiphertext +tokenIv +tokenTag');
    if (!grant) throw new Error('calendar_grant_unavailable');
    const key = this.oauth.encryptionKeys[grant.keyVersion];
    if (!key) throw new Error('calendar_grant_key_unavailable');
    let tokens = decryptGoogleSecret<GoogleTokenSet>(key, {
      ciphertext: grant.tokenCiphertext, iv: grant.tokenIv, tag: grant.tokenTag,
    }, `google-oauth-token-v1\0${grant.tenantId}\0${grant.ownerId}\0${grant.googleSubject}`);
    tokens.expiresAt = new Date(tokens.expiresAt);
    if (tokens.expiresAt.getTime() <= Date.now() + 30_000) {
      tokens = await this.port.refresh(tokens, this.oauth);
      const sealed = encryptGoogleSecret(
        key, tokens,
        `google-oauth-token-v1\0${grant.tenantId}\0${grant.ownerId}\0${grant.googleSubject}`,
      );
      grant.tokenCiphertext = sealed.ciphertext; grant.tokenIv = sealed.iv; grant.tokenTag = sealed.tag;
      await grant.save();
    }
    return { connection, tokens };
  }

  async outbound(eventId: string) {
    const event = await CalendarOutboxModel.findOne({ eventId });
    if (!event || !['event_create', 'event_update', 'event_delete'].includes(event.type)) {
      throw new Error('calendar_outbox_event_unavailable');
    }
    const connection = await CalendarConnectionModel.findOne({ tenantId: event.tenantId, ownerId: event.ownerId, status: 'active' });
    if (!connection) throw new Error('calendar_connection_unavailable');
    const resolved = await this.resolveConnection(connection.id);
    const common = { accessToken: resolved.tokens.accessToken, calendarId: connection.calendarId, payload: event.payload };
    let result: GoogleProviderResult;
    if (event.type === 'event_create') {
      result = await this.port.createEvent({ ...common, deterministicId: createHash('sha256').update(`eisenhower:${event.aggregateId}`).digest('hex').slice(0, 32) });
    } else {
      const binding = await CalendarBindingModel.findOne({ tenantId: event.tenantId, ownerId: event.ownerId, taskId: event.aggregateId });
      if (!binding || binding.connectionId.toString() !== connection.id) throw new Error('calendar_binding_unavailable');
      const input = { ...common, providerEventId: binding.providerEventId, providerEtag: binding.providerEtag };
      result = event.type === 'event_update' ? await this.port.updateEvent(input) : await this.port.deleteEvent(input);
    }
    return { ...result, connectionId: connection.id };
  }

  async changes(connectionId: string, checkpoint: string) {
    const resolved = await this.resolveConnection(connectionId);
    const state = await CalendarSyncStateModel.findOne({ connectionId, tenantId: resolved.connection.tenantId, ownerId: resolved.connection.ownerId });
    const authoritative = state?.pageToken ?? state?.syncToken ?? 'full-resync';
    if (!authoritative || checkpoint !== authoritative) throw new Error('calendar_checkpoint_mismatch');
    const baseline = checkpoint === 'full-resync';
    const events: unknown[] = [];
    let pageToken = state?.pageToken;
    const syncToken = state?.syncToken;
    for (let page = 0; page < MAX_CHANGE_PAGES; page += 1) {
      const result = await this.port.listChanges({
        accessToken: resolved.tokens.accessToken,
        calendarId: resolved.connection.calendarId,
        ...(pageToken ? { pageToken } : syncToken ? { syncToken } : {}),
      });
      if (result.resetRequired) return { events: [], resetRequired: true };
      if (!baseline) events.push(...result.events);
      if (result.nextPageToken) {
        pageToken = result.nextPageToken;
        continue;
      }
      if (!result.nextSyncToken) throw new Error('google_calendar_changes_checkpoint_missing');
      return { events, nextSyncToken: result.nextSyncToken };
    }
    throw new Error('google_calendar_changes_page_limit_exceeded');
  }

  async watch(connectionId: string, address: string) {
    if (!this.config.watchCallbackUrls.includes(address)) throw new Error('calendar_watch_address_denied');
    const resolved = await this.resolveConnection(connectionId);
    const channelId = randomUUID();
    const channelToken = randomBytes(32).toString('base64url');
    const result = await this.port.watch({
      accessToken: resolved.tokens.accessToken, calendarId: resolved.connection.calendarId,
      address, channelId, channelToken,
    });
    return {
      channelId: result.channelId,
      resourceId: result.resourceId,
      expiresAt: result.expiresAt.toISOString(),
      verificationHash: createHash('sha256').update(channelToken).digest('hex'),
    };
  }
}
