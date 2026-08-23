import { NextFunction, Request, Response, Router } from 'express';
import { CalendarApplicationService, CalendarInboundCommand } from '../application/calendar';
import {
  CalendarInternalService, InternalResult, isCalendarInboundCommand,
} from '../application/calendarInternal';
import {
  InternalHmacRequestContext, InternalHmacService,
} from '../modules/calendar-internal/internal-hmac.service';

export { isCalendarInboundCommand } from '../application/calendarInternal';

const internalRequestContext = new WeakMap<Request, InternalHmacRequestContext>();

export function requireCalendarInternalHmac(key: string) {
  const hmac = new InternalHmacService(key);
  return async (request: Request, response: Response, next: NextFunction) => {
    if (request.baseUrl.endsWith('/calendar') && request.path.startsWith('/provider/')) return next();
    try {
      const result = await hmac.authorize({
        timestamp: request.get('x-eisenhower-timestamp') ?? '',
        requestId: request.get('x-eisenhower-request-id') ?? '',
        signature: request.get('x-eisenhower-signature') ?? '',
        method: request.method,
        path: request.originalUrl.split('?')[0],
        rawBody: request.rawBody ?? Buffer.alloc(0),
      });
      if (result.kind === 'failure') {
        const errors = {
          timestamp: 'Invalid calendar dispatch timestamp',
          'request-id': 'Invalid calendar dispatch request id',
          signature: 'Invalid calendar dispatch signature',
        } as const;
        return response.status(401).json({ error: errors[result.failure] });
      }
      if (result.kind === 'replay') {
        if (result.replay.responseBody === undefined || result.replay.statusCode === 204) {
          return response.status(result.replay.statusCode).send();
        }
        return response.status(result.replay.statusCode).json(result.replay.responseBody);
      }
      internalRequestContext.set(request, result.context);
      let responseBody: unknown;
      const originalJson = response.json.bind(response);
      response.json = ((body: unknown) => {
        responseBody = body;
        return originalJson(body);
      }) as typeof response.json;
      response.once('finish', () => {
        void hmac.complete(result.context, response.statusCode, responseBody).catch(() => undefined);
      });
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

function sendResult(response: Response, result: InternalResult) {
  return result.body === undefined
    ? response.status(result.status).send()
    : response.status(result.status).json(result.body);
}

export function createCalendarInternalRouter(
  key: string,
  calendar = new CalendarApplicationService(),
  internal = new CalendarInternalService(),
) {
  const router = Router();
  router.use(requireCalendarInternalHmac(key));

  const applyInbound = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const command = req.body as CalendarInboundCommand;
      if (!isCalendarInboundCommand(command)) {
        return res.status(400).json({ error: 'Invalid calendar inbound command' });
      }
      return res.status(202).json(await calendar.applyInbound(command));
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  };
  router.post('/inbound', applyInbound);
  router.post('/sync/apply', applyInbound);

  router.post('/sync/apply-batch', async (req, res, next) => {
    try {
      const commands = req.body?.commands;
      if (!Array.isArray(commands) || !commands.length || commands.length > 250) {
        return res.status(400).json({ error: 'Invalid calendar inbound command batch' });
      }
      const results = [];
      for (const command of commands as CalendarInboundCommand[]) {
        if (!isCalendarInboundCommand(command)) {
          return res.status(400).json({ error: 'Invalid calendar inbound command batch' });
        }
        results.push(await calendar.applyInbound(command));
      }
      return res.status(202).json({ results });
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  router.post('/sync/reset', async (req, res, next) => {
    try {
      const { operationId, tenantId, ownerId, connectionId } = req.body ?? {};
      if (![operationId, tenantId, ownerId, connectionId]
        .every((value) => typeof value === 'string' && value)) {
        return res.status(400).json({ error: 'Invalid calendar sync reset' });
      }
      return res.status(202).json(await calendar.applyInbound({
        operationId, tenantId, ownerId, connectionId, kind: 'sync_token_gone',
      }));
    } catch (error) { return next(error); }
  });

  router.post('/request', async (req, res, next) => {
    try {
      const { tenantId, ownerId, connectionId, operationId } = req.body ?? {};
      if (![tenantId, ownerId, connectionId, operationId]
        .every((value) => typeof value === 'string' && value)) {
        return res.status(400).json({ error: 'Invalid calendar sync request' });
      }
      return res.status(202).json(await calendar.requestSync(
        { tenantId, ownerId }, connectionId, operationId,
      ));
    } catch (error) {
      if (error instanceof Error && error.message === 'calendar_operation_reused') {
        return res.status(409).json({ error: error.message });
      }
      return next(error);
    }
  });

  const claim = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const context = internalRequestContext.get(req);
      if (!context) throw new Error('calendar_request_receipt_missing');
      return sendResult(res, await internal.claimOutbox(context));
    } catch (error) { return next(error); }
  };
  router.post('/outbound/claim', claim);
  router.post('/outbox/claim', claim);

  const acknowledge = async (req: Request, res: Response, next: NextFunction) => {
    try { return sendResult(res, await internal.acknowledgeOutbox(req.body ?? {})); }
    catch (error) { return next(error); }
  };
  router.post('/outbound/result', acknowledge);
  router.post('/outbox/acknowledge', acknowledge);

  router.post('/notifications/validate', async (req, res, next) => {
    try { return sendResult(res, await internal.validateNotification(req.body ?? {})); }
    catch (error) { return next(error); }
  });
  router.post('/watch/renew', async (req, res, next) => {
    try { return sendResult(res, await internal.renewWatch(req.body ?? {})); }
    catch (error) { return next(error); }
  });
  router.post('/reconciliation/claim', async (_req, res, next) => {
    try { return sendResult(res, await internal.claimReconciliation()); }
    catch (error) { return next(error); }
  });
  router.post('/status', async (req, res, next) => {
    try { return sendResult(res, await internal.status(req.body ?? {})); }
    catch (error) { return next(error); }
  });

  return router;
}
