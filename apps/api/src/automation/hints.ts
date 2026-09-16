import { randomUUID } from 'node:crypto';

import { incidentIdSchema, oncallEventNames, realtimeEventNameSchema } from '@flowryn/shared';
import { Redis } from 'ioredis';
import { z } from 'zod';

export const automationHintNames = [
  'automation.ruleCreated',
  'automation.ruleUpdated',
  'automation.ruleEnabled',
  'automation.ruleDisabled',
  'automation.ruleArchived',
  'automation.runQueued',
  'automation.runStarted',
  'automation.runCompleted',
  'automation.runSkipped',
  'automation.runFailed',
  'integration.healthChanged',
  'integration.deliveryFailed',
  ...oncallEventNames,
] as const;
export const automationHintSchema = z
  .object({
    eventId: z.string().uuid(),
    timestamp: z.string().datetime(),
    workspaceId: incidentIdSchema,
    entityId: incidentIdSchema,
    actorId: incidentIdSchema,
    type: realtimeEventNameSchema,
    projectId: incidentIdSchema.optional(),
    incidentId: incidentIdSchema.optional(),
    recipientId: incidentIdSchema.optional(),
    payload: z.object({}).strict(),
  })
  .strict()
  .refine(
    (hint) => hint.type !== 'notification.created' || !!hint.recipientId,
    'Recipient required',
  );
export type AutomationHint = z.infer<typeof automationHintSchema>;
const channel = 'flowryn:automation:hints:v1';
let publisher: Redis | undefined;
let localHandler: ((hint: AutomationHint) => Promise<void>) | undefined;
export const publishAutomationHint = (
  input: Omit<AutomationHint, 'eventId' | 'timestamp' | 'payload'>,
) => {
  const hint = automationHintSchema.parse({
    ...input,
    eventId: randomUUID(),
    timestamp: new Date().toISOString(),
    payload: {},
  });
  if (publisher?.status === 'ready')
    void publisher.publish(channel, JSON.stringify(hint)).catch(() => undefined);
  else if (localHandler) void localHandler(hint).catch(() => undefined);
};
// These are disposable REST invalidation hints, never durable worker inputs.
export const startAutomationHints = async (handler?: (hint: AutomationHint) => Promise<void>) => {
  localHandler = handler;
  if (!process.env.REDIS_URL || process.env.REALTIME_COORDINATION === 'memory')
    return async () => {
      localHandler = undefined;
    };
  const options = {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 3000,
  };
  const pub = new Redis(process.env.REDIS_URL, options);
  publisher = pub;
  const sub = handler ? new Redis(process.env.REDIS_URL, options) : undefined;
  pub.on('error', () => undefined);
  sub?.on('error', () => undefined);
  sub?.on('message', (_channel, raw) => {
    if (raw.length > 2048) return;
    try {
      const hint = automationHintSchema.safeParse(JSON.parse(raw));
      if (hint.success) void handler!(hint.data).catch(() => undefined);
    } catch {
      /* Ignore malformed hints. */
    }
  });
  sub?.on('ready', () => {
    void sub.subscribe(channel).catch(() => undefined);
  });
  try {
    await pub.connect();
    publisher = pub;
    if (sub) await sub.connect();
  } catch {
    /* REST polling recovers missed hints. */
  }
  return async () => {
    publisher = undefined;
    localHandler = undefined;
    pub.disconnect();
    sub?.disconnect();
  };
};
