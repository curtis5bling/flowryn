import { healthResponseSchema } from '@flowryn/shared';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';

import { IncidentError } from './incidents/service.js';
import { CoordinationUnavailable, RevocationIncomplete } from './realtime/coordination.js';
import { realtimeAvailable } from './realtime/gateway.js';
import authRouter from './routes/auth.js';
import automationRouter from './routes/automation.js';
import collaborationRouter from './routes/collaboration.js';
import inboundRouter from './routes/inbound.js';
import incidentsRouter from './routes/incidents.js';
import oncallRouter from './routes/oncall.js';
import projectsRouter from './routes/projects.js';
import publicStatusRouter from './routes/public-status.js';
import reliabilityInboundRouter from './routes/reliability-inbound.js';
import reliabilityRouter from './routes/reliability.js';
import statusRouter from './routes/status.js';
import workspacesRouter from './routes/workspaces.js';

export const createApp = () => {
  const app = express();
  const trustedProxyHops = Number.parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10);
  if (Number.isSafeInteger(trustedProxyHops) && trustedProxyHops > 0)
    app.set('trust proxy', trustedProxyHops);

  const allowedOrigins = (process.env.SOCKET_ALLOWED_ORIGINS ?? 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim());
  app.use(cors({ origin: allowedOrigins, credentials: true }));
  app.use((request, response, next) => {
    if (request.headers.origin && !allowedOrigins.includes(request.headers.origin)) {
      response.status(403).json({ error: 'Origin denied' });
      return;
    }
    next();
  });
  app.use(cookieParser());
  app.use('/api/webhooks', inboundRouter);
  app.use('/api/webhooks/reliability', reliabilityInboundRouter);
  app.use(express.json({ limit: '2mb' }));
  app.get('/api/ready', (_request, response) => {
    const ready = realtimeAvailable();
    response.status(ready ? 200 : 503).json({ ready });
  });
  app.get('/api/health', (_request, response) => {
    response.json(
      healthResponseSchema.parse({
        status: 'ok',
        service: 'flowryn-api',
        timestamp: new Date().toISOString(),
      }),
    );
  });
  app.use('/api/auth', authRouter);
  app.use('/api/status', publicStatusRouter);
  app.use('/api/workspaces', statusRouter);
  app.use('/api/workspaces', reliabilityRouter);
  app.use('/api/workspaces', oncallRouter);
  app.use('/api/workspaces', automationRouter);
  app.use('/api/workspaces', incidentsRouter);
  app.use('/api/workspaces', collaborationRouter);
  app.use('/api/workspaces', projectsRouter);
  app.use('/api/workspaces', workspacesRouter);
  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    void next;
    if (error instanceof CoordinationUnavailable) {
      response.status(503).json({
        error: error.message,
        code: error instanceof RevocationIncomplete ? error.code : 'COORDINATION_UNAVAILABLE',
      });
      return;
    }
    const status = error instanceof IncidentError ? error.status : error?.status === 400 || error?.status === 413 ? error.status : 500;
    console.error(JSON.stringify({ service: 'api', event: 'request_failed', status }));
    response.status(status).json({
      error:
        status === 413
          ? 'Request body too large'
          : status < 500
            ? error instanceof IncidentError ? error.message : 'Invalid request body'
            : 'Internal server error',
    });
  };
  app.use(errorHandler);

  return app;
};
