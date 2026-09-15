import { healthResponseSchema } from '@flowryn/shared';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express, { type ErrorRequestHandler } from 'express';

import authRouter from './routes/auth.js';
import projectsRouter from './routes/projects.js';
import workspacesRouter from './routes/workspaces.js';

export const createApp = () => {
  const app = express();

  app.use(cors({ origin: true, credentials: true }));
  app.use(cookieParser());
  app.use(express.json());
  app.get('/api/health', (_request, response) => {
    response.json(
      healthResponseSchema.parse({ status: 'ok', service: 'flowryn-api', timestamp: new Date().toISOString() }),
    );
  });
  app.use('/api/auth', authRouter);
  app.use('/api/workspaces', projectsRouter);
  app.use('/api/workspaces', workspacesRouter);
  const errorHandler: ErrorRequestHandler = (error, _request, response, next) => {
    void next;
    console.error(error);
    response.status(500).json({ error: process.env.NODE_ENV === 'production' ? 'Internal server error' : String(error?.message ?? error) });
  };
  app.use(errorHandler);

  return app;
};