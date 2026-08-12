import { Router } from 'express';
import { GoogleOAuthService } from '../application/googleOAuth';
import { requireScope, SecurityRejectionHandler } from '../auth';

export function createGoogleOAuthCallbackRouter(service: GoogleOAuthService) {
  const router = Router();
  router.get('/callback', async (req, res, next) => {
    if (req.query.error !== undefined) {
      return res.status(400).json({ error: 'Google authorization was not completed' });
    }
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    if (!state || !code) return res.status(400).json({ error: 'OAuth state and code are required' });
    try {
      const result = await service.callback(state, code);
      return res.redirect(303, result.returnUrl);
    } catch (error) {
      if (error instanceof Error && error.message === 'invalid_oauth_state') {
        return res.status(400).json({ error: 'Invalid or expired OAuth state' });
      }
      return next(error);
    }
  });
  return router;
}

export function createGoogleOAuthUserRouter(service: GoogleOAuthService, onReject?: SecurityRejectionHandler) {
  const router = Router();
  router.post('/start', requireScope('calendar:write', onReject), async (req, res, next) => {
    if (typeof req.body?.returnPath !== 'string') return res.status(400).json({ error: 'returnPath is required' });
    try {
      return res.status(201).json(await service.start({
        tenantId: req.auth!.tenantId, ownerId: req.auth!.userId,
      }, req.body.returnPath));
    } catch (error) {
      if (error instanceof Error && error.message === 'unsafe_return_path') {
        return res.status(400).json({ error: 'Unsafe OAuth return path' });
      }
      return next(error);
    }
  });
  router.post('/disconnect', requireScope('calendar:write', onReject), async (req, res, next) => {
    try {
      await service.disconnect({ tenantId: req.auth!.tenantId, ownerId: req.auth!.userId });
      return res.status(204).send();
    } catch (error) { return next(error); }
  });
  return router;
}
