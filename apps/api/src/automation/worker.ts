import '../config.js';

import { createServer } from 'node:http';

import mongoose from 'mongoose';

import { AutomationWorker } from './engine.js';
import { startAutomationHints } from './hints.js';
import { ensureAutomationStorage } from './storage.js';

const worker = new AutomationWorker(
  Number(process.env.AUTOMATION_CONCURRENCY ?? 4),
  Number(process.env.AUTOMATION_POLL_MS ?? 1000),
);
const health = createServer((request, response) => {
  const ready = worker.ready;
  response.setHeader('content-type', 'application/json');
  response.statusCode =
    request.url === '/health' ? 200 : request.url === '/ready' ? (ready ? 200 : 503) : 404;
  response.end(
    JSON.stringify(
      request.url === '/health' ? { status: 'ok', service: 'flowryn-automation' } : { ready },
    ),
  );
});
let stopping = false;
let closeHints = async () => {};
const stop = async () => {
  if (stopping) return;
  stopping = true;
  await worker.stop();
  await closeHints();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await mongoose.disconnect();
};
const start = async () => {
  await mongoose.connect(
    process.env.MONGODB_URI ?? 'mongodb://localhost:27017/flowryn?replicaSet=rs0',
    { serverSelectionTimeoutMS: 5000 },
  );
  await ensureAutomationStorage();
  closeHints = await startAutomationHints();
  await worker.tick();
  await new Promise<void>((resolve, reject) => {
    health.once('error', reject);
    health.listen(Number(process.env.AUTOMATION_HEALTH_PORT ?? 4001), '127.0.0.1', resolve);
  });
  worker.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const)
    process.once(signal, () => {
      void stop().catch(() => {
        process.exitCode = 1;
      });
    });
};
void start().catch(async () => {
  console.error(
    JSON.stringify({
      service: 'automation',
      event: 'startup_failed',
      message: 'Check MongoDB replica-set topology and automation encryption configuration',
    }),
  );
  try {
    await stop();
  } catch {
    console.error(JSON.stringify({ service: 'automation', event: 'shutdown_failed' }));
  } finally {
    process.exitCode = 1;
  }
});
