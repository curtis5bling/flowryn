import './config.js';

import { createServer } from 'node:http';

import mongoose from 'mongoose';

import { createApp } from './app.js';
import { startAutomationHints } from './automation/hints.js';
import { ensureAutomationStorage } from './automation/storage.js';
import { coordinationLog } from './realtime/coordination.js';
import { createRealtimeGateway, relayAutomationHint } from './realtime/gateway.js';
import { createCoordination } from './realtime/redis.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = createApp();
const server = createServer(app);
const allowedOrigins = (process.env.SOCKET_ALLOWED_ORIGINS ?? 'http://localhost:5173')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const start = async () => {
  const coordination = await createCoordination();
  const gateway = createRealtimeGateway(server, allowedOrigins, coordination);
  const closeHints = await startAutomationHints(relayAutomationHint);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => {
      coordinationLog('shutdown_timeout');
      process.exit(1);
    }, 10000);
    deadline.unref();
    try {
      await closeHints();
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await coordination.close();
      await mongoose.disconnect();
      coordinationLog('shutdown_complete');
    } finally {
      clearTimeout(deadline);
    }
  };
  try {
    await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/flowryn', {
      serverSelectionTimeoutMS: 5000,
    });
    await ensureAutomationStorage();
    coordination.assertAvailable();
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, resolve);
    });
    coordinationLog('api_ready');
    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.once(signal, () => {
        void stop().catch(() => {
          coordinationLog('shutdown_failed');
          process.exitCode = 1;
        });
      });
  } catch {
    await stop();
    throw new Error('API startup failed');
  }
};
void start().catch(() => {
  console.error(
    JSON.stringify({
      service: 'api',
      event: 'startup_failed',
      message:
        'Check AUTOMATION_ENCRYPTION_KEYS/AUTOMATION_KEY_VERSION, MongoDB replica-set connectivity, automation indexes and required REDIS_URL coordination; memory mode is forbidden in production',
    }),
  );
  process.exitCode = 1;
});
