import { Router } from 'express';
import { GoogleCalendarService } from '../application/googleCalendar';
import { requireCalendarInternalHmac } from './calendarInternal';

export function createGoogleCalendarProviderRouter(key: string, service: GoogleCalendarService) {
  const router = Router();
  router.use(requireCalendarInternalHmac(key));
  const fail = (error: unknown, res: Parameters<Parameters<typeof router.post>[1]>[1], next: (error: unknown) => void) => {
    if (error instanceof Error && error.message.endsWith('_denied')) return res.status(400).json({ error: 'Invalid provider request' });
    if (error instanceof Error && (error.message.endsWith('_unavailable') || error.message.endsWith('_mismatch'))) return res.status(409).json({ error: 'Provider state is unavailable' });
    return next(error);
  };
  router.post('/outbound', async (req, res, next) => {
    if (Object.keys(req.body ?? {}).length !== 1 || typeof req.body?.eventId !== 'string' || !req.body.eventId) return res.status(400).json({ error: 'eventId is required' });
    try { return res.json(await service.outbound(req.body.eventId)); } catch (error) { return fail(error, res, next); }
  });
  router.post('/changes', async (req, res, next) => {
    if (Object.keys(req.body ?? {}).some((key) => !['connectionId', 'checkpoint'].includes(key)) || typeof req.body?.connectionId !== 'string' || typeof req.body?.checkpoint !== 'string') return res.status(400).json({ error: 'connectionId and checkpoint are required' });
    try { return res.json(await service.changes(req.body.connectionId, req.body.checkpoint)); } catch (error) { return fail(error, res, next); }
  });
  router.post('/watch', async (req, res, next) => {
    if (Object.keys(req.body ?? {}).some((key) => !['connectionId', 'address'].includes(key)) || typeof req.body?.connectionId !== 'string' || typeof req.body?.address !== 'string') return res.status(400).json({ error: 'connectionId and address are required' });
    try { return res.json(await service.watch(req.body.connectionId, req.body.address)); } catch (error) { return fail(error, res, next); }
  });
  return router;
}
