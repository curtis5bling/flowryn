/* eslint-disable @typescript-eslint/no-explicit-any -- IPC messages are runtime-validated by the isolated test protocol. */
import { createServer } from 'node:http';

import mongoose from 'mongoose';

import { createApp } from '../src/app.js';
import { authorizationChanged } from '../src/auth/revocation.js';
import { publishAutomationHint, startAutomationHints } from '../src/automation/hints.js';
import {
  createRealtimeGateway,
  publishRealtimeEvent,
  publishRestrictedRealtimeEvent,
  relayAutomationHint,
} from '../src/realtime/gateway.js';
import { createCoordination } from '../src/realtime/redis.js';

const main = async () => {
  await mongoose.connect(process.env.MONGODB_URI!);
  const coordination = await createCoordination();
  const server = createServer(createApp());
  const gateway = createRealtimeGateway(server, ['http://127.0.0.1'], coordination);
  await coordination.ensureReady();
  const closeHints = await startAutomationHints(relayAutomationHint);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server address');
  process.send?.({ type: 'ready', port: address.port });
  process.on('message', (message: any) => {
    void (async () => {
      if (message.type === 'publish')
        publishRealtimeEvent({
          type: message.eventType,
          workspaceId: message.workspaceId,
          actorId: message.actorId,
          entityId: message.entityId,
          payload: {},
        });
      if (message.type === 'restricted')
        await publishRestrictedRealtimeEvent({
          type: message.eventType,
          workspaceId: message.workspaceId,
          actorId: message.actorId,
          entityId: message.entityId,
          payload: {},
        });
      if (message.type === 'hint') {
        publishAutomationHint({
          type: message.eventType,
          workspaceId: message.workspaceId,
          actorId: message.actorId,
          entityId: message.entityId,
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (message.type === 'authorization') await authorizationChanged(message.change);
      if (message.type === 'fail') { coordination.fail(); await coordination.close(); }
      if (message.type === 'stop') {
        await closeHints();
        await new Promise<void>((resolve) => gateway.close(() => resolve()));
        await mongoose.disconnect();
        process.send?.({ type: 'stopped', id: message.id });
        return;
      }
      process.send?.({ type: 'ack', id: message.id });
    })().catch(() => process.send?.({ type: 'error', id: message.id }));
  });
};

void main().catch(() => {
  process.send?.({ type: 'startup-error' });
  process.exitCode = 1;
});
