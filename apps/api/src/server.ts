import './config.js';

import { createServer } from 'node:http';

import mongoose from 'mongoose';

import { createApp } from './app.js';
import { ensureIncidentStorage } from './incidents/storage.js';
import { coordinationLog } from './realtime/coordination.js';
import { createRealtimeGateway } from './realtime/gateway.js';
import { createCoordination } from './realtime/redis.js';

const port = Number(process.env.API_PORT ?? 4000);
const app = createApp();
const server = createServer(app);
const allowedOrigins = (process.env.SOCKET_ALLOWED_ORIGINS ?? 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean);
const start = async () => {
  const coordination = await createCoordination();
  const gateway = createRealtimeGateway(server, allowedOrigins, coordination);
  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    const deadline = setTimeout(() => { coordinationLog('shutdown_timeout'); process.exit(1); }, 10000);
    deadline.unref();
    try {
      await new Promise<void>((resolve) => gateway.close(() => resolve()));
      await coordination.close();
      await mongoose.disconnect();
      coordinationLog('shutdown_complete');
    } finally { clearTimeout(deadline); }
  };
  try {
    await mongoose.connect(process.env.MONGODB_URI ?? 'mongodb://localhost:27017/flowryn', { serverSelectionTimeoutMS: 5000 });
    await ensureIncidentStorage();
    coordination.assertAvailable();
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(port, resolve); });
    coordinationLog('api_ready');
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
      void stop().catch(() => { coordinationLog('shutdown_failed'); process.exitCode = 1; });
    });
  } catch { await stop(); throw new Error('API startup failed'); }
};
void start().catch(() => {
  console.error(JSON.stringify({ service: 'api', event: 'startup_failed', message: 'Check MongoDB replica-set connectivity, incident indexes and required REDIS_URL coordination; memory mode is forbidden in production' }));
  process.exitCode = 1;
});
