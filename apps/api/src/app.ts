import cors from 'cors';
import express from 'express';

import { healthResponseSchema } from '@flowryn/shared';

export const createApp = () => {
  const app = express();

  app.use(cors());
  app.use(express.json());
  app.get('/api/health', (_request, response) => {
    response.json(
      healthResponseSchema.parse({ status: 'ok', service: 'flowryn-api', timestamp: new Date().toISOString() }),
    );
  });

  return app;
};